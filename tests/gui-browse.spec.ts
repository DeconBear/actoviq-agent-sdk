import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import { browseDirectory } from '../src/gui/actoviqGui.js';

describe('GUI workspace browse API', () => {
  it('lists the home directory when given a valid path', async () => {
    const home = os.homedir();
    const result = await browseDirectory(home);
    expect(result.path).toBe(path.resolve(home));
    expect(result.entries.some((entry) => entry.name === '..' && entry.kind === 'folder')).toBe(true);
    expect(result.entries.every((entry) => entry.kind === 'folder' || entry.kind === 'drive')).toBe(true);
  });

  it('returns roots when path is empty', async () => {
    const result = await browseDirectory('');
    expect(result.path).toBe('');
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('rejects missing directories', async () => {
    await expect(
      browseDirectory(path.join(os.tmpdir(), 'actoviq-missing-folder-' + process.pid)),
    ).rejects.toThrow(/Folder not found/);
  });
});
