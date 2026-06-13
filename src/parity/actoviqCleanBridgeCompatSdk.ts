import { randomUUID } from 'node:crypto';

import type { MessageParam } from '../provider/types.js';
import type {
  ActoviqAgentMetadata,
  ActoviqAgentDefinition,
  ActoviqAgentSummary,
  ActoviqBridgeAgentRunOptions,
  ActoviqBridgeAgentSessionOptions,
  ActoviqBridgeCapabilityLookupOptions,
  ActoviqBridgeJsonEvent,
  ActoviqBridgePermissionMode,
  ActoviqBridgeRunOptions,
  ActoviqBridgeRunResult,
  ActoviqBridgeSessionCreateOptions,
  ActoviqBridgeSkillRunOptions,
  ActoviqBridgeToolsOption,
  ActoviqCleanBridgeCompatibilityReport,
  ActoviqCleanBridgeParityMatrixEntry,
  ActoviqCleanBridgeUnsupportedOption,
  ActoviqCleanBridgeUnsupportedOptionPolicy,
  ActoviqContextUsage,
  ActoviqPermissionMode,
  ActoviqPermissionRule,
  ActoviqRuntimeCatalog,
  ActoviqRuntimeInfo,
  ActoviqSkillMetadata,
  ActoviqSlashCommandMetadata,
  ActoviqToolMetadata,
  AgentEvent,
  AgentMcpServerDefinition,
  AgentRunOptions,
  AgentRunResult,
  AgentToolDefinition,
  CreateActoviqBridgeSdkOptions,
  CreateActoviqCleanBridgeSdkOptions,
  SessionCreateOptions,
} from '../types.js';
import type { ActoviqBridgeCompactBoundaryLookupOptions, ActoviqBridgeSessionMessagesOptions } from './actoviqTranscripts.js';
import { createAgentSdk, type ActoviqAgentClient } from '../runtime/agentClient.js';
import { AgentRunStream, AsyncQueue } from '../runtime/asyncQueue.js';
import { extractTextFromContent } from '../runtime/messageUtils.js';
import { asError, isRecord, nowIso } from '../runtime/helpers.js';
import type { AgentSession } from '../runtime/agentSession.js';
import { mergeActoviqHooks } from '../hooks/actoviqHooks.js';

type InternalBridgeCleanRunOptions = AgentRunOptions & {
  __actoviqUseDefaultTools?: boolean;
  __actoviqUseDefaultMcpServers?: boolean;
};

interface BridgeRunPlan {
  bridgeOptions: ActoviqBridgeRunOptions;
  cleanOptions: InternalBridgeCleanRunOptions;
  report: ActoviqCleanBridgeCompatibilityReport;
}

interface CleanBridgeResultContext {
  prompt?: string;
  sessionId?: string;
  bridgeOptions: ActoviqBridgeRunOptions;
  report: ActoviqCleanBridgeCompatibilityReport;
  events?: ActoviqBridgeJsonEvent[];
  startedAt?: string;
}

const BRIDGE_OPTION_MATRIX: ActoviqCleanBridgeParityMatrixEntry[] = [
  { option: 'executable', status: 'unsupported', notes: 'CLI executable selection has no clean runtime equivalent.' },
  { option: 'cliPath', status: 'unsupported', notes: 'CLI path selection is bridge-only.' },
  { option: 'homeDir', status: 'mapped', cleanTarget: 'CreateAgentSdkOptions.homeDir', notes: 'Mapped at client creation.' },
  { option: 'workDir', status: 'mapped', cleanTarget: 'CreateAgentSdkOptions.workDir', notes: 'Mapped at client creation; per-run changes are reported as unsupported.' },
  { option: 'model', status: 'exact', cleanTarget: 'AgentRunOptions.model', notes: 'Passed through to clean runs.' },
  { option: 'fallbackModel', status: 'unsupported', notes: 'Clean model API does not expose fallback model selection.' },
  { option: 'effort', status: 'exact', cleanTarget: 'AgentRunOptions.effort', notes: 'Passed through to clean runs.' },
  { option: 'systemPrompt', status: 'exact', cleanTarget: 'AgentRunOptions.systemPrompt', notes: 'Passed through to clean runs.' },
  { option: 'appendSystemPrompt', status: 'mapped', cleanTarget: 'AgentRunOptions.systemPrompt', notes: 'Appended to systemPrompt text before the clean run.' },
  { option: 'permissionMode', status: 'mapped', cleanTarget: 'AgentRunOptions.permissionMode', notes: 'Bridge modes are translated to the closest clean permission mode.' },
  { option: 'dangerouslySkipPermissions', status: 'mapped', cleanTarget: 'AgentRunOptions.permissionMode', notes: 'true maps to bypassPermissions; bridge-compatible default is bypassPermissions.' },
  { option: 'maxTurns', status: 'simulated', cleanTarget: 'CreateAgentSdkOptions.maxToolIterations', notes: 'Bridge defaults can map at client creation; per-run maxTurns is reported as unsupported.' },
  { option: 'maxBudgetUsd', status: 'unsupported', notes: 'Clean runtime does not meter or stop by USD budget.' },
  { option: 'agent', status: 'exact', cleanTarget: 'runWithAgent/createAgentSession', notes: 'Passed to clean agent helpers.' },
  { option: 'agents', status: 'unsupported', notes: 'Bridge accepts raw CLI agent config; clean requires typed ActoviqAgentDefinition values at creation.' },
  { option: 'tools', status: 'mapped', cleanTarget: 'AgentRunOptions.tools / __actoviqUseDefaultTools', notes: 'none disables defaults; string arrays filter known clean default tools.' },
  { option: 'allowedTools', status: 'mapped', cleanTarget: 'AgentRunOptions.canUseTool', notes: 'Converted to a clean canUseTool allowlist.' },
  { option: 'disallowedTools', status: 'mapped', cleanTarget: 'AgentRunOptions.canUseTool', notes: 'Converted to a clean canUseTool denylist.' },
  { option: 'addDirs', status: 'unsupported', notes: 'Clean tools use their configured cwd; bridge add-dir is CLI-only.' },
  { option: 'mcpConfigs', status: 'mapped', cleanTarget: 'AgentRunOptions.mcpServers', notes: 'JSON MCP config objects are converted when they match supported clean MCP shapes.' },
  { option: 'strictMcpConfig', status: 'simulated', cleanTarget: 'mcpConfigs converter', notes: 'Unsupported MCP entries throw only when strictMcpConfig is true.' },
  { option: 'settings', status: 'unsupported', notes: 'Bridge runtime settings JSON is not consumed by clean runs.' },
  { option: 'settingSources', status: 'unsupported', notes: 'Bridge setting-source selection is CLI-only.' },
  { option: 'jsonSchema', status: 'unsupported', notes: 'Clean model request has no structured output schema field.' },
  { option: 'files', status: 'unsupported', notes: 'Bridge file attachment flags are CLI-only in this facade.' },
  { option: 'bare', status: 'unsupported', notes: 'Bridge bare prompt mode is CLI-only.' },
  { option: 'disableSlashCommands', status: 'simulated', notes: 'The facade avoids slash-command shortcuts when this is true.' },
  { option: 'includePartialMessages', status: 'exact', cleanTarget: 'bridge-compatible event adapter', notes: 'Controls text-delta event emission.' },
  { option: 'includeHookEvents', status: 'mapped', cleanTarget: 'bridge-compatible event adapter', notes: 'Includes permission, compact, and error hook-like events.' },
  { option: 'verbose', status: 'simulated', notes: 'Bridge always invokes verbose stream JSON; clean event detail is controlled by include* flags.' },
  { option: 'pluginDirs', status: 'unsupported', notes: 'Clean skills/plugins are loaded through typed skill directories, not bridge plugin dirs.' },
  { option: 'env', status: 'unsupported', notes: 'There is no child process environment in clean runs.' },
  { option: 'cliArgs', status: 'unsupported', notes: 'Raw CLI args are bridge-only.' },
  { option: 'sessionId', status: 'exact', cleanTarget: 'createSession/resumeSession', notes: 'Used for clean session creation and resume paths.' },
  { option: 'resume', status: 'mapped', cleanTarget: 'resumeSession', notes: 'String resumes a clean session; true resumes the most recent clean session.' },
  { option: 'continueMostRecent', status: 'mapped', cleanTarget: 'sessions.list()[0]', notes: 'Resumes the most recent clean session by last activity.' },
  { option: 'forkSession', status: 'mapped', cleanTarget: 'AgentSession.fork()', notes: 'Forks a clean session before running.' },
  { option: 'name', status: 'mapped', cleanTarget: 'SessionCreateOptions.title', notes: 'Used as a clean session title when a new session is created.' },
  { option: 'signal', status: 'exact', cleanTarget: 'AgentRunOptions.signal', notes: 'Passed through to clean runs.' },
];

