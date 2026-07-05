import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function unpackAsarPath(candidate: string): string {
  if (candidate.includes('\\app.asar\\')) return candidate.replace('\\app.asar\\', '\\app.asar.unpacked\\');
  if (candidate.includes('/app.asar/')) return candidate.replace('/app.asar/', '/app.asar.unpacked/');
  return candidate;
}

/** Candidate repo/package roots for assets/actoviq-icon.* resolution. */
export function resolveGuiAssetRoots(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const roots = new Set<string>();
  if (process.env.ACTOVIQ_GUI_ROOT) roots.add(path.resolve(process.env.ACTOVIQ_GUI_ROOT));
  // dist/src/gui → repo root
  roots.add(path.resolve(moduleDir, '..', '..', '..'));
  // src/gui (tsx dev)
  roots.add(path.resolve(moduleDir, '..', '..'));
  roots.add(path.resolve(process.cwd()));
  return [...roots];
}

/** Absolute path to actoviq-icon.ico (Windows) or .png fallback. */
export function resolveGuiIconPath(): string | undefined {
  for (const root of resolveGuiAssetRoots()) {
    if (process.platform === 'win32') {
      for (const candidate of [path.join(root, 'assets', 'actoviq-icon.ico'), unpackAsarPath(path.join(root, 'assets', 'actoviq-icon.ico'))]) {
        if (existsSync(candidate)) return path.resolve(candidate);
      }
    }
    for (const candidate of [path.join(root, 'assets', 'actoviq-icon.png'), unpackAsarPath(path.join(root, 'assets', 'actoviq-icon.png'))]) {
      if (existsSync(candidate)) return path.resolve(candidate);
    }
  }
  return undefined;
}

export function resolveGuiAssetsDir(): string | undefined {
  for (const root of resolveGuiAssetRoots()) {
    const dir = path.join(root, 'assets');
    if (existsSync(dir)) return path.resolve(dir);
  }
  return undefined;
}
