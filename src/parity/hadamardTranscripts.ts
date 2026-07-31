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

export type HadamardListSessionsOptions = ListSessionsOptions;
export type HadamardBridgeSessionInfo = SessionInfo;
const LEGACY_CONFIG_ENV_KEY = ['CL', 'AUDE_CONFIG_DIR'].join('');

export type HadamardTranscriptMessageType =
  | 'user'
  | 'assistant'
  | 'attachment'
  | 'system';

export interface HadamardTranscriptMessage {
  uuid: string;
  parentUuid: string | null;
  logicalParentUuid?: string | null;
  type: HadamardTranscriptMessageType;
  timestamp: string;
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  isSidechain: boolean;
  message?: unknown;
  raw: Record<string, unknown>;
}

export interface HadamardBridgeSessionLookupOptions {
  dir?: string;
}

export interface HadamardBridgeSessionMessagesOptions extends HadamardBridgeSessionLookupOptions {
  includeSystemMessages?: boolean;
  includeSidechains?: boolean;
}

export interface HadamardBridgeCompactBoundaryLookupOptions
  extends HadamardBridgeSessionMessagesOptions {}

const TRANSCRIPT_MESSAGE_TYPES = new Set<HadamardTranscriptMessageType>([
  'user',
  'assistant',
  'attachment',
  'system',
]);

/**
 * Lists Hadamard Runtime native sessions from the `.hadamard/projects` store using
 * the upstream portable session discovery logic.
 */
export async function listHadamardBridgeSessions(
  options?: HadamardListSessionsOptions,
): Promise<HadamardBridgeSessionInfo[]> {
  return withPortableConfigEnv(() => listSessionsImpl(options));
}

/**
 * Resolves Hadamard Runtime session metadata for a single session id using the
 * upstream portable lite-reader path.
 */