const BRIDGE_ONLY_OPTIONS = new Set([
  'executable',
  'cliPath',
  'fallbackModel',
  'maxBudgetUsd',
  'agents',
  'addDirs',
  'settings',
  'settingSources',
  'jsonSchema',
  'files',
  'bare',
  'pluginDirs',
  'env',
  'cliArgs',
]);

const CLEAN_SLASH_COMMANDS = new Set(['context', 'compact', 'memory', 'dream', 'tools', 'skills', 'agents']);

export function getActoviqCleanBridgeParityMatrix(): ActoviqCleanBridgeParityMatrixEntry[] {
  return BRIDGE_OPTION_MATRIX.map(entry => ({ ...entry }));
}

export class ActoviqCleanBridgeRunStream implements AsyncIterable<ActoviqBridgeJsonEvent> {
  private readonly queue = new AsyncQueue<ActoviqBridgeJsonEvent>();
  readonly result: Promise<ActoviqBridgeRunResult>;

  constructor(
    executor: (controller: {
      emit: (event: ActoviqBridgeJsonEvent) => void;
      fail: (error: unknown) => void;
      close: () => void;
    }) => Promise<ActoviqBridgeRunResult>,
  ) {
    this.result = (async () => {
      try {
        return await executor({
          emit: event => this.queue.push(event),
          fail: error => this.queue.fail(error),
          close: () => this.queue.close(),
        });
      } catch (error) {
        this.queue.fail(error);
        throw error;
      } finally {
        this.queue.close();
      }
    })();
  }

  [Symbol.asyncIterator](): AsyncIterator<ActoviqBridgeJsonEvent> {
    return this.queue[Symbol.asyncIterator]();
  }
}

export class ActoviqCleanBridgeSession {
  constructor(
    private readonly client: ActoviqCleanBridgeSdkClient,
    private readonly session: AgentSession,
    readonly title: string | undefined,
    private readonly defaults: ActoviqBridgeSessionCreateOptions,
  ) {}

  get id(): string {
    return this.session.id;
  }

  async send(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.client.runInCleanSession(this.session, prompt, {
      ...this.defaults,
      ...options,
    });
  }

  stream(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): ActoviqCleanBridgeRunStream {
    return this.client.streamInCleanSession(this.session, prompt, {
      ...this.defaults,
      ...options,
    });
  }

  runSlashCommand(
    commandName: string,
    args = '',
    options: ActoviqBridgeRunOptions = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.client.runSlashCommand(commandName, args, {
      ...this.defaults,
      ...options,
      sessionId: this.id,
    });
  }

  runSkill(
    skill: string,
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.client.runSkillInCleanSession(this.session, skill, args, {
      ...this.defaults,
      ...options,
    });
  }

  streamSlashCommand(
    commandName: string,
    args = '',
    options: ActoviqBridgeRunOptions = {},
  ): ActoviqCleanBridgeRunStream {
    return this.client.streamSlashCommand(commandName, args, {
      ...this.defaults,
      ...options,
      sessionId: this.id,
    });
  }

  streamSkill(
    skill: string,
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): ActoviqCleanBridgeRunStream {
    return this.client.streamSkillInCleanSession(this.session, skill, args, {
      ...this.defaults,
      ...options,
    });
  }

  compact(
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.client.compactContext(args, {
      ...this.defaults,
      ...options,
      sessionId: this.id,
    });
  }

  info() {
    return this.client.getCleanBridgeSessionInfo(this.id);
  }

  messages(options: ActoviqBridgeSessionMessagesOptions = {}) {
    return this.client.getCleanBridgeSessionMessages(this.id, options);
  }

  compactBoundaries(options: ActoviqBridgeCompactBoundaryLookupOptions = {}) {
    return this.client.getCleanBridgeCompactBoundaries(this.id, options);
  }

  latestCompactBoundary(options: ActoviqBridgeCompactBoundaryLookupOptions = {}) {
    return this.client.getCleanBridgeLatestCompactBoundary(this.id, options);
  }

  compactState(options: Omit<import('../types.js').ActoviqCompactStateOptions, 'sessionId' | 'projectPath'> = {}) {
    return this.session.compactState(options);
  }

  async fork(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    const forked = await this.session.fork({ title: options.name ?? this.title });
    return this.client.runInCleanSession(forked, prompt, {
      ...this.defaults,
      ...options,
      forkSession: true,
    });
  }

  forkStream(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ): ActoviqCleanBridgeRunStream {
    return new ActoviqCleanBridgeRunStream(async () => {
      const forked = await this.session.fork({ title: options.name ?? this.title });
      return this.client.streamInCleanSession(forked, prompt, {
        ...this.defaults,
        ...options,
        forkSession: true,
      }).result;
    });
  }
}

export class ActoviqCleanBridgeAgentHandle {
  constructor(
    private readonly client: ActoviqCleanBridgeSdkClient,
    readonly agent: string,
    private readonly defaults: ActoviqBridgeAgentRunOptions = {},
  ) {}

  run(prompt: string, options: ActoviqBridgeAgentRunOptions = {}) {
    return this.client.runWithAgent(this.agent, prompt, { ...this.defaults, ...options });
  }

  stream(prompt: string, options: ActoviqBridgeAgentRunOptions = {}) {
    return this.client.streamWithAgent(this.agent, prompt, { ...this.defaults, ...options });
  }

  createSession(options: ActoviqBridgeAgentSessionOptions = {}) {
    return this.client.createAgentSession(this.agent, { ...this.defaults, ...options });
  }
}

export class ActoviqCleanBridgeSkillHandle {
  constructor(
    private readonly client: ActoviqCleanBridgeSdkClient,
    readonly skill: string,
    private readonly defaults: ActoviqBridgeSkillRunOptions = {},
  ) {}

  run(args = '', options: ActoviqBridgeSkillRunOptions = {}) {
    return this.client.runSkill(this.skill, args, { ...this.defaults, ...options });
  }

  stream(args = '', options: ActoviqBridgeSkillRunOptions = {}) {
    return this.client.streamSkill(this.skill, args, { ...this.defaults, ...options });
  }

  runInSession(
    session: ActoviqCleanBridgeSession,
    args = '',
    options: Omit<ActoviqBridgeSkillRunOptions, 'resume' | 'sessionId'> = {},
  ) {
    return session.runSkill(this.skill, args, options);
  }

  streamInSession(
    session: ActoviqCleanBridgeSession,
    args = '',
    options: Omit<ActoviqBridgeSkillRunOptions, 'resume' | 'sessionId'> = {},
  ) {
    return session.streamSkill(this.skill, args, options);
  }

  metadata(options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.getSkillMetadata(this.skill, options);
  }
}

export class ActoviqCleanBridgeAgentsApi {
  constructor(private readonly client: ActoviqCleanBridgeSdkClient) {}

  list() {
    return this.client.listAgents();
  }

  use(agent: string, defaults: ActoviqBridgeAgentRunOptions = {}) {
    return new ActoviqCleanBridgeAgentHandle(this.client, agent, defaults);
  }

  run(agent: string, prompt: string, options: ActoviqBridgeAgentRunOptions = {}) {
    return this.client.runWithAgent(agent, prompt, options);
  }

