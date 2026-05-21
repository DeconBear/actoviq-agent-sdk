import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MailboxStore, SessionStore, TeammateStore } from '../src/index.js';
import { BackgroundTaskStore } from '../src/storage/backgroundTaskStore.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function createRoot(prefix: string): Promise<{ temp: string; root: string; escaped: string }> {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(temp);
  const root = path.join(temp, 'store-root');
  const escaped = path.join(temp, 'escaped.json');
  await mkdir(root, { recursive: true });
  await writeFile(escaped, '{"sentinel":true}\n', 'utf8');
  return { temp, root, escaped };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('storage path safety', () => {
  it('rejects traversal session ids before touching files outside the session root', async () => {
    const { root, escaped } = await createRoot('actoviq-storage-session-');
    await mkdir(path.join(root, 'sessions'), { recursive: true });
    const store = new SessionStore(root);

    await expect(store.delete('../../escaped')).rejects.toThrow('Unsafe sessionId');

    expect(await exists(escaped)).toBe(true);
  });

  it('rejects traversal task ids before touching files outside the task root', async () => {
    const { root, escaped } = await createRoot('actoviq-storage-task-');
    await mkdir(path.join(root, 'tasks'), { recursive: true });
    const store = new BackgroundTaskStore(root);

    await expect(store.delete('../../escaped')).rejects.toThrow('Unsafe taskId');

    expect(await exists(escaped)).toBe(true);
  });

  it('rejects traversal mailbox team names and recipients', async () => {
    const { root, escaped } = await createRoot('actoviq-storage-mailbox-');
    const store = new MailboxStore(root);
    const message = {
      from: 'lead',
      kind: 'status' as const,
      text: 'hello',
      createdAt: new Date().toISOString(),
    };

    await expect(store.post('../../outside', 'member', message)).rejects.toThrow('Unsafe teamName');
    await expect(store.post('team', '../../outside', message)).rejects.toThrow('Unsafe recipient');

    expect(await exists(escaped)).toBe(true);
  });

  it('rejects traversal teammate team names and names', async () => {
    const { root, escaped } = await createRoot('actoviq-storage-teammate-');
    const store = new TeammateStore(root);
    const record = {
      name: 'member',
      agentName: 'agent',
      sessionId: 'session',
      status: 'idle' as const,
      leaderName: 'leader',
      originPrompt: 'prompt',
      lineage: [],
      mailboxDepth: 0,
      mailboxMessageCount: 0,
      mailboxTurns: 0,
      runCount: 0,
      backgroundRunCount: 0,
      recoveryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await expect(store.create('../../outside', record)).rejects.toThrow('Unsafe teamName');
    await expect(store.create('team', { ...record, name: '../../outside' })).rejects.toThrow('Unsafe name');

    expect(await exists(escaped)).toBe(true);
  });
});
