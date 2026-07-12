/**
 * Graph (team) scaffolds and insertable blocks — pure generators for
 * Task → agents → Return topologies. Used by GUI create/insert flows and tests.
 * Does not run the orchestrator; callers validate via validateTeamGraph.
 */
import type {
  TeamDefinition,
  TeamGraphEdge,
  TeamGraphNode,
  TeamGraphReturnMode,
} from '../types.js';
import { ensureConfiguredTeamGraph, migrateTeamDefinitionToGraph, validateTeamGraph } from './teamGraph.js';

export type GraphTeamTemplate = 'blank' | 'parallel' | 'review-loop';

export interface ParallelMemberSpec {
  id: string;
  role?: string;
  model?: string;
  systemPrompt?: string;
}

export interface ParallelBlockOptions {
  members: ParallelMemberSpec[];
  join?: 'all' | 'any';
  synthesizer?: boolean;
  synthesizerId?: string;
  returnMode?: TeamGraphReturnMode;
  /** When true, do not add Task/Return — only agents + edges into an existing graph. */
  intoExisting?: boolean;
}

export interface LoopBlockOptions {
  executorId?: string;
  reviewerId?: string;
  maxRounds?: number;
  returnMode?: TeamGraphReturnMode;
  /** Inline loop edges into `def` (default). */
  mode?: 'inline' | 'nested';
  /** Required when mode is nested — name of the child team definition. */
  nestedName?: string;
  intoExisting?: boolean;
}

export interface NestedBlockResult {
  /** Parent graph with a single `type: team` node referencing `nested`. */
  definition: TeamDefinition;
  nested: TeamDefinition;
}

/** @deprecated Use NestedBlockResult — kept for call-site clarity. */
export type NestedLoopResult = NestedBlockResult;

function baseGraphMeta(name: string, description?: string): Pick<TeamDefinition, 'name' | 'description' | 'mode' | 'version' | 'orchestration' | 'squadType' | 'members'> {
  return {
    name,
    ...(description ? { description } : {}),
    mode: 'graph',
    version: 3,
    orchestration: 'graph',
    squadType: 'graph',
    members: [],
  };
}

function agentNode(opts: {
  id: string;
  role?: string;
  model?: string;
  systemPrompt?: string;
  join?: 'all' | 'any';
  maxRounds?: number;
  x: number;
  y: number;
}): TeamGraphNode {
  return {
    kind: 'agent',
    id: opts.id,
    role: opts.role ?? opts.id,
    model: opts.model ?? '',
    systemPrompt: opts.systemPrompt ?? '',
    ...(opts.join ? { join: opts.join } : {}),
    ...(opts.maxRounds != null ? { maxRounds: opts.maxRounds } : {}),
    ui: { x: opts.x, y: opts.y },
  };
}

/** Minimal legal graph: Task → one agent → void Return. */
export function scaffoldMinimalGraphTeam(name: string, description?: string): TeamDefinition {
  const nodes: TeamGraphNode[] = [
    { kind: 'task', id: 'task', ui: { x: 40, y: 160 } },
    agentNode({
      id: 'agent-1',
      role: 'agent',
      systemPrompt: 'Primary agent. Complete the task using available tools.',
      x: 280,
      y: 140,
    }),
    { kind: 'return', id: 'return-void', returnMode: 'void', ui: { x: 560, y: 160 } },
  ];
  const edges: TeamGraphEdge[] = [
    { from: 'task', to: 'agent-1', trigger: 'on_complete' },
    { from: 'agent-1', to: 'return-void', trigger: 'on_complete' },
  ];
  return finalizeGraph({
    ...baseGraphMeta(name, description),
    nodes,
    edges,
  });
}

