export type AgentExecutionKind = 'root' | 'subagent';

/** Mirrors the lifecycle states exposed by Codex multi-agent control. */
export type AgentExecutionStatus =
  | 'pending_init'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'not_found';

/** Thread residency is independent from the agent's last turn result. */
export type AgentThreadStatus = 'not_loaded' | 'idle' | 'active' | 'system_error';

export type AgentExecutionPlanStepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked';

export interface AgentExecutionPlanStep {
  id: string;
  title: string;
  status: AgentExecutionPlanStepStatus;
  description?: string;
}

export type AgentExecutionActivityKind =
  | 'thinking'
  | 'tool'
  | 'message'
  | 'delegating'
  | 'waiting'
  | 'idle';

export interface AgentExecutionActivity {
  kind: AgentExecutionActivityKind;
  summary: string;
  toolName?: string;
  startedAt: string;
  updatedAt?: string;
}

export interface AgentExecutionTimestamps {
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  turnStartedAt: string | null;
  turnCompletedAt: string | null;
  completedAt: string | null;
  interruptedAt: string | null;
  lastActivityAt: string | null;
}

/** One stable node per agent session/thread, including resumed turns. */
export interface AgentExecutionNode {
  id: string;
  sessionId: string;
  rootExecutionId: string;
  parentExecutionId: string | null;
  parentSessionId: string | null;
  canonicalPath: string;
  spawnOrder: number;
  agentName: string;
  nickname: string | null;
  role: string | null;
  kind: AgentExecutionKind;
  runtime: string;
  model: string | null;
  cwd: string;
  agentStatus: AgentExecutionStatus;
  threadStatus: AgentThreadStatus;
  currentPlan: AgentExecutionPlanStep[];
  currentActivity: AgentExecutionActivity | null;
  runIds: string[];
  timestamps: AgentExecutionTimestamps;
  error: string | null;
  result: string | null;
}

export type AgentExecutionEdgeKind = 'delegate' | 'message' | 'resume' | 'handoff';
export type AgentExecutionEdgeStatus = 'started' | 'completed' | 'failed';

export interface AgentExecutionEdge {
  /** Stable identity for a collaboration tool call. */
  callId: string;
  kind: AgentExecutionEdgeKind;
  status: AgentExecutionEdgeStatus;
  sourceExecutionId: string;
  targetExecutionId: string;
  sourceSessionId: string | null;
  targetSessionId: string | null;
  summary: string | null;
  startedAt: string;
  completedAt: string | null;
  failedAt: string | null;
  result: string | null;
  error: string | null;
}

interface AgentExecutionEventBase {
  eventId: string;
  rootExecutionId: string;
  occurredAt: string;
}

export interface AgentThreadStartedEvent extends AgentExecutionEventBase {
  type: 'thread.started';
  executionId: string;
  sessionId: string;
  parentExecutionId?: string | null;
  parentSessionId?: string | null;
  canonicalPath?: string;
  spawnOrder?: number;
  agentName: string;
  nickname?: string | null;
  role?: string | null;
  kind?: AgentExecutionKind;
  runtime?: string;
  model?: string | null;
  cwd?: string;
  agentStatus?: AgentExecutionStatus;
  threadStatus?: AgentThreadStatus;
  currentPlan?: AgentExecutionPlanStep[];
  currentActivity?: AgentExecutionActivity | null;
}

export interface AgentThreadStatusEvent extends AgentExecutionEventBase {
  type: 'thread.status';
  executionId: string;
  sessionId?: string;
  agentStatus?: AgentExecutionStatus;
  threadStatus?: AgentThreadStatus;
  error?: string | null;
  result?: string | null;
}

export interface AgentTurnStartedEvent extends AgentExecutionEventBase {
  type: 'turn.started';
  executionId: string;
  sessionId?: string;
  runId: string;
}

export interface AgentTurnCompletedEvent extends AgentExecutionEventBase {
  type: 'turn.completed';
  executionId: string;
  sessionId?: string;
  runId: string;
  outcome?: 'completed' | 'interrupted' | 'errored';
  result?: string | null;
  error?: string | null;
}

export interface AgentPlanUpdatedEvent extends AgentExecutionEventBase {
  type: 'plan.updated';
  executionId: string;
  sessionId?: string;
  plan: AgentExecutionPlanStep[];
}

export interface AgentActivityEvent extends AgentExecutionEventBase {
  type: 'activity';
  executionId: string;
  sessionId?: string;
  activity: AgentExecutionActivity | null;
}

