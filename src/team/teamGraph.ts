/**
 * Team graph orchestration (TeamDefinition version 2) — schema validation,
 * v1 → v2 migration, and the `on_complete` scheduling engine.
 *
 * Plan: plan/TEAM_GRAPH_ORCHESTRATION_05Jul2026.md §3.5 / Phase 2–3 (+ the
 * Phase 6 advanced-edge extensions: condition gates, OR-join, communication
 * triggers, broadcast).
 *
 * Engine semantics:
 *  - `on_complete` edges auto-schedule. Default join is wait-all (AND): the
 *    downstream node wakes exactly once, after every in-edge resolves, with
 *    merged payloads. `join: 'any'` on a node = OR-join: it wakes on the first
 *    in-edge that delivers a payload (later deliveries are dropped).
 *  - `condition` on an edge gates it on the upstream output (`/regex/` or
 *    substring). A gated-out edge releases its join slot without a payload; a
 *    non-entry node whose every in-edge releases empty is skipped and
 *    cascades the release downstream (conditional short-circuit).
 *  - Communication triggers (`on_tool_call` / `on_handoff` /
 *    `on_review_request`) are push edges: the upstream node gets a
 *    `NotifyTeammate` tool; a message wakes the target immediately when its
 *    `on_complete` requirements are already satisfied (`to: '*'` broadcasts
 *    along all of the sender's communication edges). `manual` edges never
 *    auto-dispatch.
 *  - Fail-soft: a failed upstream delivers a `[FAILED …]` marker downstream
 *    instead of aborting the run (same contract as panel member failures).
 *  - The graph must be a DAG; node count is capped (same order as the global
 *    AgentPool bound) and violations fail validation, never silently truncate.
 */
import type {
  MemberStatus,
  TeamDefinition,
  TeamEvent,
  TeamGraphEdge,
  TeamGraphNode,
  TeamGraphTrigger,
  TeamMember,
} from '../types.js';
import { buildMemberIdentities, type MemberIdentity } from './teamRuntime.js';

/** v1 cap: nodes per graph (kept in the same order as the AgentPool bound). */
export const MAX_GRAPH_NODES = 16;

/** The ref a node is addressed by in edges/entryNodeIds: id → name → role → model. */
export function graphNodeRef(node: TeamMember): string {
  return (node.id ?? node.name ?? node.role ?? node.model ?? '').trim();
}

interface NormalizedGraph {
  nodes: TeamGraphNode[];
  identities: MemberIdentity[];
  /** ref (as written in edges/entryNodeIds) → node index. */
  refIndex: Map<string, number>;
  edges: TeamGraphEdge[];
  entryIndexes: number[];
}

function indexGraph(definition: TeamDefinition): NormalizedGraph {
  const nodes = definition.nodes ?? [];
  const identities = buildMemberIdentities(nodes);
  const refIndex = new Map<string, number>();
  nodes.forEach((node, i) => {
    // Every addressable alias maps to the node; first writer wins (duplicate
    // refs are rejected by validation below).
    for (const ref of [node.id, node.name, node.role, node.model, identities[i]!.id]) {
      const key = (ref ?? '').trim();
      if (key && !refIndex.has(key)) refIndex.set(key, i);
    }
  });
  const entrySet = new Set<number>();
  nodes.forEach((node, i) => { if (node.entry) entrySet.add(i); });
  for (const ref of definition.entryNodeIds ?? []) {
    const i = refIndex.get(ref.trim());
    if (i !== undefined) entrySet.add(i);
  }
  return {
    nodes,
    identities,
    refIndex,
    edges: definition.edges ?? [],
    entryIndexes: [...entrySet].sort((a, b) => a - b),
  };
}

/**
 * Validate a graph-mode team definition. Returns a list of human-readable
 * problems; an empty list means the definition is executable by the engine.
 */
