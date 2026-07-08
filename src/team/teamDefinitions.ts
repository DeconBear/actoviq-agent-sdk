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
import type { TeamDefinition, TeamGraphNode, TeamMember } from '../types.js';
import {
  canonicalizeTeamDefinition,
  graphNodeKind,
  ensureConfiguredTeamGraph,
  migrateTeamDefinitionToGraph,
  toPersistedTeamDefinition,
} from './teamGraph.js';

/** Human-readable agent labels for list/confirm UI (graph v3 nodes or legacy members). */
export function listTeamAgentLabels(definition: TeamDefinition): string[] {
  const fromNodes = (definition.nodes ?? [])
    .filter((n) => graphNodeKind(n) === 'agent')
    .map((m) => m.name ?? m.role ?? m.id ?? m.model)
    .filter((label): label is string => Boolean(label));
  if (fromNodes.length) return fromNodes;
  return [
    ...(definition.members ?? []),
    ...(definition.reviewer ? [definition.reviewer] : []),
    ...(definition.primary ? [definition.primary] : []),
  ]
    .map((m) => m.name ?? m.role ?? m.model)
    .filter((label): label is string => Boolean(label));
}

/** Count of executable agent nodes (excludes Task/Return ports). */
export function countTeamAgents(definition: TeamDefinition): number {
  const agents = (definition.nodes ?? []).filter((n) => graphNodeKind(n) === 'agent');
  if (agents.length) return agents.length;
  return (definition.members?.length ?? 0)
    + (definition.reviewer ? 1 : 0)
    + (definition.primary ? 1 : 0);
}

export interface LoadedTeamDefinition {
  name: string;
  definition: TeamDefinition;
  source: 'project' | 'personal' | 'built-in';
  filePath: string;
}

/**
 * Built-in team presets, available everywhere `/team` lists or loads — even
 * with no team files on disk. A user file of the same name in `.actoviq/teams/`
 * or `~/.actoviq/teams/` shadows the built-in (same rule as
 * `BUILT_IN_ROUTER_PROFILES`). Built-ins are never overwritten by save; clone
 * to a new name to customize.
 *
 * Members use `model: ''` meaning "the session's current model" — call
 * `instantiateTeamDefinition(def, model)` before running.
 */
/**
 * Legacy preset shapes used only to seed graph v3 built-ins. Runtime, GUI, and
 * disk all consume {@link BUILT_IN_TEAM_DEFINITIONS} — canonical graph v3 JSON
 * with Task + Return ports.
 */
