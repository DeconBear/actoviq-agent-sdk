/**
 * Actoviq TUI — a full-screen-feel terminal UI for the Clean SDK, modeled on
 * Claude Code's REPL: permanent transcript in native scrollback, a redrawable
 * bottom region with a Claude-style prompt bar, slash-command menu, streaming
 * output, permission dialogs, and mid-run steering. Dependency-free ANSI
 * rendering (no React/Ink).
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline';

import {
  createActoviqCoreTools,
  createAgentSdk,
  loadDefaultActoviqSettings,
  loadJsonConfigFile,
  listWorkflows,
  loadWorkflow,
  listTeamDefinitions,
  loadTeamDefinition,
  createModelTeam,
  createTeamTool,
  WorktreeService,
} from '../index.js';
import {
  persistActoviqSettingsStore,
  resolveActoviqSettingsStore,
} from '../config/actoviqSettingsStore.js';
import type {
  ActoviqEffort,
  ActoviqRunEffort,
  ActoviqCanUseTool,
  ActoviqPermissionMode,
  ActoviqPermissionRule,
  ActoviqToolApprover,
  AgentEvent,
  AgentToolDefinition,
  TeamDefinition,
} from '../types.js';
import { isRecord } from '../runtime/helpers.js';
import { pathToFileURL } from 'node:url';
import { A, stringWidth, truncateToWidth, wrapToWidth } from './ansi.js';
import { InputEditor } from './editor.js';
import { discoverActoviqPlugins } from './pluginCatalog.js';
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
const SESSION_EFFORT_KEY = '__actoviqEffort';
const EFFORT_LEVELS: readonly ActoviqEffort[] = ['low', 'medium', 'high', 'max'];

/** Core tools that mutate state and require approval in 'default' mode. */
const MUTATING_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit']);
const PERMISSION_MODES = new Set<ActoviqPermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'auto',
]);

export const TUI_SLASH_COMMANDS: Record<string, string> = {
  help: 'Show available commands',
  clear: 'Clear the screen',
  compact: 'Compact the current session',
  memory: 'Show memory/compact state',
  model: 'Select a model or configure its provider',
  effort: 'Select the reasoning effort',
  permissions: 'Show or set the permission mode',
  sessions: 'List stored sessions',
  resume: 'Resume a stored session',
  tools: 'List available tools',
  skills: 'Browse available skills',
  agents: 'Browse available subagents',
  mcp: 'Inspect MCP servers and tools',
  plugins: 'Browse discovered Clean plugins',
  dream: 'Inspect or run memory consolidation',
  workflows: 'Browse saved dynamic workflows',
  worktree: 'Enter, exit, or list git worktrees',
  team: 'List or run Model Team definitions',
  exit: 'Quit',
};