/** Parallel panel: Task fans out to members, optional synthesizer, then Return. */
export function scaffoldParallelPanelGraph(
  name: string,
  options: ParallelBlockOptions,
  description?: string,
): TeamDefinition {
  const members = options.members.filter((m) => m.id?.trim());
  if (members.length < 2) {
    throw new Error('Parallel panel requires at least 2 members');
  }
  const returnMode = options.returnMode === 'payload' ? 'payload' : 'void';
  const returnId = returnMode === 'payload' ? 'return' : 'return-void';
  const useSynth = options.synthesizer !== false;
  const synthId = (options.synthesizerId || 'synthesizer').trim() || 'synthesizer';
  const join = options.join === 'any' ? 'any' : 'all';

  const nodes: TeamGraphNode[] = [
    { kind: 'task', id: 'task', ui: { x: 40, y: 200 } },
  ];
  const edges: TeamGraphEdge[] = [];

  members.forEach((m, i) => {
    const id = m.id.trim();
    nodes.push(agentNode({
      id,
      role: m.role ?? id,
      model: m.model,
      systemPrompt: m.systemPrompt ?? `Panel member (${id}). Investigate independently; cite evidence.`,
      x: 280,
      y: 40 + i * 160,
    }));
    edges.push({ from: 'task', to: id, trigger: 'on_complete' });
  });

  if (useSynth) {
    nodes.push(agentNode({
      id: synthId,
      role: 'synthesizer',
      systemPrompt: 'Synthesizer. Reconcile panel findings into the best answer.',
      join,
      x: 520,
      y: 120,
    }));
    for (const m of members) {
      edges.push({ from: m.id.trim(), to: synthId, trigger: 'on_complete' });
    }
    nodes.push({
      kind: 'return',
      id: returnId,
      returnMode,
      ...(returnMode === 'payload' ? { payloadTemplate: '{{from.output}}' } : {}),
      ui: { x: 760, y: 160 },
    });
    edges.push({ from: synthId, to: returnId, trigger: 'on_complete' });
  } else {
    nodes.push({
      kind: 'return',
      id: returnId,
      returnMode,
      ...(returnMode === 'payload' ? { payloadTemplate: '{{from.output}}' } : {}),
      ui: { x: 560, y: 200 },
    });
    for (const m of members) {
      edges.push({ from: m.id.trim(), to: returnId, trigger: 'on_complete' });
    }
  }

  return finalizeGraph({
    ...baseGraphMeta(name, description),
    nodes,
    edges,
    maxRounds: 100,
  });
}

/** Review loop: executor ↔ reviewer with loop edge + maxRounds. */
export function scaffoldReviewLoopGraph(
  name: string,
  options: LoopBlockOptions = {},
  description?: string,
): TeamDefinition {
  const executorId = (options.executorId || 'executor').trim() || 'executor';
  const reviewerId = (options.reviewerId || 'reviewer').trim() || 'reviewer';
  const maxRounds = Math.max(2, options.maxRounds ?? 8);
  const returnMode = options.returnMode === 'payload' ? 'payload' : 'void';
  const returnId = returnMode === 'payload' ? 'return' : 'return-void';

  const nodes: TeamGraphNode[] = [
    { kind: 'task', id: 'task', ui: { x: 40, y: 180 } },
    agentNode({
      id: executorId,
      role: 'executor',
      systemPrompt: 'Executor. Implement or revise the solution. When the reviewer asks for changes, address them.',
      maxRounds,
      x: 280,
      y: 80,
    }),
    agentNode({
      id: reviewerId,
      role: 'reviewer',
      systemPrompt: 'Reviewer. Verify with evidence. Reply CONTINUE with concrete issues, or FINALIZE when the work is acceptable.',
      maxRounds,
      x: 280,
      y: 280,
    }),
    {
      kind: 'return',
      id: returnId,
      returnMode,
      ...(returnMode === 'payload' ? { payloadTemplate: '{{from.output}}' } : {}),
      ui: { x: 560, y: 180 },
    },
  ];
  const edges: TeamGraphEdge[] = [
    { from: 'task', to: executorId, trigger: 'on_complete' },
    { from: executorId, to: reviewerId, trigger: 'on_complete' },
    {
      from: reviewerId,
      to: executorId,
      trigger: 'on_complete',
      loop: true,
      condition: 'CONTINUE',
      direction: 'directed',
    },
    {
      from: reviewerId,
      to: returnId,
      trigger: 'on_complete',
      condition: 'FINALIZE',
    },
  ];

  return finalizeGraph({
    ...baseGraphMeta(name, description),
    nodes,
    edges,
    maxRounds,
  });
}

export function buildGraphTeamFromTemplate(
  name: string,
  template: GraphTeamTemplate,
  description?: string,
  options?: { parallel?: ParallelBlockOptions; loop?: LoopBlockOptions },
): TeamDefinition {
  if (template === 'parallel') {
    const members = options?.parallel?.members?.length
      ? options.parallel.members
      : [
          { id: 'researcher', role: 'researcher' },
          { id: 'skeptic', role: 'skeptic' },
        ];
    return scaffoldParallelPanelGraph(name, { synthesizer: true, join: 'all', ...options?.parallel, members }, description);
  }
  if (template === 'review-loop') {
    return scaffoldReviewLoopGraph(name, options?.loop ?? {}, description);
  }
  return scaffoldMinimalGraphTeam(name, description);
}

/**
 * Insert a parallel fan-out block into an existing graph (keeps the single Task).
 * Adds agents + edges from Task; wires to synthesizer or existing/primary Return.
 */