  stream(agent: string, prompt: string, options: ActoviqBridgeAgentRunOptions = {}) {
    return this.client.streamWithAgent(agent, prompt, options);
  }

  createSession(agent: string, options: ActoviqBridgeAgentSessionOptions = {}) {
    return this.client.createAgentSession(agent, options);
  }
}

export class ActoviqCleanBridgeSkillsApi {
  constructor(private readonly client: ActoviqCleanBridgeSdkClient) {}

  list() {
    return this.client.listSkills();
  }

  use(skill: string, defaults: ActoviqBridgeSkillRunOptions = {}) {
    return new ActoviqCleanBridgeSkillHandle(this.client, skill, defaults);
  }

  run(skill: string, args = '', options: ActoviqBridgeSkillRunOptions = {}) {
    return this.client.runSkill(skill, args, options);
  }

  stream(skill: string, args = '', options: ActoviqBridgeSkillRunOptions = {}) {
    return this.client.streamSkill(skill, args, options);
  }

  listMetadata(options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.listSkillMetadata(options);
  }

  getMetadata(skill: string, options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.getSkillMetadata(skill, options);
  }
}

export class ActoviqCleanBridgeToolsApi {
  constructor(private readonly client: ActoviqCleanBridgeSdkClient) {}

  list(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.listTools(options);
  }

  listMetadata(options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.listToolMetadata(options);
  }

  getMetadata(toolName: string, options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.getToolMetadata(toolName, options);
  }
}

export class ActoviqCleanBridgeSlashCommandsApi {
  constructor(private readonly client: ActoviqCleanBridgeSdkClient) {}

  list(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.listSlashCommands(options);
  }

  listMetadata(options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.listSlashCommandMetadata(options);
  }

  getMetadata(commandName: string, options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.getSlashCommandMetadata(commandName, options);
  }

  run(
    commandName: string,
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ) {
    return this.client.runSlashCommand(commandName, args, options);
  }

  stream(
    commandName: string,
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ) {
    return this.client.streamSlashCommand(commandName, args, options);
  }
}

export class ActoviqCleanBridgeContextApi {
  constructor(private readonly client: ActoviqCleanBridgeSdkClient) {}

  usage(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.getContextUsage(options);
  }

  compact(
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ) {
    return this.client.compactContext(args, options);
  }

  streamCompact(
    args = '',
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {},
  ) {
    return this.client.streamSlashCommand('compact', args, options);
  }

  compactBoundaries(sessionId: string, options: ActoviqBridgeCompactBoundaryLookupOptions = {}) {
    return this.client.getCleanBridgeCompactBoundaries(sessionId, options);
  }

  latestCompactBoundary(sessionId: string, options: ActoviqBridgeCompactBoundaryLookupOptions = {}) {
    return this.client.getCleanBridgeLatestCompactBoundary(sessionId, options);
  }

  compactState(
    sessionId: string,
    options: Omit<import('../types.js').ActoviqCompactStateOptions, 'sessionId' | 'projectPath'> = {},
  ) {
    return this.client.clean.sessions.get(sessionId).then(session => session.compactState(options));
  }
}

export class ActoviqCleanBridgeSessionsApi {
  constructor(private readonly client: ActoviqCleanBridgeSdkClient) {}

  list() {
    return this.client.listCleanBridgeSessions();
  }

  getInfo(sessionId: string) {
    return this.client.getCleanBridgeSessionInfo(sessionId);
  }

  getMessages(sessionId: string, options: ActoviqBridgeSessionMessagesOptions = {}) {
    return this.client.getCleanBridgeSessionMessages(sessionId, options);
  }

  getCompactBoundaries(sessionId: string, options: ActoviqBridgeCompactBoundaryLookupOptions = {}) {
    return this.client.getCleanBridgeCompactBoundaries(sessionId, options);
  }

  getLatestCompactBoundary(sessionId: string, options: ActoviqBridgeCompactBoundaryLookupOptions = {}) {
    return this.client.getCleanBridgeLatestCompactBoundary(sessionId, options);
  }

  getCompactState(
    sessionId: string,
    options: Omit<import('../types.js').ActoviqCompactStateOptions, 'sessionId' | 'projectPath'> = {},
  ) {
    return this.client.clean.sessions.get(sessionId).then(session => session.compactState(options));
  }

  resume(sessionId: string, options: Omit<ActoviqBridgeSessionCreateOptions, 'sessionId'> = {}) {
    return this.client.resumeSession(sessionId, options);
  }

  continueMostRecent(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'continueMostRecent'> = {},
  ) {
    return this.client.continueMostRecent(prompt, options);
  }

  streamContinueMostRecent(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'continueMostRecent'> = {},
  ) {
    return this.client.streamContinueMostRecent(prompt, options);
  }

  fork(
    sessionId: string,
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'forkSession'> = {},
  ) {
    return this.client.forkSession(sessionId, prompt, options);
  }

  streamFork(
    sessionId: string,
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'forkSession'> = {},
  ) {
    return this.client.streamForkSession(sessionId, prompt, options);
  }

  getRuntimeInfo(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.getRuntimeInfo(options);
  }

  listAgents() {
    return this.client.listAgents();
  }

  listSkills(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.listSkills(options);
  }

  listSlashCommands(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.listSlashCommands(options);
  }

  listTools(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.listTools(options);
  }

  getRuntimeCatalog(options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.getRuntimeCatalog(options);
  }

  listSkillMetadata(options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.listSkillMetadata(options);
  }

  listSlashCommandMetadata(options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.listSlashCommandMetadata(options);
  }

  listToolMetadata(options?: ActoviqBridgeCapabilityLookupOptions) {
    return this.client.listToolMetadata(options);
  }

  getContextUsage(options?: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'>) {
    return this.client.getContextUsage(options);
  }
}

export class ActoviqCleanBridgeSdkClient {
  readonly sessions: ActoviqCleanBridgeSessionsApi;
  readonly agents: ActoviqCleanBridgeAgentsApi;
  readonly skills: ActoviqCleanBridgeSkillsApi;
  readonly tools: ActoviqCleanBridgeToolsApi;
  readonly slashCommands: ActoviqCleanBridgeSlashCommandsApi;
  readonly context: ActoviqCleanBridgeContextApi;
  readonly buddy: ActoviqAgentClient['buddy'];
  readonly memory: ActoviqAgentClient['memory'];

  private constructor(
    readonly clean: ActoviqAgentClient,
    private readonly cleanDefaults: CreateActoviqCleanBridgeSdkOptions,
    private readonly bridgeDefaults: CreateActoviqBridgeSdkOptions,
    private readonly unsupportedOptionPolicy: ActoviqCleanBridgeUnsupportedOptionPolicy,
  ) {
    this.sessions = new ActoviqCleanBridgeSessionsApi(this);
    this.agents = new ActoviqCleanBridgeAgentsApi(this);
    this.skills = new ActoviqCleanBridgeSkillsApi(this);
    this.tools = new ActoviqCleanBridgeToolsApi(this);
    this.slashCommands = new ActoviqCleanBridgeSlashCommandsApi(this);
    this.context = new ActoviqCleanBridgeContextApi(this);
    this.buddy = clean.buddy;
    this.memory = clean.memory;
  }

  static async create(options: CreateActoviqCleanBridgeSdkOptions = {}): Promise<ActoviqCleanBridgeSdkClient> {
    const {
      bridgeDefaults = {},
      unsupportedOptionPolicy = 'metadata',
      ...cleanOptions
    } = options;
    const resolvedCleanOptions = {
      ...cleanOptions,
      effort:
        cleanOptions.effort ?? bridgeDefaults.effort,
      maxToolIterations:
        cleanOptions.maxToolIterations ?? bridgeDefaults.maxTurns,
      permissionMode:
        cleanOptions.permissionMode ?? mapBridgePermissionMode(bridgeDefaults.permissionMode, bridgeDefaults),
    };
    const clean = await createAgentSdk(resolvedCleanOptions);
    return new ActoviqCleanBridgeSdkClient(
      clean,
      options,
      bridgeDefaults,
      unsupportedOptionPolicy,
    );
  }

