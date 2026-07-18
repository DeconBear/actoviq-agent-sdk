import {
  createAgentExecutionTree,
  type AgentExecutionActivity,
  type AgentExecutionEdge,
  type AgentExecutionNode,
  type AgentExecutionPlanStep,
  type AgentExecutionSnapshot,
  type AgentExecutionStatus,
  type AgentExecutionTreeNode,
  type AgentThreadStatus,
} from '../runtime/agentExecution.js';

export type AgentExecutionViewNow = string | number | Date;

export interface AgentExecutionTimingView {
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number;
  durationMs: number | null;
}

export interface AgentExecutionNodeView {
  id: string;
  sessionId: string;
  rootExecutionId: string;
  parentExecutionId: string | null;
  parentSessionId: string | null;
  canonicalPath: string;
  spawnOrder: number;
  depth: number;
  displayName: string;
  agentName: string;
  nickname: string | null;
  role: string | null;
  kind: AgentExecutionNode['kind'];
  runtime: string;
  model: string | null;
  cwd: string;
  status: AgentExecutionStatus;
  threadStatus: AgentThreadStatus;
  isActive: boolean;
  currentActivity: AgentExecutionActivity | null;
  plan: AgentExecutionPlanStep[];
  currentStep: AgentExecutionPlanStep | null;
  nextSteps: AgentExecutionPlanStep[];
  timing: AgentExecutionTimingView;
  error: string | null;
  result: string | null;
  runCount: number;
  children: AgentExecutionNodeView[];
}

export interface AgentExecutionEdgeView {
  callId: string;
  kind: AgentExecutionEdge['kind'];
  status: AgentExecutionEdge['status'];
  sourceExecutionId: string;
  targetExecutionId: string;
  sourceSessionId: string | null;
  targetSessionId: string | null;
  summary: string | null;
  startedAt: string;
  completedAt: string | null;
  failedAt: string | null;
  error: string | null;
  result: string | null;
}

export interface AgentExecutionRootView {
  rootExecutionId: string;
  rootSessionId: string | null;
  displayName: string;
  status: AgentExecutionStatus;
  isActive: boolean;
  nodeCount: number;
  subagentCount: number;
  activeNodeCount: number;
  completedNodeCount: number;
  erroredNodeCount: number;
  interruptedNodeCount: number;
  edgeCount: number;
  edges: AgentExecutionEdgeView[];
  updatedAt: string;
  timing: AgentExecutionTimingView;
  currentActivity: AgentExecutionActivity | null;
  focusedExecutionId: string | null;
  currentStep: AgentExecutionPlanStep | null;
  nextSteps: AgentExecutionPlanStep[];
  root: AgentExecutionNodeView | null;
  detached: AgentExecutionNodeView[];
}

export interface AgentExecutionProjectView {
  active: AgentExecutionRootView[];
  completed: AgentExecutionRootView[];
  totalExecutionCount: number;
  totalAgentCount: number;
  activeExecutionCount: number;
  completedExecutionCount: number;
  erroredExecutionCount: number;
  updatedAt: string | null;
}

export interface FormatAgentExecutionTreeOptions {
  prefix?: string;
  includeActivity?: boolean;
  includePlan?: boolean;
  includeTiming?: boolean;
  includeResult?: boolean;
  maxNextSteps?: number;
  maxMetaWidth?: number;
}

const ACTIVE_STATUSES = new Set<AgentExecutionStatus>(['pending_init', 'running']);

