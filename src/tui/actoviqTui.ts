/**
 * Actoviq TUI — a full-screen-feel terminal UI for the Clean SDK, modeled on
 * Claude Code's REPL: permanent transcript in native scrollback, a redrawable
 * bottom region with a Claude-style prompt bar, slash-command menu, streaming
 * output, permission dialogs, and mid-run steering. Dependency-free ANSI
 * rendering (no React/Ink).
 */
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline';

import {
  createActoviqCoreTools,
  createAgentSdk,
  loadDefaultActoviqSettings,
  loadJsonConfigFile,
} from '../index.js';
import type {
  ActoviqCanUseTool,
  ActoviqPermissionMode,
  ActoviqToolApprover,
  AgentEvent,
} from '../types.js';
import { A, stringWidth, truncateToWidth } from './ansi.js';
import { InputEditor } from './editor.js';
import { TuiScreen } from './screen.js';
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
const MENU_MAX_ROWS = 12;
const PROMPT_GLYPH = '❯';

/** Core tools that mutate state and require approval in 'default' mode. */
const MUTATING_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit']);

export const TUI_SLASH_COMMANDS: Record<string, string> = {
  help: 'Show available commands',
  clear: 'Clear the screen',
  compact: 'Compact the current session',
  memory: 'Show memory/compact state',
  model: 'Show current model',
  tools: 'List available tools',
  dream: 'Trigger memory consolidation',
  exit: 'Quit',
};

export function filterSlashCommands(input: string): string[] {
  if (!input.startsWith('/')) return [];
  const head = input.slice(1).split(/\s/, 1)[0] ?? '';
  if (input.includes(' ') && head.length > 0) return [];
  const partial = head.toLowerCase();
  return Object.keys(TUI_SLASH_COMMANDS).filter((name) => name.startsWith(partial));
}

export interface ActoviqTuiOptions {
  workDir?: string;
  configPath?: string;
  permissionMode?: ActoviqPermissionMode;
  model?: string;
}

