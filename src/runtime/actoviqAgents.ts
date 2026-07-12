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

export const ACTOVIQ_RUN_STATE_KEY = '__actoviqRunState';

export interface ActoviqRunToolState {
  subagentFanout: number;
}

export function createActoviqRunToolState(): ActoviqRunToolState {
  return { subagentFanout: 0 };
}

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
    effort: definition.effort,
    permissionMode: definition.permissionMode,
    maxToolIterations: definition.maxToolIterations,
    maxTurns: definition.maxTurns,
    toolNames: (definition.tools ?? []).map(toolDefinition => toolDefinition.name),
    allowedTools: [...(definition.allowedTools ?? [])],
    disallowedTools: [...(definition.disallowedTools ?? [])],
    allowedAgents: [...(definition.allowedAgents ?? [])],
    skills: [...(definition.skills ?? [])],
    mcpServerNames: (definition.mcpServers ?? []).map(server => server.name),
    requiredMcpServers: [...(definition.requiredMcpServers ?? [])],
    inheritDefaultTools: definition.inheritDefaultTools !== false,
    inheritDefaultMcpServers: definition.inheritDefaultMcpServers !== false,
    background: definition.background === true,
    isolation: definition.isolation,
    memory: definition.memory,
    source: definition.source,
    sourcePath: definition.sourcePath,
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
    delegation?: {
      description: string;
      name?: string;
      isolation?: 'worktree';
      cwd?: string;
    },
  ) => Promise<{
    result: AgentRunResult;
    sessionId?: string;
    worktreePath?: string;
    worktreeBranch?: string;
  }>;
  launchBackgroundAgent: (
    agent: string,
    prompt: string,
    options: {
      parentRunId: string;
      parentSessionId?: string;
    },
    runOptions?: AgentRunOptions,
    delegation?: {
      description: string;
      name?: string;
      isolation?: 'worktree';
      cwd?: string;
    },
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
    requestCount?: number;
    toolCallCount?: number;
    toolErrorCount?: number;
    textSummary?: string;
  }) => void;
  name?: string;
  description?: string;
  maxDepth?: number;
  maxFanout?: number;
}): AgentToolDefinition<ActoviqTaskToolInput, ActoviqTaskToolResult> {
  const name = options.name ?? 'Agent';
  const description =
    options.description ??
    'Delegate a focused task to a named subagent and return its final response.';

  return tool(
    {
      name,
      description,
      aliases: name === 'Agent' ? ['Task'] : name === 'Task' ? ['Agent'] : undefined,
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
        model: z.string().min(1).optional(),
        run_in_background: z.boolean().optional(),
        name: z.string().min(1).optional(),
        isolation: z.literal('worktree').optional(),
        cwd: z.string().min(1).optional(),
      }).superRefine((input, ctx) => {
        if (!resolveTaskPrompt(input)) {
          ctx.addIssue({
            code: 'custom',
            path: ['prompt'],
            message: 'Provide `prompt` (full task briefing) and optionally a short `description` label for the delegated work.',
          });
        }
        if (input.cwd && input.isolation) {
          ctx.addIssue({
            code: 'custom',
            path: ['cwd'],
            message: '`cwd` and `isolation` are mutually exclusive.',
          });
        }
      }),
      outputSchema: z.union([
        z.object({
          status: z.literal('completed'),
          subagentType: z.string(),
          runId: z.string(),
          sessionId: z.string().optional(),
          agentId: z.string().optional(),
          model: z.string(),
          text: z.string(),
          toolCallCount: z.number().int().nonnegative(),
          toolErrorCount: z.number().int().nonnegative(),
          worktreePath: z.string().optional(),
          worktreeBranch: z.string().optional(),
        }),
        z.object({
          status: z.literal('async_launched'),
          taskId: z.string(),
          subagentType: z.string(),
          sessionId: z.string().optional(),
          agentId: z.string().optional(),
          outputFile: z.string(),
          canReadOutputFile: z.boolean(),
          description: z.string(),
          worktreePath: z.string().optional(),
          worktreeBranch: z.string().optional(),
        }),
      ]),
      serialize: (output) =>
        output.status === 'completed'
          ? [
              `Delegated to ${output.subagentType}.`,
              `Run id: ${output.runId}`,
              output.sessionId ? `Session id: ${output.sessionId}` : undefined,
              output.agentId ? `Agent id: ${output.agentId}` : undefined,
              `Model: ${output.model}`,
              `Tool calls: ${output.toolCallCount}`,
              `Tool errors: ${output.toolErrorCount}`,
              output.worktreePath ? `Worktree: ${output.worktreePath}` : undefined,
              output.worktreeBranch ? `Branch: ${output.worktreeBranch}` : undefined,
              '',
              output.text,
            ]
              .filter(Boolean)
              .join('\n')
          : [
              `Background task launched for ${output.subagentType}.`,
              `Task id: ${output.taskId}`,
              output.sessionId ? `Session id: ${output.sessionId}` : undefined,
              output.agentId ? `Agent id: ${output.agentId}` : undefined,
              'You will be notified automatically when this agent completes. Use TaskOutput only for explicit manual inspection; do not poll it.',
              `Description: ${output.description}`,
              output.worktreePath ? `Worktree: ${output.worktreePath}` : undefined,
              output.worktreeBranch ? `Branch: ${output.worktreeBranch}` : undefined,
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

      const parentDepth = readNonNegativeInteger(context.metadata.__actoviqAgentDepth) ?? 0;
      const maxDepth = options.maxDepth ?? 1;
      if (parentDepth >= maxDepth) {
        throw new ConfigurationError(
          `Subagent depth limit reached (${maxDepth}). Complete this task without another delegation.`,
        );
      }
      const allowedAgents = readStringArray(context.metadata.__actoviqAllowedAgents);
      if (allowedAgents && !allowedAgents.includes(resolvedSubagent)) {
        throw new ConfigurationError(
          `Subagent "${resolvedSubagent}" is not allowed in this delegated context.`,
        );
      }
      const runState = getActoviqRunToolState(context.metadata);
      const currentFanout = runState.subagentFanout;
      const maxFanout = options.maxFanout ?? 8;
      if (currentFanout >= maxFanout) {
        throw new ConfigurationError(`Subagent fanout limit reached (${maxFanout}).`);
      }
      runState.subagentFanout = currentFanout + 1;

      const inheritedOptions = extractInheritedDelegationOptions(context, {
        depth: parentDepth + 1,
        allowedAgents: definition.allowedAgents,
        model: input.model,
      });
      const delegation = {
        description: taskLabel,
        name: input.name,
        isolation: input.isolation ?? definition.isolation,
        cwd: input.cwd ?? definition.cwd,
      };

      if (input.run_in_background ?? definition.background ?? false) {
        const backgroundTask = await options.launchBackgroundAgent(
          resolvedSubagent,
          taskPrompt,
          {
            parentRunId: context.runId,
            parentSessionId: context.sessionId,
          },
          inheritedOptions,
          delegation,
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
          agentId: backgroundTask.sessionId,
          outputFile: backgroundTask.outputFile,
          canReadOutputFile: true,
          description: taskLabel,
          worktreePath: backgroundTask.worktreePath,
          worktreeBranch: backgroundTask.worktreeBranch,
        };
      }

      const delegated = await options.runAgent(
        resolvedSubagent,
        taskPrompt,
        inheritedOptions,
        delegation,
      );
      const result = delegated.result;
      const toolErrorCount = result.toolCalls.filter(call => call.isError).length;
      options.onDelegated?.({
        subagentType: resolvedSubagent,
        description: taskLabel,
        parentRunId: context.runId,
        parentSessionId: context.sessionId,
        runId: result.runId,
        sessionId: delegated.sessionId ?? result.sessionId,
        status: 'completed',
        requestCount: result.requests.length,
        toolCallCount: result.toolCalls.length,
        toolErrorCount,
        textSummary: result.text,
      });
      return {
        status: 'completed',
        subagentType: resolvedSubagent,
        runId: result.runId,
        sessionId: delegated.sessionId ?? result.sessionId,
        agentId: delegated.sessionId ?? result.sessionId,
        model: result.model,
        text: result.text,
        toolCallCount: result.toolCalls.length,
        toolErrorCount,
        worktreePath: delegated.worktreePath,
        worktreeBranch: delegated.worktreeBranch,
      };
    },
  );
}

