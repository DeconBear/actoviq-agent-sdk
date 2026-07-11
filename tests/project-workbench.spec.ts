import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';

import {
  buildPathTree,
  gitStatusBadge,
  readWorkspaceFile,
  splitGitStatus,
} from '../src/gui/projectWorkbench.js';

describe('projectWorkbench helpers', () => {
  it('splits porcelain status into staged and unstaged', () => {
    const split = splitGitStatus([
      { x: 'M', y: '', file: 'staged.ts' },
      { x: '', y: 'M', file: 'unstaged.ts' },
      { x: 'M', y: 'M', file: 'both.ts' },
      { x: '?', y: '?', file: 'new.ts' },
    ]);
    expect(split.staged.map((e) => e.file)).toEqual(['staged.ts', 'both.ts']);
    expect(split.unstaged.map((e) => e.file)).toEqual(['unstaged.ts', 'both.ts', 'new.ts']);
  });

  it('builds a path tree with dirs before files', () => {
    const tree = buildPathTree([
      { file: 'src/a.ts', badge: 'M' },
      { file: 'src/util/b.ts', badge: 'A' },
      { file: 'readme.md', badge: 'M' },
    ]);
    expect(tree.map((n) => n.name)).toEqual(['src', 'readme.md']);
    expect(tree[0]?.kind).toBe('dir');
    expect(tree[0]?.children?.map((n) => n.name)).toEqual(['util', 'a.ts']);
    expect(tree[0]?.children?.[0]?.children?.[0]).toMatchObject({
      name: 'b.ts',
      relPath: 'src/util/b.ts',
      badge: 'A',
      kind: 'file',
    });
  });

  it('picks status badges for staged and unstaged sides', () => {
    expect(gitStatusBadge({ x: 'A', y: '', file: 'a' }, 'staged')).toBe('A');
    expect(gitStatusBadge({ x: '', y: 'D', file: 'a' }, 'unstaged')).toBe('D');
    expect(gitStatusBadge({ x: '?', y: '?', file: 'a' }, 'unstaged')).toBe('U');
  });

  it('reads workspace files and rejects path escape', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-files-'));
    const file = path.join(root, 'hello.txt');
    await writeFile(file, 'hello world', 'utf8');
    const ok = await readWorkspaceFile(file, root);
    expect(ok.text).toBe('hello world');
    expect(ok.binary).toBeUndefined();

    await expect(
      readWorkspaceFile(path.join(root, '..', 'outside.txt'), root),
    ).rejects.toThrow(/escapes workspace/);
  });

  it('marks binary files without returning text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-bin-'));
    const file = path.join(root, 'blob.bin');
    await writeFile(file, Buffer.from([0, 1, 2, 3, 4, 255, 0, 9]));
    const result = await readWorkspaceFile(file, root);
    expect(result.binary).toBe(true);
    expect(result.text).toBeUndefined();
  });

  it('gui source wires the five project tabs and workbench CSS', async () => {
    const src = await readFile(new URL('../src/gui/actoviqGui.ts', import.meta.url), 'utf8');
    expect(src).toContain("['git', 'Git']");
    expect(src).toContain("['terminal', 'Terminal']");
    expect(src).toContain("['files', 'Files']");
    expect(src).toContain('function renderProjectFilesPanel');
    expect(src).toContain('function renderProjectGitPanel');
    expect(src).toContain('function mountProjectTerminal');
    expect(src).toContain('/api/workspace-file');
    expect(src).toContain('/api/git/diff');
    expect(src).toContain('.project-files-split');
    expect(src).toContain('.project-git-split');
    expect(src).toContain('.tree-row');
  });
});
