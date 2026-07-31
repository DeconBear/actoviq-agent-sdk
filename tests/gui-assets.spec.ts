import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { resolveGuiAssetRoots, resolveGuiAssetsDir, resolveGuiIconPath } from '../src/gui/guiAssets.js';

describe('GUI asset paths', () => {
  it('resolves hadamard-icon from repo assets/', () => {
    const iconPath = resolveGuiIconPath();
    expect(iconPath).toBeTruthy();
    expect(existsSync(iconPath!)).toBe(true);
    expect(iconPath!).toMatch(/hadamard-icon\.(ico|png)$/);
    expect(path.basename(path.dirname(iconPath!))).toBe('assets');
  });

  it('finds assets directory via module roots', () => {
    const assetsDir = resolveGuiAssetsDir();
    expect(assetsDir).toBeTruthy();
    expect(existsSync(path.join(assetsDir!, 'hadamard-icon.png'))).toBe(true);
    expect(existsSync(path.join(assetsDir!, 'hadamard-icon.ico'))).toBe(true);
  });

  it('includes HADAMARD_GUI_ROOT when set', () => {
    const root = process.cwd();
    process.env.HADAMARD_GUI_ROOT = root;
    try {
      expect(resolveGuiAssetRoots()).toContain(path.resolve(root));
      expect(resolveGuiIconPath()).toBe(path.resolve(root, 'assets', process.platform === 'win32' ? 'hadamard-icon.ico' : 'hadamard-icon.png'));
    } finally {
      delete process.env.HADAMARD_GUI_ROOT;
    }
  });
});
