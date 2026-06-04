import { z } from 'zod';

import type { MessageParam } from '../provider/types.js';
import type {
  ActoviqAgentDefinition,
  ActoviqAgentDefinitionSummary,
  ActoviqBackgroundTaskRecord,
  ActoviqTaskToolInput,
  ActoviqTaskToolResult,
  AgentRunOptions,
  AgentRunResult,
  AgentToolDefinition,
  SessionCreateOptions,
} from '../types.js';
import { ConfigurationError } from '../errors.js';
import { tool } from './tools.js';

export interface ActoviqAgentSessionLike {
  readonly id: string;
  send(input: string | MessageParam['content'], options?: AgentRunOptions): Promise<AgentRunResult>;
}

interface ActoviqAgentBindings {
  listDefinitions: () => ActoviqAgentDefinitionSummary[];
  getDefinition: (agent: string) => ActoviqAgentDefinition | undefined;
  runDefinition: (
    agent: string,
    prompt: string | MessageParam['content'],
    options?: AgentRunOptions,
  ) => Promise<AgentRunResult>;
  launchBackgroundDefinition: (
    agent: string,
    prompt: string,
    options: {
      parentRunId: string;
      parentSessionId?: string;
    },
    runOptions?: AgentRunOptions,
  ) => Promise<ActoviqBackgroundTaskRecord>;
  createDefinitionSession: (
    agent: string,
    options?: SessionCreateOptions,
  ) => Promise<ActoviqAgentSessionLike>;
}

export function summarizeActoviqAgentDefinition(
  definition: ActoviqAgentDefinition,
): ActoviqAgentDefinitionSummary {
  return {
    name: definition.name,
    description: definition.description,
    model: definition.model,
    maxToolIterations: definition.maxToolIterations,
    toolNames: (definition.tools ?? []).map(toolDefinition => toolDefinition.name),
    mcpServerNames: (definition.mcpServers ?? []).map(server => server.name),
    inheritDefaultTools: definition.inheritDefaultTools !== false,
    inheritDefaultMcpServers: definition.inheritDefaultMcpServers !== false,
    metadataKeys: Object.keys(definition.metadata ?? {}),
    hasSystemPrompt:
      typeof definition.systemPrompt === 'string' && definition.systemPrompt.trim().length > 0,
    hasHooks:
      (definition.hooks?.sessionStart?.length ?? 0) +
        (definition.hooks?.postSampling?.length ?? 0) +
        (definition.hooks?.postRun?.length ?? 0) >
      0,
  };
}

export class ActoviqAgentHandle {
  constructor(
    private readonly bindings: ActoviqAgentBindings,
    readonly name: string,
    private readonly defaults: AgentRunOptions = {},
  ) {}

  definition(): ActoviqAgentDefinition | undefined {
    return this.bindings.getDefinition(this.name);
  }

  summary(): ActoviqAgentDefinitionSummary | undefined {
    return this.bindings.listDefinitions().find(definition => definition.name === this.name);
  }

  launchBackground(
    prompt: string,
    options: {
      parentRunId: string;
      parentSessionId?: string;
    },
    runOptions?: AgentRunOptions,
  ): Promise<ActoviqBackgroundTaskRecord> {
    return this.bindings.launchBackgroundDefinition(this.name, prompt, options, runOptions);
  }

  run(
    prompt: string | MessageParam['content'],
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    return this.bindings.runDefinition(this.name, prompt, {
      ...this.defaults,
      ...options,
    });
  }

  createSession(options: SessionCreateOptions = {}): Promise<ActoviqAgentSessionLike> {
    return this.bindings.createDefinitionSession(this.name, options);
  }
}

export class ActoviqAgentsApi {
  constructor(private readonly bindings: ActoviqAgentBindings) {}

  list(): ActoviqAgentDefinitionSummary[] {
    return this.bindings.listDefinitions();
  }

  get(name: string): ActoviqAgentDefinition | undefined {
    return this.bindings.getDefinition(name);
  }

  use(name: string, defaults: AgentRunOptions = {}): ActoviqAgentHandle {
    return new ActoviqAgentHandle(this.bindings, name, defaults);
  }

  run(
    name: string,
    prompt: string | MessageParam['content'],
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    return this.bindings.runDefinition(name, prompt, options);
  }

  launchBackground(
    name: string,
    prompt: string,
    options: {
      parentRunId: string;
      parentSessionId?: string;
    },
    runOptions?: AgentRunOptions,
  ): Promise<ActoviqBackgroundTaskRecord> {
    return this.bindings.launchBackgroundDefinition(name, prompt, options, runOptions);
  }

