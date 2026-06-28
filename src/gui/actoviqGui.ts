#!/usr/bin/env node
import { execFileSync, execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  createActoviqCoreTools,
  createAgentSdk,
  createModelTeam,
  createTeamTool,
  detectBridgeProviders,
  listRouterProfiles,
  listTeamDefinitions,
  listWorkflows,
  loadDefaultActoviqSettings,
  loadJsonConfigFile,
  loadRouterProfile,
  loadTeamDefinition,
  loadWorkflow,
  resolveRoutedRun,
  WorktreeService,
} from '../index.js';
import {
  addBridgeConfig,
  findBridgeConfig,
  maskApiKey,
  readBridgeConfigs,
  removeBridgeConfig,
  type ModelModality,
  type PersistedBridgeConfig,
} from '../parity/bridgeConfigs.js';
import { buildRouteModelApi } from '../router/modelRouter.js';
import { applyOutputStyle, OUTPUT_STYLES, type OutputStyleId } from '../prompts/outputStyles.js';
import { estimateCost } from '../team/pricing.js';
import { createPlanModeTools, planFilePath, readPlanFile } from '../tools/planMode/PlanModeTools.js';
import { isReadOnlyBashCommand } from '../runtime/bashClassification.js';
import { loadProjectContext } from '../memory/projectContext.js';
import { recordTurn } from '../memory/sessionHistory.js';
import {
  addMcpServer,
  readMcpServerConfig,
  removeMcpServer,
  type PersistedMcpServer,
} from '../mcp/mcpServerConfig.js';
import {
  createPreToolUseHookClassifier,
  readPostToolUseHooks,
  readPreToolUseHooks,
  readSessionStartHooks,
  runPostToolUseHooks,
  runSessionStartHooks,
} from '../hooks/userHooks.js';
import { getLoadedJsonConfig } from '../config/loadJsonConfigFile.js';
import {
  persistActoviqSettingsStore,
  resolveActoviqSettingsStore,
} from '../config/actoviqSettingsStore.js';
import { readPackageVersion } from '../cli/version.js';
import { discoverActoviqPlugins } from '../tui/pluginCatalog.js';
import { ACTOVIQ_INTERACTIVE_COMMANDS } from '../ui/commandSurface.js';
import { renderMarkdown } from './guiMarkdown.js';
import type {
  ActoviqCanUseTool,
  ActoviqEffort,
  ActoviqPermissionMode,
  ActoviqPermissionRule,
  ActoviqRunEffort,
  ActoviqToolApprover,
  AgentEvent,
  AgentRunResult,
  AgentToolDefinition,
  RouterProfile,
  TeamDefinition,
} from '../types.js';
import type { AgentSession } from '../runtime/agentSession.js';
import type { ContentBlockParam, ToolResultBlockParam, ToolUseBlock } from '../provider/types.js';

const DEFAULT_PORT = 4174;
const EFFORT_LEVELS: readonly ActoviqEffort[] = ['low', 'medium', 'high', 'max'];
const READONLY_DENY = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'PowerShell'];
const PERMISSION_MODES = new Set<ActoviqPermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'auto',
]);

export interface ActoviqGuiOptions {
  workDir?: string;
  homeDir?: string;
  host?: string;
  port?: number;
  configPath?: string;
  permissionMode?: ActoviqPermissionMode;
  model?: string;
  resumeSessionId?: string;
  continueMostRecent?: boolean;
}

export interface ActoviqGuiServer {
  url: string;
  /** Per-process secret required on every `/api/*` request (defeats other local processes / CSRF). */
  token: string;
  close(): Promise<void>;
}

interface GuiRunEvent {
  type: string;
  [key: string]: unknown;
}

interface PendingPermission {
  id: string;
  toolName: string;
  summary: string;
  resolve: (outcome: 'allow' | 'always' | 'always-user' | 'deny') => void;
}

interface GuiPreferences {
  workMode: 'coding' | 'daily';
  theme: 'system' | 'light' | 'dark';
  density: 'comfortable' | 'compact';
  enterToSend: boolean;
  autoScroll: boolean;
}

const DEFAULT_GUI_PREFERENCES: GuiPreferences = {
  workMode: 'coding',
  theme: 'system',
  density: 'comfortable',
  enterToSend: true,
  autoScroll: true,
};

function buildGuiSystemPrompt(workDir: string, workMode: 'coding' | 'daily' = 'coding'): string {
  let isGit = false;
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: workDir, stdio: 'ignore' });
    isGit = true;
  } catch {
    // Non-git workspaces are valid.
  }
  // Load the CLAUDE.md hierarchy (user + project, with @includes) so the agent
  // picks up project-specific instructions — the canonical Claude Code behavior.
  const project = loadProjectContext(workDir);
  const projectSection = project.text
    ? `\n\n# Project context (CLAUDE.md)\n\nThe following project instructions were loaded from CLAUDE.md files. Treat them as authoritative guidance for this workspace.\n\n${project.text}\n`
    : '';
  const base = (
    `You are Hadamard Agent, an interactive GUI agent. Working directory: ${workDir}\n\n` +
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
    `- NEVER update the git config.\n` +
    `- NEVER run destructive git commands unless the user explicitly requests them.\n` +
    `- NEVER skip hooks unless the user explicitly requests it.\n` +
    `- NEVER commit changes unless the user explicitly asks you to.\n\n` +
    `# Other\n` +
    `- NEVER create documentation files (*.md) unless explicitly requested.\n` +
    `- When in doubt, use TodoWrite to track progress.` +
    (workMode === 'daily'
      ? `\n\n# Work mode: For daily work\n` +
        `- The user prefers an everyday-assistant style: reply in plain language, keep it concise, and minimize jargon, file paths, and raw code unless they ask for them.\n` +
        `- You are equally capable in this mode — only the presentation is less technical. Still use tools and do the real work; just summarize results in accessible terms.`
      : ``)
  );
  return base + projectSection;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string, type = 'text/plain'): void {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
}

function summarizeInput(input: unknown): string {
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

/**
 * Expand @<image-path> tokens into Anthropic image content blocks so the user
 * can attach screenshots/designs inline. Returns the string unchanged when no
 * image actually loads (the @tokens stay literal). Mirrors the TUI's
 * expandImageRefs — the @path route only (clipboard capture is platform-specific).
 */
function expandImageRefs(text: string, workDir: string): string | ContentBlockParam[] {
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
      data = readFileSync(resolved).toString('base64');
    } catch {
      continue; // not readable — leave the @token in the text below
    }
    const at = text.indexOf(ref, cursor);
    if (at > cursor) blocks.push({ type: 'text', text: text.slice(cursor, at) });
    const ext = path.extname(raw).slice(1).toLowerCase();
    const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    cursor = at + ref.length;
    seen.add(resolved);
    imagesAdded++;
  }
  if (cursor < text.length) blocks.push({ type: 'text', text: text.slice(cursor) });
  return imagesAdded > 0 ? blocks : text;
}

function commandUsage(command: string): string {
  switch (command) {
    case 'model': return '/model [config|router [name|off]|<model>|default]';
    case 'effort': return '/effort [auto|low|medium|high|max]';
    case 'permissions': return '/permissions [read-only|workspace|full]';
    case 'resume': return '/resume [session-id]';
    case 'dream': return '/dream [status|run]';
    case 'workflows': return '/workflows [run <name> [input]]';
    case 'worktree': return '/worktree [enter <name>|exit|list]';
    case 'team': return '/team [list|attach <name>|off|ask <name> <prompt>]';
    default: return `/${command}`;
  }
}

function guiIcon(name: string): string {
  const icons: Record<string, string> = {
    agent: '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M9 13h.01"/><path d="M15 13h.01"/><path d="M10 17h4"/>',
    automation: '<path d="M4 12a8 8 0 0 1 13.66-5.66"/><path d="M18 4v5h-5"/><path d="M20 12a8 8 0 0 1-13.66 5.66"/><path d="M6 20v-5h5"/>',
    browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 8h.01"/><path d="M12 8h.01"/><path d="M3 10h18"/>',
    chat: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/><path d="m14 4-4 16"/>',
    command: '<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0 0-6Z"/>',
    computer: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/>',
    environment: '<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    gear: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.8 1.8 0 0 0 15 19.4a1.8 1.8 0 0 0-1 .6 1.8 1.8 0 0 0-.42 1.12V21a2 2 0 1 1-4 0v-.09A1.8 1.8 0 0 0 8.6 19.4a1.8 1.8 0 0 0-1.98.36l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.8 1.8 0 0 0 4.6 15a1.8 1.8 0 0 0-.6-1 1.8 1.8 0 0 0-1.12-.42H3a2 2 0 1 1 0-4h.09A1.8 1.8 0 0 0 4.6 8.6a1.8 1.8 0 0 0-.36-1.98l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.8 1.8 0 0 0 9 4.6a1.8 1.8 0 0 0 1-.6 1.8 1.8 0 0 0 .42-1.12V3a2 2 0 1 1 4 0v.09A1.8 1.8 0 0 0 15.4 4.6a1.8 1.8 0 0 0 1.98-.36l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.8 1.8 0 0 0 19.4 9c.36.23.72.6 1 .6h.09a2 2 0 1 1 0 4h-.09a1.8 1.8 0 0 0-1 .6Z"/>',
    git: '<path d="M16 3 21 8l-5 5"/><path d="M8 3 3 8l5 5"/><path d="M12 21v-9"/><path d="M8 12h8"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 0 20"/><path d="M12 2a15.3 15.3 0 0 0 0 20"/>',
    hooks: '<path d="M9 18a5 5 0 0 1 0-10h1"/><path d="M15 6a5 5 0 0 1 0 10h-1"/><path d="M8 13h8"/>',
    keyboard: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h.01"/><path d="M11 9h.01"/><path d="M15 9h.01"/><path d="M7 13h10"/><path d="M8 17h8"/>',
    logo: '<circle cx="12" cy="12" r="2.4"/><circle cx="5" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="19" r="1.5"/><path d="M7.1 12h2.5"/><path d="M14.4 12h2.5"/><path d="M12 7.1v2.5"/><path d="M12 14.4v2.5"/><path d="m18.3 4.2.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6Z"/>',
    memory: '<path d="M8 3v3"/><path d="M16 3v3"/><rect x="5" y="6" width="14" height="14" rx="2"/><path d="M9 10h6"/><path d="M9 14h4"/>',
    mic: '<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v4"/>',
    model: '<path d="M12 2 4 6v12l8 4 8-4V6Z"/><path d="m4 6 8 4 8-4"/><path d="M12 10v12"/>',
    more: '<path d="M12 12h.01"/><path d="M19 12h.01"/><path d="M5 12h.01"/>',
    palette: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2a10 10 0 0 0 0 20h1.5a2.5 2.5 0 0 0 0-5H12a2 2 0 0 1 0-4h3a7 7 0 0 0 0-11Z"/>',
    plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M6 8h12v4a6 6 0 0 1-12 0Z"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    profile: '<circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 0 0-16 0"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    terminal: '<path d="m4 17 6-5-6-5"/><path d="M12 19h8"/>',
    tools: '<path d="M14.7 6.3a4 4 0 0 0-5 5L3 18l3 3 6.7-6.7a4 4 0 0 0 5-5l-2.4 2.4-3-3Z"/>',
    worktree: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><path d="M8.6 8.6 11 15"/><path d="m15.4 8.6-2.4 6.4"/>',
  };
  const body = icons[name] ?? icons.gear;
  return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

function isEffort(value: unknown): value is ActoviqEffort {
  return typeof value === 'string' && EFFORT_LEVELS.includes(value as ActoviqEffort);
}

function readEnvFromSettings(raw: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (/^[A-Z0-9_]+$/.test(key) && typeof value === 'string') env[key] = value;
  }
  if (isPlainRecord(raw.env)) {
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value === 'string') env[key] = value;
    }
  }
  return env;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readGuiPreferences(raw: Record<string, unknown>): GuiPreferences {
  const source = isPlainRecord(raw.gui) ? raw.gui : {};
  const workMode = source.workMode === 'daily' ? 'daily' : 'coding';
  const theme = source.theme === 'light' || source.theme === 'dark' ? source.theme : 'system';
  const density = source.density === 'compact' ? 'compact' : 'comfortable';
  return {
    workMode,
    theme,
    density,
    enterToSend: typeof source.enterToSend === 'boolean'
      ? source.enterToSend
      : DEFAULT_GUI_PREFERENCES.enterToSend,
    autoScroll: typeof source.autoScroll === 'boolean'
      ? source.autoScroll
      : DEFAULT_GUI_PREFERENCES.autoScroll,
  };
}

function normalizeFsPath(value: string): string {
  const resolved = path.resolve(value).normalize('NFC');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

interface StoredSessionFile {
  id: string;
  storageId: string;
  filePath: string;
  messageCount: number;
  workDir?: string;
}

async function listProjectSessionRoots(homeDir: string): Promise<string[]> {
  const projectsRoot = path.join(homeDir, '.actoviq', 'projects');
  let projectDirs: Array<{ name: string; isDirectory(): boolean }>;
  try {
    projectDirs = await readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return projectDirs
    .filter((projectDir) => projectDir.isDirectory())
    .map((projectDir) => path.join(projectsRoot, projectDir.name));
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    const resolved = path.resolve(item);
    const key = normalizeFsPath(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

async function listStoredSessionFiles(projectRoot: string): Promise<StoredSessionFile[]> {
  const sessionsDir = path.join(projectRoot, 'sessions');
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const sessions: StoredSessionFile[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(sessionsDir, file);
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
      const metadata = isPlainRecord(raw) && isPlainRecord(raw.metadata) ? raw.metadata : {};
      const messages = isPlainRecord(raw) && Array.isArray(raw.messages) ? raw.messages : [];
      const storageId = file.slice(0, -'.json'.length);
      sessions.push({
        id: isPlainRecord(raw) && typeof raw.id === 'string' ? raw.id : storageId,
        storageId,
        filePath,
        messageCount: messages.length,
        workDir: typeof metadata.__actoviqWorkDir === 'string' ? metadata.__actoviqWorkDir : undefined,
      });
    } catch {
      // Ignore unreadable historical sessions while building GUI state.
    }
  }
  return sessions;
}

async function cleanupStoredEmptySessions(projectRoots: string[], activeSessionId: string): Promise<number> {
  let deleted = 0;
  for (const projectRoot of projectRoots) {
    for (const item of await listStoredSessionFiles(projectRoot)) {
      if (item.id === activeSessionId || item.storageId === activeSessionId || item.messageCount > 0) continue;
      await rm(item.filePath, { force: true });
      await rm(path.join(projectRoot, 'sessions', '.checkpoints', item.storageId), {
        recursive: true,
        force: true,
      });
      deleted += 1;
    }
  }
  return deleted;
}

async function collectSessionStoreRoots(homeDir: string, currentSessionDirectory: string): Promise<string[]> {
  return uniquePaths([
    currentSessionDirectory,
    ...await listProjectSessionRoots(homeDir),
  ]);
}

async function listKnownProjects(homeDir: string, currentWorkDir: string) {
  const current = path.resolve(currentWorkDir);
  const projects = new Map<string, {
    name: string;
    path: string;
    sessionCount: number;
    active: boolean;
  }>();
  const addProject = (projectPath: string, sessionCount = 0) => {
    const resolved = path.resolve(projectPath);
    const key = normalizeFsPath(resolved);
    const existing = projects.get(key);
    projects.set(key, {
      name: path.basename(resolved) || resolved,
      path: resolved,
      sessionCount: (existing?.sessionCount ?? 0) + sessionCount,
      active: normalizeFsPath(resolved) === normalizeFsPath(current),
    });
  };
  addProject(current, 0);

  for (const projectRoot of await listProjectSessionRoots(homeDir)) {
    const countsByWorkDir = new Map<string, { path: string; count: number }>();
    for (const item of await listStoredSessionFiles(projectRoot)) {
      if (item.messageCount === 0 || !item.workDir || !(await pathExists(item.workDir))) continue;
      const key = normalizeFsPath(item.workDir);
      const existing = countsByWorkDir.get(key);
      countsByWorkDir.set(key, { path: item.workDir, count: (existing?.count ?? 0) + 1 });
    }
    for (const project of countsByWorkDir.values()) {
      addProject(project.path, project.count);
    }
  }

  return [...projects.values()].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function openPathInSystem(targetPath: string): void {
  const command = process.platform === 'win32'
    ? 'explorer.exe'
    : process.platform === 'darwin'
      ? 'open'
      : 'xdg-open';
  const child = spawn(command, [targetPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

function sessionView(session: AgentSession) {
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    messages: session.messages.length,
    permissionContext: session.permissionContext,
  };
}

/**
 * Flatten a stored conversation into the same event shapes the live stream emits,
 * so the client can replay history through its normal render path when a chat is
 * opened or resumed.
 */
function renderableHistory(session: AgentSession): GuiRunEvent[] {
  const events: GuiRunEvent[] = [];
  const results = new Map<string, { ok: boolean; text: string }>();
  const stringifyResult = (content: ToolResultBlockParam['content']): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
            return (block as { text: string }).text;
          }
          try {
            return JSON.stringify(block);
          } catch {
            return '';
          }
        })
        .join('\n');
    }
    return '';
  };

  for (const message of session.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result') {
        const result = block as ToolResultBlockParam;
        results.set(result.tool_use_id, { ok: !result.is_error, text: stringifyResult(result.content) });
      }
    }
  }

  for (const message of session.messages) {
    const content = message.content;
    if (typeof content === 'string') {
      if (content.trim()) events.push({ type: message.role === 'assistant' ? 'assistant' : 'user', text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const type = (block as { type?: unknown }).type;
      if (type === 'text' && typeof (block as { text?: unknown }).text === 'string' && (block as { text: string }).text.trim()) {
        events.push({ type: message.role === 'assistant' ? 'assistant' : 'user', text: (block as { text: string }).text });
      } else if (type === 'tool_use') {
        const call = block as ToolUseBlock;
        const result = results.get(call.id);
        events.push({
          type: 'tool',
          name: call.name,
          input: call.input,
          ok: result ? result.ok : true,
          text: result ? result.text : '',
        });
      }
    }
  }

  return events;
}

function buildDefaultTeam(mode: string, model: string): TeamDefinition | undefined {
  // `role` gives each member a stable identity so panel members that share a
  // model stay distinguishable in reports/events/status.
  const member = (role: string, systemPrompt: string) => ({ model, role, name: role, systemPrompt });
  switch (mode) {
    case 'panel-analysis':
      return {
        name: 'panel-analysis',
        mode: 'panel-analysis',
        members: [
          member('researcher', 'Expert researcher. Investigate with read-only tools; cite sources.'),
          member('skeptic', 'Rigorous skeptic. Verify with sources; challenge assumptions.'),
        ],
        primary: member('synthesizer', 'Synthesizer. Reconcile the panel findings into the best answer and decide when they suffice.'),
        timeoutMs: 300000,
        maxIterations: 12,
      };
    case 'analysis':
      return {
        name: 'analysis-panel',
        mode: 'analysis',
        members: [
          member('researcher', 'Expert researcher. Deep, source-grounded analysis.'),
          member('skeptic', 'Rigorous skeptic. Verify with sources; challenge assumptions.'),
        ],
        timeoutMs: 300000,
        maxIterations: 12,
      };
    case 'reviewer':
      return {
        name: 'reviewer',
        mode: 'reviewer',
        members: [],
        reviewer: member('reviewer', 'Meticulous reviewer. Surface only genuine, verifiable issues with file:line evidence; never speculate.'),
        timeoutMs: 300000,
        maxIterations: 16,
      };
    default:
      return undefined;
  }
}

async function listenWithFallback(
  server: ReturnType<typeof createServer>,
  host: string,
  startPort: number,
  attempts = 20,
): Promise<number> {
  for (let candidate = startPort; candidate < startPort + attempts; candidate += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, host);
      });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`No free port found in range ${startPort}-${startPort + attempts - 1}`);
}

