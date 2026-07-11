import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';

import {
  buildPathTree,
  gitStatusBadge,
  parseGitCommitLog,
  readWorkspaceFile,
  splitGitStatus,
  writeWorkspaceFile,
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

  it('parses enriched git log records with refs and dates', () => {
    const raw = [
      'abc123\x1fFix login\x1fAda\x1fada@ex.com\x1f2 hours ago\x1f2026-07-11T12:00:00+08:00\x1fdef456 ghi789\x1fHEAD -> main, origin/main, tag: v1.2.0\x1e',
      'def456\x1fBase\x1fBob\x1fbob@ex.com\x1f1 day ago\x1f2026-07-10T09:00:00+08:00\x1f\x1f\x1e',
    ].join('');
    const commits = parseGitCommitLog(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      hash: 'abc123',
      subject: 'Fix login',
      author: 'Ada',
      authorEmail: 'ada@ex.com',
      relativeDate: '2 hours ago',
      absoluteDate: '2026-07-11T12:00:00+08:00',
      date: '2 hours ago',
      parents: ['def456', 'ghi789'],
    });
    expect(commits[0]?.refs).toEqual([
      { name: 'HEAD', kind: 'head' },
      { name: 'main', kind: 'local' },
      { name: 'origin/main', kind: 'remote' },
      { name: 'v1.2.0', kind: 'tag' },
    ]);
    expect(commits[1]?.parents).toEqual([]);
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

  it('writes text files only within the workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-write-'));
    const file = path.join(root, 'hello.txt');
    await writeFile(file, 'before', 'utf8');

    await expect(writeWorkspaceFile(file, 'after', root)).resolves.toMatchObject({
      path: file,
      size: 5,
    });
    await expect(readFile(file, 'utf8')).resolves.toBe('after');
    await expect(writeWorkspaceFile('hello.txt', 'relative-ok', root)).resolves.toMatchObject({
      size: Buffer.byteLength('relative-ok', 'utf8'),
    });
    await expect(readFile(file, 'utf8')).resolves.toBe('relative-ok');
    await expect(
      writeWorkspaceFile(path.join(root, '..', 'outside.txt'), 'nope', root),
    ).rejects.toThrow(/escapes workspace/);
  });

  it('reads declaration files as editable text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-dts-'));
    const file = path.join(root, 'actoviqSettingsStore.d.ts');
    await writeFile(file, 'export declare const x: number;\n', 'utf8');
    const ok = await readWorkspaceFile(file, root);
    expect(ok.binary).toBeUndefined();
    expect(ok.text).toContain('export declare');
  });

  it('refuses writes to binary workspace files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-write-bin-'));
    const file = path.join(root, 'blob.bin');
    await writeFile(file, Buffer.from([0, 1, 2, 3, 4, 255, 0, 9]));

    await expect(writeWorkspaceFile(file, 'nope', root)).rejects.toThrow(/binary file/);
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
    expect(src).toContain('function saveFilesPreview');
    expect(src).toContain("method: 'PUT'");
    expect(src).toContain('detectEditorLanguage');
    expect(src).toContain('highlightCode');
    expect(src).toContain('files-preview-modes');
    expect(src).toContain('files-hl-overlay');
    expect(src).toContain('files-md-preview');
    expect(src).toContain('/api/git/diff');
    expect(src).toContain('.project-files-split');
    expect(src).toContain('.project-git-split');
    expect(src).toContain('.tree-row');
    expect(src).toContain('parseGitCommitLog');
    expect(src).toContain('.git-history-ref');
    expect(src).toContain('.git-history-graph');
    expect(src).toContain('relativeDate');
    expect(src).toContain('history: false');
  });
});