  parityMatrix(): ActoviqCleanBridgeParityMatrixEntry[] {
    return getActoviqCleanBridgeParityMatrix();
  }

  explainOptions(options: ActoviqBridgeRunOptions = {}): ActoviqCleanBridgeCompatibilityReport {
    return this.buildRunPlan(options).report;
  }

  async run(prompt: string, options: ActoviqBridgeRunOptions = {}): Promise<ActoviqBridgeRunResult> {
    return this.executeCleanRun(prompt, options, plan => this.clean.run(prompt, plan.cleanOptions));
  }

  stream(prompt: string, options: ActoviqBridgeRunOptions = {}): ActoviqCleanBridgeRunStream {
    return this.streamCleanRun(prompt, options, plan => this.clean.stream(prompt, plan.cleanOptions));
  }

  runSlashCommand(
    commandName: string,
    args = '',
    options: ActoviqBridgeRunOptions = {},
  ): Promise<ActoviqBridgeRunResult> {
    const normalized = normalizeCommandName(commandName);
    if (options.disableSlashCommands) {
      return this.run(formatSlashCommand(normalized, args), options);
    }
    if (normalized === 'compact') {
      return this.compactContext(args, options);
    }
    if (CLEAN_SLASH_COMMANDS.has(normalized)) {
      return this.executeCleanSlashCommand(normalized, args, options);
    }
    if (this.clean.getSkillDefinition(normalized)) {
      return this.runSkill(normalized, args, options);
    }
    return this.run(formatSlashCommand(normalized, args), options);
  }

  streamSlashCommand(
    commandName: string,
    args = '',
    options: ActoviqBridgeRunOptions = {},
  ): ActoviqCleanBridgeRunStream {
    const normalized = normalizeCommandName(commandName);
    if (!options.disableSlashCommands && normalized === 'compact') {
      return this.streamSyntheticRun(() => this.compactContext(args, options));
    }
    if (!options.disableSlashCommands && CLEAN_SLASH_COMMANDS.has(normalized)) {
      return this.streamSyntheticRun(() => this.executeCleanSlashCommand(normalized, args, options));
    }
    if (!options.disableSlashCommands && this.clean.getSkillDefinition(normalized)) {
      return this.streamSkill(normalized, args, options);
    }
    return this.stream(formatSlashCommand(normalized, args), options);
  }

  runWithAgent(
    agent: string,
    prompt: string,
    options: ActoviqBridgeAgentRunOptions = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.executeCleanRun(prompt, { ...options, agent }, plan =>
      this.clean.runWithAgent(agent, prompt, plan.cleanOptions),
    );
  }

  streamWithAgent(
    agent: string,
    prompt: string,
    options: ActoviqBridgeAgentRunOptions = {},
  ): ActoviqCleanBridgeRunStream {
    return this.streamCleanRun(prompt, { ...options, agent }, plan =>
      this.clean.stream(prompt, mergeCleanAgentRunOptions(this.requireCleanAgentDefinition(agent), plan.cleanOptions)),
    );
  }

  runSkill(
    skill: string,
    args = '',
    options: ActoviqBridgeSkillRunOptions = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.executeCleanRun(formatSlashCommand(skill, args), options, plan =>
      this.clean.runSkill(skill, args, plan.cleanOptions),
    );
  }

  streamSkill(
    skill: string,
    args = '',
    options: ActoviqBridgeSkillRunOptions = {},
  ): ActoviqCleanBridgeRunStream {
    return this.streamCleanRun(formatSlashCommand(skill, args), options, plan =>
      this.clean.streamSkill(skill, args, plan.cleanOptions),
    );
  }

  async continueMostRecent(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'continueMostRecent'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    const session = await this.resolveMostRecentSession();
    return this.runInCleanSession(session, prompt, {
      ...options,
      continueMostRecent: true,
    });
  }

  streamContinueMostRecent(
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'continueMostRecent'> = {},
  ): ActoviqCleanBridgeRunStream {
    return new ActoviqCleanBridgeRunStream(async () => {
      const session = await this.resolveMostRecentSession();
      return this.streamInCleanSession(session, prompt, {
        ...options,
        continueMostRecent: true,
      }).result;
    });
  }

  async forkSession(
    sessionId: string,
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'forkSession'> = {},
  ): Promise<ActoviqBridgeRunResult> {
    const session = await this.clean.resumeSession(sessionId);
    const forked = await session.fork({ title: options.name });
    return this.runInCleanSession(forked, prompt, {
      ...options,
      forkSession: true,
    });
  }

  streamForkSession(
    sessionId: string,
    prompt: string,
    options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId' | 'forkSession'> = {},
  ): ActoviqCleanBridgeRunStream {
    return new ActoviqCleanBridgeRunStream(async () => {
      const session = await this.clean.resumeSession(sessionId);
      const forked = await session.fork({ title: options.name });
      return this.streamInCleanSession(forked, prompt, {
        ...options,
        forkSession: true,
      }).result;
    });
  }

  async createSession(options: ActoviqBridgeSessionCreateOptions = {}): Promise<ActoviqCleanBridgeSession> {
    if (options.sessionId) {
      const existing = await this.clean.resumeSession(options.sessionId).catch(() => undefined);
      if (existing) {
        return new ActoviqCleanBridgeSession(this, existing, options.title, options);
      }
    }
    const cleanSession = await this.clean.createSession(this.toCleanSessionOptions(options, options.sessionId));
    return new ActoviqCleanBridgeSession(this, cleanSession, options.title, options);
  }

  createAgentSession(agent: string, options: Omit<ActoviqBridgeSessionCreateOptions, 'agent'> = {}) {
    return this.createSession({ ...options, agent });
  }

  useAgent(agent: string, defaults: ActoviqBridgeAgentRunOptions = {}) {
    return this.agents.use(agent, defaults);
  }

  useSkill(skill: string, defaults: ActoviqBridgeSkillRunOptions = {}) {
    return this.skills.use(skill, defaults);
  }

  async resumeSession(
    sessionId: string,
    options: Omit<ActoviqBridgeSessionCreateOptions, 'sessionId'> = {},
  ): Promise<ActoviqCleanBridgeSession> {
    const session = await this.clean.resumeSession(sessionId);
    return new ActoviqCleanBridgeSession(this, session, options.title, options);
  }

  close(): Promise<void> {
    return this.clean.close();
  }

  async getRuntimeInfo(options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {}): Promise<ActoviqRuntimeInfo> {
    const catalog = await this.getRuntimeCatalog({ ...options, includeContext: false });
    return catalog.runtime;
  }

  async listSkills(_options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {}): Promise<string[]> {
    return this.clean.skills.listMetadata().map(skill => skill.name);
  }

  async listTools(options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {}): Promise<string[]> {
    return (await this.listToolMetadata(options)).map(tool => tool.name);
  }

  async listSlashCommands(_options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {}): Promise<string[]> {
    return (await this.listSlashCommandMetadata()).map(command => command.name);
  }

  async listAgents(_options: Omit<CreateActoviqBridgeSdkOptions, 'cliArgs' | 'cliPath' | 'executable'> = {}): Promise<ActoviqAgentSummary[]> {
    return this.clean.agents.list().map(summary => ({
      name: summary.name,
      sourceGroup: 'clean',
      active: true,
      rawLine: summary.name,
      model: summary.model,
    }));
  }

  async getContextUsage(options: Omit<ActoviqBridgeRunOptions, 'resume' | 'sessionId'> = {}): Promise<ActoviqContextUsage> {
    const markdown = await this.clean.context.describe({
      includeTools: true,
      includeCompactState: false,
    });
    const rawResult = makeSyntheticBridgeResult(markdown, {
      bridgeOptions: options,
      report: this.buildRunPlan(options).report,
    });
    return {
      markdown,
      categories: [],
      skills: this.clean.skills.listMetadata().map(skill => ({
        name: skill.name,
        source: skill.source,
        tokens: 'unknown',
      })),
      agents: this.clean.agents.list().map(agent => ({
        agentType: agent.name,
        source: 'clean',
        tokens: 'unknown',
      })),
      mcpTools: (await this.clean.tools.listMetadata()).filter(tool => tool.provider === 'mcp').map(tool => ({
        tool: tool.name,
        server: tool.server ?? 'mcp',
        tokens: 'unknown',
      })),
      rawResult,
    };
  }