export async function startActoviqGuiServer(options: ActoviqGuiOptions = {}): Promise<ActoviqGuiServer> {
  let workDir = path.resolve(options.workDir ?? process.cwd());
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? DEFAULT_PORT;
  const permissionMode: ActoviqPermissionMode = options.permissionMode ?? 'bypassPermissions';
  const authToken = randomBytes(32).toString('hex');
  let guiWorkMode: 'coding' | 'daily' = 'coding';
  let systemPrompt = buildGuiSystemPrompt(workDir, guiWorkMode);

  try {
    if (options.configPath) await loadJsonConfigFile(options.configPath);
    else await loadDefaultActoviqSettings({ homeDir: options.homeDir });
  } catch {
    // Missing local config is fine; env vars may carry credentials.
  }

  try {
    const initialStore = await resolveActoviqSettingsStore({ configPath: options.configPath, homeDir: options.homeDir });
    guiWorkMode = readGuiPreferences(initialStore.raw).workMode;
    systemPrompt = buildGuiSystemPrompt(workDir, guiWorkMode);
  } catch {
    // Keep defaults when settings cannot be read.
  }

  // Plan mode tools (EnterPlanMode / ExitPlanMode) give the agent a structured
  // research-then-propose flow. onPlanModeChange flips the session into plan
  // permission mode so mutating tools are blocked while the agent researches;
  // the holder is assigned after the session + approver exist.
  let applyPlanPermission: (() => Promise<void>) | null = null;
  const buildTools = () => [
    ...createActoviqCoreTools({ cwd: workDir }),
    ...createPlanModeTools(workDir, {
      onPlanModeChange: async (mode) => { if (mode === 'plan') await applyPlanPermission?.(); },
    }),
  ];
  let tools = buildTools();
  const createCleanSdk = () =>
    createAgentSdk({
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      workDir,
      tools,
      permissionMode,
      ...(options.model ? { model: options.model } : {}),
    });
  let sdk = await createCleanSdk();
  let toolMetadata = await sdk.listToolMetadata();
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

  // Fire SessionStart hooks (best-effort, fire-and-forget) on the initial session.
  runSessionStartHooks(() => readSessionStartHooks(getLoadedJsonConfig()?.raw), workDir);

  let activeTeamTool: AgentToolDefinition | null = null;
  let activeTeamName: string | null = null;
  let activeRouter: RouterProfile | null = null;
  let routedModelLabel: string | null = null;
  let runAbort: AbortController | null = null;
  let eventSink: ((event: GuiRunEvent) => void) | null = null;
  const pendingPermissions = new Map<string, PendingPermission>();

  // Bridge mode — in-process: a named config pre-builds a ModelApi via
  // buildRouteModelApi and is injected per-run into session.stream({model, modelApi}).
  // Same session → context survives switching bridge↔hadamard. No child process.
  let bridgeMode = false;
  let activeBridgeConfig: PersistedBridgeConfig | null = null;
  let activeBridgeModelApi: Awaited<ReturnType<typeof buildRouteModelApi>> | null = null;
  let bridgeModelLabel: string | null = null;
  // /output-style prompt prefix swap (applied per turn; 'default' is a no-op).
  let outputStyle: OutputStyleId = 'default';
  // Usage totals for /cost, /usage, /stats. Per-config breakdown attributes spend
  // to each bridge config so the user can compare backends (mirrors the TUI).
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd: number | null = 0;
  const configUsage = new Map<string, { inputTokens: number; outputTokens: number; turns: number }>();

  function recordUsage(model: string, usage: { input_tokens?: number; output_tokens?: number } | undefined): void {
    const inT = usage?.input_tokens ?? 0;
    const outT = usage?.output_tokens ?? 0;
    totalInputTokens += inT;
    totalOutputTokens += outT;
    const cost = estimateCost(model, inT, outT, options.homeDir);
    totalCostUsd = cost === null ? null : (totalCostUsd === null ? cost : totalCostUsd + cost);
    if (bridgeMode && activeBridgeConfig) {
      const rec = configUsage.get(activeBridgeConfig.name) ?? { inputTokens: 0, outputTokens: 0, turns: 0 };
      rec.inputTokens += inT;
      rec.outputTokens += outT;
      rec.turns += 1;
      configUsage.set(activeBridgeConfig.name, rec);
    }
  }
  function configCost(name: string, rec: { inputTokens: number; outputTokens: number }): string | null {
    const cfg = findBridgeConfig(name, options.homeDir);
    if (!cfg?.model) return null;
    const cost = estimateCost(cfg.model, rec.inputTokens, rec.outputTokens, options.homeDir);
    return cost !== null ? `$${cost.toFixed(4)}` : null;
  }

  // The project/plugin/empty-session scans walk every project on disk. Cache them
  // briefly (and invalidate on mutations) so `/api/state` is cheap on every turn.
  type HeavyState = {
    key: string;
    at: number;
    projects: Awaited<ReturnType<typeof listKnownProjects>>;
    plugins: Awaited<ReturnType<typeof discoverActoviqPlugins>>;
  };
  let heavyStateCache: HeavyState | null = null;
  const invalidateHeavyState = (): void => {
    heavyStateCache = null;
  };

  async function reloadSdk(): Promise<void> {
    const previousSdk = sdk;
    const nextSdk = await createCleanSdk();
    try {
      session = await nextSdk.resumeSession(session.id, {
        model: options.model,
        permissionMode: options.permissionMode,
      });
      toolMetadata = await nextSdk.listToolMetadata();
      sdk = nextSdk;
    } catch (error) {
      await nextSdk.close().catch(() => undefined);
      throw error;
    }
    await previousSdk.close().catch(() => undefined);
  }

  async function switchProject(nextWorkDir: string): Promise<Record<string, unknown>> {
    if (runAbort) {
      throw new Error('Cannot switch projects while a run is active.');
    }
    const resolved = path.resolve(nextWorkDir);
    if (!(await pathExists(resolved))) {
      throw new Error(`Workspace does not exist: ${resolved}`);
    }
    const previousSdk = sdk;
    workDir = resolved;
    systemPrompt = buildGuiSystemPrompt(workDir, guiWorkMode);
    tools = buildTools();
    activeTeamTool = null;
    activeTeamName = null;
    activeRouter = null;
    routedModelLabel = null;
    const nextSdk = await createCleanSdk();
    try {
      const sessions = await nextSdk.sessions.list();
      const resumable = sessions.find(item => item.messageCount > 0 && item.status !== 'closed')
        ?? sessions.find(item => item.messageCount > 0)
        ?? sessions.find(item => item.status !== 'closed');
      session = resumable
        ? await nextSdk.resumeSession(resumable.id, { model: options.model, permissionMode: options.permissionMode })
        : await nextSdk.createSession({ title: path.basename(workDir), model: options.model, permissionMode });
      toolMetadata = await nextSdk.listToolMetadata();
      sdk = nextSdk;
    } catch (error) {
      await nextSdk.close().catch(() => undefined);
      throw error;
    }
    await previousSdk.close().catch(() => undefined);
    invalidateHeavyState();
    return state();
  }

  const currentPermissionMode = (): ActoviqPermissionMode =>
    session.permissionContext.mode ?? permissionMode;
  const currentEffort = (): ActoviqRunEffort | undefined => {
    const stored = session.metadata.__actoviqEffort;
    if (stored === 'auto') return 'auto';
    return isEffort(stored) ? stored : sdk.config.effort;
  };

  const approver: ActoviqToolApprover = async (context) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const pending = await new Promise<'allow' | 'always' | 'always-user' | 'deny'>((resolve) => {
      const request: PendingPermission = {
        id,
        toolName: context.publicName,
        summary: summarizeInput(context.input),
        resolve,
      };
      pendingPermissions.set(id, request);
      eventSink?.({
        type: 'permission.request',
        id,
        toolName: request.toolName,
        summary: request.summary,
      });
    });
    pendingPermissions.delete(id);
    if (pending === 'always' || pending === 'always-user') {
      const state = session.permissionContext;
      const permissions = state.permissions.filter(
        rule => !(rule.toolName === context.publicName && rule.behavior === 'allow'),
      );
      const source: 'project' | 'user' = pending === 'always-user' ? 'user' : 'project';
      permissions.push({ toolName: context.publicName, behavior: 'allow', source });
      await session.setPermissionContext({
        mode: state.mode ?? permissionMode,
        permissions,
        approver,
      });
      return { behavior: 'allow', reason: `Approved (always — ${source} scope) in GUI.` };
    }
    return pending === 'allow'
      ? { behavior: 'allow', reason: 'Approved in GUI.' }
      : { behavior: 'deny', reason: 'Denied in GUI permission dialog.' };
  };

  // Read-only Bash auto-allow + mutating-tool prompt (mirrors the TUI's
  // canUseTool). Only active in the 'default' permission mode; returns undefined
  // (no decision) otherwise so workspace/full modes keep their behavior.
  const MUTATING_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit', 'PowerShell']);
  const canUseTool: ActoviqCanUseTool = (context) => {
    if (currentPermissionMode() !== 'default') return undefined;
    if (context.publicName === 'Bash') {
      const command = (context.input as { command?: unknown } | null)?.command;
      if (typeof command === 'string' && isReadOnlyBashCommand(command)) {
        return undefined; // auto-allow harmless read-only commands
      }
      return { behavior: 'ask', reason: 'Bash command may modify the workspace.' };
    }
    if (MUTATING_TOOLS.has(context.publicName)) {
      return { behavior: 'ask', reason: `${context.publicName} mutates the workspace.` };
    }
    return undefined;
  };

  // User-configurable PreToolUse hooks from settings.json hooks.PreToolUse[].
  // Lazily reads live settings so edits apply without a restart; a no-op when no
  // hooks match (the common case), so the run path is unchanged.
  const preToolUseHookClassifier = createPreToolUseHookClassifier(
    () => readPreToolUseHooks(getLoadedJsonConfig()?.raw),
  );

  // Wire the plan-mode tools' onPlanModeChange to flip the session into plan
  // permission mode so mutating tools are blocked while the agent researches.
  applyPlanPermission = async () => {
    await session.setPermissionContext({ mode: 'plan', permissions: [], approver });
  };

  async function state() {
    const store = await resolveActoviqSettingsStore({
      configPath: options.configPath,
      homeDir: options.homeDir,
    }).catch(() => undefined);
    const env = store ? readEnvFromSettings(store.raw) : {};
    const configuredDirs = Array.isArray(store?.raw.pluginDirs)
      ? store.raw.pluginDirs.filter((value): value is string => typeof value === 'string')
      : [];
    const homeDir = store?.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? workDir;
    const cacheKey = `${workDir}|${session.id}`;
    const now = Date.now();
    let heavy = heavyStateCache && heavyStateCache.key === cacheKey && now - heavyStateCache.at < 4000
      ? heavyStateCache
      : null;
    if (!heavy) {
      const sessionStoreRoots = await collectSessionStoreRoots(homeDir, sdk.config.sessionDirectory);
      const [plugins, projects] = await Promise.all([
        discoverActoviqPlugins({ workDir, homeDir, configuredDirs }),
        listKnownProjects(homeDir, workDir),
        // Auto-clean empty sessions (except the active one) whenever the heavy
        // state is recomputed — so abandoned empty chats never accumulate and
        // no manual "Clean empty chats" action is needed.
        cleanupStoredEmptySessions(sessionStoreRoots, session.id),
      ]);
      heavy = { key: cacheKey, at: now, plugins, projects };
      heavyStateCache = heavy;
    }
    const [allSessions, workflows, teams, routers, skills, agents] = await Promise.all([
      sdk.sessions.list(),
      Promise.resolve(listWorkflows(workDir)),
      Promise.resolve(listTeamDefinitions(workDir)),
      Promise.resolve(listRouterProfiles(workDir)),
      Promise.resolve(sdk.skills.listMetadata()),
      Promise.resolve(sdk.agents.list()),
    ]);
    const sessions = allSessions.filter(item => item.messageCount > 0 || item.id === session.id);
    return {
      workDir,
      session: sessionView(session),
      permissionMode: currentPermissionMode(),
      effort: currentEffort() ?? 'auto',
      activeTeamName,
      activeRouterName: activeRouter?.name ?? null,
      routedModelLabel,
      commands: ACTOVIQ_INTERACTIVE_COMMANDS,
      commandUsages: Object.fromEntries(Object.keys(ACTOVIQ_INTERACTIVE_COMMANDS).map(name => [name, commandUsage(name)])),
      tools: toolMetadata,
      projects: heavy.projects,
      sessions,
      workflows,
      teams,
      routers,
      skills,
      agents,
      plugins: heavy.plugins,
      settings: {
        configPath: store?.configPath ?? null,
        provider: env.ACTOVIQ_PROVIDER ?? sdk.config.provider,
        baseURL: env.ACTOVIQ_BASE_URL ?? '',
        defaultModel: env.ACTOVIQ_MODEL ?? '',
        minModel: env.ACTOVIQ_DEFAULT_MIN_MODEL ?? '',
        mediumModel: env.ACTOVIQ_DEFAULT_MEDIUM_MODEL ?? '',
        maxModel: env.ACTOVIQ_DEFAULT_MAX_MODEL ?? '',
        apiKeyConfigured: Boolean(env.ACTOVIQ_API_KEY || env.ACTOVIQ_AUTH_TOKEN),
        preferences: store ? readGuiPreferences(store.raw) : DEFAULT_GUI_PREFERENCES,
        bridge: store?.raw?.bridge ?? {},
      },
      bridgeState: {
        mode: bridgeMode,
        activeConfig: activeBridgeConfig
          ? {
              name: activeBridgeConfig.name,
              provider: activeBridgeConfig.provider,
              apiKeyMasked: maskApiKey(activeBridgeConfig.apiKey),
              baseURL: activeBridgeConfig.baseURL ?? '',
              model: activeBridgeConfig.model ?? '',
            }
          : null,
        activeModelLabel: bridgeModelLabel,
        configs: readBridgeConfigs(options.homeDir).configs.map(c => ({
          name: c.name,
          provider: c.provider,
          apiKeyMasked: maskApiKey(c.apiKey),
          baseURL: c.baseURL ?? '',
          model: c.model ?? '',
        })),
      },
      mcpServers: readMcpServerConfig(options.homeDir).servers,
      goal: getGoal(),
      outputStyle,
      outputStyles: OUTPUT_STYLES,
      planMode: currentPermissionMode() === 'plan',
      plan: readPlanFile(workDir),
      todos,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        costUsd: totalCostUsd,
        perConfig: Array.from(configUsage.entries()).map(([cfgName, rec]) => ({
          name: cfgName,
          ...rec,
          costUsd: configCost(cfgName, rec),
        })),
      },
      running: Boolean(runAbort),
    };
  }

  async function saveSettings(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const store = await resolveActoviqSettingsStore({
      configPath: options.configPath,
      homeDir: options.homeDir,
    });
    const raw = structuredClone(store.raw);
    const env = readEnvFromSettings(raw);
    raw.env = env;

    if (body.provider === 'anthropic' || body.provider === 'openai') {
      env.ACTOVIQ_PROVIDER = body.provider;
    }
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      env.ACTOVIQ_API_KEY = body.apiKey.trim();
      delete env.ACTOVIQ_AUTH_TOKEN;
    } else if (body.clearApiKey === true) {
      delete env.ACTOVIQ_API_KEY;
      delete env.ACTOVIQ_AUTH_TOKEN;
    }
    const envFields = [
      ['baseURL', 'ACTOVIQ_BASE_URL'],
      ['defaultModel', 'ACTOVIQ_MODEL'],
      ['minModel', 'ACTOVIQ_DEFAULT_MIN_MODEL'],
      ['mediumModel', 'ACTOVIQ_DEFAULT_MEDIUM_MODEL'],
      ['maxModel', 'ACTOVIQ_DEFAULT_MAX_MODEL'],
    ] as const;
    for (const [field, key] of envFields) {
      if (typeof body[field] !== 'string') continue;
      const value = body[field].trim();
      if (value) env[key] = value;
      else delete env[key];
    }

    // Bridge settings: write per-provider paths + default provider.
    if (isPlainRecord(body.bridge)) {
      raw.bridge = { ...(isPlainRecord(raw.bridge) ? raw.bridge : {}), ...body.bridge };
    }

    const preferences = isPlainRecord(body.preferences)
      ? readGuiPreferences({ gui: body.preferences })
      : readGuiPreferences(raw);
    raw.gui = preferences;
    guiWorkMode = preferences.workMode;
    systemPrompt = buildGuiSystemPrompt(workDir, guiWorkMode);
    await persistActoviqSettingsStore(store.configPath, raw);
    await loadJsonConfigFile(store.configPath);

    const permissionPreset = typeof body.permissionPreset === 'string' && body.permissionPreset
      ? body.permissionPreset.toLowerCase().replace(/[ _]/g, '-')
      : '';
    const effort = typeof body.effort === 'string'
      ? body.effort.toLowerCase()
      : '';

    let applyError: string | undefined;
    try {
      await reloadSdk();
    } catch (error) {
      applyError = (error as Error).message;
    }
    if (permissionPreset) {
      await setPermissionPreset(permissionPreset);
    }
    if (effort === 'auto' || isEffort(effort)) {
      await session.mergeMetadata({ __actoviqEffort: effort });
    }
    invalidateHeavyState();
    return {
      ...await state(),
      settingsApplyError: applyError,
    };
  }

  async function setPermissionPreset(key: string): Promise<GuiRunEvent[]> {
    const presets: Record<string, { mode: ActoviqPermissionMode; rules: ActoviqPermissionRule[]; label: string }> = {
      'read-only': {
        mode: 'default',
        rules: READONLY_DENY.map(toolName => ({ toolName, behavior: 'deny', source: 'permissions-preset' })),
        label: 'Read-only',
      },
      workspace: { mode: 'acceptEdits', rules: [], label: 'Workspace access' },
      full: { mode: 'bypassPermissions', rules: [], label: 'Full access' },
    };
    const preset = presets[key];
    if (!preset) return [{ type: 'error', message: `unknown permission preset: ${key}` }];
    await session.setPermissionContext({ mode: preset.mode, permissions: preset.rules, approver });
    return [{ type: 'notice', message: `permissions: ${preset.label} (${preset.mode})` }];
  }

  async function runWorkflow(name: string, input?: string): Promise<GuiRunEvent[]> {
    const workflow = loadWorkflow(name, workDir);
    if (!workflow) return [{ type: 'error', message: `workflow not found: ${name}` }];
    const events: GuiRunEvent[] = [{ type: 'notice', message: `running workflow: ${name}` }];
    const { WorkflowScriptRuntime } = await import('../workflow/workflowScriptRuntime.js');
    const runtime = new WorkflowScriptRuntime({
      sdk: sdk as any,
      args: input,
      onEvent: (event: any) => {
        if (event.type === 'workflow.phase.start') events.push({ type: 'notice', message: `phase: ${event.title}` });
        if (event.type === 'workflow.agent.start') events.push({ type: 'notice', message: `agent: ${event.label ?? event.agentId}` });
        if (event.type === 'workflow.log') events.push({ type: 'notice', message: String(event.message) });
      },
    });
    const output = await runtime.execute(workflow.script);
    if (typeof output.result === 'string' && output.result.trim()) {
      events.push({ type: 'command.result', title: 'workflow result', text: output.result });
    }
    if (output.state.errors.length > 0) {
      events.push({ type: 'error', message: `${output.state.errors.length} errors during workflow execution` });
    }
    return events;
  }

  // Live todo list captured from TodoWrite tool calls; surfaced in state() so the
  // frontend can render a persistent panel (mirrors the TUI's buildTodoPanel).
  let todos: { subject: string; status: string; activeForm?: string }[] = [];

  // ── Bridge: in-process named configs ─────────────────────────────────
  // activateBridgeConfig pre-builds a ModelApi via buildRouteModelApi and stores
  // it; streamRun injects {model, modelApi} per-run on the SAME session, so
  // context survives switching bridge↔hadamard. No child process anywhere.
  async function activateBridgeConfig(config: PersistedBridgeConfig): Promise<boolean> {
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
    return true;
  }
  function disableBridge(): void {
    bridgeMode = false;
    activeBridgeConfig = null;
    activeBridgeModelApi = null;
    bridgeModelLabel = null;
    // session context stays intact — switching back to the default provider.
  }

  // ── Goal: session-scoped objective stored in session metadata ─────────
  const GOAL_METADATA_KEY = '__actoviqGoal';
  type GoalStatus = 'active' | 'paused' | 'complete';
  interface SessionGoal { objective: string; status: GoalStatus; setAt: string }
  function getGoal(): SessionGoal | null {
    const raw = session.metadata[GOAL_METADATA_KEY];
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) as SessionGoal; } catch { /* ignore */ }
    }
    if (typeof raw === 'object' && raw !== null) return raw as SessionGoal;
    return null;
  }
  async function setGoal(objective: string): Promise<SessionGoal> {
    const goal: SessionGoal = { objective, status: 'active', setAt: new Date().toISOString() };
    await session.mergeMetadata({ [GOAL_METADATA_KEY]: goal });
    return goal;
  }
  async function clearGoal(): Promise<void> {
    // mergeMetadata can't delete a key; setting undefined clears it functionally
    // (getGoal treats falsy as null) and JSON.stringify drops it on save.
    await session.mergeMetadata({ [GOAL_METADATA_KEY]: undefined });
  }
  async function setGoalStatus(status: GoalStatus): Promise<SessionGoal | null> {
    const goal = getGoal();
    if (!goal) return null;
    goal.status = status;
    await session.mergeMetadata({ [GOAL_METADATA_KEY]: goal });
    return goal;
  }

  // ── Batch: read a file and return its prompts for sequential execution ─
  async function runBatch(fileArg: string): Promise<GuiRunEvent[]> {
    const filePath = path.resolve(workDir, fileArg);
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      return [{ type: 'error', message: `batch: cannot read ${filePath}` }];
    }
    const prompts = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
    if (prompts.length === 0) return [{ type: 'error', message: 'batch: file has no prompts' }];
    return [
      { type: 'notice', message: `batch: ${prompts.length} prompts from ${path.basename(filePath)}` },
      { type: 'batch.queue', prompts },
    ];
  }

  async function runSlashCommand(raw: string): Promise<GuiRunEvent[]> {
    const spaceIndex = raw.indexOf(' ');
    const name = (spaceIndex === -1 ? raw.slice(1) : raw.slice(1, spaceIndex)).toLowerCase();
    const args = spaceIndex === -1 ? '' : raw.slice(spaceIndex + 1).trim();

    switch (name) {
      case 'help':
        return [{
          type: 'command.result',
          title: 'Commands',
          items: Object.entries(ACTOVIQ_INTERACTIVE_COMMANDS).map(([command, description]) => ({
            label: `/${command}`,
            description,
            detail: commandUsage(command),
          })),
        }];
      case 'clear':
        return [{ type: 'clear' }];
      case 'exit':
      case 'quit':
        return [{ type: 'notice', message: 'Close the browser tab or stop the actoviq-gui process to quit.' }];
      case 'model': {
        if (!args) return [{ type: 'command.result', title: 'Model', text: `current: ${session.model}` }];
        if (args === 'config') return [{ type: 'settings.open' }];
        if (args === 'router' || args.startsWith('router ')) {
          const routerArg = args.slice('router'.length).trim();
          if (routerArg === 'off' || routerArg === 'none') {
            activeRouter = null;
            routedModelLabel = null;
            return [{ type: 'notice', message: 'router off; using the fixed model' }];
          }
          if (!routerArg) {
            return [{
              type: 'command.result',
              title: 'Router profiles',
              items: listRouterProfiles(workDir).map(profile => ({
                label: profile.name,
                description: `${profile.profile.routes.length} routes`,
                detail: profile.source,
              })),
            }];
          }
          const loaded = loadRouterProfile(routerArg, workDir);
          if (!loaded) return [{ type: 'error', message: `router profile not found: ${routerArg}` }];
          activeRouter = loaded.profile;
          routedModelLabel = null;
          return [{ type: 'notice', message: `router active: ${loaded.profile.name}` }];
        }
        await session.setModel(args === 'default' ? sdk.config.model : args);
        return [{ type: 'notice', message: `model set to: ${session.model}` }];
      }
      case 'effort': {
        if (!args) return [{ type: 'command.result', title: 'Effort', text: `current: ${currentEffort() ?? 'auto'}` }];
        const value = args.toLowerCase();
        if (value !== 'auto' && !isEffort(value)) return [{ type: 'error', message: 'usage: /effort [auto|low|medium|high|max]' }];
        await session.mergeMetadata({ __actoviqEffort: value });
        return [{ type: 'notice', message: `effort set to: ${value}` }];
      }
      case 'permissions':
        return args
          ? setPermissionPreset(args.toLowerCase().replace(/[ _]/g, '-'))
          : [{ type: 'command.result', title: 'Permissions', text: `current: ${currentPermissionMode()}` }];
      case 'sessions': {
        const sessions = await sdk.sessions.list();
        return [{
          type: 'command.result',
          title: 'Sessions',
          items: sessions.map(item => ({
            label: item.id === session.id ? `${item.id} (current)` : item.id,
            description: `${item.title} · ${item.model} · ${item.status}`,
          })),
        }];
      }
      case 'resume': {
        if (!args) return runSlashCommand('/sessions');
        session = await sdk.resumeSession(args, { model: options.model, permissionMode: options.permissionMode });
        return [{ type: 'notice', message: `resumed session: ${session.id}` }, { type: 'state' }];
      }
      case 'tools':
        return [{
          type: 'command.result',
          title: 'Tools',
          items: toolMetadata.map(tool => ({
            label: tool.name,
            description: `${tool.category} · ${tool.provider}${tool.readOnly ? ' · read-only' : ''}`,
            detail: tool.description,
          })),
        }];
      case 'memory':
        return [{ type: 'command.result', title: 'Memory', text: JSON.stringify(await session.compactState(), null, 2) }];
      case 'compact': {
        const result = await session.compact({ force: true, summaryInstructions: args || undefined });
        return result.compacted
          ? [{ type: 'notice', message: `compacted: ${result.messagesRemoved ?? '?'} messages summarized` }]
          : [{ type: 'error', message: result.error ?? `compact skipped: ${result.reason}` }];
      }
      case 'dream': {
        if (!args || args === 'status') {
          return [{ type: 'command.result', title: 'Dream', text: JSON.stringify(await session.dreamState(), null, 2) }];
        }
        if (args !== 'run') return [{ type: 'error', message: 'usage: /dream [run|status]' }];
        const result = await session.dream({ force: true });
        return [{ type: 'notice', message: result.reason ?? (result.skipped ? 'dream skipped' : result.success ? 'dream completed' : 'dream failed') }];
      }
      case 'skills':
        return [{
          type: 'command.result',
          title: 'Skills',
          items: sdk.skills.listMetadata().map(skill => ({
            label: skill.displayName ? `${skill.displayName} (${skill.name})` : skill.name,
            description: `${skill.source} · ${skill.context}${skill.version ? ` · v${skill.version}` : ''}`,
            detail: `${skill.description} ${skill.whenToUse ?? ''}`,
          })),
        }];
      case 'agents':
        return [{
          type: 'command.result',
          title: 'Subagents',
          items: sdk.agents.list().map(agent => ({
            label: agent.name,
            description: agent.model ?? 'inherits model',
            detail: agent.description,
          })),
        }];
      case 'mcp': {
        const mcpTools = toolMetadata.filter(tool => tool.provider === 'mcp');
        return [{
          type: 'command.result',
          title: 'MCP',
          items: mcpTools.map(tool => ({
            label: tool.name,
            description: tool.server ?? 'mcp',
            detail: tool.description,
          })),
          text: mcpTools.length === 0 ? 'no MCP servers are active' : undefined,
        }];
      }
      case 'plugins': {
        const snapshot = await state();
        return [{
          type: 'command.result',
          title: 'Plugins',
          items: (snapshot.plugins as any[]).map(plugin => ({
            label: plugin.name,
            description: [plugin.version, plugin.capabilities?.join(', ')].filter(Boolean).join(' · '),
            detail: plugin.path,
          })),
        }];
      }
      case 'workflows': {
        if (args.startsWith('run ')) {
          const rest = args.slice(4).trim();
          const split = rest.indexOf(' ');
          return runWorkflow(split === -1 ? rest : rest.slice(0, split), split === -1 ? undefined : rest.slice(split + 1).trim());
        }
        return [{
          type: 'command.result',
          title: 'Workflows',
          items: listWorkflows(workDir).map(workflow => ({
            label: workflow.name,
            description: workflow.description,
            detail: workflow.source,
          })),
        }];
      }
      case 'worktree': {
        const service = new WorktreeService(workDir);
        if (args === 'list' || !args) {
          await service.init();
          const trees = await service.listWorktrees();
          return [{
            type: 'command.result',
            title: 'Worktrees',
            items: trees.map(tree => ({
              label: tree.path,
              description: tree.isDirty ? 'dirty' : 'clean',
            })),
            text: trees.length === 0 ? 'no worktrees' : undefined,
          }];
        }
        if (args === 'exit') {
          service.exitWorktree();
          return [{ type: 'notice', message: `exited worktree, cwd: ${service.currentWorkDir}` }];
        }
        if (args.startsWith('enter ')) {
          const nameToEnter = args.slice(6).trim();
          await service.init();
          await service.createAndEnterWorktree({ name: nameToEnter });
          return [{ type: 'notice', message: `entered worktree: ${nameToEnter} (${service.currentWorkDir})` }];
        }
        return [{ type: 'error', message: 'usage: /worktree [enter <name>|exit|list]' }];
      }
      case 'team': {
        if (!args || args === 'list') {
          const saved = listTeamDefinitions(workDir);
          return [{
            type: 'command.result',
            title: 'Teams',
            items: [
              ...saved.map(team => ({
                label: team.name,
                description: `${team.definition.mode} · ${team.definition.members?.length ?? 0} members`,
                detail: team.source,
              })),
              ...['panel-analysis', 'analysis', 'reviewer'].map(mode => ({
                label: mode,
                description: 'built-in',
              })),
            ],
          }];
        }
        if (args === 'off') {
          activeTeamTool = null;
          activeTeamName = null;
          return [{ type: 'notice', message: 'team: none' }];
        }
        if (args.startsWith('attach ')) {
          const teamName = args.slice(7).trim();
          const definition = loadTeamDefinition(teamName, workDir)?.definition ?? buildDefaultTeam(teamName, session.model);
          if (!definition) return [{ type: 'error', message: `team not found: ${teamName}` }];
          activeTeamTool = createTeamTool(definition);
          activeTeamName = definition.name;
          return [{ type: 'notice', message: `team active: ${definition.name}` }];
        }
        if (args.startsWith('ask ')) {
          const rest = args.slice(4).trim();
          const split = rest.indexOf(' ');
          if (split === -1) return [{ type: 'error', message: 'usage: /team ask <name> <prompt>' }];
          const teamName = rest.slice(0, split);
          const prompt = rest.slice(split + 1).trim();
          const definition = loadTeamDefinition(teamName, workDir)?.definition ?? buildDefaultTeam(teamName, session.model);
          if (!definition) return [{ type: 'error', message: `team not found: ${teamName}` }];
          const result = await createModelTeam(definition).ask(prompt);
          return [{ type: 'command.result', title: `Team response · ${result.mode}`, text: result.answer }];
        }
        return [{ type: 'error', message: 'usage: /team [list|attach <name>|off|ask <name> <prompt>]' }];
      }
      case 'init': {
        const prompt = 'Explore this repository (read package.json, README, and CLAUDE.md if present; list the top-level structure), then write or improve a root CLAUDE.md documenting: what the project is, key commands (build/test/run), the high-level architecture, and important conventions. Keep it concise and accurate.';
        return [{ type: 'agent.prompt', text: prompt }];
      }
      case 'context': {
        const project = loadProjectContext(workDir);
        const mcp = toolMetadata.filter(t => t.provider === 'mcp').length;
        const lines = [
          `Model: ${session.model}`,
          `Effort: ${currentEffort() ?? 'auto'}`,
          `Permission: ${currentPermissionMode()}`,
          `Messages: ${session.messages.length}`,
          `System prompt: ${systemPrompt.length} chars`,
          `Tools: ${toolMetadata.length} (${mcp} MCP)`,
          `Output style: ${outputStyle}`,
          `Bridge: ${bridgeMode ? (activeBridgeConfig?.name ?? 'on') : 'off'}`,
          `CLAUDE.md sources: ${project.sources.length ? project.sources.join(', ') : '(none)'}`,
        ];
        return [{ type: 'command.result', title: 'Context', text: lines.join('\n') }];
      }
      case 'cost':
      case 'usage': {
        const lines = [
          `Input tokens: ${totalInputTokens.toLocaleString()}`,
          `Output tokens: ${totalOutputTokens.toLocaleString()}`,
          `Cost: ${totalCostUsd === null ? 'unknown' : '$' + totalCostUsd.toFixed(4)}`,
          `Model: ${session.model}`,
        ];
        if (configUsage.size > 0) {
          lines.push('', 'By config:');
          for (const [cfgName, rec] of configUsage) {
            const star = activeBridgeConfig?.name === cfgName ? ' *' : '';
            const cost = configCost(cfgName, rec);
            lines.push(`  ${cfgName}${star} — ${rec.turns} turns, ${(rec.inputTokens + rec.outputTokens).toLocaleString()} tokens${cost ? ', ' + cost : ''}`);
          }
        }
        return [{ type: 'command.result', title: 'Usage', text: lines.join('\n') }];
      }
      case 'doctor': {
        const env = readEnvFromSettings(getLoadedJsonConfig()?.raw ?? {});
        const project = loadProjectContext(workDir);
        let isGit = false;
        try { execSync('git rev-parse --is-inside-work-tree', { cwd: workDir, stdio: 'ignore' }); isGit = true; } catch { /* not a git repo */ }
        const key = env.ACTOVIQ_API_KEY ? maskApiKey(env.ACTOVIQ_API_KEY) : env.ACTOVIQ_AUTH_TOKEN ? '(auth token)' : '(none)';
        const lines = [
          `Model: ${session.model}`,
          `Provider: ${env.ACTOVIQ_PROVIDER ?? sdk.config.provider}`,
          `API key: ${key}`,
          `Base URL: ${env.ACTOVIQ_BASE_URL ?? sdk.config.baseURL ?? '(default)'}`,
          `Workdir: ${workDir}`,
          `Git repo: ${isGit ? 'Yes' : 'No'}`,
          `Session: ${session.id} (${session.messages.length} messages)`,
          `Permission: ${currentPermissionMode()}`,
          `Tools: ${toolMetadata.length}`,
          `CLAUDE.md: ${project.sources.length ? project.sources.join(', ') : '(none)'}`,
          `Bridge: ${bridgeMode ? `${activeBridgeConfig?.name ?? 'on'} → ${bridgeModelLabel ?? '?'}` : 'off'}`,
        ];
        return [{ type: 'command.result', title: 'Doctor', text: lines.join('\n') }];
      }
      case 'batch':
        if (!args) return [{ type: 'error', message: 'usage: /batch <file>' }];
        return runBatch(args);
      case 'goal': {
        const goal = getGoal();
        const mark = (s: GoalStatus) => (s === 'active' ? '▶' : s === 'paused' ? '‖' : '✓');
        if (!args) {
          return goal
            ? [{ type: 'command.result', title: 'Goal', text: `${mark(goal.status)} ${goal.objective}\nstatus: ${goal.status} · set: ${goal.setAt}` }]
            : [{ type: 'notice', message: 'no goal set — /goal <objective>' }];
        }
        if (args === 'clear') { await clearGoal(); return [{ type: 'notice', message: 'goal cleared' }, { type: 'state' }]; }
        if (args === 'pause') { const g = await setGoalStatus('paused'); return g ? [{ type: 'notice', message: 'goal paused' }, { type: 'state' }] : [{ type: 'error', message: 'no goal to pause' }]; }
        if (args === 'resume') { const g = await setGoalStatus('active'); return g ? [{ type: 'notice', message: 'goal resumed' }, { type: 'state' }] : [{ type: 'error', message: 'no goal to resume' }]; }
        if (args === 'complete' || args === 'done') { const g = await setGoalStatus('complete'); return g ? [{ type: 'notice', message: 'goal complete' }, { type: 'state' }] : [{ type: 'error', message: 'no goal to complete' }]; }
        await setGoal(args);
        return [{ type: 'notice', message: `goal set: ${args.slice(0, 60)}` }, { type: 'state' }];
      }
      case 'review': {
        const diff = gitText(['--no-pager', 'diff']);
        if (!diff) return [{ type: 'error', message: 'no git diff to review (stage/commit changes first)' }];
        const capped = diff.length > 80000 ? diff.slice(0, 80000) + '\n…[diff truncated]' : diff;
        const prompt = `Review the following git diff for correctness, security, and style issues. For each finding cite file:line and explain the problem and the fix. Be concise.\n\n\`\`\`diff\n${capped}\n\`\`\``;
        return [{ type: 'agent.prompt', text: prompt }];
      }
      case 'stats': {
        const mcp = toolMetadata.filter(t => t.provider === 'mcp').length;
        const lines = [
          `Messages: ${session.messages.length}`,
          `Input tokens: ${totalInputTokens.toLocaleString()}`,
          `Output tokens: ${totalOutputTokens.toLocaleString()}`,
          `Tools: ${toolMetadata.length} (${mcp} MCP)`,
          `Model: ${session.model}${bridgeMode ? ' (bridge:' + (activeBridgeConfig?.name ?? '?') + ')' : ''}`,
          `Output style: ${outputStyle}`,
          `Plan mode: ${currentPermissionMode() === 'plan' ? 'on' : 'off'}`,
        ];
        return [{ type: 'command.result', title: 'Stats', text: lines.join('\n') }];
      }
      case 'export': {
        const lines: string[] = [];
        for (const message of session.messages) {
          const role = message.role === 'assistant' ? 'Assistant' : 'User';
          const text = typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
              ? message.content.map((b) => {
                  const t = (b as { text?: unknown } | null)?.text;
                  return typeof t === 'string' ? t : '';
                }).join('\n')
              : '';
          if (text.trim()) { lines.push(`## ${role}`, '', text, '', '---', ''); }
        }
        const md = lines.join('\n');
        const file = args ? path.resolve(workDir, args) : path.resolve(workDir, `session-${Date.now()}.md`);
        try { await writeFile(file, md, 'utf8'); return [{ type: 'notice', message: `exported to ${file}` }]; }
        catch (e) { return [{ type: 'error', message: `export failed: ${(e as Error).message}` }]; }
      }
      case 'rewind': {
        const n = parseInt(args || '1', 10);
        if (!Number.isFinite(n) || n < 1) return [{ type: 'error', message: 'usage: /rewind <N>' }];
        const kept = session.messages.slice(0, Math.max(0, session.messages.length - n));
        const newSession = await sdk.createSession({ title: session.title, model: options.model, permissionMode });
        if (kept.length > 0) await newSession.appendMessages(kept).catch(() => undefined);
        session = newSession;
        return [{ type: 'notice', message: `rewound ${n} message(s)` }, { type: 'state' }];
      }
      case 'output-style': {
        const valid = OUTPUT_STYLES.map(s => s.id);
        if (!args) return [{ type: 'command.result', title: 'Output style', text: `current: ${outputStyle}\navailable: ${valid.join(', ')}` }];
        if (!valid.includes(args as OutputStyleId)) return [{ type: 'error', message: `usage: /output-style [${valid.join('|')}]` }];
        outputStyle = args as OutputStyleId;
        return [{ type: 'notice', message: `output style: ${outputStyle}` }, { type: 'state' }];
      }
      case 'hooks': {
        const raw = getLoadedJsonConfig()?.raw;
        const pre = readPreToolUseHooks(raw);
        const post = readPostToolUseHooks(raw);
        const start = readSessionStartHooks(raw);
        const lines: string[] = [];
        const fmt = (h: { matcher?: string; command?: string }) => `  ${h.matcher ? h.matcher + ': ' : ''}${h.command}`;
        lines.push(`PreToolUse (${pre.length}):`); pre.forEach(h => lines.push(fmt(h)));
        lines.push(`PostToolUse (${post.length}):`); post.forEach(h => lines.push(fmt(h)));
        lines.push(`SessionStart (${start.length}):`); start.forEach(h => lines.push(`  ${h.command}`));
        if (pre.length + post.length + start.length === 0) {
          lines.push('', 'No hooks configured. Add to settings.json:', '{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "command": "echo $ACTOVIQ_HOOK_TOOL" }] } }');
        }
        return [{ type: 'command.result', title: 'Hooks', text: lines.join('\n') }];
      }
      case 'plan': {
        if (args === 'off') {
          const mode = permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'default';
          await session.setPermissionContext({ mode, permissions: [], approver });
          return [{ type: 'notice', message: 'plan mode off' }, { type: 'state' }];
        }
        if (args === 'open') {
          openPathInSystem(planFilePath(workDir));
          return [{ type: 'notice', message: 'opened plan file' }];
        }
        if (currentPermissionMode() !== 'plan') {
          await session.setPermissionContext({ mode: 'plan', permissions: [], approver });
        }
        const plan = readPlanFile(workDir);
        return plan
          ? [{ type: 'command.result', title: 'Plan', text: plan }, { type: 'state' }]
          : [{ type: 'notice', message: 'plan mode on — research, then ExitPlanMode. No plan yet.' }, { type: 'state' }];
      }
      case 'bridge': {
        if (args === 'off') { disableBridge(); return [{ type: 'notice', message: 'bridge off — using default provider' }, { type: 'state' }]; }
        if (args === 'help') {
          return [{ type: 'command.result', title: 'Bridge help', text: [
            '/bridge — open the bridge board (Settings → Bridge)',
            '/bridge switch <name> — activate a named config',
            '/bridge model [id] — set the active config model',
            '/bridge config — manage named configs',
            '/bridge off — return to the default provider',
            '/bridge run <prompt> — run one prompt through the active config',
            'Configs live in ~/.actoviq/bridge-configs.json',
          ].join('\n') }];
        }
        if (args === 'config' || args === '') return [{ type: 'settings.open', tab: 'bridge' }];
        if (args.startsWith('switch ')) {
          const cfgName = args.slice(7).trim();
          const cfg = findBridgeConfig(cfgName, options.homeDir);
          if (!cfg) return [{ type: 'error', message: `bridge config not found: ${cfgName}` }];
          await activateBridgeConfig(cfg);
          return [{ type: 'notice', message: `bridge active: ${cfg.name} → ${bridgeModelLabel} (provider ${cfg.provider})` }, { type: 'state' }];
        }
        if (args.startsWith('model')) {
          const modelArg = args.slice(5).trim();
          if (!activeBridgeConfig) return [{ type: 'error', message: 'no active bridge config — /bridge switch <name> first' }];
          if (!modelArg) return [{ type: 'command.result', title: 'Bridge model', text: `current: ${bridgeModelLabel ?? activeBridgeConfig.model ?? '(default)'}` }];
          activeBridgeConfig = { ...activeBridgeConfig, model: modelArg };
          await activateBridgeConfig(activeBridgeConfig);
          return [{ type: 'notice', message: `bridge model set: ${modelArg}` }, { type: 'state' }];
        }
        if (args.startsWith('run ')) {
          if (!activeBridgeConfig) return [{ type: 'error', message: 'no active bridge config — /bridge switch <name> first' }];
          return [{ type: 'agent.prompt', text: args.slice(4).trim() }];
        }
        return [{ type: 'settings.open', tab: 'bridge' }];
      }
      default:
        return [{ type: 'error', message: `unknown command: /${name}` }];
    }
  }

  async function streamRun(input: string, res: ServerResponse): Promise<void> {
    const send = (event: GuiRunEvent) => res.write(`${JSON.stringify(event)}\n`);
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    send({ type: 'user', text: input });

    if (input.startsWith('/')) {
      try {
        for (const event of await runSlashCommand(input)) send(event);
        send({ type: 'state', state: await state() });
        send({ type: 'done' });
      } catch (error) {
        send({ type: 'error', message: (error as Error).message });
      } finally {
        res.end();
      }
      return;
    }

    if (runAbort) {
      send({ type: 'error', message: 'A run is already active.' });
      res.end();
      return;
    }

    runAbort = new AbortController();
    eventSink = send;
    let streamedTextSeen = false;
    try {
      let routed: { model: string; modelApi: import('../types.js').CreateAgentSdkOptions['modelApi'] } | undefined;
      if (activeRouter && !bridgeMode) {
        try {
          const decision = await resolveRoutedRun(activeRouter, input, runAbort.signal);
          routed = { model: decision.model, modelApi: decision.modelApi };
          routedModelLabel = `${decision.label} (${decision.model})`;
          send({ type: 'notice', message: `router -> ${routedModelLabel}` });
        } catch (error) {
          send({ type: 'notice', message: `router classification failed: ${(error as Error).message}` });
        }
      }
      // Branch the event source. Bridge mode runs IN-PROCESS through the selected
      // config's provider/apiKey/baseURL/model (no child process): inject the
      // pre-built {model, modelApi} into session.stream — the /model router's
      // proven cross-provider mechanism. Same session → context survives switching
      // bridge↔hadamard. Otherwise a normal in-process turn (optionally routed).
      const systemPromptForRun = applyOutputStyle(systemPrompt, outputStyle);
      let stream: AsyncIterable<AgentEvent> & { result: Promise<AgentRunResult> };
      if (bridgeMode && activeBridgeModelApi) {
        const bridgeName = activeBridgeConfig?.name ?? 'bridge';
        send({ type: 'notice', message: `bridge -> ${bridgeName} (${activeBridgeModelApi.model})` });
        stream = session.stream(expandImageRefs(input, workDir), {
          systemPrompt: systemPromptForRun,
          signal: runAbort.signal,
          permissionMode: currentPermissionMode(),
          effort: currentEffort(),
          approver,
          classifier: preToolUseHookClassifier,
          canUseTool,
          model: activeBridgeModelApi.model,
          modelApi: activeBridgeModelApi.modelApi,
          ...(activeTeamTool ? { tools: [...tools, activeTeamTool] } : {}),
        });
      } else {
        stream = session.stream(expandImageRefs(input, workDir), {
          systemPrompt: systemPromptForRun,
          signal: runAbort.signal,
          permissionMode: currentPermissionMode(),
          effort: currentEffort(),
          approver,
          classifier: preToolUseHookClassifier,
          canUseTool,
          ...(routed ? { model: routed.model, modelApi: routed.modelApi } : {}),
          ...(activeTeamTool ? { tools: [...tools, activeTeamTool] } : {}),
        });
      }
      // Track tool call inputs so PostToolUse hooks (fire-and-forget) get both the
      // input and the output for the matching result.
      const toolCallInputs = new Map<string, { name: string; input: unknown }>();
      for await (const event of stream) {
        forwardAgentEvent(event, send);
        if (event.type === 'tool.call') {
          toolCallInputs.set(event.call.id, { name: event.call.publicName, input: event.call.input });
          // Capture the live todo list from TodoWrite calls for the panel.
          if (event.call.publicName === 'TodoWrite') {
            const tasks = (event.call.input as { tasks?: unknown[] } | null)?.tasks;
            if (Array.isArray(tasks)) {
              todos = tasks.map((t) => {
                const task = t as { subject?: string; status?: string; activeForm?: string };
                return {
                  subject: typeof task.subject === 'string' ? task.subject : '',
                  status: typeof task.status === 'string' ? task.status : 'pending',
                  ...(typeof task.activeForm === 'string' && task.activeForm ? { activeForm: task.activeForm } : {}),
                };
              }).filter(t => t.subject);
            }
          }
        } else if (event.type === 'tool.result') {
          const prev = toolCallInputs.get(event.result.id);
          runPostToolUseHooks(
            () => readPostToolUseHooks(getLoadedJsonConfig()?.raw),
            event.result.publicName,
            prev?.input,
            event.result.outputText,
            workDir,
          );
          toolCallInputs.delete(event.result.id);
        }
        if (event.type === 'response.text.delta' && event.delta) streamedTextSeen = true;
      }
      const result = await stream.result;
      if (!streamedTextSeen && result.text) send({ type: 'delta', text: result.text });
      if (result.incompleteReason) send({ type: 'notice', message: `run incomplete: ${result.incompleteReason}` });
      recordUsage(routed?.model ?? activeBridgeModelApi?.model ?? session.model, (result as any).usage);
      // Lightweight global history — one JSONL line per user turn (mirrors Codex / Claude Code).
      try {
        recordTurn({
          sessionId: session.id,
          ts: Math.floor(Date.now() / 1000),
          text: input.slice(0, 200),
          model: routed?.model ?? activeBridgeModelApi?.model ?? session.model,
        }, options.homeDir);
      } catch { /* never fail a turn over a history write */ }
      toolMetadata = await sdk.listToolMetadata();
      invalidateHeavyState();
      send({ type: 'state', state: await state() });
      send({ type: 'done', usage: (result as any).usage });
    } catch (error) {
      const err = error as Error;
      send({ type: 'error', message: runAbort?.signal.aborted ? 'interrupted' : err.message });
    } finally {
      runAbort = null;
      eventSink = null;
      invalidateHeavyState();
      res.end();
    }
  }

  // Read-only git view (Electron-safe: execFileSync, no shell, so `%`/`@{u}` aren't mangled on Windows).
  function gitText(args: string[]): string {
    try {
      return execFileSync('git', args, { cwd: workDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  }
  function gitInfo(): Record<string, unknown> {
    if (gitText(['rev-parse', '--is-inside-work-tree']) !== 'true') return { isRepo: false };
    const statusRaw = gitText(['status', '--porcelain=v1']);
    const status = statusRaw
      ? statusRaw.split('\n').filter(Boolean).map((line) => ({ x: (line[0] ?? ' ').trim(), y: (line[1] ?? ' ').trim(), file: line.slice(3) }))
      : [];
    const branchesRaw = gitText(['branch', '--format=%(HEAD)\t%(refname:short)']);
    const branches = branchesRaw
      ? branchesRaw.split('\n').filter(Boolean).map((line) => {
          const [head, ...rest] = line.split('\t');
          return { name: rest.join('\t') || line.trim(), current: head === '*' };
        })
      : [];
    const logRaw = gitText(['log', '--pretty=format:%h\t%s\t%cr\t%an', '-n', '30']);
    const commits = logRaw
      ? logRaw.split('\n').filter(Boolean).map((line) => {
          const [hash, subject, date, author] = line.split('\t');
          return { hash: hash ?? '', subject: subject ?? '', date: date ?? '', author: author ?? '' };
        })
      : [];
    const upstream = gitText(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    let ahead = 0;
    let behind = 0;
    const counts = upstream ? gitText(['rev-list', '--left-right', '--count', '@{u}...HEAD']) : '';
    if (counts) {
      const [b, a] = counts.split(/\s+/);
      behind = Number(b) || 0;
      ahead = Number(a) || 0;
    }
    return { isRepo: true, branch: gitText(['rev-parse', '--abbrev-ref', 'HEAD']), upstream, ahead, behind, status, branches, commits };
  }

  async function deleteSession(id: string): Promise<Record<string, unknown>> {
    const store = await resolveActoviqSettingsStore({ configPath: options.configPath, homeDir: options.homeDir }).catch(() => undefined);
    const homeDir = store?.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? workDir;
    const roots = await collectSessionStoreRoots(homeDir, sdk.config.sessionDirectory);
    // Also include the SDK session dir's parent (it may hold sessions/ directly).
    roots.push(path.dirname(sdk.config.sessionDirectory));
    let deleted = false;
    for (const projectRoot of roots) {
      // Check the active sessions directory.
      for (const item of await listStoredSessionFiles(projectRoot)) {
        if (item.id !== id && item.storageId !== id) continue;
        await rm(item.filePath, { force: true });
        await rm(path.join(projectRoot, 'sessions', '.checkpoints', item.storageId), { recursive: true, force: true });
        deleted = true;
      }
      // Also check the archive directory.
      const archiveDir = path.join(projectRoot, 'archive');
      try {
        for (const file of await readdir(archiveDir)) {
          if (!file.endsWith('.json')) continue;
          const storageId = file.slice(0, -'.json'.length);
          let sessionId: string | undefined;
          try {
            const raw = JSON.parse(await readFile(path.join(archiveDir, file), 'utf8')) as unknown;
            if (typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string') {
              sessionId = (raw as { id: string }).id;
            }
          } catch { /* skip */ }
          if (sessionId !== id && storageId !== id) continue;
          await rm(path.join(archiveDir, file), { force: true });
          await rm(path.join(archiveDir, '.checkpoints', storageId), { recursive: true, force: true });
          deleted = true;
        }
      } catch { /* archive dir may not exist */ }
    }
    // If the active chat was deleted, open a fresh one so the UI stays consistent.
    if (session.id === id) {
      session = await sdk.createSession({ title: path.basename(workDir), model: options.model, permissionMode });
    }
    invalidateHeavyState();
    return { deleted, state: await state() };
  }

  // ── Archive / unarchive sessions ─────────────────────────────────────
  // Move a session from sessions/ → archive/ (peer dir that the SDK never
  // touches), so it's hidden from both TUI and GUI session lists.
  async function archiveSession(id: string): Promise<boolean> {
    const store = await resolveActoviqSettingsStore({ configPath: options.configPath, homeDir: options.homeDir }).catch(() => undefined);
    const homeDir = store?.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? workDir;
    const roots = await collectSessionStoreRoots(homeDir, sdk.config.sessionDirectory);
    roots.push(path.dirname(sdk.config.sessionDirectory)); // SDK session dir's parent
    for (const projectRoot of roots) {
      for (const item of await listStoredSessionFiles(projectRoot)) {
        if (item.id !== id && item.storageId !== id) continue;
        const archiveDir = path.join(projectRoot, 'archive');
        await mkdir(archiveDir, { recursive: true });
        await rename(item.filePath, path.join(archiveDir, item.storageId + '.json'));
        const ckptSrc = path.join(projectRoot, 'sessions', '.checkpoints', item.storageId);
        const ckptDst = path.join(archiveDir, '.checkpoints', item.storageId);
        try { await mkdir(path.dirname(ckptDst), { recursive: true }); await rename(ckptSrc, ckptDst); } catch { /* no checkpoints */ }
        // If the active chat was archived, open a fresh one.
        if (session.id === id) {
          session = await sdk.createSession({ title: path.basename(workDir), model: options.model, permissionMode });
        }
        invalidateHeavyState();
        return true;
      }
    }
    return false;
  }

  async function unarchiveSession(id: string): Promise<boolean> {
    const store = await resolveActoviqSettingsStore({ configPath: options.configPath, homeDir: options.homeDir }).catch(() => undefined);
    const homeDir = store?.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? workDir;
    const roots = await collectSessionStoreRoots(homeDir, sdk.config.sessionDirectory);
    roots.push(path.dirname(sdk.config.sessionDirectory));
    for (const projectRoot of roots) {
      const archiveDir = path.join(projectRoot, 'archive');
      try {
        const files = await readdir(archiveDir);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const storageId = file.slice(0, -'.json'.length);
          // Read the archived file to get the session id.
          let sessionId: string | undefined;
          try {
            const raw = JSON.parse(await readFile(path.join(archiveDir, file), 'utf8')) as unknown;
            if (typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string') {
              sessionId = (raw as { id: string }).id;
            }
          } catch { /* skip unreadable */ }
          if (sessionId !== id && storageId !== id) continue;
          const sessionsDir = path.join(projectRoot, 'sessions');
          await mkdir(sessionsDir, { recursive: true });
          await rename(path.join(archiveDir, file), path.join(sessionsDir, file));
          const ckptSrc = path.join(archiveDir, '.checkpoints', storageId);
          const ckptDst = path.join(sessionsDir, '.checkpoints', storageId);
          try { await mkdir(path.dirname(ckptDst), { recursive: true }); await rename(ckptSrc, ckptDst); } catch { /* no checkpoints */ }
          invalidateHeavyState();
          return true;
        }
      } catch { /* archive dir doesn't exist */ }
    }
    return false;
  }

  async function listArchivedSessions(): Promise<Array<{ id: string; storageId: string; title?: string; model?: string; messageCount: number; workDir?: string }>> {
    const results: Array<{ id: string; storageId: string; title?: string; model?: string; messageCount: number; workDir?: string }> = [];
    const addDir = async (archiveDir: string) => {
      try {
        for (const file of await readdir(archiveDir)) {
          if (!file.endsWith('.json')) continue;
          const storageId = file.slice(0, -'.json'.length);
          try {
            const raw = JSON.parse(await readFile(path.join(archiveDir, file), 'utf8')) as unknown;
            if (typeof raw !== 'object' || raw === null) continue;
            const obj = raw as { id?: unknown; title?: unknown; model?: unknown; messages?: unknown; metadata?: unknown };
            const messages = Array.isArray(obj.messages) ? obj.messages : [];
            results.push({
              id: typeof obj.id === 'string' ? obj.id : storageId,
              storageId,
              title: typeof obj.title === 'string' ? obj.title : undefined,
              model: typeof obj.model === 'string' ? obj.model : undefined,
              messageCount: messages.length,
              workDir: typeof obj.metadata === 'object' && obj.metadata !== null && typeof (obj.metadata as { __actoviqWorkDir?: unknown }).__actoviqWorkDir === 'string'
                ? (obj.metadata as { __actoviqWorkDir: string }).__actoviqWorkDir : undefined,
            });
          } catch { /* skip unreadable */ }
        }
      } catch { /* archive dir doesn't exist */ }
    };
    // Check archive/ subdirs of all known project roots + the session dir's parent.
    const store = await resolveActoviqSettingsStore({ configPath: options.configPath, homeDir: options.homeDir }).catch(() => undefined);
    const homeDir = store?.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? workDir;
    const roots = await collectSessionStoreRoots(homeDir, sdk.config.sessionDirectory);
    for (const projectRoot of roots) {
      await addDir(path.join(projectRoot, 'archive'));
    }
    // Also check the parent of the session directory (SDK may store sessions directly there).
    await addDir(path.resolve(sdk.config.sessionDirectory, '..', 'archive'));
    await addDir(path.join(path.dirname(sdk.config.sessionDirectory), 'archive'));
    // Fallback: scan any archive/ dir directly under ~/.actoviq/ (the SDK's data root).
    try {
      const dataRoot = path.join(os.homedir(), '.actoviq');
      for (const entry of await readdir(dataRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        await addDir(path.join(dataRoot, entry.name, 'archive'));
      }
    } catch { /* data dir may not exist */ }
    return results;
  }

  async function forgetProject(targetPath: string): Promise<Record<string, unknown>> {
    const resolved = path.resolve(targetPath);
    if (normalizeFsPath(resolved) === normalizeFsPath(workDir)) {
      return { ok: false, error: 'Cannot forget the active workspace — switch to another first.', state: await state() };
    }
    const store = await resolveActoviqSettingsStore({ configPath: options.configPath, homeDir: options.homeDir }).catch(() => undefined);
    const homeDir = store?.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? workDir;
    const roots = await collectSessionStoreRoots(homeDir, sdk.config.sessionDirectory);
    let deleted = 0;
    for (const projectRoot of roots) {
      for (const item of await listStoredSessionFiles(projectRoot)) {
        if (!item.workDir || normalizeFsPath(item.workDir) !== normalizeFsPath(resolved)) continue;
        await rm(item.filePath, { force: true });
        await rm(path.join(projectRoot, 'sessions', '.checkpoints', item.storageId), { recursive: true, force: true });
        deleted += 1;
      }
    }
    invalidateHeavyState();
    return { ok: true, deleted, state: await state() };
  }

  // Only loopback hosts may reach the server. The Host check defeats DNS-rebinding
  // (the browser still sends the attacker's hostname); the Origin check defeats
  // cross-site requests; the per-process token defeats other local processes.
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', host.toLowerCase()]);
  const hostHeaderAllowed = (req: IncomingMessage): boolean => {
    const header = req.headers.host;
    if (!header) return false;
    return loopbackHosts.has(header.replace(/:\d+$/, '').toLowerCase());
  };
  const originAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients and same-origin GETs omit Origin
    try {
      return loopbackHosts.has(new URL(origin).hostname.toLowerCase());
    } catch {
      return false;
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);
      if (!hostHeaderAllowed(req) || !originAllowed(req)) {
        return text(res, 403, 'Forbidden: invalid host or origin');
      }
      if (url.pathname.startsWith('/api/') && req.headers['x-actoviq-token'] !== authToken) {
        return json(res, 403, { error: 'Forbidden: missing or invalid token' });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const nonce = randomBytes(16).toString('base64');
        const html = createActoviqGuiHtml().replace(
          '<script src="/app.js" type="module"></script>',
          `<script nonce="${nonce}">window.__ACTOVIQ_TOKEN__=${JSON.stringify(authToken)};</script>\n  <script nonce="${nonce}" src="/app.js" type="module"></script>`,
        );
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': [
            "default-src 'none'",
            `script-src 'self' 'nonce-${nonce}'`,
            "style-src 'self'",
            "img-src 'self' data:",
            "connect-src 'self'",
            "font-src 'self'",
            "base-uri 'none'",
            "form-action 'self'",
          ].join('; '),
        });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/app.css') return text(res, 200, createActoviqGuiStyles(), 'text/css');
      if (req.method === 'GET' && url.pathname === '/app.js') return text(res, 200, createActoviqGuiClientScript(), 'text/javascript');
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await state());
      if (req.method === 'GET' && url.pathname === '/api/session/messages') return json(res, 200, { messages: renderableHistory(session) });
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        return json(res, 200, await saveSettings(await readJson(req)));
      }
      if (req.method === 'GET' && url.pathname === '/api/bridge/detect') {
        return json(res, 200, { providers: await detectBridgeProviders() });
      }
      if (req.method === 'POST' && url.pathname === '/api/bridge/config') {
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const provider = body.provider === 'openai' ? 'openai' : 'anthropic';
        if (!name) return json(res, 400, { error: 'Missing config name' });
        // Merge with the existing config of the same name when editing. The form
        // intentionally leaves the API-key field blank on edit (it's a secret),
        // so a blank key must PRESERVE the saved one — not replace it with empty.
        // clearApiKey:true explicitly drops the key.
        const existing = findBridgeConfig(name, options.homeDir);
        const config: PersistedBridgeConfig = { name, provider };
        if (body.clearApiKey === true) {
          // explicitly remove the saved key
        } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
          config.apiKey = body.apiKey.trim();
        } else if (existing?.apiKey) {
          config.apiKey = existing.apiKey; // preserve on edit
        }
        // baseURL/model: the form loads existing values, so an empty field means
        // the user cleared it intentionally (send as-is; empty → omitted).
        if (typeof body.baseURL === 'string' && body.baseURL.trim()) config.baseURL = body.baseURL.trim();
        if (typeof body.model === 'string' && body.model.trim()) config.model = body.model.trim();
        // Models array (provider-specific model registry).
        if (Array.isArray(body.models)) {
          config.models = (body.models as Array<{ name?: unknown; context1M?: unknown; modality?: unknown }>)
            .filter(m => typeof m.name === 'string' && m.name.trim())
            .map(m => ({
              name: (m.name as string).trim(),
              context1M: m.context1M === true || false,
              modality: (m.modality === 'multimodal' ? 'multimodal' : 'text') as ModelModality,
            }));
        }
        addBridgeConfig(config, options.homeDir);
        // If the saved config is the active one, refresh it so the next turn uses it.
        if (activeBridgeConfig?.name === config.name) activeBridgeConfig = config;
        invalidateHeavyState();
        return json(res, 200, await state());
      }
      if (req.method === 'POST' && url.pathname === '/api/bridge/config/delete') {
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return json(res, 400, { error: 'Missing config name' });
        removeBridgeConfig(name, options.homeDir);
        if (activeBridgeConfig?.name === name) disableBridge();
        invalidateHeavyState();
        return json(res, 200, await state());
      }
      if (req.method === 'POST' && url.pathname === '/api/bridge/activate') {
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const cfg = findBridgeConfig(name, options.homeDir);
        if (!cfg) return json(res, 404, { error: `bridge config not found: ${name}` });
        try {
          await activateBridgeConfig(cfg);
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
        invalidateHeavyState();
        return json(res, 200, await state());
      }
      if (req.method === 'POST' && url.pathname === '/api/bridge/off') {
        disableBridge();
        invalidateHeavyState();
        return json(res, 200, await state());
      }
      if (req.method === 'GET' && url.pathname === '/api/mcp/list') {
        return json(res, 200, readMcpServerConfig(options.homeDir));
      }
      if (req.method === 'POST' && url.pathname === '/api/mcp/add') {
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return json(res, 400, { error: 'Missing server name' });
        const server: PersistedMcpServer = { name };
        if (typeof body.command === 'string' && body.command) server.command = body.command;
        if (typeof body.url === 'string' && body.url) server.url = body.url;
        if (Array.isArray(body.args)) server.args = body.args.filter((a: unknown) => typeof a === 'string') as string[];
        addMcpServer(server, options.homeDir);
        try { await reloadSdk(); } catch (error) { return json(res, 400, { error: (error as Error).message }); }
        invalidateHeavyState();
        return json(res, 200, await state());
      }
      if (req.method === 'POST' && url.pathname === '/api/mcp/remove') {
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return json(res, 400, { error: 'Missing server name' });
        removeMcpServer(name, options.homeDir);
        try { await reloadSdk(); } catch (error) { return json(res, 400, { error: (error as Error).message }); }
        invalidateHeavyState();
        return json(res, 200, await state());
      }
      if (req.method === 'POST' && url.pathname === '/api/open-location') {
        openPathInSystem(workDir);
        return json(res, 200, { ok: true, path: workDir });
      }
      if (req.method === 'POST' && url.pathname === '/api/project/open') {
        const body = await readJson(req);
        const nextWorkDir = typeof body.path === 'string' ? body.path.trim() : '';
        if (!nextWorkDir) return json(res, 400, { error: 'Missing project path' });
        return json(res, 200, await switchProject(nextWorkDir));
      }
      if (req.method === 'GET' && url.pathname === '/api/git') {
        return json(res, 200, gitInfo());
      }
      if (req.method === 'POST' && url.pathname === '/api/session/delete') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) return json(res, 400, { error: 'Missing session id' });
        return json(res, 200, await deleteSession(id));
      }
      if (req.method === 'POST' && url.pathname === '/api/session/archive') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) return json(res, 400, { error: 'Missing session id' });
        const ok = await archiveSession(id);
        if (!ok) return json(res, 404, { error: 'Session not found' });
        return json(res, 200, await state());
      }
      if (req.method === 'POST' && url.pathname === '/api/session/unarchive') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) return json(res, 400, { error: 'Missing session id' });
        const ok = await unarchiveSession(id);
        if (!ok) return json(res, 404, { error: 'Archived session not found' });
        return json(res, 200, await state());
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions/archived') {
        return json(res, 200, { sessions: await listArchivedSessions() });
      }
      if (req.method === 'POST' && url.pathname === '/api/project/forget') {
        const body = await readJson(req);
        const target = typeof body.path === 'string' ? body.path.trim() : '';
        if (!target) return json(res, 400, { error: 'Missing project path' });
        return json(res, 200, await forgetProject(target));
      }
      if (req.method === 'POST' && url.pathname === '/api/send') {
        const body = await readJson(req);
        const input = typeof body.text === 'string' ? body.text.trim() : '';
        if (!input) return json(res, 400, { error: 'Missing text' });
        return streamRun(input, res);
      }
      if (req.method === 'POST' && url.pathname === '/api/session/new') {
        session = await sdk.createSession({ title: path.basename(workDir), model: options.model, permissionMode });
        return json(res, 200, await state());
      }
      if (req.method === 'POST' && url.pathname === '/api/session/resume') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) return json(res, 400, { error: 'Missing session id' });
        session = await sdk.resumeSession(id, { model: options.model, permissionMode: options.permissionMode });
        return json(res, 200, await state());
      }
      if (req.method === 'POST' && url.pathname === '/api/permission') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        const decision = body.decision;
        const pending = pendingPermissions.get(id);
        if (!pending) return json(res, 404, { error: 'Permission request not found' });
        if (decision !== 'allow' && decision !== 'always' && decision !== 'always-user' && decision !== 'deny') {
          return json(res, 400, { error: 'Invalid decision' });
        }
        pending.resolve(decision as 'allow' | 'always' | 'always-user' | 'deny');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/abort') {
        runAbort?.abort();
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      return json(res, 500, { error: (error as Error).message });
    }
  });

  const actualPort = await listenWithFallback(server, host, port);
  const url = `http://${host}:${actualPort}/`;
  process.stdout.write(`actoviq-gui listening on ${url}\n`);

  const close = async () => {
    runAbort?.abort();
    await sdk.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { url, token: authToken, close };
}

