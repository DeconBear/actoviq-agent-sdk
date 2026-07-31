import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  hadamardExternalSkillPreferencesPath,
  clearHadamardPreferredExternalSkill,
  createAgentSdk,
  externalSkillPreferencesToRuntimeOptions,
  loadHadamardExternalSkillDefinitions,
  readHadamardExternalSkillPreferences,
  setHadamardExternalSkillDisabled,
  setHadamardPreferredExternalSkill,
  writeHadamardExternalSkillPreferences,
  type ModelApi,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(
  sourceRoot: string,
  directoryName: string,
  name: string,
  description = `${name} description`,
): Promise<string> {
  const root = path.join(sourceRoot, directoryName);
  await mkdir(root, { recursive: true });
  const filePath = path.join(root, 'SKILL.md');
  await writeFile(filePath, [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'allowed-tools: [Read, Write, Bash(git status)]',
    '---',
    '',
    `Run ${name} from \${HADAMARD_SKILL_DIR}.`,
    'Task: $ARGUMENTS',
  ].join('\n'), 'utf8');
  return filePath;
}

const unusedModelApi: ModelApi = {
  async createMessage() {
    throw new Error('Unexpected createMessage call.');
  },
  streamMessage() {
    throw new Error('Unexpected streamMessage call.');
  },
};