export function validateTeamGraph(definition: TeamDefinition): string[] {
  const errors: string[] = [];
  const nodes = definition.nodes ?? [];

  if (nodes.length === 0) {
    errors.push('graph mode requires at least one node');
    return errors;
  }
  if (nodes.length > MAX_GRAPH_NODES) {
    errors.push(`graph mode supports at most ${MAX_GRAPH_NODES} nodes (got ${nodes.length})`);
  }

  // Refs must be unique — an ambiguous edge target is a config error, not
  // something to silently disambiguate with #n suffixes.
  const seenRefs = new Map<string, number>();
  nodes.forEach((node, i) => {
    const ref = graphNodeRef(node);
    if (!ref) {
      errors.push(`node ${i + 1} has no id/name/role/model to address it by`);
      return;
    }
    const prev = seenRefs.get(ref);
    if (prev !== undefined) {
      errors.push(`duplicate node ref "${ref}" (nodes ${prev + 1} and ${i + 1}) — give each node a unique id`);
    } else {
      seenRefs.set(ref, i);
    }
  });

  const graph = indexGraph(definition);

  if (graph.entryIndexes.length === 0) {
    errors.push('graph mode requires at least one entry node (`entry: true` or `entryNodeIds`)');
  }
  for (const ref of definition.entryNodeIds ?? []) {
    if (!graph.refIndex.has(ref.trim())) {
      errors.push(`entryNodeIds references unknown node "${ref}"`);
    }
  }

  graph.edges.forEach((edge, i) => {
    const from = graph.refIndex.get((edge.from ?? '').trim());
    const to = graph.refIndex.get((edge.to ?? '').trim());
    if (from === undefined) errors.push(`edge ${i + 1} references unknown "from" node "${edge.from}"`);
    if (to === undefined) errors.push(`edge ${i + 1} references unknown "to" node "${edge.to}"`);
    if (from !== undefined && to !== undefined && from === to) {
      errors.push(`edge ${i + 1} is a self-loop on "${edge.from}"`);
    }
    if (edge.condition && /^\/.*\/[a-z]*$/.test(edge.condition.trim())) {
      const match = edge.condition.trim().match(/^\/(.*)\/([a-z]*)$/);
      try {
        new RegExp(match![1]!, match![2]);
      } catch {
        errors.push(`edge ${i + 1} has an invalid regex condition: ${edge.condition}`);
      }
    }
  });

  // DAG check over ALL edges (not just on_complete): a cycle is a config error
  // even when part of it would not auto-schedule in v1. Kahn's algorithm.
  if (!errors.some((e) => e.startsWith('edge') || e.startsWith('duplicate'))) {
    const indegree = new Array(nodes.length).fill(0);
    const adjacency: number[][] = nodes.map(() => []);
    for (const edge of graph.edges) {
      const from = graph.refIndex.get(edge.from.trim());
      const to = graph.refIndex.get(edge.to.trim());
      if (from === undefined || to === undefined) continue;
      adjacency[from]!.push(to);
      indegree[to] += 1;
    }
    const queue = indegree.map((d, i) => (d === 0 ? i : -1)).filter((i) => i >= 0);
    let visited = 0;
    while (queue.length) {
      const current = queue.shift()!;
      visited += 1;
      for (const next of adjacency[current]!) {
        indegree[next] -= 1;
        if (indegree[next] === 0) queue.push(next);
      }
    }
    if (visited < nodes.length) {
      errors.push('graph contains a cycle — v1 graphs must be a DAG');
    }
  }

  return errors;
}

/** Throwing variant of `validateTeamGraph` for engine entry points. */
export function assertValidTeamGraph(definition: TeamDefinition): void {
  const errors = validateTeamGraph(definition);
  if (errors.length) {
    throw new Error(`Invalid team graph "${definition.name}": ${errors.join('; ')}`);
  }
}

/**
 * Pure v1 → v2 migrator. Maps legacy members/primary/reviewer onto graph
 * nodes + edges and converts `reviewEdges` into `channel: 'review'` edges,
 * dropping the legacy field (no long-term dual-track). The input is not
 * mutated; a definition that is already graph-orchestrated is returned as-is.
 *
 * Shape produced:
 *  - panel modes: every member is an entry node; with a `primary` each member
 *    additionally feeds it via an `on_complete` edge (parallel → synthesize).
 *  - reviewer modes: the reviewer becomes the single entry node.
 */
