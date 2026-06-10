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
        description: z.string().min(1).optional()
          .describe('A short (3-5 word) label summarizing what the agent will do.'),
        prompt: z.string().min(1).optional()
          .describe('The full task for the agent to perform. The subagent starts with zero context: include background, what to do, and what to report back.'),
        task: z.string().min(1).optional()
          .describe('Alias of `prompt`.'),
        subagent_type: z.string().min(1).optional()
          .describe('The type of specialized agent to use for this task.'),
        agent: z.string().min(1).optional(),
        agent_type: z.string().min(1).optional(),
        run_in_background: z.boolean().optional(),
      }).superRefine((input, ctx) => {
        if (!resolveTaskPrompt(input)) {
          ctx.addIssue({
            code: 'custom',
            path: ['prompt'],
            message: 'Provide `prompt` (full task briefing) and optionally a short `description` label for the delegated work.',
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
          description: 'Release workflow review',
          prompt:
            'Review the release workflow defined in scripts/release.mjs and .github/workflows/release.yml. Context: we just added a changelog generation step. Check for missing steps, ordering hazards, and untested failure paths. Report concrete findings with file references; do not change any files.',
          subagent_type: 'code-reviewer',
        },
      ],
      prompt: () => buildTaskToolPrompt(options.listAgentDefinitions?.() ?? []),
    },
    async (input, context) => {
      const taskPrompt = resolveTaskPrompt(input);
      if (!taskPrompt) {
        throw new ConfigurationError(
          'Task tool requires `prompt` (or `task`/`description`) so the delegated work is explicit.',
        );
      }
      const taskLabel = resolveTaskLabel(input, taskPrompt);
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
          taskPrompt,
          {
            parentRunId: context.runId,
            parentSessionId: context.sessionId,
          },
          inheritedOptions,
        );
        options.onDelegated?.({
          subagentType: resolvedSubagent,
          description: taskLabel,
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
          description: taskLabel,
        };
      }

      const result = await options.runAgent(resolvedSubagent, taskPrompt, inheritedOptions);
      const toolErrorCount = result.toolCalls.filter(call => call.isError).length;
      options.onDelegated?.({
        subagentType: resolvedSubagent,
        description: taskLabel,
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

/**
 * The detailed briefing wins: models following the Claude Code convention send
 * a short `description` label plus a full `prompt`. Preferring `description`
 * here would silently drop the actual task briefing.
 */
function resolveTaskPrompt(input: {
  description?: string;
  prompt?: string;
  task?: string;
}): string | undefined {
  return [input.prompt, input.task, input.description]
    .map(value => value?.trim())
    .find((value): value is string => Boolean(value));
}

/** Short human-readable label for events and async task listings. */
function resolveTaskLabel(
  input: { description?: string },
  taskPrompt: string,
): string {
  const label = input.description?.trim();
  if (label) {
    return label;
  }
  return taskPrompt.length > 80 ? `${taskPrompt.slice(0, 77)}...` : taskPrompt;
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
  const shared = [
    'Launch a subagent with the Task tool to handle complex, multi-step work autonomously. Delegate proactively whenever independent investigation, review, debugging, parallel exploration, or verification would materially help — do not wait for the user to ask for a subagent.',
    '',
    'When to use Task:',
    '- Multi-file regressions, independent failure paths, audits/reviews, confusing test failures, and risky changes that need a second focused pass.',
    '- Open-ended searches or research that may take several rounds of exploration and would otherwise fill your context with intermediate output.',
    '- Independent subtasks that can run in parallel: launch multiple Task calls in a single message to run them concurrently.',
    '',
    'When NOT to use Task:',
    '- Reading a specific known file path, or a simple 2-3 file lookup — do it directly; it is faster.',
    '- Trivial single-file edits.',
    '',
    'Writing the prompt:',
    '- The subagent starts with zero context. Brief it like a capable colleague who just walked in: explain the goal and why it matters, what you already learned or ruled out, exact file paths and commands, and what it should report back.',
    '- Always pass a full `prompt` (the task briefing) plus a short 3-5 word `description` label. Terse command-style prompts produce shallow, generic work.',
    '- Clearly say whether the agent should write code or only investigate and report.',
    '- The agent returns a single final message; its work is otherwise invisible. Summarize the result for the user yourself.',
  ];

  if (agents.length === 0) {
    return shared.join('\n');
  }

  return [
    ...shared,
    '',
    'If `subagent_type` is omitted, `general-purpose` is used when available. If an agent description says it should be used proactively, use it without being asked.',
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
