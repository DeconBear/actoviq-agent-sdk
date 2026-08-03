import path from 'node:path';

import { getHadamardProjectSessionDirectory } from '../config/projectSessionDirectory.js';
import { MemoryProposalService } from './memoryProposalService.js';

export class MemoryProposalCommandService {
  readonly proposals: MemoryProposalService;

  constructor(homeDir: string, workDir: string) {
    this.proposals = new MemoryProposalService(
      path.join(getHadamardProjectSessionDirectory(workDir, homeDir), 'memory-proposals'),
      [homeDir, workDir],
    );
  }

  async execute(input: string): Promise<{
    message: string;
    items?: Array<{ label: string; description?: string }>;
  }> {
    const [action = 'proposals', proposalId, confirmation] = input.trim().split(/\s+/);
    if (action === 'proposals') {
      const proposals = await this.proposals.list('pending');
      return {
        message: `${proposals.length} pending memory proposal(s).`,
        items: proposals.map(proposal => ({
          label: proposal.id,
          description: `${proposal.targetPath} · ${proposal.explanation}`,
        })),
      };
    }
    if (!proposalId) throw new Error(`Usage: /memory ${action} <proposal-id>`);
    if (action === 'apply') {
      if (confirmation !== '--confirm') {
        throw new Error('Preview the proposal, then use /memory apply <proposal-id> --confirm.');
      }
      await this.proposals.apply(proposalId);
      return { message: `Memory proposal applied: ${proposalId}.` };
    }
    if (action === 'reject') {
      await this.proposals.reject(proposalId);
      return { message: `Memory proposal rejected: ${proposalId}.` };
    }
    throw new Error('Usage: /memory proposals|apply <id> --confirm|reject <id>');
  }
}
