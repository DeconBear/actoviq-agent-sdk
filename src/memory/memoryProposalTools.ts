import path from 'node:path';
import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';
import { MemoryProposalService } from './memoryProposalService.js';

export function createMemoryProposalTools(options: {
  service: MemoryProposalService;
  homeDir: string;
  workDir: string;
}): AgentToolDefinition[] {
  return [
    tool({
      name: 'ProposeMemory',
      description: 'Create a reviewed memory proposal. This does not write the memory target; the user must apply it explicitly.',
      inputSchema: z.strictObject({
        scope: z.enum(['user', 'project']),
        content: z.string().min(1),
        explanation: z.string().min(1),
      }),
      isReadOnly: () => true,
    }, async (input, context) => options.service.propose({
      targetPath: input.scope === 'user'
        ? path.join(options.homeDir, 'MEMORY.md')
        : path.join(options.workDir, '.actoviq', 'MEMORY.md'),
      content: input.content,
      explanation: input.explanation,
      provenance: {
        source: 'agent-tool',
        sessionId: context.sessionId,
        runId: context.runId,
      },
    })),
    tool({
      name: 'ListMemoryProposals',
      description: 'List pending reviewed memory proposals.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    }, async () => options.service.list('pending')),
  ];
}
