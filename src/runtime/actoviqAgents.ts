import { z } from 'zod';

import type { MessageParam } from '../provider/types.js';
import type {
  ActoviqAgentDefinition,
  ActoviqAgentDefinitionSummary,
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
      }),
      outputSchema: z.object({
        subagentType: z.string(),
        runId: z.string(),
        sessionId: z.string().optional(),
        model: z.string(),
        text: z.string(),
        toolCallCount: z.number().int().nonnegative(),
      }),
      examples: [
        {
          description: 'Review the current release workflow and call out missing steps.',
          subagent_type: 'reviewer',
        },
      ],
    },
    async ({ description: taskDescription, subagent_type }, context) => {
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

      const result = await options.runAgent(resolvedSubagent, taskDescription);
      options.onDelegated?.({
        subagentType: resolvedSubagent,
        description: taskDescription,
        parentRunId: context.runId,
        parentSessionId: context.sessionId,
        runId: result.runId,
        sessionId: result.sessionId,
      });
      return {
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