interface AgentEdgeEventBase extends AgentExecutionEventBase {
  callId: string;
  kind?: AgentExecutionEdgeKind;
  sourceExecutionId?: string;
  targetExecutionId?: string;
  sourceSessionId?: string | null;
  targetSessionId?: string | null;
  summary?: string | null;
}

export interface AgentEdgeStartedEvent extends AgentEdgeEventBase {
  type: 'edge.started';
  kind: AgentExecutionEdgeKind;
  sourceExecutionId: string;
  targetExecutionId: string;
}

export interface AgentEdgeCompletedEvent extends AgentEdgeEventBase {
  type: 'edge.completed';
  result?: string | null;
}

export interface AgentEdgeFailedEvent extends AgentEdgeEventBase {
  type: 'edge.failed';
  error: string;
}

export type AgentExecutionEvent =
  | AgentThreadStartedEvent
  | AgentThreadStatusEvent
  | AgentTurnStartedEvent
  | AgentTurnCompletedEvent
  | AgentPlanUpdatedEvent
  | AgentActivityEvent
  | AgentEdgeStartedEvent
  | AgentEdgeCompletedEvent
  | AgentEdgeFailedEvent;

export type AgentExecutionEventDraft = AgentExecutionEvent extends infer Event
  ? Event extends AgentExecutionEvent
    ? Omit<Event, 'eventId' | 'occurredAt'> &
        Partial<Pick<AgentExecutionEventBase, 'eventId' | 'occurredAt'>>
    : never
  : never;

export interface AgentExecutionSnapshot {
  version: 1;
  rootExecutionId: string;
  nodes: AgentExecutionNode[];
  edges: AgentExecutionEdge[];
  events: AgentExecutionEvent[];
  /** Bounded replay guard kept separately from the shorter UI event history. */
  seenEventIds: string[];
  createdAt: string;
  updatedAt: string;
}

export const MAX_AGENT_EXECUTION_EVENT_HISTORY = 1_000;
export const MAX_AGENT_EXECUTION_SEEN_EVENT_IDS = 10_000;

export interface AgentExecutionTreeNode {
  node: AgentExecutionNode;
  children: AgentExecutionTreeNode[];
  incomingEdges: AgentExecutionEdge[];
  outgoingEdges: AgentExecutionEdge[];
}

export interface AgentExecutionTreeSnapshot {
  rootExecutionId: string;
  root: AgentExecutionTreeNode | null;
  detached: AgentExecutionTreeNode[];
  nodeCount: number;
  edgeCount: number;
  updatedAt: string;
}

function laterTimestamp(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}

function nodeIndex(
  nodes: AgentExecutionNode[],
  executionId: string,
  sessionId?: string,
): number {
  const byId = nodes.findIndex((node) => node.id === executionId);
  if (byId >= 0) {
    return byId;
  }
  return sessionId ? nodes.findIndex((node) => node.sessionId === sessionId) : -1;
}

function resolveNodeId(
  nodes: AgentExecutionNode[],
  executionId: string | undefined,
  sessionId: string | null | undefined,
): string | undefined {
  const found = nodes.find(
    (node) => node.id === executionId || (sessionId != null && node.sessionId === sessionId),
  );
  return found?.id ?? executionId;
}

function nextSpawnOrder(
  nodes: AgentExecutionNode[],
  parentExecutionId: string | null,
): number {
  const siblingOrders = nodes
    .filter((node) => node.parentExecutionId === parentExecutionId)
    .map((node) => node.spawnOrder);
  return siblingOrders.length === 0 ? 0 : Math.max(...siblingOrders) + 1;
}

function defaultCanonicalPath(
  nodes: AgentExecutionNode[],
  parentExecutionId: string | null,
  spawnOrder: number,
  agentName: string,
): string {
  if (!parentExecutionId) {
    return '/root';
  }
  const parent = nodes.find((node) => node.id === parentExecutionId);
  const segment = agentName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || `agent-${spawnOrder + 1}`;
  const parentPath = parent?.canonicalPath || '/root';
  const candidate = `${parentPath}/${segment}`;
  return nodes.some((node) => node.canonicalPath === candidate)
    ? `${candidate}-${spawnOrder + 1}`
    : candidate;
}

function touchNode(node: AgentExecutionNode, occurredAt: string): void {
  node.timestamps.updatedAt = laterTimestamp(node.timestamps.updatedAt, occurredAt);
}

function requireNode(
  snapshot: AgentExecutionSnapshot,
  executionId: string,
  sessionId?: string,
): AgentExecutionNode {
  const index = nodeIndex(snapshot.nodes, executionId, sessionId);
  const node = index >= 0 ? snapshot.nodes[index] : undefined;
  if (!node) {
    throw new Error(`Agent execution node was not found: ${executionId}`);
  }
  return node;
}

