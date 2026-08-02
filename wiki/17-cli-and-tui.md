# 17 — CLI & TUI

## Architecture

`hadamard-tui` is the sole interactive terminal Agent. It combines native
scrollback, custom key handling, streaming tool state, and the searchable
shared slash-command surface used by the GUI.

## Module Design

### Files

| File | Role |
|---|---|
| `cli/hadamard-tui.ts` | TUI entry point |
| `tui/hadamardTui.ts` | Full TUI implementation |
| `tui/transcript.ts` | Transcript rendering |
| `ui/commandSurface.ts` | Shared TUI/GUI command registry and subcommands |

### Config Loading Behavior

```typescript
// If user explicitly passed a config path (argv[3]):
try { await loadJsonConfigFile(CONFIG_PATH); } catch (e) {
  // Fail loud — don't silently fall back to defaults
  process.stderr.write(`✕ Failed to load config "${CONFIG_PATH}"...`);
  process.exit(2);
}

// If using default settings.json:
try { await loadDefaultHadamardSettings(); } catch (e) {
  // Tolerate missing file (first run), warn on other errors
  if (!/not found|ENOENT/i.test(e.message)) {
    process.stderr.write(`⚠ Default settings load failed: ${e.message}`);
  }
}
```

### Terminal UI

Location: `src/tui/hadamardTui.ts`

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

Location: `src/runtime/hadamardSlashCommands.ts`

```typescript
class HadamardSlashCommandsApi {
  register(command: HadamardSlashCommandDefinition): HadamardSlashCommandHandle
  list(): HadamardSlashCommandDefinition[]
  execute(name: string, args: string): Promise<HadamardSlashCommandResult>
}
```

Formatters (for `/help`-style output):
- `formatHadamardAgents()` — registered agent definitions
- `formatHadamardSkills()` — registered skill definitions
- `formatHadamardTools()` — available tool catalog
- `formatHadamardContextOverview()` — session + memory state
- `formatHadamardCompactResult()` — last compaction details
- `formatHadamardDreamResult()` — last dream consolidation
- `formatHadamardMemoryState()` — memory file status

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
