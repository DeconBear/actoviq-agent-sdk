export const ACTOVIQ_INTERACTIVE_COMMANDS: Record<string, string> = {
  help: 'Show available commands',
  clear: 'Clear the screen',
  init: 'Generate a CLAUDE.md for this project',
  compact: 'Compact the current session',
  memory: 'Show memory/compact state',
  context: 'Show what is in the context window',
  cost: 'Show running token + spend totals',
  usage: 'Alias for /cost',
  doctor: 'Run configuration diagnostics',
  batch: 'Run multiple prompts from a file sequentially',
  goal: 'Set or view a session goal with status tracking',
  review: 'Review the current git diff for correctness',
  stats: 'Show session statistics',
  export: 'Export the conversation as Markdown',
  model: 'Select a model or configure its provider',
  effort: 'Select the reasoning effort',
  'output-style': 'Select the response output style',
  permissions: 'Show or set the permission mode',
  plan: 'Enter plan mode or view the current plan',
  rewind: 'Rewind the conversation by N messages',
  sessions: 'List stored sessions',
  resume: 'Resume a stored session',
  tools: 'List available tools',
  skills: 'Browse available skills',
  agents: 'Browse subagent definitions and execution runs',
  mcp: 'Inspect MCP servers and tools',
  hooks: 'List configured PreToolUse hooks',
  plugins: 'Browse discovered Clean plugins',
  dream: 'Inspect or run memory consolidation',
  workflows: 'Browse saved dynamic workflows',
  worktree: 'Enter, exit, or list git worktrees',
  team: 'List, attach, or run Model Team definitions (Graph = collab DAG; Workflow = light tree; blocks ≠ second engine)',
  issues: 'List or update project issues',
  manager: 'Project Manager: progress docs + project chat',
  bridge: 'Configure API bridges and external CLI runtimes',
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
  bridge: [
    'run',
    'background',
    'runs',
    'stop',
    'status',
    'history',
    'resume',
    'switch',
    'model',
    'config',
    'setup',
    'off',
    'help',
  ],
  model: ['router', 'config'],
  team: ['ask', 'list', 'attach', 'off', 'status', 'clone'],
  issues: ['list', 'show', 'create', 'start', 'review', 'done', 'block'],
  manager: ['chat', 'update', 'status', 'config', 'schedule'],
  worktree: ['enter', 'exit', 'list'],
  workflows: ['list', 'run'],
  agents: ['list', 'runs', 'show', 'open'],
  dream: ['run', 'status'],
  permissions: ['read-only', 'workspace', 'full'],
};

/** Description-column text for sub-commands, keyed by `${head} ${sub}`. */
export const SUBCOMMAND_DESCRIPTIONS: Record<string, string> = {
  'bridge run': 'Run a prompt through the bridge CLI',
  'bridge background': 'Start work in the active external CLI runtime',
  'bridge runs': 'List external CLI background runs',
  'bridge stop': 'Stop an external CLI background run by id',
  'bridge status': 'Show the active bridge/runtime state',
  'bridge history': 'List or inspect native conversations for the active external CLI',
  'bridge resume': 'Resume a native conversation in the active external CLI',
  'bridge switch': 'Activate a saved config by name (or a raw provider id)',
  'bridge model': 'Set the model for the current provider',
  'bridge config': 'Add / edit / remove named connection configs',
  'bridge setup': 'Detect + configure runtimes',
  'bridge off': 'Disable bridge mode',
  'bridge help': 'Show /bridge sub-commands',
  'model router': 'Pick a leader/dispatch router profile',
  'model config': 'Edit provider / keys / model tiers',
  'team ask': 'Ask a named team a prompt',
  'team list': 'List built-in + saved team definitions',
  'team attach': 'Attach a team to this conversation',
  'team off': 'Detach the current team',
  'team status': 'Show attach state, autoInvoke, and last run',
  'team clone': 'Clone a team (built-in presets stay immutable)',
  'issues list': 'List project issues',
  'issues create': 'Create a project issue',
  'issues show': 'Show issue details and its manager brief',
  'issues start': 'Decompose and dispatch an issue to an agent profile',
  'issues review': 'Move an issue into review',
  'issues done': 'Mark an issue done',
  'issues block': 'Block an in-progress issue',
  'manager chat': 'Chat with the Project Manager (progress, priorities)',
  'manager update': 'Update progress docs from recent activity',
  'manager status': 'Show manager config + last progress update',
  'manager config': 'Show or set manager configuration',
  'manager schedule': 'List manager scheduled tasks',
  'worktree enter': 'Enter a git worktree',
  'worktree exit': 'Exit the current worktree',
  'worktree list': 'List worktrees',
  'workflows list': 'List saved workflows',
  'workflows run': 'Run a saved workflow',
  'agents list': 'Browse registered subagent definitions',
  'agents runs': 'Browse active and completed Agent execution trees',
  'agents show': 'Show one Agent execution tree and choose a conversation',
  'agents open': 'Open an Agent or subagent conversation by session or execution id',
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
  if (subs.includes(partialSub)) return [`${head.toLowerCase()} ${partialSub}`];
  return subs.filter((sub) => sub.startsWith(partialSub)).map((sub) => `${head.toLowerCase()} ${sub}`);
}

/** Resolve the command submitted by Enter from the current completion menu. */
export function selectInteractiveCommand(input: string, selectedIndex = 0): string | undefined {
  const matches = filterInteractiveCommands(input);
  if (matches.length === 0) return undefined;
  const index = Math.max(0, Math.min(selectedIndex, matches.length - 1));
  return `/${matches[index]!}`;
}