  createSession(
    name: string,
    options: SessionCreateOptions = {},
  ): Promise<ActoviqAgentSessionLike> {
    return this.bindings.createDefinitionSession(name, options);
  }
}

export function createActoviqTaskTool(options: {
  listAgentDefinitions?: () => ActoviqAgentDefinitionSummary[];
  getAgentDefinition: (agent: string) => ActoviqAgentDefinition | undefined;
  runAgent: (
    agent: string,
    prompt: string,
    options?: AgentRunOptions,
  ) => Promise<AgentRunResult>;
  launchBackgroundAgent: (
    agent: string,
    prompt: string,
    options: {
      parentRunId: string;
      parentSessionId?: string;
    },
    runOptions?: AgentRunOptions,
  ) => Promise<ActoviqBackgroundTaskRecord>;
  onDelegated?: (event: {
    subagentType: string;
    description: string;
    parentRunId: string;
    parentSessionId?: string;
    runId: string;
    sessionId?: string;
    status: 'completed' | 'async_launched';
    taskId?: string;
    toolCallCount?: number;
    toolErrorCount?: number;
    textSummary?: string;
  }) => void;
  name?: string;
  description?: string;
}): AgentToolDefinition<ActoviqTaskToolInput, ActoviqTaskToolResult> {
  const name = options.name ?? 'Task';
  const description =
    options.description ??
    'Delegate a focused task to a named subagent and return its final response.';

  return tool(
    {
      name,
      description,
      inputSchema: z.object({
        description: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        task: z.string().min(1).optional(),
        subagent_type: z.string().min(1).optional(),
        agent: z.string().min(1).optional(),
        agent_type: z.string().min(1).optional(),
        run_in_background: z.boolean().optional(),
      }).superRefine((input, ctx) => {
        if (!resolveTaskDescription(input)) {
          ctx.addIssue({
            code: 'custom',
            path: ['description'],
            message: 'Provide `description`, `prompt`, or `task` for the delegated work.',
          });
        }
      }),
      outputSchema: z.union([
        z.object({
          status: z.literal('completed'),
          subagentType: z.string(),
          runId: z.string(),
          sessionId: z.string().optional(),
          model: z.string(),
          text: z.string(),
          toolCallCount: z.number().int().nonnegative(),
          toolErrorCount: z.number().int().nonnegative(),
        }),
        z.object({
          status: z.literal('async_launched'),
          taskId: z.string(),
          subagentType: z.string(),
          sessionId: z.string().optional(),
          outputFile: z.string(),
          canReadOutputFile: z.boolean(),
          description: z.string(),
        }),
      ]),
      serialize: (output) =>
        output.status === 'completed'
          ? [
              `Delegated to ${output.subagentType}.`,
              `Run id: ${output.runId}`,
              output.sessionId ? `Session id: ${output.sessionId}` : undefined,
              `Model: ${output.model}`,
              `Tool calls: ${output.toolCallCount}`,
              `Tool errors: ${output.toolErrorCount}`,
              '',
              output.text,
            ]
              .filter(Boolean)
              .join('\n')
          : [
              `Background task launched for ${output.subagentType}.`,
              `Task id: ${output.taskId}`,
              output.sessionId ? `Session id: ${output.sessionId}` : undefined,
              'Use TaskOutput with this task id to read the result; do not inspect runtime session files directly.',
              `Description: ${output.description}`,
            ]
              .filter(Boolean)
              .join('\n'),
      examples: [
        {
          description: 'Review the current release workflow and call out missing steps.',
          subagent_type: 'code-reviewer',
        },
      ],
      prompt: () => buildTaskToolPrompt(options.listAgentDefinitions?.() ?? []),
    },
    async (input, context) => {
      const taskDescription = resolveTaskDescription(input);
      if (!taskDescription) {
        throw new ConfigurationError(
          'Task tool requires `description`, `prompt`, or `task` so the delegated work is explicit.',
        );
      }
      const resolvedSubagent = resolveSubagentType(input, options);
      if (!resolvedSubagent) {
        const available = formatAvailableSubagents(options.listAgentDefinitions?.() ?? []);
        throw new ConfigurationError(
          `Task tool requires \`subagent_type\` so the delegated task can be routed to a named agent definition.${available ? ` Available subagents: ${available}.` : ''}`,
        );
      }

      const definition = options.getAgentDefinition(resolvedSubagent);
      if (!definition) {
        throw new ConfigurationError(
          `No agent definition named "${resolvedSubagent}" is registered.`,
        );
      }

      const inheritedOptions = extractInheritedDelegationOptions(context);

      if (input.run_in_background) {
        const backgroundTask = await options.launchBackgroundAgent(
          resolvedSubagent,
          taskDescription,
          {
            parentRunId: context.runId,
            parentSessionId: context.sessionId,
          },
          inheritedOptions,
        );
        options.onDelegated?.({
          subagentType: resolvedSubagent,
          description: taskDescription,
          parentRunId: context.runId,
          parentSessionId: context.sessionId,
          runId: backgroundTask.runId ?? backgroundTask.id,
          sessionId: backgroundTask.sessionId,
          status: 'async_launched',
          taskId: backgroundTask.id,
        });
        return {
          status: 'async_launched',
          taskId: backgroundTask.id,
          subagentType: resolvedSubagent,
          sessionId: backgroundTask.sessionId,
          outputFile: backgroundTask.outputFile,
          canReadOutputFile: true,
          description: taskDescription,
        };
      }

      const result = await options.runAgent(resolvedSubagent, taskDescription, inheritedOptions);
      const toolErrorCount = result.toolCalls.filter(call => call.isError).length;
      options.onDelegated?.({
        subagentType: resolvedSubagent,
        description: taskDescription,
        parentRunId: context.runId,
        parentSessionId: context.sessionId,
        runId: result.runId,
        sessionId: result.sessionId,
        status: 'completed',
        toolCallCount: result.toolCalls.length,
        toolErrorCount,
        textSummary: result.text,
      });
      return {
        status: 'completed',
        subagentType: resolvedSubagent,
        runId: result.runId,
        sessionId: result.sessionId,
        model: result.model,
        text: result.text,
        toolCallCount: result.toolCalls.length,
        toolErrorCount,
      };
    },
  );
}