interface PermissionDialogState {
  toolName: string;
  summary: string;
  selected: number; // 0 = yes, 1 = always, 2 = no
  resolve: (outcome: 'allow' | 'always' | 'deny') => void;
}

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
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
    `You are Actoviq, an interactive CLI agent. Working directory: ${workDir}\n\n` +
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
  const sdk = await createAgentSdk({
    workDir,
    tools,
    permissionMode,
    ...(options.model ? { model: options.model } : {}),
  });
  const toolMetadata = await sdk.listToolMetadata();
  const session = await sdk.createSession({ title: path.basename(workDir) });

  const screen = new TuiScreen(process.stdout);
  const editor = new InputEditor();
  const flusher = new StreamFlusher(() => screen.width);

  let running = false;
  let commandBusy = false;
  let shuttingDown = false;
  let abortCtrl: AbortController | null = null;
  let dialog: PermissionDialogState | null = null;
  let menuSelected = 0;
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let runStartedAt = 0;
  let runToolCount = 0;
  let lastTokenEstimate: number | undefined;
  let statusNote = '';
  let ctrlCCount = 0;
  let ctrlCTimer: ReturnType<typeof setTimeout> | null = null;
  let streamedTextSeen = false;
  const queuedInputs: string[] = [];
  const alwaysAllowedTools = new Set<string>();

  const approver: ActoviqToolApprover = async (context) => {
    if (alwaysAllowedTools.has(context.publicName)) {
      return { behavior: 'allow', reason: 'Always-allowed for this TUI session.' };
    }
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
      alwaysAllowedTools.add(context.publicName);
      return { behavior: 'allow', reason: 'Approved (always) in TUI.' };
    }
    return outcome === 'allow'
      ? { behavior: 'allow', reason: 'Approved in TUI.' }
      : { behavior: 'deny', reason: 'Denied in TUI permission dialog.' };
  };

  const canUseTool: ActoviqCanUseTool | undefined =
    permissionMode === 'default'
      ? (context) => {
          if (alwaysAllowedTools.has(context.publicName)) {
            return { behavior: 'allow', reason: 'Always-allowed for this TUI session.' };
          }
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
      const placeholder = truncateToWidth('Try "write a test for <filepath>"', editorWidth - 2);
      lines.push(`${A.magenta}${PROMPT_GLYPH}${A.reset} ${A.dim}${placeholder}${A.reset}`);
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

  function buildMenu(): string[] {
    const matches = filterSlashCommands(editor.text);
    if (matches.length === 0) return [];
    if (menuSelected >= matches.length) menuSelected = matches.length - 1;
    const commandWidth = Math.min(28, Math.max(14, Math.floor(screen.width * 0.28)));
    const descriptionWidth = Math.max(screen.width - commandWidth - 4, 12);
    return matches.slice(0, MENU_MAX_ROWS).map((name, index) => {
      const selected = index === menuSelected;
      const command = `/${name}`.padEnd(commandWidth);
      const label = selected ? `${A.inverse}${command}${A.reset}` : command;
      const description = truncateToWidth(TUI_SLASH_COMMANDS[name] ?? '', descriptionWidth);
      return `${label} ${A.dim}${description}${A.reset}`;
    });
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

  function buildStatusLine(): string[] {
    if (!running) return [];
    const elapsed = Math.max(Math.round((Date.now() - runStartedAt) / 1000), 0);
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    const context =
      lastTokenEstimate && lastTokenEstimate >= 1000
        ? ` · ~${Math.round(lastTokenEstimate / 1000)}k ctx`
        : '';
    const note = statusNote ? ` · ${statusNote}` : '';
    const queued = queuedInputs.length > 0 ? ` · ${queuedInputs.length} queued` : '';
    return [
      `${A.cyan}${frame}${A.reset} ${A.bold}Working…${A.reset}${A.dim} (${elapsed}s · ${runToolCount} tool${runToolCount === 1 ? '' : 's'}${context}${note}${queued} · esc to interrupt)${A.reset}`,
    ];
  }

  function buildHintLine(): string[] {
    if (running) {
      return [`${A.dim}  enter to queue a steering message · esc interrupt · ctrl+c twice to exit${A.reset}`];
    }
    return [`${A.dim}  ? for shortcuts · / for commands · \\↵ newline · ↑↓ history · ctrl+c clear/exit${A.reset}`];
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
    } else {
      lines.push(...buildPromptBar());
      const menu = buildMenu();
      lines.push(...(menu.length > 0 ? menu : buildHintLine()));
    }
    screen.setDynamic(lines);
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
        permissionMode,
        approver,
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
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
      }
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
        renderDynamic();
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
          renderDynamic();
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

  async function runSlashCommand(raw: string): Promise<void> {
    const spaceIndex = raw.indexOf(' ');
    const name = (spaceIndex === -1 ? raw.slice(1) : raw.slice(1, spaceIndex)).toLowerCase();
    appendStatic(formatUserPrompt(raw));
    commandBusy = true;
    renderDynamic();
    try {
      switch (name) {
        case 'help': {
          const lines = Object.entries(TUI_SLASH_COMMANDS).map(
            ([command, description]) => `  ${A.cyan}/${command.padEnd(10)}${A.reset} ${A.dim}${description}${A.reset}`,
          );
          appendStatic([...lines, '']);
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
        case 'model':
          appendStatic([...formatInfoLine(`model: ${sdk.config.model}`), '']);
          return;
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
            const result = (await session.compact({ force: true })) as { messagesRemoved?: number };
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
            await session.dream({ force: true });
            appendStatic([`${A.green}✓ dream triggered${A.reset}`, '']);
          } catch (error) {
            appendStatic([...formatErrorLine((error as Error).message), '']);
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
        const menu = filterSlashCommands(editor.text);
        if (menu.length > 0) {
          menuSelected = (menuSelected + menu.length - 1) % menu.length;
        } else if (!editor.onFirstLine()) {
          editor.moveUp();
        } else {
          editor.historyPrev();
        }
        break;
      }
      case 'down': {
        const menu = filterSlashCommands(editor.text);
        if (menu.length > 0) {
          menuSelected = (menuSelected + 1) % menu.length;
        } else if (!editor.onLastLine()) {
          editor.moveDown();
        } else {
          editor.historyNext();
        }
        break;
      }
      case 'tab': {
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
      model: sdk.config.model,
      toolCount: toolMetadata.length,
      permissionMode,
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