describe('external skill runtime loading', () => {
  it('reuses every supported user CLI source while leaving project sources untrusted', async () => {
    const root = await createTempDir('hadamard-external-runtime-');
    const osHomeDir = path.join(root, 'home');
    const workDir = path.join(root, 'workspace');
    const hadamardHomeDir = path.join(root, 'hadamard');
    const files = await Promise.all([
      writeSkill(path.join(osHomeDir, '.claude', 'skills'), 'claude-dir', 'claude-user'),
      writeSkill(path.join(osHomeDir, '.codex', 'skills'), 'codex-dir', 'codex-user'),
      writeSkill(path.join(osHomeDir, '.cursor', 'skills'), 'cursor-dir', 'cursor-user'),
      writeSkill(path.join(osHomeDir, '.cc-switch', 'skills'), 'switch-dir', 'switch-user'),
      writeSkill(path.join(osHomeDir, '.agents', 'skills'), 'shared-dir', 'agents-user'),
      writeSkill(path.join(workDir, '.claude', 'skills'), 'project-dir', 'project-hidden'),
      writeSkill(path.join(osHomeDir, '.codex', 'skills'), 'debug-dir', 'debug', 'external debug'),
    ]);
    const before = await Promise.all(files.map(file => readFile(file, 'utf8')));

    const result = await loadHadamardExternalSkillDefinitions({
      hadamardHomeDir,
      workDir,
      externalSkills: { osHomeDir, env: {} },
    });

    expect(result.definitions.map(skill => skill.name)).toEqual([
      'agents-user',
      'claude-user',
      'codex-user',
      'cursor-user',
      'debug',
      'switch-user',
    ]);
    expect(result.definitions.every(skill => skill.allowedTools == null)).toBe(true);
    expect(result.definitions.find(skill => skill.name === 'claude-user')?.metadata).toMatchObject({
      __hadamardExternalSkillProvider: 'claude-code',
      __hadamardExternalSkillSourceId: 'claude-code:user',
      __hadamardExternalSkillReadOnly: true,
    });
    expect(result.skippedUntrustedSourceIds).toContain('claude-code:project');
    expect(await Promise.all(files.map(file => readFile(file, 'utf8')))).toEqual(before);

    const sdk = await createAgentSdk({
      model: 'test-model',
      modelApi: unusedModelApi,
      homeDir: hadamardHomeDir,
      workDir,
      sessionDirectory: path.join(root, 'sessions'),
      externalSkills: { osHomeDir, env: {} },
    });
    try {
      expect(sdk.skills.getMetadata('claude-user')).toMatchObject({
        name: 'claude-user',
        source: 'user',
        loadedFrom: 'skills',
      });
      expect(sdk.skills.getMetadata('project-hidden')).toBeUndefined();
      expect(sdk.skills.getMetadata('debug')).toMatchObject({ source: 'bundled' });
    } finally {
      await sdk.close();
    }
  });

  it('gates Hadamard project skills and commands behind their explicit project source trust', async () => {
    const root = await createTempDir('hadamard-project-skill-trust-');
    const osHomeDir = path.join(root, 'home');
    const workDir = path.join(root, 'workspace');
    const hadamardHomeDir = path.join(root, 'hadamard');
    await writeSkill(path.join(hadamardHomeDir, 'skills'), 'user-check', 'user-check');
    await writeSkill(path.join(workDir, '.hadamard', 'skills'), 'project-check', 'project-check');
    const commandFile = path.join(workDir, '.hadamard', 'commands', 'release.md');
    await mkdir(path.dirname(commandFile), { recursive: true });
    await writeFile(commandFile, [
      '---',
      'description: Run the project release command',
      'allowed-tools: [Read, Bash(git status)]',
      '---',
      '',
      'Release $ARGUMENTS.',
    ].join('\n'), 'utf8');

    const unresolved = await loadHadamardExternalSkillDefinitions({
      hadamardHomeDir,
      workDir,
      externalSkills: { osHomeDir, env: {} },
    });
    expect(unresolved.definitions.map(skill => skill.name)).toContain('user-check');
    expect(unresolved.definitions.map(skill => skill.name)).not.toEqual(expect.arrayContaining([
      'project-check',
      'release',
    ]));
    expect(unresolved.definitions.find(skill => skill.name === 'user-check')?.allowedTools)
      .toEqual(['Read', 'Write', 'Bash(git status)']);
    expect(unresolved.skippedUntrustedSourceIds).toEqual(expect.arrayContaining([
      'hadamard:project',
      'hadamard:project-commands',
    ]));

    const trustedOptions = {
      osHomeDir,
      env: {},
      trustedProjectSourceIds: ['hadamard:project', 'hadamard:project-commands'],
    };
    const trusted = await loadHadamardExternalSkillDefinitions({
      hadamardHomeDir,
      workDir,
      externalSkills: trustedOptions,
    });
    expect(trusted.definitions.find(skill => skill.name === 'project-check')).toMatchObject({
      source: 'project',
      loadedFrom: 'skills',
      allowedTools: ['Read', 'Write', 'Bash(git status)'],
    });
    expect(trusted.definitions.find(skill => skill.name === 'release')).toMatchObject({
      source: 'project',
      loadedFrom: 'commands',
      allowedTools: ['Read', 'Bash(git status)'],
    });

    const untrustedSdk = await createAgentSdk({
      model: 'test-model',
      modelApi: unusedModelApi,
      homeDir: hadamardHomeDir,
      workDir,
      sessionDirectory: path.join(root, 'sessions-untrusted'),
      externalSkills: { osHomeDir, env: {} },
    });
    try {
      expect(untrustedSdk.skills.getMetadata('project-check')).toBeUndefined();
      expect(untrustedSdk.skills.getMetadata('release')).toBeUndefined();
    } finally {
      await untrustedSdk.close();
    }

    const trustedSdk = await createAgentSdk({
      model: 'test-model',
      modelApi: unusedModelApi,
      homeDir: hadamardHomeDir,
      workDir,
      sessionDirectory: path.join(root, 'sessions-trusted'),
      externalSkills: trustedOptions,
    });
    try {
      expect(trustedSdk.skills.getMetadata('project-check')?.loadedFrom).toBe('skills');
      expect(trustedSdk.skills.getMetadata('release')?.loadedFrom).toBe('commands');
    } finally {
      await trustedSdk.close();
    }
  });

  it('honors the chosen Hadamard or external variant in the final SDK definition map', async () => {
    const root = await createTempDir('hadamard-external-final-conflict-');
    const osHomeDir = path.join(root, 'home');
    const workDir = path.join(root, 'workspace');
    const hadamardHomeDir = path.join(root, '.hadamard');
    await writeSkill(path.join(hadamardHomeDir, 'skills'), 'shared-hadamard', 'shared', 'Hadamard variant');
    await writeSkill(path.join(osHomeDir, '.codex', 'skills'), 'shared-codex', 'shared', 'Codex variant');

    const unresolved = await loadHadamardExternalSkillDefinitions({
      hadamardHomeDir,
      workDir,
      externalSkills: { osHomeDir, env: {} },
    });
    const variants = unresolved.catalog.skills.filter(skill => skill.name === 'shared');
    expect(variants).toHaveLength(2);
    expect(unresolved.skippedConflicts).toContainEqual(expect.objectContaining({ name: 'shared' }));

    for (const provider of ['hadamard', 'codex'] as const) {
      const selected = variants.find(skill => skill.provider === provider)!;
      const sdk = await createAgentSdk({
        model: 'test-model',
        modelApi: unusedModelApi,
        homeDir: hadamardHomeDir,
        workDir,
        sessionDirectory: path.join(root, `sessions-${provider}`),
        externalSkills: {
          osHomeDir,
          env: {},
          preferredSkillIds: { shared: selected.id },
        },
      });
      try {
        expect(sdk.getSkillDefinition('shared')?.metadata?.__hadamardExternalSkillId)
          .toBe(selected.id);
        expect(sdk.skills.getMetadata('shared')?.description)
          .toBe(provider === 'hadamard' ? 'Hadamard variant' : 'Codex variant');
      } finally {
        await sdk.close();
      }
    }
  });

  it('fails closed on conflicts and only loads trusted project or preferred variants', async () => {
    const root = await createTempDir('hadamard-external-conflict-');
    const osHomeDir = path.join(root, 'home');
    const workDir = path.join(root, 'workspace');
    const hadamardHomeDir = path.join(root, 'hadamard');
    await writeSkill(path.join(osHomeDir, '.claude', 'skills'), 'shared', 'shared', 'Claude variant');
    await writeSkill(path.join(osHomeDir, '.codex', 'skills'), 'shared', 'shared', 'Codex variant');
    await writeSkill(path.join(workDir, '.codex', 'skills'), 'project', 'project-only');

    const unresolved = await loadHadamardExternalSkillDefinitions({
      hadamardHomeDir,
      workDir,
      externalSkills: { osHomeDir, env: {} },
    });
    expect(unresolved.definitions.map(skill => skill.name)).not.toContain('shared');
    expect(unresolved.definitions.map(skill => skill.name)).not.toContain('project-only');
    expect(unresolved.skippedConflicts).toEqual([
      expect.objectContaining({ name: 'shared', skillIds: expect.any(Array) }),
    ]);

    const preferred = unresolved.catalog.skills.find(skill =>
      skill.name === 'shared' && skill.description === 'Codex variant',
    );
    expect(preferred).toBeDefined();
    const resolved = await loadHadamardExternalSkillDefinitions({
      hadamardHomeDir,
      workDir,
      externalSkills: {
        osHomeDir,
        env: {},
        trustedProjectSourceIds: ['codex:project'],
        preferredSkillIds: { shared: preferred!.id },
      },
    });
    expect(resolved.definitions.find(skill => skill.name === 'shared')?.description)
      .toBe('Codex variant');
    expect(resolved.definitions.find(skill => skill.name === 'project-only')).toMatchObject({
      source: 'project',
      metadata: expect.objectContaining({ __hadamardExternalSkillSourceId: 'codex:project' }),
    });
  });

  it('disables one catalog skill id without disabling its source siblings or changing native files', async () => {
    const root = await createTempDir('hadamard-external-disabled-skill-');
    const osHomeDir = path.join(root, 'home');
    const workDir = path.join(root, 'workspace');
    const hadamardHomeDir = path.join(root, 'hadamard');
    const firstFile = await writeSkill(
      path.join(osHomeDir, '.codex', 'skills'),
      'first-dir',
      'first-skill',
    );
    const secondFile = await writeSkill(
      path.join(osHomeDir, '.codex', 'skills'),
      'second-dir',
      'second-skill',
    );
    const before = await Promise.all([firstFile, secondFile].map(file => readFile(file, 'utf8')));

    const discovered = await loadHadamardExternalSkillDefinitions({
      hadamardHomeDir,
      workDir,
      externalSkills: { osHomeDir, env: {} },
    });
    const first = discovered.catalog.skills.find(skill => skill.name === 'first-skill');
    const second = discovered.catalog.skills.find(skill => skill.name === 'second-skill');
    expect(first?.id).toMatch(/^skill:/u);
    expect(second?.id).toMatch(/^skill:/u);

    const filtered = await loadHadamardExternalSkillDefinitions({
      hadamardHomeDir,
      workDir,
      externalSkills: {
        osHomeDir,
        env: {},
        disabledSkillIds: [first!.id],
      },
    });

    expect(filtered.definitions.map(skill => skill.name)).toEqual(['second-skill']);
    expect(filtered.loadedSkillIds).toEqual([second!.id]);
    expect(filtered.catalog.skills.find(skill => skill.name === 'first-skill')?.id).toBe(first!.id);
    expect(await Promise.all([firstFile, secondFile].map(file => readFile(file, 'utf8'))))
      .toEqual(before);
  });
});

