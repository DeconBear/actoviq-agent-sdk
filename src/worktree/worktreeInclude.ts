/**
 * .worktreeinclude parser — .gitignore-syntax file listing files
 * that should be copied from the main checkout into new worktrees.
 * These are typically gitignored files like .env, config/secrets.json.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse a .worktreeinclude file, returning the list of patterns.
 * Empty lines and lines starting with # are ignored.
 */
export async function parseWorktreeInclude(filePath: string): Promise<string[]> {
  const content = await fs.promises.readFile(filePath, 'utf-8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Check if a file path matches a .worktreeinclude pattern.
 * Supports gitignore-style syntax: *, **, ?, leading /.
 */
export function matchesPattern(filePath: string, pattern: string): boolean {
  const regex = patternToRegex(pattern);
  return regex.test(filePath);
}

function patternToRegex(pattern: string): RegExp {
  // .gitignore semantics:
  // - / at start → anchored
  // - / at end → directory marker
  // - ** → matches across directories
  // - *  → matches anything except /
  // - ?  → matches single character except /

  let anchored = false;
  let p = pattern;

  if (p.startsWith('/')) {
    anchored = true;
    p = p.slice(1);
  }

  // Strip trailing / (directory marker)
  const isDir = p.endsWith('/');
  if (isDir) p = p.slice(0, -1);

  // Escape regex specials, then unescape our patterns
  let escaped = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00GLOBSTAR\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\x00GLOBSTAR\x00/g, '.*');

  let regexStr: string;
  if (anchored) {
    regexStr = '^' + escaped;
  } else {
    regexStr = '(^|.*/)' + escaped;
  }

  if (isDir) {
    regexStr += '(/.*)?$';
  } else {
    regexStr += '$';
  }

  return new RegExp(regexStr);
}
