import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getActoviqProjectSessionDirectory } from '../config/projectSessionDirectory.js';
import { nowIso } from '../runtime/helpers.js';

export const ISSUE_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'cancelled',
] as const;

export const ISSUE_PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export const ISSUE_STORAGE_MODES = ['home', 'workspace'] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];
export type IssueStorageMode = (typeof ISSUE_STORAGE_MODES)[number];
export type IssueActor = 'user' | 'manager' | 'agent' | 'system';
export type IssueCommentKind = 'comment' | 'status_change' | 'progress' | 'system';

export interface IssueComment {
  id: string;
  kind: IssueCommentKind;
  actor: IssueActor;
  body: string;
  createdAt: string;
  fromStatus?: IssueStatus;
  toStatus?: IssueStatus;
}

export interface ProjectIssue {
  version: 1;
  id: string;
  number: number;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  labels: string[];
  acceptanceCriteria: string[];
  parentIssueId?: string;
  createdBy: 'user' | 'manager';
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  agentConfig?: string;
  brief?: string;
  sessionIds: string[];
  activeSessionId?: string;
  comments: IssueComment[];
  metadata: Record<string, string | number | boolean>;
}

export interface ProjectIssueInput {
  title: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  labels?: string[];
  acceptanceCriteria?: string[];
  parentIssueId?: string;
  createdBy?: 'user' | 'manager';
  agentConfig?: string;
  brief?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface ProjectIssuePatch {
  title?: string;
  description?: string;
  priority?: IssuePriority;
  labels?: string[];
  acceptanceCriteria?: string[];
  parentIssueId?: string | null;
  agentConfig?: string | null;
  brief?: string | null;
  sessionIds?: string[];
  activeSessionId?: string | null;
  metadata?: Record<string, string | number | boolean>;
}

export interface IssueStoreFile {
  version: 1;
  nextNumber: number;
  issues: ProjectIssue[];
}

const DEFAULT_STORE: IssueStoreFile = { version: 1, nextNumber: 1, issues: [] };

const TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  backlog: ['todo', 'cancelled'],
  todo: ['in_progress', 'cancelled'],
  in_progress: ['in_review', 'blocked', 'todo'],
  in_review: ['done', 'todo'],
  blocked: ['todo'],
  done: [],
  cancelled: [],
};

export function isIssueStatus(value: unknown): value is IssueStatus {
  return typeof value === 'string' && (ISSUE_STATUSES as readonly string[]).includes(value);
}

export function isIssuePriority(value: unknown): value is IssuePriority {
  return typeof value === 'string' && (ISSUE_PRIORITIES as readonly string[]).includes(value);
}

export function isIssueStorageMode(value: unknown): value is IssueStorageMode {
  return typeof value === 'string' && (ISSUE_STORAGE_MODES as readonly string[]).includes(value);
}

export function resolveIssueStorePath(
  workDir: string,
  homeDir: string,
  mode: IssueStorageMode = 'home',
): string {
  return mode === 'workspace'
    ? path.join(path.resolve(workDir), '.actoviq', 'issues.json')
    : path.join(getActoviqProjectSessionDirectory(workDir, homeDir), 'issues.json');
}

export async function readIssueStore(
  workDir: string,
  homeDir: string,
  mode: IssueStorageMode = 'home',
): Promise<IssueStoreFile> {
  try {
    const parsed = JSON.parse(await readFile(resolveIssueStorePath(workDir, homeDir, mode), 'utf8')) as unknown;
    return normalizeIssueStore(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_STORE, issues: [] };
    throw error;
  }
}

