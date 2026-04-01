import { readFile } from 'node:fs/promises';

import {
  listSessionsImpl,
  parseSessionInfoFromLite,
  type ListSessionsOptions,
  type SessionInfo,
} from './portableSessions.js';
import {
  readSessionLite,
  readTranscriptForLoad,
  resolveSessionFilePath,
  SKIP_PRECOMPACT_THRESHOLD,
} from './portableSessions.js';

export type ActoviqListSessionsOptions = ListSessionsOptions;
export type ActoviqBridgeSessionInfo = SessionInfo;
const LEGACY_CONFIG_ENV_KEY = ['CL', 'AUDE_CONFIG_DIR'].join('');

export type ActoviqTranscriptMessageType =
  | 'user'
  | 'assistant'
  | 'attachment'
  | 'system';

export interface ActoviqTranscriptMessage {
  uuid: string;
  parentUuid: string | null;
  logicalParentUuid?: string | null;
  type: ActoviqTranscriptMessageType;
  timestamp: string;
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  isSidechain: boolean;
  message?: unknown;
  raw: Record<string, unknown>;
}

export interface ActoviqBridgeSessionLookupOptions {
  dir?: string;
}

export interface ActoviqBridgeSessionMessagesOptions extends ActoviqBridgeSessionLookupOptions {
  includeSystemMessages?: boolean;
  includeSidechains?: boolean;
}

const TRANSCRIPT_MESSAGE_TYPES = new Set<ActoviqTranscriptMessageType>([
  'user',
  'assistant',
  'attachment',
  'system',
]);

/**
 * Lists Actoviq Runtime native sessions from the `.actoviq/projects` store using
 * the upstream portable session discovery logic.
 */
export async function listActoviqBridgeSessions(
  options?: ActoviqListSessionsOptions,
): Promise<ActoviqBridgeSessionInfo[]> {
  return withPortableConfigEnv(() => listSessionsImpl(options));
}

/**
 * Resolves Actoviq Runtime session metadata for a single session id using the
 * upstream portable lite-reader path.
 */
export async function getActoviqBridgeSessionInfo(
  sessionId: string,
  options?: ActoviqBridgeSessionLookupOptions,
): Promise<ActoviqBridgeSessionInfo | undefined> {
  const resolved = await withPortableConfigEnv(() =>
    resolveSessionFilePath(sessionId, options?.dir),
  );
  if (!resolved) {
    return undefined;
  }

  const lite = await withPortableConfigEnv(() => readSessionLite(resolved.filePath));
  if (!lite) {
    return undefined;
  }

  return parseSessionInfoFromLite(sessionId, lite, resolved.projectPath) ?? undefined;
}

/**
 * Reads a Actoviq Runtime native transcript and reconstructs the latest main-thread
 * conversation chain by walking `parentUuid` from the most recent leaf.
 */
export async function getActoviqBridgeSessionMessages(
  sessionId: string,
  options: ActoviqBridgeSessionMessagesOptions = {},
): Promise<ActoviqTranscriptMessage[]> {
  const resolved = await withPortableConfigEnv(() =>
    resolveSessionFilePath(sessionId, options.dir),
  );
  if (!resolved) {
    return [];
  }

  const transcriptText = await loadPortableTranscriptText(
    resolved.filePath,
    resolved.fileSize,
  );

  const transcriptEntries = parseTranscriptMessages(transcriptText).filter(entry => {
    if (!options.includeSidechains && entry.isSidechain) {
      return false;
    }
    return true;
  });

  const latestLeaf = findLatestLeaf(transcriptEntries);
  if (!latestLeaf) {
    return [];
  }

  const chain = buildConversationChain(transcriptEntries, latestLeaf.uuid);
  if (options.includeSystemMessages) {
    return chain;
  }

  return chain.filter(entry => entry.type !== 'system');
}

async function loadPortableTranscriptText(
  filePath: string,
  fileSize: number,
): Promise<string> {
  if (fileSize > SKIP_PRECOMPACT_THRESHOLD) {
    const loaded = await readTranscriptForLoad(filePath, fileSize);
    return loaded.postBoundaryBuf.toString('utf8');
  }

  return readFile(filePath, 'utf8');
}

function parseTranscriptMessages(transcriptText: string): ActoviqTranscriptMessage[] {
  const parsed: ActoviqTranscriptMessage[] = [];

  for (const line of transcriptText.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const type = entry.type;
      const uuid = entry.uuid;
      if (
        typeof type !== 'string' ||
        !TRANSCRIPT_MESSAGE_TYPES.has(type as ActoviqTranscriptMessageType) ||
        typeof uuid !== 'string'
      ) {
        continue;
      }

      const parentUuid =
        typeof entry.parentUuid === 'string' || entry.parentUuid === null
          ? (entry.parentUuid as string | null)
          : null;

      parsed.push({
        uuid,
        parentUuid,
        logicalParentUuid:
          typeof entry.logicalParentUuid === 'string' || entry.logicalParentUuid === null
            ? (entry.logicalParentUuid as string | null)
            : undefined,
        type: type as ActoviqTranscriptMessageType,
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
        sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
        cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
        gitBranch: typeof entry.gitBranch === 'string' ? entry.gitBranch : undefined,
        isSidechain: entry.isSidechain === true,
        message: entry.message,
        raw: entry,
      });
    } catch {
      continue;
    }
  }

  return parsed;
}

function findLatestLeaf(
  transcriptEntries: ActoviqTranscriptMessage[],
): ActoviqTranscriptMessage | undefined {
  const parentReferences = new Set(
    transcriptEntries
      .map(entry => entry.parentUuid)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );

  const leaves = transcriptEntries.filter(entry => !parentReferences.has(entry.uuid));
  if (leaves.length === 0) {
    return undefined;
  }

  return leaves
    .slice()
    .sort((left, right) => {
      const timeDiff = Date.parse(right.timestamp) - Date.parse(left.timestamp);
      if (!Number.isNaN(timeDiff) && timeDiff !== 0) {
        return timeDiff;
      }
      return right.uuid.localeCompare(left.uuid);
    })[0];
}

function buildConversationChain(
  transcriptEntries: ActoviqTranscriptMessage[],
  leafUuid: string,
): ActoviqTranscriptMessage[] {
  const byId = new Map(transcriptEntries.map(entry => [entry.uuid, entry]));
  const chain: ActoviqTranscriptMessage[] = [];
  const seen = new Set<string>();

  let current = byId.get(leafUuid);
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    chain.push(current);
    current = current.parentUuid ? byId.get(current.parentUuid) : undefined;
  }

  return chain.reverse();
}

async function withPortableConfigEnv<T>(run: () => Promise<T>): Promise<T> {
  const configDir = process.env.ACTOVIQ_CONFIG_DIR;
  if (!configDir) {
    return run();
  }

  const previous = process.env[LEGACY_CONFIG_ENV_KEY];
  process.env[LEGACY_CONFIG_ENV_KEY] = configDir;

  try {
    return await run();
  } finally {
    if (previous == null) {
      delete process.env[LEGACY_CONFIG_ENV_KEY];
    } else {
      process.env[LEGACY_CONFIG_ENV_KEY] = previous;
    }
  }
}