export function migrateTeamDefinitionToV2(definition: TeamDefinition): TeamDefinition {
  if (definition.orchestration === 'graph' || definition.mode === 'graph') {
    return definition;
  }

  const nodes: TeamGraphNode[] = [];
  const edges: TeamGraphEdge[] = [];
  const isReviewer = definition.mode === 'reviewer' || definition.mode === 'executor-reviewer';

  if (isReviewer) {
    if (definition.reviewer) nodes.push({ ...definition.reviewer, entry: true });
  } else {
    for (const member of definition.members ?? []) {
      nodes.push({ ...member, entry: true });
    }
    if (definition.primary) {
      const primaryNode: TeamGraphNode = { ...definition.primary };
      nodes.push(primaryNode);
      const primaryRef = graphNodeRef(primaryNode) || 'primary';
      for (const member of definition.members ?? []) {
        const from = graphNodeRef(member);
        if (from) edges.push({ from, to: primaryRef, channel: 'message', trigger: 'on_complete' });
      }
    }
  }

  // reviewEdges → review edges (then dropped — the field does not carry forward).
  for (const reviewEdge of definition.reviewEdges ?? []) {
    if (!reviewEdge?.from || !reviewEdge?.to) continue;
    edges.push({
      from: reviewEdge.from,
      to: reviewEdge.to,
      channel: 'review',
      trigger: 'on_complete',
      note: reviewEdge.note,
    });
  }

  const migrated: TeamDefinition = {
    ...definition,
    mode: 'graph',
    version: 2,
    orchestration: 'graph',
    nodes,
    edges,
  };
  delete migrated.reviewEdges;
  return migrated;
}

// ═══════════════════════════════════════════════════════════════════
//  Engine — injectable-runner orchestration (unit-testable, no model calls)
// ═══════════════════════════════════════════════════════════════════

export interface GraphNodeRunResult {
  report: string;
  ok: boolean;
  error?: string;
}

/** Outcome of one `NotifyTeammate` push from a running node. */
export interface GraphNotifyResult {
  ok: boolean;
  /** Identity ids the message was delivered to. */
  delivered: string[];
  error?: string;
}

/** Per-node context the engine hands to `runNode`. */
export interface GraphNodeRunContext {
  /**
   * Identity ids reachable from this node over communication edges
   * (`on_tool_call` / `on_handoff` / `on_review_request`). Empty when the
   * node has none — do not offer a NotifyTeammate tool then.
   */
  commTargets: string[];
  /**
   * Push a message along this node's communication edges. `to: '*'`
   * broadcasts to every commTarget. Delivery wakes a target that is not yet
   * running and whose `on_complete` requirements are satisfied; a target
   * already running (or done) does not receive it.
   */
  notify: (to: string, message: string) => GraphNotifyResult;
}

export interface OrchestrateGraphOptions {
  prompt: string;
  definition: TeamDefinition;
  /** Runs one node to completion (the real engine wraps `runMemberAgent`). */
  runNode: (
    node: TeamGraphNode,
    identity: MemberIdentity,
    task: string,
    ctx: GraphNodeRunContext,
  ) => Promise<GraphNodeRunResult>;
  onEvent?: (event: TeamEvent) => void;
}

export interface OrchestrateGraphResult {
  answer: string;
  /** Identity ids of nodes that never ran (unreachable / gated out / never notified). */
  skipped: string[];
  /** Per-node reports in completion order. */
  reports: Array<{ id: string; report: string; ok: boolean }>;
}

function renderPayload(edge: TeamGraphEdge, fromId: string, output: string, runPrompt: string): string {
  if (edge.payloadTemplate) {
    return edge.payloadTemplate
      .replaceAll('{{from.output}}', output)
      .replaceAll('{{from.id}}', fromId)
      .replaceAll('{{run.prompt}}', runPrompt);
  }
  return `## Input from ${fromId}\n${output}`;
}

function autoSchedules(trigger: TeamGraphTrigger | undefined): boolean {
  return (trigger ?? 'on_complete') === 'on_complete';
}

