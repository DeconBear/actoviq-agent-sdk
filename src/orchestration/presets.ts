import type { AgentSpec, JsonObject } from '../core/index.js';
import type {
  ChildFailurePolicy,
  OrchestrationInput,
} from './contracts.js';
import { ChildRunner } from './childRunner.js';
import {
  WorkflowGraph,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeContext,
} from './workflowGraph.js';

export interface AgentWorkflowNodeOptions<TInput, TContext, TOutput> {
  readonly id: string;
  readonly runner: ChildRunner;
  readonly agent: AgentSpec<TContext, TOutput>;
  readonly input: (context: WorkflowNodeContext<TInput>) => OrchestrationInput;
  readonly context?: (context: WorkflowNodeContext<TInput>) => TContext;
  readonly failurePolicy?: ChildFailurePolicy;
  readonly effect?: 'read' | 'idempotent-write' | 'side-effect';
  readonly idempotencyKey?: (context: WorkflowNodeContext<TInput>) => string | undefined;
  readonly metadata?: Readonly<JsonObject>;
}

/** Agent work in a graph remains a ChildRunner node, not a second workflow runtime. */
export function agentWorkflowNode<TInput, TContext, TOutput>(
  options: AgentWorkflowNodeOptions<TInput, TContext, TOutput>,
): WorkflowNode<TInput> {
  return {
    id: options.id,
    execute: context => options.runner.run({
      parent: context.scope,
      agent: options.agent,
      input: options.input(context),
      context: options.context?.(context),
      failurePolicy: options.failurePolicy,
      effect: options.effect,
      idempotencyKey: options.idempotencyKey?.(context),
      metadata: options.metadata,
    }),
  };
}

export interface PanelPresetOptions<TInput> {
  readonly panelists: readonly WorkflowNode<TInput>[];
  readonly synthesize: WorkflowNode<TInput>;
}

export function panelPreset<TInput>(options: PanelPresetOptions<TInput>): WorkflowGraph<TInput> {
  return parallelJoinGraph(options.panelists, options.synthesize);
}

export interface TeamPresetOptions<TInput> {
  readonly members: readonly WorkflowNode<TInput>[];
  readonly reducer: WorkflowNode<TInput>;
}

export function teamPreset<TInput>(options: TeamPresetOptions<TInput>): WorkflowGraph<TInput> {
  return parallelJoinGraph(options.members, options.reducer);
}

export interface ReviewerPresetOptions<TInput> {
  readonly author: WorkflowNode<TInput>;
  readonly reviewers: readonly WorkflowNode<TInput>[];
  readonly reducer: WorkflowNode<TInput>;
}

export function reviewerPreset<TInput>(options: ReviewerPresetOptions<TInput>): WorkflowGraph<TInput> {
  const edges: WorkflowEdge<TInput>[] = [];
  for (const reviewer of options.reviewers) {
    edges.push({ from: options.author.id, to: reviewer.id });
    edges.push({ from: reviewer.id, to: options.reducer.id });
  }
  edges.push({ from: options.author.id, to: options.reducer.id });
  return new WorkflowGraph({
    nodes: [options.author, ...options.reviewers, options.reducer],
    edges,
  });
}

export interface RouterRoute<TInput> {
  readonly node: WorkflowNode<TInput>;
  readonly when: NonNullable<WorkflowEdge<TInput>['when']>;
}

export interface RouterPresetOptions<TInput> {
  readonly router: WorkflowNode<TInput>;
  readonly routes: readonly RouterRoute<TInput>[];
  readonly reducer?: WorkflowNode<TInput>;
}

export function routerPreset<TInput>(options: RouterPresetOptions<TInput>): WorkflowGraph<TInput> {
  const routeNodes = options.routes.map(route => route.node);
  const edges: WorkflowEdge<TInput>[] = options.routes.map(route => ({
    from: options.router.id,
    to: route.node.id,
    when: route.when,
  }));
  if (!options.reducer) {
    return new WorkflowGraph({ nodes: [options.router, ...routeNodes], edges });
  }
  for (const route of options.routes) edges.push({ from: route.node.id, to: options.reducer.id });
  const reducer: WorkflowNode<TInput> = { ...options.reducer, activation: 'any' };
  return new WorkflowGraph({
    nodes: [options.router, ...routeNodes, reducer],
    edges,
  });
}

export interface SwarmPresetOptions<TInput> {
  readonly agents: readonly WorkflowNode<TInput>[];
  /** Conditional edges express routing/handoffs between swarm members. */
  readonly routes: readonly WorkflowEdge<TInput>[];
  readonly reducer?: WorkflowNode<TInput>;
}

export function swarmPreset<TInput>(options: SwarmPresetOptions<TInput>): WorkflowGraph<TInput> {
  if (!options.reducer) return new WorkflowGraph({ nodes: options.agents, edges: options.routes });
  const leaves = leafIds(options.agents, options.routes);
  return new WorkflowGraph({
    nodes: [...options.agents, { ...options.reducer, activation: 'any' }],
    edges: [
      ...options.routes,
      ...leaves.map(from => ({ from, to: options.reducer!.id })),
    ],
  });
}

function parallelJoinGraph<TInput>(
  members: readonly WorkflowNode<TInput>[],
  reducer: WorkflowNode<TInput>,
): WorkflowGraph<TInput> {
  if (members.length === 0) throw new Error('Parallel orchestration preset requires a member.');
  return new WorkflowGraph({
    nodes: [...members, reducer],
    edges: members.map(member => ({ from: member.id, to: reducer.id })),
  });
}

function leafIds<TInput>(
  nodes: readonly WorkflowNode<TInput>[],
  edges: readonly WorkflowEdge<TInput>[],
): readonly string[] {
  const nonLeaves = new Set(edges.map(edge => edge.from));
  return nodes.map(node => node.id).filter(id => !nonLeaves.has(id)).sort();
}
