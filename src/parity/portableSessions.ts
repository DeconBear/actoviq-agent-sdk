import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ListSessionsOptions {
  dir?: string;
  limit?: number;
  includeWorktrees?: boolean;
}

export interface SessionLite {
  filePath: string;
  cwd?: string;
  gitBranch?: string;
  summary: string;
  timestamp?: string;
}

export interface SessionInfo {
  sessionId: string;
  summary: string;
  cwd?: string;
  gitBranch?: string;
  lastActivityAt?: string;
  filePath: string;
  projectPath?: string;
}

export const SKIP_PRECOMPACT_THRESHOLD = 5 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getPortableConfigDir(): string {
  return process.env.ACTOVIQ_CONFIG_DIR ?? path.join(os.homedir(), '.actoviq');
}

function getProjectsRootDir(): string {
  return path.join(getPortableConfigDir(), 'projects');
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

export function getProjectDir(projectPath: string): string {
  const resolvedProjectPath = path.resolve(projectPath);
  const digest = createHash('sha1')
    .update(process.platform === 'win32' ? resolvedProjectPath.toLowerCase() : resolvedProjectPath)
    .digest('hex')
    .slice(0, 16);
  const label = sanitizeSegment(path.basename(resolvedProjectPath));
  return path.join(getProjectsRootDir(), `${label}-${digest}`);
}

export async function resolveSessionFilePath(
  sessionId: string,
  dir?: string,
): Promise<{ filePath: string; fileSize: number; projectPath?: string } | undefined> {
  if (dir) {
    const filePath = path.join(getProjectDir(dir), `${sessionId}.jsonl`);
    try {
      const info = await stat(filePath);
      return {
        filePath,
        fileSize: info.size,
        projectPath: dir,
      };
    } catch {
      return undefined;
    }
  }

  const projectsRoot = getProjectsRootDir();
  try {
    const projectEntries = (await readdir(projectsRoot, {
      withFileTypes: true,
    })) as Dirent<string>[];
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) {
        continue;
      }
      const filePath = path.join(projectsRoot, projectEntry.name, `${sessionId}.jsonl`);
      try {
        const info = await stat(filePath);
        return {
          filePath,
          fileSize: info.size,
        };
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export async function readTranscriptForLoad(filePath: string, _fileSize: number) {
  const buffer = await readFile(filePath);
  return {
    postBoundaryBuf: buffer,
  };
}

export async function readSessionLite(filePath: string): Promise<SessionLite | undefined> {
  let transcriptText: string;
  try {
    transcriptText = await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }

  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let latestTimestamp: string | undefined;
  let latestUserText = '';
  let latestAssistantText = '';
  let lastPrompt: string | undefined;

  for (const line of transcriptText.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (typeof entry.cwd === 'string') {
        cwd = entry.cwd;
      }
      if (typeof entry.gitBranch === 'string') {
        gitBranch = entry.gitBranch;
      }
      if (typeof entry.timestamp === 'string') {
        latestTimestamp = entry.timestamp;
      }
      if (entry.type === 'last-prompt' && typeof entry.lastPrompt === 'string') {
        lastPrompt = entry.lastPrompt;
      }
      if (entry.type === 'user') {
        const text = extractSummaryText(entry.message);
        if (text) {
          latestUserText = text;
        }
      }
      if (entry.type === 'assistant') {
        const text = extractSummaryText(entry.message);
        if (text) {
          latestAssistantText = text;
        }
      }
    } catch {
      continue;
    }
  }

  const summary =
    lastPrompt ??
    latestUserText ??
    latestAssistantText ??
    path.basename(filePath, '.jsonl');

  return {
    filePath,
    cwd,
    gitBranch,
    summary,
    timestamp: latestTimestamp,
  };
}

export function parseSessionInfoFromLite(
  sessionId: string,
  lite: SessionLite,
  projectPath?: string,
): SessionInfo | undefined {
  return {
    sessionId,
    summary: lite.summary,
    cwd: lite.cwd ?? projectPath,
    gitBranch: lite.gitBranch,
    lastActivityAt: lite.timestamp,
    filePath: lite.filePath,
    projectPath,
  };
}

export async function listSessionsImpl(
  options: ListSessionsOptions = {},
): Promise<SessionInfo[]> {
  const sessionFiles = await collectSessionFiles(options.dir);
  const sessions: SessionInfo[] = [];

  for (const sessionFile of sessionFiles) {
    const lite = await readSessionLite(sessionFile.filePath);
    if (!lite) {
      continue;
    }
    const info = parseSessionInfoFromLite(sessionFile.sessionId, lite, options.dir);
    if (info) {
      sessions.push(info);
    }
  }

  sessions.sort((left, right) => {
    const leftTime = left.lastActivityAt ? Date.parse(left.lastActivityAt) : 0;
    const rightTime = right.lastActivityAt ? Date.parse(right.lastActivityAt) : 0;
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return right.sessionId.localeCompare(left.sessionId);
  });

  return typeof options.limit === 'number' ? sessions.slice(0, options.limit) : sessions;
}

async function collectSessionFiles(dir?: string): Promise<Array<{ filePath: string; sessionId: string }>> {
  if (dir) {
    return collectSessionFilesFromProjectDir(getProjectDir(dir));
  }

  const projectsRoot = getProjectsRootDir();
  try {
    const projectEntries = (await readdir(projectsRoot, {
      withFileTypes: true,
    })) as Dirent<string>[];
    const collected: Array<{ filePath: string; sessionId: string }> = [];
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) {
        continue;
      }
      collected.push(
        ...(await collectSessionFilesFromProjectDir(path.join(projectsRoot, projectEntry.name))),
      );
    }
    return collected;
  } catch {
    return [];
  }
}

async function collectSessionFilesFromProjectDir(
  projectDir: string,
): Promise<Array<{ filePath: string; sessionId: string }>> {
  try {
    const entries = (await readdir(projectDir, { withFileTypes: true })) as Dirent<string>[];
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map(entry => ({
        filePath: path.join(projectDir, entry.name),
        sessionId: entry.name.slice(0, -'.jsonl'.length),
      }));
  } catch {
    return [];
  }
}

function extractSummaryText(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }
  if (!isRecord(message)) {
    return '';
  }

  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map(block => {
      if (!isRecord(block)) {
        return '';
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
