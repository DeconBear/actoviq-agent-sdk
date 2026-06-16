# 17 — CLI & TUI

## Architecture

Two interactive surfaces: a lightweight scrollback REPL (`actoviq-react`) and
a full terminal UI (`actoviq-tui`). Both use the same SDK runtime but differ
in rendering approach.

| | actoviq-react | actoviq-tui |
|---|---|---|
| **Rendering** | Native scrollback (readline) | Alternate screen buffer (full TUI) |
| **Input** | readline with history | Custom key handling |
| **Streaming** | Inline text + tool indicators | Redrawable panels |
| **Slash commands** | Inline parsing | Searchable menu |
| **Complexity** | ~370 lines | ~1000+ lines |

## Module Design

### Files

| File | Role |
|---|---|
| `cli/actoviq-react.ts` | Scrollback REPL (~370 lines) |
| `cli/actoviq-tui.ts` | TUI entry point |
| `tui/actoviqTui.ts` | Full TUI implementation (~1000+ lines) |
| `tui/transcript.ts` | Transcript rendering |
| `runtime/actoviqSlashCommands.ts` | Slash command registry + formatting |

### `actoviq-react` — Scrollback REPL

Location: `src/cli/actoviq-react.ts`

```
main()
    ├── Load config (explicit path or default settings.json)
    ├── createAgentSdk({ workDir, tools, permissionMode })
    ├── createSession({ title, permissionMode })
    │
    ├── readline interface (completer: slash commands)
    │   ├── Tab → complete slash commands
    │   ├── ↑↓ → input history
    │   └── Ctrl+C (×2) → exit
    │
    ├── Slash commands (inline parsing)
    │   ├── /help, /clear, /exit
    │   ├── /model, /permissions, /sessions, /resume
    │   ├── /tools, /memory, /compact, /dream
    │   └── /model <name> → switch model
    │
    └── Message processing (processMsg)
        ├── session.stream(text, { systemPrompt, signal, model, permissionMode })
        ├── Event handling:
        │   ├── request.started → show iteration number
        │   ├── response.text.delta → write to stdout
        │   ├── response.content (thinking) → dimmed prefix
        │   ├── tool.call → "⚡ ToolName(args)" in yellow
        │   ├── tool.progress → inline status message
        │   ├── tool.result → "✓/✗ duration output" 
        │   ├── session.compacted → context compacted notice
        │   └── error → error message
        └── Abort: Ctrl+C → abortCtrl.abort()
```

### Config Loading Behavior

```typescript
// If user explicitly passed a config path (argv[3]):
try { await loadJsonConfigFile(CONFIG_PATH); } catch (e) {
  // Fail loud — don't silently fall back to defaults
  process.stderr.write(`✕ Failed to load config "${CONFIG_PATH}"...`);
  process.exit(2);
}

// If using default settings.json:
try { await loadDefaultActoviqSettings(); } catch (e) {
  // Tolerate missing file (first run), warn on other errors
  if (!/not found|ENOENT/i.test(e.message)) {
    process.stderr.write(`⚠ Default settings load failed: ${e.message}`);
  }
}
```

### `actoviq-tui` — Full Terminal UI

Location: `src/tui/actoviqTui.ts`

Uses alternate screen buffer (`\x1b[?1049h`) for a redrawable interface:

```
┌─────────────────────────────────────────────┐
│  Transcript area (native scrollback)         │
│  • Assistant text flushes into buffer        │
│  • Tool calls with live status               │
│  • Copy/paste works normally                 │
│                                              │
├─────────────────────────────────────────────┤
│  Status line                                 │
│  ⏳ Hadamard Agent · 12s · 5 tools · 8K ctx │
├─────────────────────────────────────────────┤
│  Prompt bar                                  │
│  > user input here                    [Ctrl] │
├─────────────────────────────────────────────┤
│  Slash-command menu (on /)                   │
│  /help  /model  /resume  /sessions  ...      │
└─────────────────────────────────────────────┘
```

Key features:
- **Status line**: spinner, elapsed time, tool count, context-size estimate
- **Prompt bar**: `\` + Enter for newline, `↑↓` for history, inline caret
- **Slash-command menu**: filtered, searchable (`↑↓` select, `Tab` complete)
- **Mid-run steering**: type while agent works, press Enter to queue
- **Permission dialogs**: approve / always-allow / deny for mutating tools
- **Interrupts**: `Esc` aborts run, `Ctrl+C` clears input, `Ctrl+D` exits

### Slash Command Registry

Location: `src/runtime/actoviqSlashCommands.ts`

```typescript
class ActoviqSlashCommandsApi {
  register(command: ActoviqSlashCommandDefinition): ActoviqSlashCommandHandle
  list(): ActoviqSlashCommandDefinition[]
  execute(name: string, args: string): Promise<ActoviqSlashCommandResult>
}
```

Formatters (for `/help`-style output):
- `formatActoviqAgents()` — registered agent definitions
- `formatActoviqSkills()` — registered skill definitions
- `formatActoviqTools()` — available tool catalog
- `formatActoviqContextOverview()` — session + memory state
- `formatActoviqCompactResult()` — last compaction details
- `formatActoviqDreamResult()` — last dream consolidation
- `formatActoviqMemoryState()` — memory file status

## Code Details

### ANSI Color Scheme

```typescript
const C = {
  r: '\x1b[0m',   // reset
  d: '\x1b[2m',   // dim
  c: '\x1b[36m',  // cyan
  y: '\x1b[33m',  // yellow
  g: '\x1b[32m',  // green
  R: '\x1b[31m',  // red
  b: '\x1b[1m',   // bold
  m: '\x1b[35m',  // magenta
};
```

### Default System Prompt (REPL)

```typescript
const SYSTEM_PROMPT =
  `You are Hadamard Agent, an interactive CLI agent. Working directory: ${WORK_DIR}\n\n` +
  `<env>\nWorking directory: ${WORK_DIR}\nIs git repo: ${isGit ? 'Yes' : 'No'}\n` +
  `Platform: ${process.platform}\nDate: ${new Date().toISOString().slice(0, 10)}\n</env>\n\n` +
  `# Tone and style\n- Only use emojis if explicitly requested.\n` +
  `- Responses should be short and concise.\n` +
  `- When referencing code include file_path:line_number.\n\n` +
  `# Doing tasks\n- Prefer editing existing files.\n` +
  `- Do not add features beyond what the task requires.\n` +
  `- Default to writing no comments.\n\n` +
  `# Git Safety Protocol\n- NEVER update the git config\n` +
  `- NEVER run destructive git commands unless explicitly requested\n` +
  `- NEVER skip hooks unless explicitly requested\n` +
  `- NEVER commit changes unless explicitly asked\n\n` +
  `# Other\n- NEVER create documentation files (*.md) unless explicitly requested.\n` +
  `- When in doubt, use TodoWrite to track progress.`;
```