function terminalTimestamp(status: AgentExecutionStatus, occurredAt: string): Partial<AgentExecutionTimestamps> {
  if (status === 'interrupted') {
    return { interruptedAt: occurredAt, completedAt: occurredAt };
  }
  if (status === 'completed' || status === 'errored' || status === 'shutdown') {
    return { completedAt: occurredAt };
  }
  return {};
}

function applyThreadStarted(snapshot: AgentExecutionSnapshot, event: AgentThreadStartedEvent): void {
  const existingIndex = nodeIndex(snapshot.nodes, event.executionId, event.sessionId);
  if (existingIndex >= 0) {
    const existing = snapshot.nodes[existingIndex];
    if (!existing) {
      return;
    }
    existing.agentName = event.agentName || existing.agentName;
    existing.nickname = event.nickname === undefined ? existing.nickname : event.nickname;
    existing.role = event.role === undefined ? existing.role : event.role;
    existing.runtime = event.runtime ?? existing.runtime;
    existing.model = event.model === undefined ? existing.model : event.model;
    existing.cwd = event.cwd ?? existing.cwd;
    if (existing.agentStatus === 'pending_init' && event.agentStatus) {
      existing.agentStatus = event.agentStatus;
    }
    if (existing.threadStatus === 'not_loaded' && event.threadStatus) {
      existing.threadStatus = event.threadStatus;
    }
    existing.currentPlan = event.currentPlan
      ? structuredClone(event.currentPlan)
      : existing.currentPlan;
    existing.currentActivity =
      event.currentActivity === undefined
        ? existing.currentActivity
        : structuredClone(event.currentActivity);
    touchNode(existing, event.occurredAt);
    return;
  }

  const parentExecutionId =
    resolveNodeId(
      snapshot.nodes,
      event.parentExecutionId ?? undefined,
      event.parentSessionId,
    ) ?? null;
  const spawnOrder = event.spawnOrder ?? nextSpawnOrder(snapshot.nodes, parentExecutionId);
  const node: AgentExecutionNode = {
    id: event.executionId,
    sessionId: event.sessionId,
    rootExecutionId: event.rootExecutionId,
    parentExecutionId,
    parentSessionId: event.parentSessionId ?? null,
    canonicalPath:
      event.canonicalPath ??
      defaultCanonicalPath(snapshot.nodes, parentExecutionId, spawnOrder, event.nickname ?? event.agentName),
    spawnOrder,
    agentName: event.agentName,
    nickname: event.nickname ?? null,
    role: event.role ?? null,
    kind: event.kind ?? (parentExecutionId ? 'subagent' : 'root'),
    runtime: event.runtime ?? 'hadamard',
    model: event.model ?? null,
    cwd: event.cwd ?? '',
    agentStatus: event.agentStatus ?? 'pending_init',
    threadStatus: event.threadStatus ?? 'active',
    currentPlan: structuredClone(event.currentPlan ?? []),
    currentActivity: structuredClone(event.currentActivity ?? null),
    runIds: [],
    timestamps: {
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      startedAt: event.occurredAt,
      turnStartedAt: null,
      turnCompletedAt: null,
      completedAt: null,
      interruptedAt: null,
      lastActivityAt: event.currentActivity ? event.occurredAt : null,
    },
    error: null,
    result: null,
  };
  snapshot.nodes.push(node);

  // A collaboration edge can arrive before the target thread starts. Once
  // the session is known, point those edges at the stable node identity.
  for (const edge of snapshot.edges) {
    if (edge.sourceSessionId === node.sessionId) {
      edge.sourceExecutionId = node.id;
    }
    if (edge.targetSessionId === node.sessionId) {
      edge.targetExecutionId = node.id;
    }
  }
}

function applyThreadStatus(snapshot: AgentExecutionSnapshot, event: AgentThreadStatusEvent): void {
  const node = requireNode(snapshot, event.executionId, event.sessionId);
  if (event.agentStatus) {
    node.agentStatus = event.agentStatus;
    Object.assign(node.timestamps, terminalTimestamp(event.agentStatus, event.occurredAt));
  }
  if (event.threadStatus) {
    node.threadStatus = event.threadStatus;
  }
  if (event.error !== undefined) {
    node.error = event.error;
  }
  if (event.result !== undefined) {
    node.result = event.result;
  }
  touchNode(node, event.occurredAt);
}

