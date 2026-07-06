/**
 * Team graph orchestration v3 — Task entry + Return exit ports, loop convergence.
 * Plan: plan/TEAM_GRAPH_TASK_RETURN_06Jul2026.md
 */
import type {
  TeamDefinition,
  TeamEvent,
  TeamGraphEdge,
  TeamGraphNode,
  TeamGraphReturnMode,
  TeamMember,
} from '../types.js';
import { buildMemberIdentities, type MemberIdentity } from './teamRuntime.js';
import {
  edgeConditionPasses,
  expandTeamGraphEdges,
  graphNodeRef,
  migrateTeamDefinitionToV2,
  type OrchestrateGraphOptions,
  type OrchestrateGraphResult,
} from './teamGraph.js';

export function graphNodeKind(node: TeamGraphNode): 'task' | 'agent' | 'return' {
  return node.kind ?? 'agent';
}

export function isPortNode(node: TeamGraphNode): boolean {
  const k = graphNodeKind(node);
  return k === 'task' || k === 'return';
}

export function isTeamGraphV3(definition: TeamDefinition): boolean {
  if ((definition.version ?? 0) >= 3) return true;
  return (definition.nodes ?? []).some((n) => n.kind === 'task' || n.kind === 'return');
}

function portRef(node: TeamGraphNode): string {
  const k = graphNodeKind(node);
  if (k === 'task') return (node.id ?? 'task').trim() || 'task';
  if (k === 'return') return (node.id ?? 'return').trim() || 'return';
  return graphNodeRef(node);
}

/** Agent-only identities (task/return ports are not ReAct members). */
function buildAgentIdentities(nodes: TeamGraphNode[]): MemberIdentity[] {
  return buildMemberIdentities(nodes.filter((n) => graphNodeKind(n) === 'agent'));
}

interface V3GraphIndex {
  nodes: TeamGraphNode[];
  agentIdentities: MemberIdentity[];
  refIndex: Map<string, number>;
  edges: TeamGraphEdge[];
  taskIndex: number;
  returnIndexes: number[];
}

function indexGraphV3(definition: TeamDefinition): V3GraphIndex {
  const nodes = definition.nodes ?? [];
  const agentIdentities = buildAgentIdentities(nodes);
  const refIndex = new Map<string, number>();
  nodes.forEach((node, i) => {
    const ref = portRef(node);
    if (ref && !refIndex.has(ref)) refIndex.set(ref, i);
    if (graphNodeKind(node) === 'agent') {
      const ai = agentIdentities.findIndex(
        (id) => id.id === graphNodeRef(node) || id.role === node.role,
      );
      if (ai >= 0) {
        const id = agentIdentities[ai]!.id;
        if (!refIndex.has(id)) refIndex.set(id, i);
      }
    }
  });
  let taskIndex = -1;
  const returnIndexes: number[] = [];
  nodes.forEach((node, i) => {
    if (graphNodeKind(node) === 'task') taskIndex = i;
    if (graphNodeKind(node) === 'return') returnIndexes.push(i);
  });
  return {
    nodes,
    agentIdentities,
    refIndex,
    edges: expandTeamGraphEdges(definition.edges ?? []),
    taskIndex,
    returnIndexes,
  };
}

function identityForAgentIndex(index: number, graph: V3GraphIndex): MemberIdentity {
  const node = graph.nodes[index]!;
  const ref = graphNodeRef(node);
  return graph.agentIdentities.find((id) => id.id === ref)
    ?? { id: ref || `agent-${index}`, model: node.model ?? '', role: node.role };
}

