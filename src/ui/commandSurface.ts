export const HADAMARD_INTERACTIVE_COMMANDS: Record<string, string> = {
  help: 'Show available commands',
  clear: 'Clear the screen',
  init: 'Generate a CLAUDE.md for this project',
  compact: 'Compact the current session',
  memory: 'Show memory/compact state',
  rules: 'Manage user, project, and path-scoped context rules',
  context: 'Show what is in the context window',
  cost: 'Show running token + spend totals',
  usage: 'Alias for /cost',
  doctor: 'Run configuration diagnostics',
  batch: 'Run multiple prompts from a file sequentially',
  goal: 'Set or view a session goal with status tracking',
  review: 'Review the current git diff for correctness',
  diff: 'Show or apply the current Session worktree diff',
  stats: 'Show session statistics',
  export: 'Export the conversation as Markdown',
  model: 'Select a model or configure its provider',
  effort: 'Select the reasoning effort',
  'output-style': 'Select the response output style',
  permissions: 'Show or set the permission mode',
  plan: 'Enter, review, approve, or revise the current plan',
  rewind: 'Rewind the conversation by N messages',
  checkpoint: 'List, preview, or restore file/conversation checkpoints',
  sessions: 'List stored sessions',
  session: 'Rename, pin, archive, restore, or delete a Session',
  resume: 'Resume a stored session',
  tools: 'List available tools',
  skills: 'Browse available skills',
  agents: 'Browse subagent definitions and execution runs',
  mcp: 'Inspect MCP servers and tools',
  hooks: 'List configured PreToolUse hooks',
  plugins: 'Browse discovered Clean plugins',
  plugin: 'Manage versioned plugin packages and trust',
  dream: 'Inspect or run memory consolidation',
  workflows: 'Browse saved dynamic workflows',
  worktree: 'Enter, exit, or list git worktrees',
  team: 'List, attach, or run Model Team definitions (Graph = collab DAG; Workflow = light tree; blocks ≠ second engine)',
  issues: 'List or update project issues',
  manager: 'Project Manager: progress docs + project chat',
  assistant: 'Global Assistant: cross-project chat, Sessions, and Team proposals',
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
  manager: ['chat', 'update', 'status', 'config', 'schedule', 'sessions', 'new', 'resume', 'team'],
  assistant: ['chat', 'sessions', 'new', 'resume', 'team'],
  session: ['tree', 'fork', 'clone', 'label', 'rename', 'pin', 'archive', 'restore', 'delete'],
  worktree: ['enter', 'exit', 'list'],
  workflows: ['list', 'run'],
  agents: ['list', 'runs', 'show', 'open'],
  dream: ['run', 'status'],
  permissions: ['read-only', 'workspace', 'full'],
  plan: ['view', 'approve', 'revise', 'off'],
  checkpoint: ['list', 'show', 'restore'],
  diff: ['show', 'apply'],
  plugin: ['list', 'search', 'install', 'update', 'pin', 'enable', 'disable', 'remove', 'trust'],
  rules: ['list', 'add', 'remove', 'enable', 'disable'],
  memory: ['proposals', 'apply', 'reject'],
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
  'manager sessions': 'List Project Manager conversations',
  'manager new': 'Create and select a Project Manager conversation',
  'manager resume': 'Select a Project Manager conversation by id',
  'manager team': 'Ask the Project Manager to propose a Team graph',
  'assistant chat': 'Chat with the Global Assistant',
  'assistant sessions': 'List Global Assistant conversations',
  'assistant new': 'Create and select a Global Assistant conversation',
  'assistant resume': 'Select a Global Assistant conversation by id',
  'assistant team': 'Ask the Global Assistant to propose a Team graph',
  'session rename': 'Atomically set a manual Session title',
  'session pin': 'Pin or unpin a Session',
  'session archive': 'Archive an idle Session',
  'session restore': 'Restore an archived Session',
  'session delete': 'Permanently delete an archived Session',
  'session tree': 'Show parent/child conversation branches',
  'session fork': 'Fork the current conversation at a stable message id',
  'session clone': 'Clone the full current conversation into a new branch',
  'session label': 'Set the current conversation branch label',
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
  'plan view': 'Show the current plan without changing mode',
  'plan approve': 'Approve the current plan and leave read-only Plan mode',
  'plan revise': 'Keep Plan mode active and request changes to the plan',
  'plan off': 'Leave Plan mode without approving the plan',
  'checkpoint list': 'List checkpoints for the current Session',
  'checkpoint show': 'Preview files and conflicts for a checkpoint',
  'checkpoint restore': 'Restore after preview with an explicit --confirm flag',
  'diff show': 'Show the structured diff for the current Session worktree',
  'diff apply': 'Apply the Session diff to its clean source tree with --confirm',
  'plugin list': 'List installed versioned plugin packages',
  'plugin search': 'Search the configured plugin registry',
  'plugin install': 'Install a local plugin package directory',
  'plugin update': 'Install a newer local plugin package version',
  'plugin pin': 'Pin a plugin to an installed version',
  'plugin enable': 'Enable an installed plugin package',
  'plugin disable': 'Disable an installed plugin package',
  'plugin remove': 'Remove a plugin package',
  'plugin trust': 'Trust one exact plugin version and capability set',
  'rules list': 'List active and disabled context rules',
  'rules add': 'Add a user, project, or path-scoped rule',
  'rules remove': 'Remove a context rule',
  'rules enable': 'Enable a context rule',
  'rules disable': 'Disable a context rule',
  'memory proposals': 'List pending reviewed memory proposals',
  'memory apply': 'Apply a proposal after explicit --confirm',
  'memory reject': 'Reject a proposal without changing memory',
};

export function filterInteractiveCommands(input: string): string[] {
  if (!input.startsWith('/')) return [];
  const rest = input.slice(1);
  const head = rest.split(/\s/, 1)[0] ?? '';

  // No space yet: complete the top-level command name.
  if (!input.includes(' ')) {
    const partial = head.toLowerCase();
    return Object.keys(HADAMARD_INTERACTIVE_COMMANDS).filter((name) => name.startsWith(partial));
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
