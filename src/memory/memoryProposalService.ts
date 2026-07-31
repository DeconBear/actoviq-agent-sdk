import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';

export interface MemoryProposal {
  id: string;
  targetPath: string;
  content: string;
  explanation: string;
  provenance: {
    sessionId?: string;
    runId?: string;
    source: string;
  };
  baseFingerprint: string;
  status: 'pending' | 'applied' | 'rejected';
  createdAt: string;
  updatedAt: string;
}

export class MemoryProposalService {
  constructor(
    private readonly storageRoot: string,
    private readonly allowedRoots: string[],
  ) {}

  async propose(input: {
    targetPath: string;
    content: string;
    explanation: string;
    provenance: MemoryProposal['provenance'];
  }): Promise<MemoryProposal> {
    const targetPath = this.safeTarget(input.targetPath);
    const current = await readText(targetPath);
    const now = new Date().toISOString();
    const proposal: MemoryProposal = {
      id: randomUUID(),
      targetPath,
      content: input.content.trim(),
      explanation: input.explanation.trim(),
      provenance: { ...input.provenance },
      baseFingerprint: fingerprint(current),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await this.write(proposal);
    return proposal;
  }

  async list(status?: MemoryProposal['status']): Promise<MemoryProposal[]> {
    let files: string[];
    try {
      files = await readdir(this.storageRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const proposals = await Promise.all(files
      .filter(file => file.endsWith('.json'))
      .map(async file => JSON.parse(await readFile(path.join(this.storageRoot, file), 'utf8')) as MemoryProposal));
    return proposals.filter(proposal => !status || proposal.status === status);
  }

  async apply(proposalId: string): Promise<MemoryProposal> {
    const proposal = await this.get(proposalId);
    if (proposal.status !== 'pending') throw new Error(`Memory proposal is ${proposal.status}.`);
    const current = await readText(this.safeTarget(proposal.targetPath));
    if (fingerprint(current) !== proposal.baseFingerprint) {
      throw new Error('Memory target changed after proposal creation; regenerate the proposal.');
    }
    const provenance = [
      `<!-- hadamard-memory-proposal:${proposal.id}`,
      `source:${proposal.provenance.source}`,
      proposal.provenance.sessionId ? `session:${proposal.provenance.sessionId}` : '',
      proposal.provenance.runId ? `run:${proposal.provenance.runId}` : '',
      '-->',
    ].filter(Boolean).join(' ');
    const next = [current.trimEnd(), provenance, proposal.content, ''].filter(Boolean).join('\n\n');
    await writeTextAtomic(proposal.targetPath, next);
    proposal.status = 'applied';
    proposal.updatedAt = new Date().toISOString();
    await this.write(proposal);
    return proposal;
  }

  async reject(proposalId: string): Promise<MemoryProposal> {
    const proposal = await this.get(proposalId);
    if (proposal.status !== 'pending') throw new Error(`Memory proposal is ${proposal.status}.`);
    proposal.status = 'rejected';
    proposal.updatedAt = new Date().toISOString();
    await this.write(proposal);
    return proposal;
  }

  private async get(proposalId: string): Promise<MemoryProposal> {
    if (!/^[0-9a-f-]+$/iu.test(proposalId)) throw new Error('Invalid memory proposal id.');
    return JSON.parse(
      await readFile(path.join(this.storageRoot, `${proposalId}.json`), 'utf8'),
    ) as MemoryProposal;
  }

  private async write(proposal: MemoryProposal): Promise<void> {
    await mkdir(this.storageRoot, { recursive: true });
    await writeJsonAtomic(path.join(this.storageRoot, `${proposal.id}.json`), proposal);
  }

  private safeTarget(targetPath: string): string {
    const target = path.resolve(targetPath);
    const allowed = this.allowedRoots.some(root => {
      const relative = path.relative(path.resolve(root), target);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!allowed) throw new Error(`Memory target is outside allowed roots: ${target}`);
    return target;
  }
}

async function readText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
