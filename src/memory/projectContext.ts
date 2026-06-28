/**
 * Project context loader — mirrors Claude Code's CLAUDE.md memory hierarchy.
 *
 * Loads, in order (so nearer-to-cwd files append last):
 *   1. User memory:   `~/.claude/CLAUDE.md`
 *   2. Project memory: `CLAUDE.md` and `.claude/CLAUDE.md` at the working dir
 *      and each ancestor up to (but not including) the home directory.
 *
 * Each file may pull in other files via `@<path>` include lines (relative to
 * the file's own directory, recursive, cycle-safe). The combined context is
 * size-capped so a runaway CLAUDE.md can't blow the prompt.
 *
 * The result is injected into the system prompt so the agent picks up
 * project-specific instructions ("don't touch X", coding standards, etc.) —
 * the canonical Claude Code convention that the SDK previously ignored.
 */

import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_TOTAL_CHARS = 50_000;
const INCLUDE_RE = /^\s*@([\w./\\-]+)\s*$/;

function processIncludes(content: string, baseDir: string, seen: Set<string>): string {
  return content
    .split('\n')
    .map((line) => {
      const m = line.match(INCLUDE_RE);
      if (!m) return line;
      const includePath = path.resolve(baseDir, m[1]!);
      if (seen.has(includePath) || !existsSync(includePath)) return line;
      seen.add(includePath);
      try {
        const sub = readFileSync(includePath, 'utf-8');
        return processIncludes(sub, path.dirname(includePath), seen);
      } catch {
        return line;
      }
    })
    .join('\n');
}

function readContextFile(filePath: string, seen: Set<string>): string | null {
  if (seen.has(filePath) || !existsSync(filePath)) return null;
  seen.add(filePath);
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return processIncludes(raw, path.dirname(filePath), seen);
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
 * Load the CLAUDE.md hierarchy for a working directory. Returns an empty
 * `text` when no CLAUDE.md is present anywhere (the common case for arbitrary
 * dirs), so callers can no-op cheaply.
 */
export function loadProjectContext(workDir: string): LoadedProjectContext {
  const seen = new Set<string>();
  const parts: { label: string; content: string }[] = [];
  const home = os.homedir();

  // 1. User memory.
  const userFile = path.join(home, '.claude', 'CLAUDE.md');
  const userContent = readContextFile(userFile, seen);
  if (userContent?.trim()) parts.push({ label: '~/.claude/CLAUDE.md', content: userContent });

  // 2. Project memory — ancestors from farthest (just under home) to the cwd,
  //    so the cwd's own CLAUDE.md lands last (most prominent in the prompt).
  const ancestors: string[] = [];
  let dir = path.resolve(workDir);
  while (dir && dir !== home && path.dirname(dir) !== dir) {
    ancestors.unshift(dir);
    dir = path.dirname(dir);
  }
  for (const anc of ancestors) {
    for (const rel of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')]) {
      const f = path.join(anc, rel);
      const c = readContextFile(f, seen);
      if (c?.trim()) {
        const label = path.relative(home, f) || f;
        parts.push({ label, content: c });
      }
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
