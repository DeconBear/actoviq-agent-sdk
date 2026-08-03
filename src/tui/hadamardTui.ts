/**
 * Hadamard TUI — a full-screen-feel terminal UI for the Clean SDK, modeled on
 * Claude Code's REPL: permanent transcript in native scrollback, a redrawable
 * bottom region with a Claude-style prompt bar, slash-command menu, streaming
 * output, permission dialogs, and mid-run steering. Dependency-free ANSI
 * rendering (no React/Ink).
 */
import { execSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';

import {
  createHadamardCoreTools,
  createAgentSdk,
  createHadamardBridgeSdk,
  detectBridgeProviders,
  loadDefaultHadamardSettings,
  loadJsonConfigFile,
  listWorkflows,
  loadWorkflow,
  listTeamDefinitions,
  loadTeamDefinition,
  cloneTeamDefinition,
  instantiateTeamDefinition,
  listTeamAgentLabels,
  countTeamAgents,
  createModelTeam,
  createTeamTool,
  readTeamPreferences,
  createManagerTools,
  createAssistantTeamTools,
  buildAssistantTeamSystemPrompt,
  TeamProposalStore,
  SessionCatalog,
  createAssistantGlobalTools,
  buildAssistantGlobalSystemPrompt,
  readAssistantConfig,
  writeAssistantConfig,
  buildManagerSystemPrompt,
  buildUpdateProgressPrompt,
  formatManagerUpdatePreview,
  resolveGitHubDigestForUpdate,
  readManagerConfig,
  writeManagerConfig,
  readProjectPlanFile,
  readProgressFile,
  managerProgressPath,
  createProjectIssue,
  executeProjectIssue,
  isIssueStatus,
  isIssueStorageMode,
  listProjectIssues,
  listScheduledAutomationTasks,
  upsertScheduledAutomationTask,
  resolveHadamardHome,
  externalSkillPreferencesToRuntimeOptions,
  readHadamardExternalSkillPreferences,
  createManagedPluginRuntime,
  patchManagedPluginSettings,
  readManagedPluginCatalog,
  listRouterProfiles,
  loadRouterProfile,
  resolveRoutedRun,
  transitionProjectIssue,
  WorktreeService,
  GoalService,
  executeGoalCommand,
  GOAL_METADATA_KEY,
  normalizeGoal,
} from '../index.js';
import { adaptBridgeRun } from '../parity/bridgeEventAdapter.js';
import { ExternalCliRuntimeManager } from '../parity/externalCliRuntimeManager.js';
import {
  externalCliSessionMatchesConfig,
  listExternalCliSessions,
  readExternalCliSession,
  type ExternalCliSessionSummary,
} from '../parity/externalCliSessions.js';
import { parseCrushSessionReferenceDetails } from '../parity/crushSessionHistory.js';
import { readProjectMeta } from '../gui/projectMeta.js';
import { readWorkspaceRegistry } from '../gui/workspaceRegistry.js';
import {
  persistHadamardSettingsStore,
  resolveHadamardSettingsStore,
} from '../config/hadamardSettingsStore.js';
import { createPreToolUseHookClassifier, readPreToolUseHooks, readPostToolUseHooks, runPostToolUseHooks, readSessionStartHooks, runSessionStartHooks } from '../hooks/userHooks.js';
import { parseTypedHooks } from '../hooks/hookConfig.js';
import type {
  HadamardEffort,
  HadamardRunEffort,
  HadamardCanUseTool,
  HadamardPermissionMode,
  HadamardPermissionRule,
  HadamardToolApprover,
  AgentEvent,
  AgentRunResult,
  AgentToolDefinition,
  SessionSummary,
  TeamDefinition,
  RouterProfile,
} from '../types.js';
import { isRecord } from '../runtime/helpers.js';
import { getLoadedJsonConfig } from '../config/loadJsonConfigFile.js';
import {
  findBridgeConfig,
  maskApiKey,
  readBridgeConfigs,
  addBridgeConfig,
  removeBridgeConfig,
  isManagedExternalCliRuntime,
  type PersistedBridgeConfig,
  type InProcessProvider,
  type ManagedExternalCliRuntime,
} from '../parity/bridgeConfigs.js';
import { buildRouteModelApi, type RoutedModel } from '../router/modelRouter.js';
import { addMcpServer, readMcpServerConfig, removeMcpServer } from '../mcp/mcpServerConfig.js';
import type { ContentBlockParam } from '../provider/types.js';
import { isReadOnlyBashCommand } from '../runtime/bashClassification.js';
import { estimateCost } from '../team/pricing.js';
import { applyTeamRunEvent, createTeamRunViewState, formatTeamRunTreeLines } from '../team/teamRunView.js';
import { planFilePath, readPlanFile } from '../tools/planMode/PlanModeTools.js';
import { loadProjectContext } from '../memory/projectContext.js';
import {
  LegacySurfaceEventPipeline,
  type SurfaceSemanticEvent,
} from '../surfaces/index.js';
import { pathToFileURL } from 'node:url';
import {
  HADAMARD_INTERACTIVE_COMMANDS,
  SUBCOMMAND_DESCRIPTIONS,
  filterInteractiveCommands,
  interactiveCommandUsage,
  selectInteractiveCommand,
} from '../ui/commandSurface.js';
import {
  createAgentExecutionProjectView,
  createAgentExecutionRootView,
  formatAgentExecutionTreeLines,
  type AgentExecutionNodeView,
  type AgentExecutionRootView,
} from '../ui/agentExecutionView.js';
import { A, stringWidth, truncateToWidth, wrapToWidth } from './ansi.js';
import { InputEditor } from './editor.js';
import { discoverHadamardPlugins } from './pluginCatalog.js';
import { TuiScreen } from './screen.js';
import {
  filterTuiSelectionItems,
  moveTuiSelection,
  type TuiSelectionItem,
} from './selection.js';
import {
  StreamFlusher,
  formatBanner,
  formatCompactNotice,
  formatDivider,
  formatEditCall,
  formatErrorLine,
  formatInfoLine,
  formatQueuedPrompt,
  formatThinking,
  formatToolCall,
  formatToolResult,
  formatUserPrompt,
} from './transcript.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CTRL_C_EXIT_WINDOW_MS = 600;
const DYNAMIC_FRAME_MS = 33;
const MENU_MAX_ROWS = 12;
const PROMPT_GLYPH = '❯';
const SESSION_EFFORT_KEY = '__hadamardEffort';
const EFFORT_LEVELS: readonly HadamardEffort[] = ['low', 'medium', 'high', 'max'];
const MANAGED_PLUGIN_FINAL_CLOSE_ATTEMPTS = 2;
const MANAGED_PLUGIN_FINAL_CLOSE_TIMEOUT_MS = 35_000;

/** Core tools that mutate state and require approval in 'default' mode. */
const MUTATING_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit']);
export const TUI_SLASH_COMMANDS = HADAMARD_INTERACTIVE_COMMANDS;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeManagedPluginsForExit(close: () => Promise<void>): Promise<void> {
  const failures: unknown[] = [];
  for (let attempt = 1; attempt <= MANAGED_PLUGIN_FINAL_CLOSE_ATTEMPTS; attempt += 1) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        close(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(
              `managed plugin cleanup timed out after ${MANAGED_PLUGIN_FINAL_CLOSE_TIMEOUT_MS}ms`,
            ));
          }, MANAGED_PLUGIN_FINAL_CLOSE_TIMEOUT_MS);
        }),
      ]);
      return;
    } catch (error) {
      failures.push(error);
      process.stderr.write(
        `[hadamard-tui] warning: managed plugin cleanup attempt ${attempt}/` +
        `${MANAGED_PLUGIN_FINAL_CLOSE_ATTEMPTS} failed: ${errorMessage(error)}\n`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw new AggregateError(
    failures,
    'Managed plugin cleanup failed after bounded retries; an external sandbox may remain active and billing may continue.',
  );
}

/** Mask an API key for display: show first 4 + last 4, hide the middle. */
function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function filterSlashCommands(input: string): string[] {
  return filterInteractiveCommands(input);
}

/** Agent conversations are independently resumable, but stay out of the normal chat list. */
export function isTuiChatSession(session: Pick<SessionSummary, 'kind'>): boolean {
  return session.kind !== 'manager' && session.kind !== 'agent';
}

/**
 * Detect an active "@file" mention at the cursor for path completion. Returns
 * the partial token typed after the '@' plus the '@' offset, or null when the
 * cursor is not inside a mention. The '@' only opens a mention at the start of
 * input or after whitespace, and the token ends at the first whitespace.
 */
export function activeAtToken(
  text: string,
  cursor: number,
): { token: string; start: number } | null {
  for (let i = cursor - 1; i >= 0; i -= 1) {
    const ch = text[i]!;
    if (/\s/.test(ch)) return null;
    if (ch === '@') {
      if (i === 0 || /\s/.test(text[i - 1]!)) {
        return { token: text.slice(i + 1, cursor), start: i };
      }
      return null;
    }
  }
  return null;
}

export interface HadamardTuiOptions {
  workDir?: string;
  configPath?: string;
  permissionMode?: HadamardPermissionMode;
  model?: string;
  resumeSessionId?: string;
  continueMostRecent?: boolean;
}

interface PermissionDialogState {
  toolName: string;
  summary: string;
  selected: number; // 0 = yes, 1 = always (project), 2 = always (user), 3 = no
  resolve: (outcome: 'allow' | 'always' | 'always-user' | 'deny') => void;
}

interface SelectionDialogState {
  title: string;
  subtitle?: string;
  items: TuiSelectionItem[];
  selected: number;
  query: string;
  searchable: boolean;
  resolve: (itemId: string | undefined) => void;
}

interface TextInputDialogState {
  title: string;
  label: string;
  description?: string;
  editor: InputEditor;
  secret: boolean;
  resolve: (value: string | undefined) => void;
}

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

/**
 * Render free-form text for the scrollback: width-aware word wrapping with
 * markdown-lite heading highlighting. Used for workflow/team results and the
 * expert-panel member reports so long output reads cleanly instead of dumping
 * raw lines. Optionally caps very long output with a "… (N more lines)" note.
 */
// Apply inline markdown formatting to a single unwrapped line segment:
// `code` → dim, **bold** → bold, *italic* → italic. Applied after wrapping
// so ANSI codes never split mid-segment.
function renderMarkdownInline(line: string): string {
  return line
    .replace(/`([^`]+)`/g, `${A.dim}$1${A.reset}`)
    .replace(/\*\*([^*]+)\*\*/g, `${A.bold}$1${A.reset}`)
    .replace(/\*([^*]+)\*/g, `${A.italic}$1${A.reset}`);
}

export function renderRichText(text: string, width: number, opts: { maxLines?: number } = {}): string[] {
  const cols = Math.max(20, width - 2);
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    // Fenced code blocks: render a dim rule at the fence and the content
    // dim/gray so code reads as a block instead of raw markdown text. Code
    // lines are not word-wrapped (wrapping would corrupt code).
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      out.push(`${A.dim}${'─'.repeat(Math.min(cols, 40))}${A.reset}`);
      continue;
    }
    if (inFence) {
      out.push(`${A.gray}  ${raw}${A.reset}`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      out.push(`${A.bold}${A.cyan}${heading[2]}${A.reset}`);
      continue;
    }
    if (raw.trim() === '') {
      out.push('');
      continue;
    }
    // Wrap first, then apply inline formatting per segment — avoids ANSI
    // splitting by never putting styling codes mid-segment.
    for (const line of wrapToWidth(raw, cols)) out.push(renderMarkdownInline(line));
  }
  const maxLines = opts.maxLines ?? 0;
  if (maxLines > 0 && out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    kept.push(`${A.dim}… (${out.length - maxLines} more lines)${A.reset}`);
    return kept;
  }
  return out;
}

function buildSystemPrompt(workDir: string): string {
  let isGit = false;
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: workDir, stdio: 'ignore' });
    isGit = true;
  } catch {
    // not a git repo
  }
  // Load the CLAUDE.md hierarchy (user + project, with @includes) so the agent
  // picks up project-specific instructions — the canonical Claude Code behavior.
  const project = loadProjectContext(workDir);
  const projectSection = project.text
    ? `\n\n# Project context (CLAUDE.md)\n\nThe following project instructions were loaded from CLAUDE.md files. Treat them as authoritative guidance for this workspace.\n\n${project.text}\n`
    : '';
  return (
    `You are Hadamard Agent, an interactive CLI agent. Working directory: ${workDir}\n\n` +
    `<env>\nWorking directory: ${workDir}\nIs git repo: ${isGit ? 'Yes' : 'No'}\nPlatform: ${process.platform}\nDate: ${new Date().toISOString().slice(0, 10)}\n</env>\n\n` +
    `# Tone and style\n` +
    `- Only use emojis if the user explicitly requests it.\n` +
    `- Your responses should be short and concise.\n` +
    `- When referencing code include the pattern file_path:line_number.\n\n` +
    `# Doing tasks\n` +
    `- Prefer editing existing files to creating new ones.\n` +
    `- Do not add features, refactor, or introduce abstractions beyond what the task requires.\n` +
    `- Default to writing no comments.\n\n` +
    `# Git Safety Protocol\n` +
    `- NEVER update the git config\n` +
    `- NEVER run destructive git commands unless the user explicitly requests\n` +
    `- NEVER skip hooks unless the user explicitly requests it\n` +
    `- NEVER commit changes unless the user explicitly asks you to\n\n` +
    `# Other\n` +
    `- NEVER create documentation files (*.md) unless explicitly requested.\n` +
    `- When in doubt, use TodoWrite to track progress.`
  ) + projectSection;
}

// First-run onboarding: guides the user through creating the Hadamard settings file
// when no credential is found. Uses plain readline (no TTY required beyond stdin).
async function onboardCredentials(configPath?: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  console.log('\n  Welcome to Hadamard! Let\'s set up your first connection.\n');

  const provider = await ask('  Provider (anthropic/openai) [anthropic]: ');
  const apiKey = await ask('  API Key: ');
  const baseURL = await ask('  Base URL [https://api.deepseek.com]: ');
  const model = await ask('  Model [deepseek-chat]: ');

  rl.close();

  const resolvedProvider = provider.trim() || 'anthropic';
  const resolvedBaseURL = baseURL.trim() || 'https://api.deepseek.com';
  const resolvedModel = model.trim() || 'deepseek-chat';

  const dir = resolveHadamardHome();
  const file = configPath ?? path.join(dir, 'settings.json');

  fs.mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {
    HADAMARD_API_KEY: apiKey.trim(),
    HADAMARD_BASE_URL: resolvedBaseURL,
    HADAMARD_MODEL: resolvedModel,
  };
  if (resolvedProvider === 'openai') env.HADAMARD_PROVIDER = 'openai';
  const settings: Record<string, unknown> = { env };
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf-8');
  console.log(`\n  Config saved to ${file}. Starting TUI...\n`);
}