export function filterSlashCommands(input: string): string[] {
  if (!input.startsWith('/')) return [];
  const head = input.slice(1).split(/\s/, 1)[0] ?? '';
  if (input.includes(' ') && head.length > 0) return [];
  const partial = head.toLowerCase();
  return Object.keys(TUI_SLASH_COMMANDS).filter((name) => name.startsWith(partial));
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

export interface ActoviqTuiOptions {
  workDir?: string;
  configPath?: string;
  permissionMode?: ActoviqPermissionMode;
  model?: string;
  resumeSessionId?: string;
  continueMostRecent?: boolean;
}

interface PermissionDialogState {
  toolName: string;
  summary: string;
  selected: number; // 0 = yes, 1 = always, 2 = no
  resolve: (outcome: 'allow' | 'always' | 'deny') => void;
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
function renderRichText(text: string, width: number, opts: { maxLines?: number } = {}): string[] {
  const cols = Math.max(20, width - 2);
  const out: string[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      out.push(`${A.bold}${A.cyan}${heading[2]}${A.reset}`);
      continue;
    }
    if (raw.trim() === '') {
      out.push('');
      continue;
    }
    for (const line of wrapToWidth(raw, cols)) out.push(line);
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
  );
}

export async function runActoviqTui(options: ActoviqTuiOptions = {}): Promise<void> {
  const workDir = path.resolve(options.workDir ?? process.cwd());
  const permissionMode: ActoviqPermissionMode = options.permissionMode ?? 'bypassPermissions';
  const systemPrompt = buildSystemPrompt(workDir);

  try {
    if (options.configPath) {
      await loadJsonConfigFile(options.configPath);
    } else {
      await loadDefaultActoviqSettings();
    }
  } catch {
    // Missing local config is fine; env vars may carry credentials.
  }

  const tools = createActoviqCoreTools({ cwd: workDir });
  const createCleanSdk = () =>
    createAgentSdk({
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

  const screen = new TuiScreen(process.stdout);
  const editor = new InputEditor();
  const flusher = new StreamFlusher(() => screen.width);

  let running = false;
  let commandBusy = false;
  let shuttingDown = false;
  // Active team tool the main agent may call (toggled via /team). null = no team.
  let activeTeamTool: AgentToolDefinition | null = null;
  let activeTeamName: string | null = null;
  let abortCtrl: AbortController | null = null;
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
  let statusNote = '';
  let ctrlCCount = 0;
  let ctrlCTimer: ReturnType<typeof setTimeout> | null = null;
  let streamedTextSeen = false;
  const queuedInputs: string[] = [];
  const currentPermissionMode = (): ActoviqPermissionMode =>
    session.permissionContext.mode ?? permissionMode;
  const currentEffort = (): ActoviqRunEffort | undefined => {
    const stored = session.metadata[SESSION_EFFORT_KEY];
    if (stored === 'auto') return 'auto';
    return isActoviqEffort(stored) ? stored : sdk.config.effort;
  };

  function isActoviqEffort(value: unknown): value is ActoviqEffort {
    return typeof value === 'string' && EFFORT_LEVELS.includes(value as ActoviqEffort);
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
    } catch (error) {
      await nextSdk.close().catch(() => undefined);
      throw error;
    }
    await previousSdk.close().catch(() => undefined);
  }

  const approver: ActoviqToolApprover = async (context) => {
    const outcome = await new Promise<'allow' | 'always' | 'deny'>((resolve) => {
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
    if (outcome === 'always') {
      const state = session.permissionContext;
      const permissions = state.permissions.filter(
        rule => !(rule.toolName === context.publicName && rule.behavior === 'allow'),
      );
      permissions.push({
        toolName: context.publicName,
        behavior: 'allow',
        source: 'tui-session',
      });
      await session.setPermissionContext({
        mode: state.mode ?? permissionMode,
        permissions,
        approver,
      });
      return { behavior: 'allow', reason: 'Approved (always) in TUI.' };
    }
    return outcome === 'allow'
      ? { behavior: 'allow', reason: 'Approved in TUI.' }
      : { behavior: 'deny', reason: 'Denied in TUI permission dialog.' };
  };

  const canUseTool: ActoviqCanUseTool | undefined =
    permissionMode === 'default'
      ? (context) => {
          if (MUTATING_TOOLS.has(context.publicName)) {
            return { behavior: 'ask', reason: `${context.publicName} mutates the workspace.` };
          }
          return undefined;
        }
      : undefined;

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
    const matches = files.filter((file) => file.toLowerCase().includes(query));
    matches.sort((a, b) => {
      const aBase = a.slice(a.lastIndexOf('/') + 1).toLowerCase();
      const bBase = b.slice(b.lastIndexOf('/') + 1).toLowerCase();
      const aScore = aBase.startsWith(query) ? 0 : aBase.includes(query) ? 1 : 2;
      const bScore = bBase.startsWith(query) ? 0 : bBase.includes(query) ? 1 : 2;
      if (aScore !== bScore) return aScore - bScore;
      return a.length - b.length;
    });
    return matches.slice(0, 200);
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
      const description = truncateToWidth(TUI_SLASH_COMMANDS[name] ?? '', descriptionWidth);
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
    const options = ['Yes', `Yes, always allow ${dialog.toolName}`, 'No (esc)'];
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
    lines.push(`${A.dim}  y/enter approve · a always · n/esc deny · ↑↓ select${A.reset}`);
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
    const left = `${session.model} · ${permissionLabel()} · effort:${currentEffort() ?? 'auto'} · team:${activeTeamName ?? 'none'} · `;
    return `${A.dim}  ${left}${A.reset}${ctxColor}ctx ${pct}% (${usedK})${A.reset}`;
  }

  function buildStatusLine(): string[] {
    const modeLine = buildModeLine();
    if (!running) return [modeLine];
    const elapsed = Math.max(Math.round((Date.now() - runStartedAt) / 1000), 0);
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    const note = statusNote ? ` · ${statusNote}` : '';
    const queued = queuedInputs.length > 0 ? ` · ${queuedInputs.length} queued` : '';
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

  function renderDynamic(): void {
    const lines: string[] = [];
    lines.push(...buildStatusLine());
    const tail = flusher.tail();
    if (running && tail) {
      lines.push(tail);
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

  // ── Agent run ──────────────────────────────────────────────────────

  async function startRun(text: string): Promise<void> {
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

    try {
      const stream = session.stream(text, {
        systemPrompt,
        signal: abortCtrl.signal,
        permissionMode: currentPermissionMode(),
        effort: currentEffort(),
        approver,
        ...(activeTeamTool ? { tools: [...tools, activeTeamTool] } : {}),
        ...(canUseTool ? { canUseTool } : {}),
        drainQueuedInputs: () => {
          const drained = queuedInputs.splice(0);
          return drained;
        },
      });
      for await (const event of stream) {
        handleAgentEvent(event);
      }
      const result = await stream.result;
      const rest = flusher.drain();
      if (rest.length > 0) appendStatic(rest);
      if (!flusher.hasContent && result.text && runHadNoStreamedText()) {
        appendStatic([result.text]);
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

    // Steering messages typed too late to drain mid-run become the next turn.
    if (queuedInputs.length > 0 && !shuttingDown) {
      const next = queuedInputs.splice(0).join('\n');
      await startRun(next);
    }
  }

  function runHadNoStreamedText(): boolean {
    return !streamedTextSeen;
  }

  function handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'run.started':
        streamedTextSeen = false;
        return;
      case 'request.started':
        lastTokenEstimate = event.requestTokenEstimate;
        renderDynamic();
        return;
      case 'response.text.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (!delta) return;
        streamedTextSeen = true;
        const flushed = flusher.push(delta);
        if (flushed.length > 0) appendStatic(flushed);
        scheduleDynamicRender();
        return;
      }
      case 'response.content':
        if (event.content.type === 'thinking') {
          const thinking = (event.content as { thinking?: string }).thinking ?? '';
          const lines = formatThinking(thinking, screen.width);
          if (lines.length > 0) appendStatic(lines);
        }
        return;
      case 'tool.call': {
        const pending = flusher.drain();
        if (pending.length > 0) appendStatic(pending);
        runToolCount += 1;
        statusNote = event.call.publicName;
        appendStatic(formatToolCall(event.call.publicName, event.call.input, screen.width));
        renderDynamic();
        return;
      }
      case 'tool.progress': {
        const data = event.data as { message?: string } | undefined;
        if (data?.message) {
          statusNote = data.message;
          scheduleDynamicRender();
        }
        return;
      }
      case 'tool.result':
        statusNote = '';
        appendStatic(
          formatToolResult(
            {
              isError: event.result.isError,
              durationMs: event.result.durationMs,
              outputText: event.result.outputText,
            },
            screen.width,
          ),
        );
        renderDynamic();
        return;
      case 'conversation.compacted':
        appendStatic(
          formatCompactNotice(event.trigger ?? 'auto', event.tokenEstimateBefore, event.tokenEstimateAfter),
        );
        return;
      case 'session.compacted':
        appendStatic(formatCompactNotice(event.trigger));
        return;
      case 'tool.permission':
        if (event.decision.behavior === 'deny') {
          appendStatic(formatInfoLine(`permission denied: ${event.decision.publicName} — ${event.decision.reason}`));
        }
        return;
      case 'error':
        appendStatic(formatErrorLine(event.error.message));
        return;
      default:
        return;
    }
  }

  // ── Slash commands ─────────────────────────────────────────────────

  function commandUsage(name: string): string {
    const usage: Record<string, string> = {
      help: '/help',
      clear: '/clear',
      compact: '/compact [summary instructions]',
      memory: '/memory',
      model: '/model [model|min|medium|max|default|config]',
      effort: '/effort [low|medium|high|max|auto]',
      permissions: '/permissions [default|acceptEdits|plan|bypassPermissions|auto]',
      sessions: '/sessions',
      resume: '/resume [session-id]',
      tools: '/tools',
      skills: '/skills',
      agents: '/agents',
      mcp: '/mcp',
      plugins: '/plugins',
      dream: '/dream [run|status]',
      workflows: '/workflows [run <name>|list]',
      worktree: '/worktree [enter <name>|exit|list]',
      team: '/team [ask <name> <prompt>|list]',
      exit: '/exit',
    };
    return usage[name] ?? `/${name}`;
  }

  async function resumeSession(sessionId: string): Promise<void> {
    session = await sdk.resumeSession(sessionId);
    appendStatic([
      ...formatInfoLine(`resumed: ${session.id} · ${session.title} · ${session.model}`),
      '',
    ]);
  }

  async function chooseSessionToResume(): Promise<void> {
    const sessions = (await sdk.sessions.list()).filter(item => item.id !== session.id);
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
    const store = await resolveActoviqSettingsStore({ configPath: options.configPath });
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
            description: env.ACTOVIQ_PROVIDER ?? sdk.config.provider,
          },
          {
            id: 'api-key',
            label: 'API key',
            description:
              env.ACTOVIQ_API_KEY || env.ACTOVIQ_AUTH_TOKEN ? 'configured' : 'not configured',
          },
          {
            id: 'base-url',
            label: 'Base URL',
            description: env.ACTOVIQ_BASE_URL || 'provider default',
          },
          ...(['min', 'medium', 'max'] as const).map(tier => ({
            id: `tier:${tier}`,
            label: `${tier} model`,
            description: env[`ACTOVIQ_DEFAULT_${tier.toUpperCase()}_MODEL`] || 'not configured',
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
        await persistActoviqSettingsStore(store.configPath, raw);
        await loadJsonConfigFile(store.configPath);
        await reloadCleanSdk();
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
          env.ACTOVIQ_PROVIDER = provider;
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
          env.ACTOVIQ_API_KEY = apiKey.trim();
          delete env.ACTOVIQ_AUTH_TOKEN;
          dirty = true;
        }
        continue;
      }
      if (selected === 'base-url') {
        const baseUrl = await promptText({
          title: 'Configure base URL',
          label: 'Base URL',
          description: 'Leave empty to use the provider default.',
          initial: env.ACTOVIQ_BASE_URL ?? '',
        });
        if (baseUrl !== undefined) {
          if (baseUrl.trim()) env.ACTOVIQ_BASE_URL = baseUrl.trim();
          else delete env.ACTOVIQ_BASE_URL;
          dirty = true;
        }
        continue;
      }
      if (selected.startsWith('tier:')) {
        const tier = selected.slice('tier:'.length).toUpperCase();
        const key = `ACTOVIQ_DEFAULT_${tier}_MODEL`;
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
    if (value !== 'auto' && !isActoviqEffort(value)) {
      appendStatic([...formatErrorLine(`unknown effort: ${value}`), '']);
      return;
    }
    await session.mergeMetadata({
      [SESSION_EFFORT_KEY]: value,
    });
    appendStatic([...formatInfoLine(`effort set to: ${currentEffort() ?? 'auto'}`), '']);
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

  async function showMcp(): Promise<void> {
    const byServer = new Map<string, typeof toolMetadata>();
    for (const tool of toolMetadata.filter(item => item.provider === 'mcp')) {
      const server = tool.server ?? 'mcp';
      const tools = byServer.get(server) ?? [];
      tools.push(tool);
      byServer.set(server, tools);
    }
    if (byServer.size === 0) {
      appendStatic([...formatInfoLine('no MCP servers are active'), '']);
      return;
    }
    const selected = await selectItem({
      title: 'MCP servers',
      items: [...byServer.entries()].map(([server, tools]) => ({
        id: server,
        label: server,
        description: `${tools.length} tool${tools.length === 1 ? '' : 's'}`,
        detail: tools.map(tool => tool.name).join(', '),
      })),
    });
    if (selected) {
      appendStatic([
        `${A.cyan}${selected}${A.reset}`,
        `${A.dim}${(byServer.get(selected) ?? []).map(tool => tool.name).join(', ')}${A.reset}`,
        '',
      ]);
    }
  }

  async function showPlugins(): Promise<void> {
    const store = await resolveActoviqSettingsStore({ configPath: options.configPath });
    const configuredDirs = Array.isArray(store.raw.pluginDirs)
      ? store.raw.pluginDirs.filter((value): value is string => typeof value === 'string')
      : [];
    const plugins = await discoverActoviqPlugins({
      workDir,
      homeDir: store.homeDir,
      configuredDirs,
    });
    if (plugins.length === 0) {
      appendStatic([
        ...formatInfoLine('no Clean plugins discovered in user, project, or configured plugin directories'),
        '',
      ]);
      return;
    }
    const selected = await selectItem({
      title: 'Clean plugins',
      items: plugins.map(plugin => ({
        id: plugin.path,
        label: plugin.name,
        description: [plugin.version, plugin.capabilities.join(', ')].filter(Boolean).join(' · '),
        detail: `${plugin.description ?? ''} ${plugin.path}`,
      })),
    });
    const plugin = plugins.find(item => item.path === selected);
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
          const presets: Record<string, { mode: ActoviqPermissionMode; rules: ActoviqPermissionRule[]; label: string }> = {
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
        case 'sessions': {
          const sessions = await sdk.sessions.list();
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
            const state = await session.compactState();
            appendStatic([`${A.dim}${JSON.stringify(state, null, 2)}${A.reset}`, '']);
          } catch (error) {
            appendStatic([...formatErrorLine((error as Error).message), '']);
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
            appendStatic([
              `${A.green}✓ compacted${A.reset}${A.dim} · ${result.messagesRemoved ?? '?'} messages summarized${A.reset}`,
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
        case 'agents':
          await showAgents();
          return;
        case 'mcp':
          await showMcp();
          return;
        case 'plugins':
          await showPlugins();
          return;
        // ── v0.5.0: Dynamic Workflows ────────────────────────────
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
        // ── v0.5.0: Model Team ───────────────────────────────────
        case 'team': {
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
            appendStatic([
              ...formatInfoLine(`asking team "${teamName}" (${loaded.definition.mode} mode)`),
              `${A.dim}convening: ${loaded.definition.members?.map((m) => m.model).join(', ') ?? 'configured members'}${A.reset}`,
              '',
            ]);
            try {
              const team = createModelTeam(loaded.definition);
              const result = await team.ask(prompt);
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
          const member = (sp: string) => ({ model: session.model, systemPrompt: sp });
          const buildDefault = (mode: string): TeamDefinition | undefined => {
            switch (mode) {
              case 'panel-analysis':
                return { name: 'panel-analysis', mode: 'panel-analysis', members: [member('Expert researcher. Investigate with read-only tools; cite sources.'), member('Rigorous skeptic. Verify with sources; challenge assumptions.')], primary: member('Synthesizer. Reconcile the panel findings into the best answer and decide when they suffice.'), timeoutMs: 300000, maxIterations: 12 };
              case 'analysis':
                return { name: 'analysis-panel', mode: 'analysis', members: [member('Expert researcher. Deep, source-grounded analysis.'), member('Rigorous skeptic. Verify with sources; challenge assumptions.')], timeoutMs: 300000, maxIterations: 12 };
              case 'panel':
                return { name: 'panel', mode: 'panel', members: [member('Thorough analyst.'), member('Creative problem-solver.')], primary: member('Synthesizer. Reconcile views into the best answer.'), timeoutMs: 300000 };
              case 'discussion':
                return { name: 'discussion', mode: 'discussion', members: [member('Systems thinker.'), member('Pragmatist who weighs trade-offs.')], primary: member('Convener and final decision-maker.'), timeoutMs: 300000 };
              case 'executor-reviewer':
                return { name: 'executor-reviewer', mode: 'executor-reviewer', members: [], executor: member('Executor. Own the output; you decide what to accept.'), reviewer: member('Reviewer. Advise; never command.'), timeoutMs: 300000 };
              default:
                return undefined;
            }
          };

          const saved = listTeamDefinitions(sdk.config.workDir);
          const items = [
            { id: '__none__', label: activeTeamTool ? `No team — remove "${activeTeamName}"` : 'No team (individual) — current', description: 'the agent works solo, no team tool attached' },
            ...saved.map((t) => ({ id: `saved:${t.name}`, label: t.name, description: `saved · ${t.definition.mode} · ${t.definition.members?.length ?? 0} members` })),
            ...['panel-analysis', 'analysis', 'panel', 'discussion', 'executor-reviewer'].map((m) => ({ id: `mode:${m}`, label: `+ new ${m} team`, description: `built-in ${m} mode · default ${session.model} members` })),
          ];
          const choice = await selectItem({ title: 'Team', subtitle: 'attach a team the agent can call as a tool, or remove it', items });
          if (!choice) return;
          if (choice === '__none__') {
            activeTeamTool = null;
            activeTeamName = null;
            appendStatic([...formatInfoLine('team: none — the agent works individually'), '']);
            return;
          }
          let def: TeamDefinition | undefined;
          if (choice.startsWith('saved:')) def = loadTeamDefinition(choice.slice('saved:'.length), sdk.config.workDir)?.definition;
          else if (choice.startsWith('mode:')) def = buildDefault(choice.slice('mode:'.length));
          if (!def) {
            appendStatic([...formatErrorLine('could not load team definition'), '']);
            return;
          }
          try {
            activeTeamTool = createTeamTool(def);
            activeTeamName = def.name;
            appendStatic([...formatInfoLine(`team active: ${def.name} (${def.mode}) — the agent can now call "${def.name}" as a tool when it helps`), '']);
          } catch (error: any) {
            appendStatic([...formatErrorLine(`team error: ${error.message}`), '']);
          }
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
    const matches = filterSlashCommands(editor.text);
    if (matches.length > 0 && !running) {
      const selected = matches[Math.min(menuSelected, matches.length - 1)]!;
      const args = editor.text.includes(' ') ? editor.text.slice(editor.text.indexOf(' ')) : '';
      editor.clear();
      menuSelected = 0;
      await runSlashCommand(`/${selected}${args}`);
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
      queuedInputs.push(text);
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
      dialog.selected = (dialog.selected + 2) % 3;
    } else if (name === 'down' || name === 'tab') {
      dialog.selected = (dialog.selected + 1) % 3;
    } else if (name === 'return' || name === 'enter') {
      dialog.resolve(dialog.selected === 0 ? 'allow' : dialog.selected === 1 ? 'always' : 'deny');
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
    if (spinnerTimer) clearInterval(spinnerTimer);
    cancelScheduledDynamicRender();
    abortCtrl?.abort();
    screen.stop();
    process.stdout.write(`${A.dim}Goodbye.${A.reset}\n`);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    try {
      await sdk.close();
    } catch {
      // best-effort close
    }
    process.exit(code);
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
  process.stdout.on('resize', () => renderDynamic());

  // Keep the process alive until shutdown() exits it.
  await new Promise(() => {});
}

// Allow running this module directly (`npx tsx src/tui/actoviqTui.ts`), not only
// via the cli/ wrapper. Requires an interactive terminal.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'actoviq TUI requires an interactive terminal (TTY). Run it directly in your terminal — not piped or through another tool.\n',
    );
    process.exit(1);
  }
  runActoviqTui().catch((error: unknown) => {
    process.stderr.write(`Fatal: ${(error as Error).stack ?? (error as Error).message}\n`);
    process.exit(1);
  });
}
