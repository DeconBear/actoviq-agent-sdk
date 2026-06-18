import { describe, it, expect } from 'vitest';

import { parseRouteSelection, classifyRoute } from '../src/router/modelRouter.js';
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