const LEGACY_BUILT_IN_TEAM_TEMPLATES: Record<string, TeamDefinition> = {
  'panel-analysis': {
    name: 'panel-analysis',
    description: 'Research Panel: independent read-only investigation from multiple angles, reconciled by a synthesizer.',
    mode: 'panel-analysis',
    members: [
      { model: '', role: 'researcher', name: 'researcher', systemPrompt: 'Expert researcher. Investigate with read-only tools; cite sources.' },
      { model: '', role: 'skeptic', name: 'skeptic', systemPrompt: 'Rigorous skeptic. Verify with sources; challenge assumptions.' },
    ],
    primary: { model: '', role: 'synthesizer', name: 'synthesizer', systemPrompt: 'Synthesizer. Reconcile the panel findings into the best answer and decide when they suffice.' },
    timeoutMs: 300000,
    maxIterations: 12,
  },
  analysis: {
    name: 'analysis',
    description: 'Analysis Panel: parallel read-only research without a synthesizer — you weigh the findings.',
    mode: 'analysis',
    members: [
      { model: '', role: 'researcher', name: 'researcher', systemPrompt: 'Expert researcher. Deep, source-grounded analysis.' },
      { model: '', role: 'skeptic', name: 'skeptic', systemPrompt: 'Rigorous skeptic. Verify with sources; challenge assumptions.' },
    ],
    timeoutMs: 300000,
    maxIterations: 12,
  },
  reviewer: {
    name: 'reviewer',
    description: 'Code Reviewer: one read-only agent inspects the project and reports only genuine, verifiable issues.',
    mode: 'reviewer',
    members: [],
    reviewer: { model: '', role: 'reviewer', name: 'reviewer', systemPrompt: 'Meticulous reviewer. Surface only genuine, verifiable issues with file:line evidence; never speculate.' },
    timeoutMs: 300000,
    maxIterations: 16,
  },
  'quick-review': {
    name: 'quick-review',
    description: 'Quick Review: a lightweight reviewer pass for small diffs — fast, focused, verifiable findings only.',
    mode: 'reviewer',
    members: [],
    reviewer: { model: '', role: 'reviewer', name: 'quick-reviewer', systemPrompt: 'Fast, focused reviewer for small changes. Check only what changed; report genuine, verifiable issues with file:line evidence. Be brief.' },
    timeoutMs: 180000,
    maxIterations: 8,
  },
  'security-audit': {
    name: 'security-audit',
    description: 'Security Audit: adversarial read-only panel scanning for injection, secrets, unsafe input handling, and permission gaps.',
    mode: 'panel-analysis',
    members: [
      { model: '', role: 'attacker', name: 'attacker', systemPrompt: 'Offensive security analyst. Hunt for injection points, unsafe deserialization, path traversal, command execution, and secret leakage. Cite file:line for every finding.' },
      { model: '', role: 'auditor', name: 'auditor', systemPrompt: 'Defensive security auditor. Review authentication, authorization, input validation at boundaries, and dependency risks. Only report verifiable issues with file:line evidence.' },
    ],
    primary: { model: '', role: 'synthesizer', name: 'synthesizer', systemPrompt: 'Security lead. Merge the findings, drop speculation, rank by severity, and decide when the audit is sufficient.' },
    timeoutMs: 300000,
    maxIterations: 16,
  },
};

/**
 * Built-in team presets as graph v3 metadata (Task + Return + agent nodes).
 * A user file of the same name shadows the built-in.
 */
export const BUILT_IN_TEAM_DEFINITIONS: Record<string, TeamDefinition> = Object.fromEntries(
  Object.entries(LEGACY_BUILT_IN_TEAM_TEMPLATES).map(([name, legacy]) => [
    name,
    ensureConfiguredTeamGraph(migrateTeamDefinitionToGraph({ ...legacy, name })),
  ]),
);

/** Fresh built-in preset (graph v3, fully configured) or undefined. */
export function getBuiltInTeamDefinition(name: string): TeamDefinition | undefined {
  const preset = BUILT_IN_TEAM_DEFINITIONS[name];
  return preset ? structuredClone(preset) : undefined;
}

/**
 * Fill `model: ''` placeholders in a (typically built-in) team definition with
 * a concrete model. Returns a new definition; the input is not mutated.
 */
