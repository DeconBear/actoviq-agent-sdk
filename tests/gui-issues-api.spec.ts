import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startActoviqGuiServer } from '../src/gui/actoviqGui.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function api<T>(
  server: Awaited<ReturnType<typeof startActoviqGuiServer>>,
  requestPath: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.url}${requestPath}`, {
    ...init,
    headers: {
      'x-actoviq-token': server.token,
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json() as T };
}

describe('GUI issues API', () => {
  it('creates, transitions, comments, edits, and migrates project issues', async () => {
    const root = await tempRoot('actoviq-gui-issues-');
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    const configPath = path.join(homeDir, '.actoviq', 'settings.json');
    await mkdir(workDir, { recursive: true });
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      ACTOVIQ_PROVIDER: 'openai',
      ACTOVIQ_API_KEY: 'test-key',
      ACTOVIQ_MODEL: 'gpt-4o-mini',
    }), 'utf8');

    const port = 48000 + Math.floor(Math.random() * 8000);
    const server = await startActoviqGuiServer({
      workDir,
      homeDir,
      host: '127.0.0.1',
      port,
      configPath,
    });

    try {
      const empty = await api<{ storage: string; issues: unknown[] }>(server, 'api/issues');
      expect(empty.status).toBe(200);
      expect(empty.body.storage).toBe('home');
      expect(empty.body.issues).toEqual([]);

      const created = await api<{
        issue: { id: string; number: number; title: string; status: string; priority: string };
        issues: Array<{ id: string; title: string }>;
      }>(server, 'api/issues', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Polish project detail UI', priority: 'high', labels: ['ui'] }),
      });
      expect(created.status).toBe(200);
      expect(created.body.issue.number).toBe(1);
      expect(created.body.issue.status).toBe('todo');
      expect(created.body.issue.priority).toBe('high');
      expect(created.body.issues).toHaveLength(1);

      const inProgress = await api<{
        issue: { id: string; status: string; comments: Array<{ kind: string; toStatus?: string }> };
      }>(server, 'api/issues/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: created.body.issue.id, status: 'in_progress' }),
      });
      expect(inProgress.status).toBe(200);
      expect(inProgress.body.issue.status).toBe('in_progress');
      expect(inProgress.body.issue.comments.at(-1)).toMatchObject({ kind: 'status_change', toStatus: 'in_progress' });

      const commented = await api<{
        issue: { comments: Array<{ body: string; kind: string }> };
      }>(server, 'api/issues/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: created.body.issue.id, body: 'Designer pass requested.', kind: 'progress' }),
      });
      expect(commented.status).toBe(200);
      expect(commented.body.issue.comments.at(-1)).toMatchObject({ body: 'Designer pass requested.', kind: 'progress' });

      const edited = await api<{
        issue: { title: string; priority: string; labels: string[] };
      }>(server, 'api/issues', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: created.body.issue.id,
          title: 'Polish project detail issues UI',
          priority: 'urgent',
          labels: ['ui', 'issues'],
        }),
      });
      expect(edited.status).toBe(200);
      expect(edited.body.issue.title).toBe('Polish project detail issues UI');
      expect(edited.body.issue.priority).toBe('urgent');
      expect(edited.body.issue.labels).toEqual(['ui', 'issues']);

      const migrated = await api<{
        storage: string;
        issues: Array<{ id: string; title: string }>;
      }>(server, 'api/issues/storage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'workspace' }),
      });
      expect(migrated.status).toBe(200);
      expect(migrated.body.storage).toBe('workspace');
      expect(migrated.body.issues).toHaveLength(1);
      await expect(readFile(path.join(workDir, '.actoviq', 'issues.json'), 'utf8')).resolves.toContain('Polish project detail issues UI');

      const deleted = await api<{ issues: unknown[] }>(server, 'api/issues/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: created.body.issue.id }),
      });
      expect(deleted.status).toBe(200);
      expect(deleted.body.issues).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
