#!/usr/bin/env node
/**
 * Actoviq — Interactive terminal agent.
 *
 * Clean SDK scrollback-mode REPL with readline input, slash commands,
 * and real-time streaming output. Uses the main terminal buffer for
 * native scrollback.
 */
import {
  createAgentSdk,
  loadJsonConfigFile,
  loadDefaultActoviqSettings,
  getLoadedJsonConfig,
  createActoviqCoreTools,
  createManagedPluginRuntime,
  resolveActoviqSettingsStore,
  type ActoviqPermissionMode,
  type ActoviqToolApprover,
  type AgentToolDefinition,
  type TeamDefinition,
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
  resolveActoviqHome,
  externalSkillPreferencesToRuntimeOptions,
  readActoviqExternalSkillPreferences,
  transitionProjectIssue,
  WorktreeService,
  GoalService,
} from 'actoviq-agent-sdk';
import { readProjectMeta } from '../gui/projectMeta.js';
import { readWorkspaceRegistry } from '../gui/workspaceRegistry.js';
import {
  LegacySurfaceEventPipeline,
} from '../surfaces/index.js';
import { applyTeamRunEvent, createTeamRunViewState, formatTeamRunTreeLines } from '../team/teamRunView.js';
import { execSync } from 'node:child_process';
import path from 'node:path';
import * as readline from 'node:readline';
import { hasVersionFlag, readPackageVersion } from './version.js';
import { planFilePath, readPlanFile } from '../tools/planMode/PlanModeTools.js';

if (hasVersionFlag(process.argv.slice(2))) {
  process.stdout.write(`${readPackageVersion(import.meta.url)}\n`);
  process.exit(0);
}

const WORK_DIR = path.resolve(process.argv[2] ?? process.cwd());
const CONFIG_PATH = process.argv[3] ?? path.join(resolveActoviqHome(), 'settings.json');
const DEFAULT_PERMISSION_MODE = 'bypassPermissions';
const MANAGED_PLUGIN_FINAL_CLOSE_ATTEMPTS = 2;
const MANAGED_PLUGIN_FINAL_CLOSE_TIMEOUT_MS = 35_000;
const PERMISSION_MODES = new Set<ActoviqPermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'auto',
]);

let isGit = false;
try { execSync('git rev-parse --is-inside-work-tree', { cwd: WORK_DIR, stdio: 'ignore' }); isGit = true; } catch {}

// ── ANSI ────────────────────────────────────────────────────────────

const C = {
  r: '\x1b[0m', d: '\x1b[2m', c: '\x1b[36m', y: '\x1b[33m',
  g: '\x1b[32m', R: '\x1b[31m', b: '\x1b[1m', m: '\x1b[35m',
};

