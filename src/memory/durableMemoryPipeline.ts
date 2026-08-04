import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { HadamardDreamConfig, HadamardDreamPaths, StoredSession } from '../types.js';
import { safeStorageFileName } from '../storage/pathSafety.js';
import { redactMemorySecrets } from './hadamardSessionMemoryState.js';
import { DurableMemoryStore, type DurableMemoryExtractionRecord } from './durableMemoryStore.js';
import { isHadamardDreamEligibleSession } from './hadamardDream.js';

export interface DurableMemoryExtraction {
  rawMemory: string;
  rolloutSummary: string;
  rolloutSlug?: string;
  noOutput: boolean;
}

export interface PreparedDurableMemoryConsolidation {
  owner: string;
  artifactHash: string;
  manifestJson: string;
  changed: boolean;
  diff: {
    added: string[];
    changed: string[];
    removed: string[];
  };
  selectedSessionIds: string[];
  extractedSessionIds: string[];
  promptContext: string;
}

export async function prepareDurableMemoryConsolidation(input: {
  paths: HadamardDreamPaths;
  projectPath: string;
  sessions: readonly StoredSession[];
  currentSessionId?: string;
  config: HadamardDreamConfig;
  force?: boolean;
  maxInputTokens: number;
  signal?: AbortSignal;
  extract: (input: {
    session: StoredSession;
    transcript: string;
    signal?: AbortSignal;
  }) => Promise<DurableMemoryExtraction>;
}): Promise<PreparedDurableMemoryConsolidation | undefined> {
  const store = await DurableMemoryStore.open(input.paths.stateDbPath);
  const extractionOwner = `phase1:${process.pid}:${randomUUID()}`;
  const extractedSessionIds: string[] = [];
  try {
    const eligible = selectEligibleSessions(input);
    await mapWithConcurrency(eligible, 2, async session => {
      input.signal?.throwIfAborted();
      const transcriptPath = path.join(
        input.paths.transcriptDir,
        safeStorageFileName('sessionId', session.id, 'jsonl'),
      );
      const transcript = await readFile(transcriptPath, 'utf8').catch(() => '');
      if (!transcript.trim()) return;
      const transcriptVersion = hash(transcript);
      if (!store.acquireExtractionLease({
        sessionId: session.id,
        transcriptVersion,
        owner: extractionOwner,
      })) return;
      try {
        const extraction = normalizeExtraction(await input.extract({
          session,
          transcript: truncateToTokenBudget(transcript, input.maxInputTokens),
          signal: input.signal,
        }));
        store.completeExtraction({
          sessionId: session.id,
          owner: extractionOwner,
          transcriptVersion,
          ...extraction,
        });
        extractedSessionIds.push(session.id);
      } catch (error) {
        store.failExtraction(
          session.id,
          extractionOwner,
          error instanceof Error ? error.message : String(error),
        );
      }
    });

    const selected = store.listConsolidationCandidates(64);
    const owner = `phase2:${process.pid}:${randomUUID()}`;
    if (!store.acquireConsolidationLease(owner)) return undefined;
    try {
      const prepared = await buildArtifacts(input.paths, selected, store.consolidationState().manifestJson);
      return {
        owner,
        ...prepared,
        selectedSessionIds: selected.map(record => record.sessionId),
        extractedSessionIds,
        promptContext: buildPromptContext(input.paths, prepared.diff, selected),
      };
    } catch (error) {
      store.releaseConsolidationLease(owner, error instanceof Error ? error.message : String(error));
      throw error;
    }
  } finally {
    store.close();
  }
}

export async function completeDurableMemoryConsolidation(input: {
  paths: HadamardDreamPaths;
  prepared: PreparedDurableMemoryConsolidation;
  success: boolean;
  error?: string;
}): Promise<void> {
  const store = await DurableMemoryStore.open(input.paths.stateDbPath);
  try {
    if (!input.success) {
      store.releaseConsolidationLease(input.prepared.owner, input.error);
      return;
    }
    store.completeConsolidation({
      owner: input.prepared.owner,
      artifactHash: input.prepared.artifactHash,
      manifestJson: input.prepared.manifestJson,
      watermark: input.prepared.selectedSessionIds.at(-1),
    });
  } finally {
    store.close();
  }
}

