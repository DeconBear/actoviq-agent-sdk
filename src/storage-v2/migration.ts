import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { JsonV1Migration } from './contracts.js';
import { StorageDataError } from './errors.js';
import type {
  JsonObject,
  JsonValue,
  JsonV1MigrationFileResult,
  JsonV1MigrationOptions,
  JsonV1MigrationReport,
  SessionItemInput,
} from './types.js';
import {
  assertLegacyJsonValue,
  convertLegacyJsonV1Message,
} from './legacyJsonV1Items.js';

export interface JsonV1MigrationLedgerEntry {
  contentHash: string;
  sessionId: string;
}

export interface JsonV1MigrationPlan {
  sourceId: string;
  sourceKey: string;
  sourceFile: string;
  contentHash: string;
  tenantId: string;
  sessionId: string;
  metadata: JsonObject;
  createdAt: string;
  items: SessionItemInput[];
}

export interface JsonV1MigrationApplyResult {
  sourceKey: string;
  status: 'migrated' | 'skipped';
}

/** @internal Database-side atomic migration operations. */
export interface JsonV1MigrationBackend {
  getJsonV1MigrationEntry(
    tenantId: string,
    sourceId: string,
    sourceKey: string,
  ): JsonV1MigrationLedgerEntry | undefined;
  applyJsonV1Migration(plans: readonly JsonV1MigrationPlan[]): JsonV1MigrationApplyResult[];
}

export class JsonV1Migrator implements JsonV1Migration {
  constructor(private readonly backend: JsonV1MigrationBackend) {}

  async migrate(options: JsonV1MigrationOptions): Promise<JsonV1MigrationReport> {
    assertNonEmpty(options.tenantId, 'tenantId');
    const sourceDirectory = await realpath(options.sourceDirectory).catch((error: unknown) => {
      throw new StorageDataError(
        `JSON v1 source directory does not exist: ${options.sourceDirectory}`,
        { cause: error },
      );
    });
    const sourceId = options.sourceId ?? sourceDirectory;
    assertNonEmpty(sourceId, 'sourceId');

    const plans = await planMigration(sourceDirectory, sourceId, options.tenantId);
    const duplicateIds = findDuplicates(plans.map((plan) => plan.sessionId));
    if (duplicateIds.length > 0) {
      throw new StorageDataError(
        `JSON v1 source contains duplicate session ids: ${duplicateIds.join(', ')}`,
      );
    }

    const initialResults = plans.map((plan): JsonV1MigrationFileResult => {
      const ledger = this.backend.getJsonV1MigrationEntry(
        plan.tenantId,
        plan.sourceId,
        plan.sourceKey,
      );
      if (!ledger) {
        return toFileResult(plan, options.dryRun ? 'planned' : 'migrated');
      }
      assertSameMigration(plan, ledger);
      return toFileResult(plan, 'skipped');
    });
    const pending = plans.filter((_, index) => initialResults[index]?.status !== 'skipped');

    if (options.dryRun) {
      return buildReport({
        tenantId: options.tenantId,
        sourceDirectory,
        sourceId,
        dryRun: true,
        files: initialResults,
      });
    }

    if (pending.length === 0) {
      return buildReport({
        tenantId: options.tenantId,
        sourceDirectory,
        sourceId,
        dryRun: false,
        files: initialResults,
      });
    }

    const backupDirectory = path.resolve(
      options.backupDirectory
        ?? path.join(
          path.dirname(sourceDirectory),
          `${path.basename(sourceDirectory)}.backup-v1-${Date.now()}-${randomUUID()}`,
        ),
    );
    assertBackupOutsideSource(sourceDirectory, backupDirectory);
    await mkdir(path.dirname(backupDirectory), { recursive: true });
    try {
      await cp(sourceDirectory, backupDirectory, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await verifyBackupAndSource(plans, sourceDirectory, backupDirectory);
    } catch (error) {
      throw new StorageDataError(
        `Could not create and verify migration backup at ${backupDirectory}`,
        { cause: error },
      );
    }

    // The backend applies every pending file and its ledger row in one SQLite
    // transaction. No source file is renamed, deleted, or modified.
    const applied = this.backend.applyJsonV1Migration(pending);
    const statusByKey = new Map(applied.map((result) => [result.sourceKey, result.status]));
    const files = plans.map((plan) => {
      const initial = initialResults.find((result) => result.sourceFile === plan.sourceFile);
      if (initial?.status === 'skipped') return initial;
      return toFileResult(plan, statusByKey.get(plan.sourceKey) ?? 'migrated');
    });

    return buildReport({
      tenantId: options.tenantId,
      sourceDirectory,
      sourceId,
      backupDirectory,
      dryRun: false,
      files,
    });
  }
}

async function planMigration(
  sourceDirectory: string,
  sourceId: string,
  tenantId: string,
): Promise<JsonV1MigrationPlan[]> {
  const sessionsDirectory = path.join(sourceDirectory, 'sessions');
  const entries = await readdir(sessionsDirectory, { withFileTypes: true }).catch(
    (error: unknown) => {
      throw new StorageDataError(
        `JSON v1 source has no readable sessions directory: ${sessionsDirectory}`,
        { cause: error },
      );
    },
  );

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const plans: JsonV1MigrationPlan[] = [];
  for (const file of files) {
    const sourceKey = path.posix.join('sessions', file);
    const sourceFile = path.join(sessionsDirectory, file);
    const raw = await readFile(sourceFile);
    plans.push(parseLegacySession({
      raw,
      sourceFile,
      sourceKey,
      sourceId,
      tenantId,
    }));
  }
  return plans;
}

function parseLegacySession(input: {
  raw: Buffer;
  sourceFile: string;
  sourceKey: string;
  sourceId: string;
  tenantId: string;
}): JsonV1MigrationPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw.toString('utf8'));
  } catch (error) {
    throw new StorageDataError(`Cannot parse JSON v1 session ${input.sourceFile}`, {
      cause: error,
    });
  }
  if (!isObject(parsed) || parsed.version !== 1) {
    throw new StorageDataError(`Unsupported JSON session version in ${input.sourceFile}`);
  }
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
    throw new StorageDataError(`JSON v1 session id is missing in ${input.sourceFile}`);
  }
  if (!Array.isArray(parsed.messages) || !Array.isArray(parsed.runs)) {
    throw new StorageDataError(
      `JSON v1 session ${parsed.id} must contain messages and runs arrays`,
    );
  }

  const fallbackCreatedAt = typeof parsed.createdAt === 'string'
    ? parsed.createdAt
    : new Date(0).toISOString();
  const header = { ...parsed };
  delete header.messages;
  delete header.runs;
  const messageItems = parsed.messages.flatMap((payload, messageIndex) => (
    convertLegacyJsonV1Message(payload, `JSON v1 session ${parsed.id} message ${messageIndex}`)
      .map((item, blockIndex): SessionItemInput => ({
        itemId: `json-v1:message:${messageIndex}:${blockIndex}`,
        kind: item.type,
        payload: asStorageJson(item, `JSON v1 session ${parsed.id} message ${messageIndex}`),
        createdAt: itemCreatedAt(payload, fallbackCreatedAt),
      }))
  ));
  const runItems = parsed.runs.map((payload, index): SessionItemInput => {
    assertLegacyJsonValue(payload, `JSON v1 session ${parsed.id} run ${index}`);
    return {
      itemId: `json-v1:run:${index}`,
      // Audit/provenance only. Runtime session adapters deliberately exclude
      // legacy run summaries from model transcripts.
      kind: 'legacy_run',
      payload: asStorageJson(payload, `JSON v1 session ${parsed.id} run ${index}`),
      createdAt: itemCreatedAt(payload, fallbackCreatedAt),
    };
  });
  const items: SessionItemInput[] = [...messageItems, ...runItems];

  return {
    sourceId: input.sourceId,
    sourceKey: input.sourceKey,
    sourceFile: input.sourceFile,
    contentHash: sha256(input.raw),
    tenantId: input.tenantId,
    sessionId: parsed.id,
    metadata: {
      sourceFormat: 'actoviq-json-v1',
      legacy: header,
    },
    createdAt: fallbackCreatedAt,
    items,
  };
}