function isActiveStatus(status: AgentExecutionStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveNow(now: AgentExecutionViewNow | undefined): number {
  if (now === undefined) {
    return Date.now();
  }
  const parsed = now instanceof Date
    ? now.getTime()
    : typeof now === 'number'
      ? now
      : Date.parse(now);
  if (!Number.isFinite(parsed)) {
    throw new RangeError('Invalid Agent execution view timestamp');
  }
  return parsed;
}

function clonePlanStep(step: AgentExecutionPlanStep): AgentExecutionPlanStep {
  return { ...step };
}

function cloneActivity(activity: AgentExecutionActivity | null): AgentExecutionActivity | null {
  return activity ? { ...activity } : null;
}

function displayName(node: AgentExecutionNode): string {
  return [node.nickname, node.role, node.agentName, node.canonicalPath, node.id]
    .find((value) => value?.trim())!
    .trim();
}

function nodeStartedAt(node: AgentExecutionNode): string {
  return node.timestamps.turnStartedAt ??
    node.timestamps.startedAt ??
    node.timestamps.createdAt;
}

function nodeCompletedAt(node: AgentExecutionNode): string | null {
  if (isActiveStatus(node.agentStatus)) {
    return null;
  }
  return node.timestamps.turnCompletedAt ??
    node.timestamps.completedAt ??
    node.timestamps.interruptedAt ??
    node.timestamps.updatedAt;
}

function elapsedMs(startedAt: string, completedAt: string | null, nowMs: number): number {
  const startMs = timestampMs(startedAt);
  const endMs = completedAt ? timestampMs(completedAt) : nowMs;
  if (startMs === null || endMs === null) {
    return 0;
  }
  return Math.max(0, endMs - startMs);
}

function createNodeTiming(
  node: AgentExecutionNode,
  nowMs: number,
): AgentExecutionTimingView {
  const startedAt = nodeStartedAt(node);
  const completedAt = nodeCompletedAt(node);
  const elapsed = elapsedMs(startedAt, completedAt, nowMs);
  return {
    createdAt: node.timestamps.createdAt,
    updatedAt: node.timestamps.updatedAt,
    startedAt,
    completedAt,
    elapsedMs: elapsed,
    durationMs: completedAt ? elapsed : null,
  };
}

function selectPlanSteps(plan: AgentExecutionPlanStep[]): {
  currentStep: AgentExecutionPlanStep | null;
  nextSteps: AgentExecutionPlanStep[];
} {
  const currentIndex = plan.findIndex((step) => step.status === 'in_progress');
  const currentStep = currentIndex >= 0 ? clonePlanStep(plan[currentIndex]!) : null;
  const candidates = currentIndex >= 0 ? plan.slice(currentIndex + 1) : plan;
  return {
    currentStep,
    nextSteps: candidates
      .filter((step) => step.status === 'pending' || step.status === 'blocked')
      .map(clonePlanStep),
  };
}

function createNodeView(
  treeNode: AgentExecutionTreeNode,
  nowMs: number,
  depth: number,
): AgentExecutionNodeView {
  const node = treeNode.node;
  const plan = node.currentPlan.map(clonePlanStep);
  const { currentStep, nextSteps } = selectPlanSteps(plan);
  return {
    id: node.id,
    sessionId: node.sessionId,
    rootExecutionId: node.rootExecutionId,
    parentExecutionId: node.parentExecutionId,
    parentSessionId: node.parentSessionId,
    canonicalPath: node.canonicalPath,
    spawnOrder: node.spawnOrder,
    depth,
    displayName: displayName(node),
    agentName: node.agentName,
    nickname: node.nickname,
    role: node.role,
    kind: node.kind,
    runtime: node.runtime,
    model: node.model,
    cwd: node.cwd,
    status: node.agentStatus,
    threadStatus: node.threadStatus,
    isActive: isActiveStatus(node.agentStatus),
    currentActivity: cloneActivity(node.currentActivity),
    plan,
    currentStep,
    nextSteps,
    timing: createNodeTiming(node, nowMs),
    error: node.error,
    result: node.result,
    runCount: node.runIds.length,
    children: treeNode.children.map((child) => createNodeView(child, nowMs, depth + 1)),
  };
}

function aggregateStatus(nodes: AgentExecutionNode[]): AgentExecutionStatus {
  if (!nodes.length) {
    return 'not_found';
  }
  if (nodes.some((node) =>
    node.agentStatus === 'errored' ||
    node.threadStatus === 'system_error' ||
    Boolean(node.error)
  )) {
    return 'errored';
  }
  const precedence: AgentExecutionStatus[] = [
    'running',
    'pending_init',
    'interrupted',
    'shutdown',
    'not_found',
    'completed',
  ];
  return precedence.find((status) => nodes.some((node) => node.agentStatus === status)) ??
    'completed';
}

function earliestTimestamp(values: string[], fallback: string): string {
  const [first, ...rest] = values;
  if (!first) {
    return fallback;
  }
  return rest.reduce((earliest, value) => {
    const earliestMs = timestampMs(earliest);
    const valueMs = timestampMs(value);
    if (earliestMs === null) {
      return value;
    }
    return valueMs !== null && valueMs < earliestMs ? value : earliest;
  }, first);
}

function latestTimestamp(values: string[], fallback: string): string {
  const [first, ...rest] = values;
  if (!first) {
    return fallback;
  }
  return rest.reduce((latest, value) => {
    const latestMs = timestampMs(latest);
    const valueMs = timestampMs(value);
    if (latestMs === null) {
      return value;
    }
    return valueMs !== null && valueMs > latestMs ? value : latest;
  }, first);
}

function createRootTiming(
  snapshot: AgentExecutionSnapshot,
  isActive: boolean,
  nowMs: number,
): AgentExecutionTimingView {
  const createdAt = earliestTimestamp(
    [snapshot.createdAt, ...snapshot.nodes.map((node) => node.timestamps.createdAt)],
    snapshot.createdAt,
  );
  const startedAt = earliestTimestamp(
    snapshot.nodes.map(nodeStartedAt),
    createdAt,
  );
  const updatedAt = latestTimestamp(
    [snapshot.updatedAt, ...snapshot.nodes.map((node) => node.timestamps.updatedAt)],
    snapshot.updatedAt,
  );
  const completedAt = isActive
    ? null
    : latestTimestamp(
        [
          updatedAt,
          ...snapshot.nodes
            .map(nodeCompletedAt)
            .filter((value): value is string => value !== null),
        ],
        updatedAt,
      );
  const elapsed = elapsedMs(startedAt, completedAt, nowMs);
  return {
    createdAt,
    updatedAt,
    startedAt,
    completedAt,
    elapsedMs: elapsed,
    durationMs: completedAt ? elapsed : null,
  };
}

function selectCurrentActivity(nodes: AgentExecutionNode[]): AgentExecutionActivity | null {
  const withActivity = nodes.filter(
    (node): node is AgentExecutionNode & { currentActivity: AgentExecutionActivity } =>
      node.currentActivity !== null,
  );
  const active = withActivity.filter((node) => isActiveStatus(node.agentStatus));
  const candidates = active.length ? active : withActivity;
  const selected = [...candidates].sort((left, right) => {
    const leftAt = left.currentActivity.updatedAt ?? left.currentActivity.startedAt;
    const rightAt = right.currentActivity.updatedAt ?? right.currentActivity.startedAt;
    return rightAt.localeCompare(leftAt) || left.id.localeCompare(right.id);
  })[0];
  return cloneActivity(selected?.currentActivity ?? null);
}

function focusTimestamp(node: AgentExecutionNode): string {
  return node.currentActivity?.updatedAt ??
    node.currentActivity?.startedAt ??
    node.timestamps.lastActivityAt ??
    node.timestamps.updatedAt;
}

function selectFocusedNode(
  nodes: AgentExecutionNode[],
  rootNode: AgentExecutionNode | null,
): AgentExecutionNode | null {
  const active = nodes
    .filter((node) => isActiveStatus(node.agentStatus))
    .sort((left, right) =>
      focusTimestamp(right).localeCompare(focusTimestamp(left)) ||
      right.spawnOrder - left.spawnOrder ||
      left.id.localeCompare(right.id)
    );
  return active[0] ?? rootNode;
}

function selectRootPlan(
  focusedNode: AgentExecutionNode | null,
  rootNode: AgentExecutionNode | null,
): {
  currentStep: AgentExecutionPlanStep | null;
  nextSteps: AgentExecutionPlanStep[];
} {
  if (focusedNode) {
    const focusedPlan = selectPlanSteps(focusedNode.currentPlan);
    if (focusedPlan.currentStep || focusedPlan.nextSteps.length) {
      return focusedPlan;
    }
  }
  return rootNode
    ? selectPlanSteps(rootNode.currentPlan)
    : { currentStep: null, nextSteps: [] };
}

function topLevelDetachedNodes(
  treeNodes: AgentExecutionTreeNode[],
): AgentExecutionTreeNode[] {
  const detachedIds = new Set(treeNodes.map((entry) => entry.node.id));
  const roots = treeNodes.filter(
    (entry) =>
      !entry.node.parentExecutionId ||
      !detachedIds.has(entry.node.parentExecutionId),
  );
  return roots.length ? roots : treeNodes;
}

function createEdgeViews(edges: AgentExecutionEdge[]): AgentExecutionEdgeView[] {
  return edges
    .map((edge) => ({
      callId: edge.callId,
      kind: edge.kind,
      status: edge.status,
      sourceExecutionId: edge.sourceExecutionId,
      targetExecutionId: edge.targetExecutionId,
      sourceSessionId: edge.sourceSessionId,
      targetSessionId: edge.targetSessionId,
      summary: edge.summary,
      startedAt: edge.startedAt,
      completedAt: edge.completedAt,
      failedAt: edge.failedAt,
      error: edge.error,
      result: edge.result,
    }))
    .sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt) ||
      left.callId.localeCompare(right.callId) ||
      left.kind.localeCompare(right.kind)
    );
}