function stripAnsi(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function surfaceRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function surfaceString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function surfaceInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

// ── System prompt ────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  `You are Actoviq, an interactive CLI agent. Working directory: ${WORK_DIR}\n\n` +
  `<env>\nWorking directory: ${WORK_DIR}\nIs git repo: ${isGit ? 'Yes' : 'No'}\nPlatform: ${process.platform}\nDate: ${new Date().toISOString().slice(0, 10)}\n</env>\n\n` +
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
  `- When in doubt, use TodoWrite to track progress.`;

// ── Slash commands ────────────────────────────────────────────────────

const CMDS: Record<string, string> = {
  help:    'Show available commands',
  clear:   'Clear the screen',
  exit:    'Quit',
  compact: 'Compact the current session',
  memory:  'Show memory/compact state',
  model:   'Show or set the session model',
  permissions: 'Show or set the permission mode',
  plan:    'Enter, review, approve, or revise a read-only plan',
  goal:    'Create, inspect, pause, resume, or clear a persistent goal',
  checkpoint: 'List, preview, or restore file/conversation checkpoints',
  sessions: 'List stored sessions',
  resume:  'Resume a stored session',
  tools:   'List available tools',
  dream:   'Trigger memory consolidation',
  workflows: 'List or run dynamic workflows',
  worktree: 'Enter, exit, or list git worktrees',
  team:    'List, attach, or run Model Teams',
  issues:  'List or update project issues',
  manager: 'Project Manager: progress docs + status',
};

function completer(line: string): [string[], string] {
  if (!line.startsWith('/')) return [[], line];
  const partial = line.slice(1).toLowerCase();
  const hits = Object.keys(CMDS).filter(c => c.startsWith(partial));
  return [hits.map(h => hits.length === 1 ? `/${h} ` : `/${h}`), line];
}

// ── Render helpers ────────────────────────────────────────────────────

function toolLine(name: string, input: Record<string, unknown>) {
  const inp = JSON.stringify(input);
  process.stdout.write(`${C.y}  ⚡ ${name}${C.r} ${C.d}${inp.slice(0, 120)}${inp.length > 120 ? '...' : ''}${C.r}\n`);
}

function resultLine(isErr: boolean, dur?: number, output?: unknown) {
  const ok = isErr ? `${C.R}✗` : `${C.g}✓`;
  const d = dur ? ` ${dur < 1000 ? dur + 'ms' : (dur / 1000).toFixed(1) + 's'}` : '';
  let o = '';
  if (typeof output === 'string') o = output.slice(0, 200);
  else if (output) o = JSON.stringify(output).slice(0, 200);
  process.stdout.write(`${ok}${C.r}${C.d}${d} ${o}${C.r}\n`);
}

// ═══════════════════════════════════════════════════════════════════════

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
        new Promise<never>((_, reject) => {
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
        `[actoviq-react] warning: managed plugin cleanup attempt ${attempt}/` +
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

async function main() {
  // Header
  const w = process.stdout.columns || 80;
  process.stdout.write(`\n${C.c}${C.b}╭${'─'.repeat(Math.min(w - 2, 60))}╮${C.r}\n`);
  process.stdout.write(`${C.c}│${C.r}  dir     : ${C.y}${WORK_DIR.slice(0, 45)}${C.r}\n`);

  let applyPlanPermission: (() => Promise<void>) | undefined;
  const coreTools = createActoviqCoreTools({
    cwd: WORK_DIR,
    onPlanModeChange: async mode => {
      if (mode === 'plan') await applyPlanPermission?.();
    },
  });
  const userSuppliedConfig = Boolean(process.argv[3]);
  try {
    if (userSuppliedConfig) await loadJsonConfigFile(CONFIG_PATH);
    else await loadDefaultActoviqSettings();
  } catch (e) {
    if (userSuppliedConfig) {
      // User explicitly pointed at a config — fail loud, don't silently fall
      // back to defaults (that's the bug this fixes). Empty REPL startup
      // would let the user believe their config was loaded.
      process.stderr.write(
        `${C.R}✕ Failed to load config "${process.argv[3]}":${C.r}\n` +
        `  ${(e as Error).message}\n\n` +
        `${C.d}Actoviq refused to start with a bad explicit config. Fix the file or omit the path to use defaults.${C.r}\n`,
      );
      process.exit(2);
    }
    // Default-settings path: tolerate and warn. A missing ~/.actoviq/settings.json
    // is normal on first run; surface other errors so users can diagnose.
    const msg = (e as Error).message || String(e);
    if (!/not found|ENOENT/i.test(msg)) {
      process.stderr.write(`${C.y}⚠ Default settings load failed: ${msg}${C.r}\n`);
    }
  }
  const managedPluginRuntime = await resolveActoviqSettingsStore({
    configPath: CONFIG_PATH,
  }).then(store => createManagedPluginRuntime(store.raw, {
    cwd: WORK_DIR,
  })).catch(() => ({
    tools: [] as AgentToolDefinition[],
    enabledPluginIds: [],
    close: async () => undefined,
  }));
  const tools = [...new Map(
    [...coreTools, ...managedPluginRuntime.tools].map(tool => [tool.name, tool]),
  ).values()];
  const externalSkillPreferences = await readActoviqExternalSkillPreferences({
    actoviqHomeDir: resolveActoviqHome(),
    workDir: WORK_DIR,
  });
  let pendingToolApproval: {
    resolve: (outcome: { behavior: 'allow' | 'deny'; reason: string }) => void;
  } | null = null;
  const approver: ActoviqToolApprover = async context => {
    if (!process.stdin.isTTY) {
      return {
        behavior: 'deny',
        reason: 'Interactive approval requires a TTY.',
      };
    }
    if (pendingToolApproval) {
      return {
        behavior: 'deny',
        reason: 'Another tool approval is already pending.',
      };
    }
    let input = '';
    try {
      input = JSON.stringify(context.input);
    } catch {
      input = '[unserializable input]';
    }
    process.stdout.write(
      `\n${C.y}Approval required:${C.r} ${C.b}${context.publicName}${C.r}\n` +
      `${C.d}${context.reason}${input ? `\n${input.slice(0, 500)}` : ''}${C.r}\n` +
      'Allow this tool once? [y/N] ',
    );
    return await new Promise<{ behavior: 'allow' | 'deny'; reason: string }>(resolve => {
      pendingToolApproval = { resolve };
    });
  };
  const sdk = await createAgentSdk({
    workDir: WORK_DIR,
    tools,
    permissionMode: DEFAULT_PERMISSION_MODE,
    approver,
    externalSkills: externalSkillPreferencesToRuntimeOptions(externalSkillPreferences),
  });
  const toolMetadata = await sdk.listToolMetadata();
  let session = await sdk.createSession({
    title: path.basename(WORK_DIR),
    permissionMode: DEFAULT_PERMISSION_MODE,
  });
  await session.setPermissionContext({
    mode: session.permissionContext.mode ?? DEFAULT_PERMISSION_MODE,
    permissions: session.permissionContext.permissions,
    approver,
  });
  applyPlanPermission = async () => {
    await session.setPermissionContext({
      mode: 'plan',
      permissions: [],
      approver,
    });
  };

  process.stdout.write(`${C.c}│${C.r}  model   : ${C.y}${session.model}${C.r}\n`);
  process.stdout.write(`${C.c}│${C.r}  tools   : ${C.y}${toolMetadata.length} tools loaded${C.r}\n`);
  process.stdout.write(`${C.c}│${C.r}  keys    : Tab=complete  ↑↓=history  Ctrl+C=abort${C.r}\n`);
  process.stdout.write(`${C.c}├${'─'.repeat(Math.min(w - 2, 60))}┤${C.r}\n\n`);

  let abortCtrl: AbortController | null = null;
  let msgCount = 0;
  // Persistent Manager session (kind: 'manager') — reused across /manager
  // update/chat turns so the Manager keeps its own conversation context.
  let managerSession: Awaited<ReturnType<typeof sdk.createSession>> | null = null;
  const assistantTeamProposals = new TeamProposalStore();
  async function interactiveSessionCatalog(): Promise<SessionCatalog> {
    const registered = await readWorkspaceRegistry(sdk.config.homeDir);
    return new SessionCatalog({
      homeDir: sdk.config.homeDir,
      projectPaths: [WORK_DIR, ...registered.map(item => item.path)],
    });
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
        permissionMode: DEFAULT_PERMISSION_MODE,
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
      ? await globalAssistantSdk.resumeSession(existing.id, { permissionMode: DEFAULT_PERMISSION_MODE })
      : await globalAssistantSdk.createSession({
        title: 'Assistant (Global)',
        kind: 'manager',
        metadata: { __actoviqKind: 'manager', __actoviqAssistantScope: 'global' },
        permissionMode: DEFAULT_PERMISSION_MODE,
      });
    if (config.activeSessionId !== globalAssistantSession.id) {
      await writeAssistantConfig({ ...config, activeSessionId: globalAssistantSession.id }, homeDir);
    }
    return globalAssistantSession;
  }
  async function runGlobalAssistantCommand(sub: string): Promise<void> {
    const homeDir = sdk.config.homeDir;
    const globalSession = await resolveGlobalAssistantSession();
    const config = await readAssistantConfig(homeDir);
    if (sub === 'sessions') {
      const sessions = (await globalAssistantSdk!.sessions.list()).filter(item => item.kind === 'manager');
      process.stdout.write(`${C.b}Global Assistant Sessions${C.r}\n`);
      for (const item of sessions) {
        process.stdout.write(`${item.id === config.activeSessionId ? C.g : C.d}${item.id} · ${item.title} · ${item.messageCount} messages${C.r}\n`);
      }
      process.stdout.write('\n');
      return;
    }
    if (sub === 'new') {
      globalAssistantSession = await globalAssistantSdk!.createSession({
        title: 'Assistant (Global)',
        kind: 'manager',
        metadata: { __actoviqKind: 'manager', __actoviqAssistantScope: 'global' },
        permissionMode: DEFAULT_PERMISSION_MODE,
      });
      await writeAssistantConfig({ ...config, activeSessionId: globalAssistantSession.id }, homeDir);
      process.stdout.write(`${C.g}Global Assistant Session created: ${globalAssistantSession.id}${C.r}\n\n`);
      return;
    }
    if (sub.startsWith('resume ')) {
      const id = sub.slice('resume '.length).trim();
      const found = (await globalAssistantSdk!.sessions.list())
        .find(item => item.id === id && item.kind === 'manager');
      if (!found) {
        process.stdout.write(`${C.R}Global Assistant Session not found: ${id}${C.r}\n\n`);
        return;
      }
      globalAssistantSession = await globalAssistantSdk!.resumeSession(id, { permissionMode: DEFAULT_PERMISSION_MODE });
      await writeAssistantConfig({ ...config, activeSessionId: id }, homeDir);
      process.stdout.write(`${C.g}Global Assistant Session selected: ${found.title}${C.r}\n\n`);
      return;
    }
    const isTeam = sub === 'team' || sub.startsWith('team ');
    const isChat = sub === 'chat' || sub.startsWith('chat ') || isTeam;
    const prompt = isTeam
      ? (sub === 'team' ? '' : `Propose a Team Graph for this request. Use an explicit registered projectPath. ${sub.slice('team'.length).trim()}`)
      : isChat ? sub.slice('chat'.length).trim() : '';
    if (!prompt) {
      process.stdout.write(`${C.d}Usage: /assistant [chat <message>|sessions|new|resume <id>|team <request>]${C.r}\n\n`);
      return;
    }
    const proposals: import('../team/teamProposalService.js').TeamGraphProposal[] = [];
    const assistantTools = [
      ...await createAssistantGlobalTools({ homeDir, currentWorkDir: WORK_DIR }),
      ...createAssistantTeamTools({
        scope: 'global',
        assistantSessionId: globalSession.id,
        currentWorkDir: WORK_DIR,
        homeDir,
        proposals: assistantTeamProposals,
        onProposal: proposal => { proposals.push(proposal); },
      }),
    ];
    const stream = globalSession.stream(prompt, {
      systemPrompt: `${buildAssistantGlobalSystemPrompt(WORK_DIR)}\n${buildAssistantTeamSystemPrompt('global')}`,
      tools: assistantTools,
      ...(config.model ? { model: config.model } : {}),
      __actoviqUseDefaultTools: false,
      __actoviqAllowedTools: assistantTools.map(item => item.name),
    } as Parameters<typeof globalSession.stream>[1]);
    for await (const event of stream) {
      if (event.type === 'tool.call') toolLine(
        event.call.name,
        surfaceRecord(event.call.input) ?? {},
      );
    }
    const result = await stream.result;
    if (result.text) process.stdout.write(`${result.text}\n`);
    for (const proposal of proposals) {
      process.stdout.write(`${C.b}Team proposal · ${proposal.teamName}${C.r}\n`);
      for (const [label, values] of [
        ['+ nodes', proposal.diff.addedNodes],
        ['- nodes', proposal.diff.removedNodes],
        ['~ nodes', proposal.diff.changedNodes],
        ['+ edges', proposal.diff.addedEdges],
        ['- edges', proposal.diff.removedEdges],
        ['~ edges', proposal.diff.changedEdges],
      ] as Array<[string, string[]]>) {
        if (values.length) process.stdout.write(`${C.d}${label}: ${values.join(', ')}${C.r}\n`);
      }
      if (proposal.problems.length) {
        process.stdout.write(`${C.R}${proposal.problems.join('\n')}${C.r}\n`);
        assistantTeamProposals.reject(proposal.id);
        continue;
      }
      const choice = await new Promise<string>(resolve => {
        rl.question(`${C.y}Apply this Team proposal? [y/N] ${C.r}`, answer => resolve(answer.trim().toLowerCase()));
      });
      if (choice === 'y' || choice === 'yes') {
        const applied = await assistantTeamProposals.apply(proposal.id, homeDir);
        process.stdout.write(`${C.g}Team saved: ${applied.filePath}${C.r}\n`);
      } else {
        assistantTeamProposals.reject(proposal.id);
      }
    }
    process.stdout.write('\n');
  }

  // ── Team state (Phase 0: attach / autoInvoke / status) ─────────
  const teamPrefs = readTeamPreferences(getLoadedJsonConfig()?.raw);
  let activeTeamTool: AgentToolDefinition | null = null;
  let activeTeamName: string | null = null;
  let lastTeamRunSummary: string | null = null;

  const attachTeam = (name: string): TeamDefinition | null => {
    const loaded = loadTeamDefinition(name, sdk.config.workDir);
    if (!loaded) return null;
    const definition = instantiateTeamDefinition(loaded.definition, session.model);
    activeTeamTool = createTeamTool(definition);
    activeTeamName = definition.name;
    return definition;
  };

  if (teamPrefs.defaultAttached) {
    // Silently ignore unresolvable names; /team status surfaces the hint.
    try { attachTeam(teamPrefs.defaultAttached); } catch { /* ignore */ }
  }

  async function resolveManagerSession() {
    if (managerSession) return managerSession;
    const cfg = await readManagerConfig(WORK_DIR, sdk.config.homeDir);
    const managers = (await sdk.sessions.list()).filter(item => item.kind === 'manager');
    managers.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const existing = managers.find(item => item.id === cfg.activeSessionId) ?? managers[0];
    if (existing) {
      managerSession = await sdk.resumeSession(existing.id, { permissionMode: DEFAULT_PERMISSION_MODE });
      if (cfg.activeSessionId !== existing.id) {
        await writeManagerConfig(WORK_DIR, sdk.config.homeDir, {
          ...cfg,
          activeSessionId: existing.id,
        });
      }
      await managerSession.setPermissionContext({
        mode: managerSession.permissionContext.mode ?? DEFAULT_PERMISSION_MODE,
        permissions: managerSession.permissionContext.permissions,
        approver,
      });
      return managerSession;
    }
    managerSession = await sdk.createSession({
      title: 'Manager',
      metadata: { __actoviqKind: 'manager' },
      permissionMode: DEFAULT_PERMISSION_MODE,
    });
    await writeManagerConfig(WORK_DIR, sdk.config.homeDir, {
      ...cfg,
      activeSessionId: managerSession.id,
    });
    await managerSession.setPermissionContext({
      mode: managerSession.permissionContext.mode ?? DEFAULT_PERMISSION_MODE,
      permissions: managerSession.permissionContext.permissions,
      approver,
    });
    return managerSession;
  }

  // ── Process message ────────────────────────────────────────────

  async function processMsg(text: string) {
    const t = text.trim();
    if (!t) return;
    msgCount++;

    if (t.startsWith('/')) {
      const sp = t.indexOf(' '); const cmd = sp === -1 ? t.slice(1) : t.slice(1, sp);
      switch (cmd) {
        case 'exit':
          await shutdown(0);
          return;
        case 'clear': process.stdout.write('\x1b[2J\x1b[H'); return;
        case 'help':
          process.stdout.write(`\n${C.b}Commands:${C.r}\n`);
          for (const [k, v] of Object.entries(CMDS))
            process.stdout.write(`  ${C.y}/${k.padEnd(10)}${C.r} ${C.d}${v}${C.r}\n`);
          process.stdout.write(`\n`);
          return;
        case 'model': {
          const requested = sp === -1 ? '' : t.slice(sp + 1).trim();
          if (!requested) {
            process.stdout.write(`${C.d}Model: ${C.y}${session.model}${C.r}\n\n`);
            return;
          }
          await session.setModel(requested === 'default' ? sdk.config.model : requested);
          process.stdout.write(`${C.g}Model set to ${C.y}${session.model}${C.r}\n\n`);
          return;
        }
        case 'permissions': {
          const requested = sp === -1 ? '' : t.slice(sp + 1).trim();
          const state = session.permissionContext;
          if (!requested) {
            process.stdout.write(
              `${C.d}Permissions: ${C.y}${state.mode ?? DEFAULT_PERMISSION_MODE}${C.r}` +
              `${C.d} (${state.permissions.length} session rules)${C.r}\n\n`,
            );
            return;
          }
          if (!PERMISSION_MODES.has(requested as ActoviqPermissionMode)) {
            process.stdout.write(
              `${C.R}Invalid mode. Use: ${[...PERMISSION_MODES].join(', ')}${C.r}\n\n`,
            );
            return;
          }
          await session.setPermissionContext({
            mode: requested as ActoviqPermissionMode,
            permissions: state.permissions,
            approver,
          });
          process.stdout.write(`${C.g}Permission mode set to ${C.y}${requested}${C.r}\n\n`);
          return;
        }
        case 'sessions': {
          const args = sp === -1 ? '' : t.slice(sp + 1).trim();
          if (args) {
            const value = (flag: string) => args.match(new RegExp(`(?:^|\\s)--${flag}\\s+("[^"]+"|\\S+)`))?.[1]?.replace(/^"|"$/g, '');
            const rawType = value('type') || 'user';
            const page = await (await interactiveSessionCatalog()).query({
              types: rawType === 'all'
                ? ['user', 'assistant-global', 'assistant-project', 'agent']
                : [rawType as import('../storage/sessionCatalog.js').SessionCatalogType],
              archived: value('archived') === 'all' ? 'all' : value('archived') === 'archived',
              ...(value('project') ? { projectPaths: [value('project')!] } : {}),
              ...(value('status')
                ? { runtimeStatuses: [value('status') as import('../storage/sessionCatalog.js').SessionCatalogRuntimeStatus] }
                : {}),
              keyword: value('query'),
              pageSize: 200,
            });
            for (const item of page.items) {
              process.stdout.write(`${C.d}${item.pinned ? '★' : ' '} ${item.locator.sessionId} · ${item.projectName} · ${item.type} · ${item.title}${item.archived ? ' · archived' : ''}${C.r}\n`);
            }
            process.stdout.write('\n');
            return;
          }
          const sessions = await sdk.sessions.list();
          if (sessions.length === 0) {
            process.stdout.write(`${C.d}No stored sessions.${C.r}\n\n`);
            return;
          }
          for (const stored of sessions.filter(item => item.kind !== 'manager')) {
            const current = stored.id === session.id ? '*' : ' ';
            process.stdout.write(
              `${C.d}${current} ${stored.id}  ${stored.title}  ${stored.model}${C.r}\n`,
            );
          }
          process.stdout.write('\n');
          return;
        }
        case 'resume': {
          const sessionId = sp === -1 ? '' : t.slice(sp + 1).trim();
          if (!sessionId) {
            process.stdout.write(`${C.R}Usage: /resume <session-id>${C.r}\n\n`);
            return;
          }
          const listed = await sdk.sessions.list();
          const target = listed.find(item => item.id === sessionId);
          if (target?.kind === 'manager') {
            process.stdout.write(`${C.R}Manager sessions live in the Project Manager panel only.${C.r}\n\n`);
            return;
          }
          session = await sdk.resumeSession(sessionId);
          await session.setPermissionContext({
            mode: session.permissionContext.mode ?? DEFAULT_PERMISSION_MODE,
            permissions: session.permissionContext.permissions,
            approver,
          });
          process.stdout.write(
            `${C.g}Resumed ${session.id}: ${session.title} (${session.model})${C.r}\n\n`,
          );
          return;
        }
        case 'tools':
          process.stdout.write(`${C.d}${toolMetadata.map(t => `${C.y}${t.name}${C.r}`).join(', ')}${C.r}\n\n`);
          return;
        case 'memory':
          if (sp !== -1 && /^(proposals|apply|reject)\b/u.test(t.slice(sp + 1).trim())) {
            try {
              const { MemoryProposalCommandService } = await import('../memory/memoryProposalCommandService.js');
              const result = await new MemoryProposalCommandService(
                sdk.config.homeDir,
                sdk.config.workDir,
              ).execute(t.slice(sp + 1).trim());
              process.stdout.write(`${C.g}${result.message}${C.r}\n`);
              for (const item of result.items ?? []) {
                process.stdout.write(`${C.d}${item.label}${item.description ? ` · ${item.description}` : ''}${C.r}\n`);
              }
              process.stdout.write('\n');
            } catch (error) {
              process.stdout.write(`${C.R}${error instanceof Error ? error.message : String(error)}${C.r}\n\n`);
            }
            return;
          }
          try { const s = await session.compactState();
            process.stdout.write(`${C.d}${JSON.stringify(s as any, null, 2)}${C.r}\n\n`); }
          catch { process.stdout.write(`${C.d}N/A${C.r}\n\n`); }
          return;
        case 'rules': {
          try {
            const { RuleCommandService } = await import('../context/ruleCommandService.js');
            const result = await new RuleCommandService(
              sdk.config.homeDir,
              sdk.config.workDir,
            ).execute(sp === -1 ? 'list' : t.slice(sp + 1).trim());
            process.stdout.write(`${C.g}${result.message}${C.r}\n`);
            for (const item of result.items ?? []) {
              process.stdout.write(`${C.d}${item.label}${item.description ? ` · ${item.description}` : ''}${C.r}\n`);
            }
            process.stdout.write('\n');
          } catch (error) {
            process.stdout.write(`${C.R}${error instanceof Error ? error.message : String(error)}${C.r}\n\n`);
          }
          return;
        }
        case 'compact':
          try {
            const summaryInstructions = sp === -1 ? undefined : t.slice(sp + 1).trim() || undefined;
            const r = await session.compact({ force: true, summaryInstructions });
            if (!r.compacted) {
              process.stdout.write(
                `${C.R}Compact failed: ${r.error ?? r.reason}${C.r}` +
                `${C.d}${r.consecutiveFailures ? ` (${r.consecutiveFailures} failures)` : ''}${C.r}\n\n`,
              );
              return;
            }
            process.stdout.write(`${C.g}✓ Compacted: ${r.messagesRemoved ?? '?'} msgs removed${C.r}\n\n`);
          } catch (e: any) {
            process.stdout.write(`${C.R}✕ ${e.message}${C.r}\n\n`);
          }
          return;
        case 'dream':
          try { await session.dream({ force: true });
            process.stdout.write(`${C.g}✓ Dream triggered${C.r}\n\n`); }
          catch (e: any) { process.stdout.write(`${C.R}✕ ${e.message}${C.r}\n\n`); }
          return;
        // ── v0.5.0: Dynamic Workflows ──────────────────────────────
        case 'workflows': {
          const sub = t.slice(sp + 1).trim();
          if (!sub || sub === 'list') {
            const workflows = listWorkflows(sdk.config.workDir);
            if (workflows.length === 0) {
              process.stdout.write(`${C.d}No saved workflows. Save scripts to .actoviq/workflows/${C.r}\n\n`);
            } else {
              for (const w of workflows) {
                process.stdout.write(`${C.c}/${w.name}${C.r}${C.d} · ${w.source} · ${w.description.slice(0, 60)}${C.r}\n`);
              }
              process.stdout.write('\n');
            }
            return;
          }
          if (sub.startsWith('run ')) {
            const runRest = sub.slice(4).trim();
            const runSpace = runRest.indexOf(' ');
            const wfName = runSpace === -1 ? runRest : runRest.slice(0, runSpace);
            const wfTask = runSpace === -1 ? undefined : runRest.slice(runSpace + 1).trim();
            const wf = loadWorkflow(wfName, sdk.config.workDir);
            if (!wf) {
              process.stdout.write(`${C.R}Workflow not found: ${wfName}${C.r}\n\n`);
              return;
            }
            process.stdout.write(`${C.d}Running workflow: ${wfName}...${C.r}\n`);
            try {
              const { WorkflowScriptRuntime } = await import('../workflow/workflowScriptRuntime.js');
              const runtime = new WorkflowScriptRuntime({
                sdk: sdk as any,
                trust: 'trusted',
                args: wfTask,
                onEvent: (e: any) => {
                  if (e.type === 'workflow.log') process.stdout.write(`${C.d}  │ ${e.message}${C.r}\n`);
                  else if (e.type === 'workflow.agent.start') process.stdout.write(`${C.d}  ⚡ agent: ${e.label ?? e.agentId}${C.r}\n`);
                  else if (e.type === 'workflow.script.done') process.stdout.write(`${C.g}✓ Workflow done · ${e.agentCount} agents · ${e.totalTokens} tokens${C.r}\n\n`);
                },
              });
              const output = await runtime.execute(wf.script);
              if (typeof output.result === 'string' && output.result.trim()) {
                process.stdout.write(`\n${output.result}\n\n`);
              }
              if (output.state.errors.length > 0) {
                process.stdout.write(`${C.R}  ${output.state.errors.length} errors${C.r}\n`);
                for (const err of output.state.errors.slice(0, 3)) {
                  process.stdout.write(`${C.d}    - ${err.error}${C.r}\n`);
                }
                process.stdout.write('\n');
              }
            } catch (err: any) {
              process.stdout.write(`${C.R}✕ Workflow failed: ${err.message}${C.r}\n\n`);
            }
            return;
          }
          process.stdout.write(`${C.d}Usage: /workflows [list|run <name>]${C.r}\n\n`);
          return;
        }
        // ── v0.5.0: Worktrees ──────────────────────────────────────
        case 'worktree': {
          const sub = t.slice(sp + 1).trim();
          const ws = new WorktreeService(sdk.config.workDir);
          if (!sub || sub === 'list') {
            await ws.init();
            const trees = await ws.listWorktrees();
            if (trees.length === 0) {
              process.stdout.write(`${C.d}No worktrees found.${C.r}\n\n`);
            } else {
              for (const t of trees) {
                const status = t.isDirty ? `${C.y}dirty${C.r}` : `${C.g}clean${C.r}`;
                process.stdout.write(`${C.d}${t.path}${C.r} · ${status}\n`);
              }
              process.stdout.write('\n');
            }
            return;
          }
          if (sub === 'exit') {
            try {
              ws.exitWorktree();
              process.stdout.write(`${C.g}Exited worktree. cwd: ${ws.currentWorkDir}${C.r}\n\n`);
            } catch (e: any) {
              process.stdout.write(`${C.R}✕ ${e.message}${C.r}\n\n`);
            }
            return;
          }
          if (sub.startsWith('enter ')) {
            const wfName = sub.slice(6).trim();
            try {
              await ws.init();
              await ws.createAndEnterWorktree({ name: wfName });
              process.stdout.write(`${C.g}Entered worktree: ${wfName}${C.r}\n`);
              process.stdout.write(`${C.d}  cwd: ${ws.currentWorkDir}${C.r}\n`);
              process.stdout.write(`${C.d}  branch: ${ws.worktreeBranch}${C.r}\n\n`);
            } catch (e: any) {
              process.stdout.write(`${C.R}✕ ${e.message}${C.r}\n\n`);
            }
            return;
          }
          process.stdout.write(`${C.d}Usage: /worktree [enter <name>|exit|list]${C.r}\n\n`);
          return;
        }
        // ── v0.5.0: Model Team ─────────────────────────────────────
        case 'team': {
          const sub = sp === -1 ? '' : t.slice(sp + 1).trim();
          if (!sub || sub === 'list') {
            const teams = listTeamDefinitions(sdk.config.workDir);
            for (const item of teams) {
              const active = item.name === activeTeamName ? `${C.g}*${C.r}` : ' ';
              process.stdout.write(`${active}${C.c}${item.name}${C.r}${C.d} · ${item.definition.mode} · ${item.source} · ${countTeamAgents(item.definition)} agents${C.r}\n`);
            }
            process.stdout.write(`${C.d}\n/team attach <name> · /team ask <name> <prompt> · /team off · /team status${C.r}\n\n`);
            return;
          }
          if (sub === 'status') {
            const lines = [
              `attached: ${activeTeamName ?? 'none'}`,
              `autoInvoke: ${teamPrefs.autoInvoke ? 'on (main agent can call the team as a tool)' : 'off (manual /team ask only)'}`,
              `defaultAttached: ${teamPrefs.defaultAttached ?? 'none'}` +
                (teamPrefs.defaultAttached && !activeTeamName ? ` ${C.y}(not found)${C.r}` : ''),
              `last run: ${lastTeamRunSummary ?? 'none'}`,
            ];
            process.stdout.write(`${C.d}${lines.join('\n')}${C.r}\n\n`);
            return;
          }
          if (sub === 'off') {
            activeTeamTool = null;
            activeTeamName = null;
            process.stdout.write(`${C.d}team: none${C.r}\n\n`);
            return;
          }
          if (sub.startsWith('attach ')) {
            const teamName = sub.slice(7).trim();
            const definition = attachTeam(teamName);
            if (!definition) {
              process.stdout.write(`${C.R}Team not found: ${teamName}${C.r}\n\n`);
              return;
            }
            process.stdout.write(
              `${C.g}team attached: ${definition.name}${C.r}${C.d} (${definition.mode}) · autoInvoke ${teamPrefs.autoInvoke ? 'on' : 'off — run /team ask to use it'}${C.r}\n\n`,
            );
            return;
          }
          if (sub.startsWith('clone ')) {
            const parts = sub.slice(6).trim().split(/\s+/);
            if (parts.length !== 2) {
              process.stdout.write(`${C.R}Usage: /team clone <source> <new-name>${C.r}\n\n`);
              return;
            }
            try {
              const clone = await cloneTeamDefinition(parts[0]!, parts[1]!, { projectDir: sdk.config.workDir });
              process.stdout.write(`${C.g}team cloned: ${parts[0]} → ${clone.name}${C.r}${C.d} (${clone.filePath})${C.r}\n\n`);
            } catch (e: any) {
              process.stdout.write(`${C.R}✕ Clone failed: ${e.message}${C.r}\n\n`);
            }
            return;
          }
          if (sub.startsWith('ask ')) {
            const rest = sub.slice(4).trim();
            const spaceIdx = rest.indexOf(' ');
            if (spaceIdx === -1) {
              process.stdout.write(`${C.R}Usage: /team ask <name> <prompt>${C.r}\n\n`);
              return;
            }
            const teamName = rest.slice(0, spaceIdx);
            const prompt = rest.slice(spaceIdx + 1).trim();
            const loaded = loadTeamDefinition(teamName, sdk.config.workDir);
            if (!loaded) {
              process.stdout.write(`${C.R}Team not found: ${teamName}${C.r}\n\n`);
              return;
            }
            const definition = instantiateTeamDefinition(loaded.definition, session.model);
            const memberModels = listTeamAgentLabels(definition);
            process.stdout.write(`${C.d}Asking team "${teamName}" (${definition.mode})...${C.r}\n`);
            try {
              const team = createModelTeam(definition);
              const teamRunView = createTeamRunViewState(definition.name);
              const printTeamRunTree = () => {
                for (const line of formatTeamRunTreeLines(teamRunView)) {
                  process.stdout.write(`${C.d}${line}${C.r}\n`);
                }
              };
              const result = await team.ask(prompt, undefined, {
                workDir: sdk.config.workDir,
                onEvent: (e) => {
                  applyTeamRunEvent(teamRunView, e);
                  if (e.type === 'team.synthesis') {
                    process.stdout.write(`${C.d}  ◈ synthesis round ${e.round}: ${e.decision}${C.r}\n`);
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
              process.stdout.write(`${C.g}✓ Response${C.r}${C.d} · ${result.mode} · ${Math.round(result.durationMs / 1000)}s${C.r}\n`);
              if (result.cost.estimatedCost !== null) {
                process.stdout.write(`${C.d}  cost: $${result.cost.estimatedCost.toFixed(4)} · ${result.cost.totalInputTokens + result.cost.totalOutputTokens} tokens${C.r}\n`);
              }
              process.stdout.write(`${C.r}${result.answer.slice(0, 500)}${result.answer.length > 500 ? '...' : ''}${C.r}\n\n`);
            } catch (e: any) {
              process.stdout.write(`${C.R}✕ Team error: ${e.message}${C.r}\n\n`);
            }
            return;
          }
          process.stdout.write(`${C.d}Usage: /team [list|attach <name>|off|ask <name> <prompt>|clone <source> <new>|status]${C.r}\n\n`);
          return;
        }
        // Project issues
        case 'issues': {
          const sub = sp === -1 ? '' : t.slice(sp + 1).trim();
          const homeDir = sdk.config.homeDir;
          const meta = await readProjectMeta(WORK_DIR, homeDir);
          const storage = isIssueStorageMode(meta.issueStorage) ? meta.issueStorage : 'home';
          if (!sub || sub === 'list') {
            const issues = await listProjectIssues(WORK_DIR, homeDir, storage);
            if (issues.length === 0) {
              process.stdout.write(`${C.d}No issues yet. Use /issues create <title>${C.r}\n\n`);
              return;
            }
            process.stdout.write(`${C.b}Issues (${storage})${C.r}\n`);
            for (const issue of issues) {
              process.stdout.write(`#${issue.number} ${issue.title} ${C.d}${issue.status} · ${issue.priority}${C.r}\n`);
            }
            process.stdout.write('\n');
            return;
          }
          if (sub.startsWith('create ')) {
            const title = sub.slice(7).trim();
            if (!title) {
              process.stdout.write(`${C.R}Usage: /issues create <title>${C.r}\n\n`);
              return;
            }
            const issue = await createProjectIssue(WORK_DIR, homeDir, { title }, storage);
            process.stdout.write(`${C.g}issue created: #${issue.number} ${issue.title}${C.r}\n\n`);
            return;
          }
          if (sub.startsWith('show ')) {
            const rawId = sub.slice(5).trim().replace(/^#/, '');
            const issues = await listProjectIssues(WORK_DIR, homeDir, storage);
            const issue = issues.find(candidate =>
              candidate.id === rawId ||
              String(candidate.number) === rawId ||
              `ISS-${candidate.number}` === rawId.toUpperCase(),
            );
            if (!issue) {
              process.stdout.write(`${C.R}Issue not found: ${rawId}${C.r}\n\n`);
              return;
            }
            process.stdout.write(
              `${C.b}ISS-${issue.number} ${issue.title}${C.r}\n` +
              `${C.d}${issue.status} · ${issue.priority}${C.r}\n` +
              `${issue.description || '(no description)'}\n` +
              `${issue.acceptanceCriteria.length ? `\nAcceptance criteria:\n${issue.acceptanceCriteria.map(item => `- ${item}`).join('\n')}` : ''}` +
              `${issue.brief ? `\n\nManager brief:\n${issue.brief}` : ''}\n\n`,
            );
            return;
          }
          if (sub.startsWith('start ')) {
            const [, rawId, agentProfile] = sub.split(/\s+/, 3);
            const id = rawId?.replace(/^#/, '');
            const issues = await listProjectIssues(WORK_DIR, homeDir, storage);
            const issue = issues.find(candidate =>
              candidate.id === id ||
              String(candidate.number) === id ||
              `ISS-${candidate.number}` === id?.toUpperCase(),
            );
            if (!issue) {
              process.stdout.write(`${C.R}Issue not found: ${rawId ?? ''}${C.r}\n\n`);
              return;
            }
            process.stdout.write(`${C.d}Decomposing and dispatching ISS-${issue.number}...${C.r}\n`);
            const dispatched = await executeProjectIssue({
              sdk,
              managerSession: await resolveManagerSession(),
              workDir: WORK_DIR,
              homeDir,
              storageMode: storage,
              issue,
              agentProfile,
              defaultModel: session.model,
              permissionMode: session.permissionContext.mode ?? DEFAULT_PERMISSION_MODE,
              systemPrompt: SYSTEM_PROMPT,
              onEvent: event => {
                if (event.type === 'response.text.delta') process.stdout.write(event.delta);
                else if (event.type === 'tool.call') toolLine(event.call.name, event.call.input as Record<string, unknown>);
                else if (event.type === 'tool.result') resultLine(event.result.isError, event.result.durationMs, event.result.output);
              },
            });
            session = dispatched.session;
            process.stdout.write(`\n${C.g}ISS-${dispatched.issue.number}: ${dispatched.issue.status} · session ${session.id}${C.r}\n\n`);
            return;
          }
          const transitions: Record<string, string> = {
            review: 'in_review',
            done: 'done',
            block: 'blocked',
          };
          const [verb, rawId] = sub.split(/\s+/, 2);
          const nextStatus = transitions[verb ?? ''];
          if (nextStatus && isIssueStatus(nextStatus) && rawId) {
            const issue = await transitionProjectIssue(WORK_DIR, homeDir, rawId.replace(/^#/, ''), nextStatus, 'user', storage);
            if (!issue) process.stdout.write(`${C.R}Issue not found: ${rawId}${C.r}\n\n`);
            else process.stdout.write(`${C.g}issue #${issue.number}: ${issue.status}${C.r}\n\n`);
            return;
          }
          process.stdout.write(`${C.d}Usage: /issues [list|show <id>|create <title>|start <id> [agent-profile]|review <id>|done <id>|block <id>]${C.r}\n\n`);
          return;
        }
        // ── Project Manager ────────────────────────────────────────
        case 'assistant': {
          const sub = sp === -1 ? '' : t.slice(sp + 1).trim();
          try {
            await runGlobalAssistantCommand(sub);
          } catch (error: any) {
            process.stdout.write(`${C.R}Assistant error: ${error.message}${C.r}\n\n`);
          }
          return;
        }
        case 'plan': {
          const requested = sp === -1 ? '' : t.slice(sp + 1).trim();
          if (requested === 'approve' || requested === 'off') {
            if (requested === 'approve' && !readPlanFile(WORK_DIR)) {
              process.stdout.write(`${C.R}There is no saved plan to approve.${C.r}\n\n`);
              return;
            }
            await session.setPermissionContext({
              mode: DEFAULT_PERMISSION_MODE,
              permissions: [],
              approver,
            });
            process.stdout.write(
              `${C.g}${requested === 'approve' ? 'Plan approved — implementation permissions restored.' : 'Plan mode disabled without approval.'}${C.r}\n\n`,
            );
            return;
          }
          if (requested === 'view') {
            const plan = readPlanFile(WORK_DIR);
            process.stdout.write(plan
              ? `${C.b}Plan · awaiting approval${C.r}\n\n${plan}\n\n`
              : `${C.d}No saved plan yet.${C.r}\n\n`);
            return;
          }
          if (requested === 'revise' || requested.startsWith('revise ')) {
            await applyPlanPermission!();
            const feedback = requested.slice('revise'.length).trim();
            if (!feedback) {
              process.stdout.write(`${C.d}Plan remains read-only. Use /plan revise <feedback>.${C.r}\n\n`);
              return;
            }
            return processMsg(
              `Revise the saved plan using this feedback. Stay in Plan mode and call ExitPlanMode again when ready:\n\n${feedback}`,
            );
          }
          await applyPlanPermission!();
          const plan = readPlanFile(WORK_DIR);
          process.stdout.write(plan
            ? `${C.b}Plan · awaiting approval${C.r}\n\n${plan}\n\n${C.d}Use /plan approve or /plan revise <feedback>.${C.r}\n\n`
            : `${C.d}Plan mode enabled. Mutating tools are blocked; ask the agent to research and call ExitPlanMode.${C.r}\n\n`);
          return;
        }
        case 'goal': {
          const requested = sp === -1 ? '' : t.slice(sp + 1).trim();
          const service = GoalService.forSession(session);
          if (!requested) {
            const goal = await service.read();
            process.stdout.write(goal
              ? `${C.b}Goal${C.r} ${C.y}${goal.status}${C.r} · revision ${goal.revision}\n${goal.objective}\n${C.d}${goal.evidence.length} evidence entries${C.r}\n\n`
              : `${C.d}No goal set. Use /goal <objective>.${C.r}\n\n`);
            return;
          }
          if (requested === 'clear') {
            await service.clear();
            process.stdout.write(`${C.g}Goal cleared.${C.r}\n\n`);
            return;
          }
          if (requested === 'pause' || requested === 'resume') {
            const result = await service.transition(requested === 'pause' ? 'paused' : 'active');
            process.stdout.write(result.ok
              ? `${C.g}Goal ${requested === 'pause' ? 'paused' : 'resumed'}.${C.r}\n\n`
              : `${C.R}${result.message}${C.r}\n\n`);
            return;
          }
          if (requested === 'complete' || requested === 'done') {
            process.stdout.write(
              `${C.R}Goal completion requires runtime evidence. Ask the agent to call UpdateGoal, or use /goal clear.${C.r}\n\n`,
            );
            return;
          }
          await service.create({ objective: requested });
          process.stdout.write(`${C.g}Goal set:${C.r} ${requested}\n\n`);
          return;
        }
        case 'checkpoint': {
          const requested = sp === -1 ? 'list' : t.slice(sp + 1).trim();
          const [action = 'list', checkpointId, modeValue, ...flags] = requested.split(/\s+/u).filter(Boolean);
          if (action === 'list') {
            const checkpoints = await sdk.checkpoints.list(session.id);
            if (checkpoints.length === 0) {
              process.stdout.write(`${C.d}No checkpoints for this Session.${C.r}\n\n`);
            } else {
              for (const item of checkpoints) {
                process.stdout.write(
                  `${C.d}${item.id} · ${item.status} · ${item.entries.length} file(s) · ${item.createdAt}${C.r}\n`,
                );
              }
              process.stdout.write('\n');
            }
            return;
          }
          if (!checkpointId) {
            process.stdout.write(`${C.R}Usage: /checkpoint show <id> | restore <id> [files|conversation|both] --confirm${C.r}\n\n`);
            return;
          }
          if (action === 'show') {
            const preview = await sdk.checkpoints.preview(session.id, checkpointId);
            process.stdout.write(`${C.b}Checkpoint ${checkpointId}${C.r}\n`);
            for (const file of preview.files) {
              process.stdout.write(`  ${file.action.padEnd(13)} ${file.path}${file.binary ? ' · binary' : ''}\n`);
            }
            for (const conflict of preview.conflicts) {
              process.stdout.write(`${C.R}  conflict ${conflict.path}: ${conflict.message}${C.r}\n`);
            }
            process.stdout.write('\n');
            return;
          }
          if (action === 'restore') {
            const mode = ['files', 'conversation', 'both'].includes(modeValue ?? '')
              ? modeValue as import('../checkpoint/types.js').CheckpointRestoreMode
              : 'both';
            const confirmed = flags.includes('--confirm') || modeValue === '--confirm';
            if (!confirmed) {
              process.stdout.write(
                `${C.R}Preview first, then run /checkpoint restore ${checkpointId} ${mode} --confirm${C.r}\n\n`,
              );
              return;
            }
            const preview = await sdk.checkpoints.preview(session.id, checkpointId);
            const result = await sdk.checkpoints.restore({
              sessionId: session.id,
              checkpointId,
              mode,
            });
            if (result.conflicts.length > 0) {
              for (const conflict of result.conflicts) {
                process.stdout.write(`${C.R}${conflict.path}: ${conflict.message}${C.r}\n`);
              }
              process.stdout.write('\n');
              return;
            }
            if (result.conversationRestored && preview.checkpoint.conversationCheckpointId) {
              await session.restoreCheckpoint(preview.checkpoint.conversationCheckpointId);
            }
            process.stdout.write(
              `${C.g}Checkpoint restored · ${result.restoredFiles.length} file(s)${result.conversationRestored ? ' · conversation' : ''}.${C.r}\n\n`,
            );
            return;
          }
          process.stdout.write(`${C.R}Usage: /checkpoint list|show|restore${C.r}\n\n`);
          return;
        }
        case 'diff': {
          const args = sp === -1 ? 'show' : t.slice(sp + 1).trim() || 'show';
          try {
            const diff = await sdk.getSessionDiff(session.id);
            if (args === 'show') {
              process.stdout.write(`${C.b}Session Diff${C.r}\n`);
              for (const file of diff.files) {
                process.stdout.write(`${file.status} ${file.path} ${C.g}+${file.additions}${C.r} ${C.R}-${file.deletions}${C.r}\n`);
              }
              process.stdout.write(diff.files.length ? '\n' : `${C.d}(no changes)${C.r}\n\n`);
              return;
            }
            if (args === 'apply --confirm') {
              const result = await sdk.applySessionDiff(session.id);
              process.stdout.write(`${result.applied ? C.g : C.R}${result.message}${C.r}\n\n`);
              return;
            }
            process.stdout.write(`${C.d}Usage: /diff show | apply --confirm${C.r}\n\n`);
          } catch (error) {
            process.stdout.write(`${C.R}${error instanceof Error ? error.message : String(error)}${C.r}\n\n`);
          }
          return;
        }
        case 'plugin': {
          try {
            const { PluginPackageManager } = await import('../plugins/pluginManager.js');
            const manager = new PluginPackageManager(
              path.join(sdk.config.homeDir, 'plugin-packages'),
              process.env.ACTOVIQ_PLUGIN_REGISTRY,
              sdk.config.effectivePolicy,
            );
            const result = await manager.execute(sp === -1 ? 'list' : t.slice(sp + 1).trim());
            process.stdout.write(`${C.g}${result.message}${C.r}\n`);
            for (const item of result.items ?? []) {
              process.stdout.write(`${C.d}${item.label}${item.description ? ` · ${item.description}` : ''}${C.r}\n`);
            }
            process.stdout.write('\n');
          } catch (error) {
            process.stdout.write(`${C.R}${error instanceof Error ? error.message : String(error)}${C.r}\n\n`);
          }
          return;
        }
        case 'session': {
          const args = sp === -1 ? '' : t.slice(sp + 1).trim();
          const [action, ...rest] = args.split(/\s+/);
          if (!action) {
            process.stdout.write(`${C.d}Usage: /session tree | fork <message-id> [label] | clone [label] | label <name> | rename <title> | pin [on|off] | archive | restore <id> | delete <id>${C.r}\n\n`);
            return;
          }
          if (action === 'tree') {
            const roots = await sdk.sessionGraph.roots();
            const lines: string[] = [];
            const visit = (node: (typeof roots)[number], depth: number) => {
              const current = node.session.id === session.id ? '*' : '-';
              lines.push(`${'  '.repeat(depth)}${current} ${node.session.branchName || node.session.title} (${node.session.id})`);
              node.children.forEach(child => visit(child, depth + 1));
            };
            roots.forEach(root => visit(root, 0));
            process.stdout.write(`${C.b}Session Tree${C.r}\n${lines.join('\n') || '(empty)'}\n\n`);
            return;
          }
          if (action === 'fork') {
            const messageId = rest.shift();
            if (!messageId) {
              const refs = await sdk.sessionGraph.ensureMessageIds(session.id);
              process.stdout.write(`${C.d}Usage: /session fork <message-id> [label]\n${refs.map(ref => `${ref.id} · ${ref.message.role}`).join('\n')}${C.r}\n\n`);
              return;
            }
            const forked = await sdk.sessionForks.forkAtMessage(session.id, messageId, {
              branchName: rest.join(' ').trim() || undefined,
            });
            session = await sdk.resumeSession(forked.id);
            process.stdout.write(`${C.g}Session branch created: ${forked.id}${C.r}\n\n`);
            return;
          }
          if (action === 'clone') {
            const cloned = await sdk.sessionForks.clone(session.id, {
              branchName: rest.join(' ').trim() || undefined,
            });
            session = await sdk.resumeSession(cloned.id);
            process.stdout.write(`${C.g}Session cloned: ${cloned.id}${C.r}\n\n`);
            return;
          }
          if (action === 'label') {
            const label = rest.join(' ').trim();
            if (!label) {
              process.stdout.write(`${C.d}Usage: /session label <name>${C.r}\n\n`);
              return;
            }
            await sdk.sessionForks.label(session.id, label);
            session = await sdk.resumeSession(session.id);
            process.stdout.write(`${C.g}Session branch labeled: ${label}${C.r}\n\n`);
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
            process.stdout.write(`${C.R}Session not found: ${targetId || ''}${C.r}\n\n`);
            return;
          }
          if (action === 'rename') {
            const title = rest.join(' ').trim();
            if (!title) {
              process.stdout.write(`${C.d}Usage: /session rename <title>${C.r}\n\n`);
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
              session = await sdk.createSession({ model: session.model, permissionMode: DEFAULT_PERMISSION_MODE });
            }
          } else if (action === 'restore') {
            await catalog.action({ action: 'restore', locator: item.locator });
          } else if (action === 'delete') {
            await catalog.action({ action: 'delete', locator: item.locator });
          } else {
            process.stdout.write(`${C.R}Unknown /session action: ${action}${C.r}\n\n`);
            return;
          }
          process.stdout.write(`${C.g}Session ${action} complete.${C.r}\n\n`);
          return;
        }
        case 'manager': {
          const sub = sp === -1 ? '' : t.slice(sp + 1).trim();
          const homeDir = sdk.config.homeDir;
          if (sub === 'sessions') {
            const managers = (await sdk.sessions.list()).filter(item => item.kind === 'manager');
            const cfg = await readManagerConfig(WORK_DIR, homeDir);
            process.stdout.write(`${C.b}Manager Sessions${C.r}\n`);
            for (const item of managers) {
              process.stdout.write(`${item.id === cfg.activeSessionId ? C.g + '●' : C.d + '○'} ${item.id} · ${item.title} · ${item.messageCount} messages${C.r}\n`);
            }
            process.stdout.write('\n');
            return;
          }
          if (sub === 'new') {
            const cfg = await readManagerConfig(WORK_DIR, homeDir);
            managerSession = await sdk.createSession({
              title: 'Manager',
              kind: 'manager',
              metadata: { __actoviqKind: 'manager', __actoviqAssistantScope: 'project' },
              permissionMode: DEFAULT_PERMISSION_MODE,
            });
            await writeManagerConfig(WORK_DIR, homeDir, { ...cfg, activeSessionId: managerSession.id });
            process.stdout.write(`${C.g}Manager Session created: ${managerSession.id}${C.r}\n\n`);
            return;
          }
          if (sub.startsWith('resume ')) {
            const id = sub.slice('resume '.length).trim();
            const found = (await sdk.sessions.list()).find(item => item.id === id && item.kind === 'manager');
            if (!found) {
              process.stdout.write(`${C.R}Manager Session not found: ${id}${C.r}\n\n`);
              return;
            }
            const cfg = await readManagerConfig(WORK_DIR, homeDir);
            managerSession = await sdk.resumeSession(id, { permissionMode: DEFAULT_PERMISSION_MODE });
            await writeManagerConfig(WORK_DIR, homeDir, { ...cfg, activeSessionId: id });
            process.stdout.write(`${C.g}Manager Session selected: ${found.title}${C.r}\n\n`);
            return;
          }
          if (!sub || sub === 'status') {
            const cfg = await readManagerConfig(WORK_DIR, homeDir);
            const plan = await readProjectPlanFile(WORK_DIR, homeDir);
            const progress = await readProgressFile(WORK_DIR, homeDir);
            const lines = [
              `model: ${cfg.model ?? session.model + ' (session default)'}`,
              `readScope: ${cfg.readScope}`,
              `mirror to workspace: ${cfg.mirrorProgressToWorkspace ? 'on' : 'off'}`,
              `plan.json: ${plan.milestones.length} milestones · ${plan.today.length} today · ${plan.upcoming.length} upcoming`,
              `PROGRESS.md: ${progress ? `${progress.length} chars · ${managerProgressPath(WORK_DIR, homeDir)}` : '(none yet — /manager update)'}`,
            ];
            process.stdout.write(`${C.b}Manager${C.r}\n${C.d}${lines.join('\n')}${C.r}\n\n`);
            return;
          }
          if (sub === 'config') {
            const cfg = await readManagerConfig(WORK_DIR, homeDir);
            process.stdout.write(`${C.d}${JSON.stringify(cfg, null, 2)}\nSet: /manager config set <model|bridgeConfig|readScope|mirror|allow> <value>\nThe Manager always runs read-only regardless of model.${C.r}\n\n`);
            return;
          }
          if (sub.startsWith('config set ')) {
            const rest = sub.slice('config set '.length).trim();
            const spIdx = rest.indexOf(' ');
            const key = spIdx === -1 ? rest : rest.slice(0, spIdx);
            const value = spIdx === -1 ? '' : rest.slice(spIdx + 1).trim();
            const cfg = await readManagerConfig(WORK_DIR, homeDir);
            if (key === 'model') cfg.model = value || undefined;
            else if (key === 'bridgeConfig' || key === 'config') cfg.bridgeConfig = value || undefined;
            else if (key === 'readScope') {
              if (value !== 'workspace-only' && value !== 'workspace+docs' && value !== 'explicit-allowlist' && value !== 'full-access') {
                process.stdout.write(`${C.R}readScope must be workspace-only | workspace+docs | explicit-allowlist | full-access${C.r}\n\n`);
                return;
              }
              cfg.readScope = value;
            } else if (key === 'mirror') cfg.mirrorProgressToWorkspace = value === 'on' || value === 'true';
            else if (key === 'allow') cfg.allowedReadPaths = value ? value.split(',').map(p => p.trim()).filter(Boolean) : [];
            else {
              process.stdout.write(`${C.R}usage: /manager config set <model|bridgeConfig|readScope|mirror|allow> <value>${C.r}\n\n`);
              return;
            }
            await writeManagerConfig(WORK_DIR, homeDir, cfg);
            process.stdout.write(`${C.g}✓ Manager config updated: ${key}${C.r}\n\n`);
            return;
          }
          if (sub === 'schedule') {
            const tasks = (await listScheduledAutomationTasks(WORK_DIR)).filter(task => task.kind === 'manager');
            if (tasks.length === 0) {
              process.stdout.write(`${C.d}No manager schedules. Add kind:"manager" tasks to .actoviq/scheduled-tasks.json${C.r}\n\n`);
              return;
            }
            for (const task of tasks) {
              process.stdout.write(`${C.c}${task.name}${C.r}${C.d} · ${task.cron} · ${task.enabled ? 'enabled' : 'paused'}${C.r}\n`);
            }
            process.stdout.write('\n');
            return;
          }
          const isTeam = sub === 'team' || sub.startsWith('team ');
          const isUpdate = sub === 'update' || sub.startsWith('update ');
          const isChat = sub === 'chat' || sub.startsWith('chat ') || isTeam;
          if (isUpdate || isChat) {
            const arg = isUpdate
              ? (sub === 'update' ? '' : sub.slice('update'.length).trim())
              : isTeam
                ? (sub === 'team'
                  ? ''
                  : `Propose a Team Graph for this request. Inspect existing Teams first when relevant. ${sub.slice('team'.length).trim()}`)
                : sub.slice('chat'.length).trim();
            if (isChat && !arg) {
              process.stdout.write(`${C.d}${isTeam ? 'Usage: /manager team <request>' : 'Usage: /manager chat <message>'}${C.r}\n\n`);
              return;
            }
            if (isUpdate) process.stdout.write(`${C.d}Manager: updating progress documents...${C.r}\n`);
            try {
              const cfg = await readManagerConfig(WORK_DIR, homeDir);
              const turnProposals: import('../team/teamProposalService.js').TeamGraphProposal[] = [];
              managerSession = await resolveManagerSession();
              const managerTools = [
                ...await createManagerTools({ workDir: WORK_DIR, homeDir, config: cfg }),
                ...createAssistantTeamTools({
                  scope: 'project',
                  assistantSessionId: managerSession.id,
                  currentWorkDir: WORK_DIR,
                  homeDir,
                  proposals: assistantTeamProposals,
                  onProposal: proposal => { turnProposals.push(proposal); },
                }),
              ];
              let prompt: string;
              if (isUpdate) {
                // Host-collected context (the Manager itself has no shell).
                let gitSummary = '';
                try {
                  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: WORK_DIR, encoding: 'utf8' }).trim();
                  const dirty = execSync('git status --porcelain', { cwd: WORK_DIR, encoding: 'utf8' }).trim();
                  const log = execSync('git log --oneline -10', { cwd: WORK_DIR, encoding: 'utf8' }).trim();
                  gitSummary = `branch: ${branch}\ndirty files: ${dirty ? dirty.split('\n').length : 0}\nrecent commits:\n${log}`;
                } catch { /* not a git repo */ }
                const stored = await sdk.sessions.list();
                const conversationSummaries = stored
                  .filter(s => s.kind !== 'manager')
                  .slice(0, 20)
                  .map(s => `- [${s.updatedAt.slice(0, 10)}] ${s.title} (${s.messageCount} msgs): ${s.preview}`)
                  .join('\n');
                const plan = await readProjectPlanFile(WORK_DIR, homeDir);
                const progress = await readProgressFile(WORK_DIR, homeDir);
                process.stdout.write(`${C.d}${formatManagerUpdatePreview(plan, progress).split('\n').slice(0, 2).join('\n')}${C.r}\n`);
                const githubDigest = await resolveGitHubDigestForUpdate(WORK_DIR, arg || undefined);
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
                const compactResult = await managerSession.compact({});
                if (compactResult.compacted) {
                  process.stdout.write(
                    `${C.d}Manager: compacted ${compactResult.messagesRemoved ?? '?'} older messages${C.r}\n`,
                  );
                }
              } catch { /* auto-compact is best-effort */ }
              abortCtrl = new AbortController();
              const runOptions = {
                systemPrompt: `${buildManagerSystemPrompt(WORK_DIR, cfg)}\n${buildAssistantTeamSystemPrompt('project')}`,
                tools: managerTools,
                signal: abortCtrl.signal,
                approver,
                ...(cfg.model ? { model: cfg.model } : {}),
                __actoviqUseDefaultTools: false,
                __actoviqAllowedTools: managerTools.map(tool => tool.name),
              } as Parameters<typeof managerSession.stream>[1];
              const stream = managerSession.stream(prompt, runOptions);
              const managerSurfaceEvents = new LegacySurfaceEventPipeline();
              for await (const event of stream) {
                for (const surfaceEvent of managerSurfaceEvents.projectFor(event, 'cli')) {
                  const data = surfaceEvent.data;
                  if (surfaceEvent.type === 'tool.started') {
                    toolLine(
                      surfaceString(data.name) ?? surfaceString(data.publicName) ?? 'tool',
                      surfaceRecord(data.input) ?? {},
                    );
                  } else if (
                    surfaceEvent.type === 'tool.completed'
                    || surfaceEvent.type === 'tool.failed'
                    || surfaceEvent.type === 'tool.rejected'
                  ) {
                    resultLine(data.isError === true, undefined, data.output);
                  }
                }
              }
              const result = await stream.result;
              if (result.text) process.stdout.write(`${result.text}\n`);
              for (const proposal of turnProposals) {
                const diff = proposal.diff;
                process.stdout.write(
                  `\n${C.b}Team proposal · ${proposal.teamName}${C.r}\n`
                  + `${C.d}${proposal.explanation || '(no explanation)'}${C.r}\n`
                  + [
                    ['+ nodes', diff.addedNodes],
                    ['- nodes', diff.removedNodes],
                    ['~ nodes', diff.changedNodes],
                    ['+ edges', diff.addedEdges],
                    ['- edges', diff.removedEdges],
                    ['~ edges', diff.changedEdges],
                  ].filter(([, values]) => (values as string[]).length)
                    .map(([label, values]) => `${C.d}${label}: ${(values as string[]).join(', ')}${C.r}`)
                    .join('\n')
                  + (proposal.problems.length
                    ? `\n${C.R}${proposal.problems.join('\n')}${C.r}`
                    : '')
                  + '\n',
                );
                if (proposal.problems.length) {
                  assistantTeamProposals.reject(proposal.id);
                  process.stdout.write(`${C.R}Invalid proposal; no file was written.${C.r}\n`);
                  continue;
                }
                const choice = await new Promise<string>(resolve => {
                  rl.question(`${C.y}Apply this Team proposal? [y/N] ${C.r}`, answer => resolve(answer.trim().toLowerCase()));
                });
                if (choice === 'y' || choice === 'yes') {
                  try {
                    const applied = await assistantTeamProposals.apply(proposal.id, homeDir);
                    process.stdout.write(`${C.g}Team saved: ${applied.proposal.teamName} (${applied.filePath})${C.r}\n`);
                  } catch (error: any) {
                    process.stdout.write(`${C.R}Team apply failed: ${error.message}${C.r}\n`);
                  }
                } else {
                  assistantTeamProposals.reject(proposal.id);
                  process.stdout.write(`${C.d}Proposal rejected; no file was written.${C.r}\n`);
                }
              }
              if (isUpdate) {
                process.stdout.write(`${C.g}✓ Progress updated${C.r}${C.d} · ${managerProgressPath(WORK_DIR, homeDir)}${C.r}\n\n`);
              } else {
                process.stdout.write('\n');
              }
            } catch (e: any) {
              process.stdout.write(`${C.R}✕ Manager error: ${e.message}${C.r}\n\n`);
            } finally {
              abortCtrl = null;
            }
            return;
          }
          process.stdout.write(`${C.d}Usage: /manager [status|chat <message>|update [instruction]|sessions|new|resume <id>|team <request>|config|schedule]${C.r}\n\n`);
          return;
        }
        default:
          process.stdout.write(`${C.R}Unknown: /${cmd}${C.r}  ${C.d}Type /help${C.r}\n\n`);
          return;
      }
    }

    abortCtrl = new AbortController();
    const stream = session.stream(t, {
      systemPrompt: SYSTEM_PROMPT,
      signal: abortCtrl.signal,
      model: session.model,
      permissionMode: session.permissionContext.mode ?? DEFAULT_PERMISSION_MODE,
      approver,
      // Attached team is only exposed to the main agent when autoInvoke is on;
      // otherwise attach is a selection and /team ask stays the manual path.
      ...(activeTeamTool && teamPrefs.autoInvoke ? { tools: [activeTeamTool] } : {}),
    });
    let iteration = 0;
    let hasText = false;
    const activeTools = new Map<string, { name: string; start: number }>();
    const surfaceEvents = new LegacySurfaceEventPipeline();

    for await (const event of stream) {
      for (const surfaceEvent of surfaceEvents.projectFor(event, 'cli')) {
        const data = surfaceEvent.data;
        switch (surfaceEvent.type) {
        case 'request.started':
          iteration = surfaceInteger(data.iteration) ?? iteration;
          if (iteration > 1) process.stdout.write(`\n${C.d}── iteration ${iteration} ──${C.r}\n`);
          break;
        case 'text.delta': {
          const txt = surfaceString(data.delta) ?? '';
          process.stdout.write(txt);
          hasText = true;
          break;
        }
        case 'model.content': {
          const content = surfaceRecord(data.content);
          if (data.kind === 'content' && content?.type === 'thinking') {
            const th = (surfaceString(content.thinking) ?? '').slice(0, 250);
            process.stdout.write(`\n${C.d}💭 ${th}${C.r}\n`);
          }
          break;
        }
        case 'tool.started': {
          const callId = surfaceString(data.callId);
          const name = surfaceString(data.name) ?? surfaceString(data.publicName) ?? 'tool';
          if (callId) activeTools.set(callId, { name, start: Date.now() });
          toolLine(name, surfaceRecord(data.input) ?? {});
          break;
        }
        case 'tool.progress': {
          const message = surfaceString(data.message)
            ?? surfaceString(surfaceRecord(data.progress)?.message);
          if (message) process.stdout.write(`\r\x1b[K${C.d}     ${message}${C.r}`);
          break;
        }
        case 'tool.completed':
        case 'tool.failed':
        case 'tool.rejected': {
          const callId = surfaceString(data.callId);
          const info = callId ? activeTools.get(callId) : undefined;
          if (callId) activeTools.delete(callId);
          resultLine(data.isError === true, info ? Date.now() - info.start : undefined, data.output);
          break;
        }
        case 'compaction.completed':
          process.stdout.write(`\n${C.d}── context compacted ──${C.r}\n`);
          break;
        case 'error':
          process.stdout.write(`\n${C.R}  ✕ ${surfaceString(data.message) ?? 'run failed'}${C.r}\n`);
          break;
        default:
          break;
        }
      }
    }
    if (!hasText) { const r = await stream.result; if (r.text) process.stdout.write(r.text); }
    process.stdout.write(`\n`);
  }

  // ── Readline ──────────────────────────────────────────────────

  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout,
    prompt: '', completer, historySize: 1000, terminal: true,
  });
  rl.setPrompt(`${C.c}> ${C.r}`);

  let shuttingDown = false;
  let cc = 0; let ccT: ReturnType<typeof setTimeout> | null = null;

  async function shutdown(code: number, closeReadline = true): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    let exitCode = code;
    if (ccT) clearTimeout(ccT);
    if (pendingToolApproval) {
      const approval = pendingToolApproval;
      pendingToolApproval = null;
      approval.resolve({
        behavior: 'deny',
        reason: 'The interactive session is shutting down.',
      });
    }
    abortCtrl?.abort();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    if (closeReadline) rl.close();
    process.stdout.write(`\n${C.d}Goodbye.${C.r}\n`);
    try {
      await closeManagedPluginsForExit(managedPluginRuntime.close);
    } catch (error) {
      exitCode = 1;
      process.stderr.write(
        `[actoviq-react] ERROR: ${errorMessage(error)} ` +
        'Check E2B/Playwright resources manually before assuming billing has stopped.\n',
      );
    }
    try {
      await sdk.close();
      if (globalAssistantSdk) await globalAssistantSdk.close();
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`[actoviq-react] ERROR: SDK cleanup failed: ${errorMessage(error)}\n`);
    }
    process.exit(exitCode);
  }

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on('keypress', (_ch: any, key: any) => {
    if (key?.name === 'c' && key?.ctrl) {
      if (pendingToolApproval) {
        const approval = pendingToolApproval;
        pendingToolApproval = null;
        approval.resolve({
          behavior: 'deny',
          reason: 'The user interrupted the approval prompt.',
        });
      }
      cc++;
      if (cc >= 2) { void shutdown(0); return; }
      if (ccT) clearTimeout(ccT); ccT = setTimeout(() => { cc = 0; }, 500);
      if (abortCtrl) { abortCtrl.abort(); process.stdout.write(`\n${C.y}  ⏹ Aborting...${C.r}\n`); }
      process.stdout.write('\n'); rl.prompt();
      return;
    }
    cc = 0;
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const queued = line.trim();
    if (pendingToolApproval) {
      const approval = pendingToolApproval;
      pendingToolApproval = null;
      const allowed = /^(?:y|yes)$/i.test(queued);
      approval.resolve({
        behavior: allowed ? 'allow' : 'deny',
        reason: allowed
          ? 'The user approved this tool once.'
          : 'The user denied this tool.',
      });
      process.stdout.write(`${allowed ? `${C.g}Allowed` : `${C.y}Denied`}.${C.r}\n`);
      return;
    }
    if (abortCtrl) {
      if (!queued) {
        rl.prompt();
        return;
      }
      if (queued.startsWith('/')) {
        process.stdout.write(`${C.d}Slash commands are unavailable while the agent is working.${C.r}\n`);
        rl.prompt();
        return;
      }
      session.steer(queued);
      process.stdout.write(`${C.d}  ⧗ queued steering message${C.r}\n`);
      rl.prompt();
      return;
    }
    try {
      await processMsg(line);
    } catch (e: any) {
      if (e.name === 'AbortError' || e.name === 'RunAbortedError') {
        process.stdout.write(`\n${C.y}  ⏹ aborted${C.r}\n`);
      } else {
        process.stdout.write(`\n${C.R}  ✕ ${(e as Error).message}${C.r}\n`);
      }
    } finally {
      abortCtrl = null;
    }
    rl.prompt();
  });

  rl.on('close', () => void shutdown(0, false));
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
}

main().catch((e) => { process.stderr.write(`Fatal: ${(e as Error).message}\n`); process.exit(1); });
