import type { MaybePromise } from '../core/index.js';
import type { OrchestrationScope } from './contracts.js';

export type WorkflowNodeStatus = 'pending' | 'ready' | 'running' | 'completed' | 'skipped';

export interface WorkflowNodeContext<TInput = unknown> {
  readonly nodeId: string;
  readonly input: TInput;
  readonly scope: OrchestrationScope;
  readonly signal: AbortSignal;
  readonly outputs: ReadonlyMap<string, unknown>;
}

export interface WorkflowReducerContext<TInput = unknown> extends WorkflowNodeContext<TInput> {
  /** Only completed, active direct predecessors are included. */
  readonly inputs: ReadonlyMap<string, unknown>;
}

export interface WorkflowNode<TInput = unknown> {
  readonly id: string;
  readonly execute?: (context: WorkflowNodeContext<TInput>) => MaybePromise<unknown>;
  readonly reduce?: (context: WorkflowReducerContext<TInput>) => MaybePromise<unknown>;
  /** `all` is a join/barrier; `any` activates after at least one route matches. */
  readonly activation?: 'all' | 'any';
}

export interface WorkflowRouteContext<TInput = unknown> {
  readonly input: TInput;
  readonly scope: OrchestrationScope;
  readonly from: string;
  readonly to: string;
  readonly sourceOutput: unknown;
  readonly outputs: ReadonlyMap<string, unknown>;
}

export interface WorkflowEdge<TInput = unknown> {
  readonly from: string;
  readonly to: string;
  readonly when?: (context: WorkflowRouteContext<TInput>) => MaybePromise<boolean>;
}

export interface WorkflowGraphOptions<TInput = unknown> {
  readonly nodes: readonly WorkflowNode<TInput>[];
  readonly edges?: readonly WorkflowEdge<TInput>[];
}

export interface WorkflowExecuteOptions<TInput> {
  readonly input: TInput;
  readonly scope: OrchestrationScope;
  readonly maxConcurrency?: number;
}

export interface WorkflowGraphResult {
  readonly order: readonly string[];
  readonly outputs: ReadonlyMap<string, unknown>;
  readonly statuses: ReadonlyMap<string, WorkflowNodeStatus>;
}

export class WorkflowNodeExecutionError extends Error {
  constructor(readonly nodeId: string, options: ErrorOptions) {
    super(`Workflow node "${nodeId}" failed.`, options);
    this.name = 'WorkflowNodeExecutionError';
  }
}

/** Immutable, validated DAG with deterministic lexical scheduling and result order. */
export class WorkflowGraph<TInput = unknown> {
  private readonly nodes: ReadonlyMap<string, WorkflowNode<TInput>>;
  private readonly edges: readonly WorkflowEdge<TInput>[];
  private readonly incoming: ReadonlyMap<string, readonly WorkflowEdge<TInput>[]>;
  private readonly topologicalOrder: readonly string[];

  constructor(options: WorkflowGraphOptions<TInput>) {
    const validated = validateGraph(options.nodes, options.edges ?? []);
    this.nodes = validated.nodes;
    this.edges = validated.edges;
    this.incoming = validated.incoming;
    this.topologicalOrder = validated.order;
  }

  inspect(): {
    readonly order: readonly string[];
    readonly nodes: readonly string[];
    readonly edges: readonly Readonly<{ from: string; to: string; conditional: boolean }>[];
  } {
    return {
      order: [...this.topologicalOrder],
      nodes: [...this.topologicalOrder],
      edges: this.edges.map(edge => ({
        from: edge.from,
        to: edge.to,
        conditional: edge.when !== undefined,
      })),
    };
  }

  async execute(options: WorkflowExecuteOptions<TInput>): Promise<WorkflowGraphResult> {
    const maxConcurrency = options.maxConcurrency ?? 8;
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError('Workflow maxConcurrency must be a positive safe integer.');
    }
    if (options.scope.signal.aborted) throw abortReason(options.scope.signal);