const COMMUNICATION_TRIGGERS: ReadonlySet<TeamGraphTrigger> = new Set([
  'on_tool_call',
  'on_handoff',
  'on_review_request',
]);

function isCommunicationTrigger(trigger: TeamGraphTrigger | undefined): boolean {
  return trigger !== undefined && COMMUNICATION_TRIGGERS.has(trigger);
}

/**
 * Evaluate an edge's `condition` gate against the upstream output.
 * `/pattern/flags` → regex test; anything else → substring test.
 */
export function edgeConditionPasses(condition: string | undefined, output: string): boolean {
  if (!condition) return true;
  const trimmed = condition.trim();
  const regexMatch = trimmed.match(/^\/(.*)\/([a-z]*)$/);
  if (regexMatch) {
    try {
      return new RegExp(regexMatch[1]!, regexMatch[2]).test(output);
    } catch {
      return false;
    }
  }
  return output.includes(trimmed);
}

/**
 * Execute the graph: entries start in parallel with the run prompt; every
 * completed node fires its `on_complete` out-edges (emitting
 * `team.edge.triggered`); downstream nodes wake per their join semantics
 * (wait-all by default, OR-join with `join: 'any'`), receiving the original
 * prompt plus each rendered payload. Condition gates release join slots
 * without payloads and can short-circuit whole branches. Communication edges
 * deliver via the `ctx.notify` push (see `GraphNodeRunContext`). The answer
 * is the concatenation of terminal (no auto out-edge) node reports.
 */