export function createAgentExecutionRootView(
  snapshot: AgentExecutionSnapshot,
  now?: AgentExecutionViewNow,
): AgentExecutionRootView {
  const nowMs = resolveNow(now);
  const tree = createAgentExecutionTree(snapshot);
  const root = tree.root ? createNodeView(tree.root, nowMs, 0) : null;
  const detached = topLevelDetachedNodes(tree.detached)
    .map((entry) => createNodeView(entry, nowMs, 0));
  const rootNode = tree.root?.node ?? null;
  const focusedNode = selectFocusedNode(snapshot.nodes, rootNode);
  const focusedPlan = selectRootPlan(focusedNode, rootNode);
  const isActive = snapshot.nodes.some((node) => isActiveStatus(node.agentStatus));
  const status = aggregateStatus(snapshot.nodes);
  return {
    rootExecutionId: snapshot.rootExecutionId,
    rootSessionId: root?.sessionId ?? null,
    displayName: root?.displayName ?? snapshot.rootExecutionId,
    status,
    isActive,
    nodeCount: snapshot.nodes.length,
    subagentCount: Math.max(0, snapshot.nodes.length - 1),
    activeNodeCount: snapshot.nodes.filter((node) => isActiveStatus(node.agentStatus)).length,
    completedNodeCount: snapshot.nodes.filter((node) => node.agentStatus === 'completed').length,
    erroredNodeCount: snapshot.nodes.filter((node) =>
      node.agentStatus === 'errored' ||
      node.threadStatus === 'system_error' ||
      Boolean(node.error)
    ).length,
    interruptedNodeCount: snapshot.nodes.filter(
      (node) => node.agentStatus === 'interrupted',
    ).length,
    edgeCount: snapshot.edges.length,
    edges: createEdgeViews(snapshot.edges),
    updatedAt: snapshot.updatedAt,
    timing: createRootTiming(snapshot, isActive, nowMs),
    currentActivity: selectCurrentActivity(snapshot.nodes),
    focusedExecutionId: focusedNode?.id ?? null,
    currentStep: focusedPlan.currentStep,
    nextSteps: focusedPlan.nextSteps,
    root,
    detached,
  };
}