// First-run onboarding: guides the user through creating ~/.actoviq/settings.json
// when no credential is found (mirrors the TUI's onboardCredentials). Uses plain
// readline so it works in any terminal launching `actoviq-gui`.
async function onboardCredentials(opts: { configPath?: string; homeDir?: string }): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));
  process.stdout.write('\n  Welcome to Actoviq! Let\'s set up your first connection.\n\n');
  const provider = ((await ask('  Provider (anthropic/openai) [anthropic]: ')).trim().toLowerCase() || 'anthropic') as 'anthropic' | 'openai';
  const apiKey = (await ask('  API key: ')).trim();
  const baseURL = (await ask('  Base URL [https://api.deepseek.com]: ')).trim() || 'https://api.deepseek.com';
  const model = (await ask('  Model [deepseek-chat]: ')).trim() || 'deepseek-chat';
  rl.close();
  if (!apiKey) {
    process.stdout.write('  No API key entered. Set ACTOVIQ_API_KEY and rerun, or open Settings → Environment in the GUI.\n');
    return;
  }
  const store = await resolveActoviqSettingsStore({ configPath: opts.configPath, homeDir: opts.homeDir });
  const raw = isPlainRecord(store.raw) ? structuredClone(store.raw) : {};
  const env = isPlainRecord(raw.env) ? { ...raw.env } : {};
  env.ACTOVIQ_API_KEY = apiKey;
  env.ACTOVIQ_BASE_URL = baseURL;
  env.ACTOVIQ_MODEL = model;
  if (provider === 'openai') env.ACTOVIQ_PROVIDER = 'openai';
  raw.env = env;
  await persistActoviqSettingsStore(store.configPath, raw);
  await loadJsonConfigFile(store.configPath);
  process.stdout.write(`  Config saved to ${store.configPath}. Starting GUI…\n\n`);
}

