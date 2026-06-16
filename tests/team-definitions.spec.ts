/**
 * Team definitions from disk tests — v0.5.0
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadTeamDefinition,
  saveTeamDefinition,
  listTeamDefinitions,
  deleteTeamDefinition,
} from '../src/team/teamDefinitions.js';
import type { TeamDefinition } from '../src/types.js';

describe('Team definitions from disk', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `actoviq-team-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.actoviq', 'teams'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const panelDef: TeamDefinition = {
    name: 'test-panel',
    description: 'A test panel team',
    mode: 'panel',
    members: [
      { model: 'claude-sonnet-4-6' },
      { model: 'deepseek-v4-pro', provider: 'openai', apiKey: '$DEEPSEEK_KEY' },
    ],
    primary: { model: 'claude-opus-4-8' },
  };

  it('saves and loads a team definition', async () => {
    const filePath = await saveTeamDefinition(panelDef, { projectDir: tmpDir });
    expect(fs.existsSync(filePath)).toBe(true);

    const loaded = loadTeamDefinition('test-panel', tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.definition.name).toBe('test-panel');
    expect(loaded!.definition.mode).toBe('panel');
    expect(loaded!.source).toBe('project');
  });

  it('resolves $ENV_VAR apiKey references on load', async () => {
    process.env.TEST_TEAM_KEY = 'sk-resolved-123';
    const def: TeamDefinition = {
      name: 'env-test',
      mode: 'panel',
      members: [{ model: 'test-model', apiKey: '$TEST_TEAM_KEY' }],
      primary: { model: 'primary-model' },
    };

    await saveTeamDefinition(def, { projectDir: tmpDir });
    const loaded = loadTeamDefinition('env-test', tmpDir);
    expect(loaded!.definition.members[0]!.apiKey).toBe('sk-resolved-123');

    delete process.env.TEST_TEAM_KEY;
  });

  it('keeps $VAR references, strips literal apiKeys in saved JSON', async () => {
    const defWithMixed: TeamDefinition = {
      name: 'mixed-keys',
      mode: 'panel',
      members: [
        { model: 'm1', apiKey: '$MY_API_KEY' },
        { model: 'm2', apiKey: 'sk-literal-secret' },
      ],
      primary: { model: 'primary-model' },
    };
    await saveTeamDefinition(defWithMixed, { projectDir: tmpDir });

    // Read the raw file
    const filePath = path.join(tmpDir, '.actoviq', 'teams', 'mixed-keys.json');
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    // $VAR references should be KEPT (not secrets)
    expect(raw.members[0].apiKey).toBe('$MY_API_KEY');
    // Literal apiKeys should be STRIPPED (don't store secrets on disk)
    expect(raw.members[1].apiKey).toBeUndefined();
  });

  it('lists all team definitions', async () => {
    await saveTeamDefinition(panelDef, { projectDir: tmpDir });
    const routerDef: TeamDefinition = {
      name: 'test-router',
      mode: 'router',
      members: [],
      router: { model: 'haiku' },
      specialists: { code: { model: 'sonnet' } },
    };
    await saveTeamDefinition(routerDef, { projectDir: tmpDir });

    const teams = listTeamDefinitions(tmpDir);
    expect(teams.length).toBe(2);
    expect(teams.map((t) => t.name).sort()).toEqual(['test-panel', 'test-router']);
  });

  it('deletes a team definition', async () => {
    await saveTeamDefinition(panelDef, { projectDir: tmpDir });
    expect(loadTeamDefinition('test-panel', tmpDir)).not.toBeNull();

    const deleted = await deleteTeamDefinition('test-panel', tmpDir);
    expect(deleted).toBe(true);
    expect(loadTeamDefinition('test-panel', tmpDir)).toBeNull();
  });

  it('returns null for non-existent team', () => {
    expect(loadTeamDefinition('nonexistent', tmpDir)).toBeNull();
  });

  it('prevents overwrite by default', async () => {
    await saveTeamDefinition(panelDef, { projectDir: tmpDir });
    await expect(
      saveTeamDefinition(panelDef, { projectDir: tmpDir }),
    ).rejects.toThrow('already exists');
  });

  it('project definitions override personal ones', async () => {
    const homeDir = path.join(tmpDir, 'home');
    fs.mkdirSync(path.join(homeDir, 'teams'), { recursive: true });

    const personalDef: TeamDefinition = {
      name: 'override-test',
      mode: 'panel',
      members: [{ model: 'personal-model' }],
      primary: { model: 'personal-primary' },
    };
    const projectDef: TeamDefinition = {
      name: 'override-test',
      mode: 'panel',
      members: [{ model: 'project-model' }],
      primary: { model: 'project-primary' },
    };

    await saveTeamDefinition(personalDef, { homeDir });
    await saveTeamDefinition(projectDef, { projectDir: tmpDir });

    const loaded = loadTeamDefinition('override-test', tmpDir, homeDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.source).toBe('project');
    expect(loaded!.definition.primary!.model).toBe('project-primary');
  });
});
