import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { HadamardTeammateRecord } from '../types.js';
import { createId } from '../runtime/helpers.js';
import {
  assertSafeStorageSegment,
  joinUnderStorageRoot,
  safeStorageFileName,
} from './pathSafety.js';
import { writeJsonAtomic } from './atomicJsonWrite.js';

export class TeammateStore {
  constructor(private readonly rootDirectory: string) {}

  async create(
    teamName: string,
    record: Omit<HadamardTeammateRecord, 'id' | 'teamName'>,
  ): Promise<HadamardTeammateRecord> {
    await this.ensureReady(teamName);
    const teammate: HadamardTeammateRecord = {
      ...record,
      id: createId(),
      teamName,
    };
    await this.save(teammate);
    return teammate;
  }

  async save(record: HadamardTeammateRecord): Promise<void> {
    await this.ensureReady(record.teamName);
    await writeJsonAtomic(this.recordPath(record.teamName, record.name), record);
  }

  async load(teamName: string, name: string): Promise<HadamardTeammateRecord | undefined> {
    await this.ensureReady(teamName);
    try {
      const raw = await readFile(this.recordPath(teamName, name), 'utf8');
      return JSON.parse(raw) as HadamardTeammateRecord;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async list(teamName: string): Promise<HadamardTeammateRecord[]> {
    await this.ensureReady(teamName);
    const files = await readdir(this.teamDirectory(teamName));
    const teammates: HadamardTeammateRecord[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const raw = await readFile(path.join(this.teamDirectory(teamName), file), 'utf8');
      teammates.push(JSON.parse(raw) as HadamardTeammateRecord);
    }
    return teammates.sort((left, right) => left.name.localeCompare(right.name));
  }

  async delete(teamName: string, name: string): Promise<void> {
    await this.ensureReady(teamName);
    await rm(this.recordPath(teamName, name), { force: true });
  }

  private teamDirectory(teamName: string): string {
    return joinUnderStorageRoot(
      this.rootDirectory,
      'teammates',
      assertSafeStorageSegment('teamName', teamName),
    );
  }

  private recordPath(teamName: string, name: string): string {
    return joinUnderStorageRoot(
      this.teamDirectory(teamName),
      safeStorageFileName('name', name, 'json'),
    );
  }

  private async ensureReady(teamName: string): Promise<void> {
    await mkdir(this.teamDirectory(teamName), { recursive: true });
  }
}