export async function recordDurableMemoryPromptUsage(paths: HadamardDreamPaths): Promise<void> {
  const store = await DurableMemoryStore.open(paths.stateDbPath);
  try {
    store.recordUsage(store.listConsolidationCandidates(64).map(record => record.sessionId));
  } finally {
    store.close();
  }
}

export async function readDurableMemoryPipelineStatus(paths: HadamardDreamPaths): Promise<{
  phase: 'idle' | 'extracting' | 'consolidating';
  leaseExpiresAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}> {
  const store = await DurableMemoryStore.open(paths.stateDbPath);
  try {
    const state = store.consolidationState();
    const extraction = store.activeExtractionLease();
    return {
      phase: state.leaseOwner ? 'consolidating' : extraction ? 'extracting' : 'idle',
      ...(state.leaseExpiresAt || extraction?.leaseExpiresAt
        ? { leaseExpiresAt: state.leaseExpiresAt ?? extraction?.leaseExpiresAt }
        : {}),
      ...(state.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
    };
  } finally {
    store.close();
  }
}

function selectEligibleSessions(input: {
  sessions: readonly StoredSession[];
  currentSessionId?: string;
  projectPath: string;
  config: HadamardDreamConfig;
  force?: boolean;
}): StoredSession[] {
  const now = Date.now();
  const idleMs = (input.config.minRolloutIdleHours ?? 12) * 60 * 60 * 1000;
  const ageMs = (input.config.maxRolloutAgeDays ?? 30) * 24 * 60 * 60 * 1000;
  const max = input.config.maxRolloutsPerStartup ?? 6;
  return input.sessions
    .filter(session => session.id !== input.currentSessionId)
    .filter(session => isHadamardDreamEligibleSession(session))
    .filter(session => session.kind == null || session.kind === 'main' || session.kind === 'worktree')
    .filter(session => session.parentSessionId == null)
    .filter(session => session.metadata.__hadamardExternalContext !== true)
    .filter(session => session.metadata.__hadamardPolluted !== true)
    .filter(session => samePath(
      typeof session.metadata.__hadamardWorkDir === 'string'
        ? session.metadata.__hadamardWorkDir
        : input.projectPath,
      input.projectPath,
    ))
    .filter(session => {
      const touchedAt = Date.parse(session.lastRunAt ?? session.updatedAt ?? session.createdAt);
      if (!Number.isFinite(touchedAt)) return false;
      const age = now - touchedAt;
      return age <= ageMs && (input.force === true || age >= idleMs);
    })
    .sort((a, b) => Date.parse(b.lastRunAt ?? b.updatedAt) - Date.parse(a.lastRunAt ?? a.updatedAt))
    .slice(0, max);
}

async function buildArtifacts(
  paths: HadamardDreamPaths,
  records: readonly DurableMemoryExtractionRecord[],
  previousManifestJson?: string,
): Promise<{
  artifactHash: string;
  manifestJson: string;
  changed: boolean;
  diff: { added: string[]; changed: string[]; removed: string[] };
}> {
  await mkdir(paths.rolloutSummariesDir, { recursive: true });
  const manifest: Record<string, string> = {};
  const usedSummaryPaths = new Set<string>();
  const rawSections: string[] = ['# Raw memories', ''];
  for (const record of records) {
    const slug = safeSlug(record.rolloutSlug ?? record.sessionId);
    let relative = `rollout_summaries/${slug}.md`;
    if (usedSummaryPaths.has(relative)) {
      relative = `rollout_summaries/${slug}-${hash(record.sessionId).slice(0, 8)}.md`;
    }
    usedSummaryPaths.add(relative);
    const summary = [
      `# ${record.rolloutSlug?.trim() || record.sessionId}`,
      '',
      record.rolloutSummary.trim(),
      '',
      `Session: ${record.sessionId}`,
      `Generated: ${record.generatedAt}`,
      '',
    ].join('\n');
    manifest[relative] = hash(summary);
    await writeAtomic(path.join(paths.memoryDir, relative), summary);
    rawSections.push(`## ${record.sessionId}`, '', record.rawMemory.trim(), '');
  }
  const raw = `${rawSections.join('\n').trim()}\n`;
  manifest[path.basename(paths.rawMemoriesPath)] = hash(raw);
  await writeAtomic(paths.rawMemoriesPath, raw);

  const previous = parseManifest(previousManifestJson);
  const added = Object.keys(manifest).filter(key => previous[key] == null).sort();
  const changed = Object.keys(manifest).filter(key => previous[key] != null && previous[key] !== manifest[key]).sort();
  const removed = Object.keys(previous).filter(key => manifest[key] == null).sort();
  for (const relative of removed) {
    if (!relative.startsWith('rollout_summaries/')) continue;
    const target = path.resolve(paths.memoryDir, relative);
    const root = path.resolve(paths.rolloutSummariesDir);
    if (path.dirname(target) === root) await rm(target, { force: true });
  }
  const manifestJson = JSON.stringify(manifest);
  return {
    artifactHash: hash(manifestJson),
    manifestJson,
    changed: added.length + changed.length + removed.length > 0,
    diff: { added, changed, removed },
  };
}

function buildPromptContext(
  paths: HadamardDreamPaths,
  diff: { added: string[]; changed: string[]; removed: string[] },
  records: readonly DurableMemoryExtractionRecord[],
): string {
  return [
    `Runtime-generated Phase-1 input: ${paths.rawMemoriesPath}`,
    `Runtime-generated rollout summaries: ${paths.rolloutSummariesDir}`,
    `Selected rollout count: ${records.length}`,
    `Added artifacts: ${diff.added.join(', ') || '(none)'}`,
    `Changed artifacts: ${diff.changed.join(', ') || '(none)'}`,
    `Removed artifacts: ${diff.removed.join(', ') || '(none)'}`,
  ].join('\n');
}

function normalizeExtraction(value: DurableMemoryExtraction): DurableMemoryExtraction {
  const rawMemory = redactMemorySecrets(value.rawMemory.trim());
  const rolloutSummary = redactMemorySecrets(value.rolloutSummary.trim());
  const rolloutSlug = value.rolloutSlug ? safeSlug(value.rolloutSlug) : undefined;
  const noOutput = value.noOutput || (!rawMemory && !rolloutSummary);
  return { rawMemory, rolloutSummary, ...(rolloutSlug ? { rolloutSlug } : {}), noOutput };
}

export function parseDurableMemoryExtractionOutput(raw: string): DurableMemoryExtraction {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  return normalizeExtraction({
    rawMemory: typeof parsed.rawMemory === 'string' ? parsed.rawMemory : '',
    rolloutSummary: typeof parsed.rolloutSummary === 'string' ? parsed.rolloutSummary : '',
    ...(typeof parsed.rolloutSlug === 'string' ? { rolloutSlug: parsed.rolloutSlug } : {}),
    noOutput: parsed.noOutput === true,
  });
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, 'utf8');
    await rename(temp, filePath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseManifest(raw?: string): Record<string, string> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

function truncateToTokenBudget(value: string, maxTokens: number): string {
  const maxChars = Math.max(4_000, maxTokens * 4);
  if (value.length <= maxChars) return value;
  return `[Older transcript entries omitted to fit the extraction model window.]\n${value.slice(-maxChars)}`;
}

function safeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80);
  return slug || hash(value).slice(0, 16);
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await action(values[index]!);
    }
  }));
}