function getActoviqRunToolState(metadata: Record<string, unknown>): ActoviqRunToolState {
  const existing = metadata[ACTOVIQ_RUN_STATE_KEY];
  if (
    typeof existing === 'object' &&
    existing !== null &&
    'subagentFanout' in existing &&
    typeof existing.subagentFanout === 'number'
  ) {
    return existing as ActoviqRunToolState;
  }
  const created = createActoviqRunToolState();
  metadata[ACTOVIQ_RUN_STATE_KEY] = created;
  return created;
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
    'Launch a new agent to handle complex, multi-step tasks autonomously.',
    '',
    'The Agent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it. Delegate proactively whenever independent investigation, review, debugging, parallel exploration, or verification would materially help — do not wait for the user to ask you to use an agent.',
    '',
    '## When to use Agent',
    '- Multi-file regressions, independent failure paths, audits/reviews, confusing test failures, and risky changes that need a second focused pass.',
    '- Open-ended searches or research that may take several rounds of exploration and would otherwise fill your context with intermediate output. If research can be broken into independent questions, launch parallel agents in a single message.',
    '- Implementation work that requires several edits across multiple files — an agent can stay focused on the task while you continue with other work.',
    '- Verification of non-trivial changes (3+ file edits, backend/API changes) — spawn an agent to independently confirm correctness before reporting completion.',
    '- Any task where you find yourself thinking "it would help to have someone else look at this" or "this would benefit from focused attention without distractions."',
    '',
    '## When NOT to use Agent',
    '- Reading a specific known file path or doing a simple 2-3 file lookup — use Read/Glob/Grep directly; they are faster.',
    '- Trivial single-file edits or one-line fixes.',
    '- Tasks that take less than 2 trivial steps to complete.',
    '- If you already have a running or recently completed agent for the same work, use SendMessage to continue it instead of spawning a new one.',
    '',
    '## Writing the prompt',
    'The agent starts with zero context. Brief it like a smart colleague who just walked into the room — it hasn\'t seen this conversation, doesn\'t know what you\'ve tried, doesn\'t understand why this task matters.',
    '- Explain what you\'re trying to accomplish and why.',
    '- Describe what you\'ve already learned or ruled out.',
    '- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.',
    '- If you need a short response, say so explicitly.',
    '- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.',
    '- Terse command-style prompts produce shallow, generic work.',
    '',
    '**Never delegate understanding.** Don\'t write prompts like "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.',
    '',
    '## Foreground vs background',
    '- Use foreground (default) when you need the agent\'s results before you can proceed — e.g., research agents whose findings inform your next steps.',
    '- Use background (`run_in_background: true`) when you have genuinely independent work to do in parallel. You will be automatically notified when a background agent completes — do not sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.',
    '',
    '## Parallel agents',
    'Launch multiple agents concurrently by sending a single message with multiple Agent tool calls. This maximizes throughput for independent subtasks. When the user asks you to run things "in parallel," send a single message with multiple Agent tool use blocks.',
    '',
    '## Continuing agents',
    '- Use SendMessage with the agent\'s id or assigned name to continue a previously spawned agent. The agent resumes with its full context preserved.',
    '- Each fresh Agent invocation starts without context — provide a complete task description.',
    '',
    '## Isolation',
    'Use `isolation: "worktree"` when parallel agents may edit overlapping repository files. A worktree gives the agent an isolated copy of the repo. Changed worktrees are retained; unchanged ones are removed automatically.',
    '',
    '## After the agent finishes',
    '- The agent returns a single final message. Its intermediate work is invisible to you.',
    '- Trust the agent\'s output but verify critical claims.',
    '- Summarize the agent\'s result for the user — don\'t just relay raw output.',
    '- Do not duplicate work the agent already did. If you delegated research to an agent, don\'t perform the same searches yourself.',
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
    effort?: AgentRunOptions['effort'];
    metadata?: Record<string, unknown>;
  },
  delegation: {
    depth: number;
    allowedAgents?: string[];
    model?: string;
  },
): AgentRunOptions | undefined {
  const inheritedMetadata = { ...(context.metadata ?? {}) };
  delete inheritedMetadata[ACTOVIQ_RUN_STATE_KEY];
  return {
    permissionMode: context.permissionMode,
    permissions: context.permissions,
    classifier: context.classifier,
    approver: context.approver,
    hooks: context.hooks,
    effort: context.effort,
    model: delegation.model,
    metadata: {
      ...inheritedMetadata,
      __actoviqAgentDepth: delegation.depth,
      ...(delegation.allowedAgents
        ? { __actoviqAllowedAgents: [...delegation.allowedAgents] }
        : {}),
    },
  };
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) {
    return undefined;
  }
  return [...value];
}
