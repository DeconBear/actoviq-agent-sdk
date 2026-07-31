import path from 'node:path';

export interface PluginPackageManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  publisher?: string;
  signature?: string;
  entry: string;
  integrity?: string;
  capabilities: string[];
  permissions?: string[];
  hadamard?: string;
}

export function parsePluginPackageManifest(value: unknown): PluginPackageManifest {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Plugin manifest must use schemaVersion 1.');
  }
  for (const field of ['id', 'name', 'version', 'entry'] as const) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new Error(`Plugin manifest ${field} is required.`);
    }
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(value.id as string)) {
    throw new Error('Plugin manifest id is invalid.');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version as string)) {
    throw new Error('Plugin manifest version must be SemVer.');
  }
  const entry = (value.entry as string).replace(/\\/gu, '/');
  if (path.posix.isAbsolute(entry) || entry.split('/').some(segment => segment === '..')) {
    throw new Error('Plugin manifest entry must stay inside the package.');
  }
  if (!Array.isArray(value.capabilities)
    || !value.capabilities.every(capability => typeof capability === 'string')) {
    throw new Error('Plugin manifest capabilities must be an array of strings.');
  }
  if (value.integrity !== undefined
    && (typeof value.integrity !== 'string' || !/^sha256-[A-Za-z0-9+/=]+$/u.test(value.integrity))) {
    throw new Error('Plugin manifest integrity must be a sha256 SRI value.');
  }
  return {
    schemaVersion: 1,
    id: (value.id as string).trim(),
    name: (value.name as string).trim(),
    version: (value.version as string).trim(),
    entry,
    capabilities: [...value.capabilities as string[]],
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.publisher === 'string' && value.publisher.trim()
      ? { publisher: value.publisher.trim() }
      : {}),
    ...(typeof value.signature === 'string' && value.signature.trim()
      ? { signature: value.signature.trim() }
      : {}),
    ...(typeof value.integrity === 'string' ? { integrity: value.integrity } : {}),
    ...(Array.isArray(value.permissions)
      ? { permissions: value.permissions.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(typeof value.hadamard === 'string' ? { hadamard: value.hadamard } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
