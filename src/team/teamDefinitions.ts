/**
 * Team definitions from disk — load/save team configurations.
 *
 * Search path:
 *   1. .actoviq/teams/<name>.json  (project)
 *   2. ~/.actoviq/teams/<name>.json (personal)
 *
 * apiKey values starting with $ are resolved from environment variables at load time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { TeamDefinition } from '../types.js';

export interface LoadedTeamDefinition {
  name: string;
  definition: TeamDefinition;
  source: 'project' | 'personal';
  filePath: string;
}

function resolveTeamDirs(projectDir?: string, homeDir?: string): string[] {
  const dirs: string[] = [];
  const home = homeDir ?? process.env.ACTOVIQ_HOME ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.actoviq');

  if (projectDir) {
    dirs.push(path.join(projectDir, '.actoviq', 'teams'));
  }
  dirs.push(path.join(home, 'teams'));
  return dirs;
}

/**
 * Resolve $ENV_VAR references in team definition values.
 */
function resolveEnvVars(def: TeamDefinition): TeamDefinition {
  const resolve = (val?: string) => {
    if (!val) return val;
    if (val.startsWith('$')) {
      return process.env[val.slice(1)] ?? val;
    }
    return val;
  };

  const resolvedMembers = def.members?.map((m) => ({
    ...m,
    apiKey: resolve(m.apiKey),
  }));

  return {
    ...def,
    members: resolvedMembers ?? def.members,
    primary: def.primary ? { ...def.primary, apiKey: resolve(def.primary.apiKey) } : undefined,
    reviewer: def.reviewer ? { ...def.reviewer, apiKey: resolve(def.reviewer.apiKey) } : undefined,
  };
}

/**
 * Load a team definition by name from disk.
 */
export function loadTeamDefinition(
  name: string,
  projectDir?: string,
  homeDir?: string,
): LoadedTeamDefinition | null {
  const dirs = resolveTeamDirs(projectDir, homeDir);

  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]!;
    const filePath = path.join(dir, `${name}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const definition = resolveEnvVars(raw as TeamDefinition);
        return {
          name,
          definition,
          source: i === 0 && projectDir ? 'project' : 'personal',
          filePath,
        };
      } catch (err: any) {
        throw new Error(`Failed to load team definition "${name}" from ${filePath}: ${err.message}`);
      }
    }
  }

  return null;
}

/**
 * Save a team definition to disk.
 */
export async function saveTeamDefinition(
  definition: TeamDefinition,
  options: { projectDir?: string; homeDir?: string; overwrite?: boolean } = {},
): Promise<string> {
  const dirs = resolveTeamDirs(options.projectDir, options.homeDir);
  const targetDir = dirs[0]!;
  await mkdir(targetDir, { recursive: true });

  const filePath = path.join(targetDir, `${definition.name}.json`);

  if (fs.existsSync(filePath) && !options.overwrite) {
    throw new Error(`Team "${definition.name}" already exists at ${filePath}. Use overwrite: true to replace.`);
  }

  // Strip env var values before saving (save the $VAR reference, not the resolved value)
  const stripEnvVars = (def: TeamDefinition): TeamDefinition => {
    const restore = (val?: string) => val?.startsWith?.('$') ? val : val;

    return {
      ...def,
      members: def.members?.map((m) => ({ ...m, apiKey: m.apiKey?.startsWith?.('$') ? m.apiKey : undefined })),
      primary: def.primary ? { ...def.primary, apiKey: undefined } : undefined,
      reviewer: def.reviewer ? { ...def.reviewer, apiKey: undefined } : undefined,
    };
  };

  fs.writeFileSync(filePath, JSON.stringify(stripEnvVars(definition), null, 2), 'utf-8');
  return filePath;
}

/**
 * List all team definitions from all search paths.
 */
export function listTeamDefinitions(
  projectDir?: string,
  homeDir?: string,
): LoadedTeamDefinition[] {
  const dirs = resolveTeamDirs(projectDir, homeDir);
  const seen = new Set<string>();
  const teams: LoadedTeamDefinition[] = [];

  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]!;
    if (!fs.existsSync(dir)) continue;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const name = entry.name.slice(0, -5);
        if (seen.has(name)) continue;
        seen.add(name);

        const filePath = path.join(dir, entry.name);
        try {
          const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          const definition = resolveEnvVars(raw as TeamDefinition);
          teams.push({
            name,
            definition,
            source: i === 0 && projectDir ? 'project' : 'personal',
            filePath,
          });
        } catch {
          // Skip invalid definitions
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  return teams;
}

/**
 * Delete a team definition from disk.
 */
export async function deleteTeamDefinition(
  name: string,
  projectDir?: string,
  homeDir?: string,
): Promise<boolean> {
  const dirs = resolveTeamDirs(projectDir, homeDir);

  for (const dir of dirs) {
    const filePath = path.join(dir, `${name}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  }

  return false;
}