  async getRuntimeCatalog(options: ActoviqBridgeCapabilityLookupOptions = {}): Promise<ActoviqRuntimeCatalog> {
    const [agents, tools, skills, slashCommands] = await Promise.all([
      this.listAgents(options),
      this.listToolMetadata(options),
      this.listSkillMetadata(options),
      this.listSlashCommandMetadata(options),
    ]);
    const runtime: ActoviqRuntimeInfo = {
      sessionId: randomUUID(),
      cwd: this.cleanDefaults.workDir,
      model: options.model ?? this.cleanDefaults.model,
      permissionMode: options.permissionMode ?? this.bridgeDefaults.permissionMode ?? this.cleanDefaults.permissionMode,
      tools: tools.map(tool => tool.name),
      mcpServers: tools
        .filter(tool => tool.kind === 'mcp' && tool.server)
        .map(tool => ({ name: tool.server as string, status: 'connected' })),
      slashCommands: slashCommands.map(command => command.name),
      agents: agents.map(agent => agent.name),
      skills: skills.map(skill => skill.name),
      plugins: [],
      rawInitEvent: this.makeInitEvent({
        sessionId: undefined,
        options,
      }),
    };
    return {
      runtime,
      agents: agents.map(agent => ({ ...agent, contextSource: 'clean' } satisfies ActoviqAgentMetadata)),
      tools,
      skills,
      slashCommands,
      context: options.includeContext === false ? undefined : await this.getContextUsage(options),
    };
  }

  async listSkillMetadata(_options: ActoviqBridgeCapabilityLookupOptions = {}): Promise<ActoviqSkillMetadata[]> {
    return this.clean.skills.listMetadata().map(skill => ({
      name: skill.name,
      slashCommand: `/${skill.name}`,
      source: skill.source,
      tokens: 'unknown',
    }));
  }

  async getSkillMetadata(skillName: string, options: ActoviqBridgeCapabilityLookupOptions = {}) {
    const normalized = normalizeCommandName(skillName);
    return (await this.listSkillMetadata(options)).find(skill => skill.name === normalized);
  }

  async listToolMetadata(options: ActoviqBridgeCapabilityLookupOptions = {}): Promise<ActoviqToolMetadata[]> {
    const metadata = await this.clean.tools.listMetadata({
      tools: this.filterToolsOption(options.tools),
      mcpServers: convertMcpConfigs(options.mcpConfigs, options.strictMcpConfig).servers,
    });
    return metadata.map(tool => ({
      name: tool.name,
      kind: tool.provider === 'mcp' ? 'mcp' : 'builtin',
      server: tool.server,
      tokens: 'unknown',
    }));
  }

  async getToolMetadata(toolName: string, options: ActoviqBridgeCapabilityLookupOptions = {}) {
    return (await this.listToolMetadata(options)).find(tool => tool.name === toolName);
  }

  async listSlashCommandMetadata(_options: ActoviqBridgeCapabilityLookupOptions = {}): Promise<ActoviqSlashCommandMetadata[]> {
    const cleanCommands = this.clean.slashCommands.listMetadata().map(command => ({
      name: command.name,
      kind: 'builtin' as const,
    }));
    const skillCommands = this.clean.skills.listMetadata().map(skill => ({
      name: skill.name,
      kind: 'skill' as const,
      skillName: skill.name,
    }));
    const deduped = new Map<string, ActoviqSlashCommandMetadata>();
    for (const command of [...cleanCommands, ...skillCommands]) {
      deduped.set(command.name, command);
    }
    return [...deduped.values()];
  }

  async getSlashCommandMetadata(commandName: string, options: ActoviqBridgeCapabilityLookupOptions = {}) {
    const normalized = normalizeCommandName(commandName);
    return (await this.listSlashCommandMetadata(options)).find(command => command.name === normalized);
  }

  async compactContext(
    args = '',
    options: ActoviqBridgeRunOptions = {},
  ): Promise<ActoviqBridgeRunResult> {
    const session = await this.resolveSessionFromOptions(options);
    const compact = await session.compact({
      force: true,
      summaryInstructions: args || undefined,
    });
    return makeSyntheticBridgeResult([
      '# Compact Result',
      `Compacted: ${compact.compacted ? 'yes' : 'no'}`,
      compact.summaryMessage ? '' : undefined,
      compact.summaryMessage,
    ].filter(Boolean).join('\n'), {
      sessionId: session.id,
      bridgeOptions: options,
      report: this.buildRunPlan(options).report,
      subtype: 'success',
    });
  }

  async runInCleanSession(
    session: AgentSession,
    prompt: string,
    options: ActoviqBridgeRunOptions = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.executeCleanRun(prompt, { ...options, sessionId: session.id }, plan =>
      session.send(prompt, plan.cleanOptions),
    );
  }

  streamInCleanSession(
    session: AgentSession,
    prompt: string,
    options: ActoviqBridgeRunOptions = {},
  ): ActoviqCleanBridgeRunStream {
    return this.streamCleanRun(prompt, { ...options, sessionId: session.id }, plan =>
      session.stream(prompt, plan.cleanOptions),
    );
  }

  runSkillInCleanSession(
    session: AgentSession,
    skill: string,
    args = '',
    options: ActoviqBridgeRunOptions = {},
  ): Promise<ActoviqBridgeRunResult> {
    return this.executeCleanRun(formatSlashCommand(skill, args), { ...options, sessionId: session.id }, plan =>
      session.runSkill(skill, args, plan.cleanOptions),
    );
  }

  streamSkillInCleanSession(
    session: AgentSession,
    skill: string,
    args = '',
    options: ActoviqBridgeRunOptions = {},
  ): ActoviqCleanBridgeRunStream {
    return this.streamCleanRun(formatSlashCommand(skill, args), { ...options, sessionId: session.id }, plan =>
      session.streamSkill(skill, args, plan.cleanOptions),
    );
  }

  async listCleanBridgeSessions() {
    return this.clean.sessions.list();
  }

  async getCleanBridgeSessionInfo(sessionId: string) {
    const session = await this.clean.resumeSession(sessionId);
    const snapshot = session.snapshot();
    return {
      id: snapshot.id,
      name: snapshot.title,
      cwd: this.cleanDefaults.workDir,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      lastActivityAt: snapshot.lastActiveAt ?? snapshot.lastRunAt ?? snapshot.updatedAt,
      model: snapshot.model,
      messageCount: snapshot.messages.length,
      raw: snapshot,
    };
  }

  async getCleanBridgeSessionMessages(sessionId: string, options: ActoviqBridgeSessionMessagesOptions = {}) {
    const session = await this.clean.resumeSession(sessionId);
    return session.messages
      .map((message, index) => {
        const type = message.role === 'assistant' ? 'assistant' : 'user';
        return {
          uuid: `${sessionId}-${index}`,
          parentUuid: index > 0 ? `${sessionId}-${index - 1}` : null,
          logicalParentUuid: index > 0 ? `${sessionId}-${index - 1}` : null,
          type,
          timestamp: session.snapshot().updatedAt,
          sessionId,
          cwd: this.cleanDefaults.workDir,
          isSidechain: false,
          message,
          raw: {
            type,
            message,
          },
        };
      })
      .filter(message => options.includeSystemMessages || message.type !== 'system');
  }

  async getCleanBridgeCompactBoundaries(sessionId: string, options: ActoviqBridgeCompactBoundaryLookupOptions = {}) {
    const session = await this.clean.resumeSession(sessionId);
    const state = await session.compactState({
      ...options,
      includeBoundaries: true,
    });
    return state.boundaries ?? [];
  }

