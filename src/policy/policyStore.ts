import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';
import type { PolicyDocument, PolicyScope } from './types.js';

export class PolicyStore {
  constructor(
    private readonly filePath: string,
    private readonly scope: PolicyScope,
  ) {}

  async load(): Promise<PolicyDocument> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as PolicyDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {
        version: 1,
        revision: 0,
        scope: this.scope,
        settings: {},
        rules: [],
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async save(
    next: Omit<PolicyDocument, 'revision' | 'updatedAt'>,
    expectedRevision: number,
  ): Promise<PolicyDocument> {
    const current = await this.load();
    if (current.revision !== expectedRevision) {
      throw new Error(`Policy revision conflict: expected ${expectedRevision}, actual ${current.revision}.`);
    }
    if (current.revision > 0) await this.writeHistory(current);
    const saved: PolicyDocument = {
      ...next,
      version: 1,
      scope: this.scope,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJsonAtomic(this.filePath, saved);
    return saved;
  }

  async rollback(revision: number): Promise<PolicyDocument> {
    const historyPath = path.join(this.historyRoot(), `${revision}.json`);
    const snapshot = JSON.parse(await readFile(historyPath, 'utf8')) as PolicyDocument;
    const current = await this.load();
    return this.save({
      version: 1,
      scope: this.scope,
      settings: snapshot.settings,
      rules: snapshot.rules,
      lockedSettings: snapshot.lockedSettings,
    }, current.revision);
  }

  async revisions(): Promise<number[]> {
    try {
      return (await readdir(this.historyRoot()))
        .filter(file => /^\d+\.json$/u.test(file))
        .map(file => Number(file.slice(0, -5)))
        .sort((left, right) => right - left);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async writeHistory(document: PolicyDocument): Promise<void> {
    await mkdir(this.historyRoot(), { recursive: true });
    await writeJsonAtomic(path.join(this.historyRoot(), `${document.revision}.json`), document);
  }

  private historyRoot(): string {
    return `${this.filePath}.history`;
  }
}
