import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import {
  ContextRailReminderScheduler,
  createContextRailItem,
  normalizeContextRailStore,
  readContextRailStore,
  sortContextRailItems,
  writeContextRailStore,
} from '../src/gui/contextRailStore.js';

describe('contextRailStore', () => {
  it('normalizes and persists rail items per workspace', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-rail-home-'));
    const workDir = path.join(homeDir, 'proj');
    const todo = createContextRailItem('todo', 'Ship feature');
    const reminder = createContextRailItem('reminder', 'Standup', {
      remindAt: '2026-07-09T09:00:00.000Z',
    });
    await writeContextRailStore(workDir, homeDir, { items: [todo, reminder] });
    const loaded = await readContextRailStore(workDir, homeDir);
    expect(loaded.items).toHaveLength(2);
    expect(loaded.items.find(item => item.kind === 'todo')?.text).toBe('Ship feature');
    expect(loaded.items.find(item => item.kind === 'reminder')?.remindAt).toBe('2026-07-09T09:00:00.000Z');
  });

  it('sorts open items before completed/fired', () => {
    const open = createContextRailItem('todo', 'open');
    const done = createContextRailItem('todo', 'done');
    done.done = true;
    const sorted = sortContextRailItems([done, open]);
    expect(sorted[0]?.text).toBe('open');
  });

  it('scheduler enqueues due reminders', async () => {
    const scheduler = new ContextRailReminderScheduler();
    const fired: string[] = [];
    scheduler.setOnFire(async (_wd, _hd, item) => {
      fired.push(item.id);
    });
    const past = createContextRailItem('reminder', 'Past', {
      remindAt: new Date(Date.now() - 1000).toISOString(),
    });
    await scheduler.sync('/tmp/w', '/tmp/h', { items: [past] });
    expect(fired).toEqual([past.id]);
    const notes = scheduler.drainNotifications();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toBe('Past');
  });

  it('rejects invalid store entries', () => {
    const store = normalizeContextRailStore({
      items: [{ id: '', kind: 'todo', text: 'x' }, { id: 'a', kind: 'nope', text: 'y' }],
    });
    expect(store.items).toHaveLength(0);
  });
});
