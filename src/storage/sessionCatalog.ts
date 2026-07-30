import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { getActoviqProjectSessionDirectory } from '../config/projectSessionDirectory.js';
import { SessionNotFoundError } from '../errors.js';
import { createId, nowIso } from '../runtime/helpers.js';
import { extractTextFromContent } from '../runtime/messageUtils.js';
import { SessionStore } from './sessionStore.js';
import { safeStorageFileName } from './pathSafety.js';
import type { SessionStatus, SessionSummary, StoredSession } from '../types.js';

export type SessionCatalogType =
  | 'user'
  | 'assistant-global'
  | 'assistant-project'
  | 'agent';

export type SessionCatalogRuntimeStatus = 'running' | 'waiting' | 'idle';

export interface SessionCatalogLocator {
  scope: 'project' | 'global-assistant';
  sessionId: string;
  projectPath?: string;
  archived: boolean;
}

export interface SessionCatalogItem {
  locator: SessionCatalogLocator;
  locatorKey: string;
  projectPath: string | null;
  projectName: string;
  type: SessionCatalogType;
  title: string;
  titleSource: 'auto' | 'manual';
  pinned: boolean;
  archived: boolean;
  runtimeStatus: SessionCatalogRuntimeStatus;
  sessionStatus: SessionStatus;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastActiveAt?: string;
  model: string;
  preview: string;
  brief?: string;
  messageCount: number;
  parentSessionId?: string;
  executionId?: string;
}