export async function runActoviqGui(options: ActoviqGuiOptions = {}): Promise<void> {
  let handle: ActoviqGuiServer;
  try {
    handle = await startActoviqGuiServer(options);
  } catch (error) {
    if (/(No Actoviq credential|credential was found)/i.test((error as Error).message)) {
      await onboardCredentials(options);
      handle = await startActoviqGuiServer(options);
    } else {
      throw error;
    }
  }
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
  async function close(): Promise<void> {
    await handle.close();
  }
}

function forwardAgentEvent(event: AgentEvent, send: (event: GuiRunEvent) => void): void {
  switch (event.type) {
    case 'run.started':
      send({ type: 'run.started', model: event.model });
      return;
    case 'request.started':
      send({ type: 'status', message: `request ${event.iteration}${event.requestTokenEstimate ? ` · ~${event.requestTokenEstimate} tokens` : ''}` });
      return;
    case 'response.text.delta':
      if (event.delta) send({ type: 'delta', text: event.delta });
      return;
    case 'tool.call':
      send({
        type: 'tool.call',
        id: event.call.id,
        runId: event.runId,
        iteration: event.iteration,
        name: event.call.publicName,
        provider: event.call.provider,
        input: event.call.input,
        startedAt: event.call.startedAt,
      });
      return;
    case 'tool.permission':
      send({ type: 'tool.permission', toolName: event.decision.publicName, behavior: event.decision.behavior, reason: event.decision.reason });
      return;
    case 'tool.result':
      send({
        type: 'tool.result',
        id: event.result.id,
        runId: event.runId,
        iteration: event.iteration,
        name: event.result.publicName,
        ok: !event.result.isError,
        text: event.result.outputText,
        durationMs: event.result.durationMs,
        completedAt: event.result.completedAt,
      });
      return;
    case 'tool.progress':
      send({
        type: 'tool.progress',
        id: event.toolUseId,
        runId: event.runId,
        iteration: event.iteration,
        data: event.data,
      });
      return;
    case 'session.compacted':
      send({ type: 'notice', message: `session compacted: ${event.result.messagesRemoved ?? '?'} messages summarized` });
      return;
    case 'conversation.compacted':
      send({ type: 'notice', message: `conversation compacted: ${event.messagesSummarized} messages summarized` });
      return;
    case 'model.fallback':
      send({ type: 'notice', message: `model fallback: ${event.fromModel} -> ${event.toModel}` });
      return;
    case 'request.interrupted':
      send({ type: 'notice', message: 'request interrupted' });
      return;
    case 'error':
      send({ type: 'error', message: event.error.message });
      return;
    default:
      return;
  }
}

export function createActoviqGuiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Actoviq GUI</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <div class="app" id="appView">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">${guiIcon('logo')}</span>
        <span class="brand-name">Actoviq</span>
      </div>
      <nav class="primary-nav" aria-label="Primary">
        <button id="newSession" class="nav-btn"><span class="nav-icon">${guiIcon('plus')}</span><span>New chat</span></button>
        <button id="searchNav" class="nav-btn"><span class="nav-icon">${guiIcon('search')}</span><span>Search</span></button>
        <button id="pluginsNav" class="nav-btn"><span class="nav-icon">${guiIcon('plug')}</span><span>Plugins</span></button>
        <button id="automationNav" class="nav-btn"><span class="nav-icon">${guiIcon('automation')}</span><span>Automation</span></button>
      </nav>
      <label class="search"><span>Search</span><input id="commandSearch" placeholder="Search chats"></label>
      <section class="project-section">
        <div class="section-title-row">
          <h2>Projects</h2>
          <div class="section-actions">
            <button type="button" id="newWorkspaceBtn" class="mini-action-btn" title="Switch workspace"><span class="mini-icon">${guiIcon('folder')}</span><small>Workspace</small></button>
            <button type="button" id="newProjectSessionBtn" class="mini-action-btn" title="New chat in this workspace"><span class="mini-icon">${guiIcon('plus')}</span><small>Chat</small></button>
          </div>
        </div>
        <div class="project-control-row">
          <button class="project-row" id="projectRoot">
            <span class="folder-icon">${guiIcon('folder')}</span>
            <span><strong id="projectName">actoviq-agent-sdk</strong><small id="projectPath"></small></span>
            <span class="chevron">${guiIcon('chevronDown')}</span>
          </button>
          <button type="button" id="projectMenuBtn" class="icon-btn" title="Project options" aria-label="Project options">${guiIcon('more')}</button>
        </div>
        <div id="projects" class="project-list"></div>
        <div class="project-actions">
          <button type="button" id="addProjectBtn" class="sidebar-link">Add workspace</button>
        </div>
        <div id="workspaceMeta" class="workspace-meta"></div>
      </section>
      <div class="sidebar-footer">
        <button id="settingsBtn" class="nav-btn"><span class="nav-icon">${guiIcon('gear')}</span><span>Settings</span></button>
        <button id="collapseSidebar" class="icon-btn" title="Collapse sidebar" aria-label="Collapse sidebar">${guiIcon('chevronDown')}</button>
      </div>
    </aside>
    <main class="chat">
      <header class="topbar">
        <div class="title-block">
          <div class="title-row">
            <h1 id="sessionTitle">Actoviq GUI</h1>
            <button id="conversationMenu" class="icon-btn" title="Conversation actions" aria-label="Conversation actions">${guiIcon('more')}</button>
          </div>
          <p id="workspace"></p>
        </div>
        <div class="top-actions">
          <button id="openLocationBtn" class="pill-btn" title="Open workspace folder">Open location</button>
          <button id="gitBtn" class="icon-btn" title="Git tree" aria-label="Show the Git tree">${guiIcon('git')}</button>
        </div>
      </header>
      <section id="statusbar" class="statusbar"></section>
      <section id="contextBar" class="context-bar hidden"></section>
      <details id="todosPanel" class="todos-panel hidden"><summary><span id="todosSummary">Todos</span></summary><ol id="todosList"></ol></details>
      <section id="transcript" class="transcript"></section>
      <form id="composer" class="composer">
        <div id="dropOverlay" class="drop-overlay hidden">Drop files to attach</div>
        <div id="attachmentTray" class="attachment-tray hidden"></div>
        <textarea id="promptInput" rows="3" placeholder="Ask Actoviq or type /help"></textarea>
        <div id="slashMenu" class="slash-menu hidden"></div>
        <div id="queueList" class="queue-list hidden"></div>
        <div class="composer-footer">
          <div class="composer-left">
            <button type="button" id="fileUploadBtn" class="round-btn" title="Attach files" aria-label="Attach files">${guiIcon('plus')}</button>
            <input id="fileInput" type="file" multiple class="hidden-file-input">
            <select id="permissionSelect" title="Permission mode">
              <option value="full">Full access</option>
              <option value="workspace">Workspace</option>
              <option value="read-only">Read-only</option>
            </select>
            <select id="outputStyleSelect" title="Output style">
              <option value="default">Default</option>
              <option value="concise">Concise</option>
              <option value="explanatory">Explanatory</option>
              <option value="learning">Learning</option>
            </select>
            <button type="button" id="insertCommand" class="command-chip" title="Commands">/ Commands</button>
          </div>
          <div class="composer-right">
            <div class="model-picker-wrapper">
              <button type="button" id="modelPickerBtn" class="model-picker-btn" title="Model &amp; effort">Auto ▾</button>
              <div id="modelPickerMenu" class="model-picker-menu hidden">
                <div id="modelPickerItems"></div>
              </div>
            </div>
            <button id="sendBtn" class="send-btn" title="Send" aria-label="Send message">${guiIcon('send')}</button>
          </div>
        </div>
      </form>
    </main>
  </div>
  <div id="surfaceDrawer" class="surface-drawer hidden">
    <div class="surface-panel">
      <header>
        <div><h2 id="surfaceTitle">Panel</h2><p id="surfaceSubtitle"></p></div>
        <button type="button" id="closeSurfaceBtn" class="icon-btn" title="Close" aria-label="Close panel">${guiIcon('close')}</button>
      </header>
      <div id="surfaceActions" class="surface-actions"></div>
      <div id="surfaceList" class="surface-list"></div>
    </div>
  </div>
  <div id="contextMenu" class="context-menu hidden"></div>
  <div id="workspaceModal" class="modal hidden">
    <form id="workspaceForm" class="dialog workspace-dialog">
      <h2>Workspace</h2>
      <p class="muted">Switch to an existing workspace or open a local project folder.</p>
      <div id="workspaceChoices" class="workspace-choice-list"></div>
      <label class="dialog-field">Workspace path<input id="workspacePathInput" autocomplete="off" placeholder="C:\\path\\to\\project"></label>
      <p id="workspaceStatus" class="muted"></p>
      <div class="dialog-actions">
        <button type="button" id="cancelWorkspace">Cancel</button>
        <button type="submit" id="openWorkspaceBtn" class="primary">Open workspace</button>
      </div>
    </form>
  </div>
  <div id="permissionModal" class="modal hidden">
    <div class="dialog">
      <h2>Permission required</h2>
      <p id="permissionTool"></p>
      <pre id="permissionSummary"></pre>
      <div class="dialog-actions permission-actions">
        <button data-decision="deny" class="danger">Deny</button>
        <button data-decision="allow">Allow once</button>
        <button data-decision="always">Always (project)</button>
        <button data-decision="always-user">Always (user)</button>
      </div>
    </div>
  </div>
  <div id="settingsModal" class="settings-view hidden">
    <aside class="settings-sidebar">
      <button type="button" id="backToAppBtn" class="back-btn">&lt; Back to app</button>
      <label class="settings-search"><span>Search settings</span><input id="settingsSearch" placeholder="Search settings..."></label>
      <section>
        <h2>Personal</h2>
        <button type="button" class="settings-tab active" data-settings-tab="general"><span class="settings-icon">${guiIcon('gear')}</span>General</button>
        <button type="button" class="settings-tab" data-settings-tab="models"><span class="settings-icon">${guiIcon('model')}</span>Models & routing</button>
        <button type="button" class="settings-tab" data-settings-tab="profile"><span class="settings-icon">${guiIcon('profile')}</span>Profile</button>
        <button type="button" class="settings-tab" data-settings-tab="appearance"><span class="settings-icon">${guiIcon('palette')}</span>Appearance</button>
        <button type="button" class="settings-tab" data-settings-tab="personalization"><span class="settings-icon">${guiIcon('agent')}</span>Personalization</button>
        <button type="button" class="settings-tab" data-settings-tab="shortcuts"><span class="settings-icon">${guiIcon('keyboard')}</span>Keyboard shortcuts</button>
      </section>
      <section>
        <h2>Agent</h2>
        <button type="button" class="settings-tab" data-settings-tab="capabilities"><span class="settings-icon">${guiIcon('tools')}</span>Capabilities</button>
        <button type="button" class="settings-tab" data-settings-tab="automation"><span class="settings-icon">${guiIcon('automation')}</span>Automation</button>
        <button type="button" class="settings-tab" data-settings-tab="sessions"><span class="settings-icon">${guiIcon('chat')}</span>Chats</button>
        <button type="button" class="settings-tab" data-settings-tab="memory"><span class="settings-icon">${guiIcon('memory')}</span>Memory</button>
      </section>
      <section>
        <h2>Integrations</h2>
        <button type="button" class="settings-tab" data-settings-tab="mcp"><span class="settings-icon">${guiIcon('plug')}</span>MCP servers</button>
        <button type="button" class="settings-tab" data-settings-tab="browser"><span class="settings-icon">${guiIcon('browser')}</span>Browser</button>
        <button type="button" class="settings-tab" data-settings-tab="computer"><span class="settings-icon">${guiIcon('computer')}</span>Computer control</button>
      </section>
      <section>
        <h2>Coding</h2>
        <button type="button" class="settings-tab" data-settings-tab="hooks"><span class="settings-icon">${guiIcon('hooks')}</span>Hooks</button>
        <button type="button" class="settings-tab" data-settings-tab="git"><span class="settings-icon">${guiIcon('git')}</span>Git</button>
        <button type="button" class="settings-tab" data-settings-tab="env"><span class="settings-icon">${guiIcon('environment')}</span>Environment</button>
        <button type="button" class="settings-tab" data-settings-tab="worktree"><span class="settings-icon">${guiIcon('worktree')}</span>Worktrees</button>
        <button type="button" class="settings-tab" data-settings-tab="bridge"><span class="settings-icon">${guiIcon('hooks')}</span>Bridge</button>
      </section>
    </aside>
    <form id="settingsForm" class="settings-main">
      <section class="settings-panel active" data-settings-panel="general">
        <h1>General</h1>
        <div class="settings-group">
          <h2>Work mode</h2>
          <p>Choose how much technical detail Actoviq shows by default.</p>
          <div class="mode-grid">
            <label class="mode-card"><input type="radio" name="settingsWorkMode" value="coding" id="settingsWorkModeCoding"><span><strong>For coding</strong><small>More technical replies and controls</small></span></label>
            <label class="mode-card"><input type="radio" name="settingsWorkMode" value="daily" id="settingsWorkModeDaily"><span><strong>For daily work</strong><small>Same power, less technical detail</small></span></label>
          </div>
        </div>
        <div class="settings-group">
          <h2>Permissions</h2>
          <div class="settings-row"><span><strong>Default permission</strong><small>Read and edit files in the workspace.</small></span><input id="settingsDefaultPermission" type="checkbox"></div>
          <div class="settings-row"><span><strong>Auto review</strong><small>Auto-accept workspace edits when possible.</small></span><input id="settingsAutoAudit" type="checkbox"></div>
          <div class="settings-row"><span><strong>Full access</strong><small>Run with bypass permissions for local agent work.</small></span><input id="settingsFullAccess" type="checkbox"></div>
          <label class="inline-field">Permission preset
            <select id="settingsPermissionPreset">
              <option value="">Keep current</option>
              <option value="full">Full access</option>
              <option value="workspace">Workspace</option>
              <option value="read-only">Read-only</option>
            </select>
          </label>
        </div>
      </section>
      <section class="settings-panel" data-settings-panel="models">
        <h1>Models & routing</h1>
        <div class="settings-group">
          <h2>Current run</h2>
          <p id="settingsCurrentRun" class="muted"></p>
          <div class="settings-row"><span><strong>Active model</strong><small id="settingsCurrentModel">Loading...</small></span><button type="button" id="settingsResetRuntimeModel" class="secondary-btn">Use default</button></div>
          <div class="settings-command-row">
            <label>Switch model<input id="settingsRuntimeModel" autocomplete="off" placeholder="model name"></label>
            <button type="button" id="settingsApplyRuntimeModel" class="secondary-btn">Use model</button>
          </div>
          <div class="settings-command-row">
            <label>Reasoning effort<select id="settingsRuntimeEffort"><option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="max">Max</option></select></label>
            <button type="button" id="settingsApplyRuntimeEffort" class="secondary-btn">Apply effort</button>
          </div>
        </div>
        <div class="settings-group">
          <h2>Router profiles</h2>
          <p>Route future turns through a saved model-router profile.</p>
          <div class="settings-command-row">
            <label>Router<select id="settingsRouterSelect"></select></label>
            <button type="button" id="settingsApplyRouter" class="secondary-btn">Use router</button>
            <button type="button" id="settingsDisableRouter" class="secondary-btn">Disable</button>
          </div>
          <div id="settingsRoutersList" class="settings-card-list"></div>
        </div>
      </section>
      <section class="settings-panel" data-settings-panel="profile">
        <h1>Profile</h1>
        <div class="settings-group"><p>User profile settings are stored in local Actoviq settings and memories. Use /memory and /dream to inspect durable context.</p></div>
      </section>
      <section class="settings-panel" data-settings-panel="appearance">
        <h1>Appearance</h1>
        <div class="settings-group two-col">
          <label>Theme<select id="settingsTheme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
          <label>Density<select id="settingsDensity"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
          <label class="check-row"><input id="settingsEnterToSend" type="checkbox">Enter sends message</label>
          <label class="check-row"><input id="settingsAutoScroll" type="checkbox">Auto-scroll transcript</label>
        </div>
      </section>
      <section class="settings-panel" data-settings-panel="personalization">
        <h1>Personalization</h1>
        <div class="settings-group"><p>Personalization uses local settings plus Actoviq memory. Keep stable preferences in memory; keep credentials in configuration.</p></div>
      </section>
      <section class="settings-panel" data-settings-panel="shortcuts">
        <h1>Keyboard shortcuts</h1>
        <div class="settings-group shortcut-list"><div><kbd>Ctrl</kbd> + <kbd>Enter</kbd><span>Send message</span></div><div><kbd>/</kbd><span>Open command flow</span></div><div><kbd>Shift</kbd> + <kbd>Enter</kbd><span>New line when Enter-to-send is on</span></div></div>
      </section>
      <section class="settings-panel" data-settings-panel="capabilities">
        <h1>Capabilities</h1>
        <div class="settings-group">
          <h2>Tools</h2>
          <p>Review the same registered tool surface exposed by /tools.</p>
          <div class="settings-action-row"><button type="button" id="settingsOpenTools" class="secondary-btn">Open tools drawer</button></div>
          <div id="settingsToolsList" class="settings-card-list compact"></div>
        </div>
        <div class="settings-group">
          <h2>Skills</h2>
          <div class="settings-action-row"><button type="button" id="settingsOpenSkills" class="secondary-btn">Open skills drawer</button></div>
          <div id="settingsSkillsList" class="settings-card-list compact"></div>
        </div>
        <div class="settings-group">
          <h2>Subagents</h2>
          <div class="settings-action-row"><button type="button" id="settingsOpenAgents" class="secondary-btn">Open agents drawer</button></div>
          <div id="settingsAgentsList" class="settings-card-list compact"></div>
        </div>
        <div class="settings-group">
          <h2>Plugins</h2>
          <div class="settings-action-row"><button type="button" id="settingsOpenPlugins" class="secondary-btn">Open plugins drawer</button></div>
          <div id="settingsPluginsList" class="settings-card-list compact"></div>
        </div>
      </section>
      <section class="settings-panel" data-settings-panel="automation">
        <h1>Automation</h1>
        <div class="settings-group">
          <h2>Workflows</h2>
          <p>Run saved workflow scripts without typing /workflows.</p>
          <label class="inline-field wide">Workflow input<input id="settingsWorkflowInput" autocomplete="off" placeholder="optional input"></label>
          <div id="settingsWorkflowsList" class="settings-card-list"></div>
        </div>
        <div class="settings-group">
          <h2>Teams</h2>
          <p>Attach a model team or disable team orchestration.</p>
          <div class="settings-action-row"><button type="button" id="settingsTeamOff" class="secondary-btn">No team</button></div>
          <div id="settingsTeamsList" class="settings-card-list"></div>
        </div>
        <div class="settings-group">
          <h2>Worktrees</h2>
          <div class="settings-command-row">
            <label>Worktree name<input id="settingsWorktreeName" autocomplete="off" placeholder="feature-name"></label>
            <button type="button" id="settingsEnterWorktree" class="secondary-btn">Create / enter</button>
            <button type="button" id="settingsExitWorktree" class="secondary-btn">Exit</button>
          </div>
          <div class="settings-action-row"><button type="button" id="settingsAutomationWorktreeList" class="secondary-btn">List worktrees</button></div>
        </div>
      </section>
      <section class="settings-panel" data-settings-panel="sessions">
        <h1>Chats</h1>
        <div class="settings-group">
          <h2>Session management</h2>
          <p id="settingsSessionSummary" class="muted"></p>
          <div class="settings-action-row">
            <button type="button" id="settingsNewChatBtn" class="secondary-btn">New chat</button>
          </div>
          <div id="settingsSessionsList" class="settings-card-list"></div>
        </div>
        <div class="settings-group">
          <h2>Archived</h2>
          <p class="muted">Archived chats are hidden from the session list but preserved on disk. Restore to make them visible again, or permanently delete them.</p>
          <div id="settingsArchivedList" class="settings-card-list"></div>
        </div>
      </section>
      <section class="settings-panel" data-settings-panel="memory">
        <h1>Memory</h1>
        <div class="settings-group">
          <p>Actoviq keeps two kinds of memory: the <strong>current chat's context</strong> (compaction summarizes older turns so the conversation keeps fitting in the model's window) and <strong>durable memory</strong> (dream consolidates lasting facts about you and the project). Both run automatically — the controls below let you inspect or trigger them by hand. Results open in the chat transcript.</p>
        </div>
        <div class="settings-group">
          <h2>Current chat context</h2>
          <div class="settings-help-row"><span><strong>Inspect memory</strong><small>Show the current compaction state and what has been summarized so far.</small></span><button type="button" id="settingsMemoryStatusBtn" class="secondary-btn">Inspect</button></div>
          <div class="settings-help-row"><span><strong>Compact now</strong><small>Summarize older turns right now to free up context space.</small></span><button type="button" id="settingsCompactNowBtn" class="secondary-btn">Compact</button></div>
          <label class="inline-field wide">Compaction guidance (optional)<input id="settingsCompactInstructions" autocomplete="off" placeholder="e.g. keep API decisions, drop long file listings"></label>
        </div>
        <div class="settings-group">
          <h2>Durable memory (dream)</h2>
          <div class="settings-help-row"><span><strong>Dream status</strong><small>See when consolidation last ran and what is pending.</small></span><button type="button" id="settingsDreamStatusBtn" class="secondary-btn">Status</button></div>
          <div class="settings-help-row"><span><strong>Run dream</strong><small>Consolidate lasting memories from this session into your stored profile now.</small></span><button type="button" id="settingsDreamRunBtn" class="secondary-btn">Run</button></div>
        </div>
      </section>
      <section class="settings-panel" data-settings-panel="mcp">
        <h1>MCP servers</h1>
        <div class="settings-group">
          <p>Inspect MCP-provided tools and open the full MCP drawer.</p>
          <button type="button" id="settingsMcpBtn" class="secondary-btn">Inspect MCP servers</button>
          <div id="settingsMcpList" class="settings-card-list compact"></div>
        </div>
        <div class="settings-group">
          <h2>Add MCP server</h2>
          <p class="muted">stdio runs a local command; http connects to a remote streamable_http endpoint. Saved to <code>~/.actoviq/mcp.json</code>; the SDK reloads on add/remove.</p>
          <div class="two-col">
            <label>Name<input id="mcpCfgName" autocomplete="off" placeholder="filesystem"></label>
            <label>Type<select id="mcpCfgType"><option value="stdio">stdio</option><option value="http">http</option></select></label>
          </div>
          <label class="inline-field">Command (stdio)<input id="mcpCfgCommand" autocomplete="off" placeholder="npx -y @modelcontextprotocol/server-filesystem ."></label>
          <label class="inline-field">URL (http)<input id="mcpCfgUrl" autocomplete="off" placeholder="https://example.com/mcp"></label>
          <label class="inline-field">Args (comma-separated, optional)<input id="mcpCfgArgs" autocomplete="off" placeholder="/path/to/dir, --flag"></label>
          <p id="mcpCfgStatus" class="muted"></p>
          <div class="settings-action-row"><button type="button" id="mcpCfgAdd" class="primary">Add server</button></div>
        </div>
        <div class="settings-group">
          <h2>Configured servers</h2>
          <div id="mcpServersList" class="settings-card-list"></div>
        </div>
      </section>
      <section class="settings-panel" data-settings-panel="browser">
        <h1>Browser</h1>
        <div class="settings-group"><p>Browser automation uses registered MCP/tools when available. Inspect tools from the main toolbar.</p></div>
      </section>
      <section class="settings-panel" data-settings-panel="computer">
        <h1>Computer control</h1>
        <div class="settings-group"><p>Computer control appears when the matching tools are registered for this workspace.</p></div>
      </section>
      <section class="settings-panel" data-settings-panel="hooks">
        <h1>Hooks</h1>
        <div class="settings-group"><p>Hooks are loaded from Actoviq configuration and agent definitions.</p></div>
      </section>
      <section class="settings-panel" data-settings-panel="git">
        <h1>Git</h1>
        <div class="settings-group">
          <p id="settingsGitSummary" class="muted">Reading repository…</p>
          <div class="settings-help-row"><span><strong>Git tree</strong><small>Browse branches, working-tree changes, and recent commits for this workspace.</small></span><button type="button" id="settingsGitTreeBtn" class="secondary-btn">View Git tree</button></div>
          <div class="settings-help-row"><span><strong>Workspace folder</strong><small>Open this project's folder in your system file manager.</small></span><button type="button" id="settingsOpenLocation" class="secondary-btn">Open location</button></div>
        </div>
      </section>
      <section class="settings-panel" data-settings-panel="env">
        <h1>Environment</h1>
        <p id="settingsPath" class="muted"></p>
        <div class="settings-group two-col">
          <label>Provider<select id="settingsProvider"><option value="anthropic">Anthropic-compatible</option><option value="openai">OpenAI-compatible</option></select></label>
          <label>Default model<input id="settingsDefaultModel" autocomplete="off"></label>
          <label>API key<input id="settingsApiKey" type="password" autocomplete="new-password" placeholder="Leave blank to keep current key"></label>
          <label class="check-row"><input id="settingsClearApiKey" type="checkbox">Clear saved API key</label>
          <label>Base URL<input id="settingsBaseUrl" autocomplete="off" placeholder="Provider default"></label>
          <label>Effort<select id="settingsEffort"><option value="">Keep current</option><option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="max">Max</option></select></label>
          <label>Min model<input id="settingsMinModel" autocomplete="off"></label>
          <label>Medium model<input id="settingsMediumModel" autocomplete="off"></label>
          <label>Max model<input id="settingsMaxModel" autocomplete="off"></label>
        </div>
      </section>
      <section class="settings-panel" data-settings-panel="worktree">
        <h1>Worktrees</h1>
        <div class="settings-group"><button type="button" id="settingsWorktreeBtn" class="secondary-btn">List worktrees</button></div>
      </section>
      <section class="settings-panel" data-settings-panel="bridge">
        <h1>Bridge runtimes</h1>
        <p>Switch the conversation to a different provider/model <strong>in-process</strong> — no child process. Save a named config (provider + API key + base URL + model), then activate it. The active config runs every prompt through its backend on the same chat, so context survives switching bridge↔default. Configs live in <code>~/.actoviq/bridge-configs.json</code>.</p>
        <div class="settings-group">
          <h2>Active</h2>
          <p id="bridgeActive" class="muted">No active bridge config — using the default provider.</p>
          <div class="settings-action-row">
            <button type="button" id="settingsBridgeOff" class="secondary-btn">Disable bridge</button>
            <button type="button" id="settingsBridgeDetectBtn" class="secondary-btn">Detect installed runtimes</button>
          </div>
          <div id="bridgeDetected" class="bridge-detected"></div>
        </div>
        <div class="settings-group">
          <h2>Add / edit config</h2>
          <label class="inline-field">Name<input id="bridgeCfgName" autocomplete="off" placeholder="e.g. deepseek-anthropic"></label>
          <div class="two-col">
            <label>Provider<select id="bridgeCfgProvider"><option value="anthropic">Anthropic-compatible</option><option value="openai">OpenAI-compatible</option></select></label>
            <label>Model<input id="bridgeCfgModel" autocomplete="off" placeholder="deepseek-chat"></label>
          </div>
          <label class="inline-field">API key<input id="bridgeCfgApiKey" type="password" autocomplete="new-password" placeholder="sk-… (blank keeps the saved key on edit)"></label>
          <label class="inline-field">Base URL<input id="bridgeCfgBaseUrl" autocomplete="off" placeholder="https://api.deepseek.com"></label>
          <label class="check-row"><input id="bridgeCfgClearKey" type="checkbox">Clear saved API key</label>
          <div class="settings-action-row">
            <button type="button" id="bridgeCfgSave" class="primary">Save config</button>
            <button type="button" id="bridgeCfgReset" class="secondary-btn">Clear form</button>
          </div>
          <p id="bridgeCfgStatus" class="muted"></p>
        </div>
        <div class="settings-group">
          <h2>Models</h2>
          <p class="muted">Define the models available under this config. Each model shows in the composer's model picker.</p>
          <div class="bridge-model-row">
            <input id="bridgeNewModelName" autocomplete="off" placeholder="Model id (e.g. deepseek-chat)" style="flex:2">
            <label class="check-row" style="flex:1"><input id="bridgeNewModel1M" type="checkbox">1 M ctx</label>
            <select id="bridgeNewModelModality" style="flex:1"><option value="text">Text</option><option value="multimodal">Multimodal</option></select>
            <button type="button" id="bridgeModelAdd" class="secondary-btn">+ Add</button>
          </div>
          <div id="bridgeModelsList" class="settings-card-list compact" style="margin-top:10px"></div>
        </div>
        <div class="settings-group">
          <h2>Saved configs</h2>
          <div id="bridgeConfigsList" class="settings-card-list"></div>
        </div>
      </section>
      <div class="settings-savebar">
        <span id="settingsStatus" class="muted"></span>
        <button type="button" id="cancelSettings">Cancel</button>
        <button type="submit" id="saveSettingsBtn" class="primary">Save</button>
      </div>
    </form>
  </div>
  <script src="/app.js" type="module"></script>