  async getCleanBridgeLatestCompactBoundary(sessionId: string, options: ActoviqBridgeCompactBoundaryLookupOptions = {}) {
    const session = await this.clean.resumeSession(sessionId);
    const state = await session.compactState({
      ...options,
      includeBoundaries: true,
    });
    return state.latestBoundary;
  }

  private async executeCleanSlashCommand(
    commandName: string,
    args: string,
    options: ActoviqBridgeRunOptions,
  ): Promise<ActoviqBridgeRunResult> {
    const result = await this.clean.slashCommands.run(commandName, {
      args,
      sessionId: options.resume && typeof options.resume === 'string' ? options.resume : options.sessionId,
    });
    return makeSyntheticBridgeResult(result.text, {
      sessionId: options.sessionId,
      bridgeOptions: options,
      report: this.buildRunPlan(options).report,
    });
  }

  private streamSyntheticRun(
    run: () => Promise<ActoviqBridgeRunResult>,
  ): ActoviqCleanBridgeRunStream {
    return new ActoviqCleanBridgeRunStream(async controller => {
      const result = await run();
      for (const event of result.events) {
        controller.emit(event);
      }
      return result;
    });
  }

  private async executeCleanRun(
    prompt: string,
    options: ActoviqBridgeRunOptions,
    runner: (plan: BridgeRunPlan) => Promise<AgentRunResult>,
  ): Promise<ActoviqBridgeRunResult> {
    const plan = this.buildRunPlan(options);
    this.handleUnsupportedOptions(plan.report.unsupported);
    const startedAt = nowIso();
    const cleanResult = await runner(plan);
    return cleanResultToBridgeResult(cleanResult, {
      prompt,
      bridgeOptions: plan.bridgeOptions,
      report: plan.report,
      startedAt,
    });
  }

  private streamCleanRun(
    prompt: string,
    options: ActoviqBridgeRunOptions,
    runner: (plan: BridgeRunPlan) => AgentRunStream,
  ): ActoviqCleanBridgeRunStream {
    return new ActoviqCleanBridgeRunStream(async controller => {
      const plan = this.buildRunPlan(options);
      this.handleUnsupportedOptions(plan.report.unsupported);
      const startedAt = nowIso();
      const bridgeEvents: ActoviqBridgeJsonEvent[] = [];
      const cleanStream = runner(plan);
      for await (const cleanEvent of cleanStream) {
        for (const bridgeEvent of cleanEventToBridgeEvents(cleanEvent, plan.bridgeOptions)) {
          bridgeEvents.push(structuredClone(bridgeEvent));
          controller.emit(bridgeEvent);
        }
      }
      const cleanResult = await cleanStream.result;
      return cleanResultToBridgeResult(cleanResult, {
        prompt,
        bridgeOptions: plan.bridgeOptions,
        report: plan.report,
        events: bridgeEvents,
        startedAt,
      });
    });
  }

  private buildRunPlan(options: ActoviqBridgeRunOptions = {}): BridgeRunPlan {
    const bridgeOptions = {
      ...this.bridgeDefaults,
      ...options,
    };
    const report: ActoviqCleanBridgeCompatibilityReport = {
      mapped: [],
      unsupported: [],
    };
    const cleanOptions: InternalBridgeCleanRunOptions = {
      model: bridgeOptions.model,
      signal: bridgeOptions.signal,
      metadata: {
        __actoviqBridgeCompatibility: report,
      },
    };

    const systemPrompt = joinPromptParts(bridgeOptions.systemPrompt, bridgeOptions.appendSystemPrompt);
    if (systemPrompt) {
      cleanOptions.systemPrompt = systemPrompt;
      report.mapped.push({ option: 'systemPrompt', cleanTarget: 'systemPrompt', status: 'exact' });
      if (bridgeOptions.appendSystemPrompt) {
        report.mapped.push({ option: 'appendSystemPrompt', cleanTarget: 'systemPrompt', status: 'mapped' });
      }
    }
    if (bridgeOptions.model) {
      report.mapped.push({ option: 'model', cleanTarget: 'model', status: 'exact' });
    }
    if (bridgeOptions.effort) {
      cleanOptions.effort = bridgeOptions.effort;
      report.mapped.push({ option: 'effort', cleanTarget: 'effort', status: 'exact' });
    }

    cleanOptions.permissionMode = mapBridgePermissionMode(bridgeOptions.permissionMode, bridgeOptions);
    report.mapped.push({
      option: 'permissionMode',
      cleanTarget: 'permissionMode',
      status: bridgeOptions.permissionMode === 'dontAsk' ? 'mapped' : 'exact',
      note: bridgeOptions.permissionMode === 'dontAsk' ? 'dontAsk maps to default in clean mode.' : undefined,
    });
    if (bridgeOptions.dangerouslySkipPermissions !== undefined) {
      report.mapped.push({
        option: 'dangerouslySkipPermissions',
        cleanTarget: 'permissionMode',
        status: 'mapped',
      });
    }

    const toolMapping = this.mapToolsOption(bridgeOptions.tools, report);
    if (toolMapping.useDefaultTools !== undefined) {
      cleanOptions.__actoviqUseDefaultTools = toolMapping.useDefaultTools;
    }
    if (toolMapping.tools) {
      cleanOptions.tools = toolMapping.tools;
    }

    const mcpMapping = convertMcpConfigs(bridgeOptions.mcpConfigs, bridgeOptions.strictMcpConfig);
    if (mcpMapping.servers.length > 0) {
      cleanOptions.mcpServers = mcpMapping.servers;
      report.mapped.push({ option: 'mcpConfigs', cleanTarget: 'mcpServers', status: 'mapped' });
    }
    for (const unsupported of mcpMapping.unsupported) {
      report.unsupported.push(unsupported);
    }

    const canUseTool = createToolFilter(bridgeOptions.allowedTools, bridgeOptions.disallowedTools);
    if (canUseTool) {
      cleanOptions.canUseTool = canUseTool;
      report.mapped.push({
        option: 'allowedTools/disallowedTools',
        cleanTarget: 'canUseTool',
        status: 'mapped',
      });
    }

    for (const option of Object.keys(bridgeOptions)) {
      if (!BRIDGE_ONLY_OPTIONS.has(option)) {
        continue;
      }
      const value = bridgeOptions[option as keyof ActoviqBridgeRunOptions];
      if (value !== undefined) {
        report.unsupported.push({
          option,
          value,
          reason: BRIDGE_OPTION_MATRIX.find(entry => entry.option === option)?.notes ?? 'No clean runtime equivalent.',
        });
      }
    }
    if (bridgeOptions.maxTurns !== undefined && bridgeOptions.maxTurns !== this.bridgeDefaults.maxTurns) {
      report.unsupported.push({
        option: 'maxTurns',
        value: bridgeOptions.maxTurns,
        reason: 'Per-run maxTurns cannot override clean maxToolIterations after client creation.',
      });
    }
    if (bridgeOptions.workDir !== undefined && bridgeOptions.workDir !== this.cleanDefaults.workDir) {
      report.unsupported.push({
        option: 'workDir',
        value: bridgeOptions.workDir,
        reason: 'Per-run workDir cannot override the clean client workDir.',
      });
    }

    return {
      bridgeOptions,
      cleanOptions,
      report,
    };
  }

  private handleUnsupportedOptions(unsupported: ActoviqCleanBridgeUnsupportedOption[]): void {
    if (unsupported.length === 0 || this.unsupportedOptionPolicy === 'metadata') {
      return;
    }
    const message = unsupported
      .map(entry => `${entry.option}: ${entry.reason}`)
      .join('; ');
    if (this.unsupportedOptionPolicy === 'throw') {
      throw new Error(`Unsupported bridge option(s) in clean compatibility mode: ${message}`);
    }
    console.warn(`Unsupported bridge option(s) in clean compatibility mode: ${message}`);
  }

