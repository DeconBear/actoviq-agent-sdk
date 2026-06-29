/**
 * Project context loader (CLAUDE.md / AGENTS.md hierarchy).
 *
 * Aligned with Claude Code's discovery rules (`src/utils/claudemd.ts`) and
 * Codex's AGENTS.md fallback, kept lightweight:
 *
 *  1. Managed (system) — not applicable for the SDK; skipped.
 *  2. User memory:      `~/.claude/CLAUDE.md`
 *  3. Project memory:   `CLAUDE.md`, `.claude/CLAUDE.md`,
 *                       `.claude/rules/*.md`, `AGENTS.md` at the
 *                       working dir and each ancestor up to (but not
 *                       including) the home directory.
 *  4. Local (private):  `CLAUDE.local.md` in the same ancestor walk.
 *
 * Each file may pull in other files via `@<path>` include lines (relative to
 * the file's own directory; `@~/path` resolves from the home directory).
 * Include depth is capped at 5 to prevent cycles. The combined context is
 * size-capped so a runaway instruction file can't blow the prompt.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_TOTAL_CHARS = 50_000;
const MAX_INCLUDE_DEPTH = 5;
// Matches: @relative/path, @./path, @~/path, @/absolute/path
const INCLUDE_RE = /^\s*@(?:\.\/|~\/|\/)?([^\s]+)\s*$/;

/**
 * Resolve an `@path` include reference.  `@~/x` maps to `~/x`;
 * `@/x` is absolute; otherwise relative to `baseDir`.
 */
function resolveInclude(raw: string, baseDir: string): string | null {
  const m = raw.trim().match(INCLUDE_RE);
  if (!m) return null;
  let target = m[1]!;
  if (raw.trim().startsWith('@~/')) {
    target = path.join(os.homedir(), target);
  } else if (raw.trim().startsWith('@/')) {
    target = path.resolve('/' + target);
  } else {
    target = path.resolve(baseDir, raw.trim().startsWith('@./') ? target : m[1]!);
  }
  return target;
}

function processIncludes(
  content: string,
  baseDir: string,
  seen: Set<string>,
  depth: number,
): string {
  if (depth >= MAX_INCLUDE_DEPTH) return content;
  return content
    .split('\n')
    .map((line) => {
      const target = resolveInclude(line, baseDir);
      if (!target || seen.has(target) || !existsSync(target)) return line;
      seen.add(target);
      try {
        const sub = readFileSync(target, 'utf-8');
        return processIncludes(sub, path.dirname(target), seen, depth + 1);
      } catch {
        return line;
      }
    })
    .join('\n');
}

function readContextFile(
  filePath: string,
  seen: Set<string>,
  depth = 0,
): string | null {
  if (seen.has(filePath) || !existsSync(filePath)) return null;
  seen.add(filePath);
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return processIncludes(raw, path.dirname(filePath), seen, depth);
  } catch {
    return null;
  }
}

export interface LoadedProjectContext {
  /** The assembled, size-capped context text (empty if nothing was found). */
  text: string;
  /** Human-readable labels of the files that contributed, for display. */
  sources: string[];
}

/**
 * Load the CLAUDE.md / AGENTS.md hierarchy for a working directory.
 * Returns an empty `text` when nothing is found (the common case for
 * arbitrary dirs), so callers can no-op cheaply.
 */
export function loadProjectContext(workDir: string): LoadedProjectContext {
  const seen = new Set<string>();
  const parts: { label: string; content: string }[] = [];
  const home = os.homedir();

  // 1. User memory — ~/.claude/CLAUDE.md (Claude Code convention).
  const userFile = path.join(home, '.claude', 'CLAUDE.md');
  const userContent = readContextFile(userFile, seen);
  if (userContent?.trim()) parts.push({ label: '~/.claude/CLAUDE.md', content: userContent });

  // 2. Project + local memory — walk from farthest ancestor (just under home)
  //    to the cwd so the cwd's own files land last (most prominent).
  const ancestors: string[] = [];
  let dir = path.resolve(workDir);
  while (dir && dir !== home && path.dirname(dir) !== dir) {
    ancestors.unshift(dir);
    dir = path.dirname(dir);
  }

  for (const anc of ancestors) {
    // Project: canonical names (Claude Code + Codex fallback).
    for (const rel of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'AGENTS.md']) {
      const f = path.join(anc, rel);
      const c = readContextFile(f, seen);
      if (c?.trim()) {
        const label = path.relative(home, f) || f;
        parts.push({ label, content: c });
      }
    }

    // Project: .claude/rules/*.md (Claude Code convention).
    const rulesDir = path.join(anc, '.claude', 'rules');
    try {
      const entries = readRuleEntries(rulesDir);
      for (const entry of entries) {
        const c = readContextFile(entry, seen);
        if (c?.trim()) {
          const label = path.relative(home, entry) || entry;
          parts.push({ label, content: c });
        }
      }
    } catch {
      // rules dir may not exist — that's fine.
    }

    // Local: user-private, not checked into the repo (Claude Code convention).
    const localFile = path.join(anc, 'CLAUDE.local.md');
    const localContent = readContextFile(localFile, seen);
    if (localContent?.trim()) {
      const label = path.relative(home, localFile) || localFile;
      parts.push({ label, content: localContent });
    }
  }

  if (parts.length === 0) return { text: '', sources: [] };

  const sources = parts.map((p) => p.label);
  let used = 0;
  const sections: string[] = [];
  for (const p of parts) {
    if (used >= MAX_TOTAL_CHARS) {
      sections.push(`## ${p.label}\n\n<!-- omitted: project-context size cap reached -->`);
      continue;
    }
    let content = p.content;
    const remaining = MAX_TOTAL_CHARS - used;
    if (content.length > remaining) {
      content = content.slice(0, remaining) + '\n<!-- truncated: project-context size cap -->';
    }
    sections.push(`## ${p.label}\n\n${content}`);
    used += content.length;
  }
  return { text: sections.join('\n\n'), sources };
}

// ── Rule directory helper ────────────────────────────────────────────────

function readRuleEntries(rulesDir: string): string[] {
  const paths: string[] = [];
  // Only process files directly inside rules/ (no recursion into subdirs).
  const dirents = readDirSafe(rulesDir);
  for (const name of dirents) {
    if (!name.endsWith('.md')) continue;
    paths.push(path.join(rulesDir, name));
  }
  paths.sort(); // deterministic order
  return paths;
}

function readDirSafe(dirPath: string): string[] {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}
