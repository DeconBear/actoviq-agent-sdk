import type {
  ModelTeamResult,
  TeamDefinition,
  TeamEvent,
  WorkflowNode,
} from '../types.js';
import { AgentPool } from './agentPool.js';
import { runMemberAgent } from './teamRuntime.js';

const MAX_WORKFLOW_NODES = 128;
const MAX_WORKFLOW_DEPTH = 32;

export function validateWorkflowSquad(
  definition: Pick<TeamDefinition, 'workflowTree'>,
): string[] {
  const root = definition.workflowTree;
  if (!root) return ['Workflow requires a root node'];

  const problems: string[] = [];
  const ids = new Set<string>();
  let nodeCount = 0;

  const visit = (node: WorkflowNode, depth: number): void => {
    nodeCount += 1;
    if (nodeCount > MAX_WORKFLOW_NODES) return;
    if (depth > MAX_WORKFLOW_DEPTH) {
      problems.push(`Workflow exceeds the maximum depth of ${MAX_WORKFLOW_DEPTH}`);
      return;
    }

    const id = typeof node.id === 'string' ? node.id.trim() : '';
    if (!id) problems.push('Every workflow node requires an id');
    else if (ids.has(id)) problems.push(`Duplicate workflow node id "${id}"`);
    else ids.add(id);

    const children = Array.isArray(node.children) ? node.children : [];
    if (!Array.isArray(node.children)) {
      problems.push(`Workflow node "${id || '(unnamed)'}" requires a children array`);
    }
    const type = String(node.type);
    if (type === 'agent' && children.length > 1) {
      problems.push(`Agent node "${id}" may have at most one continuation`);
    } else if (type === 'branch') {
      if (!node.condition?.trim()) problems.push(`Branch node "${id}" requires a condition`);
      if (children.length !== 2) problems.push(`Branch node "${id}" requires exactly two children`);
    } else if (type === 'parallel' && children.length < 2) {
      problems.push(`Parallel node "${id}" requires at least two children`);
    } else if (type !== 'agent' && type !== 'branch' && type !== 'parallel') {
      problems.push(`Workflow node "${id}" has unsupported type "${type}"`);
    }
    children.forEach(child => visit(child, depth + 1));
  };

  visit(root, 1);
  if (nodeCount > MAX_WORKFLOW_NODES) {
    problems.push(`Workflow exceeds the maximum size of ${MAX_WORKFLOW_NODES} nodes`);
  }
  return [...new Set(problems)];
}

export async function executeWorkflowTree(
  root: WorkflowNode,
  input: string,
  runAgent: (node: WorkflowNode, input: string) => Promise<string>,
): Promise<string> {
  const execute = async (node: WorkflowNode, nodeInput: string): Promise<string> => {
    if (node.type === 'agent') {
      const output = await runAgent(node, nodeInput);
      const continuation = node.children?.[0];
      return continuation ? execute(continuation, output) : output;
    }
    if (node.type === 'branch') {
      const matches = nodeInput.toLowerCase().includes((node.condition ?? '').toLowerCase());
      return execute(node.children[matches ? 0 : 1]!, nodeInput);
    }
    const outputs = await Promise.all(node.children.map(child => execute(child, nodeInput)));
    return outputs.filter(Boolean).join('\n\n');
  };

  return execute(root, input);
}

export async function runWorkflowSquad(
  definition: TeamDefinition,
  prompt: string,
  signal: AbortSignal,
  workDir: string,
  onEvent?: (event: TeamEvent) => void,
): Promise<ModelTeamResult> {
  const problems = validateWorkflowSquad(definition);
  if (problems.length > 0) {
    throw new Error(`Invalid workflow "${definition.name}": ${problems.join('; ')}`);
  }

  const pool = new AgentPool();
  const startedAt = Date.now();
  const statuses: ModelTeamResult['memberStatuses'] = [];
  let totalInput = 0;
  let totalOutput = 0;

  const answer = await executeWorkflowTree(definition.workflowTree!, prompt, async (node, input) => {
    const run = await runMemberAgent({
      identity: { id: node.id, model: node.model || '', role: node.label || node.type },
      member: { model: node.model || '', role: node.label || 'agent', systemPrompt: '' },
      task: node.prompt ? node.prompt.replace(/\{\{input\}\}/gu, input) : input,
      systemPrompt: '',
      cwd: workDir,
      tools: [],
      maxIterations: Infinity,
      timeoutMs: definition.timeoutMs ?? 300_000,
      signal,
      pool,
      round: 1,
      onEvent,
    });
    statuses.push(run.status);
    totalInput += run.inputTokens;
    totalOutput += run.outputTokens;
    return run.report;
  });

  return {
    answer,
    mode: 'graph',
    cost: {
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      estimatedCost: null,
      breakdown: [],
    },
    durationMs: Date.now() - startedAt,
    memberStatuses: statuses,
    reports: [],
    skippedNodes: [],
    incompleteReason: undefined,
  };
}
