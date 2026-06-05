import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function discoverPlugins(directory) {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(path.join(directory, file), 'utf8')));
}

export function validatePlugin(plugin) {
  return { valid: Boolean(plugin.name), errors: [] };
}

export function buildDiagnostics(plugin) {
  return {
    plugin: plugin.name ?? 'unknown',
    status: validatePlugin(plugin).valid ? 'ready' : 'invalid',
    errors: []
  };
}
