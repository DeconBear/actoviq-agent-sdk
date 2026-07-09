import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getActoviqProjectSessionDirectory } from '../config/projectSessionDirectory.js';
import { isIssueStorageMode, type IssueStorageMode } from '../issues/issueStore.js';

/** Manual project lifecycle status (not "is this the current workspace"). */
export const PROJECT_STATUSES = [
  'in_progress',
  'planning',
  'on_hold',
  'not_started',
  'completed',
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  in_progress: 'In progress',
  planning: 'Planning',
  on_hold: 'On hold',
  not_started: 'Not started',
  completed: 'Completed',
};

export type ProjectMeta = {
  status: ProjectStatus;
  issueStorage?: IssueStorageMode;
  updatedAt?: string;
};

const DEFAULT_META: ProjectMeta = { status: 'not_started' };

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === 'string' && (PROJECT_STATUSES as readonly string[]).includes(value);
}

export function projectMetaPath(workDir: string, homeDir: string): string {
  return path.join(getActoviqProjectSessionDirectory(workDir, homeDir), 'meta.json');
}

export async function readProjectMeta(workDir: string, homeDir: string): Promise<ProjectMeta> {
  try {
    const raw = JSON.parse(await readFile(projectMetaPath(workDir, homeDir), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_META };
    const status = isProjectStatus((raw as ProjectMeta).status)
      ? (raw as ProjectMeta).status
      : DEFAULT_META.status;
    const updatedAt = typeof (raw as ProjectMeta).updatedAt === 'string'
      ? (raw as ProjectMeta).updatedAt
      : undefined;
    const issueStorage = isIssueStorageMode((raw as ProjectMeta).issueStorage)
      ? (raw as ProjectMeta).issueStorage
      : undefined;
    return { status, ...(issueStorage ? { issueStorage } : {}), updatedAt };
  } catch {
    return { ...DEFAULT_META };
  }
}

export async function writeProjectMeta(
  workDir: string,
  homeDir: string,
  patch: Partial<ProjectMeta>,
): Promise<ProjectMeta> {
  const current = await readProjectMeta(workDir, homeDir);
  const next: ProjectMeta = {
    status: isProjectStatus(patch.status) ? patch.status : current.status,
    ...(isIssueStorageMode(patch.issueStorage ?? current.issueStorage)
      ? { issueStorage: (patch.issueStorage ?? current.issueStorage) as IssueStorageMode }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  const filePath = projectMetaPath(workDir, homeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
