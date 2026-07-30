import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';

export interface StoredApproval {
  id: string;
  tool: string;
  behavior: 'allow' | 'deny';
  pathPrefix?: string;
  expiresAt?: string;
  createdAt: string;
}

export class ApprovalPolicy {
  constructor(private readonly filePath: string) {}

  async remember(approval: StoredApproval): Promise<void> {
    const approvals = (await this.list()).filter(item => item.id !== approval.id);
    approvals.push(approval);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJsonAtomic(this.filePath, approvals);
  }

  async decide(tool: string, targetPath?: string): Promise<'allow' | 'deny' | undefined> {
    const now = Date.now();
    const approval = (await this.list()).find(item =>
      item.tool === tool
      && (!item.expiresAt || Date.parse(item.expiresAt) > now)
      && (!item.pathPrefix || (targetPath && isUnder(item.pathPrefix, targetPath))),
    );
    return approval?.behavior;
  }

  async list(): Promise<StoredApproval[]> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      return Array.isArray(value) ? value as StoredApproval[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

function isUnder(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
