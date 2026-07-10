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
  type ActoviqPermissionMode,
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
  transitionProjectIssue,
  WorktreeService,
} from 'actoviq-agent-sdk';
import { readProjectMeta } from '../gui/projectMeta.js';
import { applyTeamRunEvent, createTeamRunViewState, formatTeamRunTreeLines } from '../team/teamRunView.js';
import { execSync } from 'node:child_process';
import path from 'node:path';
import * as readline from 'node:readline';
import { hasVersionFlag, readPackageVersion } from './version.js';

if (hasVersionFlag(process.argv.slice(2))) {
  process.stdout.write(`${readPackageVersion(import.meta.url)}\n`);
  process.exit(0);
}

const WORK_DIR = path.resolve(process.argv[2] ?? process.cwd());
const CONFIG_PATH = process.argv[3] ?? path.join(resolveActoviqHome(), 'settings.json');
const DEFAULT_PERMISSION_MODE = 'bypassPermissions';
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

async function main() {
  // Header
  const w = process.stdout.columns || 80;
  process.stdout.write(`\n${C.c}${C.b}╭${'─'.repeat(Math.min(w - 2, 60))}╮${C.r}\n`);
  process.stdout.write(`${C.c}│${C.r}  dir     : ${C.y}${WORK_DIR.slice(0, 45)}${C.r}\n`);

  const tools = createActoviqCoreTools({ cwd: WORK_DIR });
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
  const sdk = await createAgentSdk({
    workDir: WORK_DIR,
    tools,
    permissionMode: DEFAULT_PERMISSION_MODE,
  });
  const toolMetadata = await sdk.listToolMetadata();
  let session = await sdk.createSession({
    title: path.basename(WORK_DIR),
    permissionMode: DEFAULT_PERMISSION_MODE,
  });

  process.stdout.write(`${C.c}│${C.r}  model   : ${C.y}${session.model}${C.r}\n`);
  process.stdout.write(`${C.c}│${C.r}  tools   : ${C.y}${toolMetadata.length} tools loaded${C.r}\n`);
  process.stdout.write(`${C.c}│${C.r}  keys    : Tab=complete  ↑↓=history  Ctrl+C=abort${C.r}\n`);
  process.stdout.write(`${C.c}├${'─'.repeat(Math.min(w - 2, 60))}┤${C.r}\n\n`);

  let abortCtrl: AbortController | null = null;
  let msgCount = 0;
  // Persistent Manager session (kind: 'manager') — reused across /manager
  // update/chat turns so the Manager keeps its own conversation context.
  let managerSession: Awaited<ReturnType<typeof sdk.createSession>> | null = null;

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
    const managers = (await sdk.sessions.list()).filter(item => item.kind === 'manager');
    managers.sort((a, b) => {
      if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount;
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });
    for (const dup of managers.slice(1)) {
      await sdk.sessions.delete(dup.id).catch(() => undefined);
    }
    const existing = managers[0];
    if (existing) {
      managerSession = await sdk.resumeSession(existing.id, { permissionMode: DEFAULT_PERMISSION_MODE });
      return managerSession;
    }
    managerSession = await sdk.createSession({
      title: 'Manager',
      metadata: { __actoviqKind: 'manager' },
      permissionMode: DEFAULT_PERMISSION_MODE,
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
          });
          process.stdout.write(`${C.g}Permission mode set to ${C.y}${requested}${C.r}\n\n`);
          return;
        }
        case 'sessions': {
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
          process.stdout.write(
            `${C.g}Resumed ${session.id}: ${session.title} (${session.model})${C.r}\n\n`,
          );
          return;
        }
        case 'tools':
          process.stdout.write(`${C.d}${toolMetadata.map(t => `${C.y}${t.name}${C.r}`).join(', ')}${C.r}\n\n`);
          return;
        case 'memory':
          try { const s = await session.compactState();
            process.stdout.write(`${C.d}${JSON.stringify(s as any, null, 2)}${C.r}\n\n`); }
          catch { process.stdout.write(`${C.d}N/A${C.r}\n\n`); }
          return;
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
        case 'manager': {
          const sub = sp === -1 ? '' : t.slice(sp + 1).trim();
          const homeDir = sdk.config.homeDir;
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
          const isUpdate = sub === 'update' || sub.startsWith('update ');
          const isChat = sub === 'chat' || sub.startsWith('chat ');
          if (isUpdate || isChat) {
            const arg = isUpdate
              ? (sub === 'update' ? '' : sub.slice('update'.length).trim())
              : sub.slice('chat'.length).trim();
            if (isChat && !arg) {
              process.stdout.write(`${C.d}Usage: /manager chat <message>${C.r}\n\n`);
              return;
            }
            if (isUpdate) process.stdout.write(`${C.d}Manager: updating progress documents...${C.r}\n`);
            try {
              const cfg = await readManagerConfig(WORK_DIR, homeDir);
              const managerTools = await createManagerTools({ workDir: WORK_DIR, homeDir, config: cfg });
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
              managerSession = await resolveManagerSession();
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
                systemPrompt: buildManagerSystemPrompt(WORK_DIR, cfg),
                tools: managerTools,
                signal: abortCtrl.signal,
                ...(cfg.model ? { model: cfg.model } : {}),
                __actoviqUseDefaultTools: false,
                __actoviqAllowedTools: managerTools.map(tool => tool.name),
              } as Parameters<typeof managerSession.stream>[1];
              const stream = managerSession.stream(prompt, runOptions);
              for await (const event of stream) {
                if (event.type === 'tool.call') toolLine(event.call.name, event.call.input as Record<string, unknown>);
                else if (event.type === 'tool.result') resultLine(event.result.isError, undefined, event.result.output);
              }
              const result = await stream.result;
              if (result.text) process.stdout.write(`${result.text}\n`);
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
          process.stdout.write(`${C.d}Usage: /manager [status|chat <message>|update [instruction]|config|schedule]${C.r}\n\n`);
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
      // Attached team is only exposed to the main agent when autoInvoke is on;
      // otherwise attach is a selection and /team ask stays the manual path.
      ...(activeTeamTool && teamPrefs.autoInvoke ? { tools: [activeTeamTool] } : {}),
    });
    let iteration = 0;
    let hasText = false;
    const activeTools = new Map<string, { name: string; start: number }>();

    for await (const event of stream) {
      switch (event.type) {
        case 'request.started':
          iteration = event.iteration;
          if (iteration > 1) process.stdout.write(`\n${C.d}── iteration ${iteration} ──${C.r}\n`);
          break;
        case 'response.text.delta': {
          const txt = typeof event.delta === 'string' ? event.delta : (event.delta as any)?.text ?? '';
          process.stdout.write(txt);
          hasText = true;
          break;
        }
        case 'response.content':
          if (event.content.type === 'thinking') {
            const th = ((event.content as any).thinking ?? '').slice(0, 250);
            process.stdout.write(`\n${C.d}💭 ${th}${C.r}\n`);
          }
          break;
        case 'tool.call': {
          activeTools.set(event.call.id, { name: event.call.name, start: Date.now() });
          toolLine(event.call.name, event.call.input as Record<string, unknown>);
          break;
        }
        case 'tool.progress': {
          const p = event.data as any;
          if (p?.message) process.stdout.write(`\r\x1b[K${C.d}     ${p.message}${C.r}`);
          break;
        }
        case 'tool.result': {
          const info = activeTools.get(event.result.id);
          activeTools.delete(event.result.id);
          resultLine(event.result.isError, info ? Date.now() - info.start : undefined, event.result.output);
          break;
        }
        case 'session.compacted':
          process.stdout.write(`\n${C.d}── context compacted ──${C.r}\n`);
          break;
        case 'error':
          process.stdout.write(`\n${C.R}  ✕ ${event.error.message}${C.r}\n`);
          break;
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
    if (ccT) clearTimeout(ccT);
    abortCtrl?.abort();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    if (closeReadline) rl.close();
    process.stdout.write(`\n${C.d}Goodbye.${C.r}\n`);
    try { await sdk.close(); } catch {}
    process.exit(code);
  }

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on('keypress', (_ch: any, key: any) => {
    if (key?.name === 'c' && key?.ctrl) {
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