function resolveTaskDescription(input: {
  description?: string;
  prompt?: string;
  task?: string;
}): string | undefined {
  return [input.description, input.prompt, input.task]
    .map(value => value?.trim())
    .find((value): value is string => Boolean(value));
}

function resolveSubagentType(
  input: {
    subagent_type?: string;
    agent?: string;
    agent_type?: string;
  },
  options: {
    getAgentDefinition: (agent: string) => ActoviqAgentDefinition | undefined;
  },
): string | undefined {
  const explicit = [input.subagent_type, input.agent, input.agent_type]
    .map(value => value?.trim())
    .find((value): value is string => Boolean(value));
  if (explicit) {
    return explicit;
  }
  return options.getAgentDefinition('general-purpose') ? 'general-purpose' : undefined;
}

function buildTaskToolPrompt(agents: ActoviqAgentDefinitionSummary[]): string {
  if (agents.length === 0) {
    return [
      'Use the Task tool to delegate focused work to a named subagent when independent investigation, review, debugging, or verification would materially help.',
      'Pass a concise `description` and a `subagent_type`.',
    ].join('\n');
  }

  return [
    'Use the Task tool to delegate focused work to a named subagent when independent investigation, review, debugging, or verification would materially help.',
    'Do not use Task for trivial single-file edits. Prefer it when a separate review, root-cause analysis, or parallel investigation can reduce risk.',
    'Good delegation candidates include multi-file regressions, independent failure paths, audit/review requests, confusing test failures, and risky changes that need a second focused pass.',
    'Choose `debugger` for failing tests or logs, `code-reviewer` for risk review after or before edits, and `general-purpose` for broad investigation when no specialist fits.',
    'Pass a concise `description` plus one of the available `subagent_type` values. If omitted, `general-purpose` is used when available.',
    '',
    'Available subagents:',
    ...agents.map(agent => `- ${agent.name}: ${agent.description}`),
  ].join('\n');
}

function formatAvailableSubagents(agents: ActoviqAgentDefinitionSummary[]): string {
  return agents.map(agent => agent.name).join(', ');
}

function extractInheritedDelegationOptions(
  context: {
    permissionMode?: AgentRunOptions['permissionMode'];
    permissions?: AgentRunOptions['permissions'];
    classifier?: AgentRunOptions['classifier'];
    approver?: AgentRunOptions['approver'];
    hooks?: AgentRunOptions['hooks'];
  },
): AgentRunOptions | undefined {
  if (
    !context.permissionMode &&
    !context.permissions &&
    !context.classifier &&
    !context.approver &&
    !context.hooks
  ) {
    return undefined;
  }

  return {
    permissionMode: context.permissionMode,
    permissions: context.permissions,
    classifier: context.classifier,
    approver: context.approver,
    hooks: context.hooks,
  };
}