function compareRootViews(
  left: AgentExecutionRootView,
  right: AgentExecutionRootView,
): number {
  return right.updatedAt.localeCompare(left.updatedAt) ||
    left.rootExecutionId.localeCompare(right.rootExecutionId);
}

export function createAgentExecutionProjectView(
  snapshots: AgentExecutionSnapshot[],
  now?: AgentExecutionViewNow,
): AgentExecutionProjectView {
  const nowMs = resolveNow(now);
  const executions = snapshots.map((snapshot) =>
    createAgentExecutionRootView(snapshot, nowMs)
  );
  const active = executions.filter((execution) => execution.isActive).sort(compareRootViews);
  const completed = executions.filter((execution) => !execution.isActive).sort(compareRootViews);
  return {
    active,
    completed,
    totalExecutionCount: executions.length,
    totalAgentCount: executions.reduce((total, execution) => total + execution.nodeCount, 0),
    activeExecutionCount: active.length,
    completedExecutionCount: completed.length,
    erroredExecutionCount: executions.filter(
      (execution) => execution.status === 'errored',
    ).length,
    updatedAt: executions.length
      ? latestTimestamp(executions.map((execution) => execution.updatedAt), executions[0]!.updatedAt)
      : null,
  };
}

function statusMarker(status: AgentExecutionStatus): string {
  switch (status) {
    case 'running':
      return '[>]';
    case 'completed':
      return '[x]';
    case 'errored':
      return '[!]';
    case 'interrupted':
      return '[~]';
    case 'shutdown':
      return '[-]';
    case 'not_found':
      return '[?]';
    default:
      return '[ ]';
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 100) / 10}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function truncate(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) {
    return value;
  }
  if (maxWidth <= 3) {
    return value.slice(0, maxWidth);
  }
  return `${value.slice(0, maxWidth - 3)}...`;
}

