export const ACTOVIQ_INTERACTIVE_COMMANDS: Record<string, string> = {
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
  bridge: 'Configure bridge runtimes (claude/pi/codex)',
  exit: 'Quit',
};

export function filterInteractiveCommands(input: string): string[] {
  if (!input.startsWith('/')) return [];
  const head = input.slice(1).split(/\s/, 1)[0] ?? '';
  if (input.includes(' ') && head.length > 0) return [];
  const partial = head.toLowerCase();
  return Object.keys(ACTOVIQ_INTERACTIVE_COMMANDS).filter((name) => name.startsWith(partial));
}