function applyTurnStarted(snapshot: AgentExecutionSnapshot, event: AgentTurnStartedEvent): void {
  const node = requireNode(snapshot, event.executionId, event.sessionId);
  if (!node.runIds.includes(event.runId)) {
    node.runIds.push(event.runId);
  }
  node.agentStatus = 'running';
  node.threadStatus = 'active';
  node.error = null;
  node.result = null;
  node.currentPlan = [];
  node.currentActivity = null;
  node.timestamps.turnStartedAt = event.occurredAt;
  node.timestamps.turnCompletedAt = null;
  node.timestamps.completedAt = null;
  node.timestamps.interruptedAt = null;
  touchNode(node, event.occurredAt);
}

function applyTurnCompleted(snapshot: AgentExecutionSnapshot, event: AgentTurnCompletedEvent): void {
  const node = requireNode(snapshot, event.executionId, event.sessionId);
  if (!node.runIds.includes(event.runId)) {
    node.runIds.push(event.runId);
  }
  const outcome = event.outcome ?? (event.error ? 'errored' : 'completed');
  node.agentStatus = outcome;
  node.threadStatus = outcome === 'errored' ? 'system_error' : 'idle';
  node.error = event.error ?? null;
  node.result = event.result ?? null;
  node.timestamps.turnCompletedAt = event.occurredAt;
  Object.assign(node.timestamps, terminalTimestamp(outcome, event.occurredAt));
  touchNode(node, event.occurredAt);
}

function applyPlanUpdated(snapshot: AgentExecutionSnapshot, event: AgentPlanUpdatedEvent): void {
  const node = requireNode(snapshot, event.executionId, event.sessionId);
  node.currentPlan = structuredClone(event.plan);
  touchNode(node, event.occurredAt);
}

function applyActivity(snapshot: AgentExecutionSnapshot, event: AgentActivityEvent): void {
  const node = requireNode(snapshot, event.executionId, event.sessionId);
  node.currentActivity = structuredClone(event.activity);
  node.timestamps.lastActivityAt = event.occurredAt;
  touchNode(node, event.occurredAt);
}

function edgeIdentityFromEvent(
  snapshot: AgentExecutionSnapshot,
  event: AgentEdgeEventBase,
): Pick<
  AgentExecutionEdge,
  | 'kind'
  | 'sourceExecutionId'
  | 'targetExecutionId'
  | 'sourceSessionId'
  | 'targetSessionId'
  | 'summary'
> {
  const existing = snapshot.edges.find((edge) => edge.callId === event.callId);
  const kind = event.kind ?? existing?.kind;
  const sourceExecutionId = resolveNodeId(
    snapshot.nodes,
    event.sourceExecutionId ?? existing?.sourceExecutionId,
    event.sourceSessionId ?? existing?.sourceSessionId,
  );
  const targetExecutionId = resolveNodeId(
    snapshot.nodes,
    event.targetExecutionId ?? existing?.targetExecutionId,
    event.targetSessionId ?? existing?.targetSessionId,
  );
  if (!kind || !sourceExecutionId || !targetExecutionId) {
    throw new Error(`Agent execution edge ${event.callId} is missing its identity fields.`);
  }
  return {
    kind,
    sourceExecutionId,
    targetExecutionId,
    sourceSessionId: event.sourceSessionId ?? existing?.sourceSessionId ?? null,
    targetSessionId: event.targetSessionId ?? existing?.targetSessionId ?? null,
    summary: event.summary === undefined ? existing?.summary ?? null : event.summary,
  };
}

function applyEdge(snapshot: AgentExecutionSnapshot, event: AgentEdgeStartedEvent | AgentEdgeCompletedEvent | AgentEdgeFailedEvent): void {
  const index = snapshot.edges.findIndex((edge) => edge.callId === event.callId);
  const existing = index >= 0 ? snapshot.edges[index] : undefined;
  if (existing?.status === 'completed' || existing?.status === 'failed') {
    return;
  }
  const identity = edgeIdentityFromEvent(snapshot, event);
  const next: AgentExecutionEdge = {
    callId: event.callId,
    ...identity,
    status:
      event.type === 'edge.started'
        ? 'started'
        : event.type === 'edge.completed'
          ? 'completed'
          : 'failed',
    startedAt: existing?.startedAt ?? event.occurredAt,
    completedAt:
      event.type === 'edge.completed' ? event.occurredAt : existing?.completedAt ?? null,
    failedAt: event.type === 'edge.failed' ? event.occurredAt : existing?.failedAt ?? null,
    result:
      event.type === 'edge.completed'
        ? event.result ?? null
        : existing?.result ?? null,
    error: event.type === 'edge.failed' ? event.error : existing?.error ?? null,
  };
  if (index >= 0) {
    snapshot.edges[index] = next;
  } else {
    snapshot.edges.push(next);
  }
}