export async function getHadamardBridgeSessionInfo(
  sessionId: string,
  options?: HadamardBridgeSessionLookupOptions,
): Promise<HadamardBridgeSessionInfo | undefined> {
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
 * Reads a Hadamard Runtime native transcript and reconstructs the latest main-thread
 * conversation chain by walking `parentUuid` from the most recent leaf.
 */
export async function getHadamardBridgeSessionMessages(
  sessionId: string,
  options: HadamardBridgeSessionMessagesOptions = {},
): Promise<HadamardTranscriptMessage[]> {
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

export async function getHadamardBridgeCompactBoundaries(
  sessionId: string,
  options: HadamardBridgeCompactBoundaryLookupOptions = {},
): Promise<import('../types.js').HadamardTranscriptBoundary[]> {
  const messages = await getHadamardBridgeSessionMessages(sessionId, {
    ...options,
    includeSystemMessages: true,
  });

  const boundaries: import('../types.js').HadamardTranscriptBoundary[] = [];

  for (const message of messages) {
    if (message.type !== 'system') {
      continue;
    }

    const subtype = typeof message.raw.subtype === 'string' ? message.raw.subtype : undefined;
    if (subtype === 'compact_boundary') {
      const compactMetadata = isRecord(message.raw.compactMetadata)
        ? message.raw.compactMetadata
        : isRecord(message.raw.compact_metadata)
          ? message.raw.compact_metadata
          : undefined;
      const metadata = isRecord(compactMetadata)
        ? {
            trigger:
              typeof compactMetadata?.trigger === 'string'
                ? compactMetadata.trigger
                : undefined,
            preTokens:
              typeof compactMetadata?.preTokens === 'number'
                ? compactMetadata.preTokens
                : typeof compactMetadata?.pre_tokens === 'number'
                  ? compactMetadata.pre_tokens
                  : undefined,
            userContext:
              typeof compactMetadata?.userContext === 'string'
                ? compactMetadata.userContext
                : typeof compactMetadata?.user_context === 'string'
                  ? compactMetadata.user_context
                  : undefined,
            messagesSummarized:
              typeof compactMetadata?.messagesSummarized === 'number'
                ? compactMetadata.messagesSummarized
                : typeof compactMetadata?.messages_summarized === 'number'
                  ? compactMetadata.messages_summarized
                  : undefined,
            preservedSegment: readPreservedSegment(compactMetadata),
          }
        : undefined;

      boundaries.push({
        kind: 'compact',
        uuid: message.uuid,
        timestamp: message.timestamp,
        sessionId: message.sessionId,
        logicalParentUuid: message.logicalParentUuid,
        metadata,
        raw: message.raw,
      });
      continue;
    }

    if (subtype === 'microcompact_boundary') {
      const metadata = isRecord(message.raw.microcompactMetadata)
        ? {
            trigger:
              typeof message.raw.microcompactMetadata.trigger === 'string'
                ? message.raw.microcompactMetadata.trigger
                : undefined,
            preTokens:
              typeof message.raw.microcompactMetadata.preTokens === 'number'
                ? message.raw.microcompactMetadata.preTokens
                : undefined,
            tokensSaved:
              typeof message.raw.microcompactMetadata.tokensSaved === 'number'
                ? message.raw.microcompactMetadata.tokensSaved
                : undefined,
            compactedToolIds: Array.isArray(message.raw.microcompactMetadata.compactedToolIds)
              ? message.raw.microcompactMetadata.compactedToolIds.filter(
                  (entry): entry is string => typeof entry === 'string',
                )
              : undefined,
            clearedAttachmentUUIDs: Array.isArray(
              message.raw.microcompactMetadata.clearedAttachmentUUIDs,
            )
              ? message.raw.microcompactMetadata.clearedAttachmentUUIDs.filter(
                  (entry): entry is string => typeof entry === 'string',
                )
              : undefined,
          }
        : undefined;

      boundaries.push({
        kind: 'microcompact',
        uuid: message.uuid,
        timestamp: message.timestamp,
        sessionId: message.sessionId,
        logicalParentUuid: message.logicalParentUuid,
        metadata,
        raw: message.raw,
      });
    }
  }

  return boundaries;
}

export async function getHadamardBridgeLatestCompactBoundary(
  sessionId: string,
  options: HadamardBridgeCompactBoundaryLookupOptions = {},
): Promise<import('../types.js').HadamardTranscriptBoundary | undefined> {
  const boundaries = await getHadamardBridgeCompactBoundaries(sessionId, options);
  return boundaries.at(-1);
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

function parseTranscriptMessages(transcriptText: string): HadamardTranscriptMessage[] {
  const parsed: HadamardTranscriptMessage[] = [];

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
        !TRANSCRIPT_MESSAGE_TYPES.has(type as HadamardTranscriptMessageType) ||
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
        type: type as HadamardTranscriptMessageType,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readPreservedSegment(
  metadata: Record<string, unknown> | undefined,
): import('../types.js').HadamardPreservedSegment | undefined {
  if (!metadata) {
    return undefined;
  }

  const segment = isRecord(metadata.preservedSegment)
    ? metadata.preservedSegment
    : isRecord(metadata.preserved_segment)
      ? metadata.preserved_segment
      : undefined;
  if (!segment) {
    return undefined;
  }

  const headUuid =
    typeof segment.headUuid === 'string'
      ? segment.headUuid
      : typeof segment.head_uuid === 'string'
        ? segment.head_uuid
        : undefined;
  const anchorUuid =
    typeof segment.anchorUuid === 'string'
      ? segment.anchorUuid
      : typeof segment.anchor_uuid === 'string'
        ? segment.anchor_uuid
        : undefined;
  const tailUuid =
    typeof segment.tailUuid === 'string'
      ? segment.tailUuid
      : typeof segment.tail_uuid === 'string'
        ? segment.tail_uuid
        : undefined;

  if (!headUuid || !anchorUuid || !tailUuid) {
    return undefined;
  }

  return {
    headUuid,
    anchorUuid,
    tailUuid,
  };
}

function findLatestLeaf(
  transcriptEntries: HadamardTranscriptMessage[],
): HadamardTranscriptMessage | undefined {
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
  transcriptEntries: HadamardTranscriptMessage[],
  leafUuid: string,
): HadamardTranscriptMessage[] {
  const byId = new Map(transcriptEntries.map(entry => [entry.uuid, entry]));
  const chain: HadamardTranscriptMessage[] = [];
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
  const configDir = process.env.HADAMARD_CONFIG_DIR;
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
