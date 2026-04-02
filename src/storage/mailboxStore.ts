import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ActoviqMailboxMessage } from '../types.js';
import { createId } from '../runtime/helpers.js';

export class MailboxStore {
  constructor(private readonly rootDirectory: string) {}

  async post(
    teamName: string,
    recipient: string,
    message: Omit<ActoviqMailboxMessage, 'id' | 'teamName' | 'to'>,
  ): Promise<ActoviqMailboxMessage> {
    await this.ensureReady(teamName);
    const entry: ActoviqMailboxMessage = {
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

  async list(teamName: string, recipient: string): Promise<ActoviqMailboxMessage[]> {
    await this.ensureReady(teamName);
    try {
      const raw = await readFile(this.mailboxPath(teamName, recipient), 'utf8');
      return JSON.parse(raw) as ActoviqMailboxMessage[];
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async drain(teamName: string, recipient: string): Promise<ActoviqMailboxMessage[]> {
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
    return path.join(this.rootDirectory, 'mailboxes', teamName);
  }

  private mailboxPath(teamName: string, recipient: string): string {
    return path.join(this.teamDirectory(teamName), `${recipient}.json`);
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
