import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadProjectContext } from '../src/memory/projectContext.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('loadProjectContext', () => {
  it('does not fabricate project context for a dir with no CLAUDE.md', () => {
    const missing = path.join(os.tmpdir(), 'nonexistent-actoviq-ctx-12345');
    const result = loadProjectContext(missing);
    // No source should reference the (missing) working directory.
    expect(result.sources.find(s => s.includes('nonexistent-actoviq-ctx-12345'))).toBeUndefined();
  });

  it('loads a project CLAUDE.md from the working directory', async () => {
    const dir = await makeTempDir('ctx-proj-');
    await writeFile(path.join(dir, 'CLAUDE.md'), '# Rules\n\n- Use TypeScript.\n- Do not touch src/generated/.\n');
    const result = loadProjectContext(dir);
    // The project file appears as a source ending in CLAUDE.md (label is
    // relative to home; allow the user-global ~/.claude/CLAUDE.md too).
    expect(result.sources.find(s => s.endsWith('CLAUDE.md') && s !== '~/.claude/CLAUDE.md')).toBeDefined();
    expect(result.text).toContain('Use TypeScript.');
    expect(result.text).toContain('Do not touch src/generated/');
  });

  it('loads a nested .claude/CLAUDE.md', async () => {
    const dir = await makeTempDir('ctx-nested-');
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(dir, '.claude', 'CLAUDE.md'), 'Nested rules go here.\n');
    const result = loadProjectContext(dir);
    expect(result.text).toContain('Nested rules go here.');
    expect(result.sources.find(s => s.endsWith(path.join('.claude', 'CLAUDE.md')))).toBeDefined();
  });

  it('inlines @path includes relative to the file', async () => {
    const dir = await makeTempDir('ctx-incl-');
    await writeFile(path.join(dir, 'standards.md'), '# Coding standards\n\n- 2-space indent.\n');
    await writeFile(path.join(dir, 'CLAUDE.md'), 'Project rules.\n\n@standards.md\n');
    const result = loadProjectContext(dir);
    expect(result.text).toContain('Project rules.');
    expect(result.text).toContain('2-space indent.');
  });

  it('guards against @include cycles', async () => {
    const dir = await makeTempDir('ctx-cycle-');
    await writeFile(path.join(dir, 'CLAUDE.md'), 'A\n\n@CLAUDE.md\n');
    // Should not hang; the cycle is detected and the self-include is skipped.
    const result = loadProjectContext(dir);
    expect(result.text).toContain('A');
  });

  it('walks ancestor CLAUDE.md files (nearest-to-cwd last)', async () => {
    const root = await makeTempDir('ctx-walk-');
    const child = path.join(root, 'pkg');
    await mkdir(child, { recursive: true });
    await writeFile(path.join(root, 'CLAUDE.md'), 'ROOT RULE\n');
    await writeFile(path.join(child, 'CLAUDE.md'), 'CHILD RULE\n');
    const result = loadProjectContext(child);
    expect(result.text).toContain('ROOT RULE');
    expect(result.text).toContain('CHILD RULE');
    // Child (cwd) appends after root.
    expect(result.text.indexOf('CHILD RULE')).toBeGreaterThan(result.text.indexOf('ROOT RULE'));
  });
});
