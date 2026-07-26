import type {
  ActoviqExternalSkillsOptions,
  ActoviqSkillDefinition,
} from '../types.js';
import { loadActoviqSkillDefinitionFile } from './actoviqSkills.js';
import {
  discoverActoviqSkillCatalog,
  type ActoviqSkillCatalog,
  type ActoviqSkillCatalogEntry,
  type ActoviqSkillCatalogOrigin,
} from './externalSkillCatalog.js';

export interface ActoviqExternalSkillConflictSkip {
  name: string;
  skillIds: string[];
}

export interface ActoviqExternalSkillLoadError {
  skillId: string;
  name: string;
  sourceId: string;
  message: string;
}

export interface ActoviqExternalSkillRuntimeResult {
  catalog: ActoviqSkillCatalog;
  definitions: ActoviqSkillDefinition[];
  loadedSkillIds: string[];
  skippedConflicts: ActoviqExternalSkillConflictSkip[];
  skippedUntrustedSourceIds: string[];
  loadErrors: ActoviqExternalSkillLoadError[];
}

interface EligibleExternalSkill {
  entry: ActoviqSkillCatalogEntry;
  origin: ActoviqSkillCatalogOrigin & {
    skillFile: string;
    skillRoot: string;
  };
}

/**
 * Resolve native CLI skills into Hadamard definitions without writing to the
 * native runtime directories. Distinct-content name conflicts are fail-closed:
 * no variant loads unless the caller chooses a catalog id explicitly.
 */
export async function loadActoviqExternalSkillDefinitions(options: {
  actoviqHomeDir: string;
  workDir: string;
  externalSkills?: boolean | ActoviqExternalSkillsOptions;
}): Promise<ActoviqExternalSkillRuntimeResult> {
  const runtimeOptions = normalizeRuntimeOptions(options.externalSkills);
  const trustedProjectSourceIds = new Set(runtimeOptions.trustedProjectSourceIds ?? []);
  const disabledSourceIds = new Set(runtimeOptions.disabledSourceIds ?? []);
  const disabledSkillIds = new Set(runtimeOptions.disabledSkillIds ?? []);
  const enabledSourceIds = runtimeOptions.enabledSourceIds
    ? new Set(runtimeOptions.enabledSourceIds)
    : undefined;
  const catalog = await discoverActoviqSkillCatalog({
    actoviqHomeDir: options.actoviqHomeDir,
    workDir: options.workDir,
    osHomeDir: runtimeOptions.osHomeDir,
    env: runtimeOptions.env,
    includeBundledActoviq: false,
    trustedProjectSourceIds: [...trustedProjectSourceIds],
  });
  const sources = new Map(catalog.sources.map(source => [source.id, source]));
  const skippedUntrustedSourceIds = catalog.sources
    .filter(source =>
      source.scope === 'project'
      && source.status !== 'missing'
      && !trustedProjectSourceIds.has(source.id),
    )
    .map(source => source.id)
    .sort();

  const eligible = catalog.skills.flatMap(entry => {
    if (
      entry.status === 'invalid'
      || disabledSkillIds.has(entry.id)
    ) return [];
    const origin = entry.origins.find(candidate => {
      const source = sources.get(candidate.sourceId);
      return Boolean(
        source
        && source.status !== 'missing'
        && source.status !== 'unreadable'
        && !disabledSourceIds.has(source.id)
        && (!enabledSourceIds || enabledSourceIds.has(source.id))
        && (source.scope !== 'project' || trustedProjectSourceIds.has(source.id))
        && candidate.skillFile
        && candidate.skillRoot,
      );
    });
    return origin?.skillFile && origin.skillRoot
      ? [{ entry, origin: origin as EligibleExternalSkill['origin'] }]
      : [];
  });

  const byName = new Map<string, EligibleExternalSkill[]>();
  for (const candidate of eligible) {
    const variants = byName.get(candidate.entry.name) ?? [];
    variants.push(candidate);
    byName.set(candidate.entry.name, variants);
  }

  const selected: EligibleExternalSkill[] = [];
  const skippedConflicts: ActoviqExternalSkillConflictSkip[] = [];
  for (const [name, variants] of byName) {
    if (variants.length === 1) {
      selected.push(variants[0]!);
      continue;
    }
    const preferredId = runtimeOptions.preferredSkillIds?.[name];
    const preferred = preferredId
      ? variants.find(candidate => candidate.entry.id === preferredId)
      : undefined;
    if (preferred) {
      selected.push(preferred);
      continue;
    }
    skippedConflicts.push({
      name,
      skillIds: variants.map(candidate => candidate.entry.id).sort(),
    });
  }

  selected.sort((left, right) => left.entry.name.localeCompare(right.entry.name));
  skippedConflicts.sort((left, right) => left.name.localeCompare(right.name));
  const definitions: ActoviqSkillDefinition[] = [];
  const loadedSkillIds: string[] = [];
  const loadErrors: ActoviqExternalSkillLoadError[] = [];
  for (const candidate of selected) {
    try {
      const definition = await loadActoviqSkillDefinitionFile({
        skillFile: candidate.origin.skillFile,
        skillRoot: candidate.origin.skillRoot,
        name: candidate.entry.name,
        source: candidate.origin.scope === 'project' ? 'project' : 'user',
        loadedFrom: candidate.origin.loadedFrom === 'commands' ? 'commands' : 'skills',
        includeDeclaredAllowedTools: candidate.origin.provider === 'actoviq',
      });
      definitions.push({
        ...definition,
        description: candidate.entry.description,
        version: candidate.entry.version ?? definition.version,
        allowedTools: candidate.origin.provider === 'actoviq'
          ? definition.allowedTools
          : undefined,
        metadata: {
          ...(definition.metadata ?? {}),
          __actoviqExternalSkillId: candidate.entry.id,
          __actoviqExternalSkillProvider: candidate.origin.provider,
          __actoviqExternalSkillSourceId: candidate.origin.sourceId,
          __actoviqExternalSkillReadOnly: candidate.origin.readOnly,
        },
      });
      loadedSkillIds.push(candidate.entry.id);
    } catch (error) {
      loadErrors.push({
        skillId: candidate.entry.id,
        name: candidate.entry.name,
        sourceId: candidate.origin.sourceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    catalog,
    definitions,
    loadedSkillIds,
    skippedConflicts,
    skippedUntrustedSourceIds,
    loadErrors,
  };
}

function normalizeRuntimeOptions(
  options: boolean | ActoviqExternalSkillsOptions | undefined,
): ActoviqExternalSkillsOptions {
  return options && typeof options === 'object' ? options : {};
}