function formatNodeLine(
  node: AgentExecutionNodeView,
  options: Required<Omit<FormatAgentExecutionTreeOptions, 'prefix'>>,
): string {
  const meta: string[] = [];
  if (options.includeActivity && node.currentActivity?.summary) {
    meta.push(node.currentActivity.summary);
  }
  if (options.includePlan && node.currentStep) {
    meta.push(`step: ${node.currentStep.title}`);
  }
  if (options.includePlan && node.nextSteps.length) {
    const next = node.nextSteps
      .slice(0, options.maxNextSteps)
      .map((step) => step.title)
      .join(', ');
    meta.push(`next: ${next}`);
  }
  if (node.error) {
    meta.push(`error: ${node.error}`);
  }
  if (options.includeResult && node.result) {
    meta.push(`result: ${node.result}`);
  }
  if (options.includeTiming) {
    const label = node.timing.durationMs === null ? 'elapsed' : 'duration';
    meta.push(`${label}: ${formatDuration(node.timing.elapsedMs)}`);
  }
  const suffix = meta.length
    ? ` - ${truncate(meta.join(' | '), options.maxMetaWidth)}`
    : '';
  return `${statusMarker(node.status)} ${node.displayName} [${node.status}]${suffix}`;
}

export function formatAgentExecutionTreeLines(
  view: AgentExecutionRootView,
  options: FormatAgentExecutionTreeOptions = {},
): string[] {
  const prefix = options.prefix ?? '';
  const resolvedOptions: Required<Omit<FormatAgentExecutionTreeOptions, 'prefix'>> = {
    includeActivity: options.includeActivity ?? true,
    includePlan: options.includePlan ?? true,
    includeTiming: options.includeTiming ?? true,
    includeResult: options.includeResult ?? false,
    maxNextSteps: Math.max(0, options.maxNextSteps ?? 3),
    maxMetaWidth: Math.max(1, options.maxMetaWidth ?? 160),
  };
  const lines: string[] = [];
  const renderNode = (
    node: AgentExecutionNodeView,
    ancestorPrefix: string,
    last: boolean | null,
  ): void => {
    const connector = last === null ? '' : last ? '`- ' : '|- ';
    lines.push(`${prefix}${ancestorPrefix}${connector}${formatNodeLine(node, resolvedOptions)}`);
    const childPrefix = last === null
      ? ancestorPrefix
      : `${ancestorPrefix}${last ? '   ' : '|  '}`;
    node.children.forEach((child, index) => {
      renderNode(child, childPrefix, index === node.children.length - 1);
    });
  };

  if (view.root) {
    renderNode(view.root, '', null);
  }
  if (view.detached.length) {
    lines.push(`${prefix}Detached`);
    view.detached.forEach((node, index) => {
      renderNode(node, '', index === view.detached.length - 1);
    });
  }
  return lines;
}