export interface SessionCatalogQuery {
  projectPaths?: string[];
  types?: SessionCatalogType[];
  runtimeStatuses?: SessionCatalogRuntimeStatus[];
  archived?: boolean | 'all';
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export interface SessionCatalogPage {
  items: SessionCatalogItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SessionCatalogReferenceMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface SessionCatalogReference {
  item: SessionCatalogItem;
  messages: SessionCatalogReferenceMessage[];
}

export type SessionCatalogAction =
  | 'create'
  | 'open'
  | 'rename'
  | 'pin'
  | 'archive'
  | 'restore'
  | 'delete';

export interface SessionCatalogActionInput {
  action: SessionCatalogAction;
  locator?: SessionCatalogLocator;
  projectPath?: string;
  type?: Exclude<SessionCatalogType, 'agent'>;
  title?: string;
  pinned?: boolean;
  model?: string;
}

export interface SessionCatalogActivity {
  runningSessionIds?: ReadonlySet<string>;
  waitingSessionIds?: ReadonlySet<string>;
}

export interface SessionCatalogOptions {
  homeDir: string;
  projectPaths: string[];
  globalAssistantRoot?: string;
  activity?: SessionCatalogActivity;
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value).normalize('NFC');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function uniqueProjects(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const projectPath of paths) {
    const resolved = path.resolve(projectPath);
    const key = normalizePath(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

export function sessionCatalogLocatorKey(locator: SessionCatalogLocator): string {
  return [
    locator.scope,
    locator.projectPath ? normalizePath(locator.projectPath) : '',
    locator.sessionId,
    locator.archived ? 'archive' : 'active',
  ].join(':');
}

function runtimeStatus(
  sessionId: string,
  activity?: SessionCatalogActivity,
): SessionCatalogRuntimeStatus {
  if (activity?.runningSessionIds?.has(sessionId)) return 'running';
  if (activity?.waitingSessionIds?.has(sessionId)) return 'waiting';
  return 'idle';
}

function sessionType(
  summary: SessionSummary,
  scope: SessionCatalogLocator['scope'],
): SessionCatalogType {
  if (summary.kind === 'agent') return 'agent';
  if (scope === 'global-assistant') return 'assistant-global';
  if (summary.kind === 'manager') return 'assistant-project';
  return 'user';
}

function itemFromSummary(
  summary: SessionSummary,
  locator: SessionCatalogLocator,
  projectName: string,
  activity?: SessionCatalogActivity,
): SessionCatalogItem {
  return {
    locator,
    locatorKey: sessionCatalogLocatorKey(locator),
    projectPath: locator.projectPath ?? null,
    projectName,
    type: sessionType(summary, locator.scope),
    title: summary.title,
    titleSource: summary.titleSource,
    pinned: summary.pinned === true,
    archived: locator.archived,
    runtimeStatus: runtimeStatus(summary.id, activity),
    sessionStatus: summary.status,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    lastRunAt: summary.lastRunAt,
    lastActiveAt: summary.lastActiveAt,
    model: summary.model,
    preview: summary.preview,
    brief: summary.brief,
    messageCount: summary.messageCount,
    parentSessionId: summary.parentSessionId,
    executionId: summary.executionId,
  };
}

function mutationTimestamp(session: StoredSession): StoredSession {
  return { ...session, updatedAt: nowIso() };
}

export class SessionCatalog {
  private readonly projectPaths: string[];
  private readonly registeredProjectKeys: Set<string>;
  private readonly globalAssistantRoot: string;

  constructor(private readonly options: SessionCatalogOptions) {
    this.projectPaths = uniqueProjects(options.projectPaths);
    this.registeredProjectKeys = new Set(this.projectPaths.map(normalizePath));
    this.globalAssistantRoot = options.globalAssistantRoot
      ? path.resolve(options.globalAssistantRoot)
      : path.join(options.homeDir, 'assistant');
  }

  async query(query: SessionCatalogQuery = {}): Promise<SessionCatalogPage> {
    const all = await this.loadKnownSessions();
    const types = new Set(query.types?.length ? query.types : ['user']);
    const projectKeys = query.projectPaths?.length
      ? new Set(query.projectPaths.map(normalizePath))
      : null;
    const statuses = query.runtimeStatuses?.length
      ? new Set(query.runtimeStatuses)
      : null;
    const keyword = query.keyword?.trim().toLocaleLowerCase() ?? '';
    const archived = query.archived ?? false;
    const filtered = all.filter(item => {
      if (!types.has(item.type)) return false;
      if (projectKeys && (!item.projectPath || !projectKeys.has(normalizePath(item.projectPath)))) return false;
      if (statuses && !statuses.has(item.runtimeStatus)) return false;
      if (archived !== 'all' && item.archived !== archived) return false;
      if (keyword) {
        const haystack = [
          item.title,
          item.preview,
          item.brief,
          item.projectName,
          item.projectPath,
        ].filter(Boolean).join('\n').toLocaleLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
    filtered.sort((left, right) => {
      const liveRank = (value: SessionCatalogRuntimeStatus) =>
        value === 'running' ? 2 : value === 'waiting' ? 1 : 0;
      const live = liveRank(right.runtimeStatus) - liveRank(left.runtimeStatus);
      if (live !== 0) return live;
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return (right.updatedAt || '').localeCompare(left.updatedAt || '');
    });
    const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));
    const page = Math.max(1, query.page ?? 1);
    const start = (page - 1) * pageSize;
    return {
      items: filtered.slice(start, start + pageSize),
      page,
      pageSize,
      total: filtered.length,
      totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
    };
  }

  async action(input: SessionCatalogActionInput): Promise<SessionCatalogItem> {
    if (input.action === 'create') return this.create(input);
    if (!input.locator) throw new Error(`${input.action} requires a Session locator.`);
    const locator = { ...input.locator };
    const resolved = this.resolveLocator(locator);
    const item = await this.find(locator);
    if (!item) throw new Error(`Unknown Session: ${locator.sessionId}`);
    if (input.action === 'open') return item;
    if (item.type === 'agent') {
      throw new Error('Agent child Sessions are read-only here. Use Agent Monitor to manage their lifecycle.');
    }
    if (
      (input.action === 'archive' || input.action === 'delete')
      && item.runtimeStatus !== 'idle'
    ) {
      throw new Error(`Cannot ${input.action} a ${item.runtimeStatus} Session.`);
    }

    const store = new SessionStore(resolved.root, locator.archived ? 'archive' : 'sessions');
    if (input.action === 'rename') {
      const title = input.title?.trim();
      if (!title) throw new Error('rename requires a non-empty title.');
      await store.mutate(locator.sessionId, session => ({
        ...mutationTimestamp(session),
        title,
        titleSource: 'manual',
      }));
    } else if (input.action === 'pin') {
      const pinned = input.pinned ?? !item.pinned;
      await store.mutate(locator.sessionId, session => {
        const metadata = { ...session.metadata };
        if (pinned) metadata.__actoviqPinned = true;
        else delete metadata.__actoviqPinned;
        return { ...mutationTimestamp(session), metadata };
      });
    } else if (input.action === 'archive') {
      if (locator.archived) throw new Error('Session is already archived.');
      await this.moveSession(resolved.root, locator.sessionId, false);
      locator.archived = true;
    } else if (input.action === 'restore') {
      if (!locator.archived) throw new Error('Session is not archived.');
      await this.moveSession(resolved.root, locator.sessionId, true);
      locator.archived = false;
    } else if (input.action === 'delete') {
      if (!locator.archived) throw new Error('Only archived Sessions can be permanently deleted.');
      await store.delete(locator.sessionId);
      await rm(
        path.join(resolved.root, 'archive', '.checkpoints', locator.sessionId),
        { recursive: true, force: true },
      );
      return item;
    }
    return (await this.find(locator)) ?? item;
  }

  async reference(locator: SessionCatalogLocator): Promise<SessionCatalogReference> {
    const resolved = this.resolveLocator(locator);
    const item = await this.find(locator);
    if (!item) throw new Error(`Unknown Session: ${locator.sessionId}`);
    const store = new SessionStore(resolved.root, locator.archived ? 'archive' : 'sessions');
    const session = await store.load(locator.sessionId);
    const messages = session.messages
      .map(message => ({
        role: message.role,
        text: extractTextFromContent(message.content).trim(),
      }))
      .filter((message): message is SessionCatalogReferenceMessage =>
        (message.role === 'user' || message.role === 'assistant')
        && Boolean(message.text)
        && !message.text.startsWith('<system-reminder>'),
      )
      .slice(-12)
      .map(message => ({
        ...message,
        text: message.text.slice(0, 2_000),
      }));
    let remaining = 12_000;
    return {
      item,
      messages: messages.flatMap(message => {
        if (remaining <= 0) return [];
        const text = message.text.slice(0, remaining);
        remaining -= text.length;
        return [{ ...message, text }];
      }),
    };
  }

  private async create(input: SessionCatalogActionInput): Promise<SessionCatalogItem> {
    const type = input.type ?? 'user';
    if (type === 'assistant-global') {
      const store = new SessionStore(this.globalAssistantRoot);
      const session = await store.create({
        id: createId(),
        title: input.title?.trim() || 'Assistant (Global)',
        model: input.model ?? 'unknown',
        kind: 'manager',
        metadata: {
          __actoviqKind: 'manager',
          __actoviqAssistantScope: 'global',
        },
      });
      return itemFromSummary(
        (await store.list()).find(item => item.id === session.id)!,
        { scope: 'global-assistant', sessionId: session.id, archived: false },
        'Global Assistant',
        this.options.activity,
      );
    }
    const projectPath = this.assertRegisteredProject(input.projectPath);
    const root = getActoviqProjectSessionDirectory(projectPath, this.options.homeDir);
    const store = new SessionStore(root);
    const manager = type === 'assistant-project';
    const session = await store.create({
      id: createId(),
      title: input.title?.trim() || (manager ? 'Manager' : 'Untitled Session'),
      model: input.model ?? 'unknown',
      kind: manager ? 'manager' : 'main',
      metadata: {
        __actoviqWorkDir: projectPath,
        ...(manager
          ? { __actoviqKind: 'manager', __actoviqAssistantScope: 'project' }
          : { __actoviqKind: 'main' }),
      },
    });
    return itemFromSummary(
      (await store.list()).find(item => item.id === session.id)!,
      { scope: 'project', projectPath, sessionId: session.id, archived: false },
      path.basename(projectPath),
      this.options.activity,
    );
  }

  private async loadKnownSessions(): Promise<SessionCatalogItem[]> {
    const items: SessionCatalogItem[] = [];
    for (const projectPath of this.projectPaths) {
      const root = getActoviqProjectSessionDirectory(projectPath, this.options.homeDir);
      const [active, archived] = await Promise.all([
        new SessionStore(root).list().catch(() => []),
        new SessionStore(root, 'archive').list().catch(() => []),
      ]);
      for (const [list, isArchived] of [[active, false], [archived, true]] as const) {
        for (const summary of list) {
          items.push(itemFromSummary(
            summary,
            {
              scope: 'project',
              projectPath,
              sessionId: summary.id,
              archived: isArchived,
            },
            path.basename(projectPath),
            this.options.activity,
          ));
        }
      }
    }
    const [globalActive, globalArchived] = await Promise.all([
      new SessionStore(this.globalAssistantRoot).list().catch(() => []),
      new SessionStore(this.globalAssistantRoot, 'archive').list().catch(() => []),
    ]);
    for (const [list, isArchived] of [[globalActive, false], [globalArchived, true]] as const) {
      for (const summary of list) {
        items.push(itemFromSummary(
          summary,
          {
            scope: 'global-assistant',
            sessionId: summary.id,
            archived: isArchived,
          },
          'Global Assistant',
          this.options.activity,
        ));
      }
    }
    return items;
  }

  private async find(locator: SessionCatalogLocator): Promise<SessionCatalogItem | null> {
    return (await this.loadKnownSessions())
      .find(item => item.locatorKey === sessionCatalogLocatorKey(locator)) ?? null;
  }

  private resolveLocator(locator: SessionCatalogLocator): { root: string } {
    if (locator.scope === 'global-assistant') {
      if (locator.projectPath) throw new Error('Global Assistant locator cannot include projectPath.');
      return { root: this.globalAssistantRoot };
    }
    return {
      root: getActoviqProjectSessionDirectory(
        this.assertRegisteredProject(locator.projectPath),
        this.options.homeDir,
      ),
    };
  }

  private assertRegisteredProject(projectPath?: string): string {
    if (!projectPath?.trim()) throw new Error('A registered projectPath is required.');
    const resolved = path.resolve(projectPath);
    if (!this.registeredProjectKeys.has(normalizePath(resolved))) {
      throw new Error(`Unknown project path: ${resolved}`);
    }
    return resolved;
  }

  private async moveSession(root: string, sessionId: string, restore: boolean): Promise<void> {
    const sourceName = restore ? 'archive' : 'sessions';
    const targetName = restore ? 'sessions' : 'archive';
    const sourceStore = new SessionStore(root, sourceName);
    const targetStore = new SessionStore(root, targetName);
    const fileName = safeStorageFileName('sessionId', sessionId, 'json');
    await sourceStore.runExclusiveTurn(sessionId, async () => {
      await sourceStore.load(sessionId);
      try {
        await targetStore.load(sessionId);
        throw new Error(`Session ${sessionId} already exists in ${targetName}.`);
      } catch (error) {
        if (!(error instanceof SessionNotFoundError)) throw error;
      }
      await mkdir(path.join(root, targetName), { recursive: true });
      await rename(
        path.join(root, sourceName, fileName),
        path.join(root, targetName, fileName),
      );
      const sourceCheckpoints = path.join(root, sourceName, '.checkpoints', sessionId);
      const targetCheckpoints = path.join(root, targetName, '.checkpoints', sessionId);
      try {
        await mkdir(path.dirname(targetCheckpoints), { recursive: true });
        await rename(sourceCheckpoints, targetCheckpoints);
      } catch {
        // No checkpoints.
      }
    });
  }
}