describe('external skill preferences', () => {
  it('stores normalized trust and conflict choices per workspace under Hadamard home', async () => {
    const root = await createTempDir('hadamard-external-preferences-');
    const hadamardHomeDir = path.join(root, 'hadamard');
    const firstWorkDir = path.join(root, 'one');
    const secondWorkDir = path.join(root, 'two');

    const written = await writeHadamardExternalSkillPreferences(
      { hadamardHomeDir, workDir: firstWorkDir },
      {
        disabledSourceIds: ['cursor:user', 'cursor:user', ''],
        disabledSkillIds: [' skill:two ', 'skill:one', 'skill:one'],
        trustedProjectSourceIds: ['codex:project'],
        preferredSkillIds: { shared: ' skill:abc ', '': 'ignored' },
      },
    );

    expect(written).toEqual({
      disabledSourceIds: ['cursor:user'],
      disabledSkillIds: ['skill:one', 'skill:two'],
      trustedProjectSourceIds: ['codex:project'],
      preferredSkillIds: { shared: 'skill:abc' },
    });
    expect(await readHadamardExternalSkillPreferences({ hadamardHomeDir, workDir: firstWorkDir }))
      .toEqual(written);
    expect(await readHadamardExternalSkillPreferences({ hadamardHomeDir, workDir: secondWorkDir }))
      .toEqual({
        disabledSourceIds: [],
        disabledSkillIds: [],
        trustedProjectSourceIds: [],
        preferredSkillIds: {},
      });
    expect(externalSkillPreferencesToRuntimeOptions(written)).toEqual(written);
    expect(hadamardExternalSkillPreferencesPath(hadamardHomeDir)).toBe(
      path.join(hadamardHomeDir, 'skill-preferences.json'),
    );
  });

  it('updates one workspace skill choice and can clear a preferred conflict variant', async () => {
    const root = await createTempDir('hadamard-external-preference-updates-');
    const location = {
      hadamardHomeDir: path.join(root, 'hadamard'),
      workDir: path.join(root, 'workspace'),
    };
    const otherLocation = { ...location, workDir: path.join(root, 'other-workspace') };

    await setHadamardExternalSkillDisabled(location, ' skill:first ', true);
    await setHadamardExternalSkillDisabled(location, 'skill:second', true);
    await setHadamardExternalSkillDisabled(location, 'skill:first', false);
    await setHadamardPreferredExternalSkill(location, ' shared ', ' skill:preferred ');

    expect(await readHadamardExternalSkillPreferences(location)).toEqual({
      disabledSourceIds: [],
      disabledSkillIds: ['skill:second'],
      trustedProjectSourceIds: [],
      preferredSkillIds: { shared: 'skill:preferred' },
    });

    await clearHadamardPreferredExternalSkill(location, 'shared');
    expect((await readHadamardExternalSkillPreferences(location)).preferredSkillIds).toEqual({});
    expect(await readHadamardExternalSkillPreferences(otherLocation)).toEqual({
      disabledSourceIds: [],
      disabledSkillIds: [],
      trustedProjectSourceIds: [],
      preferredSkillIds: {},
    });
  });
});