    const controller = new AbortController();
    const onAbort = () => controller.abort(options.scope.signal.reason);
    options.scope.signal.addEventListener('abort', onAbort, { once: true });
    const statuses = new Map<string, WorkflowNodeStatus>(
      this.topologicalOrder.map(id => [id, 'pending'] as const),
    );
    const outputs = new Map<string, unknown>();
    const activeEdges = new Map<WorkflowEdge<TInput>, boolean>();
    const running = new Map<string, Promise<{ id: string; value: unknown }>>();

    try {
      while (countTerminal(statuses) < this.topologicalOrder.length) {
        let progressed = false;
        for (const nodeId of this.topologicalOrder) {
          if (statuses.get(nodeId) !== 'pending') continue;
          const predecessors = this.incoming.get(nodeId) ?? [];
          if (!predecessors.every(edge => isTerminal(statuses.get(edge.from)))) continue;
          const active = await this.resolveActivation(
            nodeId,
            predecessors,
            activeEdges,
            outputs,
            options,
          );
          statuses.set(nodeId, active ? 'ready' : 'skipped');
          progressed = true;
        }

        for (const nodeId of this.topologicalOrder) {
          if (running.size >= maxConcurrency) break;
          if (statuses.get(nodeId) !== 'ready') continue;
          statuses.set(nodeId, 'running');
          const operation = this.executeNode(nodeId, outputs, options, controller.signal)
            .then(value => ({ id: nodeId, value }))
            .catch(error => {
              throw new WorkflowNodeExecutionError(nodeId, { cause: error });
            });
          running.set(nodeId, operation);
          progressed = true;
        }

        if (running.size === 0) {
          if (countTerminal(statuses) === this.topologicalOrder.length) break;
          if (!progressed) throw new Error('Workflow scheduler reached an invalid stalled state.');
          continue;
        }

        let completed: { id: string; value: unknown };
        try {
          completed = await raceWithSignal(Promise.race(running.values()), controller.signal);
        } catch (error) {
          controller.abort(error);
          // Do not let a node that ignores AbortSignal hold the scheduler open.
          void Promise.allSettled(running.values());
          throw error;
        }
        running.delete(completed.id);
        outputs.set(completed.id, completed.value);
        statuses.set(completed.id, 'completed');
      }

      return {
        order: [...this.topologicalOrder],
        outputs: orderedMap(this.topologicalOrder, outputs),
        statuses: orderedMap(this.topologicalOrder, statuses),
      };
    } finally {
      controller.abort(new Error('Workflow execution finished.'));
      options.scope.signal.removeEventListener('abort', onAbort);
    }
  }

  private async resolveActivation(
    nodeId: string,
    incoming: readonly WorkflowEdge<TInput>[],
    activeEdges: Map<WorkflowEdge<TInput>, boolean>,
    outputs: ReadonlyMap<string, unknown>,
    options: WorkflowExecuteOptions<TInput>,
  ): Promise<boolean> {
    if (incoming.length === 0) return true;
    for (const edge of incoming) {
      if (activeEdges.has(edge)) continue;
      const sourceCompleted = outputs.has(edge.from);
      activeEdges.set(edge, sourceCompleted && (edge.when
        ? await raceWithSignal(Promise.resolve(edge.when({
            input: options.input,
            scope: options.scope,
            from: edge.from,
            to: edge.to,
            sourceOutput: outputs.get(edge.from),
            outputs: orderedMap(this.topologicalOrder, outputs),
          })), options.scope.signal)
        : true));
    }
    const flags = incoming.map(edge => activeEdges.get(edge) === true);
    const activation = this.nodes.get(nodeId)?.activation ?? 'all';
    return activation === 'any' ? flags.some(Boolean) : flags.every(Boolean);
  }

  private async executeNode(
    nodeId: string,
    outputs: ReadonlyMap<string, unknown>,
    options: WorkflowExecuteOptions<TInput>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const node = this.nodes.get(nodeId)!;
    const snapshot = orderedMap(this.topologicalOrder, outputs);
    if (node.execute) {
      return node.execute({
        nodeId,
        input: options.input,
        scope: options.scope,
        signal,
        outputs: snapshot,
      });
    }
    const inputs = new Map<string, unknown>();
    for (const edge of this.incoming.get(nodeId) ?? []) {
      if (outputs.has(edge.from)) inputs.set(edge.from, outputs.get(edge.from));
    }
    return node.reduce!({
      nodeId,
      input: options.input,
      scope: options.scope,
      signal,
      outputs: snapshot,
      inputs,
    });
  }
}