export function insertParallelBlock(def: TeamDefinition, options: ParallelBlockOptions): TeamDefinition {
  const base = structuredClone(def);
  base.nodes = base.nodes ? [...base.nodes] : [];
  base.edges = base.edges ? [...base.edges] : [];
  const members = options.members.filter((m) => m.id?.trim());
  if (members.length < 2) throw new Error('Parallel block requires at least 2 members');

  ensureTaskAndReturn(base, options.returnMode === 'payload' ? 'payload' : 'void');
  const taskId = 'task';
  const returnNode = base.nodes.find((n) => n.kind === 'return')!;
  const returnId = returnNode.id || 'return-void';
  const useSynth = options.synthesizer !== false;
  const synthId = (options.synthesizerId || 'synthesizer').trim() || 'synthesizer';
  const join = options.join === 'any' ? 'any' : 'all';
  const agentCount = base.nodes.filter((n) => !n.kind || n.kind === 'agent').length;

  members.forEach((m, i) => {
    const id = m.id.trim();
    if (base.nodes!.some((n) => (n.id || n.role) === id)) {
      throw new Error(`Node id "${id}" already exists`);
    }
    base.nodes!.push(agentNode({
      id,
      role: m.role ?? id,
      model: m.model,
      systemPrompt: m.systemPrompt ?? `Panel member (${id}).`,
      x: 280,
      y: 40 + (agentCount + i) * 140,
    }));
    base.edges!.push({ from: taskId, to: id, trigger: 'on_complete' });
  });

  if (useSynth) {
    if (!base.nodes.some((n) => (n.id || n.role) === synthId)) {
      base.nodes.push(agentNode({
        id: synthId,
        role: 'synthesizer',
        systemPrompt: 'Synthesizer. Reconcile panel findings.',
        join,
        x: 520,
        y: 120,
      }));
    } else {
      const existing = base.nodes.find((n) => (n.id || n.role) === synthId)!;
      existing.join = join;
    }
    for (const m of members) {
      base.edges!.push({ from: m.id.trim(), to: synthId, trigger: 'on_complete' });
    }
    if (!base.edges.some((e) => e.from === synthId && e.to === returnId)) {
      base.edges.push({ from: synthId, to: returnId, trigger: 'on_complete' });
    }
  } else {
    for (const m of members) {
      base.edges!.push({ from: m.id.trim(), to: returnId, trigger: 'on_complete' });
    }
  }

  return finalizeGraph(base);
}

/** Insert an inline review loop into an existing graph. */
export function insertLoopBlock(def: TeamDefinition, options: LoopBlockOptions = {}): TeamDefinition {
  if (options.mode === 'nested') {
    throw new Error('Use insertLoopAsNestedTeam for nested mode');
  }
  const base = structuredClone(def);
  base.nodes = base.nodes ? [...base.nodes] : [];
  base.edges = base.edges ? [...base.edges] : [];
  const executorId = (options.executorId || 'executor').trim() || 'executor';
  const reviewerId = (options.reviewerId || 'reviewer').trim() || 'reviewer';
  const maxRounds = Math.max(2, options.maxRounds ?? 8);
  ensureTaskAndReturn(base, options.returnMode === 'payload' ? 'payload' : 'void');
  const returnId = (base.nodes.find((n) => n.kind === 'return')!.id) || 'return-void';

  if (!base.nodes.some((n) => (n.id || n.role) === executorId)) {
    base.nodes.push(agentNode({
      id: executorId,
      role: 'executor',
      systemPrompt: 'Executor. Implement or revise the solution.',
      maxRounds,
      x: 280,
      y: 80,
    }));
  }
  if (!base.nodes.some((n) => (n.id || n.role) === reviewerId)) {
    base.nodes.push(agentNode({
      id: reviewerId,
      role: 'reviewer',
      systemPrompt: 'Reviewer. Reply CONTINUE with issues, or FINALIZE when acceptable.',
      maxRounds,
      x: 280,
      y: 280,
    }));
  }

  const has = (from: string, to: string) => base.edges!.some((e) => e.from === from && e.to === to);
  if (!has('task', executorId)) base.edges.push({ from: 'task', to: executorId, trigger: 'on_complete' });
  if (!has(executorId, reviewerId)) base.edges.push({ from: executorId, to: reviewerId, trigger: 'on_complete' });
  if (!has(reviewerId, executorId)) {
    base.edges.push({
      from: reviewerId,
      to: executorId,
      trigger: 'on_complete',
      loop: true,
      condition: 'CONTINUE',
      direction: 'directed',
    });
  }
  if (!has(reviewerId, returnId)) {
    base.edges.push({
      from: reviewerId,
      to: returnId,
      trigger: 'on_complete',
      condition: 'FINALIZE',
    });
  }
  base.maxRounds = Math.max(base.maxRounds ?? 0, maxRounds);
  return finalizeGraph(base);
}

