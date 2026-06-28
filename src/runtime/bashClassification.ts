/**
 * Conservative read-only Bash command classifier.
 *
 * Goal (gap #12 vs claude-code): in `default` permission mode the TUI prompts
 * on EVERY Bash call, which is annoying for read-only commands (`ls`, `git
 * status`, `cat`). Claude Code auto-allows read-only commands and only prompts
 * on mutating/destructive ones. This classifier lets the TUI auto-approve a
 * small, high-confidence read-only set and leave everything else to prompt.
 *
 * Safety posture: when in doubt, return `false` (→ prompt). The only behavior
 * change is auto-approving commands in the explicit read-only set; nothing
 * becomes less safe. Any chaining operator, redirect, backgrounding, command
 * substitution, -exec, or -delete disqualifies a command from read-only, since
 * a second hidden command could mutate.
 */

/** True only for a small, unambiguous read-only command (no chaining/redirect). */
export function isReadOnlyBashCommand(command: string): boolean {
  const cmd = command.trim();
  if (cmd === '') return false;

  // Disqualify: chaining, piping, redirect, background, command substitution,
  // heredoc, or newline — a second command could hide behind these.
  if (/[;|&`]|\$\(|>>?|<<|\||&&|\|\||\n/.test(cmd)) return false;

  // Disqualify any destructive pattern anywhere in the command.
  if (DESTRUCTIVE_RE.test(cmd)) return false;

  const tokens = cmd.split(/\s+/);
  const first = basename((tokens[0] ?? '').toLowerCase());
  if (first === '') return false;

  if (SIMPLE_READ_ONLY.has(first)) {
    // `find -exec` / `find -delete` can mutate.
    if (first === 'find' && /-exec\b|--delete\b|-delete\b/.test(cmd)) return false;
    return true;
  }

  if (first === 'git') {
    const sub = (tokens[1] ?? '').toLowerCase();
    if (GIT_READ_ONLY_SUB.has(sub)) {
      // `git branch -D` is destructive (also caught by DESTRUCTIVE_RE, but be safe).
      if (sub === 'branch' && /-D\b|--delete\b|-d\b/.test(cmd)) return false;
      return true;
    }
    return false;
  }

  if (first === 'npm' || first === 'pnpm' || first === 'yarn') {
    const sub = (tokens[1] ?? '').toLowerCase();
    if (sub.startsWith('-')) return true; // e.g. npm --version
    if (PKG_READ_ONLY_SUB.has(sub)) return true;
    return false;
  }

  if (first === 'node' || first === 'tsx' || first === 'tsc' || first === 'npx') {
    const sub = tokens[1] ?? '';
    // `node --version` / `-v` etc. only; running a script is not read-only.
    if (sub.startsWith('-') && /v|version|help/.test(sub)) return true;
    return false;
  }

  return false;
}

function basename(token: string): string {
  const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return slash >= 0 ? token.slice(slash + 1) : token;
}

const SIMPLE_READ_ONLY = new Set([
  'ls', 'll', 'la', 'dir', 'cat', 'pwd', 'echo', 'printf', 'head', 'tail',
  'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'file', 'stat', 'which',
  'where', 'whoami', 'date', 'env', 'printenv', 'uname', 'hostname', 'true',
  'false', 'test', 'tty', 'id', 'uptime', 'locale',
]);

const GIT_READ_ONLY_SUB = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'blame',
  'ls-files', 'shortlog', 'describe', 'reflog', 'name-rev', 'grep',
]);

const PKG_READ_ONLY_SUB = new Set([
  'ls', 'view', 'outdated', 'info', 'root', 'list', 'why', 'audit',
]);

const DESTRUCTIVE_RE =
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\brm\s+-rf\b|rmdir\b|git\s+push\b.*(?:--force|-f\b)|git\s+reset\s+--hard|git\s+clean\b.*-f|git\s+branch\s+-D|mkfs\b|\bdd\b|chmod\s+777|chown\s+-R|>\s*\/dev\/(?:sd|nvme|hd)|\bshutdown\b|\breboot\b/i;
