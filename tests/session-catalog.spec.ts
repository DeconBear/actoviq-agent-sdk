import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getActoviqProjectSessionDirectory } from '../src/config/projectSessionDirectory.js';
import {
  SessionCatalog,
  type SessionCatalogLocator,
} from '../src/storage/sessionCatalog.js';
import { SessionStore } from '../src/storage/sessionStore.js';

let homeDir: string;
let projectA: string;
let projectB: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-home-'));
  projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-a-'));
  projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-b-'));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(projectA, { recursive: true, force: true });
  fs.rmSync(projectB, { recursive: true, force: true });
});

async function seed(
  projectPath: string,
  id: string,
  kind: 'main' | 'manager' | 'agent',
  title: string,
  updatedAt: string,
  pinned = false,
) {
  const root = getActoviqProjectSessionDirectory(projectPath, homeDir);
  const store = new SessionStore(root);
  await store.create({
    id,
    title,
    model: 'test-model',
    kind,
    metadata: {
      __actoviqWorkDir: projectPath,
      __actoviqKind: kind,
      ...(pinned ? { __actoviqPinned: true } : {}),
    },
  });
  await store.mutate(id, session => ({ ...session, updatedAt }));
}

function catalog(activity?: {
  runningSessionIds?: ReadonlySet<string>;
  waitingSessionIds?: ReadonlySet<string>;
}) {
  return new SessionCatalog({
    homeDir,
    projectPaths: [projectA, projectB],
    activity,
  });
}

describe('SessionCatalog query', () => {
  it('aggregates only known projects and defaults to user chats', async () => {
    await seed(projectA, 'user-a', 'main', 'Alpha chat', '2026-07-01T00:00:00.000Z');
    await seed(projectB, 'manager-b', 'manager', 'Project manager', '2026-07-02T00:00:00.000Z');
    await seed(projectB, 'agent-b', 'agent', 'Reviewer child', '2026-07-03T00:00:00.000Z');
    const unknown = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-unknown-'));
    try {
      await seed(unknown, 'unknown-chat', 'main', 'Hidden project', '2026-07-04T00:00:00.000Z');
      const page = await catalog().query();
      expect(page.items.map(item => item.title)).toEqual(['Alpha chat']);
      const internal = await catalog().query({
        types: ['assistant-project', 'agent'],
        archived: 'all',
      });
      expect(internal.items.map(item => item.type).sort()).toEqual(['agent', 'assistant-project']);
      expect(JSON.stringify(internal)).not.toContain('Hidden project');
    } finally {
      fs.rmSync(unknown, { recursive: true, force: true });
    }
  });

  it('filters, paginates, and sorts live then pinned then recently updated', async () => {
    await seed(projectA, 'old-running', 'main', 'Old running', '2026-07-01T00:00:00.000Z');
    await seed(projectA, 'pinned', 'main', 'Pinned', '2026-07-02T00:00:00.000Z', true);
    await seed(projectB, 'newest', 'main', 'Newest', '2026-07-03T00:00:00.000Z');
    const service = catalog({ runningSessionIds: new Set(['old-running']) });
    const first = await service.query({ keyword: 'n', pageSize: 2 });
    expect(first.total).toBe(3);
    expect(first.items.map(item => item.title)).toEqual(['Old running', 'Pinned']);
    const second = await service.query({ keyword: 'n', page: 2, pageSize: 2 });
    expect(second.items.map(item => item.title)).toEqual(['Newest']);
  });

  it('returns a bounded read-only conversation reference without injected reminders', async () => {
    await seed(projectA, 'reference', 'main', 'Reference chat', '2026-07-01T00:00:00.000Z');
    const store = new SessionStore(getActoviqProjectSessionDirectory(projectA, homeDir));
    await store.mutate('reference', session => ({
      ...session,
      messages: [
        { role: 'user', content: '<system-reminder>internal context</system-reminder>' },
        { role: 'user', content: 'What changed in the renderer?' },
        { role: 'assistant', content: 'The menu layout was simplified.' },
      ],
    }));
    const service = catalog();
    const item = (await service.query()).items[0]!;
    const reference = await service.reference(item.locator);
    expect(reference.item.title).toBe('Reference chat');
    expect(reference.messages).toEqual([
      { role: 'user', text: 'What changed in the renderer?' },
      { role: 'assistant', text: 'The menu layout was simplified.' },
    ]);
    expect((await store.load('reference')).messages).toHaveLength(3);
  });
});

describe('SessionCatalog actions', () => {
  it('creates, atomically renames and pins a user Session', async () => {
    const service = catalog();
    const created = await service.action({
      action: 'create',
      type: 'user',
      projectPath: projectA,
      title: 'Draft',
      model: 'test-model',
    });
    const renamed = await service.action({
      action: 'rename',
      locator: created.locator,
      title: 'Manual title',
    });
    expect(renamed.title).toBe('Manual title');
    expect(renamed.titleSource).toBe('manual');
    const pinned = await service.action({
      action: 'pin',
      locator: created.locator,
      pinned: true,
    });
    expect(pinned.pinned).toBe(true);
    const stored = await new SessionStore(
      getActoviqProjectSessionDirectory(projectA, homeDir),
    ).load(created.locator.sessionId);
    expect(stored.revision).toBeGreaterThanOrEqual(3);
    expect(stored.metadata.__actoviqPinned).toBe(true);
  });

  it('archives, restores, then permanently deletes only from archive', async () => {
    await seed(projectA, 'lifecycle', 'main', 'Lifecycle', '2026-07-01T00:00:00.000Z');
    const service = catalog();
    const locator: SessionCatalogLocator = {
      scope: 'project',
      projectPath: projectA,
      sessionId: 'lifecycle',
      archived: false,
    };
    const archived = await service.action({ action: 'archive', locator });
    expect(archived.archived).toBe(true);
    const restored = await service.action({ action: 'restore', locator: archived.locator });
    expect(restored.archived).toBe(false);
    const archivedAgain = await service.action({ action: 'archive', locator: restored.locator });
    await service.action({ action: 'delete', locator: archivedAgain.locator });
    expect((await service.query({ archived: 'all' })).items).toHaveLength(0);
  });

  it('protects live Sessions and keeps Agent child Sessions read-only', async () => {
    await seed(projectA, 'running', 'main', 'Running', '2026-07-01T00:00:00.000Z');
    await seed(projectA, 'child', 'agent', 'Child', '2026-07-01T00:00:00.000Z');
    const service = catalog({ waitingSessionIds: new Set(['running']) });
    const user = (await service.query()).items[0]!;
    await expect(service.action({ action: 'archive', locator: user.locator }))
      .rejects.toThrow(/waiting/i);
    const child = (await service.query({ types: ['agent'] })).items[0]!;
    await expect(service.action({ action: 'pin', locator: child.locator }))
      .rejects.toThrow(/read-only/i);
  });

  it('rejects unknown projects', async () => {
    const service = catalog();
    await expect(service.action({
      action: 'create',
      type: 'user',
      projectPath: path.join(homeDir, 'unknown'),
    })).rejects.toThrow(/Unknown project path/i);
  });
});