/**
 * Apply one immutable, idempotent lifecycle event to a root execution graph.
 * Replaying an eventId returns the original snapshot reference and makes no
 * timestamp changes.
 */
export function reduceAgentExecutionEvent(
  current: AgentExecutionSnapshot | undefined,
  event: AgentExecutionEvent,
): AgentExecutionSnapshot {
  if (
    current?.seenEventIds?.includes(event.eventId) ||
    current?.events.some((entry) => entry.eventId === event.eventId)
  ) {
    return current;
  }
  if (current && current.rootExecutionId !== event.rootExecutionId) {
    throw new Error(
      `Event root ${event.rootExecutionId} does not match execution ${current.rootExecutionId}.`,
    );
  }
  if (!current && event.type !== 'thread.started') {
    throw new Error(`The first agent execution event must be thread.started, not ${event.type}.`);
  }

  const snapshot: AgentExecutionSnapshot = current
    ? structuredClone(current)
    : {
        version: 1,
        rootExecutionId: event.rootExecutionId,
        nodes: [],
        edges: [],
        events: [],
        seenEventIds: [],
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      };

  switch (event.type) {
    case 'thread.started':
      applyThreadStarted(snapshot, event);
      break;
    case 'thread.status':
      applyThreadStatus(snapshot, event);
      break;
    case 'turn.started':
      applyTurnStarted(snapshot, event);
      break;
    case 'turn.completed':
      applyTurnCompleted(snapshot, event);
      break;
    case 'plan.updated':
      applyPlanUpdated(snapshot, event);
      break;
    case 'activity':
      applyActivity(snapshot, event);
      break;
    case 'edge.started':
    case 'edge.completed':
    case 'edge.failed':
      applyEdge(snapshot, event);
      break;
  }

  snapshot.events.push(structuredClone(event));
  if (snapshot.events.length > MAX_AGENT_EXECUTION_EVENT_HISTORY) {
    snapshot.events.splice(0, snapshot.events.length - MAX_AGENT_EXECUTION_EVENT_HISTORY);
  }
  snapshot.seenEventIds ??= [];
  snapshot.seenEventIds.push(event.eventId);
  if (snapshot.seenEventIds.length > MAX_AGENT_EXECUTION_SEEN_EVENT_IDS) {
    snapshot.seenEventIds.splice(
      0,
      snapshot.seenEventIds.length - MAX_AGENT_EXECUTION_SEEN_EVENT_IDS,
    );
  }
  snapshot.updatedAt = laterTimestamp(snapshot.updatedAt, event.occurredAt);
  return snapshot;
}

function nodeSort(left: AgentExecutionNode, right: AgentExecutionNode): number {
  return (
    left.spawnOrder - right.spawnOrder ||
    left.timestamps.createdAt.localeCompare(right.timestamps.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

/** Builds a UI-ready parent/child tree without mutating the persisted graph. */
export function createAgentExecutionTree(
  snapshot: AgentExecutionSnapshot,
): AgentExecutionTreeSnapshot {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const children = new Map<string, AgentExecutionNode[]>();
  for (const node of snapshot.nodes) {
    if (!node.parentExecutionId || !byId.has(node.parentExecutionId)) {
      continue;
    }
    const siblings = children.get(node.parentExecutionId) ?? [];
    siblings.push(node);
    children.set(node.parentExecutionId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort(nodeSort);
  }

  const included = new Set<string>();
  const build = (node: AgentExecutionNode, ancestors: Set<string>): AgentExecutionTreeNode => {
    included.add(node.id);
    const nextAncestors = new Set(ancestors).add(node.id);
    return {
      node,
      children: (children.get(node.id) ?? [])
        .filter((child) => !nextAncestors.has(child.id))
        .map((child) => build(child, nextAncestors)),
      incomingEdges: snapshot.edges.filter((edge) => edge.targetExecutionId === node.id),
      outgoingEdges: snapshot.edges.filter((edge) => edge.sourceExecutionId === node.id),
    };
  };

  const rootNode = byId.get(snapshot.rootExecutionId) ??
    [...snapshot.nodes].sort(nodeSort).find((node) => node.parentExecutionId === null) ??
    null;
  const root = rootNode ? build(rootNode, new Set()) : null;
  const detached = [...snapshot.nodes]
    .filter((node) => !included.has(node.id))
    .sort(nodeSort)
    .map((node) => build(node, new Set()));

  return {
    rootExecutionId: snapshot.rootExecutionId,
    root,
    detached,
    nodeCount: snapshot.nodes.length,
    edgeCount: snapshot.edges.length,
    updatedAt: snapshot.updatedAt,
  };
}
