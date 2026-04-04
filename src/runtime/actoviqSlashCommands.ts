import type {
  ActoviqAgentDefinitionSummary,
  ActoviqCleanContextOverview,
  ActoviqCleanContextOverviewOptions,
  ActoviqCleanSlashCommandMetadata,
  ActoviqCleanSlashCommandName,
  ActoviqCleanToolLookupOptions,
  ActoviqCleanToolMetadata,
  ActoviqDreamRunResult,
  ActoviqMemoryState,
  ActoviqRunSlashCommandOptions,
  ActoviqRunSlashCommandResult,
  ActoviqSessionCompactResult,
  ActoviqSkillDefinitionSummary,
  AgentSessionCompactOptions,
} from '../types.js';

const CLEAN_SLASH_COMMANDS: ActoviqCleanSlashCommandMetadata[] = [
  {
    name: 'context',
    helper: 'context.overview',
    description: 'Summarize the current clean SDK context surface in a command-style response.',
  },
  {
    name: 'compact',
    helper: 'context.compact',
    description: 'Compact a stored clean SDK session without bridge mode.',
  },
  {
    name: 'memory',
    helper: 'context.memoryState',
    description: 'Inspect project and session memory state through clean SDK helpers.',
  },
  {
    name: 'dream',
    helper: 'context.dream',
    description: 'Run the clean dream-memory consolidation flow without bridge mode.',
  },
  {
    name: 'tools',
    helper: 'context.tools',
    description: 'List clean SDK tools, including local, MCP, task, and computer-use tools.',
  },
  {
    name: 'skills',
    helper: 'context.skills',
    description: 'List the currently available clean SDK skills.',
  },
  {
    name: 'agents',
    helper: 'context.agents',
    description: 'List the currently registered clean SDK agents.',
  },
];

interface ActoviqContextBindings {
  getOverview: (options?: ActoviqCleanContextOverviewOptions) => Promise<ActoviqCleanContextOverview>;
  compactSession: (
    sessionId: string,
    options?: AgentSessionCompactOptions,
  ) => Promise<ActoviqSessionCompactResult>;
  getMemoryState: (
    sessionId?: string,
    options?: ActoviqRunSlashCommandOptions['memory'],
  ) => Promise<ActoviqMemoryState>;
  runDream: (
    sessionId?: string,
    options?: ActoviqRunSlashCommandOptions['dream'],
  ) => Promise<ActoviqDreamRunResult>;
  getToolMetadata: (options?: ActoviqCleanToolLookupOptions) => Promise<ActoviqCleanToolMetadata[]>;
  getSkillMetadata: () => ActoviqSkillDefinitionSummary[];
  getAgentMetadata: () => ActoviqAgentDefinitionSummary[];
}

export class ActoviqContextApi {
  constructor(private readonly bindings: ActoviqContextBindings) {}

  overview(options: ActoviqCleanContextOverviewOptions = {}): Promise<ActoviqCleanContextOverview> {
    return this.bindings.getOverview(options);
  }

  async describe(options: ActoviqCleanContextOverviewOptions = {}): Promise<string> {
    return formatActoviqContextOverview(await this.overview(options));
  }

  compact(
    sessionId: string,
    options: AgentSessionCompactOptions = {},
  ): Promise<ActoviqSessionCompactResult> {
    return this.bindings.compactSession(sessionId, options);
  }

  memoryState(
    sessionId?: string,
    options: ActoviqRunSlashCommandOptions['memory'] = {},
  ): Promise<ActoviqMemoryState> {
    return this.bindings.getMemoryState(sessionId, options);
  }

  dream(
    sessionId?: string,
    options: ActoviqRunSlashCommandOptions['dream'] = {},
  ): Promise<ActoviqDreamRunResult> {
    return this.bindings.runDream(sessionId, options);
  }

  tools(options?: ActoviqCleanToolLookupOptions): Promise<ActoviqCleanToolMetadata[]> {
    return this.bindings.getToolMetadata(options);
  }

  skills(): ActoviqSkillDefinitionSummary[] {
    return this.bindings.getSkillMetadata();
  }

  agents(): ActoviqAgentDefinitionSummary[] {
    return this.bindings.getAgentMetadata();
  }
}

export class ActoviqSlashCommandHandle {
  constructor(
    private readonly api: ActoviqSlashCommandsApi,
    readonly name: ActoviqCleanSlashCommandName,
  ) {}

  run(options: ActoviqRunSlashCommandOptions = {}): Promise<ActoviqRunSlashCommandResult> {
    return this.api.run(this.name, options);
  }
}

export class ActoviqSlashCommandsApi {
  constructor(private readonly context: ActoviqContextApi) {}

  list(): ActoviqCleanSlashCommandMetadata[] {
    return [...CLEAN_SLASH_COMMANDS];
  }

  listMetadata(): ActoviqCleanSlashCommandMetadata[] {
    return this.list();
  }

  getMetadata(
    name: string,
  ): ActoviqCleanSlashCommandMetadata | undefined {
    const normalized = normalizeCommandName(name);
    return CLEAN_SLASH_COMMANDS.find(command => command.name === normalized);
  }

  use(name: ActoviqCleanSlashCommandName): ActoviqSlashCommandHandle {
    return new ActoviqSlashCommandHandle(this, name);
  }