export async function runHadamardTui(options: HadamardTuiOptions = {}): Promise<void> {
  const workDir = path.resolve(options.workDir ?? process.cwd());
  const permissionMode: HadamardPermissionMode = options.permissionMode ?? 'bypassPermissions';
  const systemPrompt = buildSystemPrompt(workDir);

  try {
    if (options.configPath) {
      await loadJsonConfigFile(options.configPath);
    } else {
      await loadDefaultHadamardSettings();
    }
  } catch {
    // Missing local config is fine; env vars may carry credentials.
  }

  let applyPlanPermission: (() => Promise<void>) | null = null;
  let managedPluginRuntime: ReturnType<typeof createManagedPluginRuntime> | null = null;
  let tools: AgentToolDefinition[] = [];
  const rebuildInteractiveTools = async (): Promise<void> => {
    if (managedPluginRuntime) {
      await managedPluginRuntime.close();
    }
    const store = await resolveHadamardSettingsStore({
      configPath: options.configPath,
    });
    managedPluginRuntime = createManagedPluginRuntime(store.raw, { cwd: workDir });
    tools = [
      ...createHadamardCoreTools({
        cwd: workDir,
        onPlanModeChange: async (mode) => {
          if (mode === 'plan') await applyPlanPermission?.();
        },
      }),
      ...managedPluginRuntime.tools,
    ];
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    tools = [...byName.values()];
  };
  const createCleanSdk = async () => {
    await rebuildInteractiveTools();
    const externalSkillPreferences = await readHadamardExternalSkillPreferences({
      hadamardHomeDir: resolveHadamardHome(),
      workDir,
    });
    return createAgentSdk({
      workDir,
      tools,
      permissionMode,
      externalSkills: externalSkillPreferencesToRuntimeOptions(externalSkillPreferences),
      // Load user-managed stdio MCP servers from ~/.hadamard/mcp.json (gap #10).
      mcpServers: readMcpServerConfig().servers.map(s => (
        s.command
          ? { kind: 'stdio' as const, name: s.name, command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}), ...(s.cwd ? { cwd: s.cwd } : {}) }
          : { kind: 'streamable_http' as const, name: s.name, url: s.url!, ...(s.headers ? { headers: s.headers } : {}) }
      )),
      ...(options.model ? { model: options.model } : {}),
    });
  };
  let sdk: Awaited<ReturnType<typeof createAgentSdk>>;
  let toolMetadata: Awaited<ReturnType<typeof sdk.listToolMetadata>>;
  while (true) {
    try {
      sdk = await createCleanSdk();
      toolMetadata = await sdk.listToolMetadata();
      break;
    } catch (error) {
      if (error instanceof Error && error.message.includes('No Hadamard credential')) {
        // First-run onboarding: guide the user through creating ~/.hadamard/settings.json.
        await onboardCredentials(options.configPath);
        // After saving, retry SDK creation.
        continue;
      }
      throw error;
    }
  }

  // Build a dynamic capabilities section injected into the system prompt each
  // turn (gap #16 vs claude-code) — subagents, MCP servers+tools, skills — so
  // the model knows what it can delegate to/use beyond the core tool list.
  function buildAgentContext(): string {
    const parts: string[] = [];
    const agents = sdk.listAgentDefinitions();
    if (agents.length > 0) {
      parts.push(`Available subagents: ${agents.map(a => a.name).join(', ')}`);
    }
    const byServer = new Map<string, typeof toolMetadata>();
    for (const tool of toolMetadata.filter(item => item.provider === 'mcp')) {
      const server = tool.server ?? 'mcp';
      if (!byServer.has(server)) byServer.set(server, []);
      byServer.get(server)!.push(tool);
    }
    for (const [server, tools] of byServer) {
      const names = tools.map(t => t.name).slice(0, 12).join(', ');
      parts.push(`MCP server "${server}": ${names}${tools.length > 12 ? '…' : ''}`);
    }
    const skills = sdk.skills.listMetadata();
    if (skills.length > 0) {
      parts.push(`Skills: ${skills.map(s => s.name).slice(0, 12).join(', ')}${skills.length > 12 ? '…' : ''}`);
    }
    return parts.length > 0 ? `\n\n# Available capabilities\n\n${parts.join('\n')}\n` : '';
  }

  let session = options.resumeSessionId
    ? await sdk.resumeSession(options.resumeSessionId, {
        model: options.model,
        permissionMode: options.permissionMode,
      })
    : options.continueMostRecent
      ? await sdk.sessions.continueMostRecent({
          model: options.model,
          permissionMode: options.permissionMode,
        })
      : await sdk.createSession({
          title: path.basename(workDir),
          model: options.model,
          permissionMode,
        });
  // Run SessionStart hooks (fire-and-forget, from settings.json hooks.SessionStart[]).
  runSessionStartHooks(() => readSessionStartHooks(getLoadedJsonConfig()?.raw), sdk.config.workDir);

  const screen = new TuiScreen(process.stdout);
  const editor = new InputEditor();
  const flusher = new StreamFlusher(() => screen.width);

  let running = false;
  let commandBusy = false;
  let shuttingDown = false;
  // Active team tool the main agent may call (toggled via /team). null = no team.
  // The tool is only injected into runs when preferences.team.autoInvoke is on;
  // otherwise attach is a selection and /team ask stays the manual path.
  const teamPrefs = readTeamPreferences(getLoadedJsonConfig()?.raw);
  let activeTeamTool: AgentToolDefinition | null = null;
  let activeTeamName: string | null = null;
  let lastTeamRunSummary: string | null = null;
  const attachTeamByName = (name: string): TeamDefinition | null => {
    const loaded = loadTeamDefinition(name, sdk.config.workDir);
    if (!loaded) return null;
    const definition = instantiateTeamDefinition(loaded.definition, session.model);
    activeTeamTool = createTeamTool(definition);
    activeTeamName = definition.name;
    return definition;
  };
  if (teamPrefs.defaultAttached) {
    // Unresolvable default names are ignored; /team status surfaces the hint.
    try { attachTeamByName(teamPrefs.defaultAttached); } catch { /* ignore */ }
  }
  // /model router: when set, each user turn is classified and routed to a model.
  let activeRouter: RouterProfile | null = null;
  let routedModelLabel: string | null = null;
  // A named config can use either the in-process API bridge or a real external
  // CLI. External clients/sessions are isolated by Hadamard session, config, and
  // cwd so switching chats cannot leak native runtime context.
  let bridgeMode = false;
  let activeBridgeConfig: PersistedBridgeConfig | null = null;
  // Pre-built {model, modelApi} for the active config. Built once at activation;
  // stale after disable (cleared). Per-run injection reuses the /model router's
  // proven mechanism (session.stream({model, modelApi})).
  let activeBridgeModelApi: RoutedModel | null = null;
  type ExternalBridgeClient = Awaited<ReturnType<typeof createHadamardBridgeSdk>>;
  type ExternalBridgeSession = Awaited<ReturnType<ExternalBridgeClient['createSession']>>;
  interface ExternalBridgeRuntime {
    client: ExternalBridgeClient;
    session: ExternalBridgeSession;
    fingerprint: string;
  }
  type SupportedExternalCliConfig = PersistedBridgeConfig & {
    execution: 'cli';
    runtime: ManagedExternalCliRuntime;
  };
  type TuiAgentSession = typeof session;
  interface ExternalSessionBinding {
    runtime: ManagedExternalCliRuntime;
    configName: string;
    cwd: string;
    nativeSessionId: string;
    updatedAt: string;
  }
  const RUNTIME_METADATA_KEY = '__hadamardRuntime';
  const CONFIG_NAME_METADATA_KEY = '__hadamardConfigName';
  const RUNTIME_MODEL_METADATA_KEY = '__hadamardRuntimeModel';
  const EXTERNAL_SESSIONS_METADATA_KEY = '__hadamardExternalSessions';
  // Display label for the active runtime model.
  let bridgeModelLabel: string | null = null;
  const externalBridgeRuntimes = new Map<string, ExternalBridgeRuntime>();
  const externalCliRuntimeManager = new ExternalCliRuntimeManager();
  const externalCliRunLabels = new Map<string, {
    configName: string;
    runtime: ManagedExternalCliRuntime;
  }>();
  function sameWorkspace(left: string, right: string): boolean {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  function externalSessionBindingKey(
    config: SupportedExternalCliConfig,
    targetWorkDir = sdk.config.workDir,
  ): string {
    return createHash('sha256')
      .update(config.runtime + '\u0000' + config.name + '\u0000' + path.resolve(targetWorkDir))
      .digest('hex')
      .slice(0, 24);
  }
  function externalBridgeRuntimeKey(
    config: SupportedExternalCliConfig,
    targetSession: TuiAgentSession = session,
    targetWorkDir = sdk.config.workDir,
  ): string {
    return targetSession.id + '\u0000' + externalSessionBindingKey(config, targetWorkDir);
  }
  function externalSessionBindings(
    targetSession: TuiAgentSession = session,
  ): Record<string, ExternalSessionBinding> {
    const raw = targetSession.metadata[EXTERNAL_SESSIONS_METADATA_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const bindings: Record<string, ExternalSessionBinding> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (
        !isManagedExternalCliRuntime(record.runtime as import('../parity/bridgeConfigs.js').BridgeRuntime)
        || typeof record.configName !== 'string'
        || typeof record.cwd !== 'string'
        || typeof record.nativeSessionId !== 'string'
        || !record.nativeSessionId
      ) continue;
      bindings[key] = {
        runtime: record.runtime as ManagedExternalCliRuntime,
        configName: record.configName,
        cwd: record.cwd,
        nativeSessionId: record.nativeSessionId,
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
      };
    }
    return bindings;
  }
  function externalNativeSessionId(
    config: SupportedExternalCliConfig,
    targetSession: TuiAgentSession = session,
    targetWorkDir = sdk.config.workDir,
  ): string | undefined {
    const binding = externalSessionBindings(targetSession)[
      externalSessionBindingKey(config, targetWorkDir)
    ];
    if (
      !binding
      || binding.runtime !== config.runtime
      || binding.configName !== config.name
      || !sameWorkspace(binding.cwd, targetWorkDir)
    ) return undefined;
    return binding.nativeSessionId;
  }
  async function rememberExternalNativeSession(
    config: SupportedExternalCliConfig,
    nativeSessionId: string,
    targetSession: TuiAgentSession = session,
    targetWorkDir = sdk.config.workDir,
  ): Promise<void> {
    if (!nativeSessionId) return;
    const bindings = externalSessionBindings(targetSession);
    bindings[externalSessionBindingKey(config, targetWorkDir)] = {
      runtime: config.runtime,
      configName: config.name,
      cwd: path.resolve(targetWorkDir),
      nativeSessionId,
      updatedAt: new Date().toISOString(),
    };
    await targetSession.mergeMetadata({ [EXTERNAL_SESSIONS_METADATA_KEY]: bindings });
  }
  async function persistSessionRuntimeMetadata(
    targetSession: TuiAgentSession = session,
    config: PersistedBridgeConfig | null = activeBridgeConfig,
    modelLabel: string | null = bridgeModelLabel,
  ): Promise<void> {
    await targetSession.mergeMetadata({
      [RUNTIME_METADATA_KEY]: config?.runtime ?? 'hadamard',
      [CONFIG_NAME_METADATA_KEY]: config?.name ?? null,
      [RUNTIME_MODEL_METADATA_KEY]: config?.model ?? modelLabel ?? null,
    });
  }
  function clearBridgeSelection(): void {
    bridgeMode = false;
    activeBridgeConfig = null;
    activeBridgeModelApi = null;
    bridgeModelLabel = null;
  }
  async function restoreSessionRuntimeSelection(): Promise<void> {
    const configName = session.metadata[CONFIG_NAME_METADATA_KEY];
    if (typeof configName !== 'string' || !configName.trim()) {
      clearBridgeSelection();
      return;
    }
    const stored = findBridgeConfig(configName);
    if (!stored) {
      clearBridgeSelection();
      return;
    }
    const model = session.metadata[RUNTIME_MODEL_METADATA_KEY];
    const config = typeof model === 'string' && model.trim()
      ? { ...stored, model: model.trim() }
      : stored;
    if (!await activateBridgeConfig(config)) clearBridgeSelection();
  }
  function activeExternalBridgeRuntime(): ExternalBridgeRuntime | null {
    if (
      !bridgeMode
      || activeBridgeConfig?.execution !== 'cli'
      || !isManagedExternalCliRuntime(activeBridgeConfig.runtime)
    ) return null;
    return externalBridgeRuntimes.get(
      externalBridgeRuntimeKey(activeBridgeConfig as SupportedExternalCliConfig),
    ) ?? null;
  }
  function externalBridgeFingerprint(config: PersistedBridgeConfig): string {
    return JSON.stringify([
      config.runtime,
      config.authSource ?? 'native',
      config.authSource === 'apiKey' ? config.apiKey ?? '' : '',
      config.authSource === 'apiKey' ? config.baseURL ?? '' : '',
      config.authSource === 'apiKey' ? config.credentialProvider ?? '' : '',
      config.trustProjectResources === true,
    ]);
  }
  function externalCliConfigId(config: SupportedExternalCliConfig): string {
    const digest = createHash('sha256')
      .update(externalBridgeFingerprint(config))
      .digest('hex')
      .slice(0, 12);
    return `${config.name}:${digest}`;
  }
  function findConflictingExternalCliRun(
    config: SupportedExternalCliConfig,
    targetSession: TuiAgentSession = session,
    targetWorkDir = sdk.config.workDir,
  ) {
    const configId = externalCliConfigId(config);
    return externalCliRuntimeManager.list().find(run => {
      if (
        run.hadamardSessionId !== targetSession.id
        || !sameWorkspace(run.cwd, targetWorkDir)
        || (run.status !== 'queued' && run.status !== 'running')
      ) return false;
      const label = externalCliRunLabels.get(run.runId);
      return run.configId === configId
        || (label?.configName === config.name && label.runtime === config.runtime);
    });
  }
  function externalCliDisplayText(
    value: string,
    config?: PersistedBridgeConfig,
  ): string {
    let safe = value;
    if (config?.apiKey) safe = safe.split(config.apiKey).join('[REDACTED]');
    return safe
      .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
      .replace(/((?:api[_-]?key|token|authorization|password|secret)\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]')
      .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED]');
  }
  function externalCliPreview(
    value: string,
    config?: PersistedBridgeConfig,
    maxLength = 180,
  ): string {
    const normalized = externalCliDisplayText(value, config).replace(/\s+/gu, ' ').trim();
    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength - 3)}...`
      : normalized;
  }
  function externalCliHistorySourceLabel(
    summary: Pick<ExternalCliSessionSummary, 'runtime' | 'path'>,
  ): string | undefined {
    if (summary.runtime !== 'crush') return undefined;
    const reference = parseCrushSessionReferenceDetails(summary.path);
    if (!reference) return undefined;
    return reference.managedProfileId
      ? `Managed profile \u00b7 ${reference.managedProfileId.slice(0, 8)}`
      : 'Native login';
  }
  let abortCtrl: AbortController | null = null;
  // Persistent Manager session (kind: 'manager') — reused across /manager
  // update/chat turns so the Manager keeps its own conversation context.
  let managerTuiSession: Awaited<ReturnType<typeof sdk.createSession>> | null = null;
  const assistantTeamProposals = new TeamProposalStore();
  async function interactiveSessionCatalog(): Promise<SessionCatalog> {
    const registered = await readWorkspaceRegistry(sdk.config.homeDir);
    return new SessionCatalog({
      homeDir: sdk.config.homeDir,
      projectPaths: [sdk.config.workDir, ...registered.map(item => item.path)],
    });
  }
  function managerProposalDiffForTui(
    proposal: import('../team/teamProposalService.js').TeamGraphProposal,
  ): string[] {
    return [
      ['+ nodes', proposal.diff.addedNodes],
      ['- nodes', proposal.diff.removedNodes],
      ['~ nodes', proposal.diff.changedNodes],
      ['+ edges', proposal.diff.addedEdges],
      ['- edges', proposal.diff.removedEdges],
      ['~ edges', proposal.diff.changedEdges],
    ].filter(([, values]) => (values as string[]).length)
      .map(([label, values]) => `${A.dim}${label}: ${(values as string[]).join(', ')}${A.reset}`);
  }
  let globalAssistantSdk: Awaited<ReturnType<typeof createAgentSdk>> | null = null;
  let globalAssistantSession: Awaited<ReturnType<typeof sdk.createSession>> | null = null;
  async function resolveGlobalAssistantSession() {
    const homeDir = sdk.config.homeDir;
    const config = await readAssistantConfig(homeDir);
    if (!globalAssistantSdk) {
      const sessionDirectory = path.join(homeDir, 'assistant');
      globalAssistantSdk = await createAgentSdk({
        workDir: sessionDirectory,
        sessionDirectory,
        tools: [],
        permissionMode: 'bypassPermissions',
        ...(config.model ? { model: config.model } : {}),
      });
    }
    if (globalAssistantSession && globalAssistantSession.id === config.activeSessionId) {
      return globalAssistantSession;
    }
    const stored = (await globalAssistantSdk.sessions.list())
      .filter(item => item.kind === 'manager')
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const existing = stored.find(item => item.id === config.activeSessionId) ?? stored[0];
    globalAssistantSession = existing
      ? await globalAssistantSdk.resumeSession(existing.id, { permissionMode: 'bypassPermissions' })
      : await globalAssistantSdk.createSession({
        title: 'Assistant (Global)',
        kind: 'manager',
        metadata: { __hadamardKind: 'manager', __hadamardAssistantScope: 'global' },
        permissionMode: 'bypassPermissions',
      });
    if (config.activeSessionId !== globalAssistantSession.id) {
      await writeAssistantConfig({ ...config, activeSessionId: globalAssistantSession.id }, homeDir);
    }
    return globalAssistantSession;
  }
  async function resolveManagerTuiSession() {
    if (managerTuiSession) return managerTuiSession;
    const cfg = await readManagerConfig(sdk.config.workDir, sdk.config.homeDir);
    const managers = (await sdk.sessions.list()).filter(item => item.kind === 'manager');
    managers.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const existing = managers.find(item => item.id === cfg.activeSessionId) ?? managers[0];
    if (existing) {
      managerTuiSession = await sdk.resumeSession(existing.id, { permissionMode: 'bypassPermissions' });
      if (cfg.activeSessionId !== existing.id) {
        await writeManagerConfig(sdk.config.workDir, sdk.config.homeDir, {
          ...cfg,
          activeSessionId: existing.id,
        });
      }
      return managerTuiSession;
    }
    managerTuiSession = await sdk.createSession({
      title: 'Manager',
      metadata: { __hadamardKind: 'manager' },
      permissionMode: 'bypassPermissions',
    });
    await writeManagerConfig(sdk.config.workDir, sdk.config.homeDir, {
      ...cfg,
      activeSessionId: managerTuiSession.id,
    });
    return managerTuiSession;
  }
  let dialog: PermissionDialogState | null = null;
  let selectionDialog: SelectionDialogState | null = null;
  let textInputDialog: TextInputDialogState | null = null;
  let menuSelected = 0;
  // @-mention file completion: highlighted candidate + lazily-cached file list.
  let atSelected = 0;
  let workspaceFiles: string[] | null = null;
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let dynamicRenderTimer: ReturnType<typeof setTimeout> | null = null;
  let runStartedAt = 0;
  let runToolCount = 0;
  let lastTokenEstimate: number | undefined;
  // Running token + USD totals for /cost and /usage. Per-config breakdown
  // shows spend by each bridge config so the user can compare backends.
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd: number | null = 0;
  const configUsage = new Map<string, { inputTokens: number; outputTokens: number; turns: number }>();
  function recordUsage(model: string, usage: { input_tokens?: number; output_tokens?: number } | undefined): void {
    const inT = usage?.input_tokens ?? 0;
    const outT = usage?.output_tokens ?? 0;
    totalInputTokens += inT;
    totalOutputTokens += outT;
    const cost = estimateCost(model, inT, outT);
    totalCostUsd = cost === null ? null : (totalCostUsd === null ? cost : totalCostUsd + cost);
    // Per-config tracking: attribute this turn to the active bridge config.
    if (bridgeMode && activeBridgeConfig) {
      const rec = configUsage.get(activeBridgeConfig.name) ?? { inputTokens: 0, outputTokens: 0, turns: 0 };
      rec.inputTokens += inT;
      rec.outputTokens += outT;
      rec.turns += 1;
      configUsage.set(activeBridgeConfig.name, rec);
    }
  }
  function configCost(name: string, rec: { inputTokens: number; outputTokens: number }): string | null {
    const cfg = findBridgeConfig(name);
    if (!cfg?.model) return null;
    const cost = estimateCost(cfg.model, rec.inputTokens, rec.outputTokens);
    return cost !== null ? `$${cost.toFixed(4)}` : null;
  }
  let statusNote = '';
  let ctrlCCount = 0;
  let ctrlCTimer: ReturnType<typeof setTimeout> | null = null;
  let streamedTextSeen = false;
  let streamedThinkingSeen = false;
  // Track tool names by callId for PostToolUse hook context.
  const toolCallNames = new Map<string, string>();
  // Live todo list (captured from TodoWrite tool calls). Rendered as a
  // persistent panel in the dynamic region so the user can see what the agent
  // is working on / what remains — Claude Code's main progress affordance.
  let currentTodos: { content: string; status: string; activeForm?: string }[] = [];
  const currentPermissionMode = (): HadamardPermissionMode =>
    session.permissionContext.mode ?? permissionMode;
  const currentExternalCliPermissionMode = (): 'acceptEdits' | 'bypassPermissions' | 'default' | 'plan' => {
    const mode = currentPermissionMode();
    return mode === 'auto' ? 'default' : mode;
  };
  const currentEffort = (): HadamardRunEffort | undefined => {
    const stored = session.metadata[SESSION_EFFORT_KEY];
    if (stored === 'auto') return 'auto';
    return isHadamardEffort(stored) ? stored : sdk.config.effort;
  };

  function isHadamardEffort(value: unknown): value is HadamardEffort {
    return typeof value === 'string' && EFFORT_LEVELS.includes(value as HadamardEffort);
  }

  function selectItem(options: {
    title: string;
    subtitle?: string;
    items: TuiSelectionItem[];
    searchable?: boolean;
  }): Promise<string | undefined> {
    if (options.items.length === 0) {
      return Promise.resolve(undefined);
    }
    return new Promise(resolve => {
      selectionDialog = {
        title: options.title,
        subtitle: options.subtitle,
        items: options.items,
        selected: 0,
        query: '',
        searchable: options.searchable !== false,
        resolve,
      };
      renderDynamic();
    });
  }

  function promptText(options: {
    title: string;
    label: string;
    description?: string;
    initial?: string;
    secret?: boolean;
  }): Promise<string | undefined> {
    return new Promise(resolve => {
      const inputEditor = new InputEditor();
      if (options.initial) inputEditor.setText(options.initial);
      textInputDialog = {
        title: options.title,
        label: options.label,
        description: options.description,
        editor: inputEditor,
        secret: options.secret === true,
        resolve,
      };
      renderDynamic();
    });
  }

  async function reloadCleanSdk(): Promise<void> {
    const previousSdk = sdk;
    const nextSdk = await createCleanSdk();
    try {
      const nextSession = await nextSdk.resumeSession(session.id);
      const nextToolMetadata = await nextSdk.listToolMetadata();
      sdk = nextSdk;
      session = nextSession;
      toolMetadata = nextToolMetadata;
      await restoreSessionRuntimeSelection();
    } catch (error) {
      await nextSdk.close().catch(() => undefined);
      throw error;
    }
    await previousSdk.close().catch(() => undefined);
  }

  const approver: HadamardToolApprover = async (context) => {
    const outcome = await new Promise<'allow' | 'always' | 'always-user' | 'deny'>((resolve) => {
      dialog = {
        toolName: context.publicName,
        summary: summarizeForDialog(context.input),
        selected: 0,
        resolve,
      };
      renderDynamic();
    });
    dialog = null;
    renderDynamic();
    if (outcome === 'always' || outcome === 'always-user') {
      const state = session.permissionContext;
      const permissions = state.permissions.filter(
        rule => !(rule.toolName === context.publicName && rule.behavior === 'allow'),
      );
      const source: 'project' | 'user' = outcome === 'always-user' ? 'user' : 'project';
      permissions.push({
        toolName: context.publicName,
        behavior: 'allow',
        source,
      });
      await session.setPermissionContext({
        mode: state.mode ?? permissionMode,
        permissions,
        approver,
      });
      return { behavior: 'allow', reason: `Approved (always — ${source} scope) in TUI.` };
    }
    return outcome === 'allow'
      ? { behavior: 'allow', reason: 'Approved in TUI.' }
      : { behavior: 'deny', reason: 'Denied in TUI permission dialog.' };
  };

  applyPlanPermission = async () => {
    await session.setPermissionContext({ mode: 'plan', permissions: [], approver });
  };

  const canUseTool: HadamardCanUseTool | undefined =
    permissionMode === 'default'
      ? (context) => {
          if (context.publicName === 'Bash') {
            // Auto-allow read-only commands (ls, git status, cat, …) so the
            // default mode isn't a prompt on every harmless call (gap #12 vs
            // claude-code). Everything else still prompts. isReadOnlyBashCommand
            // is conservative — anything ambiguous falls through to 'ask'.
            const command = (context.input as { command?: unknown } | null)?.command;
            if (typeof command === 'string' && isReadOnlyBashCommand(command)) {
              return undefined;
            }
            return { behavior: 'ask', reason: 'Bash command may modify the workspace.' };
          }
          if (MUTATING_TOOLS.has(context.publicName)) {
            return { behavior: 'ask', reason: `${context.publicName} mutates the workspace.` };
          }
          return undefined;
        }
      : undefined;

  // User-configurable PreToolUse hooks from settings.json hooks.PreToolUse[].
  // Lazily reads the live settings so edits are picked up without a restart.
  // The classifier returns undefined (no-op) when no hooks match — so the run
  // path is unchanged for users who haven't configured any.
  const preToolUseHookClassifier = createPreToolUseHookClassifier(
    () => readPreToolUseHooks(getLoadedJsonConfig()?.raw),
  );

  function summarizeForDialog(input: unknown): string {
    if (typeof input !== 'object' || input === null) return '';
    const record = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'notebook_path', 'url', 'path']) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
    try {
      return JSON.stringify(record);
    } catch {
      return '';
    }
  }

  // ── Dynamic region rendering ───────────────────────────────────────

  /** Wrap content into `│ {content padded to width-4} │` with a border color. */
  function boxRow(content: string, borderColor: string): string {
    const inner = Math.max(screen.width - 4, 8);
    const contentWidth = stringWidth(content);
    const padded =
      contentWidth > inner
        ? truncateToWidth(content, inner)
        : content + ' '.repeat(inner - contentWidth);
    return `${borderColor}│${A.reset} ${padded} ${borderColor}│${A.reset}`;
  }

  function boxTop(borderColor: string): string {
    return `${borderColor}╭${'─'.repeat(Math.max(screen.width - 2, 2))}╮${A.reset}`;
  }

  function boxBottom(borderColor: string): string {
    return `${borderColor}╰${'─'.repeat(Math.max(screen.width - 2, 2))}╯${A.reset}`;
  }

  function promptDivider(): string {
    return `${A.gray}${'─'.repeat(Math.max(screen.width, 8))}${A.reset}`;
  }

  /** Insert an inverse-video caret at a display column of a plain line. */
  function withCaret(line: string, caretCol: number): string {
    let width = 0;
    let index = 0;
    for (const char of line) {
      if (width >= caretCol) break;
      width += stringWidth(char);
      index += char.length;
    }
    const before = line.slice(0, index);
    const rest = line.slice(index);
    const caretChar = rest.length > 0 ? [...rest][0]! : ' ';
    const after = rest.length > 0 ? rest.slice(caretChar.length) : '';
    return `${before}${A.inverse}${caretChar}${A.reset}${after}`;
  }

  function buildPromptBar(): string[] {
    const editorWidth = Math.max(screen.width - 4, 8); // '> ' prefix on the first row
    const lines: string[] = [];
    lines.push(promptDivider());
    if (editor.isEmpty()) {
      // Always-visible block caret on the empty input so the box reads as active.
      const placeholder = truncateToWidth('Try "write a test for <filepath>"', editorWidth - 4);
      lines.push(`${A.magenta}${PROMPT_GLYPH}${A.reset} ${A.inverse} ${A.reset} ${A.dim}${placeholder}${A.reset}`);
    } else {
      const visual = editor.visualLines(editorWidth - 1);
      visual.lines.forEach((line, row) => {
        const prefix = row === 0 ? `${A.magenta}${PROMPT_GLYPH}${A.reset} ` : '  ';
        const body = row === visual.cursorRow ? withCaret(line, visual.cursorCol) : line;
        lines.push(`${prefix}${body}`);
      });
    }
    lines.push(promptDivider());
    return lines;
  }

  // ── @-mention file completion ──────────────────────────────────────
  // Prefer git's view (tracked + untracked, honoring .gitignore) so the list
  // matches what the agent actually sees; fall back to a bounded fs walk for
  // non-git workspaces. Cached for the session and invalidated after each run.
  function loadWorkspaceFiles(): string[] {
    if (workspaceFiles) return workspaceFiles;
    try {
      const out = execSync('git ls-files --cached --others --exclude-standard', {
        cwd: workDir,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      workspaceFiles = out.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 8000);
    } catch {
      workspaceFiles = walkWorkspaceFiles(workDir, 8000);
    }
    return workspaceFiles;
  }

  function walkWorkspaceFiles(root: string, limit: number): string[] {
    const skip = new Set(['node_modules', '.git', 'dist', '.codegraph', '.next', 'coverage']);
    const out: string[] = [];
    const stack = [root];
    while (stack.length > 0 && out.length < limit) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!skip.has(entry.name) && !entry.name.startsWith('.')) stack.push(path.join(dir, entry.name));
        } else if (entry.isFile()) {
          out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
          if (out.length >= limit) break;
        }
      }
    }
    return out;
  }

  function atCompletions(token: string): string[] {
    const files = loadWorkspaceFiles();
    const query = token.toLowerCase();
    if (!query) return files.slice(0, 200);
    // Subsequence fuzzy match with path-aware scoring: prefer basename hits,
    // then prefix hits, then path depth (shorter = nearer the root = more
    // likely the file the user wants). Falls back to substring for short
    // tokens so exact-include still ranks well.
    const scored: { file: string; score: number }[] = [];
    for (const file of files) {
      const lower = file.toLowerCase();
      const slash = lower.lastIndexOf('/') + 1;
      const base = lower.slice(slash);
      let score = -1;
      if (base.startsWith(query)) score = 1000 - base.length;
      else if (lower.includes(query)) score = 800 - slash;
      else {
        // Subsequence fuzzy match: walk the path consuming the query in order.
        let qi = 0;
        for (let i = 0; i < lower.length && qi < query.length; i++) {
          if (lower[i] === query[qi]) qi++;
        }
        if (qi === query.length) score = 400 - slash - (lower.length - query.length) * 0.1;
      }
      if (score >= 0) scored.push({ file, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 200).map((s) => s.file);
  }

  function buildAtMenu(): string[] {
    const active = activeAtToken(editor.text, editor.cursor);
    if (!active) return [];
    const matches = atCompletions(active.token);
    if (matches.length === 0) {
      return [`${A.dim}  @${active.token} — no matching files${A.reset}`];
    }
    if (atSelected >= matches.length) atSelected = matches.length - 1;
    if (atSelected < 0) atSelected = 0;
    const windowStart = Math.max(
      0,
      Math.min(atSelected - MENU_MAX_ROWS + 1, matches.length - MENU_MAX_ROWS),
    );
    const visible = matches.slice(windowStart, windowStart + MENU_MAX_ROWS);
    const lines = visible.map((file, i) => {
      const index = windowStart + i;
      const display = truncateToWidth(file, Math.max(screen.width - 6, 12));
      return index === atSelected ? `${A.inverse} @${display} ${A.reset}` : `  ${A.cyan}@${display}${A.reset}`;
    });
    const hiddenAbove = windowStart;
    const hiddenBelow = matches.length - (windowStart + visible.length);
    if (hiddenAbove > 0 || hiddenBelow > 0) {
      const parts: string[] = [];
      if (hiddenAbove > 0) parts.push(`↑${hiddenAbove}`);
      if (hiddenBelow > 0) parts.push(`↓${hiddenBelow}`);
      lines.push(`${A.dim}  ${parts.join('  ')} more · ${atSelected + 1}/${matches.length} (↑/↓ · Tab/Enter to insert)${A.reset}`);
    }
    return lines;
  }

  /** Replace the active @-token with the highlighted file path. */
  function applyAtCompletion(): boolean {
    const active = activeAtToken(editor.text, editor.cursor);
    if (!active) return false;
    const matches = atCompletions(active.token);
    if (matches.length === 0) return false;
    const file = matches[Math.min(atSelected, matches.length - 1)]!;
    const before = editor.text.slice(0, active.start);
    const after = editor.text.slice(editor.cursor);
    const mention = `@${file} `;
    editor.setTextWithCursor(`${before}${mention}${after}`, before.length + mention.length);
    atSelected = 0;
    return true;
  }

  function buildMenu(): string[] {
    const matches = filterSlashCommands(editor.text);
    if (matches.length === 0) return [];
    if (menuSelected >= matches.length) menuSelected = matches.length - 1;
    if (menuSelected < 0) menuSelected = 0;
    const commandWidth = Math.min(28, Math.max(14, Math.floor(screen.width * 0.28)));
    const descriptionWidth = Math.max(screen.width - commandWidth - 4, 12);
    // Scroll a window of MENU_MAX_ROWS so the highlighted item stays visible and
    // commands past the cap (e.g. /workflows, /worktree, /team) are reachable
    // with the arrow keys instead of being clipped off the bottom.
    const windowStart = Math.max(
      0,
      Math.min(menuSelected - MENU_MAX_ROWS + 1, matches.length - MENU_MAX_ROWS),
    );
    const visible = matches.slice(windowStart, windowStart + MENU_MAX_ROWS);
    const lines = visible.map((name, i) => {
      const index = windowStart + i;
      const selected = index === menuSelected;
      const command = `/${name}`.padEnd(commandWidth);
      const label = selected ? `${A.inverse}${command}${A.reset}` : command;
      const description = truncateToWidth(TUI_SLASH_COMMANDS[name] ?? SUBCOMMAND_DESCRIPTIONS[name] ?? '', descriptionWidth);
      return `${label} ${A.dim}${description}${A.reset}`;
    });
    const hiddenAbove = windowStart;
    const hiddenBelow = matches.length - (windowStart + visible.length);
    if (hiddenAbove > 0 || hiddenBelow > 0) {
      const parts: string[] = [];
      if (hiddenAbove > 0) parts.push(`↑${hiddenAbove}`);
      if (hiddenBelow > 0) parts.push(`↓${hiddenBelow}`);
      lines.push(`${A.dim}  ${parts.join('  ')} more · ${menuSelected + 1}/${matches.length} (↑/↓ to scroll)${A.reset}`);
    }
    return lines;
  }

  function buildDialog(): string[] {
    if (!dialog) return [];
    const inner = Math.max(screen.width - 4, 8);
    const options = ['Yes', `Always ${dialog.toolName} (project)`, `Always ${dialog.toolName} (user)`, 'No (esc)'];
    const lines: string[] = [];
    lines.push(boxTop(A.yellow));
    lines.push(boxRow(`${A.bold}Permission required · ${dialog.toolName}${A.reset}`, A.yellow));
    lines.push(boxRow(`${A.dim}${truncateToWidth(dialog.summary || '(no arguments)', inner)}${A.reset}`, A.yellow));
    options.forEach((option, index) => {
      const selected = index === dialog!.selected;
      lines.push(
        boxRow(selected ? `${A.inverse} ${option} ${A.reset}` : `  ${option}`, A.yellow),
      );
    });
    lines.push(boxBottom(A.yellow));
    lines.push(`${A.dim}  y/enter approve · a always (project) · n/esc deny · ↑↓ select${A.reset}`);
    return lines;
  }

  function buildSelectionDialog(): string[] {
    if (!selectionDialog) return [];
    const filtered = filterTuiSelectionItems(
      selectionDialog.items,
      selectionDialog.query,
    );
    if (selectionDialog.selected >= filtered.length) {
      selectionDialog.selected = Math.max(filtered.length - 1, 0);
    }
    const lines = [
      boxTop(A.cyan),
      boxRow(`${A.bold}${selectionDialog.title}${A.reset}`, A.cyan),
    ];
    if (selectionDialog.subtitle) {
      lines.push(boxRow(`${A.dim}${selectionDialog.subtitle}${A.reset}`, A.cyan));
    }
    if (selectionDialog.searchable) {
      const query = selectionDialog.query || 'type to filter';
      lines.push(
        boxRow(
          `${A.magenta}›${A.reset} ${selectionDialog.query ? query : `${A.dim}${query}${A.reset}`}`,
          A.cyan,
        ),
      );
    }
    if (filtered.length === 0) {
      lines.push(boxRow(`${A.dim}No matching items${A.reset}`, A.cyan));
    } else {
      const visibleRows = Math.min(10, Math.max((process.stdout.rows ?? 24) - 10, 4));
      const start = Math.max(
        0,
        Math.min(
          selectionDialog.selected - Math.floor(visibleRows / 2),
          filtered.length - visibleRows,
        ),
      );
      for (let index = start; index < Math.min(start + visibleRows, filtered.length); index += 1) {
        const item = filtered[index]!;
        const description = item.description ? ` · ${item.description}` : '';
        const label = truncateToWidth(`${item.label}${description}`, Math.max(screen.width - 8, 8));
        lines.push(
          boxRow(
            index === selectionDialog.selected
              ? `${A.inverse} ${label} ${A.reset}`
              : `  ${label}`,
            A.cyan,
          ),
        );
      }
    }
    lines.push(boxBottom(A.cyan));
    lines.push(`${A.dim}  ↑↓ select · enter confirm · esc cancel${selectionDialog.searchable ? ' · type to filter' : ''}${A.reset}`);
    return lines;
  }

  function buildTextInputDialog(): string[] {
    if (!textInputDialog) return [];
    const value = textInputDialog.secret
      ? '•'.repeat(textInputDialog.editor.text.length)
      : textInputDialog.editor.text;
    const displayed = withCaret(value, textInputDialog.editor.cursor);
    const lines = [
      boxTop(A.cyan),
      boxRow(`${A.bold}${textInputDialog.title}${A.reset}`, A.cyan),
    ];
    if (textInputDialog.description) {
      lines.push(boxRow(`${A.dim}${textInputDialog.description}${A.reset}`, A.cyan));
    }
    lines.push(boxRow(`${textInputDialog.label}: ${displayed}`, A.cyan));
    lines.push(boxBottom(A.cyan));
    lines.push(`${A.dim}  enter confirm · esc cancel${textInputDialog.secret ? ' · value hidden' : ''}${A.reset}`);
    return lines;
  }

  /** Friendly permission label matching the /permissions presets. */
  function permissionLabel(): string {
    const m = currentPermissionMode();
    if (m === 'bypassPermissions') return 'full-access';
    if (m === 'acceptEdits') return 'workspace';
    if (m === 'default' && session.permissionContext.permissions.some((p) => p.behavior === 'deny')) return 'read-only';
    return m;
  }

  /** Always-visible mode + live context-usage line (usage shown as % of the window). */
  function buildModeLine(): string {
    const used = lastTokenEstimate ?? 0;
    const window = sdk.config.compact?.contextWindowTokens ?? 200_000;
    const pct = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0;
    const usedK = used >= 1000 ? `${(used / 1000).toFixed(used >= 100_000 ? 0 : 1)}k` : `${used}`;
    const ctxColor = pct >= 90 ? A.red : pct >= 70 ? A.yellow : A.dim;
    const modelLabel = activeRouter
      ? `router:${activeRouter.name}${routedModelLabel ? ` → ${routedModelLabel}` : ''}`
      : session.model;
    const bridgeTag = bridgeMode && activeBridgeConfig
      ? ` · bridge:${activeBridgeConfig.name}${bridgeModelLabel ? ` · ${bridgeModelLabel}` : ''}`
      : '';
    const teamLabel = activeTeamName
      ? `team:${activeTeamName}${teamPrefs.autoInvoke ? '' : ' (manual)'}`
      : 'team:none';
    const left = `${modelLabel} · ${permissionLabel()} · effort:${currentEffort() ?? 'auto'} · ${teamLabel}${bridgeTag}${goalContextLine()} · `;
    return `${A.dim}  ${left}${A.reset}${ctxColor}ctx ${pct}% (${usedK})${A.reset}`;
  }

  function buildStatusLine(): string[] {
    const modeLine = buildModeLine();
    if (!running) return [modeLine];
    const elapsed = Math.max(Math.round((Date.now() - runStartedAt) / 1000), 0);
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    const note = statusNote ? ` · ${statusNote}` : '';
    const queued = session.pendingInputCount > 0 ? ` · ${session.pendingInputCount} queued` : '';
    return [
      `${A.cyan}${frame}${A.reset} ${A.bold}Working…${A.reset}${A.dim} (${elapsed}s · ${runToolCount} tool${runToolCount === 1 ? '' : 's'}${note}${queued} · esc to interrupt)${A.reset}`,
      modeLine,
    ];
  }

  function buildHintLine(): string[] {
    if (running) {
      return [`${A.dim}  enter to queue a steering message · esc interrupt · ctrl+c twice to exit${A.reset}`];
    }
    return [`${A.dim}  ? shortcuts · / commands · @ files · \\↵ newline · ↑↓ history · ctrl+c clear/exit${A.reset}`];
  }

  function buildTodoPanel(): string[] {
    if (currentTodos.length === 0) return [];
    const max = 8;
    const visible = currentTodos.slice(0, max);
    const done = currentTodos.filter(t => t.status === 'completed').length;
    const lines: string[] = [
      `${A.dim}  tasks (${done}/${currentTodos.length})${A.reset}`,
    ];
    for (const t of visible) {
      let mark: string;
      let body: string;
      if (t.status === 'completed') {
        mark = `${A.green}✓${A.reset}`;
        body = `${A.dim}${truncateToWidth(t.content, screen.width - 6)}${A.reset}`;
      } else if (t.status === 'in_progress') {
        mark = `${A.cyan}▶${A.reset}`;
        // Show the present-continuous form while a task is actively executing.
        const text = t.activeForm ?? t.content;
        body = `${A.bold}${truncateToWidth(text, screen.width - 6)}${A.reset}`;
      } else {
        mark = `${A.dim}○${A.reset}`;
        body = `${truncateToWidth(t.content, screen.width - 6)}`;
      }
      lines.push(`  ${mark} ${body}`);
    }
    const more = currentTodos.length - max;
    if (more > 0) lines.push(`${A.dim}  … ${more} more${A.reset}`);
    return lines;
  }

  function renderDynamic(): void {
    const lines: string[] = [];
    lines.push(...buildStatusLine());
    const tail = flusher.tail();
    if (running && tail) {
      lines.push(tail);
    }
    // Live todo panel — shown whenever the agent has a plan, unless a modal
    // (permission/selection/text-input) is open (those take the region).
    if (currentTodos.length > 0 && !dialog && !selectionDialog && !textInputDialog) {
      lines.push(...buildTodoPanel());
    }
    if (dialog) {
      lines.push(...buildDialog());
    } else if (selectionDialog) {
      lines.push(...buildSelectionDialog());
    } else if (textInputDialog) {
      lines.push(...buildTextInputDialog());
    } else {
      lines.push(...buildPromptBar());
      const atMenu = buildAtMenu();
      if (atMenu.length > 0) {
        lines.push(...atMenu);
      } else {
        const menu = buildMenu();
        lines.push(...(menu.length > 0 ? menu : buildHintLine()));
      }
    }
    screen.setDynamic(lines);
  }

  function scheduleDynamicRender(): void {
    if (dynamicRenderTimer) return;
    dynamicRenderTimer = setTimeout(() => {
      dynamicRenderTimer = null;
      renderDynamic();
    }, DYNAMIC_FRAME_MS);
  }

  function cancelScheduledDynamicRender(): void {
    if (!dynamicRenderTimer) return;
    clearTimeout(dynamicRenderTimer);
    dynamicRenderTimer = null;
  }

  function appendStatic(lines: readonly string[]): void {
    screen.appendStatic(lines);
  }

  // Inline CLI spinner for long async operations (probe, reload).
  // Writes directly to stdout with \r — independent of the redrawable region.
  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let inlineSpinnerTimer: ReturnType<typeof setInterval> | null = null;
  function showSpinner(message: string): void {
    let i = 0;
    inlineSpinnerTimer = setInterval(() => {
      process.stdout.write(`\r${A.dim}${SPINNER[i++ % SPINNER.length]} ${message}${A.reset}`);
    }, 80);
  }
  function stopSpinner(): void {
    if (inlineSpinnerTimer) { clearInterval(inlineSpinnerTimer); inlineSpinnerTimer = null; }
    process.stdout.write('\r\x1b[K');
  }

  /** Run an async operation with an inline spinner — no flicker for sub-100ms ops. */
  async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    showSpinner(message);
    try {
      const result = await fn();
      const elapsed = Date.now() - start;
      if (elapsed < 120) await new Promise(r => setTimeout(r, 120 - elapsed)); // min display
      return result;
    } finally {
      stopSpinner();
    }
  }

  // ── Agent run ──────────────────────────────────────────────────────

  // /model router: pick a saved router profile (or turn routing off). When
  // active, each user turn is classified and routed to a model in startRun().
  async function chooseRouter(arg: string): Promise<void> {
    const turnOff = () => {
      activeRouter = null;
      routedModelLabel = null;
      appendStatic([...formatInfoLine('router off — using the fixed model'), '']);
    };
    if (arg === 'off' || arg === 'none') { turnOff(); return; }

    if (arg) {
      const found = loadRouterProfile(arg, sdk.config.workDir);
      if (!found) {
        appendStatic([...formatErrorLine(`router profile not found: ${arg}`), '']);
        return;
      }
      activeRouter = found.profile;
      routedModelLabel = null;
      appendStatic([...formatInfoLine(`router active: ${found.profile.name} — each turn is classified by ${found.profile.routerModel.model} and routed`), '']);
      return;
    }

    const profiles = listRouterProfiles(sdk.config.workDir);
    if (profiles.length === 0) {
      appendStatic([
        ...formatInfoLine('no router profiles found. Create one at ~/.hadamard/routers/<name>.json (routerModel + routes:[{ when, model, provider?, baseURL?, apiKey? }] + fallback).'),
        '',
      ]);
      return;
    }
    const items = [
      { id: '__off__', label: activeRouter ? `Turn router off (active: ${activeRouter.name})` : 'Router off (current)', description: 'use the fixed model for every turn' },
      ...profiles.map((p) => ({ id: `profile:${p.name}`, label: p.name, description: `${p.profile.routes.length} routes · classifier ${p.profile.routerModel.model} · ${p.source}` })),
    ];
    const choice = await selectItem({ title: 'Model router', subtitle: 'classify each turn and route to a model (may be cross-provider)', items });
    if (!choice) return;
    if (choice === '__off__') { turnOff(); return; }
    const found = loadRouterProfile(choice.slice('profile:'.length), sdk.config.workDir);
    if (found) {
      activeRouter = found.profile;
      routedModelLabel = null;
      appendStatic([...formatInfoLine(`router active: ${found.profile.name} — turns routed by ${found.profile.routerModel.model}`), '']);
    }
  }

  // Expand @<image-path> tokens into Anthropic image content blocks so the
  // user can attach screenshots/designs inline (gap #4, partial — clipboard
  // capture is platform-specific, so this is the @path route only). Returns a
  // string when there are no image refs (the common case) so the run path is
  // unchanged; otherwise a ContentBlockParam[] with text + base64 image blocks.
  function expandImageRefs(text: string): string | ContentBlockParam[] {
    const refs = text.match(/@([\w./\\-]+\.(?:png|jpe?g|gif|webp|bmp))/gi);
    if (!refs) return text;
    const blocks: ContentBlockParam[] = [];
    let cursor = 0;
    const seen = new Set<string>();
    let imagesAdded = 0;
    for (const ref of refs) {
      const raw = ref.slice(1); // strip @
      const resolved = path.resolve(workDir, raw);
      if (seen.has(resolved)) continue;
      let data: string;
      try {
        data = fs.readFileSync(resolved).toString('base64');
      } catch {
        continue; // not readable — leave the @token in the text below
      }
      const at = text.indexOf(ref, cursor);
      if (at > cursor) blocks.push({ type: 'text', text: text.slice(cursor, at) });
      const ext = path.extname(raw).slice(1).toLowerCase();
      const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data },
      });
      cursor = at + ref.length;
      seen.add(resolved);
      imagesAdded++;
    }
    if (cursor < text.length) blocks.push({ type: 'text', text: text.slice(cursor) });
    // If no image actually loaded, fall back to the original string so the run
    // path is unchanged (the @tokens stay literal for the model to ignore).
    return imagesAdded > 0 ? blocks : text;
  }

  async function startRun(text: string): Promise<void> {
    if (
      bridgeMode
      && activeBridgeConfig?.execution === 'cli'
          && isManagedExternalCliRuntime(activeBridgeConfig.runtime)
    ) {
      const conflictingRun = findConflictingExternalCliRun(
        activeBridgeConfig as SupportedExternalCliConfig,
      );
      if (conflictingRun) {
        appendStatic([
          ...formatErrorLine(`background run ${conflictingRun.runId} is still ${conflictingRun.status}; this native CLI session cannot run concurrently.`),
          ...formatInfoLine(`Wait for it to finish, or use /bridge runs and /bridge stop ${conflictingRun.runId}.`),
          '',
        ]);
        return;
      }
    }
    running = true;
    runStartedAt = Date.now();
    runToolCount = 0;
    statusNote = '';
    streamedTextSeen = false;
    lastTokenEstimate = undefined;
    abortCtrl = new AbortController();
    spinnerTimer = setInterval(() => {
      spinnerFrame += 1;
      renderDynamic();
    }, 120);

    appendStatic(formatUserPrompt(text));
    renderDynamic();

    // /model router: classify this turn and route it to a model (possibly on a
    // different provider). Only applies to the in-process SDK — bridge mode
    // runs on the fixed provider+model, so routing is skipped there.
    let routed: { model: string; modelApi: import('../types.js').CreateAgentSdkOptions['modelApi'] } | undefined;
    if (activeRouter && !bridgeMode) {
      try {
        const decision = await resolveRoutedRun(activeRouter, text, abortCtrl.signal);
        routed = { model: decision.model, modelApi: decision.modelApi };
        routedModelLabel = `${decision.label} (${decision.model})`;
        appendStatic(formatInfoLine(`router → ${routedModelLabel}`));
      } catch (error: any) {
        appendStatic(formatInfoLine(`router classification failed (${error.message}); using ${session.model}`));
      }
    }

    try {
      // Branch the event source. Bridge mode spawns the configured runtime CLI
      // and adapts its events into the same AgentEvent stream the rest of this
      // loop consumes — so a bridge run reuses the spinner, tool cards, Esc
      // interrupt, first-class session steering, and history exactly like a
      // normal run.
      let eventStream: AsyncIterable<AgentEvent>;
      let resultPromise: Promise<AgentRunResult>;
      const externalBridge = activeExternalBridgeRuntime();
      if (externalBridge && activeBridgeConfig) {
        statusNote = 'cli:' + activeBridgeConfig.runtime;
        const nativeStream = externalBridge.session.stream(text, {
          model: bridgeModelLabel ?? activeBridgeConfig.model,
          signal: abortCtrl.signal,
          permissionMode: currentExternalCliPermissionMode(),
        });
        const adapted = adaptBridgeRun(
          nativeStream,
          nativeStream.result,
          'tui-cli-' + runStartedAt,
          activeBridgeConfig.runtime,
        );
        eventStream = adapted;
        resultPromise = adapted.result;
      } else if (bridgeMode && activeBridgeModelApi) {
        // Bridge mode: run in-process through the selected config's
        // provider/apiKey/baseURL/model (no child process). Inject the
        // pre-built {model, modelApi} into session.stream — the /model
        // router's proven mechanism for cross-provider routing. Same
        // session → context intact; switching bridge↔hadamard is seamless.
        statusNote = `bridge:${activeBridgeConfig?.name ?? 'bridge'}`;
        const stream = session.stream(expandImageRefs(text), {
          systemPrompt: systemPrompt + buildAgentContext(),
          signal: abortCtrl.signal,
          permissionMode: currentPermissionMode(),
          effort: currentEffort(),
          approver,
          classifier: preToolUseHookClassifier,
          model: activeBridgeModelApi.model,
          modelApi: activeBridgeModelApi.modelApi,
          ...(activeTeamTool && teamPrefs.autoInvoke ? { tools: [...tools, activeTeamTool] } : {}),
          ...(canUseTool ? { canUseTool } : {}),
        });
        eventStream = stream;
        resultPromise = stream.result;
      } else {
        const stream = session.stream(expandImageRefs(text), {
          systemPrompt: systemPrompt + buildAgentContext(),
          signal: abortCtrl.signal,
          permissionMode: currentPermissionMode(),
          effort: currentEffort(),
          approver,
          classifier: preToolUseHookClassifier,
          ...(routed ? { model: routed.model, modelApi: routed.modelApi } : {}),
          ...(activeTeamTool && teamPrefs.autoInvoke ? { tools: [...tools, activeTeamTool] } : {}),
          ...(canUseTool ? { canUseTool } : {}),
        });
        eventStream = stream;
        resultPromise = stream.result;
      }
      const surfaceEvents = new LegacySurfaceEventPipeline();
      for await (const event of eventStream) {
        for (const surfaceEvent of surfaceEvents.projectFor(event, 'tui')) {
          handleSurfaceEvent(surfaceEvent);
        }
      }
      const result = await resultPromise;
      // Accumulate token + USD usage for /cost and /usage. The model is the
      // routed model (if a router is active) or the session model. Bridge runs
      recordUsage(routed?.model ?? activeBridgeModelApi?.model ?? bridgeModelLabel ?? session.model, result.usage as { input_tokens?: number; output_tokens?: number } | undefined);
      const rest = flusher.drain();
      if (rest.length > 0) appendStatic(rest);
      if (!flusher.hasContent && result.text && runHadNoStreamedText()) {
        appendStatic([result.text]);
      }
      if (
        externalBridge
        && activeBridgeConfig?.execution === 'cli'
        && isManagedExternalCliRuntime(activeBridgeConfig.runtime)
      ) {
        const externalConfig = activeBridgeConfig as SupportedExternalCliConfig;
        await rememberExternalNativeSession(externalConfig, externalBridge.session.id)
          .catch(() => undefined);
        await persistSessionRuntimeMetadata(session, externalConfig, bridgeModelLabel)
          .catch(() => undefined);
        if (result.text) {
          await session.appendMessages([
            { role: 'user', content: text },
            { role: 'assistant', content: result.text },
          ]).catch(() => undefined);
        }
      }
      if (result.incompleteReason) {
        appendStatic(formatInfoLine(`run incomplete: ${result.incompleteReason}`));
      }
      appendStatic(['']);
    } catch (error) {
      const rest = flusher.drain();
      if (rest.length > 0) appendStatic(rest);
      const err = error as Error;
      if (err.name === 'RunAbortedError' || err.name === 'AbortError' || abortCtrl?.signal.aborted) {
        appendStatic([`${A.yellow}⏹ interrupted${A.reset}`, '']);
      } else {
        appendStatic([...formatErrorLine(err.message), '']);
      }
    } finally {
      running = false;
      abortCtrl = null;
      workspaceFiles = null; // the agent may have created/removed files — refresh @-completion
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
      }
      cancelScheduledDynamicRender();
      renderDynamic();
    }

  }

  function runHadNoStreamedText(): boolean {
    return !streamedTextSeen;
  }

  function handleSurfaceEvent(event: SurfaceSemanticEvent): void {
    const data = event.data;
    switch (event.type) {
      case 'run.started':
        streamedTextSeen = false;
        streamedThinkingSeen = false;
        return;
      case 'request.started':
        lastTokenEstimate = typeof data.requestTokenEstimate === 'number'
          ? data.requestTokenEstimate
          : undefined;
        renderDynamic();
        return;
      case 'text.delta': {
        const delta = typeof data.delta === 'string' ? data.delta : '';
        if (!delta) return;
        streamedTextSeen = true;
        const flushed = flusher.push(delta);
        if (flushed.length > 0) appendStatic(flushed);
        scheduleDynamicRender();
        return;
      }
      case 'reasoning.delta': {
        const delta = typeof data.delta === 'string' ? data.delta : '';
        if (!delta) return;
        const lines = formatThinking(delta, screen.width);
        if (lines.length > 0) appendStatic(lines);
        streamedThinkingSeen = true;
        scheduleDynamicRender();
        return;
      }
      case 'tool.input.delta': {
        const name = typeof data.name === 'string' && data.name ? data.name : 'tool';
        const snapshot = typeof data.snapshot === 'string'
          ? data.snapshot.trim().replace(/\s+/g, ' ')
          : '';
        const preview = snapshot.length > 72 ? `${snapshot.slice(0, 69)}...` : snapshot;
        statusNote = preview ? `preparing ${name}: ${preview}` : `preparing ${name}`;
        scheduleDynamicRender();
        return;
      }
      case 'model.content': {
        const content = isRecord(data.content) ? data.content : undefined;
        if (data.kind === 'content' && content?.type === 'thinking' && !streamedThinkingSeen) {
          const thinking = typeof content.thinking === 'string' ? content.thinking : '';
          const lines = formatThinking(thinking, screen.width);
          if (lines.length > 0) appendStatic(lines);
        }
        return;
      }
      case 'tool.started': {
        const callId = typeof data.callId === 'string' ? data.callId : '';
        const publicName = typeof data.publicName === 'string'
          ? data.publicName
          : typeof data.name === 'string' ? data.name : 'tool';
        const input = data.input;
        const pending = flusher.drain();
        if (pending.length > 0) appendStatic(pending);
        runToolCount += 1;
        statusNote = publicName;
        if (callId) toolCallNames.set(callId, publicName);
        // Render Edit calls as a colored old→new diff instead of a one-liner.
        appendStatic(
          publicName === 'Edit'
            ? formatEditCall(input, screen.width)
            : formatToolCall(publicName, input, screen.width),
        );
        // Capture the live todo list from TodoWrite calls so the persistent
        // panel (renderDynamic) reflects the agent's current plan + progress.
        if (publicName === 'TodoWrite') {
          const todos = (isRecord(input) ? input.todos : undefined);
          if (Array.isArray(todos)) {
            currentTodos = todos
              .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
              .map(t => ({
                content: String(t.content ?? ''),
                status: String(t.status ?? 'pending'),
                activeForm: typeof t.activeForm === 'string' && t.activeForm ? t.activeForm : undefined,
              }));
            scheduleDynamicRender();
          }
        }
        renderDynamic();
        return;
      }
      case 'tool.progress': {
        const progress = isRecord(data.progress) ? data.progress : undefined;
        const message = typeof data.message === 'string'
          ? data.message
          : typeof progress?.message === 'string' ? progress.message : undefined;
        if (message) {
          statusNote = message;
          scheduleDynamicRender();
        }
        return;
      }
      case 'tool.completed':
      case 'tool.failed':
      case 'tool.rejected': {
        const callId = typeof data.callId === 'string' ? data.callId : '';
        const outputText = typeof data.outputText === 'string' ? data.outputText : '';
        statusNote = '';
        appendStatic(
          formatToolResult(
            {
              isError: data.isError === true,
              durationMs: typeof data.durationMs === 'number' ? data.durationMs : 0,
              outputText,
            },
            screen.width,
          ),
        );
        // Run matching PostToolUse hooks (fire-and-forget, never block).
        const toolName = callId ? toolCallNames.get(callId) : undefined;
        if (toolName) {
          runPostToolUseHooks(
            () => readPostToolUseHooks(getLoadedJsonConfig()?.raw),
            toolName,
            null as unknown,
            outputText,
            sdk.config.workDir,
          );
        }
        renderDynamic();
        return;
      }
      case 'compaction.completed':
        appendStatic(formatCompactNotice(
          typeof data.trigger === 'string' ? data.trigger : 'auto',
          typeof data.tokenEstimateBefore === 'number' ? data.tokenEstimateBefore : undefined,
          typeof data.tokenEstimateAfter === 'number' ? data.tokenEstimateAfter : undefined,
        ));
        return;
      case 'tool.permission':
        if (isRecord(data.decision) && data.decision.behavior === 'deny') {
          appendStatic(formatInfoLine(
            `permission denied: ${String(data.decision.publicName ?? 'tool')} — ${String(data.decision.reason ?? '')}`,
          ));
        }
        return;
      case 'error':
        appendStatic(formatErrorLine(typeof data.message === 'string' ? data.message : 'run failed'));
        return;
      default:
        return;
    }
  }

  // ── Slash commands ─────────────────────────────────────────────────

  function commandUsage(name: string): string {
    return interactiveCommandUsage(name);
  }

  async function resumeSession(
    sessionId: string,
    options: { allowAgent?: boolean } = {},
  ): Promise<boolean> {
    const listed = await sdk.sessions.list();
    const target = listed.find(item => item.id === sessionId);
    if (!target) {
      appendStatic([
        ...formatErrorLine(
          `No persisted conversation exists for '${sessionId}'. The execution record may outlive its session.`,
        ),
        '',
      ]);
      return false;
    }
    if (target?.kind === 'manager') {
      appendStatic([...formatErrorLine('Manager sessions live in the Project Manager panel only.'), '']);
      return false;
    }
    if (target.kind === 'agent' && !options.allowAgent) {
      appendStatic([
        ...formatErrorLine('Agent conversations open from /agents runs, /agents show, or /agents open.'),
        '',
      ]);
      return false;
    }
    session = await sdk.resumeSession(sessionId);
    await restoreSessionRuntimeSelection();
    appendStatic([
      ...formatInfoLine(`resumed: ${session.id} · ${session.title} · ${session.model}`),
      '',
    ]);
    return true;
  }

  async function chooseSessionToResume(): Promise<void> {
    const sessions = (await sdk.sessions.list()).filter(
      item => item.id !== session.id && isTuiChatSession(item),
    );
    if (sessions.length === 0) {
      appendStatic([...formatInfoLine('no other project sessions to resume'), '']);
      return;
    }
    const selected = await selectItem({
      title: 'Resume a project session',
      subtitle: sdk.config.sessionDirectory,
      items: sessions.map(item => ({
        id: item.id,
        label: item.title,
        description: [
          item.model,
          item.status,
          new Date(item.lastRunAt ?? item.updatedAt).toLocaleString(),
        ].join(' · '),
        detail: item.preview,
      })),
    });
    if (selected) await resumeSession(selected);
  }

  async function chooseModel(): Promise<void> {
    const items: TuiSelectionItem[] = [
      {
        id: 'default',
        label: 'Configured default',
        description: sdk.config.model,
      },
      ...(['min', 'medium', 'max'] as const)
        .filter(tier => Boolean(sdk.config.modelTiers[tier]))
        .map(tier => ({
          id: `tier:${tier}`,
          label: tier,
          description: sdk.config.modelTiers[tier],
        })),
      {
        id: 'custom',
        label: 'Enter a model ID',
        description: 'Session override',
      },
      {
        id: 'configure',
        label: 'Configure provider, API key, and models',
        description: 'Updates the active Hadamard Agent settings file',
      },
    ];
    const selected = await selectItem({
      title: 'Select model',
      subtitle: `Current: ${session.model}`,
      items,
      searchable: false,
    });
    if (!selected) return;
    if (selected === 'configure') {
      await configureModelSettings();
      return;
    }
    if (selected === 'custom') {
      const model = await promptText({
        title: 'Custom model',
        label: 'Model ID',
        initial: session.model,
      });
      if (!model?.trim()) return;
      await session.setModel(model.trim());
    } else if (selected === 'default') {
      await session.setModel(sdk.config.model);
    } else {
      await session.setModel(selected.slice('tier:'.length));
    }
    appendStatic([...formatInfoLine(`model set to: ${session.model}`), '']);
  }

  async function configureModelSettings(): Promise<void> {
    const store = await resolveHadamardSettingsStore({ configPath: options.configPath });
    const raw = structuredClone(store.raw);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (/^[A-Z0-9_]+$/.test(key) && typeof value === 'string') env[key] = value;
    }
    if (isRecord(raw.env)) {
      for (const [key, value] of Object.entries(raw.env)) {
        if (typeof value === 'string') env[key] = value;
      }
    }
    raw.env = env;
    let dirty = false;

    while (true) {
      const selected = await selectItem({
        title: 'Model and provider settings',
        subtitle: store.configPath,
        searchable: false,
        items: [
          {
            id: 'provider',
            label: 'Provider',
            description: env.HADAMARD_PROVIDER ?? sdk.config.provider,
          },
          {
            id: 'api-key',
            label: 'API key',
            description:
              env.HADAMARD_API_KEY || env.HADAMARD_AUTH_TOKEN ? 'configured' : 'not configured',
          },
          {
            id: 'base-url',
            label: 'Base URL',
            description: env.HADAMARD_BASE_URL || 'provider default',
          },
          ...(['min', 'medium', 'max'] as const).map(tier => ({
            id: `tier:${tier}`,
            label: `${tier} model`,
            description: env[`HADAMARD_DEFAULT_${tier.toUpperCase()}_MODEL`] || 'not configured',
          })),
          {
            id: 'save',
            label: 'Save and apply',
            description: dirty ? 'Unsaved changes' : 'No changes',
          },
          { id: 'cancel', label: 'Cancel' },
        ],
      });
      if (!selected || selected === 'cancel') return;
      if (selected === 'save') {
        if (!dirty) {
          appendStatic([...formatInfoLine('model settings unchanged'), '']);
          return;
        }
        await persistHadamardSettingsStore(store.configPath, raw);
        await loadJsonConfigFile(store.configPath);
        await withSpinner('reloading SDK', reloadCleanSdk);
        appendStatic([
          ...formatInfoLine(`model settings saved: ${store.configPath}`),
          '',
        ]);
        return;
      }
      if (selected === 'provider') {
        const provider = await selectItem({
          title: 'Select provider protocol',
          searchable: false,
          items: [
            { id: 'anthropic', label: 'Anthropic-compatible' },
            { id: 'openai', label: 'OpenAI-compatible' },
          ],
        });
        if (provider) {
          env.HADAMARD_PROVIDER = provider;
          dirty = true;
        }
        continue;
      }
      if (selected === 'api-key') {
        const apiKey = await promptText({
          title: 'Configure API key',
          label: 'API key',
          description: 'The value is masked and will not be written to the transcript.',
          secret: true,
        });
        if (apiKey?.trim()) {
          env.HADAMARD_API_KEY = apiKey.trim();
          delete env.HADAMARD_AUTH_TOKEN;
          dirty = true;
        }
        continue;
      }
      if (selected === 'base-url') {
        const baseUrl = await promptText({
          title: 'Configure base URL',
          label: 'Base URL',
          description: 'Leave empty to use the provider default.',
          initial: env.HADAMARD_BASE_URL ?? '',
        });
        if (baseUrl !== undefined) {
          if (baseUrl.trim()) env.HADAMARD_BASE_URL = baseUrl.trim();
          else delete env.HADAMARD_BASE_URL;
          dirty = true;
        }
        continue;
      }
      if (selected.startsWith('tier:')) {
        const tier = selected.slice('tier:'.length).toUpperCase();
        const key = `HADAMARD_DEFAULT_${tier}_MODEL`;
        const model = await promptText({
          title: `Configure ${tier.toLowerCase()} model`,
          label: 'Model ID',
          initial: env[key] ?? '',
        });
        if (model !== undefined) {
          if (model.trim()) env[key] = model.trim();
          else delete env[key];
          dirty = true;
        }
      }
    }
  }

  async function configureBridgeSettings(): Promise<void> {
    const store = await resolveHadamardSettingsStore({ configPath: options.configPath });
    const raw = structuredClone(store.raw);
    const bridge: Record<string, unknown> = (raw.bridge as Record<string, unknown>) ?? {};
    let dirty = false;

    const detections = await detectBridgeProviders();

    while (true) {
      const defaultLabel = (typeof bridge.defaultProvider === 'string' ? bridge.defaultProvider : 'claude');
      const providerItems = detections.map((d) => ({
        id: `provider:${d.id}`,
        label: `${d.id}${d.available ? '' : ' (not found)'}`,
        description: d.version ? `v${d.version}${d.path ? ` · ${d.path}` : ''}` : 'not detected',
      }));
      const selected = await selectItem({
        title: 'Bridge runtime settings',
        subtitle: store.configPath,
        searchable: false,
        items: [
          { id: 'default', label: 'Default provider', description: defaultLabel },
          ...providerItems,
          { id: 'save', label: 'Save and apply', description: dirty ? 'Unsaved changes' : 'No changes' },
          { id: 'cancel', label: 'Cancel' },
        ],
      });
      if (!selected || selected === 'cancel') return;
      if (selected === 'save') {
        if (!dirty) {
          appendStatic([...formatInfoLine('bridge settings unchanged'), '']);
          return;
        }
        raw.bridge = bridge;
        await persistHadamardSettingsStore(store.configPath, raw);
        await loadJsonConfigFile(store.configPath);
        appendStatic([...formatInfoLine(`bridge settings saved: ${store.configPath}`), '']);
        return;
      }
      if (selected === 'default') {
        const providerChoices = detections.map((d) => ({
          id: d.id,
          label: d.id,
          description: d.available ? (d.version ?? 'detected') : 'not found',
        }));
        const provider = await selectItem({
          title: 'Select default bridge provider',
          searchable: false,
          items: providerChoices,
        });
        if (provider) {
          bridge.defaultProvider = provider;
          dirty = true;
        }
        continue;
      }
      if (selected.startsWith('provider:')) {
        const pid = selected.slice('provider:'.length);
        const providers: Record<string, unknown> = (bridge.providers as Record<string, unknown>) ?? {};
        const entry: Record<string, unknown> = (providers[pid] as Record<string, unknown>) ?? {};
        const pathInput = await promptText({
          title: `Executable path for ${pid}`,
          label: 'Path',
          description: `Leave empty to auto-detect on PATH. Current: ${(entry.path as string) ?? 'auto'}`,
          initial: (entry.path as string) ?? '',
        });
        if (pathInput !== undefined) {
          if (pathInput.trim()) entry.path = pathInput.trim();
          else delete entry.path;
          providers[pid] = entry;
          bridge.providers = providers;
          dirty = true;
        }
        continue;
      }
    }
  }

  function requireActiveExternalCliConfig(action: string): SupportedExternalCliConfig | null {
    const config = activeBridgeConfig;
    if (!bridgeMode || !config) {
      appendStatic([
        ...formatErrorLine(`/bridge ${action} requires an active External CLI config.`),
        ...formatInfoLine('Use /bridge switch <name> to activate an External CLI config.'),
        '',
      ]);
      return null;
    }
    if (config.execution !== 'cli') {
      appendStatic([
        ...formatErrorLine(`/bridge ${action} is available only in External CLI mode.`),
        ...formatInfoLine(`The active config "${config.name}" uses Direct API mode.`),
        '',
      ]);
      return null;
    }
    if (!isManagedExternalCliRuntime(config.runtime)) {
      appendStatic([
        ...formatErrorLine(`External CLI control does not support runtime "${config.runtime}".`),
        ...formatInfoLine('Supported external runtimes: Claude Code, CodeWhale, Pi, Codex, Reasonix, and Crush.'),
        '',
      ]);
      return null;
    }
    return config as SupportedExternalCliConfig;
  }

  function printBridgeStatus(): void {
    if (!activeBridgeConfig) {
      appendStatic([
        `${A.bold}Bridge status${A.reset}`,
        `  ${A.dim}mode${A.reset}       off`,
        `  ${A.dim}background${A.reset} ${externalCliRuntimeManager.list().filter(run => run.hadamardSessionId === session.id && (run.status === 'queued' || run.status === 'running')).length} active`,
        '',
      ]);
      return;
    }

    const config = activeBridgeConfig;
    const activeRuns = externalCliRuntimeManager.list().filter(run =>
      run.hadamardSessionId === session.id
      && (run.status === 'queued' || run.status === 'running'),
    );
    const mode = config.execution === 'cli'
      ? 'External CLI'
      : (config.runtime === 'hadamard' ? 'Hadamard SDK' : 'Direct API');
    const lines = [
      `${A.bold}Bridge status${A.reset}`,
      `  ${A.dim}config${A.reset}     ${config.name}`,
      `  ${A.dim}mode${A.reset}       ${mode}`,
      `  ${A.dim}runtime${A.reset}    ${config.runtime}`,
      `  ${A.dim}model${A.reset}      ${bridgeModelLabel ?? config.model ?? 'runtime default'}`,
    ];
    if (config.execution === 'cli') {
      lines.push(
        `  ${A.dim}auth${A.reset}       ${config.authSource === 'apiKey' ? 'API key override' : 'native CLI login/config'}`,
        `  ${A.dim}cwd${A.reset}        ${sdk.config.workDir}`,
        `  ${A.dim}session${A.reset}    ${activeExternalBridgeRuntime()?.session.id ?? 'not started'}`,
        `  ${A.dim}background${A.reset} ${activeRuns.length} active`,
      );
    } else {
      lines.push(`  ${A.dim}external CLI controls are disabled for this config${A.reset}`);
    }
    lines.push('');
    appendStatic(lines);
  }

  async function printExternalCliHistory(nativeSessionId = ''): Promise<void> {
    const config = requireActiveExternalCliConfig('history');
    if (!config) return;
    try {
      const allSessions = (await listExternalCliSessions({
        runtimes: [config.runtime],
        crushCwd: sdk.config.workDir,
        hadamardHomeDir: sdk.config.homeDir,
      }))
        .filter(item => externalCliSessionMatchesConfig(item, {
          runtime: config.runtime,
          authSource: config.authSource,
          profileName: config.name,
        }, { hadamardHomeDir: sdk.config.homeDir }));
      if (nativeSessionId) {
        const summary = allSessions.find(item => item.nativeSessionId === nativeSessionId);
        if (!summary) {
          appendStatic([
            ...formatErrorLine(`native ${config.runtime} session not found: ${nativeSessionId}`),
            '',
          ]);
          return;
        }
        const nativeSession = await readExternalCliSession(summary.path, {
          detailMaxBytes: 512 * 1024,
          detailMaxMessages: 200,
          crushCwd: sdk.config.workDir,
          hadamardHomeDir: sdk.config.homeDir,
        });
        if (!nativeSession) {
          appendStatic([...formatErrorLine(`native session could not be read: ${nativeSessionId}`), '']);
          return;
        }
        const sourceLabel = externalCliHistorySourceLabel(summary);
        const detailLines: string[] = [
          `${A.bold}${externalCliPreview(nativeSession.summary.title, config) || nativeSessionId}${A.reset}`,
          `${A.dim}${config.runtime}${sourceLabel ? ` \u00b7 ${sourceLabel}` : ''} 路 ${nativeSessionId}${nativeSession.summary.cwd ? ` 路 ${externalCliDisplayText(nativeSession.summary.cwd, config)}` : ''}${A.reset}`,
          ...formatDivider(screen.width),
        ];
        if (nativeSession.truncated) {
          detailLines.push(`${A.dim}bounded transcript preview${A.reset}`, '');
        }
        for (const message of nativeSession.messages) {
          const model = message.model ? ` 路 ${externalCliDisplayText(message.model, config)}` : '';
          detailLines.push(`${A.bold}${message.role}${A.reset}${A.dim}${model}${A.reset}`);
          if (message.text) {
            const safeText = externalCliDisplayText(message.text, config);
            detailLines.push(...wrapToWidth(safeText, Math.max(20, screen.width - 4)).map(line => `  ${line}`));
          }
          if (message.tools?.length) {
            const safeTools = externalCliDisplayText(JSON.stringify(message.tools, null, 2) ?? '', config);
            detailLines.push(...wrapToWidth(safeTools, Math.max(20, screen.width - 4)).map(line => `  ${A.dim}${line}${A.reset}`));
          }
          detailLines.push('');
        }
        detailLines.push(...formatInfoLine(`Use /bridge resume ${nativeSessionId} to continue this native conversation.`), '');
        appendStatic(detailLines);
        return;
      }

      const sessions = allSessions.slice(0, 20);
      const runtimeLabel: Record<typeof config.runtime, string> = {
        claude: 'Claude Code',
        codewhale: 'CodeWhale',
        pi: 'Pi',
        codex: 'Codex',
        reasonix: 'Reasonix',
        crush: 'Crush',
      };
      const lines: string[] = [
        `${A.bold}${runtimeLabel[config.runtime]} native conversations${A.reset}`,
        ...formatDivider(screen.width),
      ];
      if (sessions.length === 0) {
        lines.push(`  ${A.dim}no native conversations found${A.reset}`);
      } else {
        for (const item of sessions) {
          const sourceLabel = externalCliHistorySourceLabel(item);
          lines.push(
            `  ${A.bold}${item.nativeSessionId}${A.reset} ${A.dim}· ${item.updatedAt} · ${item.messageCount} messages${sourceLabel ? ` \u00b7 ${sourceLabel}` : ''}${A.reset}`,
            `    ${externalCliPreview(item.title, config) || '(untitled)'}`,
          );
          if (item.cwd) lines.push(`    ${A.dim}${externalCliDisplayText(item.cwd, config)}${A.reset}`);
        }
      }
      lines.push(
        '',
        ...formatInfoLine('Use /bridge history <native-id> to inspect or /bridge resume <native-id> to continue.'),
        ...formatInfoLine('Credentials and history file paths stay hidden.'),
        '',
      );
      appendStatic(lines);
    } catch (error) {
      appendStatic([
        ...formatErrorLine(`could not read CLI history: ${externalCliDisplayText((error as Error).message, config)}`),
        '',
      ]);
    }
  }

  async function resumeExternalCliHistorySession(nativeSessionId: string): Promise<void> {
    const config = requireActiveExternalCliConfig('resume');
    if (!config) return;
    try {
      const summary = (await listExternalCliSessions({
        runtimes: [config.runtime],
        crushCwd: sdk.config.workDir,
        hadamardHomeDir: sdk.config.homeDir,
      }))
        .find(item => item.nativeSessionId === nativeSessionId && externalCliSessionMatchesConfig(
          item,
          {
            runtime: config.runtime,
            authSource: config.authSource,
            profileName: config.name,
          },
          { hadamardHomeDir: sdk.config.homeDir },
        ));
      if (!summary) {
        appendStatic([
          ...formatErrorLine(`native ${config.runtime} session not found: ${nativeSessionId}`),
          '',
        ]);
        return;
      }
      if (summary.cwd && !sameWorkspace(summary.cwd, sdk.config.workDir)) {
        appendStatic([
          ...formatErrorLine(`open the session workspace before resuming it: ${externalCliDisplayText(summary.cwd, config)}`),
          '',
        ]);
        return;
      }
      const runtimeKey = externalBridgeRuntimeKey(config);
      const existing = externalBridgeRuntimes.get(runtimeKey);
      if (existing) {
        await existing.client.close();
        externalBridgeRuntimes.delete(runtimeKey);
      }
      await rememberExternalNativeSession(config, summary.nativeSessionId);
      await persistSessionRuntimeMetadata(session, config, bridgeModelLabel);
      appendStatic([
        ...formatInfoLine(`native ${config.runtime} session selected: ${summary.nativeSessionId}`),
        ...formatInfoLine('The next message resumes that native conversation.'),
        '',
      ]);
    } catch (error) {
      appendStatic([
        ...formatErrorLine(`could not resume CLI history: ${externalCliDisplayText((error as Error).message, config)}`),
        '',
      ]);
    }
  }

  async function startExternalCliBackgroundRun(prompt: string): Promise<void> {
    const config = requireActiveExternalCliConfig('background');
    if (!config) return;
    const effort = currentEffort();
    const originSession = session;
    const originWorkDir = sdk.config.workDir;
    try {
      const run = await externalCliRuntimeManager.start({
        hadamardSessionId: originSession.id,
        configId: externalCliConfigId(config),
        cwd: originWorkDir,
        prompt,
        background: true,
        nativeSessionId: externalNativeSessionId(config, originSession, originWorkDir),
        clientOptions: {
          directCli: true,
          directCliProvider: config.runtime,
          workDir: sdk.config.workDir,
          authSource: config.authSource === 'apiKey' ? 'apiKey' : 'native',
          credentialProvider: config.credentialProvider,
          profileName: config.name,
          ...(config.authSource === 'apiKey'
            ? {
                apiKey: config.apiKey,
                baseURL: config.baseURL,
              }
            : {}),
          trustProjectResources: config.trustProjectResources,
        },
        sessionOptions: {
          title: `hadamard-tui-background-${config.runtime}-${config.name}`,
        },
        runOptions: {
          model: bridgeModelLabel ?? config.model,
          includePartialMessages: true,
          permissionMode: currentExternalCliPermissionMode(),
          ...(effort && effort !== 'auto' ? { effort } : {}),
        },
      });
      externalCliRunLabels.set(run.runId, {
        configName: config.name,
        runtime: config.runtime,
      });
      appendStatic([
        ...formatInfoLine(`background run queued · ${run.runId} · ${config.runtime} CLI`),
        ...formatInfoLine('Use /bridge runs to inspect it or /bridge stop <runId> to interrupt it.'),
        '',
      ]);
      void externalCliRuntimeManager.wait(run.runId).then(async completed => {
        if (!completed || shuttingDown) return;
        if (completed.status === 'completed' && completed.result) {
          const completedNativeSessionId = completed.nativeSessionId || completed.result.nativeSessionId;
          if (completedNativeSessionId) {
            await rememberExternalNativeSession(
              config,
              completedNativeSessionId,
              originSession,
              originWorkDir,
            );
          }
          await originSession.appendMessages([
            { role: 'user', content: prompt },
            { role: 'assistant', content: completed.result.text },
          ]);
        }
        const message = completed.status === 'completed'
          ? `background run completed · ${completed.runId}`
          : `background run ${completed.status} · ${completed.runId}${completed.error?.message ? ` · ${externalCliPreview(completed.error.message, config)}` : ''}`;
        appendStatic([...formatInfoLine(message), '']);
      }).catch(() => undefined);
    } catch (error) {
      appendStatic([
        ...formatErrorLine(`could not start background run: ${externalCliDisplayText((error as Error).message, config)}`),
        '',
      ]);
    }
  }

  function printExternalCliRuns(): void {
    const runs = externalCliRuntimeManager.list()
      .filter(run => run.hadamardSessionId === session.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 20);
    const lines: string[] = [
      `${A.bold}External CLI background runs${A.reset}`,
      ...formatDivider(screen.width),
    ];
    if (runs.length === 0) {
      lines.push(`  ${A.dim}no background runs in this TUI session${A.reset}`);
    } else {
      for (const run of runs) {
        const label = externalCliRunLabels.get(run.runId);
        const runtime = label?.runtime ?? 'external';
        const configName = label?.configName ?? 'unknown config';
        const runConfig = label ? findBridgeConfig(label.configName) : undefined;
        lines.push(
          `  ${A.bold}${run.runId}${A.reset} ${A.dim}· ${run.status} · ${runtime} · ${configName}${A.reset}`,
        );
        if (run.nativeSessionId) {
          lines.push(`    ${A.dim}native session: ${run.nativeSessionId}${A.reset}`);
        }
        const result = run.result?.text ? externalCliPreview(run.result.text, runConfig) : '';
        const error = run.error?.message ? externalCliPreview(run.error.message, runConfig) : '';
        if (result) lines.push(`    ${result}`);
        else if (error) lines.push(`    ${A.red}${error}${A.reset}`);
      }
    }
    lines.push('');
    appendStatic(lines);
  }

  function stopExternalCliRun(runId: string): void {
    const run = externalCliRuntimeManager.get(runId);
    if (!run || run.hadamardSessionId !== session.id) {
      appendStatic([...formatErrorLine(`unknown external CLI run: ${runId}`), '']);
      return;
    }
    if (!externalCliRuntimeManager.abort(runId)) {
      appendStatic([...formatInfoLine(`run ${runId} is already ${run.status}`), '']);
      return;
    }
    appendStatic([...formatInfoLine(`stopping background run · ${runId}`), '']);
  }

  async function runBridgePrompt(prompt: string): Promise<void> {
    // /bridge run forces a bridge turn. If no config is active, open the board
    // (or error if none saved) rather than auto-picking a detected runtime.
    if (!bridgeMode || !activeBridgeConfig) {
      const configs = readBridgeConfigs().configs;
      if (configs.length === 0) {
        appendStatic([...formatErrorLine('No bridge configs saved. Use /bridge config to add one.'), '']);
        return;
      }
      appendStatic([...formatInfoLine('No active bridge config — select one from the board.'), '']);
      return;
    }
    await startRun(prompt);
  }

  async function disableBridge(): Promise<void> {
    // Switch back to the SDK's default model/provider. The conversation
    // context stays intact (same session). Config stays saved for re-activation.
    clearBridgeSelection();
    await persistSessionRuntimeMetadata();
    appendStatic([
      ...formatInfoLine('bridge mode off — back to default provider (session intact)'),
      '',
    ]);
  }

  function printBridgeHelp(): void {
    appendStatic([
      ...formatInfoLine('/bridge sub-commands:'),
      `  ${A.dim}(bare)${A.reset}       — list saved configs; pick one to activate`,
      `  ${A.dim}config${A.reset}      — add / edit / remove named connection configs`,
      `  ${A.dim}run <prompt>${A.reset}  — run one turn through the active runtime`,
      `  ${A.dim}background <prompt>${A.reset} — start work in the active external CLI`,
      `  ${A.dim}runs${A.reset}        — list external CLI background runs`,
      `  ${A.dim}stop <runId>${A.reset} — interrupt a background run`,
      `  ${A.dim}status${A.reset}      — show execution, runtime, auth source, and session`,
      `  ${A.dim}history [native-id]${A.reset} — list or inspect native CLI conversations (paths hidden)`,
      `  ${A.dim}resume <native-id>${A.reset} — resume a native CLI conversation in this workspace`,
      `  ${A.dim}switch <name>${A.reset} — activate a saved config by name (or a raw provider id)`,
      `  ${A.dim}model [id]${A.reset} — set model for the current runtime`,
      `  ${A.dim}setup${A.reset}      — detect + configure paths (legacy)`,
      `  ${A.dim}off${A.reset}        — disable bridge mode`,
      `  ${A.dim}help${A.reset}       — show this list`,
        ...formatInfoLine('External CLI commands support every registered CLI runtime.'),
      ...formatInfoLine('Native auth lets each CLI read its own login/config; key overrides are'),
      ...formatInfoLine('injected into child processes and never printed in status or run output.'),
      ...formatInfoLine('Direct API configs keep using the existing in-process bridge path.'),
      '',
    ]);
  }

  async function openBridgeBoard(): Promise<void> {
    // The /bridge board lists SAVED connection configs (the user's presets).
    // Selecting one activates that runtime with the config's credentials
    // injected. No-config fallbacks (legacy provider switch, setup, detect)
    // live under the actions so nothing is lost.
    const configs = readBridgeConfigs().configs;
    const state = bridgeMode
      ? `${A.green}(active)${A.reset}`
      : `${A.dim}(idle)${A.reset}`;
    const activeCfg = activeBridgeConfig?.name ?? (bridgeMode ? 'active' : null);
    const lines: string[] = [
      `Bridge ${state}${activeCfg ? ` · ${A.bold}${activeCfg}${A.reset}` : ''}`,
      ...formatDivider(screen.width),
    ];
    if (configs.length === 0) {
      lines.push(`  ${A.dim}no saved configs — use "/bridge config" to add one${A.reset}`);
    } else {
      for (const c of configs) {
        const active = activeBridgeConfig?.name === c.name;
        const mark = active ? `${A.green}●${A.reset}` : `${A.dim}○${A.reset}`;
        const mode = c.execution === 'cli' ? 'External CLI' : (c.runtime === 'hadamard' ? 'Hadamard SDK' : 'Direct API');
        lines.push(`  ${mark} ${A.bold}${c.name}${A.reset} ${A.dim}· ${mode} · ${c.runtime}${A.reset}${c.model ? ` ${A.dim}· ${c.model}${A.reset}` : ''}`);
        lines.push(`      ${A.dim}${c.execution === 'cli' && c.authSource === 'native' ? 'auth: CLI login' : 'key: ' + maskApiKey(c.apiKey)}${c.baseURL ? ` · ${c.baseURL}` : ''}${A.reset}`);
      }
    }
    lines.push('');
    appendStatic(lines);

    const choice = await selectItem({
      title: 'Bridge',
      subtitle: activeCfg ? `active: ${activeCfg}` : 'no active config',
      searchable: false,
      items: [
        // One item per saved config → selecting activates it.
        ...configs.map(c => ({
          id: `c:${c.name}`,
          label: `${c.name}${activeBridgeConfig?.name === c.name ? ' *' : ''}`,
          description: `${c.execution === 'cli' ? 'External CLI' : 'Direct API'} · ${c.runtime}${c.execution === 'cli' ? ` · ${c.authSource === 'native' ? 'CLI login' : 'key override'}` : ''}${c.model ? ` · ${c.model}` : ''}`,
        })),
        { id: 'config', label: '⚙ Manage configs…', description: 'add / edit / remove saved configs' },
        { id: 'run', label: '▶ Run a prompt…', description: 'run one turn through the active runtime' },
        { id: 'model', label: '◈ Model', description: 'set model for the active runtime' },
        { id: 'setup', label: '✎ Edit paths…', description: 'per-provider executable + default (legacy)' },
        { id: 'detect', label: '↻ Re-detect runtimes', description: 're-scan PATH for installed CLIs' },
        ...(bridgeMode ? [{ id: 'off', label: '■ Disable bridge', description: 'back to in-process SDK' }] : []),
        { id: 'help', label: '? Help', description: 'show /bridge sub-commands' },
      ],
    });
    if (!choice) return;
    if (choice.startsWith('c:')) {
      const name = choice.slice(2);
      const cfg = configs.find(c => c.name === name);
      if (cfg) await activateBridgeConfig(cfg);
      return;
    }
    if (choice === 'config') { await manageBridgeConfigs(); return; }
    if (choice === 'run') {
      const task = await promptText({ title: 'Bridge run', label: 'Prompt' });
      if (task?.trim()) await runBridgePrompt(task.trim());
      return;
    }
    if (choice === 'model') { await selectBridgeModel(); return; }
    if (choice === 'setup') { await configureBridgeSettings(); return; }
    if (choice === 'detect') {
      const refreshed = await detectBridgeProviders();
      appendStatic(['', ...refreshed.map((d) => `${d.available ? '✔' : '✘'} ${d.id} ${d.version ?? ''}`), '']);
      return;
    }
    if (choice === 'off') { await disableBridge(); return; }
    if (choice === 'help') { printBridgeHelp(); return; }
  }

  // Activate a named bridge config — the in-process path. Pre-builds a ModelApi
  // via buildRouteModelApi so each turn can inject {model, modelApi} into
  // session.stream (same session, context naturally survives switching).
  async function activateBridgeConfig(config: PersistedBridgeConfig): Promise<boolean> {
    try {
      if (config.execution === 'cli') {
        if (!isManagedExternalCliRuntime(config.runtime)) {
          throw new Error(
            'External CLI mode requires an installed CLI runtime.',
          );
        }
        const externalConfig = config as SupportedExternalCliConfig;
        const fingerprint = externalBridgeFingerprint(externalConfig);
        const runtimeKey = externalBridgeRuntimeKey(externalConfig);
        let runtime = externalBridgeRuntimes.get(runtimeKey);
        if (runtime && runtime.fingerprint !== fingerprint) {
          await runtime.client.close();
          externalBridgeRuntimes.delete(runtimeKey);
          runtime = undefined;
        }
        const boundNativeSessionId = externalNativeSessionId(externalConfig);
        const resumed = Boolean(runtime || boundNativeSessionId);
        if (!runtime) {
          const client = await createHadamardBridgeSdk({
            directCli: true,
            directCliProvider: config.runtime,
            workDir: sdk.config.workDir,
            authSource: config.authSource === 'apiKey' ? 'apiKey' : 'native',
            credentialProvider: config.credentialProvider,
            profileName: config.name,
            ...(config.authSource === 'apiKey'
              ? {
                  apiKey: config.apiKey,
                  baseURL: config.baseURL,
                }
              : {}),
            trustProjectResources: config.trustProjectResources,
          });
          const sessionOptions = { title: 'hadamard-tui-' + config.runtime + '-' + config.name };
          const nativeSession = boundNativeSessionId
            ? await client.resumeSession(boundNativeSessionId, sessionOptions)
            : await client.createSession(sessionOptions);
          runtime = { client, session: nativeSession, fingerprint };
          externalBridgeRuntimes.set(runtimeKey, runtime);
        }
        activeBridgeModelApi = null;
        bridgeModelLabel = config.model ?? null;
        activeBridgeConfig = config;
        bridgeMode = true;
        await persistSessionRuntimeMetadata(session, config, bridgeModelLabel);
        appendStatic([
          ...formatInfoLine(
            'runtime active — '
              + config.runtime
              + ' CLI · '
              + (config.authSource === 'apiKey' ? 'API key override' : 'native CLI login')
              + ' · model: '
              + (config.model ?? 'runtime default')
              + (resumed ? ' · resumed' : ''),
          ),
          ...formatInfoLine(
            'working directory: ' + sdk.config.workDir + ' · native session: ' + runtime.session.id,
          ),
          '',
        ]);
        return true;
      }

      const hadamardUsesDefaults = config.runtime === 'hadamard'
        && !config.apiKey?.trim()
        && !config.baseURL?.trim();
      if (hadamardUsesDefaults) {
        activeBridgeModelApi = null;
        bridgeModelLabel = config.model ?? null;
        activeBridgeConfig = config;
        bridgeMode = false;
        await persistSessionRuntimeMetadata(session, config, bridgeModelLabel);
        appendStatic([
          ...formatInfoLine('Hadamard SDK active · model: ' + (config.model ?? session.model)),
          '',
        ]);
        return true;
      }
      const routed = await buildRouteModelApi({
        model: config.model || session.model,
        provider: config.provider,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        maxTokens: 32000,
      });
      activeBridgeModelApi = routed;
      bridgeModelLabel = routed.model;
      activeBridgeConfig = config;
      bridgeMode = true;
      await persistSessionRuntimeMetadata(session, config, bridgeModelLabel);
      appendStatic([
        ...formatInfoLine(`bridge active — config: ${config.name} · provider: ${config.provider} · model: ${routed.model}`),
        ...formatInfoLine(`apiKey: ${maskApiKey(config.apiKey)}${config.baseURL ? ` · baseURL: ${config.baseURL}` : ''}`),
        ...formatInfoLine(`normal prompts now run through ${config.name}; /bridge off switches back to the default provider`),
        '',
      ]);
      return true;
    } catch (error) {
      appendStatic([...formatErrorLine(`bridge activation failed: ${(error as Error).message}`), '']);
      return false;
    }
  }

  // /bridge config — manage named connection configs (the management screen).
  async function manageBridgeConfigs(): Promise<void> {
    while (true) {
      const store = readBridgeConfigs();
      const lines: string[] = [
        `${A.bold}Bridge configs${A.reset} ${A.dim}(~/.hadamard/bridge-configs.json)${A.reset}`,
      ];
      if (store.configs.length === 0) {
        lines.push(`  ${A.dim}no configs yet — add one to connect a runtime by name${A.reset}`);
      } else {
        for (const c of store.configs) {
          const active = activeBridgeConfig?.name === c.name;
          const star = active ? ` ${A.green}*${A.reset}` : '';
          lines.push(`  ${A.bold}${c.name}${A.reset} ${A.dim}· ${c.provider}${A.reset}${star}`);
          lines.push(`    ${A.dim}key: ${maskApiKey(c.apiKey)}${c.baseURL ? ` · ${c.baseURL}` : ''}${c.model ? ` · ${c.model}` : ''}${A.reset}`);
        }
      }
      lines.push('');
      appendStatic(lines);

      const choice = await selectItem({
        title: 'Bridge configs',
        searchable: false,
        items: [
          { id: 'add', label: '+ Add config…', description: 'open the config editor with empty fields' },
          ...(store.configs.length > 0
            ? [
                { id: 'edit', label: '✎ Edit config…', description: 'modify any field of a saved config' },
                { id: 'remove', label: '− Remove config…', description: 'delete a saved config' },
              ]
            : []),
          { id: 'back', label: '↩ Back', description: 'return to the prompt' },
        ],
      });
      if (!choice || choice === 'back') return;
      if (choice === 'add') {
        const created = await editBridgeConfig();
        if (created) {
          addBridgeConfig(created);
          appendStatic([...formatInfoLine(`saved config "${created.name}" — select it via /bridge to activate`), '']);
        }
        continue;
      }
      if (choice === 'edit') {
        const name = await selectItem({
          title: 'Edit config',
          searchable: false,
          items: store.configs.map(c => ({ id: c.name, label: c.name, description: `${c.provider} · ${maskApiKey(c.apiKey)}` })),
        });
        if (!name) continue;
        const existing = store.configs.find(c => c.name === name)!;
        const updated = await editBridgeConfig(existing);
        if (updated) {
          const wasActive = activeBridgeConfig?.name === existing.name
            || activeBridgeConfig?.name === updated.name;
          const previousRuntimeKey = wasActive
            && activeBridgeConfig?.execution === 'cli'
        && isManagedExternalCliRuntime(activeBridgeConfig.runtime)
            ? externalBridgeRuntimeKey(activeBridgeConfig as SupportedExternalCliConfig)
            : undefined;
          addBridgeConfig(updated); // dedupe-by-name replaces
          if (wasActive) {
            if (await activateBridgeConfig(updated)) {
              const nextRuntimeKey = updated.execution === 'cli'
        && isManagedExternalCliRuntime(updated.runtime)
                ? externalBridgeRuntimeKey(updated as SupportedExternalCliConfig)
                : undefined;
              if (previousRuntimeKey && previousRuntimeKey !== nextRuntimeKey) {
                const previousRuntime = externalBridgeRuntimes.get(previousRuntimeKey);
                await previousRuntime?.client.close().catch(() => undefined);
                externalBridgeRuntimes.delete(previousRuntimeKey);
              }
              appendStatic([...formatInfoLine(`active config "${updated.name}" updated and reactivated`), '']);
            }
          } else {
            appendStatic([...formatInfoLine(`config "${updated.name}" saved`), '']);
          }
        }
        continue;
      }
      if (choice === 'remove') {
        const name = await selectItem({
          title: 'Remove config',
          searchable: false,
          items: store.configs.map(c => ({ id: c.name, label: c.name, description: `${c.provider} · ${maskApiKey(c.apiKey)}` })),
        });
        if (!name) continue;
        removeBridgeConfig(name);
        if (activeBridgeConfig?.name === name) {
          await disableBridge();
          appendStatic([...formatInfoLine(`removed active config "${name}" and disabled bridge mode`), '']);
        } else {
          appendStatic([...formatInfoLine(`removed config "${name}"`), '']);
        }
        continue;
      }
    }
  }

  // Single-page config editor: shows ALL fields at once (with current values),
  // and the user can edit any field in any order — e.g. set the key, then go
  // back and change the name — before Save / Cancel. A field is selected via the
  // menu, re-prompted, then the loop re-renders the whole form with the new
  // value. Returns the config on Save, undefined on Cancel.
  async function editBridgeConfig(existing?: PersistedBridgeConfig): Promise<PersistedBridgeConfig | undefined> {
    // Work on a local copy so Cancel discards all edits.
    const draft: PersistedBridgeConfig = existing
      ? {
          name: existing.name,
          provider: existing.provider,
          runtime: existing.runtime,
          execution: existing.execution ?? 'api',
          authSource: existing.authSource ?? 'apiKey',
          ...(existing.apiKey ? { apiKey: existing.apiKey } : {}),
          ...(existing.baseURL ? { baseURL: existing.baseURL } : {}),
          ...(existing.model ? { model: existing.model } : {}),
          ...(existing.credentialProvider ? { credentialProvider: existing.credentialProvider } : {}),
          ...(existing.trustProjectResources ? { trustProjectResources: true } : {}),
        }
      : {
          name: '',
          provider: 'anthropic',
          runtime: 'claude',
          execution: 'cli',
          authSource: 'native',
        };

    // Lazy-detect: runtimes are probed only when the user opens the runtime
    // picker, so the form renders instantly. Cached after first probe.
    let detections: Awaited<ReturnType<typeof detectBridgeProviders>> | null = null;

    while (true) {
      // Render the live form.
      const header = existing ? `Editing "${existing.name}"` : 'New bridge config';
      const lines: string[] = [
        `${A.bold}${header}${A.reset} — edit any field, then Save`,
        ...formatDivider(screen.width),
        `  ${A.bold}name${A.reset}     ${draft.name || `${A.dim}(unset)${A.reset}`}`,
        `  ${A.bold}execution${A.reset} ${draft.execution === 'cli' ? 'External CLI' : (draft.runtime === 'hadamard' ? 'Hadamard SDK' : 'Direct API')}`,
        `  ${A.bold}runtime${A.reset}   ${A.bold}${draft.runtime}${A.reset} ${A.dim}(${draft.provider})${A.reset}`,
        `  ${A.bold}auth${A.reset}      ${draft.execution === 'cli' ? (draft.authSource === 'native' ? 'reuse CLI login' : 'API key override') : 'API adapter credentials'}`,
        `  ${A.bold}apiKey${A.reset}   ${maskApiKey(draft.apiKey)}`,
        `  ${A.bold}baseURL${A.reset} ${draft.baseURL || `${A.dim}(inherit)${A.reset}`}`,
        `  ${A.bold}key provider${A.reset} ${draft.credentialProvider || `${A.dim}(infer from model/runtime)${A.reset}`}`,
        `  ${A.bold}project config${A.reset} ${draft.trustProjectResources ? 'trusted' : 'not trusted'}`,
        `  ${A.bold}model${A.reset}    ${draft.model || `${A.dim}(inherit)${A.reset}`}`,
        '',
      ];
      appendStatic(lines);

      const choice = await selectItem({
        title: existing ? `Edit ${existing.name}` : 'New config',
        subtitle: 'edit any field in any order · Save to commit',
        searchable: false,
        items: [
          { id: 'name', label: `name: ${draft.name || '(unset)'}`, description: 'a label you pick, e.g. deepseek-claude' },
          { id: 'execution', label: `execution: ${draft.execution === 'cli' ? 'External CLI' : 'Direct API'}`, description: 'launch an installed CLI or use Hadamard API adapters' },
          { id: 'provider', label: `runtime: ${draft.runtime}`, description: `${draft.provider} · pick from detected runtimes` },
          { id: 'auth', label: `auth: ${draft.authSource === 'native' ? 'reuse CLI login' : 'API key override'}`, description: draft.execution === 'cli' ? 'credential source for the child CLI' : 'used by External CLI mode' },
          { id: 'apiKey', label: `apiKey: ${maskApiKey(draft.apiKey)}`, description: 'injected as the credential each turn (hidden input)' },
          { id: 'baseURL', label: `baseURL: ${draft.baseURL || '(inherit)'}`, description: 'the backend endpoint (e.g. https://api.deepseek.com)' },
          { id: 'credentialProvider', label: `key provider: ${draft.credentialProvider || '(infer)'}`, description: 'provider env mapping for multi-backend CLIs, e.g. openai, anthropic, deepseek' },
          { id: 'trustProjectResources', label: `project config: ${draft.trustProjectResources ? 'trusted' : 'not trusted'}`, description: 'allow runtime-specific project config; required for explicit-key Crush when config exists' },
          { id: 'model', label: `model: ${draft.model || '(inherit)'}`, description: 'optional model id' },
          { id: 'save', label: '💾 Save config', description: draft.name ? `commit "${draft.name}"` : 'a name is required to save' },
          { id: 'cancel', label: '✕ Cancel', description: 'discard changes' },
        ],
      });
      if (!choice || choice === 'cancel') return undefined;
      if (choice === 'save') {
        const name = draft.name.trim();
        if (!name) {
          appendStatic([...formatErrorLine('cannot save — name is required (edit the name field first)'), '']);
          continue;
        }
        if (draft.execution === 'cli' && !isManagedExternalCliRuntime(draft.runtime)) {
          appendStatic([
            ...formatErrorLine('External CLI mode requires a registered CLI runtime.'),
            '',
          ]);
          continue;
        }
        if (draft.execution === 'cli' && draft.authSource === 'apiKey' && !draft.apiKey) {
          appendStatic([
            ...formatErrorLine('API-key override requires an API key.'),
            '',
          ]);
          continue;
        }
        const config: PersistedBridgeConfig = {
          name,
          provider: draft.provider,
          runtime: draft.runtime,
          execution: draft.execution,
          authSource: draft.authSource,
        };
        if (draft.apiKey) config.apiKey = draft.apiKey;
        if (draft.baseURL) config.baseURL = draft.baseURL;
        if (draft.model) config.model = draft.model;
        if (draft.credentialProvider) config.credentialProvider = draft.credentialProvider;
        if (draft.trustProjectResources) config.trustProjectResources = true;
        return config;
      }
      if (choice === 'name') {
        const v = (await promptText({ title: 'Config name', label: 'name', initial: draft.name, description: 'a label you pick, e.g. deepseek-claude' }))?.trim();
        if (v !== undefined) draft.name = v;
        continue;
      }
      if (choice === 'execution') {
        const v = await selectItem({
          title: 'Execution mode',
          subtitle: 'API mode stays in Hadamard; CLI mode launches the installed runtime',
          searchable: false,
          items: [
            { id: 'cli', label: 'External CLI', description: 'Managed CLI child process with native session resume' },
            { id: 'api', label: 'Direct API', description: 'Hadamard provider adapter; no external CLI process' },
          ],
        });
        if (v === 'cli') {
          if (!isManagedExternalCliRuntime(draft.runtime)) {
            appendStatic([
              ...formatErrorLine('External CLI mode requires a registered CLI runtime.'),
              '',
            ]);
          } else {
            draft.execution = 'cli';
            draft.authSource = draft.authSource ?? 'native';
          }
        } else if (v === 'api') {
          draft.execution = 'api';
          draft.authSource = 'apiKey';
        }
        continue;
      }
      if (choice === 'auth') {
        if (draft.execution !== 'cli') {
          appendStatic([
            ...formatInfoLine('Authentication source applies to External CLI mode.'),
            '',
          ]);
          continue;
        }
        const v = await selectItem({
          title: 'CLI authentication',
          subtitle: 'Native login never copies credentials into Hadamard',
          searchable: false,
          items: [
            { id: 'native', label: 'Reuse CLI login / config', description: 'inherit HOME and let the CLI read its own credentials' },
            { id: 'apiKey', label: 'API key override', description: 'inject this config key into the child process only' },
          ],
        });
        if (v === 'native' || v === 'apiKey') draft.authSource = v;
        continue;
      }
      if (choice === 'provider') {
        // Show detected runtimes as the primary options; each maps to an
        // in-process provider. Detection is lazy — probed only when the user
        // opens this picker, so the form renders instantly.
        if (!detections) {
          detections = await withSpinner('scanning for runtimes', detectBridgeProviders);
        }
        const RUNTIME_MAP: Record<string, { provider: InProcessProvider; label: string }> = {
          claude: { provider: 'anthropic', label: 'claude' },
          codewhale: { provider: 'anthropic', label: 'codewhale' },
          reasonix: { provider: 'openai', label: 'reasonix' },
          pi: { provider: 'openai', label: 'pi' },
          codex: { provider: 'openai', label: 'codex' },
          crush: { provider: 'openai', label: 'crush' },
        };
        const curProvider = draft.provider;
        const curRuntime = draft.runtime;
        const items = detections.map(d => ({
          id: d.id,
          label: `${d.id}${d.id === curRuntime ? ' ✓' : ''}`,
          description: `${RUNTIME_MAP[d.id]?.provider ?? '?'}${d.available ? (d.version ? ` · v${d.version}` : ' · detected') : ' · not found'}${d.id === 'reasonix' ? ' · DeepSeek' : d.id === 'crush' ? ' · multi-backend' : ''}`,
        }));
        const v = await selectItem({
          title: 'Runtime',
          subtitle: curRuntime ? `current: ${curRuntime} (${curProvider})` : `current provider: ${curProvider}`,
          searchable: false,
          items,
        });
        if (v) {
          const mapped = RUNTIME_MAP[v] ?? { provider: 'anthropic' as InProcessProvider };
          draft.provider = mapped.provider;
          draft.runtime = v as PersistedBridgeConfig['runtime'];
        }
        continue;
      }
      if (choice === 'apiKey') {
        const initial = draft.apiKey;
        const v = await promptText({
          title: 'API key',
          label: 'api key',
          secret: true,
          initial,
          description: 'hidden input · clear to inherit from settings',
        });
        if (v !== undefined) draft.apiKey = v.trim() || undefined;
        continue;
      }
      if (choice === 'baseURL') {
        const v = (await promptText({ title: 'Base URL', label: 'base url', initial: draft.baseURL, description: 'the backend endpoint; leave empty to inherit' }))?.trim();
        if (v !== undefined) draft.baseURL = v || undefined;
        continue;
      }
      if (choice === 'credentialProvider') {
        const v = (await promptText({
          title: 'Credential provider',
          label: 'provider id',
          initial: draft.credentialProvider,
          description: 'openai, anthropic, deepseek, gemini, openrouter, etc.; leave empty to infer',
        }))?.trim();
        if (v !== undefined) draft.credentialProvider = v || undefined;
        continue;
      }
      if (choice === 'trustProjectResources') {
        const v = await selectItem({
          title: 'Project runtime config',
          subtitle: 'Project-local runtime files may change provider/tool behavior',
          searchable: false,
          items: [
            { id: 'no', label: 'Do not trust', description: 'use runtime defaults and managed credentials where supported' },
            { id: 'yes', label: 'Trust project config', description: 'allow project-local CLI resources and configuration' },
          ],
        });
        if (v === 'yes' || v === 'no') draft.trustProjectResources = v === 'yes';
        continue;
      }
      if (choice === 'model') {
        const v = (await promptText({
          title: 'Model',
          label: 'model',
          initial: draft.model,
          description: 'a model id (optional, e.g. deepseek-chat, claude-sonnet-4-6)',
        }))?.trim();
        if (v !== undefined) draft.model = v || undefined;
        continue;
      }
    }
  }

  async function switchBridgeProvider(target: string): Promise<void> {
    if (!target) {
      appendStatic([...formatInfoLine('usage: /bridge switch <config-name>  (or open /bridge to pick)'), '']);
      return;
    }
    const cfg = findBridgeConfig(target);
    if (cfg) {
      await activateBridgeConfig(cfg);
      return;
    }
    appendStatic([...formatErrorLine(`unknown config: ${target} — use /bridge config to add one, or open /bridge to pick`), '']);
  }

  async function selectBridgeModel(modelId = ''): Promise<void> {
    const cfgName = activeBridgeConfig?.name ?? 'active';
    if (modelId) {
      // Direct set: /bridge model claude-sonnet-4-6
      bridgeModelLabel = modelId;
      if (activeBridgeConfig) activeBridgeConfig = { ...activeBridgeConfig, model: modelId };
      await persistSessionRuntimeMetadata();
      appendStatic([...formatInfoLine(`bridge model → ${modelId}`), '']);
      return;
    }

    // Picker: prompt for a model ID.
    const v = (await promptText({
      title: `Bridge model for ${cfgName}`,
      label: 'Model ID',
      initial: bridgeModelLabel ?? '',
      description: 'enter the model id to use with the bridge config',
    }));
    if (v !== undefined) {
      bridgeModelLabel = v.trim() || null;
      if (activeBridgeConfig) {
        activeBridgeConfig = {
          ...activeBridgeConfig,
          ...(bridgeModelLabel ? { model: bridgeModelLabel } : { model: undefined }),
        };
      }
      await persistSessionRuntimeMetadata();
      appendStatic([...formatInfoLine(`bridge model → ${bridgeModelLabel || 'session default'}`), '']);
    }
  }

  async function chooseEffort(): Promise<void> {
    const selected = await selectItem({
      title: 'Select reasoning effort',
      subtitle: `Current: ${currentEffort() ?? 'auto'}`,
      searchable: false,
      items: [
        { id: 'auto', label: 'auto', description: 'Use the runtime default' },
        { id: 'low', label: 'low', description: 'Fast, direct reasoning' },
        { id: 'medium', label: 'medium', description: 'Balanced reasoning' },
        { id: 'high', label: 'high', description: 'Deeper reasoning and verification' },
        { id: 'max', label: 'max', description: 'Maximum supported reasoning effort' },
      ],
    });
    if (selected) await setEffort(selected);
  }

  async function setEffort(value: string): Promise<void> {
    if (value !== 'auto' && !isHadamardEffort(value)) {
      appendStatic([...formatErrorLine(`unknown effort: ${value}`), '']);
      return;
    }
    await session.mergeMetadata({
      [SESSION_EFFORT_KEY]: value,
    });
    appendStatic([...formatInfoLine(`effort set to: ${currentEffort() ?? 'auto'}`), '']);
  }

  // ── /goal: session-scoped goal managed by the shared GoalService ─────
  // The service is the single authority over goal lifecycle (see plan/13
  // P0.2); the TUI only reads and steers it (create/clear/pause/resume).
  // Complete/blocked are runtime-only transitions, set via the Goal tools.
  function goalService(): GoalService {
    return GoalService.forSession(session);
  }

  function goalContextLine(): string {
    // Normalize through the shared Goal schema while keeping status rendering
    // synchronous over the already-cached Session metadata.
    const goal = normalizeGoal(session.metadata[GOAL_METADATA_KEY], new Date().toISOString());
    if (!goal) return '';
    const marks: Record<string, string> = {
      active: `${A.green}▶${A.reset}`,
      paused: `${A.yellow}‖${A.reset}`,
      complete: `${A.dim}✓${A.reset}`,
      blocked: `${A.red}⊘${A.reset}`,
    };
    const mark = marks[goal.status ?? 'active'] ?? '';
    return ` · goal:${mark}${A.dim}${truncateToWidth(goal.objective, 30)}${A.reset}`;
  }

  async function showSkills(): Promise<void> {
    const skills = sdk.skills.listMetadata();
    if (skills.length === 0) {
      appendStatic([...formatInfoLine('no skills are registered'), '']);
      return;
    }
    const selected = await selectItem({
      title: 'Skills',
      items: skills.map(skill => ({
        id: skill.name,
        label: skill.displayName ? `${skill.displayName} (${skill.name})` : skill.name,
        description: `${skill.source} · ${skill.context}${skill.version ? ` · v${skill.version}` : ''}`,
        detail: `${skill.description} ${skill.whenToUse ?? ''}`,
      })),
    });
    const skill = skills.find(item => item.name === selected);
    if (skill) {
      const heading = skill.displayName ? `${skill.displayName} (/${skill.name})` : `/${skill.name}`;
      const ver = skill.version ? ` v${skill.version}` : '';
      appendStatic([
        `${A.cyan}${heading}${A.reset}${A.dim}${ver}${A.reset} ${skill.description}`,
        `${A.dim}${skill.whenToUse ?? `source: ${skill.source} · context: ${skill.context}`}${A.reset}`,
        '',
      ]);
    }
  }

  async function showAgents(): Promise<void> {
    const agents = sdk.agents.list();
    if (agents.length === 0) {
      appendStatic([...formatInfoLine('no subagents are registered'), '']);
      return;
    }
    const selected = await selectItem({
      title: 'Subagents',
      items: agents.map(agent => ({
        id: agent.name,
        label: agent.name,
        description: agent.model ?? 'inherits model',
        detail: agent.description,
      })),
    });
    const agent = agents.find(item => item.name === selected);
    if (agent) {
      appendStatic([
        `${A.cyan}${agent.name}${A.reset} ${agent.description}`,
        `${A.dim}model: ${agent.model ?? 'inherit'} · tools: ${agent.inheritDefaultTools ? 'inherit' : agent.toolNames.join(', ') || 'none'}${A.reset}`,
        '',
      ]);
    }
  }

  function flattenAgentExecutionNodes(view: AgentExecutionRootView): AgentExecutionNodeView[] {
    const nodes: AgentExecutionNodeView[] = [];
    const visit = (node: AgentExecutionNodeView): void => {
      nodes.push(node);
      node.children.forEach(visit);
    };
    if (view.root) visit(view.root);
    view.detached.forEach(visit);
    return nodes;
  }

  function formatAgentExecutionElapsed(elapsedMs: number): string {
    if (elapsedMs < 1_000) return `${elapsedMs}ms`;
    if (elapsedMs < 60_000) return `${Math.round(elapsedMs / 100) / 10}s`;
    return `${Math.floor(elapsedMs / 60_000)}m ${Math.round((elapsedMs % 60_000) / 1_000)}s`;
  }

  async function openAgentExecutionConversation(reference: string): Promise<void> {
    let snapshots;
    try {
      snapshots = await sdk.executions.listSnapshots();
    } catch (error) {
      appendStatic([...formatErrorLine(`could not load Agent executions: ${(error as Error).message}`), '']);
      return;
    }
    const views = snapshots.map(snapshot => createAgentExecutionRootView(snapshot));
    const node = views.flatMap(flattenAgentExecutionNodes).find(
      item => item.id === reference || item.sessionId === reference,
    );
    if (!node) {
      appendStatic([
        ...formatErrorLine(`No Agent execution or conversation matches '${reference}'. Use /agents runs to browse.`),
        '',
      ]);
      return;
    }
    await resumeSession(node.sessionId, { allowAgent: true });
  }

  async function showAgentExecution(rootExecutionId: string): Promise<void> {
    let snapshot;
    try {
      snapshot = await sdk.executions.getSnapshot(rootExecutionId);
    } catch (error) {
      appendStatic([...formatErrorLine(`could not load Agent execution: ${(error as Error).message}`), '']);
      return;
    }
    if (!snapshot) {
      appendStatic([
        ...formatErrorLine(`No Agent execution tree found for '${rootExecutionId}'. Use /agents runs to browse.`),
        '',
      ]);
      return;
    }
    const view = createAgentExecutionRootView(snapshot);
    const nodes = flattenAgentExecutionNodes(view);
    appendStatic([
      `${A.bold}Agent execution${A.reset} ${A.dim}${view.rootExecutionId}${A.reset}`,
      `${A.dim}${view.status} · ${view.nodeCount} agents · ${view.edgeCount} links · ${formatAgentExecutionElapsed(view.timing.elapsedMs)}${A.reset}`,
      ...formatAgentExecutionTreeLines(view, {
        prefix: '  ',
        includeActivity: true,
        includePlan: true,
        includeTiming: true,
        maxMetaWidth: Math.max(36, screen.width - 12),
      }),
      '',
    ]);
    if (nodes.length === 0) return;
    const selected = await selectItem({
      title: 'Agent execution conversations',
      subtitle: 'Choose an Agent or subagent to open its independent conversation',
      items: nodes.map(node => ({
        id: node.id,
        label: `${'  '.repeat(node.depth)}${node.displayName}`,
        description: `${node.status} · ${node.runtime}${node.model ? ` · ${node.model}` : ''}`,
        detail: [
          `session: ${node.sessionId}`,
          node.currentActivity?.summary,
          node.currentStep ? `current: ${node.currentStep.title}` : undefined,
          node.nextSteps.length ? `next: ${node.nextSteps.slice(0, 3).map(step => step.title).join(', ')}` : undefined,
        ].filter((value): value is string => Boolean(value)).join('\n'),
      })),
    });
    if (selected) await openAgentExecutionConversation(selected);
  }

  async function showAgentRuns(): Promise<void> {
    let snapshots;
    try {
      snapshots = await sdk.executions.listSnapshots();
    } catch (error) {
      appendStatic([...formatErrorLine(`could not load Agent executions: ${(error as Error).message}`), '']);
      return;
    }
    const project = createAgentExecutionProjectView(snapshots);
    if (project.totalExecutionCount === 0) {
      appendStatic([...formatInfoLine('no Agent executions are recorded for this project'), '']);
      return;
    }
    const summary = (label: string, executions: AgentExecutionRootView[]): string[] => [
      `${A.bold}${label}${A.reset} ${A.dim}(${executions.length})${A.reset}`,
      ...executions.map(execution =>
        `  ${execution.status === 'errored' ? A.red : execution.isActive ? A.green : A.dim}${execution.rootExecutionId}${A.reset} ${execution.displayName} · ${execution.nodeCount} agents · ${formatAgentExecutionElapsed(execution.timing.elapsedMs)}`,
      ),
    ];
    appendStatic([
      `${A.bold}Agent executions${A.reset} ${A.dim}${project.totalAgentCount} agent conversations${A.reset}`,
      ...summary('Active', project.active),
      ...summary('Completed', project.completed),
      '',
    ]);
    const selected = await selectItem({
      title: 'Agent execution runs',
      subtitle: `${project.activeExecutionCount} active · ${project.completedExecutionCount} completed`,
      items: [
        ...project.active.map(execution => ({
          id: execution.rootExecutionId,
          label: `Active · ${execution.displayName}`,
          description: `${execution.status} · ${execution.nodeCount} agents · ${execution.currentActivity?.summary ?? 'waiting'}`,
          detail: execution.rootExecutionId,
        })),
        ...project.completed.map(execution => ({
          id: execution.rootExecutionId,
          label: `Completed · ${execution.displayName}`,
          description: `${execution.status} · ${execution.nodeCount} agents · ${formatAgentExecutionElapsed(execution.timing.elapsedMs)}`,
          detail: execution.rootExecutionId,
        })),
      ],
    });
    if (selected) await showAgentExecution(selected);
  }

  async function showMcp(): Promise<void> {
    const byServer = new Map<string, typeof toolMetadata>();
    for (const tool of toolMetadata.filter(item => item.provider === 'mcp')) {
      const server = tool.server ?? 'mcp';
      const tools = byServer.get(server) ?? [];
      tools.push(tool);
      byServer.set(server, tools);
    }
    const persisted = readMcpServerConfig();
    const lines: string[] = [];
    if (byServer.size > 0) {
      lines.push(`${A.bold}Active MCP servers${A.reset} ${A.dim}(${byServer.size})${A.reset}`);
      for (const [server, tools] of byServer) {
        lines.push(`  ${A.green}●${A.reset} ${A.bold}${server}${A.reset} ${A.dim}— ${tools.length} tool${tools.length === 1 ? '' : 's'}${A.reset}`);
      }
    } else {
      lines.push(`${A.dim}no MCP servers are active${A.reset}`);
    }
    if (persisted.servers.length > 0) {
      lines.push(`${A.bold}Configured servers${A.reset} ${A.dim}(~/.hadamard/mcp.json)${A.reset}`);
      for (const s of persisted.servers) {
        lines.push(`  ${A.dim}·${A.reset} ${s.name} ${A.dim}→ ${s.command}${s.args?.length ? ' ' + s.args.join(' ') : ''}${A.reset}`);
      }
    }
    lines.push('');
    appendStatic(lines);

    const choice = await selectItem({
      title: 'MCP servers',
      searchable: false,
      items: [
        { id: 'add', label: '+ Add stdio server…', description: 'persist a stdio MCP server to ~/.hadamard/mcp.json' },
        ...(persisted.servers.length > 0
          ? [{ id: 'remove', label: '− Remove server…', description: 'delete a configured server and reload' }]
          : []),
        { id: 'reload', label: '↻ Reload SDK', description: 'recreate the client to pick up config changes' },
        ...(byServer.size > 0
          ? [...byServer.entries()].map(([server, tools]) => ({
              id: `view:${server}`,
              label: server,
              description: `${tools.length} tool${tools.length === 1 ? '' : 's'}: ${tools.map(t => t.name).slice(0, 6).join(', ')}${tools.length > 6 ? '…' : ''}`,
            }))
          : []),
      ],
    });
    if (!choice) return;
    if (choice === 'add') {
      const name = (await promptText({ title: 'MCP server name', label: 'name' }))?.trim();
      if (!name) return;
      const kind = await selectItem({
        title: 'Server type',
        items: [
          { id: 'stdio', label: 'stdio', description: 'local process (e.g. npx, python, a binary)' },
          { id: 'http', label: 'http', description: 'remote streamable HTTP MCP server (url)' },
        ],
      });
      if (!kind) return;
      if (kind === 'stdio') {
        const command = (await promptText({ title: `Command for ${name}`, label: 'command', description: 'e.g. npx or a binary path' }))?.trim();
        if (!command) return;
        const argsRaw = await promptText({ title: `Args for ${name}`, label: 'args', description: 'space-separated (optional)' });
        addMcpServer({ name, command, ...(argsRaw?.trim() ? { args: argsRaw.trim().split(/\s+/) } : {}) });
      } else {
        const url = (await promptText({ title: `URL for ${name}`, label: 'url', description: 'e.g. https://mcp.example.com' }))?.trim();
        if (!url) return;
        const headersRaw = await promptText({ title: `Headers for ${name}`, label: 'headers', description: 'key:value, comma-separated (optional)' });
        const headers: Record<string, string> | undefined = headersRaw?.trim() ? Object.fromEntries(headersRaw.split(',').map(p => p.split(':').map(s => s.trim())).filter(a => a.length === 2)) : undefined;
        addMcpServer({ name, url, ...(headers ? { headers } : {}) });
      }
      appendStatic([...formatInfoLine(`added MCP server "${name}" — reloading SDK`), '']);
      await withSpinner('reloading SDK', reloadCleanSdk);
      return;
    }
    if (choice === 'remove') {
      const name = await selectItem({
        title: 'Remove MCP server',
        searchable: false,
        items: persisted.servers.map(s => ({ id: s.name, label: s.name, description: `${s.command}` })),
      });
      if (!name) return;
      removeMcpServer(name);
      appendStatic([...formatInfoLine(`removed MCP server "${name}" — reloading SDK`), '']);
      await withSpinner('reloading SDK', reloadCleanSdk);
      return;
    }
    if (choice === 'reload') {
      await withSpinner('reloading SDK', reloadCleanSdk);
      appendStatic([...formatInfoLine('SDK reloaded — MCP config re-read'), '']);
      return;
    }
    if (choice.startsWith('view:')) {
      const server = choice.slice('view:'.length);
      appendStatic([
        `${A.cyan}${server}${A.reset}`,
        `${A.dim}${(byServer.get(server) ?? []).map(tool => tool.name).join(', ')}${A.reset}`,
        '',
      ]);
    }
  }

  async function showPlugins(): Promise<void> {
    const store = await resolveHadamardSettingsStore({ configPath: options.configPath });
    const managed = readManagedPluginCatalog(store.raw).plugins;
    const configuredDirs = Array.isArray(store.raw.pluginDirs)
      ? store.raw.pluginDirs.filter((value): value is string => typeof value === 'string')
      : [];
    const plugins = await discoverHadamardPlugins({
      workDir,
      homeDir: store.homeDir,
      configuredDirs,
    });
    const selected = await selectItem({
      title: 'Plugins',
      subtitle: 'Built-in managed integrations and local plugin manifests',
      items: [
        ...managed.map(plugin => ({
          id: `managed:${plugin.id}`,
          label: plugin.name,
          description: `${plugin.state} · ${plugin.description}`,
          detail: plugin.statusDetail ?? plugin.category,
        })),
        ...plugins.map(plugin => ({
          id: `local:${plugin.path}`,
          label: plugin.name,
          description: [plugin.version, plugin.capabilities.join(', ')].filter(Boolean).join(' · '),
          detail: `${plugin.description ?? ''} ${plugin.path}`,
        })),
      ],
    });
    if (selected?.startsWith('managed:')) {
      const id = selected.slice('managed:'.length);
      const plugin = managed.find(item => item.id === id);
      if (!plugin) return;
      const action = await selectItem({
        title: plugin.name,
        subtitle: plugin.description,
        searchable: false,
        items: [
          {
            id: 'toggle',
            label: plugin.state === 'available' ? 'Install' : plugin.enabled ? 'Disable' : 'Enable',
            description: `Current state: ${plugin.state}`,
          },
          {
            id: 'details',
            label: 'Show configuration status',
            description: plugin.secretConfigured ? 'Credential configured' : 'No plugin credential stored',
          },
        ],
      });
      if (action === 'toggle') {
        const raw = structuredClone(store.raw);
        const enabling = plugin.state === 'available' || !plugin.enabled;
        patchManagedPluginSettings(raw, plugin.id, { enabled: enabling });
        await persistHadamardSettingsStore(store.configPath, raw);
        await loadJsonConfigFile(store.configPath);
        await withSpinner('reloading managed plugins', reloadCleanSdk);
        appendStatic([
          ...formatInfoLine(`${plugin.name} ${enabling ? 'enabled' : 'disabled'}`),
          '',
        ]);
      } else if (action === 'details') {
        appendStatic([
          `${A.cyan}${plugin.name}${A.reset}`,
          `${A.dim}${plugin.description}${A.reset}`,
          `${A.dim}state: ${plugin.state} · credential: ${plugin.secretConfigured ? 'configured' : 'not configured'}${A.reset}`,
          ...formatInfoLine('Use GUI Customize for provider URLs, API keys, browser profiles, and health checks.'),
          '',
        ]);
      }
      return;
    }
    const localPath = selected?.startsWith('local:') ? selected.slice('local:'.length) : '';
    const plugin = plugins.find(item => item.path === localPath);
    if (plugin) {
      appendStatic([
        `${A.cyan}${plugin.name}${A.reset}${plugin.version ? ` ${plugin.version}` : ''}`,
        `${A.dim}${plugin.path} · ${plugin.capabilities.join(', ') || 'manifest only'}${A.reset}`,
        '',
      ]);
    }
  }

  async function showDreamMenu(): Promise<void> {
    const selected = await selectItem({
      title: 'Dream memory consolidation',
      searchable: false,
      items: [
        { id: 'status', label: 'Show dream state' },
        { id: 'run', label: 'Run consolidation now' },
      ],
    });
    if (selected) await runDreamCommand(selected);
  }

  async function runDreamCommand(action: string): Promise<void> {
    if (action === 'status') {
      const state = await session.dreamState();
      appendStatic([`${A.dim}${JSON.stringify(state, null, 2)}${A.reset}`, '']);
      return;
    }
    if (action !== 'run') {
      appendStatic([...formatErrorLine('usage: /dream [run|status]'), '']);
      return;
    }
    const result = await session.dream({ force: true });
    appendStatic([
      ...formatInfoLine(
        result.reason ?? (result.skipped ? 'dream skipped' : result.success ? 'dream completed' : 'dream failed'),
      ),
      '',
    ]);
  }

  async function runSlashCommand(raw: string): Promise<void> {
    const spaceIndex = raw.indexOf(' ');
    const name = (spaceIndex === -1 ? raw.slice(1) : raw.slice(1, spaceIndex)).toLowerCase();
    const args = spaceIndex === -1 ? '' : raw.slice(spaceIndex + 1).trim();
    appendStatic(formatUserPrompt(raw));
    commandBusy = true;
    renderDynamic();
    try {
      switch (name) {
        case 'help': {
          const selected = await selectItem({
            title: 'Help',
            items: Object.entries(TUI_SLASH_COMMANDS).map(([command, description]) => ({
              id: command,
              label: `/${command}`,
              description,
              detail: commandUsage(command),
            })),
          });
          if (selected) {
            appendStatic([
              `${A.cyan}${commandUsage(selected)}${A.reset}`,
              `${A.dim}${TUI_SLASH_COMMANDS[selected]}${A.reset}`,
              '',
            ]);
          }
          return;
        }
        case 'clear':
          process.stdout.write('\x1b[2J\x1b[H');
          renderDynamic();
          return;
        case 'init': {
          // Bootstrap a CLAUDE.md by having the agent explore the repo and
          // write concise guidance — complements the CLAUDE.md loader (the
          // generated file is then injected into every system prompt).
          await startRun(
            'Create or update a CLAUDE.md at the repo root with concise guidance for AI coding assistants: the build/test/lint/run commands, a short architecture overview, key conventions, and non-obvious gotchas. Explore with Glob, Grep, and Read first (package.json, README, existing CLAUDE.md, key source dirs). If a CLAUDE.md already exists, improve it without discarding user-authored sections. Keep it focused — no filler.',
          );
          return;
        }
        case 'exit':
        case 'quit':
          await shutdown(0);
          return;
        case 'model': {
          if (!args) {
            await chooseModel();
            return;
          }
          if (args === 'config') {
            await configureModelSettings();
            return;
          }
          if (args === 'router' || args.startsWith('router ')) {
            await chooseRouter(args.slice('router'.length).trim());
            return;
          }
          await session.setModel(args === 'default' ? sdk.config.model : args);
          appendStatic([...formatInfoLine(`model set to: ${session.model}`), '']);
          return;
        }
        case 'effort':
          if (!args) await chooseEffort();
          else await setEffort(args.toLowerCase());
          return;
        case 'permissions': {
          // Three presets, selectable or named directly:
          //   read-only  → deny mutating tools (read / search / web only)
          //   workspace  → acceptEdits (auto-accept edits in the workspace)
          //   full       → bypassPermissions (no prompts)
          const READONLY_DENY = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'PowerShell'];
          const presets: Record<string, { mode: HadamardPermissionMode; rules: HadamardPermissionRule[]; label: string }> = {
            'read-only': {
              mode: 'default',
              rules: READONLY_DENY.map((t) => ({ toolName: t, behavior: 'deny', source: 'permissions-preset' })),
              label: 'Read-only',
            },
            workspace: { mode: 'acceptEdits', rules: [], label: 'Workspace access' },
            full: { mode: 'bypassPermissions', rules: [], label: 'Full access' },
          };
          let key = args.trim().toLowerCase().replace(/[ _]/g, '-');
          if (!key) {
            const choice = await selectItem({
              title: 'Permission mode',
              subtitle: `current: ${session.permissionContext.mode ?? permissionMode}`,
              items: [
                { id: 'read-only', label: 'Read-only', description: 'Read, search, and web only — deny Write/Edit/Bash/NotebookEdit/PowerShell' },
                { id: 'workspace', label: 'Workspace access', description: 'Auto-accept edits in the workspace (acceptEdits)' },
                { id: 'full', label: 'Full access', description: 'No prompts — run any tool (bypassPermissions)' },
              ],
            });
            if (!choice) return;
            key = choice;
          }
          const preset = presets[key];
          if (!preset) {
            appendStatic([...formatErrorLine(`unknown permission preset: ${key} (read-only | workspace | full)`), '']);
            return;
          }
          await session.setPermissionContext({ mode: preset.mode, permissions: preset.rules, approver });
          appendStatic([
            ...formatInfoLine(`permissions: ${preset.label} — ${preset.mode}${preset.rules.length ? ` · ${preset.rules.length} deny rules` : ''}`),
            '',
          ]);
          return;
        }
        case 'plan': {
          // Plan mode (gap #6). The model can enter/exit via EnterPlanMode /
          // ExitPlanMode tools; /plan toggles the permission mode and lets the
          // user view/open the plan file the agent wrote.
          const arg = args.trim().toLowerCase();
          if (arg === 'off' || arg === 'approve') {
            if (arg === 'approve' && !readPlanFile(sdk.config.workDir)) {
              appendStatic([...formatErrorLine('there is no saved plan to approve'), '']);
              return;
            }
            await session.setPermissionContext({ mode: permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'default', permissions: [], approver });
            appendStatic([
              ...formatInfoLine(arg === 'approve'
                ? 'plan approved — implementation permissions restored'
                : 'plan mode off without approval'),
              '',
            ]);
            return;
          }
          if (arg === 'view') {
            const plan = readPlanFile(sdk.config.workDir);
            appendStatic(plan
              ? [
                  `${A.bold}Current plan · awaiting approval${A.reset}`,
                  '',
                  ...renderRichText(plan, screen.width),
                  '',
                ]
              : [...formatInfoLine('no saved plan yet'), '']);
            return;
          }
          if (arg === 'revise' || arg.startsWith('revise ')) {
            if (session.permissionContext.mode !== 'plan') {
              await session.setPermissionContext({ mode: 'plan', permissions: [], approver });
            }
            const feedback = args.trim().slice('revise'.length).trim();
            if (!feedback) {
              appendStatic([...formatInfoLine('plan remains read-only; use /plan revise <feedback>'), '']);
              return;
            }
            await startRun(
              `Revise the saved plan using this feedback. Stay in Plan mode and call ExitPlanMode again when ready:\n\n${feedback}`,
            );
            return;
          }
          if (arg === 'open') {
            const file = planFilePath(sdk.config.workDir);
            try {
              const editorBin = process.env.EDITOR || process.env.VISUAL || 'notepad';
              spawnSync(editorBin, [file], { stdio: 'ignore', shell: false });
            } catch {
              appendStatic([...formatErrorLine(`could not open plan file: ${file}`), '']);
            }
            return;
          }
          // Default: enter plan mode (if not already) and show the current plan.
          const current = session.permissionContext.mode;
          if (current !== 'plan') {
            await session.setPermissionContext({ mode: 'plan', permissions: [], approver });
            appendStatic([...formatInfoLine('plan mode on — mutating tools blocked; research, then ExitPlanMode'), '']);
          }
          const plan = readPlanFile(sdk.config.workDir);
          if (plan) {
            appendStatic([
              `${A.bold}Current plan${A.reset} ${A.dim}(${planFilePath(sdk.config.workDir)})${A.reset}`,
              '',
              ...renderRichText(plan, screen.width),
              '',
            ]);
          } else {
            appendStatic([...formatInfoLine('no plan yet — ask the agent to plan a task (it will call ExitPlanMode)'), '']);
          }
          return;
        }
        case 'checkpoint': {
          const [action = 'list', checkpointId, modeValue, ...flags] = args.trim().split(/\s+/u).filter(Boolean);
          if (action === 'list') {
            const checkpoints = await sdk.checkpoints.list(session.id);
            appendStatic(checkpoints.length > 0
              ? [
                  `${A.bold}Checkpoints${A.reset}`,
                  ...checkpoints.map(item =>
                    `  ${item.id}  ${A.dim}${item.status} · ${item.entries.length} file(s) · ${item.createdAt}${A.reset}`
                  ),
                  '',
                ]
              : [...formatInfoLine('no checkpoints for this Session'), '']);
            return;
          }
          if (!checkpointId) {
            appendStatic([...formatErrorLine('usage: /checkpoint show <id> | restore <id> [files|conversation|both] --confirm'), '']);
            return;
          }
          if (action === 'show') {
            const preview = await sdk.checkpoints.preview(session.id, checkpointId);
            appendStatic([
              `${A.bold}Checkpoint ${checkpointId}${A.reset}`,
              ...preview.files.map(file => `  ${file.action.padEnd(13)} ${file.path}${file.binary ? ' · binary' : ''}`),
              ...(preview.conflicts.length > 0
                ? ['', `${A.red}Conflicts${A.reset}`, ...preview.conflicts.map(conflict => `  ${conflict.path}: ${conflict.message}`)]
                : ['', `${A.dim}No restore conflicts detected.${A.reset}`]),
              '',
            ]);
            return;
          }
          if (action === 'restore') {
            const mode = ['files', 'conversation', 'both'].includes(modeValue ?? '')
              ? modeValue as import('../checkpoint/types.js').CheckpointRestoreMode
              : 'both';
            const confirmed = flags.includes('--confirm') || modeValue === '--confirm';
            if (!confirmed) {
              appendStatic([
                ...formatErrorLine(`preview first, then run /checkpoint restore ${checkpointId} ${mode} --confirm`),
                '',
              ]);
              return;
            }
            const preview = await sdk.checkpoints.preview(session.id, checkpointId);
            const result = await sdk.checkpoints.restore({
              sessionId: session.id,
              checkpointId,
              mode,
            });
            if (result.conflicts.length > 0) {
              appendStatic([
                ...result.conflicts.flatMap(conflict => formatErrorLine(`${conflict.path}: ${conflict.message}`)),
                '',
              ]);
              return;
            }
            if (result.conversationRestored && preview.checkpoint.conversationCheckpointId) {
              await session.restoreCheckpoint(preview.checkpoint.conversationCheckpointId);
            }
            appendStatic([
              ...formatInfoLine(`checkpoint restored · ${result.restoredFiles.length} file(s)${result.conversationRestored ? ' · conversation' : ''}`),
              '',
            ]);
            return;
          }
          appendStatic([...formatErrorLine('usage: /checkpoint list|show|restore'), '']);
          return;
        }
        case 'rewind': {
          const n = parseInt(args, 10);
          if (!n || n < 1) {
            appendStatic([...formatErrorLine('usage: /rewind <N> — drops the last N messages (best-effort, no file restore)'), '']);
            return;
          }
          const msgs = session.messages;
          if (n >= msgs.length) {
            appendStatic([...formatErrorLine('cannot rewind beyond session start'), '']);
            return;
          }
          const kept = msgs.slice(0, msgs.length - n);
          // Create a fresh session with only the kept messages.
          const nextSession = await sdk.createSession({ title: session.title, model: session.model });
          if (kept.length > 0) await nextSession.appendMessages(kept);
          // Switch the active session.
          const prevSession = session;
          session = nextSession;
          await restoreSessionRuntimeSelection();
          await prevSession.delete().catch(() => undefined);
          appendStatic([...formatInfoLine(`rewound ${n} message${n === 1 ? '' : 's'} (session ${session.id}), files unchanged`), '']);
          return;
        }
        case 'sessions': {
          if (args) {
            const value = (flag: string) => args.match(new RegExp(`(?:^|\\s)--${flag}\\s+("[^"]+"|\\S+)`))?.[1]?.replace(/^"|"$/g, '');
            const rawType = value('type') || 'user';
            const types = rawType === 'all'
              ? ['user', 'assistant-global', 'assistant-project', 'agent'] as const
              : [rawType as import('../storage/sessionCatalog.js').SessionCatalogType];
            const archiveFlag = value('archived') || 'active';
            const page = await (await interactiveSessionCatalog()).query({
              types: [...types],
              archived: archiveFlag === 'all' ? 'all' : archiveFlag === 'archived',
              ...(value('project') ? { projectPaths: [value('project')!] } : {}),
              ...(value('status')
                ? { runtimeStatuses: [value('status') as import('../storage/sessionCatalog.js').SessionCatalogRuntimeStatus] }
                : {}),
              keyword: value('query'),
              pageSize: 200,
            });
            appendStatic([
              ...(page.items.length
                ? page.items.map(item => `${item.pinned ? '★' : ' '} ${item.locator.sessionId} · ${item.projectName} · ${item.type} · ${item.title}${item.archived ? ' · archived' : ''}`)
                : formatInfoLine('no matching Sessions')),
              '',
            ]);
            return;
          }
          const sessions = (await sdk.sessions.list()).filter(isTuiChatSession);
          appendStatic([
            ...(sessions.length > 0
              ? sessions.map(item =>
                  `${item.id === session.id ? A.green : A.dim}${item.id}${A.reset} ${item.title} · ${item.model} · ${item.status}`,
                )
              : formatInfoLine('no stored sessions')),
            '',
          ]);
          return;
        }
        case 'resume': {
          if (!args) await chooseSessionToResume();
          else await resumeSession(args);
          return;
        }
        case 'tools':
          appendStatic([
            ...formatInfoLine(toolMetadata.map((tool) => tool.name).join(', ')),
            '',
          ]);
          return;
        case 'memory': {
          try {
            const { HadamardMemoryCommandService } = await import('../memory/memoryCommandService.js');
            const result = await new HadamardMemoryCommandService({
              memory: sdk.memory,
              proposals: sdk.memoryProposals,
              compactConfig: sdk.config.compact,
              sessionMemoryEffectiveLimit: Math.min(sdk.config.projectMemory.sessionMemory.maxOutputTokens, sdk.config.maxTokens, 20_000),
              getState: () => session.compactState(),
              extract: () => session.extractMemory({ force: true }),
            }).execute(args || 'status');
            appendStatic([
              `${A.bold}${result.title}${A.reset}`,
              ...formatInfoLine(result.message),
              ...(result.text ? result.text.split('\n').map(line => `${A.dim}${line}${A.reset}`) : []),
              ...(result.items ?? []).flatMap(item => [
                `  ${A.bold}${item.label}${A.reset}${item.description ? ` ${A.dim}· ${item.description}${A.reset}` : ''}`,
                ...(item.detail ? [`    ${A.dim}${item.detail}${A.reset}`] : []),
              ]),
              '',
            ]);
          } catch (error) {
            appendStatic([...formatErrorLine(error instanceof Error ? error.message : String(error)), '']);
          }
          return;
        }
        case 'context': {
          // Break down what is consuming the context window (gap #9 vs
          // claude-code's /context) — usage, messages, system prompt, tools,
          // the loaded CLAUDE.md sources, and the active config.
          const { resolveHadamardCompactBudget } = await import('../runtime/hadamardCompact.js');
          const compactBudget = resolveHadamardCompactBudget(sdk.config.compact);
          const window = compactBudget.effectiveContextWindowTokens;
          const used = lastTokenEstimate ?? 0;
          const pct = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0;
          const usedK = used >= 1000 ? `${(used / 1000).toFixed(1)}k` : `${used}`;
          const windowK = window >= 1000 ? `${(window / 1000).toFixed(0)}k` : `${window}`;
          const ctxColor = pct >= 90 ? A.red : pct >= 70 ? A.yellow : A.dim;
          const messages = session.messages.length;
          const sysChars = systemPrompt.length;
          const mcpCount = toolMetadata.filter(t => t.provider === 'mcp').length;
          const project = loadProjectContext(sdk.config.workDir);
          const team = activeTeamName ?? 'none';
          const router = activeRouter ? activeRouter.name : 'off';
          const bridge = bridgeMode && activeBridgeConfig ? activeBridgeConfig.name : 'off';
          appendStatic([
            `${A.bold}Context window${A.reset}`,
            `  ${ctxColor}${pct}% used (${usedK} / ${windowK} tokens)${A.reset}`,
            `  ${A.dim}raw window${A.reset}      ${compactBudget.rawContextWindowTokens}`,
            `  ${A.dim}compact limit${A.reset}  ${compactBudget.autoCompactTokenLimit} (${compactBudget.source})`,
            `  ${A.dim}messages${A.reset}        ${messages}`,
            `  ${A.dim}system prompt${A.reset}   ~${sysChars} chars`,
            `  ${A.dim}tools${A.reset}           ${toolMetadata.length}${mcpCount > 0 ? ` (${mcpCount} MCP)` : ''}`,
            `  ${A.dim}CLAUDE.md${A.reset}       ${project.sources.length ? project.sources.join(', ') : '(none loaded)'}`,
            `  ${A.dim}active${A.reset}         model=${session.model} · effort=${currentEffort() ?? 'auto'} · team=${team} · router=${router} · bridge=${bridge}`,
            '',
          ]);
          return;
        }
        case 'cost':
        case 'usage': {
          // Running token + spend totals for the session (gap #20).
          const fmtTok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
          const costStr = totalCostUsd === null
            ? `${A.dim}(unknown — model lacks pricing; set ~/.hadamard/pricing.json)${A.reset}`
            : `$${totalCostUsd.toFixed(4)}`;
          const lines = [
            `${A.bold}Session usage${A.reset}`,
            `  ${A.dim}tokens${A.reset}   ${fmtTok(totalInputTokens)} in · ${fmtTok(totalOutputTokens)} out`,
            `  ${A.dim}cost${A.reset}     ${costStr}`,
            `  ${A.dim}model${A.reset}    ${session.model}`,
          ];
          // Per-config breakdown panel.
          if (configUsage.size > 0) {
            lines.push('');
            lines.push(`${A.bold}By config${A.reset}`);
            for (const [name, rec] of configUsage) {
              const active = activeBridgeConfig?.name === name;
              const star = active ? ` ${A.green}*${A.reset}` : '';
              const cfgCost = configCost(name, rec);
              lines.push(`  ${A.bold}${name}${star}${A.reset}  ${A.dim}${rec.turns} turn${rec.turns === 1 ? '' : 's'}${A.reset}  ${fmtTok(rec.inputTokens)} in · ${fmtTok(rec.outputTokens)} out${cfgCost ? `  ${cfgCost}` : ''}`);
            }
          }
          lines.push('');
          appendStatic(lines);
          return;
        }
        case 'doctor': {
          // Configuration diagnostics (gap #21, partial). Checks the things a
          // user would actually need to fix to get a run working.
          const cfg = sdk.config;
          const ok = (b: boolean) => b ? `${A.green}✓${A.reset}` : `${A.red}✗${A.reset}`;
          const lines: string[] = [`${A.bold}Hadamard diagnostics${A.reset}`];
          // Model + provider
          lines.push(`  ${ok(Boolean(cfg.model))} model ${A.dim}${cfg.model || '(unset)'}${A.reset}`);
          lines.push(`  ${ok(Boolean(cfg.provider))} provider ${A.dim}${cfg.provider || '(unset)'}${A.reset}`);
          // API key (env or settings)
          const apiKey = cfg.apiKey ?? process.env.HADAMARD_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY;
          lines.push(`  ${ok(Boolean(apiKey))} api key ${A.dim}${apiKey ? 'set (' + maskKey(apiKey) + ')' : '(not set — set HADAMARD_API_KEY or configure via /model config)'}${A.reset}`);
          if (cfg.baseURL) lines.push(`  ${A.dim}base url${A.reset} ${cfg.baseURL}`);
          // Workspace + git
          let isGit = false;
          try { execSync('git rev-parse --is-inside-work-tree', { cwd: cfg.workDir, stdio: 'ignore' }); isGit = true; } catch { /* not git */ }
          lines.push(`  ${ok(true)} workdir ${A.dim}${cfg.workDir}${A.reset}`);
          lines.push(`  ${ok(isGit)} git repo ${A.dim}${isGit ? 'yes' : 'no'}${A.reset}`);
          // Session + permissions
          lines.push(`  ${ok(true)} session ${A.dim}${session.id}${A.reset} · ${session.messages.length} messages`);
          lines.push(`  ${ok(true)} permission mode ${A.dim}${currentPermissionMode()}${A.reset}`);
          lines.push(`  ${ok(toolMetadata.length > 0)} tools ${A.dim}${toolMetadata.length}${A.reset}`);
          // Context memory
          const project = loadProjectContext(cfg.workDir);
          lines.push(`  ${ok(project.sources.length > 0)} CLAUDE.md ${A.dim}${project.sources.length ? project.sources.join(', ') : '(none)'}${A.reset}`);
          // Bridge runtimes
          const detections = await withSpinner('detecting runtimes', detectBridgeProviders);
          const avail = detections.filter(d => d.available);
          lines.push(`  ${ok(avail.length > 0)} bridge runtimes ${A.dim}${avail.length ? avail.map(d => d.id).join(', ') : '(none on PATH)'}${A.reset}`);
          if (bridgeMode && activeBridgeConfig) {
            lines.push(`  ${A.dim}active bridge${A.reset} ${activeBridgeConfig.name}${bridgeModelLabel ? ` · ${bridgeModelLabel}` : ''}`);
          }
          lines.push('');
          appendStatic(lines);
          return;
        }
        case 'batch': {
          const file = args.trim();
          if (!file) {
            appendStatic([...formatErrorLine('usage: /batch <file> — runs each line as a separate turn'), '']);
            return;
          }
          let prompts: string[];
          try {
            const content = fs.readFileSync(path.resolve(workDir, file), 'utf-8');
            prompts = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
          } catch (error) {
            appendStatic([...formatErrorLine(`cannot read batch file: ${(error as Error).message}`), '']);
            return;
          }
          if (!prompts.length) {
            appendStatic([...formatInfoLine('batch file is empty'), '']);
            return;
          }
          appendStatic([...formatInfoLine(`batch: ${prompts.length} prompt${prompts.length === 1 ? '' : 's'} from ${file}`), '']);
          for (let i = 0; i < prompts.length; i++) {
            appendStatic([`${A.dim}[${i + 1}/${prompts.length}]${A.reset} ${A.bold}>${A.reset} ${truncateToWidth(prompts[i]!, 60)}`, '']);
            await startRun(prompts[i]!);
          }
          appendStatic([...formatInfoLine(`batch complete — ${prompts.length} prompt${prompts.length === 1 ? '' : 's'} done`), '']);
          return;
        }
        case 'goal': {
          const commandResult = await executeGoalCommand(goalService(), args);
          appendStatic([...formatInfoLine(commandResult.message), '']);
          return;
        }
        case 'review': {
          // Run a code-review prompt on the current git diff (gap #5 subset).
          let diff = '';
          try {
            diff = execSync('git diff', { cwd: workDir, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 15_000 }).trim();
          } catch { /* no diff available */ }
          if (!diff) {
            appendStatic([...formatInfoLine('no uncommitted changes to review — working tree is clean'), '']);
            return;
          }
          await startRun(
            'Review this code change for correctness bugs, security issues, and simplification opportunities. ' +
            'File-by-file, note any real problems with file_path:line_number. Skip trivial style nits.\n\n```diff\n' +
            diff.slice(0, 80_000) + '\n```',
          );
          return;
        }
        case 'stats': {
          const fmtTok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
          appendStatic([
            `${A.bold}Session stats${A.reset}`,
            `  ${A.dim}messages${A.reset}     ${session.messages.length}`,
            `  ${A.dim}tokens${A.reset}       ${fmtTok(totalInputTokens)} in · ${fmtTok(totalOutputTokens)} out`,
            `  ${A.dim}tools${A.reset}        ${toolMetadata.length}${toolMetadata.filter(t => t.provider === 'mcp').length ? ` (${toolMetadata.filter(t => t.provider === 'mcp').length} MCP)` : ''}`,
            `  ${A.dim}model${A.reset}       ${session.model}${bridgeMode && activeBridgeConfig ? ` · bridge:${activeBridgeConfig.name}` : ''}`,
            `  ${A.dim}plan mode${A.reset}   ${session.permissionContext.mode === 'plan' ? 'on' : 'off'}`,
            '',
          ]);
          return;
        }
        case 'export': {
          const file = args.trim() || `session-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
          const md = session.messages
            .map((m) => `## ${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}\n\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
            .join('\n\n---\n\n');
          try {
            fs.writeFileSync(path.resolve(workDir, file), md, 'utf-8');
            appendStatic([...formatInfoLine(`conversation exported to ${file}`), '']);
          } catch (error) {
            appendStatic([...formatErrorLine(`export failed: ${(error as Error).message}`), '']);
          }
          return;
        }
        case 'compact': {
          try {
            const summaryInstructions =
              args || undefined;
            const result = await session.compact({ force: true, summaryInstructions });
            if (!result.compacted) {
              appendStatic([
                ...formatErrorLine(result.error ?? `compact skipped: ${result.reason}`),
                '',
              ]);
              return;
            }
            const mode = sdk.config.compact?.compactPromptMode ?? 'hybrid';
            appendStatic([
              `${A.green}\u2713 compacted${A.reset}${A.dim} \u00b7 ${result.messagesRemoved ?? '?'} messages summarized \u00b7 mode: ${mode}${A.reset}`,
              '',
            ]);
          } catch (error) {
            appendStatic([...formatErrorLine((error as Error).message), '']);
          }
          return;
        }
        case 'dream': {
          try {
            if (!args) await showDreamMenu();
            else await runDreamCommand(args.toLowerCase());
          } catch (error) {
            appendStatic([...formatErrorLine((error as Error).message), '']);
          }
          return;
        }
        case 'skills':
          await showSkills();
          return;
        case 'agents': {
          const trimmedArgs = args.trim();
          const subcommandEnd = trimmedArgs.search(/\s/);
          const subcommand = (subcommandEnd < 0 ? trimmedArgs : trimmedArgs.slice(0, subcommandEnd))
            .toLowerCase() || 'list';
          const target = subcommandEnd < 0 ? '' : trimmedArgs.slice(subcommandEnd + 1).trim();
          if (subcommand === 'list') {
            if (target) {
              appendStatic([...formatErrorLine('usage: /agents [list|runs|show <root-execution-id>|open <session-or-execution-id>]'), '']);
            } else {
              await showAgents();
            }
            return;
          }
          if (subcommand === 'runs') {
            if (target) await showAgentExecution(target);
            else await showAgentRuns();
            return;
          }
          if (subcommand === 'show') {
            if (!target) {
              appendStatic([...formatErrorLine('usage: /agents show <root-execution-id>'), '']);
            } else {
              await showAgentExecution(target);
            }
            return;
          }
          if (subcommand === 'open') {
            if (!target) {
              appendStatic([...formatErrorLine('usage: /agents open <session-or-execution-id>'), '']);
            } else {
              await openAgentExecutionConversation(target);
            }
            return;
          }
          appendStatic([...formatErrorLine('usage: /agents [list|runs|show <root-execution-id>|open <session-or-execution-id>]'), '']);
          return;
        }
        case 'mcp':
          await showMcp();
          return;
        case 'hooks': {
          const raw = getLoadedJsonConfig()?.raw;
          const typedHooks = parseTypedHooks(raw?.typedHooks);
          const preHooks = readPreToolUseHooks(raw);
          const postHooks = readPostToolUseHooks(raw);
          const startHooks = readSessionStartHooks(raw);
          const total = typedHooks.hooks.length + preHooks.length + postHooks.length + startHooks.length;
          if (total === 0) {
            appendStatic([
              ...formatInfoLine('no hooks configured'),
              ...formatInfoLine('open GUI Settings > Hooks or add typedHooks to ~/.hadamard/settings.json'),
              '',
            ]);
          } else {
            const lines: string[] = [`${A.bold}Hooks${A.reset} ${A.dim}(${total})${A.reset}`];
            if (typedHooks.hooks.length > 0) {
              lines.push(`${A.bold}  Lifecycle${A.reset} ${A.dim}(${typedHooks.hooks.length})${A.reset}`);
              typedHooks.hooks.forEach((hook, index) => lines.push(
                `    ${A.dim}${index + 1}.${A.reset} ${A.bold}${hook.id}${A.reset} ${hook.event} ${A.dim}-> ${hook.handler.type}${A.reset}`,
              ));
            }
            typedHooks.issues.forEach(issue => lines.push(`    ${A.yellow}[invalid] ${issue}${A.reset}`));
            if (preHooks.length > 0) {
              lines.push(`${A.bold}  PreToolUse${A.reset} ${A.dim}(${preHooks.length}) — blocks tool on non-zero exit or "BLOCK" stdout${A.reset}`);
              preHooks.forEach((h, i) => lines.push(`    ${A.dim}${i + 1}.${A.reset} ${A.bold}${h.matcher}${A.reset} ${A.dim}→${A.reset} ${truncateToWidth(h.command, 50)}`));
            }
            if (postHooks.length > 0) {
              lines.push(`${A.bold}  PostToolUse${A.reset} ${A.dim}(${postHooks.length}) — fire-and-forget after tool completes${A.reset}`);
              postHooks.forEach((h, i) => lines.push(`    ${A.dim}${i + 1}.${A.reset} ${A.bold}${h.matcher}${A.reset} ${A.dim}→${A.reset} ${truncateToWidth(h.command, 50)}`));
            }
            if (startHooks.length > 0) {
              lines.push(`${A.bold}  SessionStart${A.reset} ${A.dim}(${startHooks.length}) — fire-and-forget on session init${A.reset}`);
              startHooks.forEach((h, i) => lines.push(`    ${A.dim}${i + 1}.${A.reset} ${A.dim}→${A.reset} ${truncateToWidth(h.command, 50)}`));
            }
            lines.push('');
            appendStatic(lines);
          }
          return;
        }
        case 'plugins':
          await showPlugins();
          return;
        case 'plugin': {
          try {
            const { PluginPackageManager } = await import('../plugins/pluginManager.js');
            const manager = new PluginPackageManager(
              path.join(sdk.config.homeDir, 'plugin-packages'),
              process.env.HADAMARD_PLUGIN_REGISTRY,
              sdk.config.effectivePolicy,
            );
            const result = await manager.execute(args || 'list');
            appendStatic([
              ...formatInfoLine(result.message),
              ...(result.items ?? []).map(item => `  ${A.bold}${item.label}${A.reset}${item.description ? ` ${A.dim}· ${item.description}${A.reset}` : ''}`),
              '',
            ]);
          } catch (error) {
            appendStatic([...formatErrorLine(error instanceof Error ? error.message : String(error)), '']);
          }
          return;
        }
        case 'rules': {
          try {
            const { RuleCommandService } = await import('../context/ruleCommandService.js');
            const result = await new RuleCommandService(
              sdk.config.homeDir,
              sdk.config.workDir,
            ).execute(args || 'list');
            appendStatic([
              ...formatInfoLine(result.message),
              ...(result.items ?? []).map(item => `  ${A.bold}${item.label}${A.reset}${item.description ? ` ${A.dim}· ${item.description}${A.reset}` : ''}`),
              '',
            ]);
          } catch (error) {
            appendStatic([...formatErrorLine(error instanceof Error ? error.message : String(error)), '']);
          }
          return;
        }
        // ── v0.5.0: Dynamic Workflows ────────────────────────────
        case 'automation': {
          if (!args || args === 'list') {
            const tasks = await listScheduledAutomationTasks(sdk.config.workDir);
            appendStatic([
              ...formatInfoLine(tasks.length ? `Automation tasks (${tasks.length})` : 'No automation tasks configured.'),
              ...tasks.map(task => `  ${A.bold}${task.name}${A.reset} ${A.dim}· ${task.kind} · ${task.trigger ?? 'schedule'} · ${task.enabled ? 'enabled' : 'paused'}${A.reset}`),
              '',
            ]);
            return;
          }
          if (args !== 'new') {
            appendStatic([...formatErrorLine('usage: /automation [list|new]'), '']);
            return;
          }

          const kind = await selectItem({
            title: 'New automation task',
            subtitle: 'Choose what the task runs',
            items: [
              { id: 'workflow', label: 'Agent Workflow', description: 'Run a Workflow saved on the Agent page' },
              { id: 'prompt', label: 'Prompt', description: 'Run one background prompt' },
              { id: 'manager', label: 'Manager update', description: 'Update project progress' },
            ],
          });
          if (kind !== 'workflow' && kind !== 'prompt' && kind !== 'manager') return;

          let workflowName: string | undefined;
          let workflowSource: 'agent' | undefined;
          let input: string | undefined;
          let prompt: string | undefined;
          if (kind === 'workflow') {
            const workflows = listTeamDefinitions(sdk.config.workDir, sdk.config.homeDir)
              .filter(team => team.definition.squadType === 'workflow');
            if (!workflows.length) {
              appendStatic([...formatErrorLine('Create and save a Workflow on the Agent page first.'), '']);
              return;
            }
            workflowName = await selectItem({
              title: 'Agent Workflow',
              items: workflows.map(workflow => ({
                id: workflow.name,
                label: workflow.name,
                description: `${workflow.source} · ${workflow.definition.description ?? ''}`,
              })),
            });
            if (!workflowName) return;
            workflowSource = 'agent';
            input = (await promptText({ title: workflowName, label: 'Input (optional)' }))?.trim() || undefined;
          } else if (kind === 'prompt') {
            prompt = (await promptText({ title: 'Prompt automation', label: 'Prompt' }))?.trim();
            if (!prompt) return;
          } else {
            input = (await promptText({ title: 'Manager update', label: 'Instruction (optional)' }))?.trim() || undefined;
          }

          const trigger = await selectItem({
            title: 'Trigger',
            items: [
              { id: 'schedule', label: 'Schedule', description: 'Run from a cron expression' },
              { id: 'webhook', label: 'Webhook', description: 'Run when its local webhook URL is called' },
            ],
          });
          if (trigger !== 'schedule' && trigger !== 'webhook') return;
          const cron = trigger === 'schedule'
            ? (await promptText({ title: 'Schedule', label: 'Cron', initial: '0 9 * * *', description: 'min hour day month weekday' }))?.trim()
            : '';
          if (trigger === 'schedule' && !cron) return;
          const defaultName = workflowName ?? (prompt ? prompt.slice(0, 48) : 'Manager progress update');
          const taskName = (await promptText({ title: 'Automation task', label: 'Name', initial: defaultName }))?.trim();
          if (!taskName) return;
          try {
            const task = await upsertScheduledAutomationTask(sdk.config.workDir, {
              name: taskName,
              kind,
              trigger,
              cron,
              enabled: true,
              workflowName,
              workflowSource,
              input,
              prompt,
              ...(trigger === 'webhook' ? { webhookId: `wh-${randomUUID().slice(0, 8)}` } : {}),
            });
            appendStatic([...formatInfoLine(`Automation task saved: ${task.name}`), '']);
          } catch (error) {
            appendStatic([...formatErrorLine(errorMessage(error)), '']);
          }
          return;
        }
        case 'workflows': {
          const runSavedWorkflow = async (wfName: string, wfTask?: string): Promise<void> => {
            const wf = loadWorkflow(wfName, sdk.config.workDir);
            if (!wf) {
              appendStatic([...formatErrorLine(`workflow not found: ${wfName}`), '']);
              return;
            }
            appendStatic([
              ...formatInfoLine(`running workflow: ${wfName}`),
              ...formatInfoLine(`phases: ${wf.meta?.phases?.map((p) => p.title).join(', ') ?? 'none'}`),
              '',
            ]);
            try {
              const { WorkflowScriptRuntime } = await import('../workflow/workflowScriptRuntime.js');
              const runtime = new WorkflowScriptRuntime({
                sdk: sdk as any,
                trust: 'trusted',
                args: wfTask,
                onEvent: (e: any) => {
                  if (e.type === 'workflow.phase.start') {
                    appendStatic([`${A.bold}${A.magenta}▶ ${e.title}${A.reset}`]);
                  } else if (e.type === 'workflow.agent.start') {
                    appendStatic([`${A.dim}  ⚡ ${e.label ?? e.agentId}${e.cached ? ' (cached)' : ''}${A.reset}`]);
                  } else if (e.type === 'workflow.agent.done') {
                    const secs = e.durationMs ? ` · ${Math.round(e.durationMs / 1000)}s` : '';
                    appendStatic([`${A.dim}  ✓ ${e.label ?? e.agentId}${secs}${A.reset}`]);
                  } else if (e.type === 'workflow.log') {
                    appendStatic([`${A.dim}  │ ${e.message}${A.reset}`]);
                  } else if (e.type === 'workflow.script.done') {
                    const secs = e.durationMs ? ` · ${Math.round(e.durationMs / 1000)}s` : '';
                    appendStatic([
                      `${A.green}✓ workflow done${A.reset}${A.dim} · ${e.agentCount} agents · ${e.totalTokens} tokens${secs}${A.reset}`,
                      '',
                    ]);
                  }
                },
              });
              const output = await runtime.execute(wf.script);
              if (typeof output.result === 'string' && output.result.trim()) {
                appendStatic([...formatInfoLine('workflow result:'), ...renderRichText(output.result, screen.width), '']);
              }
              if (output.state.errors.length > 0) {
                appendStatic([...formatErrorLine(`${output.state.errors.length} errors during workflow execution`), '']);
              }
            } catch (error: any) {
              appendStatic([...formatErrorLine(`workflow error: ${error.message}`), '']);
            }
          };

          if (args.startsWith('run ')) {
            const runRest = args.slice(4).trim();
            const runSpace = runRest.indexOf(' ');
            await runSavedWorkflow(
              runSpace === -1 ? runRest : runRest.slice(0, runSpace),
              runSpace === -1 ? undefined : runRest.slice(runSpace + 1).trim(),
            );
            return;
          }
          if (args && args !== 'list') {
            appendStatic([...formatErrorLine('usage: /workflows [list|run <name> [task]]'), '']);
            return;
          }

          // No sub-command → selection picker.
          const saved = listWorkflows(sdk.config.workDir);
          const items = [
            ...saved.map((w) => ({
              id: `run:${w.name}`,
              label: w.name,
              description: `${w.source} · ${w.description}`.slice(0, 80),
            })),
            {
              id: '__orchestrate__',
              label: '+ ask the agent to orchestrate a new workflow',
              description: 'describe a task in the prompt box; the agent designs & runs a workflow, then you can save it',
            },
          ];
          const choice = await selectItem({
            title: 'Workflows',
            subtitle: 'run a saved workflow, or have the agent build a new one',
            items,
          });
          if (!choice) return;
          if (choice.startsWith('run:')) {
            const name = choice.slice('run:'.length);
            const task = await promptText({ title: `Run /${name}`, label: 'Task / input (optional — Enter to skip)' });
            await runSavedWorkflow(name, task && task.trim() ? task.trim() : undefined);
          } else if (choice === '__orchestrate__') {
            appendStatic([
              ...formatInfoLine('Type your task in the prompt box and ask: "orchestrate a workflow to <task>".'),
              `${A.dim}After it runs and works, ask me to save it as a reusable workflow.${A.reset}`,
              '',
            ]);
          }
          return;
        }
        // ── v0.5.0: Worktrees ────────────────────────────────────
        case 'worktree': {
          const ws = new WorktreeService(sdk.config.workDir);
          if (args === 'list') {
            await ws.init();
            const trees = await ws.listWorktrees();
            if (trees.length === 0) {
              appendStatic([...formatInfoLine('no worktrees'), '']);
            } else {
              appendStatic([
                ...trees.map((t) =>
                  `${A.dim}${t.path}${A.reset} · ${t.isDirty ? `${A.yellow}dirty${A.reset}` : `${A.green}clean${A.reset}`}`,
                ),
                '',
              ]);
            }
            return;
          }
          if (args === 'exit') {
            try {
              ws.exitWorktree();
              appendStatic([...formatInfoLine(`exited worktree, cwd: ${ws.currentWorkDir}`), '']);
            } catch (error: any) {
              appendStatic([...formatErrorLine(error.message), '']);
            }
            return;
          }
          if (args.startsWith('enter ')) {
            const wfName = args.slice(6).trim();
            try {
              await ws.init();
              await ws.createAndEnterWorktree({ name: wfName });
              appendStatic([...formatInfoLine(`entered worktree: ${wfName} (${ws.currentWorkDir})`), '']);
            } catch (error: any) {
              appendStatic([...formatErrorLine(error.message), '']);
            }
            return;
          }
          appendStatic([...formatInfoLine('usage: /worktree [enter <name>|exit|list]'), '']);
          return;
        }
        case 'bridge': {
          if (args === 'run' || args.startsWith('run ')) {
            const bp = args.startsWith('run ') ? args.slice(4).trim() : '';
            if (!bp) { appendStatic([...formatErrorLine('usage: /bridge run <prompt>'), '']); return; }
            await runBridgePrompt(bp);
            return;
          }
          if (args === 'background' || args.startsWith('background ')) {
            const prompt = args.startsWith('background ') ? args.slice(11).trim() : '';
            if (!prompt) {
              appendStatic([...formatErrorLine('usage: /bridge background <prompt>'), '']);
              return;
            }
            await startExternalCliBackgroundRun(prompt);
            return;
          }
          if (args === 'runs') {
            printExternalCliRuns();
            return;
          }
          if (args === 'stop' || args.startsWith('stop ')) {
            const runId = args.startsWith('stop ') ? args.slice(5).trim() : '';
            if (!runId) {
              appendStatic([...formatErrorLine('usage: /bridge stop <runId>'), '']);
              return;
            }
            stopExternalCliRun(runId);
            return;
          }
          if (args === 'status') {
            printBridgeStatus();
            return;
          }
          if (args === 'history' || args.startsWith('history ')) {
            const nativeSessionId = args.startsWith('history ') ? args.slice(8).trim() : '';
            await printExternalCliHistory(nativeSessionId);
            return;
          }
          if (args === 'resume' || args.startsWith('resume ')) {
            const nativeSessionId = args.startsWith('resume ') ? args.slice(7).trim() : '';
            if (!nativeSessionId) {
              appendStatic([...formatErrorLine('usage: /bridge resume <native-id>'), '']);
              return;
            }
            await resumeExternalCliHistorySession(nativeSessionId);
            return;
          }
          if (args === 'switch' || args.startsWith('switch ')) {
            const target = args.startsWith('switch ') ? args.slice(7).trim() : '';
            await switchBridgeProvider(target);
            return;
          }
          if (args === 'setup') {
            await configureBridgeSettings();
            return;
          }
          if (args === 'config') {
            await manageBridgeConfigs();
            return;
          }
          if (args === 'off') {
            await disableBridge();
            return;
          }
          if (args === 'model' || args.startsWith('model ')) {
            const modelId = args.startsWith('model ') ? args.slice(6).trim() : '';
            await selectBridgeModel(modelId);
            return;
          }
          if (args === 'help') {
            printBridgeHelp();
            return;
          }
          if (!args) {
            await openBridgeBoard();
            return;
          }
          await configureBridgeSettings();
          return;
        }
        // ── v0.5.0: Model Team ───────────────────────────────────
        case 'team': {
          if (args === 'status') {
            appendStatic([
              `${A.bold}Team status${A.reset}`,
              `${A.dim}attached: ${activeTeamName ?? 'none'}${A.reset}`,
              `${A.dim}autoInvoke: ${teamPrefs.autoInvoke ? 'on — the main agent can call the team as a tool' : 'off — manual /team ask only'}${A.reset}`,
              `${A.dim}defaultAttached: ${teamPrefs.defaultAttached ?? 'none'}${teamPrefs.defaultAttached && !activeTeamName ? ' (not found)' : ''}${A.reset}`,
              `${A.dim}last run: ${lastTeamRunSummary ?? 'none'}${A.reset}`,
              '',
            ]);
            return;
          }
          if (args === 'off') {
            activeTeamTool = null;
            activeTeamName = null;
            appendStatic([...formatInfoLine('team: none — the agent works individually'), '']);
            return;
          }
          if (args === 'list') {
            const teams = listTeamDefinitions(sdk.config.workDir);
            appendStatic([
              `${A.bold}Teams${A.reset}`,
              ...teams.map((t) =>
                `${t.name === activeTeamName ? `${A.green}*${A.reset}` : ' '}${A.cyan}${t.name}${A.reset}${A.dim} · ${t.definition.mode} · ${t.source} · ${countTeamAgents(t.definition)} agents${A.reset}`),
              `${A.dim}/team attach <name> · /team ask <name> <prompt> · /team off · /team status${A.reset}`,
              '',
            ]);
            return;
          }
          if (args.startsWith('attach ')) {
            const teamName = args.slice(7).trim();
            const definition = attachTeamByName(teamName);
            if (!definition) {
              appendStatic([...formatErrorLine(`team not found: ${teamName}`), '']);
              return;
            }
            appendStatic([
              ...formatInfoLine(`team attached: ${definition.name} (${definition.mode}) · autoInvoke ${teamPrefs.autoInvoke ? 'on' : 'off — run /team ask <name> <prompt> to use it'}`),
              '',
            ]);
            return;
          }
          if (args.startsWith('clone ')) {
            const parts = args.slice(6).trim().split(/\s+/);
            if (parts.length !== 2) {
              appendStatic([...formatErrorLine('usage: /team clone <source> <new-name>'), '']);
              return;
            }
            try {
              const clone = await cloneTeamDefinition(parts[0]!, parts[1]!, { projectDir: sdk.config.workDir });
              appendStatic([...formatInfoLine(`team cloned: ${parts[0]} → ${clone.name} (${clone.filePath})`), '']);
            } catch (error: any) {
              appendStatic([...formatErrorLine(`clone failed: ${error.message}`), '']);
            }
            return;
          }
          if (args.startsWith('ask ')) {
            const rest = args.slice(4).trim();
            const spaceIdx = rest.indexOf(' ');
            if (spaceIdx === -1) {
              appendStatic([...formatErrorLine('usage: /team ask <name> <prompt>'), '']);
              return;
            }
            const teamName = rest.slice(0, spaceIdx);
            const prompt = rest.slice(spaceIdx + 1).trim();
            const loaded = loadTeamDefinition(teamName, sdk.config.workDir);
            if (!loaded) {
              appendStatic([...formatErrorLine(`team not found: ${teamName}`), '']);
              return;
            }
            const definition = instantiateTeamDefinition(loaded.definition, session.model);
            const memberModels = listTeamAgentLabels(definition);
            if (teamPrefs.confirmBeforeRun) {
              const go = await selectItem({
                title: `Run team "${definition.name}"?`,
                subtitle: `${definition.mode} · members: ${memberModels.join(', ') || '(none)'}`,
                items: [
                  { id: 'run', label: 'Run', description: 'convene the team now' },
                  { id: 'cancel', label: 'Cancel', description: 'do nothing' },
                ],
              });
              if (go !== 'run') return;
            }
            appendStatic([
              ...formatInfoLine(`asking team "${teamName}" (${definition.mode} mode)`),
              `${A.dim}convening: ${memberModels.join(', ') || 'configured members'}${A.reset}`,
              '',
            ]);
            try {
              const team = createModelTeam(definition);
              const teamRunView = createTeamRunViewState(definition.name);
              const printTeamRunTree = () => {
                const lines = formatTeamRunTreeLines(teamRunView);
                if (!lines.length) return;
                appendStatic([...lines.map((line) => `${A.dim}${line}${A.reset}`), '']);
              };
              const result = await team.ask(prompt, undefined, {
                workDir: sdk.config.workDir,
                onEvent: (e) => {
                  applyTeamRunEvent(teamRunView, e);
                  if (e.type === 'team.synthesis') {
                    appendStatic([`${A.dim}  ◈ synthesis round ${e.round}: ${e.decision}${A.reset}`]);
                  } else if (
                    e.type === 'team.started'
                    || e.type === 'team.member.completed'
                    || e.type === 'team.edge.triggered'
                    || e.type === 'team.completed'
                  ) {
                    printTeamRunTree();
                  }
                },
              });
              lastTeamRunSummary = `${teamName} · ${result.mode} · ${Math.round(result.durationMs / 1000)}s`;
              appendStatic([
                `${A.green}✓ team response${A.reset}${A.dim} · ${result.mode} · ${Math.round(result.durationMs / 1000)}s${A.reset}`,
                `${A.dim}cost: ${result.cost.estimatedCost !== null ? `$${result.cost.estimatedCost.toFixed(4)}` : 'N/A'} · ${result.cost.totalInputTokens + result.cost.totalOutputTokens} tokens${A.reset}`,
                '',
                ...renderRichText(result.answer, screen.width),
                '',
              ]);
            } catch (error: any) {
              appendStatic([...formatErrorLine(`team error: ${error.message}`), '']);
            }
            return;
          }

          // No sub-command → picker that toggles which team the agent may call.
          const teams = listTeamDefinitions(sdk.config.workDir);
          const items = [
            { id: '__none__', label: activeTeamTool ? `No team — remove "${activeTeamName}"` : 'No team (individual) — current', description: 'the agent works solo, no team attached' },
            ...teams.map((t) => ({
              id: `team:${t.name}`,
              label: `${t.name}${t.name === activeTeamName ? ' — attached' : ''}`,
              description: `${t.source} · ${t.definition.mode} · ${countTeamAgents(t.definition)} agents`,
            })),
          ];
          const choice = await selectItem({ title: 'Team', subtitle: `attach a team (autoInvoke ${teamPrefs.autoInvoke ? 'on' : 'off'} — settings preferences.team)`, items });
          if (!choice) return;
          if (choice === '__none__') {
            activeTeamTool = null;
            activeTeamName = null;
            appendStatic([...formatInfoLine('team: none — the agent works individually'), '']);
            return;
          }
          try {
            const definition = attachTeamByName(choice.slice('team:'.length));
            if (!definition) {
              appendStatic([...formatErrorLine('could not load team definition'), '']);
              return;
            }
            appendStatic([
              ...formatInfoLine(
                teamPrefs.autoInvoke
                  ? `team active: ${definition.name} (${definition.mode}) — the agent can now call "${definition.name}" as a tool when it helps`
                  : `team attached: ${definition.name} (${definition.mode}) — run /team ask ${definition.name} <prompt> (autoInvoke off)`,
              ),
              '',
            ]);
          } catch (error: any) {
            appendStatic([...formatErrorLine(`team error: ${error.message}`), '']);
          }
          return;
        }
        // ── Project Manager ──────────────────────────────────────
        case 'issues': {
          const homeDir = sdk.config.homeDir;
          const meta = await readProjectMeta(sdk.config.workDir, homeDir);
          const storage = isIssueStorageMode(meta.issueStorage) ? meta.issueStorage : 'home';
          if (!args || args === 'list') {
            const issues = await listProjectIssues(sdk.config.workDir, homeDir, storage);
            if (issues.length === 0) {
              appendStatic([...formatInfoLine('no issues yet; use /issues create <title>'), '']);
              return;
            }
            appendStatic([
              `${A.cyan}Issues (${storage})${A.reset}`,
              ...issues.map(issue => `#${issue.number} ${issue.title} ${A.dim}${issue.status} · ${issue.priority}${A.reset}`),
              '',
            ]);
            return;
          }
          if (args.startsWith('create ')) {
            const title = args.slice(7).trim();
            if (!title) {
              appendStatic([...formatErrorLine('usage: /issues create <title>'), '']);
              return;
            }
            const issue = await createProjectIssue(sdk.config.workDir, homeDir, { title }, storage);
            appendStatic([...formatInfoLine(`issue created: #${issue.number} ${issue.title}`), '']);
            return;
          }
          if (args.startsWith('show ')) {
            const rawId = args.slice(5).trim().replace(/^#/, '');
            const issues = await listProjectIssues(sdk.config.workDir, homeDir, storage);
            const issue = issues.find(candidate =>
              candidate.id === rawId ||
              String(candidate.number) === rawId ||
              `ISS-${candidate.number}` === rawId.toUpperCase(),
            );
            if (!issue) {
              appendStatic([...formatErrorLine(`issue not found: ${rawId}`), '']);
              return;
            }
            appendStatic([
              `${A.bold}ISS-${issue.number} ${issue.title}${A.reset}`,
              `${A.dim}${issue.status} · ${issue.priority}${A.reset}`,
              issue.description || '(no description)',
              ...(issue.acceptanceCriteria.length
                ? ['', 'Acceptance criteria:', ...issue.acceptanceCriteria.map(item => `- ${item}`)]
                : []),
              ...(issue.brief ? ['', 'Manager brief:', issue.brief] : []),
              '',
            ]);
            return;
          }
          if (args.startsWith('start ')) {
            const [, rawId, agentProfile] = args.split(/\s+/, 3);
            const id = rawId?.replace(/^#/, '');
            const issues = await listProjectIssues(sdk.config.workDir, homeDir, storage);
            const issue = issues.find(candidate =>
              candidate.id === id ||
              String(candidate.number) === id ||
              `ISS-${candidate.number}` === id?.toUpperCase(),
            );
            if (!issue) {
              appendStatic([...formatErrorLine(`issue not found: ${rawId ?? ''}`), '']);
              return;
            }
            appendStatic([...formatInfoLine(`decomposing and dispatching ISS-${issue.number}...`), '']);
            const dispatched = await executeProjectIssue({
              sdk,
              managerSession: await resolveManagerTuiSession(),
              workDir: sdk.config.workDir,
              homeDir,
              storageMode: storage,
              issue,
              agentProfile,
              defaultModel: session.model,
              permissionMode: currentPermissionMode(),
              systemPrompt,
            });
            session = dispatched.session;
            appendStatic([
              ...formatInfoLine(`ISS-${dispatched.issue.number}: ${dispatched.issue.status} · session ${session.id}`),
              ...(dispatched.result.text ? [dispatched.result.text] : []),
              '',
            ]);
            return;
          }
          const transitions: Record<string, string> = {
            review: 'in_review',
            done: 'done',
            block: 'blocked',
          };
          const [verb, rawId] = args.split(/\s+/, 2);
          const nextStatus = transitions[verb ?? ''];
          if (nextStatus && isIssueStatus(nextStatus) && rawId) {
            const issue = await transitionProjectIssue(sdk.config.workDir, homeDir, rawId.replace(/^#/, ''), nextStatus, 'user', storage);
            if (!issue) appendStatic([...formatErrorLine(`issue not found: ${rawId}`), '']);
            else appendStatic([...formatInfoLine(`issue #${issue.number}: ${issue.status}`), '']);
            return;
          }
          appendStatic([...formatErrorLine('usage: /issues [list|show <id>|create <title>|start <id> [agent-profile]|review <id>|done <id>|block <id>]'), '']);
          return;
        }
        case 'assistant': {
          const homeDir = sdk.config.homeDir;
          const globalSession = await resolveGlobalAssistantSession();
          if (args === 'sessions') {
            const config = await readAssistantConfig(homeDir);
            const sessions = (await globalAssistantSdk!.sessions.list()).filter(item => item.kind === 'manager');
            appendStatic([
              `${A.bold}Global Assistant Sessions${A.reset}`,
              ...sessions.map(item => `${item.id === config.activeSessionId ? A.green + '●' : A.dim + '○'} ${item.id} · ${item.title} · ${item.messageCount} messages${A.reset}`),
              '',
            ]);
            return;
          }
          if (args === 'new') {
            const config = await readAssistantConfig(homeDir);
            globalAssistantSession = await globalAssistantSdk!.createSession({
              title: 'Assistant (Global)',
              kind: 'manager',
              metadata: { __hadamardKind: 'manager', __hadamardAssistantScope: 'global' },
              permissionMode: 'bypassPermissions',
            });
            await writeAssistantConfig({ ...config, activeSessionId: globalAssistantSession.id }, homeDir);
            appendStatic([...formatInfoLine(`Global Assistant Session created: ${globalAssistantSession.id}`), '']);
            return;
          }
          if (args.startsWith('resume ')) {
            const id = args.slice('resume '.length).trim();
            const found = (await globalAssistantSdk!.sessions.list())
              .find(item => item.id === id && item.kind === 'manager');
            if (!found) {
              appendStatic([...formatErrorLine(`Global Assistant Session not found: ${id}`), '']);
              return;
            }
            const config = await readAssistantConfig(homeDir);
            globalAssistantSession = await globalAssistantSdk!.resumeSession(id, { permissionMode: 'bypassPermissions' });
            await writeAssistantConfig({ ...config, activeSessionId: id }, homeDir);
            appendStatic([...formatInfoLine(`Global Assistant Session selected: ${found.title}`), '']);
            return;
          }
          const isTeam = args === 'team' || args.startsWith('team ');
          const isChat = args === 'chat' || args.startsWith('chat ') || isTeam;
          if (!isChat) {
            appendStatic([...formatErrorLine('usage: /assistant [chat <message>|sessions|new|resume <id>|team <request>]'), '']);
            return;
          }
          const prompt = isTeam
            ? (args === 'team'
              ? ''
              : `Propose a Team Graph for this request. Use an explicit registered projectPath. ${args.slice('team'.length).trim()}`)
            : args.slice('chat'.length).trim();
          if (!prompt) {
            appendStatic([...formatErrorLine(isTeam ? 'usage: /assistant team <request>' : 'usage: /assistant chat <message>'), '']);
            return;
          }
          const proposals: import('../team/teamProposalService.js').TeamGraphProposal[] = [];
          const tools = [
            ...await createAssistantGlobalTools({ homeDir, currentWorkDir: sdk.config.workDir }),
            ...createAssistantTeamTools({
              scope: 'global',
              assistantSessionId: globalSession.id,
              currentWorkDir: sdk.config.workDir,
              homeDir,
              proposals: assistantTeamProposals,
              onProposal: proposal => { proposals.push(proposal); },
            }),
          ];
          try {
            const config = await readAssistantConfig(homeDir);
            const stream = globalSession.stream(prompt, {
              systemPrompt: `${buildAssistantGlobalSystemPrompt(sdk.config.workDir)}\n${buildAssistantTeamSystemPrompt('global')}`,
              tools,
              ...(config.model ? { model: config.model } : {}),
              __hadamardUseDefaultTools: false,
              __hadamardAllowedTools: tools.map(item => item.name),
            } as Parameters<typeof globalSession.stream>[1]);
            for await (const event of stream) {
              if (event.type === 'tool.call') appendStatic([`${A.dim}  ⚙ ${event.call.name}${A.reset}`]);
            }
            const result = await stream.result;
            if (result.text) appendStatic([...renderRichText(result.text, screen.width), '']);
            for (const proposal of proposals) {
              appendStatic([
                `${A.bold}Team proposal · ${proposal.teamName}${A.reset}`,
                ...managerProposalDiffForTui(proposal),
                '',
              ]);
              const choice = await selectItem({
                title: `Team proposal "${proposal.teamName}"`,
                subtitle: proposal.problems.length ? proposal.problems.join(' · ') : `Target: ${proposal.projectPath}`,
                items: [
                  ...(!proposal.problems.length
                    ? [{ id: 'apply', label: 'Apply', description: 'check base version and save' }]
                    : []),
                  { id: 'reject', label: 'Reject', description: 'no file write' },
                  { id: 'later', label: 'Keep pending', description: 'decide later' },
                ],
              });
              if (choice === 'apply') {
                const applied = await assistantTeamProposals.apply(proposal.id, homeDir);
                appendStatic([...formatInfoLine(`Team saved: ${applied.filePath}`), '']);
              } else if (choice === 'reject') {
                assistantTeamProposals.reject(proposal.id);
              }
            }
          } catch (error: any) {
            appendStatic([...formatErrorLine(`Assistant error: ${error.message}`), '']);
          }
          return;
        }
        case 'diff': {
          const sub = args || 'show';
          try {
            const diff = await sdk.getSessionDiff(session.id);
            if (sub === 'show') {
              appendStatic([
                `${A.bold}Session Diff${A.reset}`,
                ...(diff.files.length
                  ? diff.files.map(file => `  ${file.status} ${file.path} ${A.green}+${file.additions}${A.reset} ${A.red}-${file.deletions}${A.reset}`)
                  : [`  ${A.dim}(no changes)${A.reset}`]),
                '',
              ]);
              return;
            }
            if (sub === 'apply --confirm') {
              const result = await sdk.applySessionDiff(session.id);
              appendStatic([
                ...(result.applied ? formatInfoLine(result.message) : formatErrorLine(result.message)),
                '',
              ]);
              return;
            }
            appendStatic([...formatErrorLine('usage: /diff show | apply --confirm'), '']);
          } catch (error) {
            appendStatic([...formatErrorLine(error instanceof Error ? error.message : String(error)), '']);
          }
          return;
        }
        case 'session': {
          const [action, ...rest] = args.split(/\s+/);
          if (!action) {
            appendStatic([...formatErrorLine('usage: /session tree | fork <message-id> [label] | clone [label] | label <name> | rename <title> | pin [on|off] | archive | restore <id> | delete <id>'), '']);
            return;
          }
          if (action === 'tree') {
            const roots = await sdk.sessionGraph.roots();
            const lines: string[] = [`${A.bold}Session Tree${A.reset}`];
            const visit = (node: (typeof roots)[number], depth: number) => {
              const marker = node.session.id === session.id ? `${A.green}*${A.reset}` : '-';
              lines.push(`${'  '.repeat(depth)}${marker} ${node.session.branchName || node.session.title} ${A.dim}${node.session.id}${A.reset}`);
              node.children.forEach(child => visit(child, depth + 1));
            };
            roots.forEach(root => visit(root, 0));
            appendStatic([...lines, '']);
            return;
          }
          if (action === 'fork') {
            const messageId = rest.shift();
            if (!messageId) {
              const refs = await sdk.sessionGraph.ensureMessageIds(session.id);
              appendStatic([
                ...formatErrorLine('usage: /session fork <message-id> [label]'),
                ...refs.map(ref => `  ${A.dim}${ref.id}${A.reset} · ${ref.message.role}`),
                '',
              ]);
              return;
            }
            const forked = await sdk.sessionForks.forkAtMessage(session.id, messageId, {
              branchName: rest.join(' ').trim() || undefined,
            });
            session = await sdk.resumeSession(forked.id);
            appendStatic([...formatInfoLine(`Session branch created: ${forked.id}`), '']);
            return;
          }
          if (action === 'clone') {
            const cloned = await sdk.sessionForks.clone(session.id, {
              branchName: rest.join(' ').trim() || undefined,
            });
            session = await sdk.resumeSession(cloned.id);
            appendStatic([...formatInfoLine(`Session cloned: ${cloned.id}`), '']);
            return;
          }
          if (action === 'label') {
            const label = rest.join(' ').trim();
            if (!label) {
              appendStatic([...formatErrorLine('usage: /session label <name>'), '']);
              return;
            }
            await sdk.sessionForks.label(session.id, label);
            session = await sdk.resumeSession(session.id);
            appendStatic([...formatInfoLine(`Session branch labeled: ${label}`), '']);
            return;
          }
          const catalog = await interactiveSessionCatalog();
          const all = await catalog.query({
            types: ['user', 'assistant-global', 'assistant-project'],
            archived: 'all',
            pageSize: 200,
          });
          const targetId = action === 'restore' || action === 'delete' ? rest[0] : session.id;
          const item = all.items.find(candidate => candidate.locator.sessionId === targetId);
          if (!item) {
            appendStatic([...formatErrorLine(`Session not found: ${targetId || ''}`), '']);
            return;
          }
          if (action === 'rename') {
            const title = rest.join(' ').trim();
            if (!title) {
              appendStatic([...formatErrorLine('usage: /session rename <title>'), '']);
              return;
            }
            await catalog.action({ action: 'rename', locator: item.locator, title });
            if (item.locator.sessionId === session.id) session = await sdk.resumeSession(session.id);
          } else if (action === 'pin') {
            await catalog.action({
              action: 'pin',
              locator: item.locator,
              pinned: rest[0] === 'off' ? false : rest[0] === 'on' ? true : undefined,
            });
          } else if (action === 'archive') {
            await catalog.action({ action: 'archive', locator: item.locator });
            if (item.locator.sessionId === session.id) {
              session = await sdk.createSession({ model: session.model, permissionMode: currentPermissionMode() });
            }
          } else if (action === 'restore') {
            await catalog.action({ action: 'restore', locator: item.locator });
          } else if (action === 'delete') {
            await catalog.action({ action: 'delete', locator: item.locator });
          } else {
            appendStatic([...formatErrorLine(`unknown /session action: ${action}`), '']);
            return;
          }
          appendStatic([...formatInfoLine(`Session ${action} complete.`), '']);
          return;
        }
        case 'manager': {
          const homeDir = sdk.config.homeDir;
          if (args === 'sessions') {
            const managers = (await sdk.sessions.list()).filter(item => item.kind === 'manager');
            const cfg = await readManagerConfig(sdk.config.workDir, homeDir);
            appendStatic([
              `${A.bold}Manager Sessions${A.reset}`,
              ...managers.map(item => `${item.id === cfg.activeSessionId ? A.green + '●' : A.dim + '○'} ${item.id} · ${item.title} · ${item.messageCount} messages${A.reset}`),
              '',
            ]);
            return;
          }
          if (args === 'new') {
            const cfg = await readManagerConfig(sdk.config.workDir, homeDir);
            managerTuiSession = await sdk.createSession({
              title: 'Manager',
              kind: 'manager',
              metadata: { __hadamardKind: 'manager', __hadamardAssistantScope: 'project' },
              permissionMode: 'bypassPermissions',
            });
            await writeManagerConfig(sdk.config.workDir, homeDir, { ...cfg, activeSessionId: managerTuiSession.id });
            appendStatic([...formatInfoLine(`Manager Session created: ${managerTuiSession.id}`), '']);
            return;
          }
          if (args.startsWith('resume ')) {
            const id = args.slice('resume '.length).trim();
            const found = (await sdk.sessions.list()).find(item => item.id === id && item.kind === 'manager');
            if (!found) {
              appendStatic([...formatErrorLine(`Manager Session not found: ${id}`), '']);
              return;
            }
            const cfg = await readManagerConfig(sdk.config.workDir, homeDir);
            managerTuiSession = await sdk.resumeSession(id, { permissionMode: 'bypassPermissions' });
            await writeManagerConfig(sdk.config.workDir, homeDir, { ...cfg, activeSessionId: id });
            appendStatic([...formatInfoLine(`Manager Session selected: ${found.title}`), '']);
            return;
          }
          if (!args || args === 'status') {
            const cfg = await readManagerConfig(sdk.config.workDir, homeDir);
            const plan = await readProjectPlanFile(sdk.config.workDir, homeDir);
            const progress = await readProgressFile(sdk.config.workDir, homeDir);
            appendStatic([
              `${A.bold}Manager${A.reset}`,
              `${A.dim}model: ${cfg.model ?? `${session.model} (session default)`}${A.reset}`,
              `${A.dim}readScope: ${cfg.readScope}${A.reset}`,
              `${A.dim}mirror to workspace: ${cfg.mirrorProgressToWorkspace ? 'on' : 'off'}${A.reset}`,
              `${A.dim}plan.json: ${plan.milestones.length} milestones · ${plan.today.length} today · ${plan.upcoming.length} upcoming${A.reset}`,
              `${A.dim}PROGRESS.md: ${progress ? `${progress.length} chars` : '(none yet — /manager update)'}${A.reset}`,
              '',
            ]);
            return;
          }
          if (args === 'config') {
            const cfg = await readManagerConfig(sdk.config.workDir, homeDir);
            appendStatic([
              ...JSON.stringify(cfg, null, 2).split('\n').map((l) => `${A.dim}${l}${A.reset}`),
              `${A.dim}Set: /manager config set <model|bridgeConfig|readScope|mirror|allow> <value>${A.reset}`,
              `${A.dim}The Manager always runs read-only regardless of model.${A.reset}`,
              '',
            ]);
            return;
          }
          if (args.startsWith('config set ')) {
            const rest = args.slice('config set '.length).trim();
            const spIdx = rest.indexOf(' ');
            const key = spIdx === -1 ? rest : rest.slice(0, spIdx);
            const value = spIdx === -1 ? '' : rest.slice(spIdx + 1).trim();
            const cfg = await readManagerConfig(sdk.config.workDir, homeDir);
            if (key === 'model') cfg.model = value || undefined;
            else if (key === 'bridgeConfig' || key === 'config') cfg.bridgeConfig = value || undefined;
            else if (key === 'readScope') {
              if (value !== 'workspace-only' && value !== 'workspace+docs' && value !== 'explicit-allowlist' && value !== 'full-access') {
                appendStatic([...formatErrorLine('readScope must be workspace-only | workspace+docs | explicit-allowlist | full-access'), '']);
                return;
              }
              cfg.readScope = value;
            } else if (key === 'mirror') cfg.mirrorProgressToWorkspace = value === 'on' || value === 'true';
            else if (key === 'allow') cfg.allowedReadPaths = value ? value.split(',').map((p) => p.trim()).filter(Boolean) : [];
            else {
              appendStatic([...formatErrorLine('usage: /manager config set <model|bridgeConfig|readScope|mirror|allow> <value>'), '']);
              return;
            }
            await writeManagerConfig(sdk.config.workDir, homeDir, cfg);
            appendStatic([...formatInfoLine(`Manager config updated: ${key}`), '']);
            return;
          }
          if (args === 'schedule') {
            const tasks = (await listScheduledAutomationTasks(sdk.config.workDir)).filter((task) => task.kind === 'manager');
            appendStatic([
              `${A.bold}Manager schedules${A.reset}`,
              ...(tasks.length === 0
                ? [`${A.dim}none — add kind:"manager" tasks to .hadamard/scheduled-tasks.json${A.reset}`]
                : tasks.map((task) => `${A.cyan}${task.name}${A.reset}${A.dim} · ${task.cron} · ${task.enabled ? 'enabled' : 'paused'}${A.reset}`)),
              '',
            ]);
            return;
          }
          const isTeam = args === 'team' || args.startsWith('team ');
          const isUpdate = args === 'update' || args.startsWith('update ');
          const isChat = args === 'chat' || args.startsWith('chat ') || isTeam;
          if (isUpdate || isChat) {
            const arg = isUpdate
              ? (args === 'update' ? '' : args.slice('update'.length).trim())
              : isTeam
                ? (args === 'team'
                  ? ''
                  : `Propose a Team Graph for this request. Inspect existing Teams first when relevant. ${args.slice('team'.length).trim()}`)
                : args.slice('chat'.length).trim();
            if (isChat && !arg) {
              appendStatic([...formatErrorLine(isTeam ? 'usage: /manager team <request>' : 'usage: /manager chat <message>'), '']);
              return;
            }
            if (isUpdate) appendStatic([...formatInfoLine('Manager: updating progress documents…'), '']);
            try {
              const cfg = await readManagerConfig(sdk.config.workDir, homeDir);
              const turnProposals: import('../team/teamProposalService.js').TeamGraphProposal[] = [];
              managerTuiSession = await resolveManagerTuiSession();
              const managerTools = [
                ...await createManagerTools({ workDir: sdk.config.workDir, homeDir, config: cfg }),
                ...createAssistantTeamTools({
                  scope: 'project',
                  assistantSessionId: managerTuiSession.id,
                  currentWorkDir: sdk.config.workDir,
                  homeDir,
                  proposals: assistantTeamProposals,
                  onProposal: proposal => { turnProposals.push(proposal); },
                }),
              ];
              let prompt: string;
              if (isUpdate) {
                // Host-collected context — the Manager itself has no shell.
                let gitSummary = '';
                try {
                  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: sdk.config.workDir, encoding: 'utf8' }).trim();
                  const dirty = execSync('git status --porcelain', { cwd: sdk.config.workDir, encoding: 'utf8' }).trim();
                  const log = execSync('git log --oneline -10', { cwd: sdk.config.workDir, encoding: 'utf8' }).trim();
                  gitSummary = `branch: ${branch}\ndirty files: ${dirty ? dirty.split('\n').length : 0}\nrecent commits:\n${log}`;
                } catch { /* not a git repo */ }
                const stored = await sdk.sessions.list();
                const conversationSummaries = stored
                  .filter((s) => s.kind !== 'manager')
                  .slice(0, 20)
                  .map((s) => `- [${s.updatedAt.slice(0, 10)}] ${s.title} (${s.messageCount} msgs): ${s.preview}`)
                  .join('\n');
                const plan = await readProjectPlanFile(sdk.config.workDir, homeDir);
                const progress = await readProgressFile(sdk.config.workDir, homeDir);
                appendStatic([...formatInfoLine(formatManagerUpdatePreview(plan, progress).split('\n').slice(0, 2).join(' · ')), '']);
                const githubDigest = await resolveGitHubDigestForUpdate(sdk.config.workDir, arg || undefined);
                prompt = buildUpdateProgressPrompt({
                  instruction: arg || undefined,
                  gitSummary,
                  conversationSummaries,
                  githubDigest,
                  currentPlanJson: JSON.stringify(plan, null, 2),
                  currentProgress: progress ?? undefined,
                });
              } else {
                prompt = arg;
              }
              try {
                const compactResult = await managerTuiSession.compact({});
                if (compactResult.compacted) {
                  appendStatic([...formatInfoLine(`manager compacted ${compactResult.messagesRemoved ?? '?'} older messages`), '']);
                }
              } catch { /* auto-compact is best-effort */ }
              const runOptions = {
                systemPrompt: `${buildManagerSystemPrompt(sdk.config.workDir, cfg)}\n${buildAssistantTeamSystemPrompt('project')}`,
                tools: managerTools,
                ...(cfg.model ? { model: cfg.model } : {}),
                __hadamardUseDefaultTools: false,
                __hadamardAllowedTools: managerTools.map((tool) => tool.name),
              } as Parameters<typeof managerTuiSession.stream>[1];
              const stream = managerTuiSession.stream(prompt, runOptions);
              for await (const event of stream) {
                if (event.type === 'tool.call') appendStatic([`${A.dim}  ⚡ ${event.call.name}${A.reset}`]);
              }
              const result = await stream.result;
              if (result.text) appendStatic([...renderRichText(result.text, screen.width), '']);
              for (const proposal of turnProposals) {
                const diff = proposal.diff;
                appendStatic([
                  `${A.bold}Team proposal · ${proposal.teamName}${A.reset}`,
                  `${A.dim}${proposal.explanation || '(no explanation)'}${A.reset}`,
                  ...[
                    ['+ nodes', diff.addedNodes],
                    ['- nodes', diff.removedNodes],
                    ['~ nodes', diff.changedNodes],
                    ['+ edges', diff.addedEdges],
                    ['- edges', diff.removedEdges],
                    ['~ edges', diff.changedEdges],
                  ].filter(([, values]) => (values as string[]).length)
                    .map(([label, values]) => `${A.dim}${label}: ${(values as string[]).join(', ')}${A.reset}`),
                  ...(proposal.problems.length
                    ? proposal.problems.map(problem => `${A.red}invalid: ${problem}${A.reset}`)
                    : []),
                  '',
                ]);
                const choice = await selectItem({
                  title: `Team proposal "${proposal.teamName}"`,
                  subtitle: proposal.problems.length
                    ? 'Invalid proposal — Apply is unavailable'
                    : `Target: ${proposal.projectPath}`,
                  items: [
                    ...(!proposal.problems.length
                      ? [{ id: 'apply', label: 'Apply', description: 'validate base version and write the Team definition' }]
                      : []),
                    { id: 'reject', label: 'Reject', description: 'discard without writing' },
                    { id: 'later', label: 'Keep pending', description: 'do not write now' },
                  ],
                });
                if (choice === 'apply') {
                  try {
                    const applied = await assistantTeamProposals.apply(proposal.id, homeDir);
                    appendStatic([...formatInfoLine(`Team saved: ${applied.proposal.teamName} (${applied.filePath})`), '']);
                  } catch (error: any) {
                    appendStatic([...formatErrorLine(`Team apply failed: ${error.message}`), '']);
                  }
                } else if (choice === 'reject') {
                  assistantTeamProposals.reject(proposal.id);
                  appendStatic([...formatInfoLine('Team proposal rejected; no file was written.'), '']);
                }
              }
              if (isUpdate) appendStatic([...formatInfoLine(`progress updated · ${managerProgressPath(sdk.config.workDir, homeDir)}`), '']);
            } catch (error: any) {
              appendStatic([...formatErrorLine(`manager error: ${error.message}`), '']);
            }
            return;
          }
          appendStatic([...formatErrorLine('usage: /manager [status|chat <message>|update [instruction]|sessions|new|resume <id>|team <request>|config|schedule]'), '']);
          return;
        }
        default:
          appendStatic([...formatErrorLine(`unknown command: /${name} — type /help`), '']);
          return;
      }
    } finally {
      commandBusy = false;
      renderDynamic();
    }
  }

  // ── Submit / key handling ──────────────────────────────────────────

  async function submit(): Promise<void> {
    if (!running && applyAtCompletion()) {
      renderDynamic();
      return;
    }
    const selectedCommand = !running
      ? selectInteractiveCommand(editor.text, menuSelected)
      : undefined;
    if (selectedCommand) {
      editor.clear();
      menuSelected = 0;
      // A selected completion already contains its subcommand. Keeping the
      // partially typed second word would turn `/agents runs` into
      // `/agents runs runs` on Enter.
      await runSlashCommand(selectedCommand);
      return;
    }
    const value = editor.submit();
    if (value === null) {
      renderDynamic();
      return;
    }
    const text = value.trim();
    menuSelected = 0;
    if (!text) {
      renderDynamic();
      return;
    }
    if (running) {
      if (text.startsWith('/')) {
        appendStatic(formatInfoLine('slash commands are unavailable while the agent is working'));
        renderDynamic();
        return;
      }
      session.steer(text);
      appendStatic(formatQueuedPrompt(text));
      renderDynamic();
      return;
    }
    if (commandBusy) {
      renderDynamic();
      return;
    }
    if (text.startsWith('/')) {
      await runSlashCommand(text);
      return;
    }
    void startRun(text);
  }

  function handleDialogKey(key: Key): void {
    if (!dialog) return;
    const name = key.name ?? '';
    if (name === 'up') {
      dialog.selected = (dialog.selected + 3) % 4;
    } else if (name === 'down' || name === 'tab') {
      dialog.selected = (dialog.selected + 1) % 4;
    } else if (name === 'return' || name === 'enter') {
      dialog.resolve(dialog.selected === 0 ? 'allow' : dialog.selected === 1 ? 'always' : dialog.selected === 2 ? 'always-user' : 'deny');
      return;
    } else if (name === 'y') {
      dialog.resolve('allow');
      return;
    } else if (name === 'a') {
      dialog.resolve('always');
      return;
    } else if (name === 'n' || name === 'escape') {
      dialog.resolve('deny');
      return;
    } else if (name === 'c' && key.ctrl) {
      dialog.resolve('deny');
      return;
    }
    renderDynamic();
  }

  function finishSelection(value: string | undefined): void {
    const active = selectionDialog;
    if (!active) return;
    selectionDialog = null;
    renderDynamic();
    active.resolve(value);
  }

  function handleSelectionKey(char: string | undefined, key: Key): void {
    if (!selectionDialog) return;
    const name = key.name ?? '';
    const filtered = filterTuiSelectionItems(
      selectionDialog.items,
      selectionDialog.query,
    );
    if (name === 'up') {
      selectionDialog.selected = moveTuiSelection(
        selectionDialog.selected,
        filtered.length,
        -1,
      );
    } else if (name === 'down' || name === 'tab') {
      selectionDialog.selected = moveTuiSelection(
        selectionDialog.selected,
        filtered.length,
        1,
      );
    } else if (name === 'pageup') {
      selectionDialog.selected = Math.max(selectionDialog.selected - 8, 0);
    } else if (name === 'pagedown') {
      selectionDialog.selected = Math.max(
        Math.min(selectionDialog.selected + 8, filtered.length - 1),
        0,
      );
    } else if (name === 'return' || name === 'enter') {
      finishSelection(filtered[selectionDialog.selected]?.id);
      return;
    } else if (name === 'escape' || (name === 'c' && key.ctrl)) {
      finishSelection(undefined);
      return;
    } else if (selectionDialog.searchable && name === 'backspace') {
      selectionDialog.query = selectionDialog.query.slice(0, -1);
      selectionDialog.selected = 0;
    } else if (selectionDialog.searchable && name === 'u' && key.ctrl) {
      selectionDialog.query = '';
      selectionDialog.selected = 0;
    } else if (selectionDialog.searchable && !key.ctrl && !key.meta) {
      const sequence = key.sequence ?? char ?? '';
      const cleaned = sequence.replace(/[\x00-\x1f\x7f]/g, '');
      if (cleaned) {
        selectionDialog.query += cleaned;
        selectionDialog.selected = 0;
      }
    }
    renderDynamic();
  }

  function finishTextInput(value: string | undefined): void {
    const active = textInputDialog;
    if (!active) return;
    textInputDialog = null;
    renderDynamic();
    active.resolve(value);
  }

  function handleTextInputKey(char: string | undefined, key: Key): void {
    if (!textInputDialog) return;
    const name = key.name ?? '';
    const inputEditor = textInputDialog.editor;
    if (name === 'return' || name === 'enter') {
      finishTextInput(inputEditor.text);
      return;
    }
    if (name === 'escape' || (name === 'c' && key.ctrl)) {
      finishTextInput(undefined);
      return;
    }
    if (key.ctrl) {
      if (name === 'a') inputEditor.moveHome();
      else if (name === 'e') inputEditor.moveEnd();
      else if (name === 'u') inputEditor.clear();
      else if (name === 'w') inputEditor.deleteWordLeft();
    } else if (name === 'backspace') {
      inputEditor.backspace();
    } else if (name === 'delete') {
      inputEditor.deleteForward();
    } else if (name === 'left') {
      inputEditor.moveLeft();
    } else if (name === 'right') {
      inputEditor.moveRight();
    } else if (name === 'home') {
      inputEditor.moveHome();
    } else if (name === 'end') {
      inputEditor.moveEnd();
    } else {
      const sequence = key.sequence ?? char ?? '';
      const cleaned = sequence.replace(/[\x00-\x1f\x7f]/g, '');
      if (cleaned) inputEditor.insert(cleaned);
    }
    renderDynamic();
  }

  function handleKey(char: string | undefined, key: Key): void {
    if (shuttingDown) return;
    const name = key.name ?? '';

    if (name !== 'c' || !key.ctrl) {
      ctrlCCount = 0;
    }

    if (dialog) {
      handleDialogKey(key);
      return;
    }
    if (selectionDialog) {
      handleSelectionKey(char, key);
      return;
    }
    if (textInputDialog) {
      handleTextInputKey(char, key);
      return;
    }

    if (key.ctrl) {
      switch (name) {
        case 'c': {
          ctrlCCount += 1;
          if (ctrlCTimer) clearTimeout(ctrlCTimer);
          ctrlCTimer = setTimeout(() => {
            ctrlCCount = 0;
          }, CTRL_C_EXIT_WINDOW_MS);
          if (ctrlCCount >= 2) {
            void shutdown(0);
            return;
          }
          if (running && abortCtrl) {
            abortCtrl.abort();
          } else if (!editor.isEmpty()) {
            editor.clear();
            menuSelected = 0;
          }
          renderDynamic();
          return;
        }
        case 'd':
          if (editor.isEmpty()) {
            void shutdown(0);
            return;
          }
          editor.deleteForward();
          break;
        case 'a':
          editor.moveHome();
          break;
        case 'e':
          editor.moveEnd();
          break;
        case 'k':
          editor.killToEnd();
          break;
        case 'u':
          editor.killToStart();
          break;
        case 'w':
          editor.deleteWordLeft();
          break;
        case 'left':
          editor.moveWordLeft();
          break;
        case 'right':
          editor.moveWordRight();
          break;
        case 'l':
          process.stdout.write('\x1b[2J\x1b[H');
          break;
        case 'j':
          editor.insert('\n');
          break;
        default:
          break;
      }
      renderDynamic();
      return;
    }

    switch (name) {
      case 'return': {
        if (key.meta) {
          editor.insert('\n');
          break;
        }
        void submit();
        return;
      }
      case 'enter':
        editor.insert('\n');
        break;
      case 'escape': {
        if (running && abortCtrl) {
          abortCtrl.abort();
        } else if (!editor.isEmpty()) {
          editor.clear();
          menuSelected = 0;
        }
        break;
      }
      case 'backspace':
        editor.backspace();
        menuSelected = 0;
        atSelected = 0;
        break;
      case 'delete':
        editor.deleteForward();
        break;
      case 'left':
        if (key.meta) editor.moveWordLeft();
        else editor.moveLeft();
        break;
      case 'right':
        if (key.meta) editor.moveWordRight();
        else editor.moveRight();
        break;
      case 'home':
        editor.moveHome();
        break;
      case 'end':
        editor.moveEnd();
        break;
      case 'up': {
        const atToken = activeAtToken(editor.text, editor.cursor);
        const atCount = atToken ? atCompletions(atToken.token).length : 0;
        const menu = filterSlashCommands(editor.text);
        if (atCount > 0) {
          atSelected = (atSelected + atCount - 1) % atCount;
        } else if (menu.length > 0) {
          menuSelected = (menuSelected + menu.length - 1) % menu.length;
        } else if (!editor.onFirstLine()) {
          editor.moveUp();
        } else {
          editor.historyPrev();
        }
        break;
      }
      case 'down': {
        const atToken = activeAtToken(editor.text, editor.cursor);
        const atCount = atToken ? atCompletions(atToken.token).length : 0;
        const menu = filterSlashCommands(editor.text);
        if (atCount > 0) {
          atSelected = (atSelected + 1) % atCount;
        } else if (menu.length > 0) {
          menuSelected = (menuSelected + 1) % menu.length;
        } else if (!editor.onLastLine()) {
          editor.moveDown();
        } else {
          editor.historyNext();
        }
        break;
      }
      case 'tab': {
        if (applyAtCompletion()) break;
        const menu = filterSlashCommands(editor.text);
        if (menu.length > 0) {
          const selected = menu[Math.min(menuSelected, menu.length - 1)]!;
          editor.setText(`/${selected} `);
        }
        break;
      }
      default: {
        const sequence = key.sequence ?? char ?? '';
        if (sequence) {
          const cleaned = sequence
            .replace(/\x1b\[20[01]~/g, '')
            .replace(/\r\n?/g, '\n')
            .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (match) => (match === '\n' ? '\n' : ''));
          if (cleaned) {
            editor.insert(cleaned);
            menuSelected = 0;
            atSelected = 0;
          }
        }
        break;
      }
    }
    renderDynamic();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    let exitCode = code;
    if (spinnerTimer) clearInterval(spinnerTimer);
    cancelScheduledDynamicRender();
    abortCtrl?.abort();
    screen.stop();
    process.stdout.write(`${A.dim}Goodbye.${A.reset}\n`);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    if (managedPluginRuntime) {
      try {
        await closeManagedPluginsForExit(managedPluginRuntime.close);
      } catch (error) {
        exitCode = 1;
        process.stderr.write(
          `[hadamard-tui] ERROR: ${errorMessage(error)} ` +
          'Check E2B/Playwright resources manually before assuming billing has stopped.\n',
        );
      }
    }
    const cleanupResults = await Promise.allSettled([
      sdk.close(),
      ...(globalAssistantSdk ? [globalAssistantSdk.close()] : []),
      externalCliRuntimeManager.close(),
      ...[...externalBridgeRuntimes.values()].map(runtime => runtime.client.close()),
    ]);
    const cleanupFailures = cleanupResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (cleanupFailures.length > 0) {
      exitCode = 1;
      process.stderr.write(
        `[hadamard-tui] ERROR: ${cleanupFailures.length} runtime cleanup operation(s) failed: ` +
        `${cleanupFailures.map(result => errorMessage(result.reason)).join('; ')}\n`,
      );
    }
    externalBridgeRuntimes.clear();
    externalCliRunLabels.clear();
    process.exit(exitCode);
  }

  screen.start();
  appendStatic(
    formatBanner({
      workDir,
      model: session.model,
      toolCount: toolMetadata.length,
      permissionMode: currentPermissionMode(),
      width: screen.width,
    }),
  );
  await restoreSessionRuntimeSelection();
  renderDynamic();

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', (char: string | undefined, key: Key | undefined) => {
    try {
      handleKey(char, key ?? {});
    } catch (error) {
      appendStatic(formatErrorLine(`input error: ${(error as Error).message}`));
      renderDynamic();
    }
  });
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
  process.stdout.on('resize', () => renderDynamic());

  // Keep the process alive until shutdown() exits it.
  await new Promise(() => {});
}

// Allow running this module directly (`npx tsx src/tui/hadamardTui.ts`), not only
// via the cli/ wrapper. Requires an interactive terminal.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'hadamard TUI requires an interactive terminal (TTY). Run it directly in your terminal — not piped or through another tool.\n',
    );
    process.exit(1);
  }
  runHadamardTui().catch((error: unknown) => {
    process.stderr.write(`Fatal: ${(error as Error).stack ?? (error as Error).message}\n`);
    process.exit(1);
  });
}
