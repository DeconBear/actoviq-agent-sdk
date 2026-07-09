import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { getActoviqProjectSessionDirectory } from '../config/projectSessionDirectory.js';
import { isRecord } from '../runtime/helpers.js';

export type ContextRailItemKind = 'todo' | 'reminder';

export interface ContextRailItem {
  id: string;
  kind: ContextRailItemKind;
  text: string;
  done?: boolean;
  /** ISO-8601 datetime for reminders. */
  remindAt?: string | null;
  /** Set when a scheduled reminder fires. */
  firedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContextRailStore {
  items: ContextRailItem[];
}

export interface ContextRailNotification {
  id: string;
  itemId: string;
  text: string;
  remindAt: string;
  firedAt: string;
}

export const EMPTY_CONTEXT_RAIL_STORE: ContextRailStore = { items: [] };

export function contextRailStorePath(workDir: string, homeDir: string): string {
  return path.join(getActoviqProjectSessionDirectory(workDir, homeDir), 'rail-items.json');
}

function normalizeItem(raw: unknown): ContextRailItem | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const kind = raw.kind === 'todo' || raw.kind === 'reminder' ? raw.kind : null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!id || !kind || !text) return null;
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt;
  const item: ContextRailItem = { id, kind, text, createdAt, updatedAt };
  if (typeof raw.done === 'boolean') item.done = raw.done;
  if (typeof raw.remindAt === 'string' && raw.remindAt.trim()) item.remindAt = raw.remindAt.trim();
  if (raw.remindAt === null) item.remindAt = null;
  if (typeof raw.firedAt === 'string' && raw.firedAt.trim()) item.firedAt = raw.firedAt.trim();
  if (raw.firedAt === null) item.firedAt = null;
  if (kind === 'todo') {
    item.remindAt = undefined;
    item.firedAt = undefined;
  }
  if (kind === 'reminder' && item.remindAt && !Number.isFinite(Date.parse(item.remindAt))) {
    item.remindAt = null;
  }
  if (kind === 'reminder' && typeof item.done !== 'boolean') item.done = false;
  return item;
}

export function normalizeContextRailStore(raw: unknown): ContextRailStore {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return { items: [] };
  const items: ContextRailItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw.items) {
    const item = normalizeItem(entry);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return { items };
}

export async function readContextRailStore(workDir: string, homeDir: string): Promise<ContextRailStore> {
  try {
    const raw = JSON.parse(await readFile(contextRailStorePath(workDir, homeDir), 'utf8'));
    return normalizeContextRailStore(raw);
  } catch {
    return { ...EMPTY_CONTEXT_RAIL_STORE, items: [] };
  }
}

export async function writeContextRailStore(
  workDir: string,
  homeDir: string,
  store: ContextRailStore,
): Promise<ContextRailStore> {
  const normalized = normalizeContextRailStore(store);
  const filePath = contextRailStorePath(workDir, homeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

export function createContextRailItem(
  kind: ContextRailItemKind,
  text: string,
  opts?: { remindAt?: string | null; done?: boolean },
): ContextRailItem {
  const now = new Date().toISOString();
  const item: ContextRailItem = {
    id: `rail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    text: text.trim(),
    createdAt: now,
    updatedAt: now,
  };
  if (kind === 'todo') {
    item.done = Boolean(opts?.done);
  } else {
    item.remindAt = opts?.remindAt ?? null;
    item.firedAt = null;
    item.done = Boolean(opts?.done);
  }
  return item;
}

/** Sort todos/reminders for display: open first, then by createdAt. */
export function sortContextRailItems(items: ContextRailItem[]): ContextRailItem[] {
  return [...items].sort((a, b) => {
    const aOpen = a.kind === 'todo' ? !a.done : !a.done;
    const bOpen = b.kind === 'todo' ? !b.done : !b.done;
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    if (a.kind === 'reminder' && b.kind === 'reminder' && a.remindAt && b.remindAt) {
      return Date.parse(a.remindAt) - Date.parse(b.remindAt);
    }
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
}

export class ContextRailReminderScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending: ContextRailNotification[] = [];
  private workDir = '';
  private homeDir = '';
  private onFire: ((workDir: string, homeDir: string, item: ContextRailItem) => Promise<void>) | null = null;

  setOnFire(
    handler: (workDir: string, homeDir: string, item: ContextRailItem) => Promise<void>,
  ): void {
    this.onFire = handler;
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  drainNotifications(): ContextRailNotification[] {
    const out = [...this.pending];
    this.pending = [];
    return out;
  }

  async sync(workDir: string, homeDir: string, store: ContextRailStore): Promise<void> {
    this.clear();
    this.workDir = workDir;
    this.homeDir = homeDir;
    const now = Date.now();
    for (const item of store.items) {
      if (item.kind !== 'reminder' || !item.remindAt || item.done || item.firedAt) continue;
      const at = Date.parse(item.remindAt);
      if (!Number.isFinite(at)) continue;
      const delay = at - now;
      if (delay <= 0) {
        await this.fire(item);
      } else {
        const timer = setTimeout(() => {
          void this.fire(item);
        }, delay);
        this.timers.set(item.id, timer);
      }
    }
  }

  private async fire(item: ContextRailItem): Promise<void> {
    this.timers.delete(item.id);
    if (item.firedAt) return;
    const firedAt = new Date().toISOString();
    const notification: ContextRailNotification = {
      id: `rail-notify-${item.id}-${Date.now().toString(36)}`,
      itemId: item.id,
      text: item.text,
      remindAt: item.remindAt ?? firedAt,
      firedAt,
    };
    this.pending.push(notification);
    if (this.onFire) {
      await this.onFire(this.workDir, this.homeDir, { ...item, firedAt });
    }
  }
}