  private mapToolsOption(
    tools: ActoviqBridgeToolsOption | undefined,
    report: ActoviqCleanBridgeCompatibilityReport,
  ): { useDefaultTools?: boolean; tools?: AgentToolDefinition[] } {
    if (tools === undefined || tools === 'default') {
      return {};
    }
    if (tools === 'none') {
      report.mapped.push({ option: 'tools', cleanTarget: '__actoviqUseDefaultTools', status: 'mapped' });
      return {
        useDefaultTools: false,
        tools: [],
      };
    }
    const filtered = this.filterDefaultTools(tools);
    report.mapped.push({ option: 'tools', cleanTarget: 'tools', status: 'mapped' });
    return {
      useDefaultTools: false,
      tools: filtered,
    };
  }

  private filterToolsOption(tools: ActoviqBridgeToolsOption | undefined): AgentToolDefinition[] | undefined {
    if (!Array.isArray(tools)) {
      return undefined;
    }
    return this.filterDefaultTools(tools);
  }

  private filterDefaultTools(toolNames: string[]): AgentToolDefinition[] {
    const desired = new Set(toolNames);
    return [...(this.cleanDefaults.tools ?? [])].filter(tool =>
      desired.has(tool.name) ||
      (tool.aliases ?? []).some(alias => desired.has(alias)) ||
      desired.has(tool.userFacingName?.() ?? ''),
    );
  }

  private toCleanSessionOptions(options: ActoviqBridgeSessionCreateOptions, requestedSessionId?: string): SessionCreateOptions {
    const definition = options.agent ? this.clean.getAgentDefinition(options.agent) : undefined;
    return {
      id: requestedSessionId,
      title: options.title ?? requestedSessionId ?? options.agent,
      systemPrompt: joinPromptParts(definition?.systemPrompt, options.systemPrompt, options.appendSystemPrompt),
      model: options.model ?? definition?.model,
      metadata: {
        __actoviqBridgeSession: true,
        __actoviqBridgeRequestedSessionId: requestedSessionId,
        __actoviqBridgeAgent: options.agent,
      },
    };
  }

  private requireCleanAgentDefinition(agent: string): ActoviqAgentDefinition {
    const definition = this.clean.getAgentDefinition(agent);
    if (!definition) {
      throw new Error(`Unknown clean agent definition: ${agent}`);
    }
    return definition;
  }

  private async resolveMostRecentSession(): Promise<AgentSession> {
    const [summary] = await this.clean.sessions.list();
    if (summary) {
      return this.clean.resumeSession(summary.id);
    }
    return this.clean.createSession({ title: 'Bridge-compatible session' });
  }

  private async resolveSessionFromOptions(options: Pick<ActoviqBridgeRunOptions, 'sessionId' | 'resume' | 'continueMostRecent' | 'name'>): Promise<AgentSession> {
    if (typeof options.resume === 'string') {
      return this.clean.resumeSession(options.resume);
    }
    if (options.sessionId) {
      return this.clean.resumeSession(options.sessionId).catch(() =>
        this.clean.createSession({ title: options.name ?? options.sessionId }),
      );
    }
    if (options.resume === true || options.continueMostRecent) {
      return this.resolveMostRecentSession();
    }
    return this.clean.createSession({ title: options.name ?? 'Bridge-compatible session' });
  }

  private makeInitEvent(args: {
    sessionId?: string;
    options: Partial<ActoviqBridgeRunOptions>;
  }): ActoviqBridgeJsonEvent {
    return {
      type: 'system',
      subtype: 'init',
      session_id: args.sessionId ?? '',
      cwd: this.cleanDefaults.workDir,
      model: args.options.model ?? this.cleanDefaults.model,
      permissionMode: args.options.permissionMode ?? this.bridgeDefaults.permissionMode ?? this.cleanDefaults.permissionMode,
      tools: [],
      mcp_servers: [],
      slash_commands: this.clean.slashCommands.listMetadata().map(command => command.name),
      agents: this.clean.agents.list().map(agent => agent.name),
      skills: this.clean.skills.listMetadata().map(skill => skill.name),
      plugins: [],
      bridge_compat: true,
    };
  }
}

export async function createActoviqCleanBridgeSdk(
  options: CreateActoviqCleanBridgeSdkOptions = {},
): Promise<ActoviqCleanBridgeSdkClient> {
  return ActoviqCleanBridgeSdkClient.create(options);
}

function cleanResultToBridgeResult(
  result: AgentRunResult,
  context: CleanBridgeResultContext,
): ActoviqBridgeRunResult {
  const events = context.events?.length
    ? [...context.events]
    : synthesizeBridgeEvents(result, context);
  const assistantMessages = events.filter(event => event.type === 'assistant');
  const resultEvent =
    [...events].reverse().find(event => event.type === 'result') ??
    makeResultEvent(result, context.bridgeOptions);
  const initEvent =
    events.find(event => event.type === 'system' && event.subtype === 'init') ??
    makeInitEventFromResult(result, context.bridgeOptions);
  return {
    text: result.text,
    sessionId: result.sessionId ?? context.sessionId ?? '',
    isError: false,
    subtype: getStringValue(resultEvent, 'subtype') ?? 'success',
    stopReason: result.stopReason ?? undefined,
    durationMs: Math.max(0, new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime()),
    totalCostUsd: undefined,
    numTurns: result.requests.length,
    exitCode: 0,
    stderr: '',
    initEvent,
    resultEvent,
    assistantMessages,
    events,
  };
}

function makeSyntheticBridgeResult(
  text: string,
  context: {
    sessionId?: string;
    bridgeOptions: Partial<ActoviqBridgeRunOptions>;
    report: ActoviqCleanBridgeCompatibilityReport;
    subtype?: string;
  },
): ActoviqBridgeRunResult {
  const sessionId = context.sessionId ?? context.bridgeOptions.sessionId ?? '';
  const timestamp = nowIso();
  const initEvent: ActoviqBridgeJsonEvent = {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    bridge_compat: true,
  };
  const assistant: ActoviqBridgeJsonEvent = {
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    timestamp,
  };
  const resultEvent: ActoviqBridgeJsonEvent = {
    type: 'result',
    subtype: context.subtype ?? 'success',
    session_id: sessionId,
    is_error: false,
    result: text,
    stop_reason: 'end_turn',
    duration_ms: 0,
    num_turns: 1,
    bridge_compatibility: context.report,
    timestamp,
  };
  return {
    text,
    sessionId,
    isError: false,
    subtype: context.subtype ?? 'success',
    stopReason: 'end_turn',
    durationMs: 0,
    numTurns: 1,
    exitCode: 0,
    stderr: '',
    initEvent,
    resultEvent,
    assistantMessages: [assistant],
    events: [initEvent, assistant, resultEvent],
  };
}

function synthesizeBridgeEvents(
  result: AgentRunResult,
  context: CleanBridgeResultContext,
): ActoviqBridgeJsonEvent[] {
  const initEvent = makeInitEventFromResult(result, context.bridgeOptions);
  const assistant: ActoviqBridgeJsonEvent = {
    type: 'assistant',
    session_id: result.sessionId ?? context.sessionId,
    uuid: result.message.id,
    message: result.message,
  };
  const resultEvent = makeResultEvent(result, context.bridgeOptions, context.report);
  return [initEvent, assistant, resultEvent];
}