  async run(
    name: ActoviqCleanSlashCommandName | string,
    options: ActoviqRunSlashCommandOptions = {},
  ): Promise<ActoviqRunSlashCommandResult> {
    const normalized = normalizeCommandName(name);
    switch (normalized) {
      case 'context': {
        const data = await this.context.overview(options.overview ?? {});
        return {
          name: normalized,
          data,
          text: formatActoviqContextOverview(data),
        };
      }
      case 'compact': {
        if (!options.sessionId) {
          throw new Error('The clean /compact replacement requires a sessionId.');
        }
        const data = await this.context.compact(options.sessionId, {
          ...options.compact,
          summaryInstructions: options.args || options.compact?.summaryInstructions,
        });
        return {
          name: normalized,
          data,
          text: formatActoviqCompactResult(data),
        };
      }
      case 'memory': {
        const data = await this.context.memoryState(options.sessionId, options.memory);
        return {
          name: normalized,
          data,
          text: formatActoviqMemoryState(data),
        };
      }
      case 'dream': {
        const data = await this.context.dream(options.sessionId, {
          ...options.dream,
          currentSessionId: options.sessionId ?? options.dream?.currentSessionId,
          extraContext: options.args || options.dream?.extraContext,
        });
        return {
          name: normalized,
          data,
          text: formatActoviqDreamResult(data),
        };
      }
      case 'tools': {
        const data = await this.context.tools(options.toolLookup);
        return {
          name: normalized,
          data,
          text: formatActoviqTools(data),
        };
      }
      case 'skills': {
        const data = this.context.skills();
        return {
          name: normalized,
          data,
          text: formatActoviqSkills(data),
        };
      }
      case 'agents': {
        const data = this.context.agents();
        return {
          name: normalized,
          data,
          text: formatActoviqAgents(data),
        };
      }
      default:
        throw new Error(`Unsupported clean slash command replacement: ${name}`);
    }
  }
}

export function formatActoviqContextOverview(
  overview: ActoviqCleanContextOverview,
): string {
  const lines = [
    '# Clean Context Overview',
    '',
    `Session: ${overview.sessionId ?? 'none'}`,
    `Tools: ${overview.tools.length}`,
    `Skills: ${overview.skills.length}`,
    `Agents: ${overview.agents.length}`,
  ];

  if (overview.memoryState) {
    lines.push(
      `Memory: autoCompact=${overview.memoryState.enabled.autoCompact ? 'on' : 'off'}, autoMemory=${overview.memoryState.enabled.autoMemory ? 'on' : 'off'}, autoDream=${overview.memoryState.enabled.autoDream ? 'on' : 'off'}`,
    );
  }

  if (overview.compactState) {
    lines.push(
      `Compact: compactCount=${overview.compactState.compactCount}, microcompactCount=${overview.compactState.microcompactCount}, pendingPostCompaction=${overview.compactState.pendingPostCompaction ? 'yes' : 'no'}`,
    );
  }

  return lines.join('\n');
}

export function formatActoviqCompactResult(result: ActoviqSessionCompactResult): string {
  return [
    '# Compact Result',
    '',
    `Compacted: ${result.compacted ? 'yes' : 'no'}`,
    `Trigger: ${result.trigger}`,
    `Reason: ${result.reason}`,
    `Before: ${result.tokenEstimateBefore}`,
    result.tokenEstimateAfter != null ? `After: ${result.tokenEstimateAfter}` : undefined,
    result.summaryMessage ? `Summary: ${result.summaryMessage}` : undefined,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

export function formatActoviqMemoryState(state: ActoviqMemoryState): string {
  return [
    '# Memory State',
    '',
    `Project path: ${state.paths.projectPath}`,
    `Auto memory dir: ${state.paths.autoMemoryDir}`,
    `Session memory path: ${state.paths.sessionMemoryPath ?? 'none'}`,
    `Auto compact: ${state.enabled.autoCompact ? 'on' : 'off'}`,
    `Auto memory: ${state.enabled.autoMemory ? 'on' : 'off'}`,
    `Auto dream: ${state.enabled.autoDream ? 'on' : 'off'}`,
    state.sessionMemory
      ? `Session memory exists: ${state.sessionMemory.exists ? 'yes' : 'no'}`
      : undefined,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

export function formatActoviqDreamResult(result: ActoviqDreamRunResult): string {
  return [
    '# Dream Result',
    '',
    `Trigger: ${result.trigger}`,
    `Skipped: ${result.skipped ? 'yes' : 'no'}`,
    result.reason ? `Reason: ${result.reason}` : undefined,
    `Touched sessions: ${result.touchedSessions.length}`,
    `Touched files: ${result.touchedFiles.length}`,
    result.task ? `Background task: ${result.task.id}` : undefined,
    result.result?.text ? `Summary: ${result.result.text}` : undefined,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
}

export function formatActoviqTools(tools: readonly ActoviqCleanToolMetadata[]): string {
  return [
    '# Tools',
    '',
    ...tools.map(tool => {
      const flags = [
        tool.category,
        tool.provider,
        tool.server ? `server=${tool.server}` : undefined,
        tool.readOnly ? 'read-only' : undefined,
        tool.mutating ? 'mutating' : undefined,
      ]
        .filter((value): value is string => typeof value === 'string')
        .join(', ');
      return `- ${tool.name}: ${tool.description} (${flags})`;
    }),
  ].join('\n');
}

export function formatActoviqSkills(skills: readonly ActoviqSkillDefinitionSummary[]): string {
  return [
    '# Skills',
    '',
    ...skills.map(skill => `- ${skill.name}: ${skill.description}`),
  ].join('\n');
}

export function formatActoviqAgents(agents: readonly ActoviqAgentDefinitionSummary[]): string {
  return [
    '# Agents',
    '',
    ...agents.map(agent => `- ${agent.name}: ${agent.description}`),
  ].join('\n');
}

function normalizeCommandName(name: string): ActoviqCleanSlashCommandName {
  return name.trim().replace(/^\/+/u, '') as ActoviqCleanSlashCommandName;
}
