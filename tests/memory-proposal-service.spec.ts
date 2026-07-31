import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MemoryProposalService } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('MemoryProposalService', () => {
  it('requires review, records provenance, and detects base conflicts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-memory-proposal-'));
    dirs.push(dir);
    const target = path.join(dir, 'MEMORY.md');
    await writeFile(target, '# Memory\n');
    const service = new MemoryProposalService(path.join(dir, 'proposals'), [dir]);
    const proposal = await service.propose({
      targetPath: target,
      content: 'Prefer focused modules.',
      explanation: 'Durable project convention.',
      provenance: { source: 'assistant', sessionId: 'session-1', runId: 'run-1' },
    });
    expect(await readFile(target, 'utf8')).toBe('# Memory\n');
    await service.apply(proposal.id);
    expect(await readFile(target, 'utf8')).toContain('session:session-1');

    const conflicting = await service.propose({
      targetPath: target,
      content: 'Conflicting note.',
      explanation: 'test',
      provenance: { source: 'assistant' },
    });
    await writeFile(target, '# externally changed\n');
    await expect(service.apply(conflicting.id)).rejects.toThrow('changed after proposal');
  });
});