/** v3 graph validation (Task×1, Return≥1, reachability, loop caps). */
export function validateTeamGraphV3(definition: TeamDefinition): string[] {
  const errors: string[] = [];
  const nodes = definition.nodes ?? [];
  if (nodes.length === 0) {
    errors.push('graph mode requires at least one node');
    return errors;
  }

  const tasks = nodes.filter((n) => graphNodeKind(n) === 'task');
  const returns = nodes.filter((n) => graphNodeKind(n) === 'return');
  if (tasks.length !== 1) {
    errors.push(`graph v3 requires exactly one Task entry node (found ${tasks.length})`);
  }
  if (returns.length === 0) {
    errors.push('graph v3 requires at least one Return exit node');
  }

  const seenRefs = new Map<string, number>();
  nodes.forEach((node, i) => {
    const ref = portRef(node);
    if (!ref) {
      errors.push(`node ${i + 1} has no id to address it by`);
      return;
    }
    const prev = seenRefs.get(ref);
    if (prev !== undefined) {
      errors.push(`duplicate node ref "${ref}" (nodes ${prev + 1} and ${i + 1})`);
    } else {
      seenRefs.set(ref, i);
    }
    if (graphNodeKind(node) === 'agent') {
      const model = node.model;
      // Empty string = "use session model" placeholder (built-in presets).
      if (model !== '' && !model?.trim()) {
        errors.push(`agent node "${ref}" requires a model`);
      }
    }
    if (graphNodeKind(node) === 'return' && !node.returnMode) {
      errors.push(`return node "${ref}" requires returnMode (void or payload)`);
    }
  });

  const graph = indexGraphV3(definition);
  if (graph.taskIndex < 0) {
    errors.push('graph v3 Task entry node not found in index');
    return errors;
  }

  graph.edges.forEach((edge, i) => {
    const from = graph.refIndex.get((edge.from ?? '').trim());
    const to = graph.refIndex.get((edge.to ?? '').trim());
    if (from === undefined) errors.push(`edge ${i + 1} references unknown "from" node "${edge.from}"`);
    if (to === undefined) errors.push(`edge ${i + 1} references unknown "to" node "${edge.to}"`);
    if (to !== undefined && graphNodeKind(nodes[to]!) === 'task') {
      errors.push(`edge ${i + 1} must not target Task "${edge.to}" — Task is dispatch-only (outgoing edges)`);
    }
    if (from !== undefined && to !== undefined && from === to && !edge.loop) {
      errors.push(`edge ${i + 1} is a self-loop on "${edge.from}" — set loop: true with maxRounds`);
    }
  });

  if (!errors.length) {
    const reachableReturn = returns.some((r) => {
      const target = portRef(r);
      return pathExistsToReturn(graph, graph.taskIndex, target);
    });
    if (!reachableReturn) {
      errors.push('no path from Task entry to any Return exit');
    }
  }

  const hasLoop = graph.edges.some((e) => e.loop);
  if (hasLoop && !(definition.maxRounds && definition.maxRounds >= 2)) {
    errors.push('graph with loop edges requires maxRounds >= 2 on the squad definition');
  }

  if (!errors.some((e) => e.startsWith('edge') || e.startsWith('duplicate'))) {
    const cycleError = detectUncontrolledCycle(graph);
    if (cycleError) errors.push(cycleError);
  }

  return errors;
}

function pathExistsToReturn(graph: V3GraphIndex, start: number, returnRef: string): boolean {
  const returnIdx = graph.refIndex.get(returnRef);
  if (returnIdx === undefined) return false;
  const adj = buildAutoAdjacency(graph);
  const queue = [start];
  const seen = new Set<number>([start]);
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === returnIdx) return true;
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

function buildAutoAdjacency(graph: V3GraphIndex): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  for (const edge of graph.edges) {
    if ((edge.trigger ?? 'on_complete') !== 'on_complete') continue;
    const from = graph.refIndex.get(edge.from.trim());
    const to = graph.refIndex.get(edge.to.trim());
    if (from === undefined || to === undefined) continue;
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push(to);
  }
  return adj;
}

function detectUncontrolledCycle(graph: V3GraphIndex): string | null {
  const nodes = graph.nodes;
  const indegree = new Array(nodes.length).fill(0);
  const adjacency: number[][] = nodes.map(() => []);
  for (const edge of graph.edges) {
    const from = graph.refIndex.get(edge.from.trim());
    const to = graph.refIndex.get(edge.to.trim());
    if (from === undefined || to === undefined) continue;
    adjacency[from]!.push(to);
    if (!edge.loop) indegree[to] += 1;
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
    const hasLoopEdge = graph.edges.some((e) => e.loop);
    if (!hasLoopEdge) return 'graph contains a cycle — mark loop edges with loop: true and set maxRounds';
  }
  return null;
}

/** Task dispatch targets: refs of agents (or ports) reached directly from Task. */
function taskDispatchTargets(edges: TeamGraphEdge[], taskRef = 'task'): string[] {
  return [...new Set(
    edges
      .filter((e) => e.from.trim() === taskRef && (e.trigger ?? 'on_complete') === 'on_complete')
      .map((e) => e.to.trim())
      .filter(Boolean),
  )];
}

