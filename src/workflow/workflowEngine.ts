import type { ActoviqAgentClient } from '../runtime/agentClient.js';
import type { AgentEvent, AgentToolCallRecord } from '../types.js';
import type {
  WorkflowDefinition,
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowStepResult,
} from './types.js';
import { createId } from '../runtime/helpers.js';

const isoNow = () => new Date().toISOString();

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function emit(options: WorkflowRunOptions, event: AgentEvent): void {
  options.onEvent?.(event);
}

export class WorkflowEngine {
  constructor(private readonly sdk: ActoviqAgentClient) {}

  async run(
    definition: WorkflowDefinition,
    params: Record<string, unknown>,
    options: WorkflowRunOptions,
  ): Promise<WorkflowRunResult> {
    const runId = createId();
    const levels = topologicalSort(definition.steps);
    const stepResults = new Map<string, WorkflowStepResult>();
    const startedAt = Date.now();

    emit(options, {
      type: 'workflow.start',
      runId,
      workflowName: definition.name,
      stepCount: definition.steps.length,
      timestamp: isoNow(),
    });

    for (const level of levels) {
      if (options.signal?.aborted) {
        break;
      }

      const results = await Promise.all(
        level.map((step) =>
          this.executeStep(step, definition, params, stepResults, runId, options),
        ),
      );

      for (const r of results) {
        stepResults.set(r.id, r);
      }

      // If every step in a level failed, abort remaining levels
      if (results.every((r) => r.status === 'failed')) {
        break;
      }
    }

    // Mark unexecuted steps as skipped
    for (const step of definition.steps) {
      if (!stepResults.has(step.id)) {
        stepResults.set(step.id, {
          id: step.id,
          name: step.name,
          status: 'skipped',
          text: '',
          toolCalls: [],
          durationMs: 0,
          sessionId: '',
        });
      }
    }

    const allResults = [...stepResults.values()];
    const lastCompleted = allResults.filter((r) => r.status === 'completed').pop();
    const workflowStatus = aggregateStatus(allResults);
    const durationMs = Date.now() - startedAt;

    emit(options, {
      type: 'workflow.done',
      runId,
      workflowName: definition.name,
      status: workflowStatus,
      durationMs,
      timestamp: isoNow(),
    });

    return {
      runId,
      workflowName: definition.name,
      steps: allResults,
      text: lastCompleted?.text ?? '',
      durationMs,
      status: workflowStatus,
    };
  }

  private async executeStep(
    step: WorkflowDefinition['steps'][number],
    definition: WorkflowDefinition,
    params: Record<string, unknown>,
    previousResults: Map<string, WorkflowStepResult>,
    runId: string,
    options: WorkflowRunOptions,
  ): Promise<WorkflowStepResult> {
    const startedAt = Date.now();

    emit(options, {
      type: 'step.start',
      runId,
      workflowName: definition.name,
      stepId: step.id,
      stepName: step.name,
      timestamp: isoNow(),
    });

    // Resolve variable interpolation
    const prompt = resolveVariables(step.prompt, params, previousResults);

    // Create an independent session for this step
    const session = await this.sdk.createSession({
      title: `${definition.name}/${step.name}`,
    });

    try {
      const toolPermissions =
        step.allowedTools?.map((toolName) => ({
          toolName,
          behavior: 'allow' as const,
          source: `workflow:${definition.name}/${step.id}`,
        })) ?? [];

      const result = await session.send(prompt, {
        systemPrompt: step.systemPrompt ?? definition.systemPrompt,
        model: step.model ?? definition.model ?? undefined,
        mcpServers: step.mcpServers,
        signal: options.signal,
        permissions: toolPermissions.length > 0 ? toolPermissions : undefined,
      });

      const stepResult: WorkflowStepResult = {
        id: step.id,
        name: step.name,
        status: 'completed',
        text: result.text,
        toolCalls: result.toolCalls.map((c: AgentToolCallRecord) => c.name),
        durationMs: Date.now() - startedAt,
        sessionId: session.id,
      };

      emit(options, {
        type: 'step.done',
        runId,
        workflowName: definition.name,
        stepId: step.id,
        status: stepResult.status,
        durationMs: stepResult.durationMs,
        timestamp: isoNow(),
      });

      return stepResult;
    } catch (err) {
      const stepResult: WorkflowStepResult = {
        id: step.id,
        name: step.name,
        status: 'failed',
        text: '',
        toolCalls: [],
        durationMs: Date.now() - startedAt,
        sessionId: session.id,
        error: asError(err).message,
      };

      emit(options, {
        type: 'step.done',
        runId,
        workflowName: definition.name,
        stepId: step.id,
        status: stepResult.status,
        durationMs: stepResult.durationMs,
        timestamp: isoNow(),
      });

      return stepResult;
    }
  }
}

function resolveVariables(
  prompt: string,
  params: Record<string, unknown>,
  previousResults: Map<string, WorkflowStepResult>,
): string {
  let result = prompt;

  // $steps.<id>.text
  result = result.replace(/\$steps\.(\w+)\.text/g, (_, id) =>
    previousResults.get(id)?.text ?? '',
  );

  // $steps.<id>.toolCalls
  result = result.replace(/\$steps\.(\w+)\.toolCalls/g, (_, id) =>
    previousResults.get(id)?.toolCalls?.join(', ') ?? '',
  );

  // $PARAM_NAME (uppercase with optional underscores and digits)
  result = result.replace(/\$([A-Z][A-Z0-9_]*)/g, (_, name) =>
    params[name] !== undefined ? String(params[name]) : `$${name}`,
  );

  return result;
}

function topologicalSort(
  steps: WorkflowDefinition['steps'],
): WorkflowDefinition['steps'][] {
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const s of steps) {
    inDegree.set(s.id, s.dependsOn.length);
    for (const dep of s.dependsOn) {
      if (!adjacency.has(dep)) {
        adjacency.set(dep, []);
      }
      adjacency.get(dep)!.push(s.id);
    }
  }

  const levels: WorkflowDefinition['steps'][] = [];
  const queue = [...inDegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([id]) => stepMap.get(id)!);

  while (queue.length > 0) {
    levels.push([...queue]);
    const next: WorkflowDefinition['steps'] = [];
    for (const step of queue) {
      for (const neighbor of adjacency.get(step.id) ?? []) {
        const newDeg = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) {
          next.push(stepMap.get(neighbor)!);
        }
      }
    }
    queue.length = 0;
    queue.push(...next);
  }

  return levels;
}

function aggregateStatus(
  results: WorkflowStepResult[],
): 'completed' | 'partial' | 'failed' {
  if (results.length === 0) return 'failed';
  if (results.every((r) => r.status === 'completed')) return 'completed';
  if (results.every((r) => r.status === 'failed' || r.status === 'skipped')) return 'failed';
  return 'partial';
}
