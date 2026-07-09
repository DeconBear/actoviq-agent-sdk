import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, it, expect } from 'vitest';

import {
  parseRouteSelection,
  classifyRoute,
  listRouterProfiles,
  loadRouterProfile,
  BUILT_IN_ROUTER_PROFILES,
} from '../src/router/modelRouter.js';
import type { RouterProfile, RouterRoute } from '../src/types.js';

const routes: RouterRoute[] = [
  { name: 'fast', model: 'haiku', when: 'simple or quick tasks' },
  { name: 'strong', model: 'opus', when: 'hard reasoning or planning' },
];

describe('parseRouteSelection', () => {
  it('selects by 1-based number', () => {
    expect(parseRouteSelection('1', routes)).toBe(routes[0]);
    expect(parseRouteSelection('2', routes)).toBe(routes[1]);
    expect(parseRouteSelection('Route 2 is best', routes)).toBe(routes[1]);
  });

  it('returns null for "0" (explicit none) and out-of-range', () => {
    expect(parseRouteSelection('0', routes)).toBeNull();
    expect(parseRouteSelection('9', routes)).toBeNull();
  });

  it('falls back to a name/model substring match', () => {
    expect(parseRouteSelection('use the strong model', routes)).toBe(routes[1]);
    expect(parseRouteSelection('haiku', routes)).toBe(routes[0]);
  });

  it('returns null for unmatchable output', () => {
    expect(parseRouteSelection('banana', routes)).toBeNull();
    expect(parseRouteSelection('', routes)).toBeNull();
  });
});

describe('classifyRoute', () => {
  const base: RouterProfile = {
    name: 'r',
    routerModel: { model: 'classifier' },
    routes,
    fallback: { model: 'sonnet' },
  };

  it('routes to the matched route', async () => {
    const decision = await classifyRoute(base, 'plan a hard refactor', undefined, {
      classify: async () => '2',
    });
    expect(decision.target.model).toBe('opus');
    expect(decision.label).toBe('strong');
    expect(decision.matched).toBe(true);
  });

  it('uses the fallback when the classifier matches nothing', async () => {
    const decision = await classifyRoute(base, 'whatever', undefined, {
      classify: async () => '0',
    });
    expect(decision.target.model).toBe('sonnet');
    expect(decision.matched).toBe(false);
    expect(decision.label).toBe('fallback:sonnet');
  });

  it('falls back to the first route when there is no fallback and no match', async () => {
    const noFallback: RouterProfile = { ...base, fallback: undefined };
    const decision = await classifyRoute(noFallback, 'whatever', undefined, {
      classify: async () => '0',
    });
    expect(decision.target.model).toBe('haiku');
    expect(decision.matched).toBe(false);
  });

  it('falls back gracefully when the classifier throws', async () => {
    const decision = await classifyRoute(base, 'anything', undefined, {
      classify: async () => {
        throw new Error('classifier down');
      },
    });
    expect(decision.matched).toBe(false);
    expect(decision.target.model).toBe('sonnet'); // fallback
    expect(decision.classification).toBe('');
  });
});

describe('leader/dispatch enrichment', () => {
  const specialists: RouterRoute[] = [
    { role: 'frontend', model: 'sonnet', when: 'UI work', description: 'React + CSS expert' },
    { role: 'backend', model: 'deepseek-v4-pro', when: 'APIs and databases' },
  ];

  it('matches a specialist by role substring', () => {
    expect(parseRouteSelection('hand this to the backend specialist', specialists)).toBe(specialists[1]);
    expect(parseRouteSelection('frontend', specialists)).toBe(specialists[0]);
  });

  it('labels the decision by role when present', async () => {
    const profile: RouterProfile = { name: 'leader', routerModel: { model: 'lead' }, routes: specialists };
    const decision = await classifyRoute(profile, 'build an API endpoint', undefined, { classify: async () => '2' });
    expect(decision.label).toBe('backend');
    expect(decision.target.model).toBe('deepseek-v4-pro');
  });

  it('builds a leader/dispatch prompt listing each specialist role + description', async () => {
    const profile: RouterProfile = { name: 'leader', routerModel: { model: 'lead' }, routes: specialists };
    let captured = '';
    await classifyRoute(profile, 'style the navbar', undefined, {
      classify: async (prompt) => { captured = prompt; return '1'; },
    });
    expect(captured.toLowerCase()).toContain('leader');
    expect(captured.toLowerCase()).toContain('specialist');
    expect(captured).toContain('frontend');
    expect(captured).toContain('React + CSS expert');
  });
});

describe('built-in dispatch profile', () => {
  const tempDirs: string[] = [];
  const tempHome = (): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'actoviq-router-'));
    tempDirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('ships a well-formed dispatch profile (leader + role/when specialists)', () => {
    const profile = BUILT_IN_ROUTER_PROFILES.dispatch!;
    expect(profile.routerModel.model).toBeTruthy();
    expect(profile.routes.length).toBeGreaterThanOrEqual(2);
    expect(profile.routes.every((r) => Boolean(r.role) && Boolean(r.when) && Boolean(r.model))).toBe(true);
  });

  it('is listed even with no router files on disk', () => {
    const listed = listRouterProfiles(undefined, tempHome());
    const dispatch = listed.find((p) => p.name === 'dispatch');
    expect(dispatch).toBeDefined();
    expect(dispatch!.source).toBe('built-in');
  });

  it('loads by name without a file on disk', () => {
    const loaded = loadRouterProfile('dispatch', undefined, tempHome());
    expect(loaded).not.toBeNull();
    expect(loaded!.source).toBe('built-in');
    expect(loaded!.profile.routes.length).toBeGreaterThanOrEqual(2);
  });

  it('is shadowed by a user profile of the same name (not duplicated)', () => {
    const home = tempHome();
    const dir = path.join(home, 'routers');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'dispatch.json'),
      JSON.stringify({ name: 'dispatch', routerModel: { model: 'mine' }, routes: [{ role: 'x', model: 'm', when: 'w' }] }),
      'utf-8',
    );

    const loaded = loadRouterProfile('dispatch', undefined, home);
    expect(loaded!.source).toBe('personal');
    expect(loaded!.profile.routerModel.model).toBe('mine');

    const dispatchEntries = listRouterProfiles(undefined, home).filter((p) => p.name === 'dispatch');
    expect(dispatchEntries).toHaveLength(1);
    expect(dispatchEntries[0]!.source).toBe('personal');
  });
});

describe('saveRouterProfile / deleteRouterProfile', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    temps.push(dir);
    return dir;
  }

  it('writes a project profile and can delete it', async () => {
    const { saveRouterProfile, deleteRouterProfile } = await import('../src/router/modelRouter.js');
    const project = tempDir('actoviq-router-proj-');
    const home = tempDir('actoviq-router-home-');
    const filePath = await saveRouterProfile(
      {
        name: 'fast-strong',
        routerModel: { model: 'leader' },
        routes: [{ role: 'quick', model: 'haiku', when: 'simple' }],
        fallback: { model: 'sonnet' },
      },
      { projectDir: project, homeDir: home, overwrite: true },
    );
    expect(filePath).toContain(path.join('.actoviq', 'routers', 'fast-strong.json'));
    const loaded = loadRouterProfile('fast-strong', project, home);
    expect(loaded?.source).toBe('project');
    expect(loaded?.profile.routes[0]?.role).toBe('quick');
    expect(await deleteRouterProfile('fast-strong', project, home)).toBe(true);
    expect(loadRouterProfile('fast-strong', project, home)).toBeNull();
  });
});