/**
 * Insert a parallel fan-out as a nested child team; parent keeps one Task and
 * gains a single `type: team` node (no second Task).
 */
export function insertParallelAsNestedTeam(
  def: TeamDefinition,
  options: ParallelBlockOptions & { nestedName: string },
): NestedBlockResult {
  const nestedName = options.nestedName.trim();
  if (!nestedName) throw new Error('nestedName is required');
  if (nestedName === def.name) throw new Error('nested team must not self-reference the parent');
  const nested = scaffoldParallelPanelGraph(nestedName, options, def.description);
  const nodeId = (options.synthesizerId || 'parallel-panel').trim() || 'parallel-panel';
  const definition = insertTeamRefNode(def, {
    id: nodeId,
    role: 'parallel-panel',
    teamRef: nestedName,
  });
  return { definition, nested };
}

/**
 * Insert a review-loop as a nested child team into an existing parent graph
 * (keeps the single Task; adds one team-ref node).
 */
export function insertLoopAsNestedTeam(
  def: TeamDefinition,
  options: LoopBlockOptions = {},
): NestedBlockResult {
  const nestedName = (options.nestedName || `${def.name}-review-loop`).trim();
  if (!nestedName) throw new Error('nestedName is required');
  if (nestedName === def.name) throw new Error('nested team must not self-reference the parent');
  const nested = scaffoldReviewLoopGraph(nestedName, { ...options, mode: 'inline' }, def.description);
  const definition = insertTeamRefNode(def, {
    id: 'review-loop',
    role: 'review-loop',
    teamRef: nestedName,
  });
  return { definition, nested };
}

/** Wire a `type: team` agent into an existing graph without adding a second Task. */
export function insertTeamRefNode(
  def: TeamDefinition,
  opts: { id: string; teamRef: string; role?: string },
): TeamDefinition {
  const base = structuredClone(def);
  base.nodes = base.nodes ? [...base.nodes] : [];
  base.edges = base.edges ? [...base.edges] : [];
  ensureTaskAndReturn(base, 'void');
  const id = opts.id.trim();
  if (!id) throw new Error('team node id is required');
  if (base.nodes.some((n) => (n.id || n.role) === id)) {
    throw new Error(`Node id "${id}" already exists`);
  }
  const agentCount = base.nodes.filter((n) => !n.kind || n.kind === 'agent').length;
  base.nodes.push({
    kind: 'agent',
    id,
    role: opts.role ?? id,
    type: 'team',
    teamRef: opts.teamRef,
    model: '',
    systemPrompt: '',
    ui: { x: 280, y: 40 + agentCount * 140 },
  });
  const returnId = (base.nodes.find((n) => n.kind === 'return')!.id) || 'return-void';
  if (!base.edges.some((e) => e.from === 'task' && e.to === id)) {
    base.edges.push({ from: 'task', to: id, trigger: 'on_complete' });
  }
  if (!base.edges.some((e) => e.from === id && e.to === returnId)) {
    base.edges.push({ from: id, to: returnId, trigger: 'on_complete' });
  }
  return finalizeGraph(base);
}

function ensureTaskAndReturn(def: TeamDefinition, returnMode: TeamGraphReturnMode): void {
  def.nodes = def.nodes || [];
  def.edges = def.edges || [];
  if (!def.nodes.some((n) => n.kind === 'task')) {
    def.nodes.unshift({ kind: 'task', id: 'task', ui: { x: 40, y: 160 } });
  } else {
    const task = def.nodes.find((n) => n.kind === 'task')!;
    if (!task.id) task.id = 'task';
  }
  if (!def.nodes.some((n) => n.kind === 'return')) {
    const id = returnMode === 'payload' ? 'return' : 'return-void';
    def.nodes.push({
      kind: 'return',
      id,
      returnMode,
      ...(returnMode === 'payload' ? { payloadTemplate: '{{from.output}}' } : {}),
      ui: { x: 720, y: 160 },
    });
  }
}

function finalizeGraph(def: TeamDefinition): TeamDefinition {
  const configured = ensureConfiguredTeamGraph(migrateTeamDefinitionToGraph(def));
  const problems = validateTeamGraph(configured);
  if (problems.length) {
    throw new Error(`Invalid graph scaffold: ${problems.join('; ')}`);
  }
  return configured;
}
