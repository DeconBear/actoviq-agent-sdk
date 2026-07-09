import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultActoviqHome,
  getActoviqHomePointerPath,
  migrateActoviqHomeData,
  resolveActoviqHome,
  summarizeActoviqHome,
  writeActoviqHomePointer,
} from '../src/config/actoviqHome.js';

const tempDirs: string[] = [];
const previousActoviqHome = process.env.ACTOVIQ_HOME;

afterEach(async () => {
  if (previousActoviqHome === undefined) delete process.env.ACTOVIQ_HOME;
  else process.env.ACTOVIQ_HOME = previousActoviqHome;
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('actoviqHome', () => {
  it('keeps explicit homeDir compatibility by appending .actoviq', async () => {
    const home = await tempRoot('actoviq-home-compat-');
    expect(resolveActoviqHome(home)).toBe(path.join(home, '.actoviq'));
    expect(resolveActoviqHome(path.join(home, '.actoviq'))).toBe(path.join(home, '.actoviq'));
  });

  it('uses ACTOVIQ_HOME as a direct data root', async () => {
    const dataRoot = await tempRoot('actoviq-home-env-');
    process.env.ACTOVIQ_HOME = dataRoot;
    expect(resolveActoviqHome()).toBe(path.resolve(dataRoot));
    expect(resolveActoviqHome(dataRoot)).toBe(path.resolve(dataRoot));
  });

  it('uses the bootstrap pointer when no explicit root is provided', async () => {
    const osHomeDir = await tempRoot('actoviq-home-pointer-os-');
    const targetRoot = await tempRoot('actoviq-home-pointer-data-');
    process.env.ACTOVIQ_HOME = path.join(osHomeDir, 'ignored-env-root');
    await writeActoviqHomePointer(targetRoot, osHomeDir);

    const pointer = JSON.parse(await readFile(getActoviqHomePointerPath(osHomeDir), 'utf8')) as { root: string };
    expect(pointer.root).toBe(path.resolve(targetRoot));
    expect(defaultActoviqHome(osHomeDir)).toBe(path.join(osHomeDir, '.actoviq'));
    expect(resolveActoviqHome(undefined, { osHomeDir, env: {} })).toBe(path.resolve(targetRoot));
    expect(resolveActoviqHome(targetRoot, { osHomeDir, env: {} })).toBe(path.resolve(targetRoot));
  });

  it('migrates data into an empty target and writes a pointer', async () => {
    const osHomeDir = await tempRoot('actoviq-home-migrate-os-');
    const sourceRoot = path.join(osHomeDir, '.actoviq');
    const targetRoot = path.join(await tempRoot('actoviq-home-migrate-target-parent-'), 'actoviq-data');
    await mkdir(path.join(sourceRoot, 'projects', 'demo'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'settings.json'), '{"ok":true}\n', 'utf8');
    await writeFile(path.join(sourceRoot, 'projects', 'demo', 'note.txt'), 'hello', 'utf8');

    const before = summarizeActoviqHome(sourceRoot);
    const result = await migrateActoviqHomeData({ sourceRoot, targetRoot, osHomeDir });

    expect(result.sourceRoot).toBe(path.resolve(sourceRoot));
    expect(result.targetRoot).toBe(path.resolve(targetRoot));
    expect(result.entries).toBe(before.entries);
    expect(result.bytes).toBe(before.bytes);
    await expect(readFile(path.join(targetRoot, 'settings.json'), 'utf8')).resolves.toContain('ok');
    await expect(readFile(path.join(targetRoot, 'projects', 'demo', 'note.txt'), 'utf8')).resolves.toBe('hello');

    const pointer = JSON.parse(await readFile(getActoviqHomePointerPath(osHomeDir), 'utf8')) as { root: string };
    expect(pointer.root).toBe(path.resolve(targetRoot));
  });

  it('rejects non-empty migration targets', async () => {
    const sourceRoot = await tempRoot('actoviq-home-source-');
    const targetRoot = await tempRoot('actoviq-home-target-');
    await writeFile(path.join(targetRoot, 'existing.txt'), 'x', 'utf8');

    await expect(migrateActoviqHomeData({ sourceRoot, targetRoot })).rejects.toThrow('must be empty');
  });
});
