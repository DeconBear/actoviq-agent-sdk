import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { HadamardMailboxMessage } from '../types.js';
import { createId } from '../runtime/helpers.js';
import {
  assertSafeStorageSegment,
  joinUnderStorageRoot,
  safeStorageFileName,
} from './pathSafety.js';
import { writeJsonAtomic } from './atomicJsonWrite.js';

export class MailboxStore {
  constructor(private readonly rootDirectory: string) {}

  async post(
    teamName: string,
    recipient: string,
    message: Omit<HadamardMailboxMessage, 'id' | 'teamName' | 'to'>,
  ): Promise<HadamardMailboxMessage> {
    await this.ensureReady(teamName);
    const entry: HadamardMailboxMessage = {
      ...message,
      id: createId(),
      teamName,
      to: recipient,
    };
    const current = await this.list(teamName, recipient);
    current.push(entry);
    await writeJsonAtomic(this.mailboxPath(teamName, recipient), current);
    return entry;
  }

  async list(teamName: string, recipient: string): Promise<HadamardMailboxMessage[]> {
    await this.ensureReady(teamName);
    try {
      const raw = await readFile(this.mailboxPath(teamName, recipient), 'utf8');
      return JSON.parse(raw) as HadamardMailboxMessage[];
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async drain(teamName: string, recipient: string): Promise<HadamardMailboxMessage[]> {
    const entries = await this.list(teamName, recipient);
    await rm(this.mailboxPath(teamName, recipient), { force: true });
    return entries;
  }

  async recipients(teamName: string): Promise<string[]> {
    await this.ensureReady(teamName);
    const files = await readdir(this.teamDirectory(teamName));
    return files.filter(file => file.endsWith('.json')).map(file => file.replace(/\.json$/u, ''));
  }

  private teamDirectory(teamName: string): string {
    return joinUnderStorageRoot(
      this.rootDirectory,
      'mailboxes',
      assertSafeStorageSegment('teamName', teamName),
    );
  }

  private mailboxPath(teamName: string, recipient: string): string {
    return joinUnderStorageRoot(
      this.teamDirectory(teamName),
      safeStorageFileName('recipient', recipient, 'json'),
    );
  }

  private async ensureReady(teamName: string): Promise<void> {
    await mkdir(this.teamDirectory(teamName), { recursive: true });
  }
}
