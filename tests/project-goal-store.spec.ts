import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProjectGoalApi } from '../src/goal/projectGoalApi.js';
import { GOAL_METADATA_KEY } from '../src/goal/goalStore.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function session(id: string, metadata: Record<string, unknown> = {}) {
  return {
    id,
    metadata,
    async mergeMetadata(patch: Record<string, unknown>) {
      Object.assign(metadata, patch);
      return metadata;
    },
  };
}

async function stateDir(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `hadamard-project-goal-${name}-`));
  roots.push(root);
  return root;
}

describe('project Goal persistence', () => {
  it('resumes a session Goal across process reopen and leaves other chats empty', async () => {
    const directory = await stateDir('resume');
    const first = new ProjectGoalApi(directory);
    const a = session('session-a');
    const created = await first.command(a, 'start ship project goal');
    expect(created.ok).toBe(true);
    const goalId = (await first.status(a.id)).goalId;
    expect(goalId).toBeTruthy();
    await first.close();

    const reopened = new ProjectGoalApi(directory);
    const resumed = await reopened.command(a, 'status');
    expect(resumed.goal?.objective).toBe('ship project goal');
    expect((await reopened.status(a.id)).goalId).toBe(goalId);

    const b = session('session-b');
    expect((await reopened.command(b, 'status')).goal).toBeFalsy();
    expect((await reopened.status(b.id)).goalId).toBeUndefined();
    expect((await reopened.list())[0]?.attachedSessionIds).toEqual(['session-a']);

    await reopened.command(a, 'pause');
    expect((await reopened.status(a.id)).goal?.status).toBe('paused');
    await reopened.close();
  });

  it('isolates Goals stored under different canonical project directories', async () => {
    const [directoryA, directoryB] = await Promise.all([stateDir('a'), stateDir('b')]);
    const [projectA, projectB] = [new ProjectGoalApi(directoryA), new ProjectGoalApi(directoryB)];
    await projectA.command(session('same-session'), 'start objective A');
    await projectB.command(session('same-session'), 'start objective B');

    expect((await projectA.status('same-session')).goal?.objective).toBe('objective A');
    expect((await projectB.status('same-session')).goal?.objective).toBe('objective B');
    await Promise.all([projectA.close(), projectB.close()]);
  });

  it('imports a legacy session Goal once and records durable history', async () => {
    const directory = await stateDir('migration');
    const metadata: Record<string, unknown> = {
      [GOAL_METADATA_KEY]: {
        objective: 'legacy objective',
        status: 'active',
        setAt: '2026-08-04T00:00:00.000Z',
      },
    };
    const api = new ProjectGoalApi(directory);
    const legacySession = session('legacy-session', metadata);
    const service = await api.serviceForSession(legacySession);
    expect((await service.read())?.objective).toBe('legacy objective');
    expect(metadata[GOAL_METADATA_KEY]).toBeUndefined();

    const status = await api.status(legacySession.id);
    expect(status.goal?.workItems[0]?.id).toBe('goal-work:1');
    const history = await api.history(status.goalId!);
    expect(history.map(event => event.type)).toContain('legacy_imported');
    expect(history.map(event => event.type)).toContain('session_attached');
    await api.close();
  });

  it('starts a replacement Goal without overwriting archived project history', async () => {
    const directory = await stateDir('replacement');
    const api = new ProjectGoalApi(directory);
    const activeSession = session('session');
    const first = await api.command(activeSession, 'start first objective');
    const firstId = (await api.status(activeSession.id)).goalId;
    expect(first.goal?.objective).toBe('first objective');

    const second = await api.command(activeSession, 'start second objective');
    const secondId = (await api.status(activeSession.id)).goalId;
    expect(second.goal?.objective).toBe('second objective');
    expect(secondId).not.toBe(firstId);
    expect((await api.list({ includeArchived: true })).map(goal => goal.objective)).toEqual([
      'second objective',
      'first objective',
    ]);
    await api.close();
  });
});