</body>
</html>`;
}

export function createActoviqGuiStyles(): string {
  return `
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  color: #202124;
  background: #f6f7f7;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
button, input, textarea, select { font: inherit; }
button { cursor: pointer; }
.hidden { display: none !important; }
.ui-icon { width: 18px; height: 18px; display: block; flex: 0 0 auto; }
.app { height: 100vh; display: flex; overflow: hidden; border: 1px solid #cfcfcf; background: #fff; }
.sidebar {
  width: 300px;
  flex: 0 0 300px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 10px 10px;
  overflow: hidden;
  background: linear-gradient(150deg, #f7f2ef 0%, #f2f0e9 58%, #e8f4ee 100%);
  border-right: 1px solid #dddddd;
}
.brand { display: flex; align-items: center; gap: 9px; height: 30px; padding: 0 6px; }
.brand-mark { width: 28px; height: 28px; flex: 0 0 28px; display: inline-grid; place-items: center; border-radius: 9px; background: linear-gradient(135deg, #4b93f7 0%, #6ad0a8 100%); color: #fff; }
.brand-mark .ui-icon { width: 18px; height: 18px; }
.brand-name { font-weight: 650; font-size: 15px; letter-spacing: .2px; color: #2f3337; }
.primary-nav, .project-list, .command-list { display: grid; gap: 2px; }
.nav-btn, .project-row, .project-list button, .command-list button, .sidebar-link, .icon-btn, .pill-btn, .round-btn, .secondary-btn, .mini-action-btn, .command-chip {
  min-height: 34px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: #2f3337;
}
.nav-btn { display: flex; align-items: center; gap: 10px; width: 100%; padding: 0 10px; text-align: left; }
.nav-icon, .folder-icon, .chevron, .settings-icon, .mini-icon { width: 22px; height: 22px; display: inline-grid; place-items: center; flex: 0 0 22px; color: #4e5358; }
.nav-icon .ui-icon, .folder-icon .ui-icon, .chevron .ui-icon, .settings-icon .ui-icon, .mini-icon .ui-icon { width: 18px; height: 18px; }
.nav-btn:hover, .project-row:hover, .project-list button:hover, .command-list button:hover, .sidebar-link:hover, .icon-btn:hover, .pill-btn:hover, .mini-action-btn:hover, .command-chip:hover { background: rgba(0,0,0,.055); }
.search { display: grid; gap: 6px; color: #777b80; font-size: 13px; }
.search input, .settings-search input {
  width: 100%;
  height: 34px;
  border: 1px solid #d8d8d8;
  border-radius: 10px;
  padding: 0 12px;
  background: rgba(255,255,255,.78);
  outline: none;
}
.project-section, .command-section { min-height: 0; }
.project-section { flex: 1; overflow: hidden; }
.project-section h2, .command-section h2, .settings-sidebar h2 { margin: 8px 10px; font-size: 13px; font-weight: 500; color: #85888d; }
.section-title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 2px 0 4px; }
.section-actions { display: flex; align-items: center; gap: 4px; }
.mini-action-btn { min-height: 28px; display: inline-flex; align-items: center; gap: 5px; padding: 0 7px; color: #4e5358; }
.mini-action-btn small { font-size: 11px; color: #6d7177; }
.project-control-row { display: grid; grid-template-columns: minmax(0, 1fr) 34px; gap: 4px; align-items: center; }
.project-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; text-align: left; }
.project-row > span:nth-child(2) { min-width: 0; display: grid; gap: 2px; }
.project-row .chevron { margin-left: auto; color: #7a7e83; }
.project-list { max-height: 150px; overflow: auto; margin: 4px 0; }
.project-list button { width: 100%; display: grid; gap: 2px; padding: 7px 10px; text-align: left; }
.project-list button.active { background: rgba(0,0,0,.06); }
.project-actions { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0 6px; }
.workspace-meta { margin: 2px 10px 8px; color: #777b80; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-row strong, .project-list strong { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-row small, .project-list small, .command-list small { color: #7e8389; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folder-icon { color: #4e5358; }
.project-session-list { display: grid; gap: 2px; margin: 2px 0 6px 20px; padding-left: 8px; border-left: 1px solid rgba(0,0,0,.08); }
.project-session-list.current-project-chats { margin: 0; padding-left: 0; border-left: 0; }
.project-chat-row { min-height: 30px !important; padding: 6px 9px !important; border-radius: 8px !important; }
.project-chat-row strong { font-size: 13px; font-weight: 500; }
.project-chat-row small { font-size: 12px; }
.project-chat-row.active { background: rgba(0,0,0,.06); }
.project-chat-more { justify-self: start; min-height: 28px !important; padding: 0 9px !important; color: #7b7f84 !important; }
.command-list button { width: 100%; padding: 8px 10px; text-align: left; display: grid; gap: 2px; }
.sidebar-link { justify-self: start; padding: 0 10px; color: #8a8d91; }
.command-section { max-height: 190px; overflow: auto; }
.sidebar-footer { display: flex; align-items: center; gap: 8px; margin-top: auto; }
.sidebar-footer .nav-btn { flex: 1; }
.icon-btn { width: 34px; height: 34px; display: inline-grid; place-items: center; }
.icon-btn .ui-icon, .round-btn .ui-icon, .send-btn .ui-icon { width: 18px; height: 18px; }
.chat { flex: 1; min-width: 0; display: flex; flex-direction: column; background: #fff; }
.topbar { min-height: 58px; border-bottom: 1px solid #e7e7e7; display: flex; align-items: center; justify-content: space-between; padding: 10px 18px; gap: 14px; }
.title-block { min-width: 0; }
.title-row { display: flex; align-items: center; gap: 8px; }
h1 { font-size: 16px; margin: 0; font-weight: 650; }
.topbar p { margin: 3px 0 0; color: #777b80; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 64vw; }
.top-actions { display: flex; gap: 8px; align-items: center; }
.pill-btn { border-color: #dddddd; background: #fff; padding: 0 14px; }
select { border: 1px solid #dddddd; background: #fff; color: #202124; border-radius: 8px; height: 34px; padding: 0 9px; }
.statusbar { min-height: 34px; padding: 8px 18px; color: #6b6f75; font-size: 13px; border-bottom: 1px solid #f0f0f0; display: flex; align-items: center; gap: 8px; }
.statusbar.running::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #4b93f7; box-shadow: 0 0 0 0 rgba(75,147,247,.45); animation: pulse 1.2s infinite; }
.statusbar.error::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #c7392f; }
.transcript { flex: 1; overflow: auto; padding: 24px max(22px, 12vw) 18px; }
.message { margin: 0 0 18px; line-height: 1.55; white-space: pre-wrap; }
.message.user { margin-left: auto; max-width: 68%; background: #f1f2f3; padding: 10px 14px; border-radius: 16px; }
.message.assistant { max-width: 840px; }
.message.assistant a { color: #2f5fa8; }
.message.assistant .md-h { margin: 14px 0 8px; line-height: 1.3; }
.message.assistant p.md-p { margin: 0 0 12px; }
.message.assistant ul.md-ul { margin: 8px 0; padding-left: 22px; }
.message.assistant ol.md-ol { margin: 8px 0; padding-left: 24px; }
.message.assistant ul.md-ul li, .message.assistant ol.md-ol li { margin: 3px 0; }
.message.assistant li.md-task { list-style: none; margin-left: -20px; }
.message.assistant li.md-task input[type="checkbox"] { margin-right: 7px; accent-color: #4a90f7; }
.message.assistant li.md-task-done { color: #9aa0a6; }
.message.assistant li.md-task-done > :not(input) { text-decoration: line-through; }
.message.assistant blockquote.md-quote { margin: 8px 0; padding: 4px 14px; border-left: 3px solid #d8d8d8; color: #5f6368; }
.message.assistant hr.md-hr { border: 0; border-top: 1px solid #e2e2e2; margin: 16px 0; }
.message.assistant del { color: #9aa0a6; }
.message.assistant .md-table { border-collapse: collapse; margin: 10px 0; font-size: 13.5px; display: block; overflow-x: auto; }
.message.assistant .md-table th, .message.assistant .md-table td { border: 1px solid #e2e2e2; padding: 6px 11px; text-align: left; }
.message.assistant .md-table th { background: #f6f7f8; font-weight: 600; }
.message.assistant .md-table tr:nth-child(even) td { background: #fafbfc; }
.message.assistant .md-table :is(th, td) :where(.inline-code) { background: #eef0f1; }
.message.assistant .inline-code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .92em; background: #f1f2f3; padding: 1px 5px; border-radius: 5px; }
.code-block { position: relative; margin: 10px 0; padding: 12px; background: #1f2330; color: #e6e9ef; border-radius: 8px; overflow: auto; }
.code-block code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12.5px; white-space: pre; }
.copy-btn { position: absolute; top: 6px; right: 6px; min-height: 24px; border: 1px solid rgba(255,255,255,.22); border-radius: 6px; background: rgba(255,255,255,.08); color: #e6e9ef; padding: 0 8px; font-size: 12px; }
.copy-btn:hover { background: rgba(255,255,255,.16); }
.code-lang { position: absolute; top: 6px; left: 12px; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; text-transform: lowercase; color: rgba(230,233,239,.5); letter-spacing: .04em; }
.code-block:has(.code-lang) code { margin-top: 6px; display: block; }
.message.notice, .message.tool, .message.error { max-width: 840px; color: #5f6368; border-left: 3px solid #d8d8d8; padding-left: 12px; font-size: 14px; }
.message.error { border-left-color: #c7392f; color: #8c1d18; }
.message.tool { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
.tool-card { max-width: 840px; border: 1px solid #e2e5e8; border-radius: 8px; margin: 0 0 18px; overflow: hidden; background: #fff; animation: slideIn .18s ease-out; }
.tool-card header { min-height: 48px; display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: #fafbfc; border-bottom: 1px solid #eef0f2; }
.tool-card strong { display: block; font-size: 14px; }
.tool-card small { display: block; color: #777b80; margin-top: 2px; }
.tool-spinner { width: 14px; height: 14px; border: 2px solid #d7e3f8; border-top-color: #4b93f7; border-radius: 50%; animation: spin .85s linear infinite; flex: 0 0 auto; }
.tool-card.success .tool-spinner, .tool-card.error .tool-spinner { animation: none; border: 0; display: inline-grid; place-items: center; color: #fff; font-size: 10px; }
.tool-card.success .tool-spinner { background: #1f8f4c; }
.tool-card.success .tool-spinner::before { content: "ok"; }
.tool-card.error .tool-spinner { background: #c7392f; }
.tool-card.error .tool-spinner::before { content: "x"; }
.tool-card pre { margin: 0; padding: 10px 12px; max-height: 180px; overflow: auto; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; color: #4d5359; background: #fff; }
.tool-card.running::after { content: ""; display: block; height: 2px; background: linear-gradient(90deg, transparent, #4b93f7, transparent); animation: sweep 1.15s infinite; }
.tool-card.error { border-color: #e5b7b2; }
.tool-card.success { border-color: #cfe6d8; }
.result { max-width: 840px; border: 1px solid #e1e1e1; border-radius: 8px; margin-bottom: 18px; overflow: hidden; }
.result h3 { margin: 0; padding: 10px 12px; font-size: 14px; border-bottom: 1px solid #e8e8e8; background: #fafafa; }
.result pre { margin: 0; padding: 12px; overflow: auto; white-space: pre-wrap; }
.result .row { padding: 10px 12px; border-top: 1px solid #eeeeee; }
.result small { display: block; color: #777b80; margin-top: 3px; }
.composer { margin: 0 max(22px, 12vw) 18px; border: 1px solid #dddddd; border-radius: 18px; padding: 10px; background: #fff; display: grid; gap: 8px; position: relative; }
.composer.dragging { border-color: #4b93f7; box-shadow: 0 0 0 3px rgba(75,147,247,.12); }
.composer textarea { resize: none; border: 0; outline: none; min-height: 58px; max-height: 190px; width: 100%; }
.hidden-file-input { display: none; }
.drop-overlay { position: absolute; inset: 8px; z-index: 3; border: 1px dashed #4b93f7; border-radius: 14px; background: rgba(244,248,255,.94); color: #2f5fa8; display: grid; place-items: center; font-weight: 600; pointer-events: none; }
.drop-overlay.hidden { display: none; }
.attachment-tray { display: flex; flex-wrap: wrap; gap: 6px; }
.attachment-tray.hidden { display: none; }
.attachment-chip { min-height: 30px; display: inline-flex; align-items: center; gap: 8px; border: 1px solid #dfe3e7; border-radius: 8px; padding: 0 8px; background: #f8f9fa; max-width: 100%; }
.attachment-chip small { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #5f6368; }
.attachment-chip button { border: 0; background: transparent; color: #777b80; padding: 0; min-width: 18px; }
.slash-menu, .queue-list { border: 1px solid #e1e1e1; border-radius: 10px; overflow: hidden; background: #fff; }
.slash-menu.hidden, .queue-list.hidden, .surface-drawer.hidden { display: none; }
.slash-menu button { width: 100%; display: grid; grid-template-columns: 160px 1fr; gap: 10px; min-height: 34px; border: 0; border-bottom: 1px solid #f0f0f0; background: transparent; padding: 7px 10px; text-align: left; }
.slash-menu button:last-child { border-bottom: 0; }
.slash-menu button.active { background: #f1f3f4; }
.slash-menu small, .queue-list small { color: #777b80; }
.queue-list { display: grid; gap: 0; }
.queue-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 32px; padding: 6px 10px; border-bottom: 1px solid #f0f0f0; }
.queue-item:last-child { border-bottom: 0; }
.queue-item button { border: 0; background: transparent; color: #777b80; }
.composer-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.composer-left, .composer-right { display: flex; align-items: center; gap: 8px; }
.round-btn, .send-btn { width: 34px; height: 34px; border-radius: 50%; display: inline-grid; place-items: center; }
.round-btn { background: transparent; border: 1px solid #d8d8d8; color: #4c5055; }
.command-chip { border-color: #d8d8d8; padding: 0 10px; color: #4c5055; }
.send-btn { border: 0; background: #202124; color: #fff; }
.send-btn.stopping { background: #c7392f; }
.context-menu { position: fixed; z-index: 40; min-width: 168px; background: #fff; border: 1px solid #d8d8d8; border-radius: 9px; box-shadow: 0 12px 34px rgba(0,0,0,.18); padding: 4px; display: grid; gap: 2px; }
.context-menu.hidden { display: none; }
.context-menu button { width: 100%; text-align: left; border: 0; background: transparent; border-radius: 6px; min-height: 32px; padding: 0 10px; color: #2f3337; cursor: pointer; }
.context-menu button:hover { background: rgba(0,0,0,.06); }
.context-menu button.danger { color: #c7392f; }
.git-section { display: grid; gap: 6px; }
.git-section > h3 { margin: 2px 0; font-size: 12px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: #85888d; }
.git-branch-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.git-badge { border: 1px solid #d8d8d8; border-radius: 999px; padding: 2px 10px; font-size: 12px; color: #4e5358; }
.git-row { display: flex; gap: 8px; align-items: baseline; padding: 5px 0; border-top: 1px solid #f0f0f0; font-size: 13px; }
.git-row:first-child { border-top: 0; }
.git-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.git-stat { font-family: ui-monospace, Consolas, monospace; font-size: 12px; min-width: 22px; color: #1f8f4c; }
.git-stat.del { color: #c7392f; }
.git-current { font-weight: 650; }
.git-hash { font-family: ui-monospace, Consolas, monospace; color: #7a7e83; }
.git-meta { color: #85888d; margin-left: auto; white-space: nowrap; }
.surface-drawer { position: fixed; inset: 0; z-index: 12; background: rgba(0,0,0,.16); display: flex; justify-content: flex-end; }
.surface-panel { width: min(520px, calc(100vw - 320px)); min-width: 360px; height: 100%; background: #fff; border-left: 1px solid #dedede; display: flex; flex-direction: column; }
.surface-panel header { min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid #e8e8e8; }
.surface-panel h2, .surface-panel p { margin: 0; }
.surface-panel p { color: #777b80; font-size: 13px; }
.surface-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 18px; border-bottom: 1px solid #f0f0f0; }
.surface-actions button, .surface-card button { min-height: 32px; border: 1px solid #d8d8d8; border-radius: 8px; background: #fff; padding: 0 10px; }
.surface-list { overflow: auto; padding: 12px 18px 24px; display: grid; gap: 10px; }
.surface-card { border: 1px solid #e1e1e1; border-radius: 8px; padding: 12px; display: grid; gap: 8px; }
.surface-card strong { overflow-wrap: anywhere; }
.surface-card p { color: #666b70; margin: 0; overflow-wrap: anywhere; }
.surface-card footer { display: flex; gap: 8px; flex-wrap: wrap; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.18); display: grid; place-items: center; padding: 20px; z-index: 30; }
.modal.hidden, .settings-view.hidden { display: none; }
.dialog { width: min(520px, 100%); background: #fff; border-radius: 8px; border: 1px solid #d8d8d8; padding: 18px; box-shadow: 0 20px 55px rgba(0,0,0,.14); }
.dialog h2 { margin: 0 0 8px; font-size: 18px; }
.dialog-field { display: grid; gap: 6px; margin: 14px 0 8px; color: #5f6368; font-size: 13px; }
.dialog-field input { min-height: 38px; border: 1px solid #d8d8d8; border-radius: 9px; padding: 0 10px; outline: none; }
.workspace-choice-list { display: grid; gap: 4px; max-height: 220px; overflow: auto; margin: 12px 0; padding: 2px; }
.workspace-choice { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; border: 1px solid transparent; border-radius: 8px; background: transparent; text-align: left; padding: 9px 10px; cursor: pointer; font: inherit; }
.workspace-choice:hover, .workspace-choice.active { background: #f1f1ef; border-color: #e1e1df; }
.workspace-choice strong, .workspace-choice small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-choice small { color: #73777d; }
.workspace-choice .workspace-count { color: #7b8086; font-size: 12px; white-space: nowrap; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
.dialog-actions button, .settings-savebar button { border: 1px solid #d8d8d8; border-radius: 8px; min-height: 34px; padding: 0 12px; background: #fff; }
.dialog-actions .primary, .settings-savebar .primary { background: #202124; color: #fff; }
.settings-view { position: fixed; inset: 0; z-index: 20; display: flex; background: #fff; border: 1px solid #cfcfcf; }
.settings-sidebar { width: 300px; flex: 0 0 300px; padding: 18px 10px; overflow: auto; background: linear-gradient(150deg, #f7f2ef 0%, #f2f0e9 58%, #e8f4ee 100%); border-right: 1px solid #dddddd; }
.back-btn { width: 100%; min-height: 34px; border: 0; background: transparent; text-align: left; color: #777b80; border-radius: 8px; padding: 0 10px; margin-bottom: 12px; }
.settings-search { display: grid; gap: 6px; margin-bottom: 18px; color: #777b80; font-size: 13px; }
.settings-tab { width: 100%; min-height: 38px; display: flex; align-items: center; gap: 10px; border: 0; background: transparent; border-radius: 8px; padding: 0 10px; text-align: left; color: #2f3337; }
.settings-icon { color: #4e5358; }
.settings-tab:hover, .settings-tab.active, .back-btn:hover { background: rgba(0,0,0,.06); }
.settings-main { flex: 1; overflow: auto; padding: 84px min(11vw, 160px) 110px; position: relative; }
.settings-panel { display: none; max-width: 840px; }
.settings-panel.active { display: block; }
.settings-panel h1 { font-size: 24px; margin: 0 0 64px; }
.settings-group { margin-bottom: 42px; }
.settings-group h2 { font-size: 18px; margin: 0 0 8px; }
.settings-group p { margin: 0 0 20px; color: #7b7f84; }
.mode-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.mode-card { min-height: 78px; border: 1px solid #e2e2e2; border-radius: 12px; display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 18px; }
.mode-card input { order: 2; width: 20px; height: 20px; accent-color: #4a90f7; }
.mode-card small { display: block; color: #777b80; margin-top: 4px; }
.settings-row { min-height: 82px; border: 1px solid #e8e8e8; border-bottom: 0; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px 16px; }
.settings-row:first-child { border-radius: 12px 12px 0 0; }
.settings-row:nth-last-child(2) { border-bottom: 1px solid #e8e8e8; border-radius: 0 0 12px 12px; }
.settings-row small { display: block; color: #777b80; margin-top: 4px; }
.settings-row input[type="checkbox"], .check-row input { width: 22px; height: 22px; accent-color: #4a90f7; }
.inline-field, .two-col label, .settings-command-row label { display: grid; gap: 7px; color: #5f6368; font-size: 13px; }
.inline-field { margin-top: 14px; max-width: 320px; }
.inline-field.wide { max-width: 520px; }
.two-col { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.two-col input, .two-col select, .inline-field input, .inline-field select, .settings-command-row input, .settings-command-row select { min-height: 38px; border: 1px solid #dddddd; border-radius: 9px; padding: 0 10px; background: #fff; color: #202124; }
.check-row { display: flex !important; align-items: center; gap: 10px; color: #2f3337 !important; }
.shortcut-list div { display: flex; align-items: center; gap: 8px; min-height: 38px; }
kbd { border: 1px solid #d8d8d8; border-bottom-width: 2px; border-radius: 6px; padding: 2px 7px; background: #fafafa; }
.secondary-btn { border-color: #d8d8d8; background: #fff; padding: 0 12px; }
.settings-command-row { display: grid; grid-template-columns: minmax(220px, 1fr) auto auto; align-items: end; gap: 10px; margin: 14px 0; }
.settings-action-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.settings-help-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; border-top: 1px solid #eee; }
.settings-help-row:first-of-type { border-top: 0; }
.settings-help-row > span { display: grid; gap: 3px; }
.settings-help-row small { color: #777b80; }
.settings-help-row .secondary-btn { white-space: nowrap; }
.settings-card-list { display: grid; gap: 10px; max-height: 360px; overflow: auto; padding-right: 2px; }
.settings-card-list.compact { max-height: 260px; }
.settings-card { border: 1px solid #e3e5e7; border-radius: 8px; padding: 12px; display: grid; gap: 8px; background: #fff; }
.settings-card strong { overflow-wrap: anywhere; font-size: 14px; }
.settings-card p { margin: 0; color: #6f7479; overflow-wrap: anywhere; }
.settings-card footer { display: flex; flex-wrap: wrap; gap: 8px; }
.settings-card button { min-height: 30px; border: 1px solid #d8d8d8; border-radius: 8px; background: #fff; padding: 0 10px; }
.settings-savebar { position: fixed; right: min(11vw, 160px); bottom: 24px; display: flex; align-items: center; gap: 10px; background: rgba(255,255,255,.94); border: 1px solid #e5e5e5; border-radius: 12px; padding: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.08); }
.muted { color: #777b80; font-size: 13px; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 70% { box-shadow: 0 0 0 8px rgba(75,147,247,0); } 100% { box-shadow: 0 0 0 0 rgba(75,147,247,0); } }
@keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
@keyframes slideIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
body[data-density="compact"] .message { margin-bottom: 10px; line-height: 1.42; }
body[data-density="compact"] .transcript { padding-top: 14px; padding-bottom: 10px; }
body[data-density="compact"] .composer { margin-bottom: 10px; padding: 8px; }
body[data-theme="dark"] { color: #e8eaed; background: #1f2023; }
body[data-theme="dark"] .chat, body[data-theme="dark"] .composer, body[data-theme="dark"] .dialog, body[data-theme="dark"] .settings-view, body[data-theme="dark"] .settings-main, body[data-theme="dark"] .surface-panel, body[data-theme="dark"] .slash-menu, body[data-theme="dark"] .queue-list, body[data-theme="dark"] .tool-card { background: #1f2023; color: #e8eaed; }
body[data-theme="dark"] .sidebar, body[data-theme="dark"] .settings-sidebar { background: #202226; border-color: #3b3d43; }
body[data-theme="dark"] input, body[data-theme="dark"] textarea, body[data-theme="dark"] select, body[data-theme="dark"] .pill-btn, body[data-theme="dark"] .dialog-actions button, body[data-theme="dark"] .settings-savebar button, body[data-theme="dark"] .secondary-btn, body[data-theme="dark"] .surface-actions button, body[data-theme="dark"] .surface-card button, body[data-theme="dark"] .settings-card button, body[data-theme="dark"] .command-chip { background: #26272b; color: #e8eaed; border-color: #3b3d43; }
body[data-theme="dark"] .nav-btn, body[data-theme="dark"] .settings-tab, body[data-theme="dark"] .project-row, body[data-theme="dark"] .project-list button, body[data-theme="dark"] .command-list button, body[data-theme="dark"] .icon-btn, body[data-theme="dark"] .round-btn, body[data-theme="dark"] .mini-action-btn, body[data-theme="dark"] .check-row, body[data-theme="dark"] .slash-menu button { color: #e8eaed !important; }
body[data-theme="dark"] .topbar, body[data-theme="dark"] .statusbar, body[data-theme="dark"] .result h3, body[data-theme="dark"] .result .row, body[data-theme="dark"] .mode-card, body[data-theme="dark"] .settings-row, body[data-theme="dark"] .settings-card, body[data-theme="dark"] .surface-panel header, body[data-theme="dark"] .surface-card, body[data-theme="dark"] .slash-menu, body[data-theme="dark"] .queue-list, body[data-theme="dark"] .tool-card, body[data-theme="dark"] .tool-card header, body[data-theme="dark"] .attachment-chip { border-color: #3b3d43; }
body[data-theme="dark"] .message.user, body[data-theme="dark"] .result h3, body[data-theme="dark"] kbd, body[data-theme="dark"] .slash-menu button.active, body[data-theme="dark"] .tool-card header, body[data-theme="dark"] .attachment-chip { background: #303238; }
body[data-theme="dark"] .settings-card { background: #1f2023; }
body[data-theme="dark"] .message.assistant .inline-code { background: #303238; }
body[data-theme="dark"] .message.assistant blockquote.md-quote { border-left-color: #3b3d43; color: #aab0b8; }
body[data-theme="dark"] .message.assistant hr.md-hr { border-top-color: #3b3d43; }
body[data-theme="dark"] .message.assistant .md-table th, body[data-theme="dark"] .message.assistant .md-table td { border-color: #3b3d43; }
body[data-theme="dark"] .message.assistant .md-table th { background: #26272b; }
body[data-theme="dark"] .message.assistant .md-table tr:nth-child(even) td { background: #232529; }
body[data-theme="dark"] .message.assistant del, body[data-theme="dark"] .message.assistant li.md-task-done { color: #6f7479; }
body[data-theme="dark"] .message.assistant .md-table :is(th, td) :where(.inline-code) { background: #303238; }
body[data-theme="dark"] .message.assistant a { color: #8ab4f8; }
body[data-theme="dark"] .brand-name { color: #e8eaed; }
body[data-theme="dark"] .context-menu { background: #26272b; border-color: #3b3d43; }
body[data-theme="dark"] .context-menu button { color: #e8eaed; }
body[data-theme="dark"] .context-menu button:hover { background: #33363c; }
body[data-theme="dark"] .git-row, body[data-theme="dark"] .settings-help-row { border-color: #3b3d43; }
body[data-theme="dark"] .git-badge { border-color: #3b3d43; color: #aab0b8; }
body[data-theme="dark"] .tool-card pre { background: #1f2023; color: #c7ccd3; }
body[data-theme="dark"] .drop-overlay { background: rgba(35,42,52,.95); color: #b8d2ff; }
body[data-theme="dark"] .muted, body[data-theme="dark"] small, body[data-theme="dark"] .topbar p, body[data-theme="dark"] .statusbar, body[data-theme="dark"] .settings-group p, body[data-theme="dark"] .workspace-meta { color: #aab0b8; }
body.sidebar-collapsed .sidebar { width: 72px; flex-basis: 72px; }
body.sidebar-collapsed .sidebar .search,
body.sidebar-collapsed .project-section,
body.sidebar-collapsed .command-section,
body.sidebar-collapsed .sidebar-link,
body.sidebar-collapsed .brand-name,
body.sidebar-collapsed .nav-btn span:not(.nav-icon) { display: none; }
body.sidebar-collapsed .sidebar-footer { justify-content: center; }
@media (max-width: 860px) {
  .sidebar, .settings-sidebar { width: 86px; flex-basis: 86px; }
  .sidebar .search, .command-section, .project-section h2, .project-session-list, .sidebar-link, .settings-search, .settings-sidebar section h2, .settings-tab span + text { display: none; }
  .transcript { padding: 18px 16px; }
  .composer { margin: 0 12px 12px; }
  .mode-grid, .two-col { grid-template-columns: 1fr; }
  .settings-command-row { grid-template-columns: 1fr; }
  .settings-main { padding: 48px 22px 110px; }
}
.context-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 7px 18px; border-bottom: 1px solid #f0f0f0; font-size: 12.5px; color: #5f6368; }
.context-bar.hidden { display: none; }
.context-bar > span { display: inline-flex; align-items: center; gap: 4px; border: 1px solid #e2e5e8; border-radius: 999px; padding: 2px 10px; background: #fafbfc; white-space: nowrap; max-width: 50vw; overflow: hidden; text-overflow: ellipsis; }
.ctx-goal { border-color: #cfe6d8; background: #f1f8f3; color: #1f6b3b; }
.ctx-paused { color: #8a6d1b; border-color: #ecdfb8; background: #fbf6e6; }
.ctx-complete { color: #5f6368; }
.ctx-bridge { border-color: #cfd9ef; background: #f1f6fe; color: #2f5fa8; }
.ctx-plan { border-color: #ead9ef; background: #f8f1fb; color: #6b2f7a; }
.ctx-usage { border-color: #e2e5e8; color: #5f6368; }
.todos-panel { margin: 0 max(22px, 12vw); padding: 8px 0 0; }
.todos-panel.hidden { display: none; }
.todos-panel > summary { cursor: pointer; font-size: 13px; color: #5f6368; user-select: none; }
#todosList { margin: 6px 0 0; padding-left: 20px; max-height: 220px; overflow: auto; }
#todosList li { font-size: 13px; line-height: 1.55; color: #4d5359; }
#todosList li.todo-completed { color: #9aa0a6; text-decoration: line-through; }
#todosList li.todo-in_progress { font-weight: 500; color: #2f5fa8; }
.permission-actions { flex-wrap: wrap; justify-content: flex-end; }
.permission-actions .danger { color: #c7392f; }
.model-picker-wrapper { position: relative; }
.model-picker-btn { min-height: 34px; border: 1px solid #dddddd; border-radius: 8px; background: #fff; color: #202124; padding: 0 10px; font: inherit; cursor: pointer; white-space: nowrap; }
.model-picker-btn:hover { background: #f5f5f5; }
.model-picker-menu { position: absolute; right: 0; bottom: calc(100% + 6px); min-width: 280px; max-width: 420px; background: #fff; border: 1px solid #d8d8d8; border-radius: 10px; box-shadow: 0 12px 36px rgba(0,0,0,.14); z-index: 15; padding: 6px; max-height: 420px; overflow-y: auto; }
.model-picker-menu.hidden { display: none; }
.model-picker-cat { font-size: 12px; font-weight: 600; color: #85888d; padding: 6px 10px 2px; text-transform: uppercase; letter-spacing: .04em; }
.model-picker-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 34px; padding: 5px 10px; border-radius: 7px; cursor: pointer; font-size: 13px; border: 0; background: transparent; width: 100%; text-align: left; color: #2f3337; }
.model-picker-item:hover { background: #f1f3f4; }
.model-picker-item.selected { background: #e9f2fe; color: #1a56c4; }
.model-picker-tags { display: flex; gap: 4px; font-size: 11px; color: #85888d; }
.model-picker-tags span { border: 1px solid #e2e5e8; border-radius: 4px; padding: 1px 5px; white-space: nowrap; }
.model-picker-efforts { display: flex; gap: 3px; }
.model-picker-effort { min-height: 22px; border: 1px solid #e2e5e8; border-radius: 5px; background: #fafbfc; font-size: 11px; color: #5f6368; padding: 1px 6px; cursor: pointer; }
.model-picker-effort:hover, .model-picker-effort.active { background: #e9f2fe; color: #1a56c4; border-color: #bdd4f0; }
body[data-theme="dark"] .model-picker-btn { background: #26272b; color: #e8eaed; border-color: #3b3d43; }
body[data-theme="dark"] .model-picker-menu { background: #26272b; border-color: #3b3d43; }
body[data-theme="dark"] .model-picker-item { color: #e8eaed; }
body[data-theme="dark"] .model-picker-item:hover { background: #33363c; }
body[data-theme="dark"] .model-picker-item.selected { background: #1f2b3a; color: #8ab4f8; }
body[data-theme="dark"] .model-picker-effort { background: #26272b; border-color: #3b3d43; color: #aab0b8; }
body[data-theme="dark"] .model-picker-tags span { border-color: #3b3d43; }
.bridge-detected { display: grid; gap: 4px; margin-top: 10px; }
.bridge-provider { margin: 0; font-size: 13px; color: #5f6368; }
body[data-theme="dark"] .context-bar, body[data-theme="dark"] .todos-panel { border-color: #3b3d43; }
body[data-theme="dark"] .context-bar > span { background: #26272b; border-color: #3b3d43; color: #c7ccd3; }
body[data-theme="dark"] .ctx-goal { background: #1e2b22; border-color: #2f4a37; color: #8dd9a8; }
body[data-theme="dark"] .ctx-bridge { background: #1f2b3a; border-color: #2f4a6b; color: #8ab4f8; }
body[data-theme="dark"] .ctx-plan { background: #2b1f30; border-color: #4a2f5a; color: #d7a8e6; }
body[data-theme="dark"] #todosList li { color: #c7ccd3; }
body[data-theme="dark"] #todosList li.todo-completed { color: #6f7479; }
}`;
}

export function createActoviqGuiClientScript(): string {
  return `
const ACTOVIQ_TOKEN = window.__ACTOVIQ_TOKEN__ || '';
function api(path, options = {}) {
  const headers = Object.assign({}, options.headers || {}, { 'x-actoviq-token': ACTOVIQ_TOKEN });
  return fetch(path, Object.assign({}, options, { headers }));
}
${renderMarkdown.toString()}
function renderMarkdownInto(node, value) { node.innerHTML = renderMarkdown(value || ''); }
const state = {
  currentAssistant: null,
  pendingPermissionId: null,
  permissionQueue: [],
  snapshot: null,
  sessionsLimit: 16,
  queue: [],
  running: false,
  slashIndex: 0,
  activeSurface: null,
  attachments: [],
  attachmentCounter: 0,
  lastUsageText: '',
  toolNodes: new Map(),
  preferences: { workMode: 'coding', theme: 'system', density: 'comfortable', enterToSend: true, autoScroll: true }
};
const el = (id) => document.getElementById(id);
const transcript = el('transcript');
const input = el('promptInput');
const statusbar = el('statusbar');

function shouldAutoScroll() { return state.preferences.autoScroll !== false; }
function scrollTranscript() { if (shouldAutoScroll()) transcript.scrollTop = transcript.scrollHeight; }
function applyPreferences(preferences) {
  state.preferences = { ...state.preferences, ...(preferences || {}) };
  const theme = state.preferences.theme === 'dark' || state.preferences.theme === 'light'
    ? state.preferences.theme
    : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.body.dataset.theme = theme;
  document.body.dataset.density = state.preferences.density === 'compact' ? 'compact' : 'comfortable';
}
const SEND_SVG = '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';
const STOP_SVG = '<svg class="ui-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';
function updateSendButton() {
  const btn = el('sendBtn');
  if (!btn) return;
  if (state.running) {
    btn.innerHTML = STOP_SVG;
    btn.title = 'Stop';
    btn.setAttribute('aria-label', 'Stop the current run');
    btn.classList.add('stopping');
  } else {
    btn.innerHTML = SEND_SVG;
    btn.title = 'Send';
    btn.setAttribute('aria-label', 'Send message');
    btn.classList.remove('stopping');
  }
}
function hideContextMenu() {
  const menu = el('contextMenu');
  if (menu) menu.classList.add('hidden');
}
function showContextMenu(x, y, items) {
  const menu = el('contextMenu');
  menu.textContent = '';
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    if (item.danger) button.classList.add('danger');
    button.addEventListener('click', (event) => { event.stopPropagation(); hideContextMenu(); item.onClick(); });
    menu.appendChild(button);
  }
  menu.classList.remove('hidden');
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
}
function dangerConfirmMenu(x, y, confirmLabel, onConfirm) {
  showContextMenu(x, y, [
    { label: confirmLabel, danger: true, onClick: onConfirm },
    { label: 'Cancel', onClick: hideContextMenu },
  ]);
}
function flashStatus(message) {
  setRunStatus(message);
  setTimeout(() => { if (!state.running) setRunStatus(readyLabel()); }, 2600);
}
function setRunStatus(message, kind = '') {
  statusbar.textContent = message || '';
  statusbar.classList.toggle('running', kind === 'running');
  statusbar.classList.toggle('error', kind === 'error');
  updateSendButton();
}
function formatUsage(usage) {
  if (!usage) return '';
  const total = (usage.input_tokens || 0) + (usage.output_tokens || 0);
  return total > 0 ? '~' + total.toLocaleString() + ' tokens last turn' : '';
}
function readyLabel() {
  return 'Ready' + (state.lastUsageText ? ' - ' + state.lastUsageText : '');
}
function finalizeAssistant() {
  if (state.currentAssistant && state.currentAssistant.dataset.raw) {
    renderMarkdownInto(state.currentAssistant, state.currentAssistant.dataset.raw);
    scrollTranscript();
  }
}
function displayUserText(text) {
  const value = String(text || '');
  return value.length > 1800 ? value.slice(0, 1800) + '\\n\\n[message truncated in UI; full prompt was sent]' : value;
}
function addMessage(kind, text) {
  const node = document.createElement('div');
  node.className = 'message ' + kind;
  node.textContent = text || '';
  transcript.appendChild(node);
  scrollTranscript();
  return node;
}
function addResult(event) {
  const box = document.createElement('div');
  box.className = 'result';
  const title = document.createElement('h3');
  title.textContent = event.title || 'Result';
  box.appendChild(title);
  if (event.text) {
    const pre = document.createElement('pre');
    pre.textContent = event.text;
    box.appendChild(pre);
  }
  for (const item of event.items || []) {
    const row = document.createElement('div');
    row.className = 'row';
    row.textContent = item.label || '';
    const small = document.createElement('small');
    small.textContent = [item.description, item.detail].filter(Boolean).join(' - ');
    if (small.textContent) row.appendChild(small);
    box.appendChild(row);
  }
  transcript.appendChild(box);
  scrollTranscript();
}
function summarizeToolInput(inputValue) {
  if (inputValue == null) return '';
  try {
    const text = typeof inputValue === 'string' ? inputValue : JSON.stringify(inputValue, null, 2);
    return text.length > 900 ? text.slice(0, 900) + '\\n...' : text;
  } catch {
    return String(inputValue);
  }
}
function formatDuration(ms) {
  if (typeof ms !== 'number') return '';
  return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
}
function addToolActivity(event) {
  const id = event.id || ('tool-' + Date.now() + '-' + Math.random());
  const card = document.createElement('article');
  card.className = 'tool-card running';
  card.dataset.toolId = id;
  const header = document.createElement('header');
  const spinner = document.createElement('span');
  spinner.className = 'tool-spinner';
  const labels = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = event.name || 'Tool';
  const status = document.createElement('small');
  status.textContent = 'Calling tool';
  labels.append(title, status);
  header.append(spinner, labels);
  const pre = document.createElement('pre');
  pre.textContent = summarizeToolInput(event.input);
  if (!pre.textContent) pre.classList.add('hidden');
  card.append(header, pre);
  transcript.appendChild(card);
  state.toolNodes.set(id, { card, status, pre });
  setRunStatus('Calling ' + (event.name || 'tool') + '...', 'running');
  scrollTranscript();
}
function updateToolProgress(event) {
  const node = state.toolNodes.get(event.id);
  if (!node) return;
  const progress = event.data && typeof event.data === 'object'
    ? Object.entries(event.data).map(([key, value]) => key + ': ' + String(value)).slice(0, 3).join(' - ')
    : String(event.data || '');
  node.status.textContent = progress || 'Tool is working';
}
function updateToolActivity(event) {
  const id = event.id || ('tool-result-' + Date.now() + '-' + Math.random());
  let node = state.toolNodes.get(id);
  if (!node) {
    addToolActivity({ ...event, id });
    node = state.toolNodes.get(id);
    if (!node) return;
  }
  node.card.classList.remove('running');
  node.card.classList.add(event.ok ? 'success' : 'error');
  node.status.textContent = (event.ok ? 'Completed' : 'Failed') + (event.durationMs ? ' in ' + formatDuration(event.durationMs) : '');
  const output = String(event.text || '').trim();
  if (output) {
    node.pre.classList.remove('hidden');
    node.pre.textContent = output.length > 1400 ? output.slice(0, 1400) + '\\n...' : output;
  }
  setRunStatus((event.ok ? 'Completed ' : 'Failed ') + (event.name || 'tool'), event.ok ? '' : 'error');
  scrollTranscript();
}
function makeListButton(label, detail) {
  const button = document.createElement('button');
  const strong = document.createElement('strong');
  strong.textContent = label || '';
  button.appendChild(strong);
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    button.appendChild(small);
  }
  return button;
}
function describeParts(parts) {
  return parts.filter(Boolean).map(value => String(value)).join(' - ');
}
function renderSelectOptions(id, items, value, emptyLabel) {
  const select = el(id);
  select.textContent = '';
  if (emptyLabel) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyLabel;
    select.appendChild(option);
  }
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  }
  select.value = value || '';
}
function addSettingsCard(root, title, description, detail, actions = []) {
  const card = document.createElement('article');
  card.className = 'settings-card';
  const strong = document.createElement('strong');
  strong.textContent = title || '(unnamed)';
  card.appendChild(strong);
  if (description || detail) {
    const p = document.createElement('p');
    p.textContent = describeParts([description, detail]);
    card.appendChild(p);
  }
  if (actions.length > 0) {
    const footer = document.createElement('footer');
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.disabled = Boolean(action.disabled);
      button.addEventListener('click', action.handler);
      footer.appendChild(button);
    }
    card.appendChild(footer);
  }
  root.appendChild(card);
}
function renderSettingsCardList(id, items, renderItem) {
  const root = el(id);
  root.textContent = '';
  if (!items || items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Nothing configured.';
    root.appendChild(empty);
    return;
  }
  items.forEach(item => renderItem(root, item));
}
async function runSettingsCommand(command, status = 'Running command...') {
  el('settingsStatus').textContent = status;
  await submitText(command);
  if (!el('settingsModal').classList.contains('hidden')) {
    await loadState();
    renderSettingsCommandPanels();
    el('settingsStatus').textContent = 'Applied';
  }
}
function renderSettingsCommandPanels() {
  const snapshot = state.snapshot || {};
  const session = snapshot.session || {};
  const settings = snapshot.settings || {};
  el('settingsCurrentRun').textContent = describeParts([
    'Permission: ' + (snapshot.permissionMode || 'unknown'),
    'Effort: ' + (snapshot.effort || 'auto'),
    'Router: ' + (snapshot.activeRouterName || 'off'),
    'Team: ' + (snapshot.activeTeamName || 'none'),
  ]);
  el('settingsCurrentModel').textContent = session.model || settings.defaultModel || 'default';
  setField('settingsRuntimeModel', session.model || settings.defaultModel || '');
  setField('settingsRuntimeEffort', snapshot.effort || 'auto');
  const routers = snapshot.routers || [];
  renderSelectOptions(
    'settingsRouterSelect',
    routers.map(router => ({ value: router.name, label: router.name })),
    snapshot.activeRouterName || '',
    'Fixed model',
  );
  renderSettingsCardList('settingsRoutersList', routers, (root, router) => {
    addSettingsCard(root, router.name, router.profile?.routes ? router.profile.routes.length + ' routes' : '', router.source, [
      { label: router.name === snapshot.activeRouterName ? 'Active' : 'Use', disabled: router.name === snapshot.activeRouterName, handler: () => runSettingsCommand('/model router ' + router.name, 'Applying router...') },
    ]);
  });
  renderSettingsCardList('settingsToolsList', (snapshot.tools || []).slice(0, 40), (root, tool) => {
    addSettingsCard(root, tool.name, describeParts([tool.category, tool.provider, tool.readOnly ? 'read-only' : '']), tool.description);
  });
  renderSettingsCardList('settingsSkillsList', (snapshot.skills || []).slice(0, 40), (root, skill) => {
    addSettingsCard(root, skill.displayName ? skill.displayName + ' (' + skill.name + ')' : skill.name, describeParts([skill.source, skill.context, skill.version ? 'v' + skill.version : '']), skill.description || skill.whenToUse);
  });
  renderSettingsCardList('settingsAgentsList', snapshot.agents || [], (root, agent) => {
    addSettingsCard(root, agent.name, agent.model || 'inherits model', agent.description);
  });
  renderSettingsCardList('settingsPluginsList', snapshot.plugins || [], (root, plugin) => {
    addSettingsCard(root, plugin.name, describeParts([plugin.version, Array.isArray(plugin.capabilities) ? plugin.capabilities.join(', ') : '']), plugin.path);
  });
  renderSettingsCardList('settingsMcpList', (snapshot.tools || []).filter(tool => tool.provider === 'mcp'), (root, tool) => {
    addSettingsCard(root, tool.name, tool.server || 'mcp', tool.description);
  });
  renderSettingsCardList('settingsWorkflowsList', snapshot.workflows || [], (root, workflow) => {
    addSettingsCard(root, workflow.name, workflow.description, workflow.source, [
      { label: 'Run', handler: () => {
        const task = el('settingsWorkflowInput').value.trim();
        return runSettingsCommand('/workflows run ' + workflow.name + (task ? ' ' + task : ''), 'Running workflow...');
      } },
    ]);
  });
  const builtInTeams = ['panel-analysis', 'analysis', 'reviewer'].map(name => ({ name, source: 'built-in', definition: { mode: 'built-in', members: [] } }));
  const savedTeamNames = new Set((snapshot.teams || []).map(team => team.name));
  const teams = [...(snapshot.teams || []), ...builtInTeams.filter(team => !savedTeamNames.has(team.name))];
  renderSettingsCardList('settingsTeamsList', teams, (root, team) => {
    addSettingsCard(root, team.name, describeParts([team.definition?.mode, team.definition?.members ? team.definition.members.length + ' members' : '', team.source]), '', [
      { label: team.name === snapshot.activeTeamName ? 'Active' : 'Attach', disabled: team.name === snapshot.activeTeamName, handler: () => runSettingsCommand('/team attach ' + team.name, 'Attaching team...') },
    ]);
  });
  el('settingsSessionSummary').textContent = describeParts([
    'Current: ' + (session.title || session.id || 'new chat'),
    (snapshot.sessions || []).length + ' visible chats',
  ]);
  renderSettingsCardList('settingsSessionsList', snapshot.sessions || [], (root, item) => {
    addSettingsCard(root, item.title || item.id, describeParts([item.model, item.status, (item.messageCount || 0) + ' messages']), item.id, [
      { label: item.id === session.id ? 'Current' : 'Resume', disabled: item.id === session.id, handler: () => runSettingsCommand('/resume ' + item.id, 'Resuming chat...') },
    ]);
  });
}
function renderProjects() {
  const root = el('projects');
  root.textContent = '';
  const projects = state.snapshot?.projects || [];
  const query = el('commandSearch').value.trim().toLowerCase();
  const visibleSessions = (state.snapshot?.sessions || []).filter(item => {
    const haystack = [item.id, item.title, item.model, item.status].filter(Boolean).join(' ').toLowerCase();
    return !query || haystack.includes(query);
  });
  const chats = document.createElement('div');
  chats.className = 'project-session-list current-project-chats';
  for (const item of visibleSessions.slice(0, state.sessionsLimit)) {
    const chat = makeListButton(item.title || item.id, [item.model, item.status, (item.messageCount || 0) + ' messages'].filter(Boolean).join(' - '));
    chat.classList.add('project-chat-row');
    if (state.snapshot?.session?.id === item.id) chat.classList.add('active');
    chat.addEventListener('click', () => resumeSession(item.id));
    chat.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const cx = event.clientX;
      const cy = event.clientY;
      showContextMenu(cx, cy, [
        { label: 'Archive chat', onClick: () => archiveChat(item.id) },
        { label: 'Delete chat', danger: true, onClick: () => dangerConfirmMenu(cx, cy, 'Confirm delete chat', () => deleteChat(item.id)) },
      ]);
    });
    chats.appendChild(chat);
  }
  if (visibleSessions.length > state.sessionsLimit) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'project-chat-more';
    more.textContent = 'Show more chats';
    more.addEventListener('click', () => {
      state.sessionsLimit += 16;
      renderProjects();
    });
    chats.appendChild(more);
  }
  if (visibleSessions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = query ? 'No matching chats in this workspace.' : 'No chats in this workspace.';
    chats.appendChild(empty);
  }
  root.appendChild(chats);
  const active = projects.find(project => project.active);
  const activeChats = active?.sessionCount ?? visibleSessions.filter(item => item.messageCount > 0).length;
  el('workspaceMeta').textContent = activeChats + ' chats here';
}
function renderWorkspaceChoices() {
  const root = el('workspaceChoices');
  root.textContent = '';
  const projects = state.snapshot?.projects || [];
  for (const project of projects) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-choice';
    if (project.active) button.classList.add('active');
    const label = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = project.name || project.path;
    const detail = document.createElement('small');
    detail.textContent = project.path;
    label.append(title, detail);
    const count = document.createElement('span');
    count.className = 'workspace-count';
    count.textContent = project.active ? 'Current' : (project.sessionCount || 0) + ' chats';
    button.append(label, count);
    button.addEventListener('click', async () => {
      if (project.active) {
        el('workspacePathInput').value = project.path;
        return;
      }
      el('workspaceStatus').textContent = 'Switching workspace...';
      const ok = await switchProject(project.path);
      el('workspaceStatus').textContent = ok ? '' : 'Could not open this workspace.';
      if (ok) closeWorkspaceDialog();
    });
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (project.active) return;
      const cx = event.clientX;
      const cy = event.clientY;
      showContextMenu(cx, cy, [
        { label: 'Forget workspace', danger: true, onClick: () => dangerConfirmMenu(cx, cy, 'Confirm forget workspace', () => forgetWorkspace(project.path)) },
      ]);
    });
    root.appendChild(button);
  }
  if (projects.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No saved workspaces yet.';
    root.appendChild(empty);
  }
}
function permissionSelectValue(mode) {
  if (mode === 'bypassPermissions') return 'full';
  if (mode === 'acceptEdits') return 'workspace';
  return 'read-only';
}
async function hydrateTranscript() {
  let data;
  try {
    const res = await api('/api/session/messages');
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  transcript.textContent = '';
  state.toolNodes.clear();
  state.currentAssistant = null;
  for (const entry of (data.messages || [])) {
    if (entry.type === 'user') {
      addMessage('user', displayUserText(entry.text));
    } else if (entry.type === 'assistant') {
      const node = addMessage('assistant', '');
      node.dataset.raw = entry.text || '';
      renderMarkdownInto(node, entry.text || '');
    } else if (entry.type === 'tool') {
      const id = 'hist-' + Math.random().toString(36).slice(2);
      addToolActivity({ id, name: entry.name, input: entry.input });
      updateToolActivity({ id, name: entry.name, ok: entry.ok, text: entry.text });
    }
  }
  setRunStatus(state.running ? 'Running' : readyLabel(), state.running ? 'running' : '');
  scrollTranscript();
}
async function loadState() {
  const res = await api('/api/state');
  state.snapshot = await res.json();
  applyPreferences(state.snapshot.settings?.preferences);
  const workDir = state.snapshot.workDir || '';
  const parts = workDir.split(/[\\\\/]/).filter(Boolean);
  el('projectName').textContent = parts[parts.length - 1] || 'workspace';
  el('projectPath').textContent = workDir;
  el('sessionTitle').textContent = state.snapshot.session?.title || 'Actoviq GUI';
  el('workspace').textContent = workDir + ' - ' + state.snapshot.session.model + ' - ' + state.snapshot.permissionMode + ' - effort:' + state.snapshot.effort + ' - team:' + (state.snapshot.activeTeamName || 'none');
  state.running = Boolean(state.snapshot.running);
  setRunStatus(state.running ? 'Running' : readyLabel(), state.running ? 'running' : '');
  el('permissionSelect').value = permissionSelectValue(state.snapshot.permissionMode);
  renderProjects();
  renderStatusExtras();
  if (state.activeSurface) renderSurface(state.activeSurface);
  if (!el('workspaceModal').classList.contains('hidden')) renderWorkspaceChoices();
  if (!el('settingsModal').classList.contains('hidden')) renderSettingsCommandPanels();
}
function renderStatusExtras() {
  const snap = state.snapshot || {};
  const bar = el('contextBar');
  bar.textContent = '';
  const addBadge = (cls, text, title) => {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    if (title) span.title = title;
    bar.appendChild(span);
  };
  const goal = snap.goal;
  if (goal && goal.objective) {
    const mark = goal.status === 'active' ? '▶' : goal.status === 'paused' ? '‖' : '✓';
    addBadge('ctx-goal ctx-' + (goal.status || 'active'), mark + ' ' + goal.objective, 'Goal: ' + goal.objective + ' (' + goal.status + ')');
  }
  const bs = snap.bridgeState || {};
  if (bs.mode && bs.activeConfig) addBadge('ctx-bridge', '⇄ ' + bs.activeConfig.name, 'Bridge active: ' + bs.activeConfig.name);
  if (snap.planMode) addBadge('ctx-plan', '◐ plan', 'Plan mode on — mutating tools blocked');
  const usage = snap.usage || {};
  const totalTok = Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0);
  if (totalTok > 0) {
    const cost = usage.costUsd == null ? '' : ' · $' + Number(usage.costUsd).toFixed(4);
    addBadge('ctx-usage', totalTok.toLocaleString() + ' tok' + cost, 'Session usage (/cost for detail)');
  }
  bar.classList.toggle('hidden', bar.children.length === 0);
  const todos = snap.todos || [];
  const panel = el('todosPanel');
  if (todos.length === 0) {
    panel.classList.add('hidden');
  } else {
    panel.classList.remove('hidden');
    const done = todos.filter(t => t.status === 'completed').length;
    el('todosSummary').textContent = 'Todos (' + done + '/' + todos.length + ')';
    const list = el('todosList');
    list.textContent = '';
    for (const t of todos) {
      const li = document.createElement('li');
      li.className = 'todo-' + (t.status || 'pending');
      li.textContent = (t.status === 'completed' ? '✓ ' : t.status === 'in_progress' ? '▶ ' : '○ ') + (t.activeForm || t.subject || '');
      list.appendChild(li);
    }
  }
  el('outputStyleSelect').value = snap.outputStyle || 'default';
  renderModelPicker();
}
function renderModelPicker() {
  const items = el('modelPickerItems');
  items.textContent = '';
  const snap = state.snapshot;
  if (!snap) return;
  const bs = snap.bridgeState || {};
  const configs = bs.configs || [];
  const activeConfig = bs.activeConfig;
  const EFFORTS = ['auto','low','medium','high','max'];
  // Default entry (current session model, no bridge).
  const defItem = document.createElement('button');
  defItem.className = 'model-picker-item' + (!bs.mode ? ' selected' : '');
  defItem.type = 'button';
  defItem.innerHTML = '<span>Default</span><span class="model-picker-tags"><span>' + (snap.session?.model || 'default') + '</span></span>';
  defItem.addEventListener('click', () => { selectPickerModel(null, null, null); });
  items.appendChild(defItem);
  if (configs.length === 0) { el('modelPickerBtn').textContent = bs.mode ? (activeConfig?.name || 'Bridge') + ' ▾' : 'Auto ▾'; return; }
  for (const cfg of configs) {
    const cat = document.createElement('div');
    cat.className = 'model-picker-cat';
    cat.textContent = cfg.name + ' (' + cfg.provider + ')';
    items.appendChild(cat);
    const models = Array.isArray(cfg.models) && cfg.models.length > 0 ? cfg.models : [{ name: cfg.model || '(default)', modality: 'text' }];
    for (const m of models) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'model-picker-item';
      const isActive = activeConfig?.name === cfg.name && (!activeConfig.model || activeConfig.model === m.name);
      if (isActive) row.classList.add('selected');
      const tags = [m.context1M ? '1 M' : '', m.modality === 'multimodal' ? 'Vision' : ''].filter(Boolean);
      row.innerHTML = '<span>' + m.name + '</span>' + (tags.length ? '<span class="model-picker-tags">' + tags.map(t => '<span>' + t + '</span>').join('') + '</span>' : '');
      // Effort sub-picks for this model
      const effortRow = document.createElement('div');
      effortRow.className = 'model-picker-efforts';
      effortRow.style.cssText = 'margin-left:10px;margin-bottom:4px';
      for (const e of EFFORTS) {
        const eb = document.createElement('button');
        eb.type = 'button';
        eb.className = 'model-picker-effort';
        eb.textContent = e === 'auto' ? 'auto' : e;
        eb.addEventListener('click', (ev) => { ev.stopPropagation(); selectPickerModel(cfg.name, m.name, e); });
        effortRow.appendChild(eb);
      }
      row.addEventListener('click', () => { selectPickerModel(cfg.name, m.name, 'auto'); });
      items.appendChild(row);
      items.appendChild(effortRow);
    }
  }
  const btn = el('modelPickerBtn');
  if (bs.mode && activeConfig) {
    const mLabel = activeConfig.model || '(default)';
    btn.textContent = mLabel + ' ▾';
    btn.title = activeConfig.name + ' · ' + mLabel;
  } else {
    btn.textContent = 'Auto ▾';
    btn.title = 'Default model (no bridge)';
  }
}
async function selectPickerModel(configName, modelName, effort) {
  if (!configName) {
    // Default: disable bridge
    const res = await api('/api/bridge/off', { method: 'POST' });
    if (res.ok) { state.snapshot = await res.json(); }
  } else {
    // Update the config's selected model if different from stored.
    const cfg = (state.snapshot?.bridgeState?.configs || []).find(c => c.name === configName);
    if (cfg && cfg.model !== modelName) {
      const res = await api('/api/bridge/config', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ name: configName, model: modelName || '' }) });
      if (res.ok) { state.snapshot = await res.json(); }
    }
    const actRes = await api('/api/bridge/activate', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ name: configName }) });
    if (actRes.ok) { state.snapshot = await actRes.json(); }
  }
  if (effort && effort !== 'auto') { submitText('/effort ' + effort); }
  else { loadState().catch(console.error); }
  el('modelPickerMenu').classList.add('hidden');
}
function toggleModelPicker() {
  const menu = el('modelPickerMenu');
  if (menu.classList.contains('hidden')) {
    renderModelPicker();
    menu.classList.remove('hidden');
  } else {
    menu.classList.add('hidden');
  }
}
async function resumeSession(id) {
  await api('/api/session/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  await loadState();
  await hydrateTranscript();
  closeSurface();
}
async function switchProject(projectPath) {
  if (!projectPath) return false;
  const res = await api('/api/project/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: projectPath }) });
  if (!res.ok) { addMessage('error', await res.text()); return false; }
  state.snapshot = await res.json();
  transcript.textContent = '';
  state.toolNodes.clear();
  state.sessionsLimit = 16;
  await loadState();
  await hydrateTranscript();
  closeSurface();
  return true;
}
async function addWorkspace() {
  el('workspacePathInput').value = '';
  el('workspaceStatus').textContent = '';
  renderWorkspaceChoices();
  el('workspaceModal').classList.remove('hidden');
  el('workspacePathInput').focus();
}
function closeWorkspaceDialog() {
  el('workspaceModal').classList.add('hidden');
}
async function submitWorkspace(event) {
  event.preventDefault();
  const projectPath = el('workspacePathInput').value.trim();
  if (!projectPath) {
    el('workspaceStatus').textContent = 'Enter a workspace path.';
    return;
  }
  el('workspaceStatus').textContent = 'Opening workspace...';
  const ok = await switchProject(projectPath);
  el('workspaceStatus').textContent = ok ? '' : 'Could not open this workspace.';
  if (ok) closeWorkspaceDialog();
}
async function createNewSession() {
  await api('/api/session/new', { method: 'POST' });
  transcript.textContent = '';
  state.toolNodes.clear();
  state.currentAssistant = null;
  await loadState();
}
async function openLocation() {
  const res = await api('/api/open-location', { method: 'POST' });
  if (!res.ok) addMessage('error', await res.text());
}
function commandNeedsSpace(name) {
  return ['model','effort','permissions','resume','dream','workflows','worktree','team','goal','batch','plan','output-style','rewind','export','review','bridge'].includes(name);
}
function slashMatches() {
  const value = input.value.trim();
  if (!value.startsWith('/') || value.includes(' ')) return [];
  const query = value.slice(1).toLowerCase();
  return Object.entries(state.snapshot?.commands || {})
    .map(([name, description]) => ({ name, description }))
    .filter(item => item.name.startsWith(query))
    .slice(0, 10);
}
function renderSlashMenu() {
  const menu = el('slashMenu');
  const matches = slashMatches();
  menu.textContent = '';
  if (matches.length === 0) {
    menu.classList.add('hidden');
    return;
  }
  state.slashIndex = Math.max(0, Math.min(state.slashIndex, matches.length - 1));
  for (const [index, item] of matches.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    if (index === state.slashIndex) button.classList.add('active');
    const strong = document.createElement('strong');
    strong.textContent = '/' + item.name;
    const small = document.createElement('small');
    small.textContent = item.description;
    button.append(strong, small);
    button.addEventListener('click', () => completeSlash(item.name));
    menu.appendChild(button);
  }
  menu.classList.remove('hidden');
}
function completeSlash(name) {
  input.value = '/' + name + (commandNeedsSpace(name) ? ' ' : '');
  el('slashMenu').classList.add('hidden');
  input.focus();
}
function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function renderAttachments() {
  const tray = el('attachmentTray');
  tray.textContent = '';
  if (state.attachments.length === 0) {
    tray.classList.add('hidden');
    return;
  }
  for (const attachment of state.attachments) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    const label = document.createElement('small');
    label.textContent = attachment.name + ' - ' + formatFileSize(attachment.size);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'x';
    remove.addEventListener('click', () => {
      state.attachments = state.attachments.filter(item => item.id !== attachment.id);
      renderAttachments();
    });
    chip.append(label, remove);
    tray.appendChild(chip);
  }
  tray.classList.remove('hidden');
}
async function addFileAttachment(file) {
  const maxInlineBytes = 512 * 1024;
  let text = '';
  let note = '';
  const localPath = typeof file.path === 'string' ? file.path : '';
  if (file.size <= maxInlineBytes) {
    try {
      text = await file.text();
      if (text.length > 120000) {
        text = text.slice(0, 120000);
        note = 'Content truncated for prompt size.';
      }
    } catch {
      note = 'Could not read file content in the renderer.';
    }
  } else {
    note = 'File is larger than 512 KB; content was not inlined.';
  }
  state.attachments.push({
    id: 'att-' + (++state.attachmentCounter),
    name: file.name || 'file',
    size: file.size || 0,
    type: file.type || '',
    path: localPath,
    text,
    note,
  });
}
async function addFiles(files) {
  const list = Array.from(files || []).slice(0, 8);
  for (const file of list) await addFileAttachment(file);
  renderAttachments();
  if (list.length > 0) input.focus();
}
function clearAttachments() {
  state.attachments = [];
  renderAttachments();
}
function buildSubmissionText(text) {
  if (state.attachments.length === 0) return text;
  const lines = [text || 'Please review the attached file(s).', '', 'Attached files:'];
  for (const attachment of state.attachments) {
    lines.push('', '--- ' + attachment.name + ' ---');
    lines.push('Size: ' + formatFileSize(attachment.size));
    if (attachment.type) lines.push('Type: ' + attachment.type);
    if (attachment.path) lines.push('Local path: ' + attachment.path);
    if (attachment.note) lines.push('Note: ' + attachment.note);
    if (attachment.text) lines.push('Content:', attachment.text);
  }
  return lines.join('\\n');
}
function renderQueue() {
  const root = el('queueList');
  root.textContent = '';
  if (state.queue.length === 0) {
    root.classList.add('hidden');
    return;
  }
  for (const [index, text] of state.queue.entries()) {
    const row = document.createElement('div');
    row.className = 'queue-item';
    const label = document.createElement('small');
    label.textContent = 'Queued #' + (index + 1) + ': ' + text;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'remove';
    remove.addEventListener('click', () => {
      state.queue.splice(index, 1);
      renderQueue();
    });
    row.append(label, remove);
    root.appendChild(row);
  }
  root.classList.remove('hidden');
}
function enqueueText(text) {
  state.queue.push(text);
  renderQueue();
  addMessage('notice', 'queued: ' + text);
}
async function submitText(text) {
  if (!text) return;
  if (state.running) {
    enqueueText(text);
    return;
  }
  await sendText(text);
}
async function processQueue() {
  if (state.running || state.queue.length === 0) return;
  const next = state.queue.shift();
  renderQueue();
  if (next) await sendText(next);
}
function closeSurface() {
  state.activeSurface = null;
  el('surfaceDrawer').classList.add('hidden');
}
function surfaceData(kind) {
  const snapshot = state.snapshot || {};
  if (kind === 'projects') return {
    title: 'Projects',
    subtitle: 'Switch workspaces and manage chats',
    items: snapshot.projects || [],
  };
  if (kind === 'sessions') return {
    title: 'Chats',
    subtitle: 'Browse and resume sessions',
    items: snapshot.sessions || [],
  };
  if (kind === 'workflows') return { title: 'Workflows', subtitle: 'Run saved workflow scripts', items: snapshot.workflows || [] };
  if (kind === 'plugins') return { title: 'Plugins', subtitle: 'Discovered Clean plugins', items: snapshot.plugins || [] };
  if (kind === 'tools') return { title: 'Tools', subtitle: 'Registered tools for this workspace', items: snapshot.tools || [] };
  if (kind === 'skills') return { title: 'Skills', subtitle: 'Available skills', items: snapshot.skills || [] };
  if (kind === 'agents') return { title: 'Subagents', subtitle: 'Available agent definitions', items: snapshot.agents || [] };
  if (kind === 'mcp') return { title: 'MCP servers', subtitle: 'MCP-provided tools', items: (snapshot.tools || []).filter(tool => tool.provider === 'mcp') };
  if (kind === 'teams') return { title: 'Teams', subtitle: 'Attach a model team to the main agent', items: snapshot.teams || [] };
  if (kind === 'routers') return { title: 'Model routers', subtitle: 'Route turns by profile', items: snapshot.routers || [] };
  return { title: 'Panel', subtitle: '', items: [] };
}
function itemTitle(item, kind) {
  return item.name || item.title || item.id || item.path || item.label || '(unnamed)';
}
function itemDescription(item, kind) {
  if (kind === 'projects') return item.path + ' - ' + (item.sessionCount || 0) + ' chats';
  if (kind === 'sessions') return [item.model, item.status, item.messageCount + ' messages', item.preview].filter(Boolean).join(' - ');
  if (kind === 'workflows') return [item.description, item.source].filter(Boolean).join(' - ');
  if (kind === 'tools') return [item.category, item.provider, item.readOnly ? 'read-only' : '', item.description].filter(Boolean).join(' - ');
  if (kind === 'teams') return [item.definition?.mode, item.source].filter(Boolean).join(' - ');
  if (kind === 'routers') return [item.profile?.routes ? item.profile.routes.length + ' routes' : '', item.source].filter(Boolean).join(' - ');
  return [item.description, item.detail, item.source, item.path].filter(Boolean).join(' - ');
}
function addSurfaceAction(label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', handler);
  el('surfaceActions').appendChild(button);
}
function renderSurface(kind) {
  const data = surfaceData(kind);
  state.activeSurface = kind;
  el('surfaceTitle').textContent = data.title;
  el('surfaceSubtitle').textContent = data.subtitle || '';
  el('surfaceActions').textContent = '';
  el('surfaceList').textContent = '';
  if (kind === 'projects') {
    addSurfaceAction('Add workspace', addWorkspace);
  }
  if (kind === 'teams') {
    addSurfaceAction('No team', () => submitText('/team off'));
  }
  if (kind === 'routers') {
    addSurfaceAction('Router off', () => submitText('/model router off'));
  }
  for (const item of data.items) {
    const card = document.createElement('article');
    card.className = 'surface-card';
    const strong = document.createElement('strong');
    strong.textContent = itemTitle(item, kind);
    const desc = document.createElement('p');
    desc.textContent = itemDescription(item, kind);
    const footer = document.createElement('footer');
    if (kind === 'projects') {
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = item.active ? 'Current' : 'Switch';
      open.disabled = Boolean(item.active);
      open.addEventListener('click', () => switchProject(item.path));
      footer.appendChild(open);
    } else if (kind === 'sessions') {
      const resume = document.createElement('button');
      resume.type = 'button';
      resume.textContent = item.id === state.snapshot?.session?.id ? 'Current' : 'Resume';
      resume.disabled = item.id === state.snapshot?.session?.id;
      resume.addEventListener('click', () => resumeSession(item.id));
      footer.appendChild(resume);
    } else if (kind === 'workflows') {
      const run = document.createElement('button');
      run.type = 'button';
      run.textContent = 'Run';
      run.addEventListener('click', () => {
        const task = window.prompt('Workflow input', '');
        submitText('/workflows run ' + item.name + (task && task.trim() ? ' ' + task.trim() : ''));
      });
      footer.appendChild(run);
    } else if (kind === 'teams') {
      const attach = document.createElement('button');
      attach.type = 'button';
      attach.textContent = 'Attach';
      attach.addEventListener('click', () => submitText('/team attach ' + item.name));
      footer.appendChild(attach);
    } else if (kind === 'routers') {
      const select = document.createElement('button');
      select.type = 'button';
      select.textContent = 'Use router';
      select.addEventListener('click', () => submitText('/model router ' + item.name));
      footer.appendChild(select);
    }
    card.append(strong, desc, footer);
    el('surfaceList').appendChild(card);
  }
  if (data.items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Nothing to show.';
    el('surfaceList').appendChild(empty);
  }
  el('surfaceDrawer').classList.remove('hidden');
}
async function openSurface(kind) {
  await loadState();
  renderSurface(kind);
}
async function gitData() {
  try {
    const res = await api('/api/git');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
function gitSection(title) {
  const card = document.createElement('article');
  card.className = 'surface-card git-section';
  const heading = document.createElement('h3');
  heading.textContent = title;
  card.appendChild(heading);
  return card;
}
async function openGitSurface() {
  hideContextMenu();
  const data = await gitData();
  state.activeSurface = null;
  el('surfaceTitle').textContent = 'Git';
  el('surfaceActions').textContent = '';
  el('surfaceList').textContent = '';
  if (!data || !data.isRepo) {
    el('surfaceSubtitle').textContent = data ? 'Not a git repository' : 'Git unavailable';
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = data ? 'This workspace is not a git repository.' : 'Could not read git information.';
    el('surfaceList').appendChild(note);
    el('surfaceDrawer').classList.remove('hidden');
    return;
  }
  const tracking = (data.ahead ? ' ↑' + data.ahead : '') + (data.behind ? ' ↓' + data.behind : '');
  el('surfaceSubtitle').textContent = 'On ' + data.branch + (data.upstream ? ' → ' + data.upstream : '') + tracking;

  const status = data.status || [];
  const changes = gitSection('Changes (' + status.length + ')');
  if (status.length === 0) {
    const clean = document.createElement('p');
    clean.className = 'muted';
    clean.textContent = 'Working tree clean.';
    changes.appendChild(clean);
  } else {
    for (const entry of status) {
      const row = document.createElement('div');
      row.className = 'git-row';
      const code = (entry.x || '') + (entry.y || '');
      const stat = document.createElement('span');
      stat.className = 'git-stat' + (code.indexOf('D') !== -1 ? ' del' : '');
      stat.textContent = code || '•';
      const file = document.createElement('span');
      file.className = 'git-mono';
      file.textContent = entry.file;
      row.append(stat, file);
      changes.appendChild(row);
    }
  }
  el('surfaceList').appendChild(changes);

  const branchList = data.branches || [];
  const branches = gitSection('Branches (' + branchList.length + ')');
  for (const branch of branchList) {
    const row = document.createElement('div');
    row.className = 'git-row';
    const name = document.createElement('span');
    if (branch.current) name.className = 'git-current';
    name.textContent = (branch.current ? '● ' : '') + branch.name;
    row.appendChild(name);
    branches.appendChild(row);
  }
  el('surfaceList').appendChild(branches);

  const commitList = data.commits || [];
  const commits = gitSection('Recent commits');
  for (const commit of commitList) {
    const row = document.createElement('div');
    row.className = 'git-row';
    const hash = document.createElement('span');
    hash.className = 'git-hash';
    hash.textContent = commit.hash;
    const subject = document.createElement('span');
    subject.textContent = commit.subject;
    const meta = document.createElement('span');
    meta.className = 'git-meta';
    meta.textContent = commit.date + (commit.author ? ' · ' + commit.author : '');
    row.append(hash, subject, meta);
    commits.appendChild(row);
  }
  if (commitList.length === 0) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'No commits.';
    commits.appendChild(note);
  }
  el('surfaceList').appendChild(commits);
  el('surfaceDrawer').classList.remove('hidden');
}
async function refreshGitSettingsSummary() {
  const target = el('settingsGitSummary');
  if (!target) return;
  const data = await gitData();
  if (!data || !data.isRepo) {
    target.textContent = data ? 'Not a git repository.' : 'Git information unavailable.';
    return;
  }
  const changed = (data.status || []).length;
  const tracking = (data.ahead ? ' · ↑' + data.ahead : '') + (data.behind ? ' · ↓' + data.behind : '');
  target.textContent = 'On branch ' + data.branch + ' · ' + changed + ' changed file' + (changed === 1 ? '' : 's') + tracking;
}
async function deleteChat(id) {
  const wasActive = state.snapshot?.session?.id === id;
  const res = await api('/api/session/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  if (!res.ok) { flashStatus('Could not delete chat'); return; }
  await loadState();
  if (wasActive) {
    transcript.textContent = '';
    state.toolNodes.clear();
    state.currentAssistant = null;
    await hydrateTranscript();
  }
  flashStatus('Chat deleted');
}
async function archiveChat(id) {
  const wasActive = state.snapshot?.session?.id === id;
  const res = await api('/api/session/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  if (!res.ok) { flashStatus('Could not archive chat'); return; }
  await loadState();
  if (wasActive) {
    transcript.textContent = '';
    state.toolNodes.clear();
    state.currentAssistant = null;
    await hydrateTranscript();
  }
  flashStatus('Chat archived — restore from Settings → Chats → Archived');
}
async function unarchiveChat(id) {
  const res = await api('/api/session/unarchive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  if (!res.ok) { flashStatus('Could not restore chat'); return; }
  await loadState();
  renderArchived();
  flashStatus('Chat restored');
}
async function loadArchived() {
  try {
    const res = await api('/api/sessions/archived');
    if (!res.ok) return [];
    const data = await res.json();
    return (data && data.sessions) || [];
  } catch { return []; }
}
async function renderArchived() {
  const root = el('settingsArchivedList');
  if (!root || root.closest('.settings-panel.active') !== root.closest('[data-settings-panel="sessions"]')) return;
  const sessions = await loadArchived();
  root.textContent = '';
  if (sessions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No archived chats.';
    root.appendChild(empty);
    return;
  }
  for (const item of sessions) {
    const card = document.createElement('article');
    card.className = 'settings-card';
    const strong = document.createElement('strong');
    strong.textContent = item.title || item.id;
    card.appendChild(strong);
    const p = document.createElement('p');
    p.textContent = [item.model, (item.messageCount || 0) + ' messages', item.workDir].filter(Boolean).join(' · ');
    card.appendChild(p);
    const footer = document.createElement('footer');
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.textContent = 'Restore';
    restore.addEventListener('click', () => unarchiveChat(item.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      if (confirm('Permanently delete this archived chat?')) deleteChat(item.id).then(renderArchived);
    });
    footer.append(restore, del);
    card.appendChild(footer);
    root.appendChild(card);
  }
}
async function forgetWorkspace(projectPath) {
  const res = await api('/api/project/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: projectPath }) });
  if (!res.ok) { flashStatus('Could not forget workspace'); return; }
  const payload = await res.json();
  if (payload && payload.error) { flashStatus(payload.error); return; }
  await loadState();
  if (!el('workspaceModal').classList.contains('hidden')) renderWorkspaceChoices();
  flashStatus('Workspace forgotten' + (payload.deleted ? ' (' + payload.deleted + ' chats removed)' : ''));
}
async function sendText(text) {
  state.running = true;
  setRunStatus('Running', 'running');
  const res = await api('/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!res.ok || !res.body) {
    addMessage('error', await res.text());
    state.running = false;
    setRunStatus(readyLabel());
    await processQueue();
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) handleEvent(JSON.parse(line));
      }
      if (done) break;
    }
  } finally {
    state.running = false;
    setRunStatus(readyLabel());
    await processQueue();
  }
}
function handleEvent(event) {
  if (event.type === 'user') { finalizeAssistant(); state.currentAssistant = null; addMessage('user', displayUserText(event.text)); }
  else if (event.type === 'delta') {
    if (!state.currentAssistant) { state.currentAssistant = addMessage('assistant', ''); state.currentAssistant.dataset.raw = ''; }
    state.currentAssistant.dataset.raw += event.text || '';
    state.currentAssistant.textContent = state.currentAssistant.dataset.raw;
    scrollTranscript();
  } else if (event.type === 'status') setRunStatus(event.message || 'Running', 'running');
  else if (event.type === 'notice') addMessage('notice', event.message || '');
  else if (event.type === 'tool.call') { finalizeAssistant(); state.currentAssistant = null; addToolActivity(event); }
  else if (event.type === 'tool.progress') updateToolProgress(event);
  else if (event.type === 'tool.result') updateToolActivity(event);
  else if (event.type === 'command.result') addResult(event);
  else if (event.type === 'clear') { transcript.textContent = ''; state.toolNodes.clear(); state.currentAssistant = null; }
  else if (event.type === 'permission.request') showPermission(event);
  else if (event.type === 'agent.prompt') { if (event.text) { state.queue.push(String(event.text)); renderQueue(); } }
  else if (event.type === 'batch.queue') {
    const prompts = Array.isArray(event.prompts) ? event.prompts : [];
    prompts.forEach(p => state.queue.push(String(p || '')));
    renderQueue();
    addMessage('notice', 'batch: queued ' + prompts.length + ' prompts — running in sequence');
  }
  else if (event.type === 'settings.open') void openSettings(event.tab || 'env').catch(console.error);
  else if (event.type === 'state') { if (event.state) state.snapshot = event.state; loadState().catch(console.error); }
  else if (event.type === 'done') { finalizeAssistant(); state.currentAssistant = null; state.running = false; if (event.usage) state.lastUsageText = formatUsage(event.usage); setRunStatus(readyLabel()); void processQueue(); }
  else if (event.type === 'error') { finalizeAssistant(); state.currentAssistant = null; setRunStatus(event.message || 'Error', 'error'); addMessage('error', event.message || 'Error'); }
}
function showPermission(event) {
  state.permissionQueue.push(event);
  if (state.pendingPermissionId == null) showNextPermission();
}
function showNextPermission() {
  const next = state.permissionQueue.shift();
  if (!next) {
    state.pendingPermissionId = null;
    el('permissionModal').classList.add('hidden');
    return;
  }
  state.pendingPermissionId = next.id;
  el('permissionTool').textContent = next.toolName || '';
  el('permissionSummary').textContent = next.summary || '(no arguments)';
  el('permissionModal').classList.remove('hidden');
}
function setField(id, value) { el(id).value = value == null ? '' : String(value); }
function setChecked(id, value) { el(id).checked = Boolean(value); }
async function refreshBridgeDetect() {
  const el = document.getElementById('bridgeDetected');
  if (!el) return;
  el.innerHTML = '<span class="muted">Detecting...</span>';
  try {
    const res = await api('/api/bridge/detect');
    const data = await res.json();
    const providers = data.providers || [];
    let html = '';
    for (const p of providers) {
      const mark = p.available ? '✔' : '✘';
      const ver = p.version ? ' v' + p.version : '';
      const path = p.path ? ' · ' + p.path : '';
      html += \`<p class="bridge-provider"><strong>\${p.id}</strong> \${mark}\${ver}\${path}</p>\`;
    }
    el.innerHTML = html || '<p class="muted">No providers detected.</p>';
  } catch { el.innerHTML = '<p class="muted">Detection failed.</p>'; }
}
function renderBridgeConfigs() {
  const bs = (state.snapshot && state.snapshot.bridgeState) || {};
  const active = bs.activeConfig;
  const configs = bs.configs || [];
  el('bridgeActive').innerHTML = active
    ? \`<strong>\${active.name}</strong> · \${active.provider} · \${active.model || '(default model)'} · key \${active.apiKeyMasked}\${active.baseURL ? ' · ' + active.baseURL : ''}\`
    : 'No active bridge config — using the default provider.';
  const root = el('bridgeConfigsList');
  root.textContent = '';
  if (configs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No saved configs yet — add one above.';
    root.appendChild(empty);
    return;
  }
  for (const cfg of configs) {
    const isActive = active && active.name === cfg.name;
    const card = document.createElement('article');
    card.className = 'settings-card';
    const strong = document.createElement('strong');
    strong.textContent = cfg.name + (isActive ? ' ●' : '');
    card.appendChild(strong);
    const p = document.createElement('p');
    const modelCount = Array.isArray(cfg.models) ? cfg.models.length : 0;
    p.textContent = [cfg.provider, cfg.model || '(default model)', modelCount > 0 ? modelCount + ' models' : '', 'key ' + cfg.apiKeyMasked, cfg.baseURL].filter(Boolean).join(' · ');
    card.appendChild(p);
    const footer = document.createElement('footer');
    const actBtn = document.createElement('button');
    actBtn.type = 'button';
    actBtn.textContent = isActive ? 'Active' : 'Activate';
    actBtn.disabled = isActive;
    actBtn.addEventListener('click', () => activateBridgeConfig(cfg.name));
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
      setField('bridgeCfgName', cfg.name);
      setField('bridgeCfgProvider', cfg.provider);
      setField('bridgeCfgModel', cfg.model || '');
      setField('bridgeCfgApiKey', '');
      setField('bridgeCfgBaseUrl', cfg.baseURL || '');
      el('bridgeCfgClearKey').checked = false;
      draftBridgeModels = Array.isArray(cfg.models) ? cfg.models.map(m => ({name: m.name, context1M: m.context1M || false, modality: m.modality || 'text'})) : [];
      renderBridgeModels();
      el('bridgeCfgStatus').textContent = 'Editing "' + cfg.name + '" — leave API key blank to keep the saved key.';
    });
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = 'Remove';
    delBtn.addEventListener('click', () => deleteBridgeConfig(cfg.name));
    footer.append(actBtn, editBtn, delBtn);
    card.appendChild(footer);
    root.appendChild(card);
  }
}
let draftBridgeModels = [];
function renderBridgeModels() {
  const root = el('bridgeModelsList');
  root.textContent = '';
  if (draftBridgeModels.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No models added yet.';
    root.appendChild(p);
    return;
  }
  for (const [index, m] of draftBridgeModels.entries()) {
    const card = document.createElement('article');
    card.className = 'settings-card';
    card.style.cssText = 'display:flex;align-items:center;gap:10px;justify-content:space-between;padding:8px 12px';
    const info = document.createElement('span');
    const tags = [m.name, m.context1M ? '1 M ctx' : '', m.modality === 'multimodal' ? 'Multimodal' : 'Text'].filter(Boolean);
    info.textContent = tags.join(' · ');
    card.appendChild(info);
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Remove';
    del.addEventListener('click', () => { draftBridgeModels.splice(index, 1); renderBridgeModels(); });
    card.appendChild(del);
    root.appendChild(card);
  }
}
function addBridgeModel() {
  const name = el('bridgeNewModelName').value.trim();
  if (!name) return;
  const model = {
    name,
    context1M: el('bridgeNewModel1M').checked,
    modality: el('bridgeNewModelModality').value || 'text',
  };
  draftBridgeModels.push(model);
  el('bridgeNewModelName').value = '';
  el('bridgeNewModel1M').checked = false;
  el('bridgeNewModelModality').value = 'text';
  renderBridgeModels();
}
async function saveBridgeConfig() {
  const name = el('bridgeCfgName').value.trim();
  if (!name) { el('bridgeCfgStatus').textContent = 'Name is required.'; return; }
  const clearKey = el('bridgeCfgClearKey').checked;
  const body = {
    name,
    provider: el('bridgeCfgProvider').value || 'anthropic',
    apiKey: el('bridgeCfgApiKey').value,
    clearApiKey: clearKey,
    baseURL: el('bridgeCfgBaseUrl').value.trim(),
    model: el('bridgeCfgModel').value.trim(),
    models: draftBridgeModels.length > 0 ? draftBridgeModels : undefined,
  };
  el('bridgeCfgStatus').textContent = 'Saving...';
  const res = await api('/api/bridge/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { el('bridgeCfgStatus').textContent = 'Save failed: ' + (await res.text()); return; }
  state.snapshot = await res.json();
  el('bridgeCfgStatus').textContent = 'Saved "' + name + '"' + (clearKey ? ' (key cleared).' : '.');
  el('bridgeCfgName').value = '';
  el('bridgeCfgApiKey').value = '';
  el('bridgeCfgClearKey').checked = false;
  draftBridgeModels = [];
  renderBridgeModels();
  renderBridgeConfigs();
}
async function deleteBridgeConfig(name) {
  const res = await api('/api/bridge/config/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!res.ok) { addMessage('error', 'Remove failed'); return; }
  state.snapshot = await res.json();
  renderBridgeConfigs();
}
async function activateBridgeConfig(name) {
  const res = await api('/api/bridge/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!res.ok) { addMessage('error', 'Activation failed: ' + (await res.text())); return; }
  state.snapshot = await res.json();
  renderBridgeConfigs();
  addMessage('notice', 'bridge active: ' + name);
}
async function disableBridge() {
  const res = await api('/api/bridge/off', { method: 'POST' });
  if (!res.ok) { addMessage('error', 'Disable failed'); return; }
  state.snapshot = await res.json();
  renderBridgeConfigs();
  addMessage('notice', 'bridge off — using default provider');
}
function renderMcpServers() {
  const servers = (state.snapshot && state.snapshot.mcpServers) || [];
  const root = el('mcpServersList');
  root.textContent = '';
  if (servers.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No MCP servers configured.';
    root.appendChild(empty);
    return;
  }
  for (const s of servers) {
    const card = document.createElement('article');
    card.className = 'settings-card';
    const strong = document.createElement('strong');
    strong.textContent = s.name + ' · ' + (s.url ? 'http' : 'stdio');
    card.appendChild(strong);
    const p = document.createElement('p');
    p.textContent = s.command || s.url || '';
    card.appendChild(p);
    const footer = document.createElement('footer');
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Remove';
    del.addEventListener('click', () => removeMcpServerConfig(s.name));
    footer.appendChild(del);
    card.appendChild(footer);
    root.appendChild(card);
  }
}
async function addMcpServerConfig() {
  const name = el('mcpCfgName').value.trim();
  if (!name) { el('mcpCfgStatus').textContent = 'Name is required.'; return; }
  const type = el('mcpCfgType').value;
  const args = el('mcpCfgArgs').value.split(',').map(s => s.trim()).filter(Boolean);
  const body = { name, args };
  if (type === 'http') body.url = el('mcpCfgUrl').value.trim();
  else body.command = el('mcpCfgCommand').value.trim();
  el('mcpCfgStatus').textContent = 'Adding...';
  const res = await api('/api/mcp/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { el('mcpCfgStatus').textContent = 'Add failed: ' + (await res.text()); return; }
  state.snapshot = await res.json();
  el('mcpCfgStatus').textContent = 'Added "' + name + '".';
  ['mcpCfgName', 'mcpCfgCommand', 'mcpCfgUrl', 'mcpCfgArgs'].forEach(id => { el(id).value = ''; });
  renderMcpServers();
}
async function removeMcpServerConfig(name) {
  const res = await api('/api/mcp/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!res.ok) { addMessage('error', 'Remove failed'); return; }
  state.snapshot = await res.json();
  renderMcpServers();
}
function showSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(button => button.classList.toggle('active', button.dataset.settingsTab === tab));
  document.querySelectorAll('.settings-panel').forEach(panel => panel.classList.toggle('active', panel.dataset.settingsPanel === tab));
  if (tab === 'git') refreshGitSettingsSummary().catch(() => undefined);
  if (tab === 'bridge') { renderBridgeConfigs(); refreshBridgeDetect().catch(() => undefined); }
  if (tab === 'mcp') renderMcpServers();
  if (tab === 'sessions') renderArchived();
}
async function openSettings(tab = 'general') {
  if (!state.snapshot) {
    await loadState();
  }
  const settings = state.snapshot?.settings || {};
  const preferences = settings.preferences || {};
  el('settingsPath').textContent = settings.configPath ? 'Saved locally: ' + settings.configPath : 'Settings path unavailable';
  const mode = preferences.workMode === 'daily' ? 'daily' : 'coding';
  setChecked('settingsWorkModeCoding', mode === 'coding');
  setChecked('settingsWorkModeDaily', mode === 'daily');
  setField('settingsProvider', settings.provider || 'anthropic');
  setField('settingsDefaultModel', settings.defaultModel || '');
  setField('settingsApiKey', '');
  el('settingsApiKey').placeholder = settings.apiKeyConfigured ? 'Configured; leave blank to keep current key' : 'Paste API key';
  setChecked('settingsClearApiKey', false);
  setField('settingsBaseUrl', settings.baseURL || '');
  setField('settingsPermissionPreset', '');
  setChecked('settingsDefaultPermission', true);
  setChecked('settingsAutoAudit', state.snapshot?.permissionMode === 'acceptEdits');
  setChecked('settingsFullAccess', state.snapshot?.permissionMode === 'bypassPermissions');
  setField('settingsMinModel', settings.minModel || '');
  setField('settingsMediumModel', settings.mediumModel || '');
  setField('settingsMaxModel', settings.maxModel || '');
  setField('settingsEffort', '');
  setField('settingsTheme', preferences.theme || 'system');
  setField('settingsDensity', preferences.density || 'comfortable');
  setChecked('settingsEnterToSend', preferences.enterToSend);
  setChecked('settingsAutoScroll', preferences.autoScroll !== false);
  renderBridgeConfigs();
  renderMcpServers();
  el('settingsStatus').textContent = '';
  renderSettingsCommandPanels();
  el('settingsModal').classList.remove('hidden');
  showSettingsTab(tab);
}
function closeSettings() { el('settingsModal').classList.add('hidden'); }
function derivePermissionPreset() {
  if (el('settingsPermissionPreset').value) return el('settingsPermissionPreset').value;
  if (el('settingsFullAccess').checked) return 'full';
  if (el('settingsAutoAudit').checked) return 'workspace';
  if (el('settingsDefaultPermission').checked) return 'workspace';
  return '';
}
async function saveSettings(event) {
  event.preventDefault();
  el('settingsStatus').textContent = 'Saving...';
  const workMode = document.querySelector('input[name="settingsWorkMode"]:checked')?.value || 'coding';
  const body = {
    provider: el('settingsProvider').value,
    defaultModel: el('settingsDefaultModel').value,
    apiKey: el('settingsApiKey').value,
    clearApiKey: el('settingsClearApiKey').checked,
    baseURL: el('settingsBaseUrl').value,
    permissionPreset: derivePermissionPreset(),
    minModel: el('settingsMinModel').value,
    mediumModel: el('settingsMediumModel').value,
    maxModel: el('settingsMaxModel').value,
    effort: el('settingsEffort').value,
    preferences: {
      workMode,
      theme: el('settingsTheme').value,
      density: el('settingsDensity').value,
      enterToSend: el('settingsEnterToSend').checked,
      autoScroll: el('settingsAutoScroll').checked,
    },
  };
  const res = await api('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { el('settingsStatus').textContent = 'Save failed'; addMessage('error', await res.text()); return; }
  state.snapshot = await res.json();
  applyPreferences(state.snapshot.settings?.preferences);
  el('settingsStatus').textContent = state.snapshot.settingsApplyError ? 'Saved; restart may be required' : 'Saved';
  if (state.snapshot.settingsApplyError) addMessage('notice', 'Settings saved, but the active SDK could not reload: ' + state.snapshot.settingsApplyError);
  await loadState();
}
document.querySelectorAll('[data-decision]').forEach(button => {
  button.addEventListener('click', async () => {
    const id = state.pendingPermissionId;
    state.pendingPermissionId = null;
    if (id) await api('/api/permission', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, decision: button.dataset.decision }) });
    showNextPermission();
  });
});
document.querySelectorAll('.settings-tab').forEach(button => button.addEventListener('click', () => showSettingsTab(button.dataset.settingsTab)));
el('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.running) { await api('/api/abort', { method: 'POST' }); return; }
  const text = input.value.trim();
  if (!text && state.attachments.length === 0) return;
  const submission = buildSubmissionText(text);
  input.value = '';
  clearAttachments();
  renderSlashMenu();
  await submitText(submission);
});
input.addEventListener('keydown', (event) => {
  const matches = slashMatches();
  const menuVisible = !el('slashMenu').classList.contains('hidden');
  if (menuVisible && matches.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    state.slashIndex = event.key === 'ArrowDown'
      ? (state.slashIndex + 1) % matches.length
      : (state.slashIndex + matches.length - 1) % matches.length;
    renderSlashMenu();
    return;
  }
  if (menuVisible && matches.length > 0 && (event.key === 'Tab' || event.key === 'Enter')) {
    event.preventDefault();
    completeSlash(matches[state.slashIndex]?.name || matches[0].name);
    return;
  }
  if (event.key === 'Escape') {
    el('slashMenu').classList.add('hidden');
    return;
  }
  if (event.key !== 'Enter') return;
  if (state.preferences.enterToSend && !event.shiftKey) { event.preventDefault(); el('composer').requestSubmit(); }
  else if (!state.preferences.enterToSend && (event.ctrlKey || event.metaKey)) { event.preventDefault(); el('composer').requestSubmit(); }
});
input.addEventListener('input', () => {
  state.slashIndex = 0;
  renderSlashMenu();
});
el('fileUploadBtn').addEventListener('click', () => el('fileInput').click());
el('fileInput').addEventListener('change', async (event) => {
  await addFiles(event.target.files);
  event.target.value = '';
});
el('insertCommand').addEventListener('click', async () => {
  if (!state.snapshot?.commands) await loadState().catch(() => undefined);
  input.value = input.value || '/';
  input.focus();
  renderSlashMenu();
});
el('composer').addEventListener('dragover', (event) => {
  if (!event.dataTransfer || Array.from(event.dataTransfer.types || []).indexOf('Files') === -1) return;
  event.preventDefault();
  el('composer').classList.add('dragging');
  el('dropOverlay').classList.remove('hidden');
});
el('composer').addEventListener('dragleave', (event) => {
  if (el('composer').contains(event.relatedTarget)) return;
  el('composer').classList.remove('dragging');
  el('dropOverlay').classList.add('hidden');
});
el('composer').addEventListener('drop', async (event) => {
  if (!event.dataTransfer) return;
  event.preventDefault();
  el('composer').classList.remove('dragging');
  el('dropOverlay').classList.add('hidden');
  await addFiles(event.dataTransfer.files);
});
el('newSession').addEventListener('click', createNewSession);
el('searchNav').addEventListener('click', () => { openSurface('sessions').catch(console.error); });
el('pluginsNav').addEventListener('click', () => { openSurface('plugins').catch(console.error); });
el('automationNav').addEventListener('click', () => { openSurface('workflows').catch(console.error); });
el('gitBtn').addEventListener('click', () => { openGitSurface().catch(console.error); });
el('conversationMenu').addEventListener('click', () => { openSurface('sessions').catch(console.error); });
el('openLocationBtn').addEventListener('click', openLocation);
el('projectRoot').addEventListener('click', () => { openSurface('projects').catch(console.error); });
el('projectMenuBtn').addEventListener('click', () => { openSurface('projects').catch(console.error); });
el('newWorkspaceBtn').addEventListener('click', addWorkspace);
el('newProjectSessionBtn').addEventListener('click', createNewSession);
el('addProjectBtn').addEventListener('click', addWorkspace);
el('workspaceForm').addEventListener('submit', submitWorkspace);
el('cancelWorkspace').addEventListener('click', closeWorkspaceDialog);
el('workspaceModal').addEventListener('click', (event) => { if (event.target === el('workspaceModal')) closeWorkspaceDialog(); });
el('settingsOpenLocation').addEventListener('click', openLocation);
el('settingsApplyRuntimeModel').addEventListener('click', () => {
  const model = el('settingsRuntimeModel').value.trim();
  if (model) runSettingsCommand('/model ' + model, 'Switching model...').catch(console.error);
});
el('settingsResetRuntimeModel').addEventListener('click', () => { runSettingsCommand('/model default', 'Switching to default model...').catch(console.error); });
el('settingsApplyRuntimeEffort').addEventListener('click', () => { runSettingsCommand('/effort ' + el('settingsRuntimeEffort').value, 'Applying effort...').catch(console.error); });
el('settingsApplyRouter').addEventListener('click', () => {
  const router = el('settingsRouterSelect').value;
  if (router) runSettingsCommand('/model router ' + router, 'Applying router...').catch(console.error);
});
el('settingsDisableRouter').addEventListener('click', () => { runSettingsCommand('/model router off', 'Disabling router...').catch(console.error); });
el('settingsOpenTools').addEventListener('click', () => { closeSettings(); openSurface('tools').catch(console.error); });
el('settingsOpenSkills').addEventListener('click', () => { closeSettings(); openSurface('skills').catch(console.error); });
el('settingsOpenAgents').addEventListener('click', () => { closeSettings(); openSurface('agents').catch(console.error); });
el('settingsOpenPlugins').addEventListener('click', () => { closeSettings(); openSurface('plugins').catch(console.error); });
el('settingsTeamOff').addEventListener('click', () => { runSettingsCommand('/team off', 'Disabling team...').catch(console.error); });
el('settingsEnterWorktree').addEventListener('click', () => {
  const name = el('settingsWorktreeName').value.trim();
  if (name) runSettingsCommand('/worktree enter ' + name, 'Entering worktree...').catch(console.error);
});
el('settingsExitWorktree').addEventListener('click', () => { runSettingsCommand('/worktree exit', 'Exiting worktree...').catch(console.error); });
el('settingsAutomationWorktreeList').addEventListener('click', () => { runSettingsCommand('/worktree list', 'Listing worktrees...').catch(console.error); });
el('settingsNewChatBtn').addEventListener('click', async () => {
  await createNewSession();
  if (!el('settingsModal').classList.contains('hidden')) {
    renderSettingsCommandPanels();
    el('settingsStatus').textContent = 'New chat created';
  }
});
el('settingsMemoryStatusBtn').addEventListener('click', () => { runSettingsCommand('/memory', 'Inspecting memory...').catch(console.error); });
el('settingsCompactNowBtn').addEventListener('click', () => {
  const instructions = el('settingsCompactInstructions').value.trim();
  runSettingsCommand('/compact' + (instructions ? ' ' + instructions : ''), 'Compacting session...').catch(console.error);
});
el('settingsDreamStatusBtn').addEventListener('click', () => { runSettingsCommand('/dream status', 'Inspecting dream state...').catch(console.error); });
el('settingsDreamRunBtn').addEventListener('click', () => { runSettingsCommand('/dream run', 'Running dream...').catch(console.error); });
el('settingsMcpBtn').addEventListener('click', () => { closeSettings(); openSurface('mcp').catch(console.error); });
el('mcpCfgAdd').addEventListener('click', () => { addMcpServerConfig().catch(console.error); });
el('settingsWorktreeBtn').addEventListener('click', () => { closeSettings(); submitText('/worktree list'); });
el('settingsBridgeDetectBtn').addEventListener('click', () => { refreshBridgeDetect().catch(console.error); });
el('settingsBridgeOff').addEventListener('click', () => { disableBridge().catch(console.error); });
el('bridgeCfgSave').addEventListener('click', () => { saveBridgeConfig().catch(console.error); });
el('bridgeCfgReset').addEventListener('click', () => {
  ['bridgeCfgName', 'bridgeCfgApiKey', 'bridgeCfgBaseUrl', 'bridgeCfgModel'].forEach(id => { el(id).value = ''; });
  el('bridgeCfgClearKey').checked = false;
  draftBridgeModels = [];
  renderBridgeModels();
  el('bridgeCfgStatus').textContent = '';
});
el('bridgeModelAdd').addEventListener('click', () => { addBridgeModel(); });
el('settingsGitTreeBtn').addEventListener('click', () => { closeSettings(); openGitSurface().catch(console.error); });
document.addEventListener('click', (event) => {
  hideContextMenu();
  const menu = el('modelPickerMenu');
  if (!menu.classList.contains('hidden') && !event.target.closest('#modelPickerBtn') && !event.target.closest('#modelPickerMenu')) {
    menu.classList.add('hidden');
  }
});
document.addEventListener('contextmenu', (event) => {
  const onTarget = event.target.closest && (event.target.closest('.project-chat-row') || event.target.closest('.workspace-choice'));
  if (!onTarget) hideContextMenu();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideContextMenu(); });
el('permissionSelect').addEventListener('change', (event) => submitText('/permissions ' + event.target.value));
el('modelPickerBtn').addEventListener('click', (event) => { event.stopPropagation(); toggleModelPicker(); });
el('outputStyleSelect').addEventListener('change', (event) => submitText('/output-style ' + event.target.value));
el('closeSurfaceBtn').addEventListener('click', closeSurface);
el('surfaceDrawer').addEventListener('click', (event) => { if (event.target === el('surfaceDrawer')) closeSurface(); });
el('settingsBtn').addEventListener('click', () => { void openSettings('general').catch(console.error); });
el('backToAppBtn').addEventListener('click', closeSettings);
el('cancelSettings').addEventListener('click', closeSettings);
el('settingsForm').addEventListener('submit', saveSettings);
el('settingsSearch').addEventListener('input', (event) => {
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll('.settings-tab').forEach(button => {
    button.style.display = !query || button.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
});
el('commandSearch').addEventListener('input', () => { renderProjects(); });
el('collapseSidebar').addEventListener('click', () => document.body.classList.toggle('sidebar-collapsed'));
transcript.addEventListener('click', (event) => {
  const button = event.target.closest ? event.target.closest('.copy-btn') : null;
  if (!button) return;
  const code = button.parentElement && button.parentElement.querySelector('code');
  if (!code) return;
  navigator.clipboard.writeText(code.textContent || '').then(() => {
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = original; }, 1200);
  }).catch(() => {});
});
loadState().then(hydrateTranscript).catch(error => addMessage('error', error.message));
`;
}

export function parseActoviqGuiArgs(argv: string[]): ActoviqGuiOptions & { help?: boolean; version?: boolean } {
  const result: ActoviqGuiOptions & { help?: boolean; version?: boolean } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--version' || arg === '-v') result.version = true;
    else if (arg === '--host' && argv[index + 1]) result.host = argv[++index];
    else if (arg === '--port' && argv[index + 1]) result.port = Number(argv[++index]);
    else if (arg === '--config' && argv[index + 1]) result.configPath = argv[++index];
    else if (arg === '--permission-mode' && argv[index + 1]) {
      const mode = argv[++index]!;
      if (!PERMISSION_MODES.has(mode as ActoviqPermissionMode)) throw new Error(`Unknown permission mode: ${mode}`);
      result.permissionMode = mode as ActoviqPermissionMode;
    } else if (arg === '--model' && argv[index + 1]) result.model = argv[++index];
    else if (arg === '--resume' && argv[index + 1]) result.resumeSessionId = argv[++index];
    else if (arg === '--continue') result.continueMostRecent = true;
    else if (!arg.startsWith('-') && !result.workDir) result.workDir = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseActoviqGuiArgs(process.argv.slice(2));
  if (args.version) {
    process.stdout.write(`${readPackageVersion(import.meta.url)}\n`);
    process.exit(0);
  }
  if (args.help) {
    process.stdout.write([
      'actoviq-gui - Clean SDK local GUI',
      '',
      'Usage: actoviq-gui [work-dir] [options]',
      '',
      'Options:',
      '  --host <host>              Host to bind (default: 127.0.0.1)',
      '  --port <port>              Port to bind (default: 4174)',
      '  --config <path>            Load a specific Actoviq settings JSON file',
      '  --permission-mode <mode>   default | acceptEdits | plan | bypassPermissions (default)',
      '  --model <model>            Override the configured model',
      '  --resume <session-id>      Resume a stored Clean SDK session',
      '  --continue                 Resume the most recent stored session',
      '  -v, --version              Show package version',
      '  -h, --help                 Show this help',
      '',
    ].join('\n'));
    process.exit(0);
  }
  runActoviqGui(args).catch((error) => {
    process.stderr.write(`Fatal: ${(error as Error).stack ?? (error as Error).message}\n`);
    process.exit(1);
  });
}