export async function orchestrateGraph(opts: OrchestrateGraphOptions): Promise<OrchestrateGraphResult> {
  const graph = indexGraph(opts.definition);
  const { nodes, identities, refIndex } = graph;

  // Pre-compute topology: auto (on_complete) vs communication edges.
  const outgoing: Map<number, TeamGraphEdge[]> = new Map();
  const commOutgoing: Map<number, TeamGraphEdge[]> = new Map();
  const remainingIn = new Array(nodes.length).fill(0);
  for (const edge of graph.edges) {
    const from = refIndex.get(edge.from.trim())!;
    const to = refIndex.get(edge.to.trim())!;
    if (autoSchedules(edge.trigger)) {
      if (!outgoing.has(from)) outgoing.set(from, []);
      outgoing.get(from)!.push(edge);
      remainingIn[to] += 1;
    } else if (isCommunicationTrigger(edge.trigger)) {
      if (!commOutgoing.has(from)) commOutgoing.set(from, []);
      commOutgoing.get(from)!.push(edge);
    }
    // `manual` edges never auto-dispatch.
  }

  const inputs: string[][] = nodes.map(() => []);
  const delivered = new Array(nodes.length).fill(0);
  const started = new Set<number>();
  const shortCircuited = new Set<number>();
  const completionOrder: Array<{ id: string; report: string; ok: boolean }> = [];
  const runs: Promise<void>[] = [];

  const buildTask = (index: number): string => {
    const sections = inputs[index]!;
    return sections.length ? `${opts.prompt}\n\n${sections.join('\n\n')}` : opts.prompt;
  };

  const joinMode = (index: number): 'all' | 'any' => nodes[index]!.join === 'any' ? 'any' : 'all';

  // Release one join slot on `to` (payload already pushed when delivered=true).
  // Wake rules: OR-join wakes on any delivery; wait-all wakes when every slot
  // resolved AND at least one payload arrived. All slots resolved with zero
  // payloads = conditional short-circuit → skip + cascade releases downstream.
  const resolveSlot = (to: number, deliveredPayload: boolean): void => {
    remainingIn[to] -= 1;
    if (deliveredPayload) delivered[to] += 1;
    if (started.has(to) || shortCircuited.has(to)) return;
    if (deliveredPayload && joinMode(to) === 'any') {
      schedule(to);
      return;
    }
    if (remainingIn[to] > 0) return;
    if (delivered[to] > 0) {
      schedule(to);
    } else {
      shortCircuited.add(to);
      cascadeRelease(to);
    }
  };

  // A short-circuited node fires nothing; its auto out-edges just release.
  const cascadeRelease = (index: number): void => {
    for (const edge of outgoing.get(index) ?? []) {
      resolveSlot(refIndex.get(edge.to.trim())!, false);
    }
  };

  const firedAuto = new Set<number>();

  const fireEdge = (edge: TeamGraphEdge, fromIndex: number, output: string): void => {
    const to = refIndex.get(edge.to.trim())!;
    const fromId = identities[fromIndex]!.id;
    if (!edgeConditionPasses(edge.condition, output)) {
      resolveSlot(to, false);
      return;
    }
    firedAuto.add(fromIndex);
    opts.onEvent?.({
      type: 'team.edge.triggered',
      from: fromId,
      to: identities[to]!.id,
      trigger: edge.trigger ?? 'on_complete',
      channel: edge.channel ?? 'message',
    });
    inputs[to]!.push(renderPayload(edge, fromId, output, opts.prompt));
    resolveSlot(to, true);
  };

  // Communication push: deliver along matching comm edges; wake targets whose
  // on_complete requirements are already met. `'*'` fans out to all targets.
  const notifyFrom = (fromIndex: number, to: string, message: string): GraphNotifyResult => {
    const edges = commOutgoing.get(fromIndex) ?? [];
    if (edges.length === 0) {
      return { ok: false, delivered: [], error: 'this node has no communication edges' };
    }
    const wanted = to.trim();
    const matching = wanted === '*'
      ? edges
      : edges.filter((e) => {
          const idx = refIndex.get(e.to.trim());
          return idx !== undefined && identities[idx]!.id === wanted;
        });
    if (matching.length === 0) {
      const valid = [...new Set(edges.map((e) => identities[refIndex.get(e.to.trim())!]!.id))];
      return { ok: false, delivered: [], error: `no communication edge to "${wanted}" (valid: ${valid.join(', ')} or *)` };
    }
    const deliveredIds: string[] = [];
    for (const edge of matching) {
      const toIndex = refIndex.get(edge.to.trim())!;
      if (started.has(toIndex) || shortCircuited.has(toIndex)) continue; // already running/done — dropped
      if (!edgeConditionPasses(edge.condition, message)) continue;
      opts.onEvent?.({
        type: 'team.edge.triggered',
        from: identities[fromIndex]!.id,
        to: identities[toIndex]!.id,
        trigger: edge.trigger ?? 'on_tool_call',
        channel: edge.channel ?? 'message',
      });
      inputs[toIndex]!.push(renderPayload(edge, identities[fromIndex]!.id, message, opts.prompt));
      delivered[toIndex] += 1;
      deliveredIds.push(identities[toIndex]!.id);
      if (remainingIn[toIndex] === 0) schedule(toIndex);
    }
    return deliveredIds.length > 0
      ? { ok: true, delivered: deliveredIds }
      : { ok: false, delivered: [], error: 'message not delivered (target already running/done, or gated out)' };
  };

  const buildContext = (index: number): GraphNodeRunContext => ({
    commTargets: [...new Set((commOutgoing.get(index) ?? []).map((e) => identities[refIndex.get(e.to.trim())!]!.id))],
    notify: (to, message) => notifyFrom(index, to, message),
  });

  function startRun(index: number): void {
    const node = nodes[index]!;
    const identity = identities[index]!;
    runs.push((async () => {
      const result = await opts.runNode(node, identity, buildTask(index), buildContext(index));
      completionOrder.push({ id: identity.id, report: result.report, ok: result.ok });
      const output = result.ok
        ? result.report
        : `[FAILED: ${identity.id} — ${result.error ?? 'unknown error'}]`;
      for (const edge of outgoing.get(index) ?? []) fireEdge(edge, index, output);
    })());
  }

  function schedule(index: number): void {
    if (started.has(index) || shortCircuited.has(index)) return;
    started.add(index);
    startRun(index);
  }

  // Entries start in parallel. Mark them all as started before launching any,
  // so an entry's synchronous notify() cannot race-deliver into a sibling
  // entry that simply hasn't been launched yet. Nodes reachable only over
  // `manual` edges (or never-notified communication edges) never wake and are
  // reported skipped.
  for (const index of graph.entryIndexes) started.add(index);
  for (const index of graph.entryIndexes) startRun(index);

  // `runs` grows while draining — sequential await covers late additions.
  for (let i = 0; i < runs.length; i += 1) await runs[i];

  const skipped = nodes
    .map((_, i) => i)
    .filter((i) => !started.has(i))
    .map((i) => identities[i]!.id);

  // Terminal = ran and delivered no auto out-edge payload (either it has no
  // auto out-edges, or every one was gated out — its output flowed nowhere).
  // Those reports are the answer.
  const terminalIds = new Set(
    nodes
      .map((_, i) => i)
      .filter((i) => started.has(i) && !firedAuto.has(i))
      .map((i) => identities[i]!.id),
  );
  const terminalReports = completionOrder.filter((r) => terminalIds.has(r.id));
  const answer = terminalReports.length === 1
    ? terminalReports[0]!.report
    : terminalReports.map((r) => `### ${r.id}\n${r.report}`).join('\n\n---\n\n');

  return { answer, skipped, reports: completionOrder };
}

