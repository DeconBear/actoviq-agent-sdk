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
  cloneTeamDefinition,
  BUILT_IN_TEAM_DEFINITIONS,
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
    expect(loaded!.definition.mode).toBe('graph');
    expect(loaded!.definition.version).toBe(3);
    expect(loaded!.definition.nodes?.some((n) => n.kind === 'task')).toBe(true);
    expect(loaded!.definition.nodes?.some((n) => n.kind === 'return')).toBe(true);
    expect(loaded!.source).toBe('project');
  });

  it('preserves member responsibilities and review edges', async () => {
    const def: TeamDefinition = {
      name: 'collab-team',
      mode: 'panel-analysis',
      members: [
        {
          id: 'planner',
          name: 'Planner',
          role: 'planner',
          model: 'claude-sonnet-4-6',
          responsibility: 'Break the task into implementation steps.',
          reviews: ['coder'],
          runtime: 'claude-code',
          toolScope: ['Read', 'Grep'],
        },
        {
          id: 'coder',
          name: 'Coder',
          role: 'coder',
          model: 'deepseek-v4-pro',
          responsibility: 'Implement the agreed changes.',
        },
      ],
      reviewEdges: [{ from: 'planner', to: 'coder', kind: 'review' }],
    };

    await saveTeamDefinition(def, { projectDir: tmpDir });
    const loaded = loadTeamDefinition('collab-team', tmpDir);

    const planner = loaded!.definition.nodes?.find((n) => n.id === 'planner');
    expect(planner).toMatchObject({
      responsibility: 'Break the task into implementation steps.',
      reviews: ['coder'],
      runtime: 'claude-code',
      toolScope: ['Read', 'Grep'],
    });
    expect(loaded!.definition.edges?.some((e) => e.channel === 'review')).toBe(true);
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
    const agent = loaded!.definition.nodes?.find((n) => n.kind === 'agent');
    expect(agent?.apiKey).toBe('sk-resolved-123');

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

    expect(raw.mode).toBe('graph');
    expect(raw.version).toBe(3);
    expect(raw.nodes.some((n: { kind?: string }) => n.kind === 'task')).toBe(true);
    expect(raw.nodes.some((n: { kind?: string }) => n.kind === 'return')).toBe(true);
    const agents = raw.nodes.filter((n: { kind?: string }) => (n.kind ?? 'agent') === 'agent');
    // $VAR references should be KEPT (not secrets)
    expect(agents[0].apiKey).toBe('$MY_API_KEY');
    // Literal apiKeys should be STRIPPED (don't store secrets on disk)
    expect(agents[1].apiKey).toBeUndefined();
  });

  it('lists all team definitions', async () => {
    await saveTeamDefinition(panelDef, { projectDir: tmpDir });
    const reviewerDef: TeamDefinition = {
      name: 'test-reviewer',
      mode: 'reviewer',
      members: [],
      reviewer: { model: 'opus' },
    };
    await saveTeamDefinition(reviewerDef, { projectDir: tmpDir });

    const teams = listTeamDefinitions(tmpDir);
    // Saved definitions plus the 5 built-in presets (panel-analysis, analysis,
    // reviewer, quick-review, security-audit).
    const saved = teams.filter((t) => t.source !== 'built-in');
    expect(saved.length).toBe(2);
    expect(saved.map((t) => t.name).sort()).toEqual(['test-panel', 'test-reviewer']);
    const builtIn = teams.filter((t) => t.source === 'built-in');
    expect(builtIn.map((t) => t.name).sort()).toEqual([
      'analysis',
      'panel-analysis',
      'quick-review',
      'reviewer',
      'security-audit',
    ]);
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

  it('refuses to save over a built-in preset name by default', async () => {
    const def: TeamDefinition = {
      ...BUILT_IN_TEAM_DEFINITIONS['reviewer']!,
      description: 'my hacked reviewer',
    };
    await expect(saveTeamDefinition(def, { projectDir: tmpDir })).rejects.toThrow(/built-in preset/);
    // Explicit overwrite is the opt-in shadowing escape hatch.
    const filePath = await saveTeamDefinition(def, { projectDir: tmpDir, overwrite: true });
    expect(fs.existsSync(filePath)).toBe(true);
    const loaded = loadTeamDefinition('reviewer', tmpDir);
    expect(loaded!.source).toBe('project');
    expect(loaded!.definition.description).toBe('my hacked reviewer');
  });

  it('a user file shadows the built-in of the same name in list results', async () => {
    const shadow: TeamDefinition = {
      ...BUILT_IN_TEAM_DEFINITIONS['analysis']!,
      description: 'shadowed',
    };
    await saveTeamDefinition(shadow, { projectDir: tmpDir, overwrite: true });
    const teams = listTeamDefinitions(tmpDir);
    const analysis = teams.filter((t) => t.name === 'analysis');
    expect(analysis).toHaveLength(1);
    expect(analysis[0]!.source).toBe('project');
    expect(analysis[0]!.definition.description).toBe('shadowed');
  });

  it('clones a built-in preset to a new user-owned definition', async () => {
    const clone = await cloneTeamDefinition('security-audit', 'my-audit', { projectDir: tmpDir });
    expect(clone.source).toBe('project');
    expect(clone.definition.name).toBe('my-audit');
    expect(clone.definition.mode).toBe('graph');
    expect(clone.definition.version).toBe(3);
    expect(clone.definition.nodes?.some((n) => n.kind === 'task')).toBe(true);
    expect(clone.definition.nodes?.some((n) => n.kind === 'return')).toBe(true);
    expect(clone.definition.nodes?.filter((n) => (n.kind ?? 'agent') === 'agent').map((m) => m.role)).toEqual([
      'attacker',
      'auditor',
      'synthesizer',
    ]);

    const loaded = loadTeamDefinition('my-audit', tmpDir);
    expect(loaded!.source).toBe('project');
    // The built-in itself is untouched.
    expect(BUILT_IN_TEAM_DEFINITIONS['security-audit']!.name).toBe('security-audit');
  });

  it('clone preserves $ENV_VAR apiKey references from disk sources', async () => {
    process.env.CLONE_TEST_KEY = 'sk-resolved-clone';
    await saveTeamDefinition(
      {
        name: 'env-source',
        mode: 'panel',
        members: [{ model: 'm1', apiKey: '$CLONE_TEST_KEY' }],
        primary: { model: 'p1' },
      },
      { projectDir: tmpDir },
    );

    await cloneTeamDefinition('env-source', 'env-clone', { projectDir: tmpDir });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, '.actoviq', 'teams', 'env-clone.json'), 'utf-8'));
    const agent = raw.nodes.find((n: { kind?: string }) => (n.kind ?? 'agent') === 'agent');
    expect(agent.apiKey).toBe('$CLONE_TEST_KEY');
    delete process.env.CLONE_TEST_KEY;
  });

  it('clone rejects built-in target names, same-name clones, and unknown sources', async () => {
    await expect(cloneTeamDefinition('reviewer', 'reviewer', { projectDir: tmpDir })).rejects.toThrow(/different name/);
    await expect(cloneTeamDefinition('reviewer', 'analysis', { projectDir: tmpDir })).rejects.toThrow(/built-in preset name/);
    await expect(cloneTeamDefinition('does-not-exist', 'copy', { projectDir: tmpDir })).rejects.toThrow(/not found/);
  });

  it('resolves and strips graph node apiKeys like members', async () => {
    process.env.NODE_KEY_TEST = 'sk-node-key';
    const def: TeamDefinition = {
      name: 'graph-keys',
      mode: 'graph',
      version: 2,
      orchestration: 'graph',
      members: [],
      nodes: [
        { id: 'a', model: 'm1', entry: true, apiKey: '$NODE_KEY_TEST' },
        { id: 'b', model: 'm2', apiKey: 'sk-literal-node' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    await saveTeamDefinition(def, { projectDir: tmpDir });

    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, '.actoviq', 'teams', 'graph-keys.json'), 'utf-8'));
    const agents = raw.nodes.filter((n: { kind?: string }) => (n.kind ?? 'agent') === 'agent');
    expect(agents[0].apiKey).toBe('$NODE_KEY_TEST'); // $refs kept
    expect(agents[1].apiKey).toBeUndefined(); // literals stripped

    const loaded = loadTeamDefinition('graph-keys', tmpDir);
    const loadedAgent = loaded!.definition.nodes!.find((n) => n.id === 'a');
    expect(loadedAgent!.apiKey).toBe('sk-node-key'); // resolved on load
    delete process.env.NODE_KEY_TEST;
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
    expect(loaded!.definition.nodes?.some((n) => n.model === 'project-model')).toBe(true);
    expect(loaded!.definition.nodes?.some((n) => n.model === 'project-primary')).toBe(true);
  });
});