function asStorageJson(value: unknown, label: string): JsonValue {
  assertLegacyJsonValue(value, label);
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function verifyBackupAndSource(
  plans: readonly JsonV1MigrationPlan[],
  sourceDirectory: string,
  backupDirectory: string,
): Promise<void> {
  for (const plan of plans) {
    const relativeParts = plan.sourceKey.split('/');
    const [current, backup] = await Promise.all([
      readFile(path.join(sourceDirectory, ...relativeParts)),
      readFile(path.join(backupDirectory, ...relativeParts)),
    ]);
    if (sha256(current) !== plan.contentHash || sha256(backup) !== plan.contentHash) {
      throw new StorageDataError(`Source changed while backing up ${plan.sourceFile}`);
    }
  }
}

function assertBackupOutsideSource(sourceDirectory: string, backupDirectory: string): void {
  if (sourceDirectory === backupDirectory) {
    throw new StorageDataError('Migration backup directory must differ from source directory');
  }
  const relative = path.relative(sourceDirectory, backupDirectory);
  if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new StorageDataError('Migration backup directory must not be inside source directory');
  }
}

function assertSameMigration(
  plan: JsonV1MigrationPlan,
  ledger: JsonV1MigrationLedgerEntry,
): void {
  if (ledger.contentHash !== plan.contentHash || ledger.sessionId !== plan.sessionId) {
    throw new StorageDataError(
      `Previously migrated JSON v1 source changed: ${plan.sourceFile}`,
    );
  }
}

function toFileResult(
  plan: JsonV1MigrationPlan,
  status: JsonV1MigrationFileResult['status'],
): JsonV1MigrationFileResult {
  return {
    sourceFile: plan.sourceFile,
    sessionId: plan.sessionId,
    itemCount: plan.items.length,
    status,
  };
}

function buildReport(input: {
  tenantId: string;
  sourceDirectory: string;
  sourceId: string;
  backupDirectory?: string;
  dryRun: boolean;
  files: JsonV1MigrationFileResult[];
}): JsonV1MigrationReport {
  return {
    tenantId: input.tenantId,
    sourceDirectory: input.sourceDirectory,
    sourceId: input.sourceId,
    ...(input.backupDirectory ? { backupDirectory: input.backupDirectory } : {}),
    dryRun: input.dryRun,
    files: input.files,
    migratedSessions: input.files.filter((file) => file.status === 'migrated').length,
    skippedSessions: input.files.filter((file) => file.status === 'skipped').length,
    totalItems: input.files.reduce((total, file) => total + file.itemCount, 0),
  };
}

function itemCreatedAt(value: unknown, fallback: string): string {
  return isObject(value) && typeof value.createdAt === 'string' ? value.createdAt : fallback;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) throw new StorageDataError(`${field} must not be empty`);
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
