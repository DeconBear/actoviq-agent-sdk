import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  forgetWorkspaceFromRegistry,
  readWorkspaceRegistry,
  rememberWorkspace,
  setWorkspacePinned,
} from '../src/gui/workspaceRegistry.js';

describe('workspaceRegistry', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempHome(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-ws-reg-'));
    dirs.push(dir);
    return dir;
  }

  it('remembers opened workspaces and keeps newest first', async () => {
    const home = await tempHome();
    const a = path.join(home, 'a');
    const b = path.join(home, 'b');
    await rememberWorkspace(a, home, '2026-07-09T01:00:00.000Z');
    await rememberWorkspace(b, home, '2026-07-09T02:00:00.000Z');
    await rememberWorkspace(a, home, '2026-07-09T03:00:00.000Z');
    const entries = await readWorkspaceRegistry(home);
    expect(entries.map((e) => e.path)).toEqual([path.resolve(a), path.resolve(b)]);
    expect(entries[0]?.lastOpenedAt).toBe('2026-07-09T03:00:00.000Z');
  });

  it('forgets a workspace from the registry', async () => {
    const home = await tempHome();
    const a = path.join(home, 'a');
    const b = path.join(home, 'b');
    await rememberWorkspace(a, home);
    await rememberWorkspace(b, home);
    await forgetWorkspaceFromRegistry(a, home);
    const entries = await readWorkspaceRegistry(home);
    expect(entries.map((e) => e.path)).toEqual([path.resolve(b)]);
  });

  it('tolerates a corrupt registry file', async () => {
    const home = await tempHome();
    const actoviq = path.join(home, '.actoviq');
    await mkdir(actoviq, { recursive: true });
    await writeFile(path.join(actoviq, 'workspaces.json'), '{not-json');
    expect(await readWorkspaceRegistry(home)).toEqual([]);
  });

  it('pins a workspace and preserves pin across remember', async () => {
    const home = await tempHome();
    const a = path.join(home, 'a');
    const b = path.join(home, 'b');
    await rememberWorkspace(a, home, '2026-07-09T01:00:00.000Z');
    await rememberWorkspace(b, home, '2026-07-09T02:00:00.000Z');
    await setWorkspacePinned(a, home, true);
    let entries = await readWorkspaceRegistry(home);
    expect(entries[0]?.path).toBe(path.resolve(a));
    expect(entries[0]?.pinned).toBe(true);
    await rememberWorkspace(a, home, '2026-07-09T04:00:00.000Z');
    entries = await readWorkspaceRegistry(home);
    expect(entries.find((e) => e.path === path.resolve(a))?.pinned).toBe(true);
    await setWorkspacePinned(a, home, false);
    entries = await readWorkspaceRegistry(home);
    expect(entries.find((e) => e.path === path.resolve(a))?.pinned).toBeUndefined();
  });
});
