export const ACTOVIQ_INTERACTIVE_COMMANDS: Record<string, string> = {
  help: 'Show available commands',
  clear: 'Clear the screen',
  init: 'Generate a CLAUDE.md for this project',
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
  bridge: 'Configure / run bridge runtimes (6 providers)',
  exit: 'Quit',
};

/**
 * Sub-commands offered for completion once a top-level command is committed
 * (e.g. `/bridge ` → `run`/`switch`/…). Only commands that take a known
 * second word are listed; bare-action commands (`/clear`, `/compact`, …)
 * intentionally have no entries, so typing a space after them closes the
 * menu and lets the user type freely.
 */
export const SUBCOMMANDS: Record<string, string[]> = {
  bridge: ['run', 'switch', 'model', 'setup', 'off', 'help'],
  model: ['router', 'config'],
  team: ['ask', 'list'],
  worktree: ['enter', 'exit', 'list'],
  workflows: ['list', 'run'],
  dream: ['run', 'status'],
  permissions: ['read-only', 'workspace', 'full'],
};

/** Description-column text for sub-commands, keyed by `${head} ${sub}`. */
export const SUBCOMMAND_DESCRIPTIONS: Record<string, string> = {
  'bridge run': 'Run a prompt through the bridge CLI',
  'bridge switch': 'Activate a different provider',
  'bridge model': 'Set the model for the current provider',
  'bridge setup': 'Detect + configure runtimes',
  'bridge off': 'Disable bridge mode',
  'bridge help': 'Show /bridge sub-commands',
  'model router': 'Pick a leader/dispatch router profile',
  'model config': 'Edit provider / keys / model tiers',
  'team ask': 'Ask a named team a prompt',
  'team list': 'List saved team definitions',
  'worktree enter': 'Enter a git worktree',
  'worktree exit': 'Exit the current worktree',
  'worktree list': 'List worktrees',
  'workflows list': 'List saved workflows',
  'workflows run': 'Run a saved workflow',
  'dream run': 'Run memory consolidation',
  'dream status': 'Show dream state',
  'permissions read-only': 'Read-only preset',
  'permissions workspace': 'Auto-approve in-workspace edits',
  'permissions full': 'Bypass all permission prompts',
};

export function filterInteractiveCommands(input: string): string[] {
  if (!input.startsWith('/')) return [];
  const rest = input.slice(1);
  const head = rest.split(/\s/, 1)[0] ?? '';

  // No space yet: complete the top-level command name.
  if (!input.includes(' ')) {
    const partial = head.toLowerCase();
    return Object.keys(ACTOVIQ_INTERACTIVE_COMMANDS).filter((name) => name.startsWith(partial));
  }

  // A space is present. Offer sub-commands only for commands that have them,
  // and only while the user is still choosing the sub-command (no second
  // space yet). Once a second space appears the sub-command is committed and
  // the user is typing the argument/prompt — close the menu.
  const subs = SUBCOMMANDS[head.toLowerCase()];
  if (!subs) return [];
  const afterHead = rest.slice(head.length + 1);
  if (afterHead.includes(' ')) return [];
  const partialSub = afterHead.toLowerCase();
  return subs.filter((sub) => sub.startsWith(partialSub)).map((sub) => `${head.toLowerCase()} ${sub}`);
}