export function instantiateTeamDefinition(definition: TeamDefinition, model: string): TeamDefinition {
  const fill = (member?: TeamMember): TeamMember | undefined =>
    member ? { ...member, model: member.model || model } : undefined;
  const def = structuredClone(definition);
  def.members = (def.members ?? []).map((m) => fill(m)!);
  def.primary = fill(def.primary);
  def.reviewer = fill(def.reviewer);
  def.nodes = def.nodes?.map((n) =>
    graphNodeKind(n) === 'agent' ? { ...n, model: n.model || model } : n,
  );
  return def;
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
    nodes: def.nodes?.map((n) => ({ ...n, apiKey: resolve(n.apiKey) })),
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
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TeamDefinition;
        // Subagent / workflow squads skip graph canonicalization (no Task→Return).
        const squadType = raw.squadType || 'graph';
        const definition = squadType === 'graph'
          ? ensureConfiguredTeamGraph(resolveEnvVars(canonicalizeTeamDefinition(raw)))
          : { ...raw, squadType } as TeamDefinition;
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

  const builtIn = BUILT_IN_TEAM_DEFINITIONS[name];
  if (builtIn) {
    return {
      name,
      definition: ensureConfiguredTeamGraph(resolveEnvVars(structuredClone(builtIn))),
      source: 'built-in',
      filePath: '(built-in)',
    };
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
  // Built-in presets are immutable; a same-name save would silently shadow
  // them, so require an explicit clone-to-new-name instead (overwrite of an
  // existing user shadow file remains allowed above).
  if (BUILT_IN_TEAM_DEFINITIONS[definition.name] && !fs.existsSync(filePath) && !options.overwrite) {
    throw new Error(
      `"${definition.name}" is a built-in preset. Clone it to a new name (cloneTeamDefinition) instead of overwriting.`,
    );
  }

  // Strip env var values before saving (save the $VAR reference, not the resolved value)
  const keepRef = (apiKey?: string) => (apiKey?.startsWith?.('$') ? apiKey : undefined);
  const stripEnvVars = (def: TeamDefinition): TeamDefinition => {
    return {
      ...def,
      members: def.members?.map((m) => ({ ...m, apiKey: keepRef(m.apiKey) })),
      primary: def.primary ? { ...def.primary, apiKey: keepRef(def.primary.apiKey) } : undefined,
      reviewer: def.reviewer ? { ...def.reviewer, apiKey: keepRef(def.reviewer.apiKey) } : undefined,
      nodes: def.nodes?.map((n) => ({ ...n, apiKey: keepRef(n.apiKey) })),
    };
  };

  // Persist graph v3 JSON (Task + Return ports); validate before write.
  const persisted = toPersistedTeamDefinition(definition);
  fs.writeFileSync(filePath, JSON.stringify(stripEnvVars(persisted), null, 2), 'utf-8');
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
          const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TeamDefinition;
          // Subagent / workflow squads skip graph canonicalization (no Task→Return).
          const squadType = raw.squadType || 'graph';
          const definition = squadType === 'graph'
            ? ensureConfiguredTeamGraph(resolveEnvVars(canonicalizeTeamDefinition(raw)))
            : { ...raw, squadType } as TeamDefinition;
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

  // Append built-in presets that a user file hasn't shadowed.
  for (const [name, definition] of Object.entries(BUILT_IN_TEAM_DEFINITIONS)) {
    if (seen.has(name)) continue;
    seen.add(name);
    teams.push({
      name,
      definition: ensureConfiguredTeamGraph(resolveEnvVars(structuredClone(definition))),
      source: 'built-in',
      filePath: '(built-in)',
    });
  }

  return teams;
}

/**
 * Clone an existing team definition (built-in or on-disk) under a new name and
 * save it to the usual target dir (project when `projectDir` is set, else
 * personal). This is the supported way to customize a built-in preset — the
 * clone is a plain user file, fully decoupled from future SDK preset updates.
 */
export async function cloneTeamDefinition(
  sourceName: string,
  newName: string,
  options: { projectDir?: string; homeDir?: string; overwrite?: boolean } = {},
): Promise<LoadedTeamDefinition> {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error('Clone requires a non-empty new team name.');
  if (trimmed === sourceName) throw new Error('Clone requires a different name from the source team.');
  if (BUILT_IN_TEAM_DEFINITIONS[trimmed]) {
    throw new Error(`"${trimmed}" is a built-in preset name — pick another name for the clone.`);
  }

  const source = loadTeamDefinition(sourceName, options.projectDir, options.homeDir);
  if (!source) throw new Error(`Team "${sourceName}" not found (checked project, personal, and built-in presets).`);

  // Clone the raw on-disk shape when there is one, so `$ENV_VAR` apiKey
  // references survive verbatim (the loaded view resolves them, and resolved
  // literals would be stripped on save).
  const rawSource: TeamDefinition = source.source === 'built-in'
    ? structuredClone(BUILT_IN_TEAM_DEFINITIONS[sourceName]!)
    : canonicalizeTeamDefinition(JSON.parse(fs.readFileSync(source.filePath, 'utf-8')) as TeamDefinition);
  const definition: TeamDefinition = structuredClone(rawSource);
  definition.name = trimmed;
  const filePath = await saveTeamDefinition(definition, options);
  return {
    name: trimmed,
    definition,
    source: options.projectDir ? 'project' : 'personal',
    filePath,
  };
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
