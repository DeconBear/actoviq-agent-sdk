import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ActoviqTeammateRecord } from '../types.js';
import { createId } from '../runtime/helpers.js';

export class TeammateStore {
  constructor(private readonly rootDirectory: string) {}

  async create(
    teamName: string,
    record: Omit<ActoviqTeammateRecord, 'id' | 'teamName'>,
  ): Promise<ActoviqTeammateRecord> {
    await this.ensureReady(teamName);
    const teammate: ActoviqTeammateRecord = {
      ...record,
      id: createId(),
      teamName,
    };
    await this.save(teammate);
    return teammate;
  }

  async save(record: ActoviqTeammateRecord): Promise<void> {
    await this.ensureReady(record.teamName);
    await writeJsonAtomic(this.recordPath(record.teamName, record.name), record);
  }

  async load(teamName: string, name: string): Promise<ActoviqTeammateRecord | undefined> {
    await this.ensureReady(teamName);
    try {
      const raw = await readFile(this.recordPath(teamName, name), 'utf8');
      return JSON.parse(raw) as ActoviqTeammateRecord;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async list(teamName: string): Promise<ActoviqTeammateRecord[]> {
    await this.ensureReady(teamName);
    const files = await readdir(this.teamDirectory(teamName));
    const teammates: ActoviqTeammateRecord[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const raw = await readFile(path.join(this.teamDirectory(teamName), file), 'utf8');
      teammates.push(JSON.parse(raw) as ActoviqTeammateRecord);
    }
    return teammates.sort((left, right) => left.name.localeCompare(right.name));
  }

  async delete(teamName: string, name: string): Promise<void> {
    await this.ensureReady(teamName);
    await rm(this.recordPath(teamName, name), { force: true });
  }

  private teamDirectory(teamName: string): string {
    return path.join(this.rootDirectory, 'teammates', teamName);
  }

  private recordPath(teamName: string, name: string): string {
    return path.join(this.teamDirectory(teamName), `${name}.json`);
  }

  private async ensureReady(teamName: string): Promise<void> {
    await mkdir(this.teamDirectory(teamName), { recursive: true });
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tempPath = `${filePath}.${createId()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}
