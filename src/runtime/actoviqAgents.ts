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
        description: z.string().min(1),
        subagent_type: z.string().min(1).optional(),
        run_in_background: z.boolean().optional(),
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
              '',
              output.text,
            ]
              .filter(Boolean)
              .join('\n')
          : [
              `Background task launched for ${output.subagentType}.`,
              `Task id: ${output.taskId}`,
              output.sessionId ? `Session id: ${output.sessionId}` : undefined,
              `Output file: ${output.outputFile}`,
              `Description: ${output.description}`,
            ]
              .filter(Boolean)
              .join('\n'),
      examples: [
        {
          description: 'Review the current release workflow and call out missing steps.',
          subagent_type: 'reviewer',
        },
      ],
    },
    async ({ description: taskDescription, subagent_type, run_in_background }, context) => {
      const resolvedSubagent = subagent_type?.trim();
      if (!resolvedSubagent) {
        throw new ConfigurationError(
          'Task tool requires `subagent_type` so the delegated task can be routed to a named agent definition.',
        );
      }

      const definition = options.getAgentDefinition(resolvedSubagent);
      if (!definition) {
        throw new ConfigurationError(
          `No agent definition named "${resolvedSubagent}" is registered.`,
        );
      }

      const inheritedOptions = extractInheritedDelegationOptions(context);

      if (run_in_background) {
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
      options.onDelegated?.({
        subagentType: resolvedSubagent,
        description: taskDescription,
        parentRunId: context.runId,
        parentSessionId: context.sessionId,
        runId: result.runId,
        sessionId: result.sessionId,
      });
      return {
        status: 'completed',
        subagentType: resolvedSubagent,
        runId: result.runId,
        sessionId: result.sessionId,
        model: result.model,
        text: result.text,
        toolCallCount: result.toolCalls.length,
      };
    },
  );
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