/**
 * Task is a one-shot dispatch port — no incoming edges. Loop rounds re-hand off
 * to Task's dispatch targets instead of routing back through Task.
 */
export function sanitizeV3GraphTopology(definition: TeamDefinition): TeamDefinition {
  const nodes = definition.nodes ?? [];
  const taskNode = nodes.find((n) => graphNodeKind(n) === 'task');
  if (!taskNode) return definition;
  const taskRef = portRef(taskNode);
  const edges = [...(definition.edges ?? [])];
  const entryTargets = taskDispatchTargets(edges, taskRef);

  for (let i = edges.length - 1; i >= 0; i -= 1) {
    const edge = edges[i]!;
    if (edge.to.trim() !== taskRef) continue;
    if (edge.loop) {
      for (const target of entryTargets) {
        const dup = edges.some(
          (e) => e.from === edge.from && e.to === target && e.loop && e.condition === edge.condition,
        );
        if (!dup) {
          edges.push({ ...edge, to: target });
        }
      }
    }
    edges.splice(i, 1);
  }

  definition.edges = edges;
  return definition;
}

/**
 * v2/v1 graph → v3: insert Task + Return ports, rewire entries and terminals.
 */
export function migrateTeamDefinitionToV3(definition: TeamDefinition): TeamDefinition {
  const wasReviewer = definition.mode === 'reviewer' || definition.mode === 'executor-reviewer';
  const base = definition.orchestration === 'graph' || definition.mode === 'graph'
    ? structuredClone(definition)
    : migrateTeamDefinitionToV2(definition);

  if (isTeamGraphV3(base) && base.nodes?.some((n) => n.kind === 'task')) {
    return sanitizeV3GraphTopology({ ...base, version: 3 });
  }

  const agents: TeamGraphNode[] = (base.nodes ?? [])
    .filter((n) => graphNodeKind(n) !== 'task' && graphNodeKind(n) !== 'return')
    .map((n) => {
      const { entry: _e, ...rest } = n;
      return { ...rest, kind: 'agent' as const };
    });

  const edges: TeamGraphEdge[] = [...(base.edges ?? [])].filter(
    (e) => !['task', 'return', 'return-void'].includes(e.from) && !['task', 'return', 'return-void'].includes(e.to),
  );

  const entryRefs = new Set<string>();
  (base.nodes ?? []).forEach((n) => { if (n.entry) entryRefs.add(graphNodeRef(n)); });
  (base.entryNodeIds ?? []).forEach((r) => entryRefs.add(r.trim()));

  const taskNode: TeamGraphNode = { kind: 'task', id: 'task', ui: { x: 24, y: 48 } };
  const voidReturn: TeamGraphNode = { kind: 'return', id: 'return-void', returnMode: 'void', ui: { x: 520, y: 360 } };
  const payloadReturn: TeamGraphNode = {
    kind: 'return',
    id: 'return',
    returnMode: 'payload',
    payloadTemplate: '{{from.output}}',
    ui: { x: 520, y: 240 },
  };

  const isReviewer = wasReviewer || Boolean(base.reviewer && !(base.members?.length));
  const primaryRef = base.primary ? graphNodeRef(base.primary as TeamMember) : '';
  const hasPrimary = Boolean(primaryRef && agents.some((n) => graphNodeRef(n) === primaryRef));

  const nodes: TeamGraphNode[] = [taskNode, ...agents];
  if (isReviewer) nodes.push(payloadReturn);
  else nodes.push(voidReturn);

  const dispatchFromTask = (ref: string) => {
    if (!ref || edges.some((e) => e.from === 'task' && e.to === ref)) return;
    edges.push({
      from: 'task',
      to: ref,
      trigger: 'on_complete',
      channel: 'message',
      payloadTemplate: '{{run.prompt}}',
    });
  };

  if (entryRefs.size) entryRefs.forEach(dispatchFromTask);
  else agents.forEach((n) => dispatchFromTask(graphNodeRef(n)));

  if (hasPrimary && primaryRef) {
    if (!edges.some((e) => e.from === primaryRef && e.to === 'return-void')) {
      edges.push({ from: primaryRef, to: 'return-void', trigger: 'on_complete', condition: 'FINALIZE', channel: 'message' });
    }
    const loopTargets = taskDispatchTargets(edges, 'task');
    for (const target of loopTargets) {
      if (edges.some((e) => e.from === primaryRef && e.to === target && e.loop)) continue;
      edges.push({
        from: primaryRef,
        to: target,
        trigger: 'on_complete',
        condition: '/^CONTINUE/i',
        channel: 'message',
        loop: true,
      });
    }
  }

  const autoFrom = new Set<string>();
  for (const edge of edges) {
    if ((edge.trigger ?? 'on_complete') === 'on_complete') autoFrom.add(edge.from.trim());
  }
  for (const n of agents) {
    const ref = graphNodeRef(n);
    if (!ref || autoFrom.has(ref)) continue;
    const targetReturn = isReviewer ? 'return' : 'return-void';
    edges.push({ from: ref, to: targetReturn, trigger: 'on_complete', channel: 'message' });
    autoFrom.add(ref);
  }

  if (isReviewer) {
    const agentRef = agents[0] ? graphNodeRef(agents[0]) : '';
    if (agentRef && !edges.some((e) => e.from === agentRef && e.to === 'return')) {
      edges.push({ from: agentRef, to: 'return', trigger: 'on_complete', channel: 'message' });
    }
  }

  return sanitizeV3GraphTopology({
    ...base,
    mode: 'graph',
    version: 3,
    orchestration: 'graph',
    nodes,
    edges,
    maxRounds: base.maxRounds ?? (hasPrimary ? 100 : undefined),
    entryNodeIds: undefined,
    reviewEdges: undefined,
  });
}

