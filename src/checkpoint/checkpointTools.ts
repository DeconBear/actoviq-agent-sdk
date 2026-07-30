import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';
import { FileCheckpointService } from './fileCheckpointService.js';

export interface CheckpointToolContext {
  service: FileCheckpointService;
  sessionId: string;
}

export function createCheckpointTools(context: CheckpointToolContext): AgentToolDefinition[] {
  return [
    tool(
      {
        name: 'ListCheckpoints',
        description: 'List file/conversation checkpoints for the current Session.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async () => context.service.list(context.sessionId),
    ),
    tool(
      {
        name: 'PreviewCheckpoint',
        description: 'Preview affected files and conflicts before restoring a checkpoint.',
        inputSchema: z.strictObject({ checkpointId: z.string().min(1) }),
        isReadOnly: () => true,
      },
      async input => context.service.preview(context.sessionId, input.checkpointId),
    ),
    tool(
      {
        name: 'RestoreCheckpoint',
        description: 'Restore files, conversation, or both from a checkpoint. Requires explicit user confirmation.',
        inputSchema: z.strictObject({
          checkpointId: z.string().min(1),
          mode: z.enum(['files', 'conversation', 'both']).default('both'),
          confirm: z.literal(true).describe('Must be true only after the user confirms the preview.'),
          force: z.boolean().optional().default(false),
        }),
        isDestructive: () => true,
        requiresUserInteraction: () => true,
      },
      async input => context.service.restore({
        sessionId: context.sessionId,
        checkpointId: input.checkpointId,
        mode: input.mode,
        force: input.force,
      }),
    ),
  ];
}
