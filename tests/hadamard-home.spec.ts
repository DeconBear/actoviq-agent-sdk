import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultHadamardHome,
  getHadamardHomePointerPath,
  listHadamardHomeTopLevelEntries,
  migrateHadamardHomeData,
  migrateLegacyProjectActoviqDirIfNeeded,
  resolveHadamardHome,
  summarizeHadamardHome,
  writeHadamardHomePointer,
} from '../src/config/hadamardHome.js';

const tempDirs: string[] = [];
const previousHadamardHome = process.env.HADAMARD_HOME;

afterEach(async () => {
  if (previousHadamardHome === undefined) delete process.env.HADAMARD_HOME;
  else process.env.HADAMARD_HOME = previousHadamardHome;
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('hadamardHome', () => {
  it('keeps explicit homeDir compatibility by appending .hadamard', async () => {
    const home = await tempRoot('hadamard-home-compat-');
    expect(resolveHadamardHome(home)).toBe(path.join(home, '.hadamard'));
    expect(resolveHadamardHome(path.join(home, '.hadamard'))).toBe(path.join(home, '.hadamard'));
  });

  it('uses HADAMARD_HOME as a direct data root', async () => {
    const dataRoot = await tempRoot('hadamard-home-env-');
    process.env.HADAMARD_HOME = dataRoot;
    expect(resolveHadamardHome()).toBe(path.resolve(dataRoot));
    expect(resolveHadamardHome(dataRoot)).toBe(path.resolve(dataRoot));
  });

  it('uses the bootstrap pointer when no explicit root is provided', async () => {
    const osHomeDir = await tempRoot('hadamard-home-pointer-os-');
    const targetRoot = await tempRoot('hadamard-home-pointer-data-');
    process.env.HADAMARD_HOME = path.join(osHomeDir, 'ignored-env-root');
    await writeHadamardHomePointer(targetRoot, osHomeDir);

    const pointer = JSON.parse(await readFile(getHadamardHomePointerPath(osHomeDir), 'utf8')) as { root: string };
    expect(pointer.root).toBe(path.resolve(targetRoot));
    expect(defaultHadamardHome(osHomeDir)).toBe(path.join(osHomeDir, '.hadamard'));
    expect(resolveHadamardHome(undefined, { osHomeDir, env: {} })).toBe(path.resolve(targetRoot));
    expect(resolveHadamardHome(targetRoot, { osHomeDir, env: {} })).toBe(path.resolve(targetRoot));
  });

  it('migrates data into an empty target and writes a pointer', async () => {
    const osHomeDir = await tempRoot('hadamard-home-migrate-os-');
    const sourceRoot = path.join(osHomeDir, '.hadamard');
    const targetRoot = path.join(await tempRoot('hadamard-home-migrate-target-parent-'), 'hadamard-data');
    await mkdir(path.join(sourceRoot, 'projects', 'demo'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'settings.json'), '{"ok":true}\n', 'utf8');
    await writeFile(path.join(sourceRoot, 'projects', 'demo', 'note.txt'), 'hello', 'utf8');

    const before = summarizeHadamardHome(sourceRoot);
    expect(listHadamardHomeTopLevelEntries(sourceRoot)).toEqual(['projects/', 'settings.json']);
    const result = await migrateHadamardHomeData({ sourceRoot, targetRoot, osHomeDir });

    expect(result.sourceRoot).toBe(path.resolve(sourceRoot));
    expect(result.targetRoot).toBe(path.resolve(targetRoot));
    expect(result.entries).toBe(before.entries);
    expect(result.bytes).toBe(before.bytes);
    await expect(readFile(path.join(targetRoot, 'settings.json'), 'utf8')).resolves.toContain('ok');
    await expect(readFile(path.join(targetRoot, 'projects', 'demo', 'note.txt'), 'utf8')).resolves.toBe('hello');

    const pointer = JSON.parse(await readFile(getHadamardHomePointerPath(osHomeDir), 'utf8')) as { root: string };
    expect(pointer.root).toBe(path.resolve(targetRoot));
  });

  it('rejects non-empty migration targets', async () => {
    const sourceRoot = await tempRoot('hadamard-home-source-');
    const targetRoot = await tempRoot('hadamard-home-target-');
    await writeFile(path.join(targetRoot, 'existing.txt'), 'x', 'utf8');

    await expect(migrateHadamardHomeData({ sourceRoot, targetRoot })).rejects.toThrow('must be empty');
  });

  it('renames project-local .actoviq to .hadamard when the new dir is missing', async () => {
    const workDir = await tempRoot('hadamard-project-legacy-');
    const legacy = path.join(workDir, '.actoviq');
    await mkdir(path.join(legacy, 'teams'), { recursive: true });
    await writeFile(path.join(legacy, 'teams', 'demo.json'), '{"name":"demo"}\n', 'utf8');

    const result = await migrateLegacyProjectActoviqDirIfNeeded(workDir);
    expect(result?.targetRoot).toBe(path.join(workDir, '.hadamard'));
    await expect(readFile(path.join(workDir, '.hadamard', 'teams', 'demo.json'), 'utf8')).resolves.toContain('demo');
    await expect(rm(path.join(workDir, '.actoviq'), { recursive: true, force: true })).resolves.toBeUndefined();
  });

  it('leaves project-local .actoviq alone when .hadamard already exists', async () => {
    const workDir = await tempRoot('hadamard-project-both-');
    await mkdir(path.join(workDir, '.actoviq'), { recursive: true });
    await mkdir(path.join(workDir, '.hadamard'), { recursive: true });
    await writeFile(path.join(workDir, '.actoviq', 'legacy.txt'), 'old', 'utf8');
    await writeFile(path.join(workDir, '.hadamard', 'current.txt'), 'new', 'utf8');

    expect(await migrateLegacyProjectActoviqDirIfNeeded(workDir)).toBeUndefined();
    await expect(readFile(path.join(workDir, '.actoviq', 'legacy.txt'), 'utf8')).resolves.toBe('old');
    await expect(readFile(path.join(workDir, '.hadamard', 'current.txt'), 'utf8')).resolves.toBe('new');
  });
});