interface ValidatedGraph<TInput> {
  readonly nodes: ReadonlyMap<string, WorkflowNode<TInput>>;
  readonly edges: readonly WorkflowEdge<TInput>[];
  readonly incoming: ReadonlyMap<string, readonly WorkflowEdge<TInput>[]>;
  readonly order: readonly string[];
}

function validateGraph<TInput>(
  rawNodes: readonly WorkflowNode<TInput>[],
  rawEdges: readonly WorkflowEdge<TInput>[],
): ValidatedGraph<TInput> {
  if (rawNodes.length === 0) throw new Error('WorkflowGraph requires at least one node.');
  const nodes = new Map<string, WorkflowNode<TInput>>();
  for (const node of rawNodes) {
    const id = node.id.trim();
    if (!id) throw new Error('Workflow node id must not be empty.');
    if (nodes.has(id)) throw new Error(`Duplicate workflow node "${id}".`);
    if ((node.execute === undefined) === (node.reduce === undefined)) {
      throw new Error(`Workflow node "${id}" must define exactly one of execute or reduce.`);
    }
    nodes.set(id, Object.freeze({ ...node, id }));
  }

  const edgeKeys = new Set<string>();
  const edges = [...rawEdges]
    .map(edge => Object.freeze({ ...edge, from: edge.from.trim(), to: edge.to.trim() }))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  const incoming = new Map<string, WorkflowEdge<TInput>[]>(
    [...nodes.keys()].map(id => [id, []]),
  );
  const outgoing = new Map<string, WorkflowEdge<TInput>[]>(
    [...nodes.keys()].map(id => [id, []]),
  );
  for (const edge of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      throw new Error(`Workflow edge "${edge.from}" -> "${edge.to}" references an unknown node.`);
    }
    if (edge.from === edge.to) throw new Error(`Workflow node "${edge.from}" cannot depend on itself.`);
    const key = `${edge.from}\u0000${edge.to}`;
    if (edgeKeys.has(key)) throw new Error(`Duplicate workflow edge "${edge.from}" -> "${edge.to}".`);
    edgeKeys.add(key);
    incoming.get(edge.to)!.push(edge);
    outgoing.get(edge.from)!.push(edge);
  }
  for (const node of nodes.values()) {
    if (node.reduce && incoming.get(node.id)!.length === 0) {
      throw new Error(`Workflow reducer "${node.id}" requires at least one predecessor.`);
    }
  }

  const indegree = new Map([...incoming].map(([id, values]) => [id, values.length]));
  const ready = [...nodes.keys()].filter(id => indegree.get(id) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const edge of outgoing.get(id)!.sort((left, right) => left.to.localeCompare(right.to))) {
      const remaining = indegree.get(edge.to)! - 1;
      indegree.set(edge.to, remaining);
      if (remaining === 0) {
        ready.push(edge.to);
        ready.sort();
      }
    }
  }
  if (order.length !== nodes.size) {
    const cyclic = [...nodes.keys()].filter(id => !order.includes(id)).sort();
    throw new Error(`WorkflowGraph contains a cycle involving: ${cyclic.join(', ')}.`);
  }
  return {
    nodes,
    edges,
    incoming,
    order,
  };
}

function countTerminal(statuses: ReadonlyMap<string, WorkflowNodeStatus>): number {
  let count = 0;
  for (const status of statuses.values()) if (isTerminal(status)) count += 1;
  return count;
}

function isTerminal(status: WorkflowNodeStatus | undefined): boolean {
  return status === 'completed' || status === 'skipped';
}

function orderedMap<T>(order: readonly string[], source: ReadonlyMap<string, T>): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const id of order) if (source.has(id)) result.set(id, source.get(id)!);
  return result;
}

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Workflow aborted.');
}