// ═══════════════════════════════════════════════════════════════════
//  NotifyTeammate — the communication-edge push tool (Phase 3)
// ═══════════════════════════════════════════════════════════════════

/**
 * Build the `NotifyTeammate` tool for a node that has outgoing communication
 * edges. The tool pushes a message along those edges via the engine's
 * `ctx.notify`; `to: '*'` broadcasts to every listed teammate.
 */
export async function createNotifyTeammateTool(ctx: GraphNodeRunContext) {
  const { z } = await import('zod');
  const { tool } = await import('../runtime/tools.js');
  const targets = ctx.commTargets.join(', ');
  return tool(
    {
      name: 'NotifyTeammate',
      description: [
        `Push a message to a downstream teammate over your communication edges (targets: ${targets}).`,
        'Use it to hand off work, request a review, or share findings mid-run.',
        `Set to: '*' to broadcast to all targets. A teammate that is already running (or finished) will not receive it.`,
      ].join(' '),
      inputSchema: z.strictObject({
        to: z.string().describe(`Teammate id to notify (one of: ${targets}) or '*' for all`),
        message: z.string().min(1).describe('The message/payload to deliver'),
      }),
      isReadOnly: () => true,
      isConcurrencySafe: () => false,
    },
    async (input: { to: string; message: string }) => {
      const result = ctx.notify(input.to, input.message);
      if (result.ok) return `Delivered to: ${result.delivered.join(', ')}`;
      return `Not delivered: ${result.error ?? 'unknown error'}`;
    },
  );
}

// ═══════════════════════════════════════════════════════════════════
//  Node tool resolution (graph nodes may opt in to specific core tools)
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve a graph node's toolset. Absent `allowedTools` → the same read-only
 * expert tools panel members get. With `allowedTools`, the whitelist filters
 * the full core toolset (granting Write/Bash is an explicit, per-node act —
 * the editor confirms it, the engine honors it).
 */
export async function buildGraphNodeTools(node: TeamGraphNode, cwd: string) {
  const { buildReadOnlyExpertTools } = await import('./teamRuntime.js');
  if (!node.allowedTools?.length) return buildReadOnlyExpertTools(cwd);
  const { createActoviqCoreTools } = await import('../tools/actoviqCoreTools.js');
  const { createTavilySearchTool } = await import('../tools/tavilySearch.js');
  const allow = new Set(node.allowedTools);
  const core = createActoviqCoreTools({ cwd });
  const pool = core.some((t) => t.name === 'TavilySearch') ? core : [...core, createTavilySearchTool()];
  return pool.filter((tool) => allow.has(tool.name));
}

/** Collected outcome of a full graph run (per-node statuses + token totals). */
export interface GraphRunAccounting {
  memberStatuses: MemberStatus[];
  perModelTokens: Map<string, { input: number; output: number }>;
  totalInput: number;
  totalOutput: number;
}