/** v1/v2 → v3 in one step (GUI load / save path). */
export function migrateTeamDefinitionToGraph(definition: TeamDefinition): TeamDefinition {
  return migrateTeamDefinitionToV3(migrateTeamDefinitionToV2(definition));
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

function renderReturnPayload(
  node: TeamGraphNode,
  inputs: string[],
  runPrompt: string,
  fromId: string,
  fromOutput: string,
): string {
  const tpl = node.payloadTemplate ?? '{{from.output}}';
  return tpl
    .replaceAll('{{from.output}}', fromOutput)
    .replaceAll('{{from.id}}', fromId)
    .replaceAll('{{run.prompt}}', runPrompt)
    .replaceAll('{{inputs}}', inputs.join('\n\n'));
}

/**
 * v3 engine: Task dispatches prompt once; Return terminates with void/payload;
 * loop edges re-hand off to Task's dispatch targets (never back through Task).
 */
export async function orchestrateGraphV3(opts: OrchestrateGraphOptions): Promise<OrchestrateGraphResult> {
  const graph = indexGraphV3(opts.definition);
  const { nodes, refIndex, taskIndex } = graph;
  const maxRounds = opts.definition.maxRounds ?? 100;

  const outgoing = new Map<number, TeamGraphEdge[]>();
  const commOutgoing = new Map<number, TeamGraphEdge[]>();
  const initialRemainingIn = new Array(nodes.length).fill(0);
  const taskEntryRefs = new Set(
    (graph.edges ?? [])
      .filter((e) => e.from.trim() === portRef(nodes[taskIndex]!) && (e.trigger ?? 'on_complete') === 'on_complete')
      .map((e) => e.to.trim()),
  );

  for (const edge of graph.edges) {
    const from = refIndex.get(edge.from.trim());
    const to = refIndex.get(edge.to.trim());
    if (from === undefined || to === undefined) continue;
    const trigger = edge.trigger ?? 'on_complete';
    if (trigger === 'on_complete') {
      if (!outgoing.has(from)) outgoing.set(from, []);
      outgoing.get(from)!.push(edge);
      if (!edge.loop) initialRemainingIn[to] += 1;
    } else if (trigger === 'on_tool_call' || trigger === 'on_handoff' || trigger === 'on_review_request') {
      if (!commOutgoing.has(from)) commOutgoing.set(from, []);
      commOutgoing.get(from)!.push(edge);
    }
  }

  let remainingIn = [...initialRemainingIn];
  const inputs: string[][] = nodes.map(() => []);
  const delivered = new Array(nodes.length).fill(0);
  const started = new Set<number>();
  const shortCircuited = new Set<number>();
  const completionOrder: Array<{ id: string; report: string; ok: boolean }> = [];
  const runs: Promise<void>[] = [];

  let rounds = 1;
  let graphDone = false;
  let returnValue: string | null = null;
  let returnMode: TeamGraphReturnMode = 'void';
  let returnNodeId: string | undefined;
  let incompleteReason: string | undefined;
  let lastFromOutput = '';
  let lastFromId = 'task';
  let continuingRound = false;

  const buildTask = (index: number): string => {
    const sections = inputs[index]!.filter((s) => s.trim() && s !== opts.prompt);
    return sections.length ? `${opts.prompt}\n\n${sections.join('\n\n')}` : opts.prompt;
  };

  const joinMode = (index: number): 'all' | 'any' => nodes[index]!.join === 'any' ? 'any' : 'all';

  const completeReturn = (index: number, fromIndex: number, fromOutput: string): void => {
    if (graphDone) return;
    graphDone = true;
    const node = nodes[index]!;
    returnNodeId = portRef(node);
    returnMode = node.returnMode ?? 'void';
    if (returnMode === 'void') {
      returnValue = null;
    } else {
      returnValue = renderReturnPayload(node, inputs[index]!, opts.prompt, lastFromId, fromOutput);
    }
    opts.onEvent?.({
      type: 'team.returned',
      nodeId: returnNodeId,
      returnMode,
      returnValue: returnValue ?? undefined,
    });
  };

  const resolveSlot = (to: number, deliveredPayload: boolean, fromIndex: number, fromOutput: string): void => {
    if (graphDone) return;
    remainingIn[to] -= 1;
    if (deliveredPayload) delivered[to] += 1;
    if (graphNodeKind(nodes[to]!) === 'return') {
      if (remainingIn[to] > 0) return;
      if (delivered[to] > 0) {
        completeReturn(to, fromIndex, fromOutput);
      }
      return;
    }
    if (started.has(to) || shortCircuited.has(to)) return;
    if (deliveredPayload && joinMode(to) === 'any') {
      schedule(to);
      return;
    }
    if (remainingIn[to] > 0) return;
    if (delivered[to] > 0) schedule(to);
    else {
      shortCircuited.add(to);
      cascadeRelease(to);
    }
  };

  const cascadeRelease = (index: number): void => {
    for (const edge of outgoing.get(index) ?? []) {
      resolveSlot(refIndex.get(edge.to.trim())!, false, index, '');
    }
  };

  const fireEdge = (edge: TeamGraphEdge, fromIndex: number, output: string): void => {
    if (graphDone) return;
    const to = refIndex.get(edge.to.trim())!;
    const fromId = graphNodeKind(nodes[fromIndex]!) === 'task'
      ? 'task'
      : identityForAgentIndex(fromIndex, graph).id;
    lastFromId = fromId;
    lastFromOutput = output;

    const toRef = portRef(nodes[to]!);
    const isLoopRoundEdge = edge.loop && (
      graphNodeKind(nodes[to]!) === 'task' || taskEntryRefs.has(toRef)
    );

    if (isLoopRoundEdge) {
      if (!edgeConditionPasses(edge.condition, output)) {
        resolveSlot(to, false, fromIndex, output);
        return;
      }
      if (continuingRound) return;
      opts.onEvent?.({ type: 'team.synthesis', round: rounds, decision: 'continue' });
      if (rounds >= maxRounds) {
        incompleteReason = `maxRounds (${maxRounds}) reached during loop`;
        opts.onEvent?.({ type: 'team.synthesis', round: rounds, decision: 'finalize' });
        const voidRet = graph.returnIndexes.find((i) => nodes[i]!.returnMode === 'void');
        if (voidRet !== undefined) completeReturn(voidRet, fromIndex, output);
        return;
      }
      continuingRound = true;
      rounds += 1;
      opts.onEvent?.({
        type: 'team.round.completed',
        round: rounds,
        reports: completionOrder.length,
      });
      redispatchEntryAgents();
      continuingRound = false;
      return;
    }

    if (!edgeConditionPasses(edge.condition, output)) {
      resolveSlot(to, false, fromIndex, output);
      return;
    }

    if (graphNodeKind(nodes[to]!) === 'return') {
      const isFinalize = (edge.condition ?? '').trim() === 'FINALIZE'
        || output.trim().toUpperCase().startsWith('FINALIZE');
      if (isFinalize) {
        opts.onEvent?.({ type: 'team.synthesis', round: rounds, decision: 'finalize' });
      }
    }

    opts.onEvent?.({
      type: 'team.edge.triggered',
      from: fromId,
      to: graphNodeKind(nodes[to]!) === 'return' ? portRef(nodes[to]!) : identityForAgentIndex(to, graph).id,
      trigger: edge.trigger ?? 'on_complete',
      channel: edge.channel ?? 'message',
    });

    if (graphNodeKind(nodes[to]!) === 'return') {
      inputs[to]!.push(renderPayload(edge, fromId, output, opts.prompt));
      resolveSlot(to, true, fromIndex, output);
      return;
    }

    inputs[to]!.push(renderPayload(edge, fromId, output, opts.prompt));
    resolveSlot(to, true, fromIndex, output);
  };

  const redispatchEntryAgents = (): void => {
    remainingIn = [...initialRemainingIn];
    inputs.fill([], 0, nodes.length);
    delivered.fill(0);
    started.clear();
    shortCircuited.clear();
    started.add(taskIndex);
    for (const edge of outgoing.get(taskIndex) ?? []) {
      fireEdge(edge, taskIndex, opts.prompt);
    }
  };

  const notifyFrom = (fromIndex: number, to: string, message: string) => {
    const edges = commOutgoing.get(fromIndex) ?? [];
    if (!edges.length) return { ok: false, delivered: [] as string[], error: 'no communication edges' };
    const deliveredIds: string[] = [];
    for (const edge of edges) {
      const toIndex = refIndex.get(edge.to.trim())!;
      if (started.has(toIndex) || shortCircuited.has(toIndex) || graphDone) continue;
      if (!edgeConditionPasses(edge.condition, message)) continue;
      inputs[toIndex]!.push(renderPayload(edge, identityForAgentIndex(fromIndex, graph).id, message, opts.prompt));
      delivered[toIndex] += 1;
      deliveredIds.push(portRef(nodes[toIndex]!));
      if (remainingIn[toIndex] === 0) schedule(toIndex);
    }
    return deliveredIds.length
      ? { ok: true, delivered: deliveredIds }
      : { ok: false, delivered: [], error: 'not delivered' };
  };

  const buildContext = (index: number) => ({
    commTargets: [...new Set((commOutgoing.get(index) ?? []).map((e) => portRef(nodes[refIndex.get(e.to.trim())!]!)))],
    notify: (to: string, message: string) => notifyFrom(index, to, message),
  });

  function startRun(index: number): void {
    if (graphDone) return;
    const node = nodes[index]!;
    if (graphNodeKind(node) === 'task' || graphNodeKind(node) === 'return') return;
    const identity = identityForAgentIndex(index, graph);
    runs.push((async () => {
      const result = await opts.runNode(node, identity, buildTask(index), buildContext(index));
      completionOrder.push({ id: identity.id, report: result.report, ok: result.ok });
      const output = result.ok ? result.report : `[FAILED: ${identity.id} — ${result.error ?? 'unknown'}]`;
      for (const edge of outgoing.get(index) ?? []) fireEdge(edge, index, output);
    })());
  }

  function schedule(index: number): void {
    if (graphDone || started.has(index) || shortCircuited.has(index)) return;
    const kind = graphNodeKind(nodes[index]!);
    if (kind === 'return') {
      if (remainingIn[index] === 0 && delivered[index] > 0) {
        completeReturn(index, taskIndex, lastFromOutput);
      }
      return;
    }
    started.add(index);
    if (kind === 'task') dispatchTask();
    else startRun(index);
  }

  function dispatchTask(): void {
    if (graphDone) return;
    started.add(taskIndex);
    const output = opts.prompt;
    for (const edge of outgoing.get(taskIndex) ?? []) fireEdge(edge, taskIndex, output);
  }

  dispatchTask();

  for (let i = 0; i < runs.length; i += 1) await runs[i];

  const skipped = nodes
    .map((_, i) => i)
    .filter((i) => graphNodeKind(nodes[i]!) === 'agent' && !started.has(i))
    .map((i) => identityForAgentIndex(i, graph).id);

  const answer = returnValue ?? '';

  return {
    answer,
    skipped,
    reports: completionOrder,
    returnValue,
    returnMode,
    returnNodeId,
    rounds,
    incompleteReason,
    lastFromOutput,
  };
}