function cleanEventToBridgeEvents(
  event: AgentEvent,
  options: ActoviqBridgeRunOptions,
): ActoviqBridgeJsonEvent[] {
  switch (event.type) {
    case 'run.started':
      return [{
        type: 'system',
        subtype: 'init',
        session_id: event.sessionId,
        model: event.model,
        permissionMode: options.permissionMode,
        bridge_compat: true,
        uuid: event.runId,
        timestamp: event.timestamp,
      }];
    case 'response.text.delta':
      if (options.includePartialMessages === false) {
        return [];
      }
      return [{
        type: 'assistant',
        subtype: 'text_delta',
        delta: event.delta,
        text: event.snapshot,
        uuid: event.runId,
        timestamp: event.timestamp,
      }];
    case 'response.content':
      return [{
        type: 'assistant',
        subtype: 'content',
        content: event.content,
        uuid: event.runId,
        timestamp: event.timestamp,
      }];
    case 'response.message':
      return [{
        type: 'assistant',
        subtype: 'message',
        message: event.message,
        uuid: event.message.id,
        timestamp: event.timestamp,
      }];
    case 'tool.call':
      return [{
        type: 'assistant',
        subtype: 'tool_use',
        tool_use: event.call,
        uuid: event.call.id,
        timestamp: event.timestamp,
      }];
    case 'tool.result':
      return [{
        type: 'user',
        subtype: 'tool_result',
        tool_result: event.result,
        uuid: event.result.id,
        timestamp: event.timestamp,
      }];
    case 'tool.permission':
      return options.includeHookEvents
        ? [{
            type: 'hook',
            subtype: 'tool_permission',
            decision: event.decision,
            timestamp: event.timestamp,
          }]
        : [];
    case 'tool.progress':
      return options.includeHookEvents
        ? [{
            type: 'hook',
            subtype: 'tool_progress',
            tool_use_id: event.toolUseId,
            data: event.data,
            timestamp: event.timestamp,
          }]
        : [];
    case 'session.compacted':
      return [{
        type: 'system',
        subtype: 'compact_boundary',
        session_id: event.sessionId,
        compactMetadata: event.result,
        timestamp: event.timestamp,
      }];
    case 'response.completed':
      return [makeResultEvent(event.result, options)];
    case 'error':
      return [{
        type: 'result',
        subtype: 'error',
        is_error: true,
        error: event.error,
        duration_ms: 0,
        timestamp: event.timestamp,
      }];
    default:
      if ('workflowName' in event && options.includeHookEvents) {
        return [{
          type: 'hook',
          subtype: event.type,
          event,
          timestamp: event.timestamp,
        }];
      }
      return [];
  }
}

function makeInitEventFromResult(
  result: AgentRunResult,
  options: ActoviqBridgeRunOptions,
): ActoviqBridgeJsonEvent {
  return {
    type: 'system',
    subtype: 'init',
    session_id: result.sessionId,
    model: result.model,
    permissionMode: options.permissionMode,
    bridge_compat: true,
    uuid: result.runId,
    timestamp: result.startedAt,
  };
}

function makeResultEvent(
  result: AgentRunResult,
  _options: ActoviqBridgeRunOptions,
  report?: ActoviqCleanBridgeCompatibilityReport,
): ActoviqBridgeJsonEvent {
  return {
    type: 'result',
    subtype: 'success',
    session_id: result.sessionId,
    is_error: false,
    result: result.text,
    stop_reason: result.stopReason ?? undefined,
    duration_ms: Math.max(0, new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime()),
    num_turns: result.requests.length,
    bridge_compatibility: report,
    uuid: result.runId,
    timestamp: result.completedAt,
  };
}

function mapBridgePermissionMode(
  mode: ActoviqBridgePermissionMode | ActoviqPermissionMode | undefined,
  options: Pick<CreateActoviqBridgeSdkOptions, 'dangerouslySkipPermissions'> = {},
): ActoviqPermissionMode {
  if (options.dangerouslySkipPermissions === true) {
    return 'bypassPermissions';
  }
  if (options.dangerouslySkipPermissions === false && mode === undefined) {
    return 'default';
  }
  if (mode === undefined) {
    return 'bypassPermissions';
  }
  if (mode === 'dontAsk') {
    return 'default';
  }
  return mode as ActoviqPermissionMode;
}

function mergeCleanAgentRunOptions(
  definition: ActoviqAgentDefinition,
  options: InternalBridgeCleanRunOptions,
): InternalBridgeCleanRunOptions {
  return {
    ...options,
    systemPrompt: joinPromptParts(definition.systemPrompt, options.systemPrompt),
    model: options.model ?? definition.model,
    metadata: {
      ...(definition.metadata ?? {}),
      ...(options.metadata ?? {}),
      __actoviqAgentDefinition: definition.name,
    },
    hooks: mergeActoviqHooks(definition.hooks, options.hooks),
    tools: [...(definition.tools ?? []), ...(options.tools ?? [])],
    mcpServers: [...(definition.mcpServers ?? []), ...(options.mcpServers ?? [])],
    __actoviqUseDefaultTools: definition.inheritDefaultTools !== false,
    __actoviqUseDefaultMcpServers: definition.inheritDefaultMcpServers !== false,
  };
}

function createToolFilter(
  allowedTools?: string[],
  disallowedTools?: string[],
): AgentRunOptions['canUseTool'] | undefined {
  const allowed = allowedTools?.length ? new Set(allowedTools) : undefined;
  const disallowed = disallowedTools?.length ? new Set(disallowedTools) : undefined;
  if (!allowed && !disallowed) {
    return undefined;
  }
  return (context) => {
    const names = [context.publicName, context.toolName];
    if (disallowed && names.some(name => disallowed.has(name))) {
      return { behavior: 'deny', reason: 'Denied by bridge disallowedTools.' };
    }
    if (allowed && !names.some(name => allowed.has(name))) {
      return { behavior: 'deny', reason: 'Denied because bridge allowedTools did not include this tool.' };
    }
    return { behavior: 'allow', reason: 'Allowed by bridge tool filter.' };
  };
}

function convertMcpConfigs(
  configs?: Array<string | Record<string, unknown>>,
  strict = false,
): { servers: AgentMcpServerDefinition[]; unsupported: ActoviqCleanBridgeUnsupportedOption[] } {
  const servers: AgentMcpServerDefinition[] = [];
  const unsupported: ActoviqCleanBridgeUnsupportedOption[] = [];
  for (const config of configs ?? []) {
    const parsed = typeof config === 'string' ? parseJsonMaybe(config) : config;
    if (!isRecord(parsed)) {
      const entry = {
        option: 'mcpConfigs',
        value: config,
        reason: 'String MCP configs must contain JSON to be converted by clean compatibility mode.',
      };
      if (strict) throw new Error(entry.reason);
      unsupported.push(entry);
      continue;
    }
    const root = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
    for (const [name, value] of Object.entries(root)) {
      if (!isRecord(value)) {
        continue;
      }
      const command = typeof value.command === 'string' ? value.command : undefined;
      const url = typeof value.url === 'string' ? value.url : undefined;
      if (command) {
        servers.push({
          kind: 'stdio',
          name,
          command,
          args: Array.isArray(value.args) ? value.args.filter((entry): entry is string => typeof entry === 'string') : undefined,
          env: isStringRecord(value.env) ? value.env : undefined,
          cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
        });
        continue;
      }
      if (url) {
        servers.push({
          kind: 'streamable_http',
          name,
          url,
          headers: isStringRecord(value.headers) ? value.headers : undefined,
        });
        continue;
      }
      const entry = {
        option: 'mcpConfigs',
        value,
        reason: `MCP server "${name}" is not a supported clean stdio or streamable_http shape.`,
      };
      if (strict) throw new Error(entry.reason);
      unsupported.push(entry);
    }
  }
  return { servers, unsupported };
}

function parseJsonMaybe(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string');
}

function formatSlashCommand(commandName: string, args = ''): string {
  const normalized = normalizeCommandName(commandName);
  const trimmed = args.trim();
  return trimmed ? `/${normalized} ${trimmed}` : `/${normalized}`;
}

function normalizeCommandName(commandName: string): string {
  return commandName.trim().replace(/^\/+/u, '');
}

function joinPromptParts(...parts: Array<string | undefined>): string | undefined {
  const text = parts
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
  return text || undefined;
}

function getStringValue(record: unknown, key: string): string | undefined {
  if (!isRecord(record)) {
    return undefined;
  }
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function bridgePromptFromMessageContent(input: string | MessageParam['content']): string {
  return typeof input === 'string' ? input : extractTextFromContent(input);
}

export function normalizeCleanBridgeError(error: unknown): Error {
  return asError(error);
}