export async function writeIssueStore(
  workDir: string,
  homeDir: string,
  store: IssueStoreFile,
  mode: IssueStorageMode = 'home',
): Promise<void> {
  const filePath = resolveIssueStorePath(workDir, homeDir, mode);
  await mkdir(path.dirname(filePath), { recursive: true });
  const normalized = normalizeIssueStore(store);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

export async function listProjectIssues(
  workDir: string,
  homeDir: string,
  mode: IssueStorageMode = 'home',
): Promise<ProjectIssue[]> {
  return (await readIssueStore(workDir, homeDir, mode)).issues;
}

export async function createProjectIssue(
  workDir: string,
  homeDir: string,
  input: ProjectIssueInput,
  mode: IssueStorageMode = 'home',
): Promise<ProjectIssue> {
  const title = normalizeText(input.title);
  if (!title) throw new Error('Issue title is required');
  const store = await readIssueStore(workDir, homeDir, mode);
  const now = nowIso();
  const issue: ProjectIssue = {
    version: 1,
    id: createIssueId(store.nextNumber),
    number: store.nextNumber,
    title,
    description: normalizeText(input.description),
    status: input.status === 'backlog' ? 'backlog' : 'todo',
    priority: isIssuePriority(input.priority) ? input.priority : 'none',
    labels: normalizeStringList(input.labels),
    acceptanceCriteria: normalizeStringList(input.acceptanceCriteria),
    ...(normalizeText(input.parentIssueId) ? { parentIssueId: normalizeText(input.parentIssueId) } : {}),
    createdBy: input.createdBy === 'manager' ? 'manager' : 'user',
    createdAt: now,
    updatedAt: now,
    ...(normalizeText(input.agentConfig) ? { agentConfig: normalizeText(input.agentConfig) } : {}),
    ...(normalizeText(input.brief) ? { brief: normalizeText(input.brief) } : {}),
    sessionIds: [],
    comments: [],
    metadata: normalizeMetadata(input.metadata),
  };
  store.issues.push(issue);
  store.nextNumber = Math.max(store.nextNumber + 1, issue.number + 1);
  await writeIssueStore(workDir, homeDir, store, mode);
  return issue;
}

export async function updateProjectIssue(
  workDir: string,
  homeDir: string,
  idOrNumber: string | number,
  patch: ProjectIssuePatch,
  mode: IssueStorageMode = 'home',
): Promise<ProjectIssue | undefined> {
  const store = await readIssueStore(workDir, homeDir, mode);
  const index = findIssueIndex(store.issues, idOrNumber);
  if (index < 0) return undefined;
  const current = store.issues[index]!;
  const updated = applyIssuePatch(current, patch);
  store.issues[index] = updated;
  await writeIssueStore(workDir, homeDir, store, mode);
  return updated;
}

export async function transitionProjectIssue(
  workDir: string,
  homeDir: string,
  idOrNumber: string | number,
  nextStatus: IssueStatus,
  actor: IssueActor,
  mode: IssueStorageMode = 'home',
): Promise<ProjectIssue | undefined> {
  const store = await readIssueStore(workDir, homeDir, mode);
  const index = findIssueIndex(store.issues, idOrNumber);
  if (index < 0) return undefined;
  const updated = applyIssueTransition(store.issues[index]!, nextStatus, actor);
  store.issues[index] = updated;
  await writeIssueStore(workDir, homeDir, store, mode);
  return updated;
}

export async function deleteProjectIssue(
  workDir: string,
  homeDir: string,
  idOrNumber: string | number,
  mode: IssueStorageMode = 'home',
): Promise<boolean> {
  const store = await readIssueStore(workDir, homeDir, mode);
  const next = store.issues.filter(issue => !matchesIssue(issue, idOrNumber));
  if (next.length === store.issues.length) return false;
  await writeIssueStore(workDir, homeDir, { ...store, issues: next }, mode);
  return true;
}

export async function addIssueComment(
  workDir: string,
  homeDir: string,
  idOrNumber: string | number,
  input: { body: string; kind?: IssueCommentKind; actor?: IssueActor },
  mode: IssueStorageMode = 'home',
): Promise<ProjectIssue | undefined> {
  const store = await readIssueStore(workDir, homeDir, mode);
  const index = findIssueIndex(store.issues, idOrNumber);
  if (index < 0) return undefined;
  const body = normalizeText(input.body);
  if (!body) throw new Error('Comment body is required');
  const issue = store.issues[index]!;
  const now = nowIso();
  const updated: ProjectIssue = {
    ...issue,
    updatedAt: now,
    comments: [
      ...issue.comments,
      {
        id: createCommentId(),
        kind: input.kind ?? 'comment',
        actor: input.actor ?? 'user',
        body,
        createdAt: now,
      },
    ],
  };
  store.issues[index] = updated;
  await writeIssueStore(workDir, homeDir, store, mode);
  return updated;
}

export function applyIssueTransition(
  issue: ProjectIssue,
  nextStatus: IssueStatus,
  actor: IssueActor,
  now = nowIso(),
): ProjectIssue {
  if (!isIssueStatus(nextStatus)) throw new Error(`Invalid issue status: ${String(nextStatus)}`);
  if (issue.status === nextStatus) return { ...issue };
  if (!TRANSITIONS[issue.status].includes(nextStatus)) {
    throw new Error(`Invalid issue transition: ${issue.status} -> ${nextStatus}`);
  }
  return {
    ...issue,
    status: nextStatus,
    updatedAt: now,
    ...(nextStatus === 'in_progress' && !issue.startedAt ? { startedAt: now } : {}),
    ...(nextStatus === 'done' ? { completedAt: now } : {}),
    comments: [
      ...issue.comments,
      {
        id: createCommentId(),
        kind: 'status_change',
        actor,
        body: `Status changed from ${issue.status} to ${nextStatus}.`,
        createdAt: now,
        fromStatus: issue.status,
        toStatus: nextStatus,
      },
    ],
  };
}

export async function migrateIssueStore(options: {
  workDir: string;
  homeDir: string;
  from: IssueStorageMode;
  to: IssueStorageMode;
}): Promise<IssueStoreFile> {
  if (options.from === options.to) return readIssueStore(options.workDir, options.homeDir, options.to);
  const source = await readIssueStore(options.workDir, options.homeDir, options.from);
  const target = await readIssueStore(options.workDir, options.homeDir, options.to);
  const merged = mergeIssueStores(target, source);
  await writeIssueStore(options.workDir, options.homeDir, merged, options.to);
  await rm(resolveIssueStorePath(options.workDir, options.homeDir, options.from), { force: true });
  return merged;
}

function normalizeIssueStore(value: unknown): IssueStoreFile {
  if (!isRecord(value) || !Array.isArray(value.issues)) return { ...DEFAULT_STORE, issues: [] };
  const issues = value.issues
    .map(coerceIssue)
    .filter((issue): issue is ProjectIssue => Boolean(issue))
    .sort((a, b) => a.number - b.number);
  const maxNumber = issues.reduce((max, issue) => Math.max(max, issue.number), 0);
  const nextNumber = typeof value.nextNumber === 'number' && Number.isFinite(value.nextNumber)
    ? Math.max(Math.floor(value.nextNumber), maxNumber + 1, 1)
    : maxNumber + 1;
  return { version: 1, nextNumber, issues };
}

function coerceIssue(value: unknown): ProjectIssue | undefined {
  if (!isRecord(value)) return undefined;
  const title = normalizeText(value.title);
  const number = typeof value.number === 'number' && Number.isFinite(value.number)
    ? Math.max(1, Math.floor(value.number))
    : 0;
  if (!title || number <= 0) return undefined;
  const now = nowIso();
  const id = normalizeText(value.id) || createIssueId(number);
  const status = isIssueStatus(value.status) ? value.status : 'todo';
  return {
    version: 1,
    id,
    number,
    title,
    description: normalizeText(value.description),
    status,
    priority: isIssuePriority(value.priority) ? value.priority : 'none',
    labels: normalizeStringList(value.labels),
    acceptanceCriteria: normalizeStringList(value.acceptanceCriteria),
    ...(normalizeText(value.parentIssueId) ? { parentIssueId: normalizeText(value.parentIssueId) } : {}),
    createdBy: value.createdBy === 'manager' ? 'manager' : 'user',
    createdAt: normalizeText(value.createdAt) || now,
    updatedAt: normalizeText(value.updatedAt) || now,
    ...(normalizeText(value.startedAt) ? { startedAt: normalizeText(value.startedAt) } : {}),
    ...(normalizeText(value.completedAt) ? { completedAt: normalizeText(value.completedAt) } : {}),
    ...(normalizeText(value.agentConfig) ? { agentConfig: normalizeText(value.agentConfig) } : {}),
    ...(normalizeText(value.brief) ? { brief: normalizeText(value.brief) } : {}),
    sessionIds: normalizeStringList(value.sessionIds),
    ...(normalizeText(value.activeSessionId) ? { activeSessionId: normalizeText(value.activeSessionId) } : {}),
    comments: Array.isArray(value.comments)
      ? value.comments.map(coerceComment).filter((comment): comment is IssueComment => Boolean(comment))
      : [],
    metadata: normalizeMetadata(isRecord(value.metadata) ? value.metadata : undefined),
  };
}

function coerceComment(value: unknown): IssueComment | undefined {
  if (!isRecord(value)) return undefined;
  const body = normalizeText(value.body);
  if (!body) return undefined;
  return {
    id: normalizeText(value.id) || createCommentId(),
    kind: isCommentKind(value.kind) ? value.kind : 'comment',
    actor: isIssueActor(value.actor) ? value.actor : 'user',
    body,
    createdAt: normalizeText(value.createdAt) || nowIso(),
    ...(isIssueStatus(value.fromStatus) ? { fromStatus: value.fromStatus } : {}),
    ...(isIssueStatus(value.toStatus) ? { toStatus: value.toStatus } : {}),
  };
}

function applyIssuePatch(issue: ProjectIssue, patch: ProjectIssuePatch): ProjectIssue {
  const next: ProjectIssue = { ...issue, updatedAt: nowIso() };
  if (patch.title !== undefined) {
    const title = normalizeText(patch.title);
    if (!title) throw new Error('Issue title is required');
    next.title = title;
  }
  if (patch.description !== undefined) next.description = normalizeText(patch.description);
  if (patch.priority !== undefined) {
    if (!isIssuePriority(patch.priority)) throw new Error(`Invalid issue priority: ${String(patch.priority)}`);
    next.priority = patch.priority;
  }
  if (patch.labels !== undefined) next.labels = normalizeStringList(patch.labels);
  if (patch.acceptanceCriteria !== undefined) next.acceptanceCriteria = normalizeStringList(patch.acceptanceCriteria);
  if (patch.parentIssueId !== undefined) {
    if (patch.parentIssueId === null || !normalizeText(patch.parentIssueId)) delete next.parentIssueId;
    else next.parentIssueId = normalizeText(patch.parentIssueId);
  }
  if (patch.agentConfig !== undefined) {
    if (patch.agentConfig === null || !normalizeText(patch.agentConfig)) delete next.agentConfig;
    else next.agentConfig = normalizeText(patch.agentConfig);
  }
  if (patch.brief !== undefined) {
    if (patch.brief === null || !normalizeText(patch.brief)) delete next.brief;
    else next.brief = normalizeText(patch.brief);
  }
  if (patch.sessionIds !== undefined) next.sessionIds = normalizeStringList(patch.sessionIds);
  if (patch.activeSessionId !== undefined) {
    if (patch.activeSessionId === null || !normalizeText(patch.activeSessionId)) delete next.activeSessionId;
    else next.activeSessionId = normalizeText(patch.activeSessionId);
  }
  if (patch.metadata !== undefined) next.metadata = normalizeMetadata(patch.metadata);
  return next;
}

function mergeIssueStores(base: IssueStoreFile, incoming: IssueStoreFile): IssueStoreFile {
  const byNumber = new Map<number, ProjectIssue>();
  for (const issue of base.issues) byNumber.set(issue.number, issue);
  for (const issue of incoming.issues) {
    const existing = byNumber.get(issue.number);
    byNumber.set(issue.number, existing ? mergeDuplicateIssue(existing, issue) : issue);
  }
  const issues = [...byNumber.values()].sort((a, b) => a.number - b.number);
  const maxNumber = issues.reduce((max, issue) => Math.max(max, issue.number), 0);
  return {
    version: 1,
    nextNumber: Math.max(base.nextNumber, incoming.nextNumber, maxNumber + 1),
    issues,
  };
}

function mergeDuplicateIssue(existing: ProjectIssue, incoming: ProjectIssue): ProjectIssue {
  const comments = new Map<string, IssueComment>();
  for (const comment of [...existing.comments, ...incoming.comments]) {
    comments.set(comment.id, comment);
  }
  return {
    ...existing,
    comments: [...comments.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    updatedAt: existing.updatedAt > incoming.updatedAt ? existing.updatedAt : incoming.updatedAt,
  };
}

function findIssueIndex(issues: ProjectIssue[], idOrNumber: string | number): number {
  return issues.findIndex(issue => matchesIssue(issue, idOrNumber));
}

function matchesIssue(issue: ProjectIssue, idOrNumber: string | number): boolean {
  return typeof idOrNumber === 'number'
    ? issue.number === idOrNumber
    : issue.id === idOrNumber || String(issue.number) === idOrNumber || `ISS-${issue.number}` === idOrNumber.toUpperCase();
}

function createIssueId(number: number): string {
  return `issue-${number}-${randomUUID().slice(0, 8)}`;
}

function createCommentId(): string {
  return `comment-${randomUUID().slice(0, 8)}`;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeText).filter(Boolean))];
}

function normalizeMetadata(value: unknown): Record<string, string | number | boolean> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string | number | boolean] =>
      typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean',
    ),
  );
}

function isCommentKind(value: unknown): value is IssueCommentKind {
  return value === 'comment' || value === 'status_change' || value === 'progress' || value === 'system';
}

function isIssueActor(value: unknown): value is IssueActor {
  return value === 'user' || value === 'manager' || value === 'agent' || value === 'system';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
