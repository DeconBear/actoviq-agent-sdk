import type { PluginPackageManifest } from './packageManifest.js';

export function resolvePluginVersion(
  manifests: PluginPackageManifest[],
  options: { version?: string; pinnedVersion?: string } = {},
): PluginPackageManifest | undefined {
  const requested = options.pinnedVersion ?? options.version;
  const candidates = requested
    ? manifests.filter(manifest => manifest.version === requested)
    : [...manifests];
  return candidates.sort((left, right) => compareSemver(right.version, left.version))[0];
}

export function compareSemver(left: string, right: string): number {
  const a = left.split('-', 1)[0]!.split('.').map(Number);
  const b = right.split('-', 1)[0]!.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return left.localeCompare(right);
}
