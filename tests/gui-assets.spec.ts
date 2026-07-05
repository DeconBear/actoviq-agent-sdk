import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { resolveGuiAssetRoots, resolveGuiAssetsDir, resolveGuiIconPath } from '../src/gui/guiAssets.js';

describe('GUI asset paths', () => {
  it('resolves actoviq-icon from repo assets/', () => {
    const iconPath = resolveGuiIconPath();
    expect(iconPath).toBeTruthy();
    expect(existsSync(iconPath!)).toBe(true);
    expect(iconPath!).toMatch(/actoviq-icon\.(ico|png)$/);
    expect(path.basename(path.dirname(iconPath!))).toBe('assets');
  });

  it('finds assets directory via module roots', () => {
    const assetsDir = resolveGuiAssetsDir();
    expect(assetsDir).toBeTruthy();
    expect(existsSync(path.join(assetsDir!, 'actoviq-icon.png'))).toBe(true);
    expect(existsSync(path.join(assetsDir!, 'actoviq-icon.ico'))).toBe(true);
  });

  it('includes ACTOVIQ_GUI_ROOT when set', () => {
    const root = process.cwd();
    process.env.ACTOVIQ_GUI_ROOT = root;
    try {
      expect(resolveGuiAssetRoots()).toContain(path.resolve(root));
      expect(resolveGuiIconPath()).toBe(path.resolve(root, 'assets', process.platform === 'win32' ? 'actoviq-icon.ico' : 'actoviq-icon.png'));
    } finally {
      delete process.env.ACTOVIQ_GUI_ROOT;
    }
  });
});
