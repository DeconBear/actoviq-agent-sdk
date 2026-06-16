/**
 * ExitWorktree tool — exits the current worktree and returns to
 * the original working directory.
 */
import { z } from 'zod';
import { tool } from '../runtime/tools.js';
import type { WorktreeService } from '../worktree/worktreeService.js';

export const EXIT_WORKTREE_TOOL_NAME = 'ExitWorktree';

const exitWorktreeSchema = z.strictObject({});

export function createExitWorktreeTool(getWorktreeService: () => WorktreeService | undefined) {
  return tool(
    {
      name: EXIT_WORKTREE_TOOL_NAME,
      description:
        'Exits the current worktree and returns to the original working directory. ' +
        'Not available to subagents already running in worktree isolation.',
      inputSchema: exitWorktreeSchema,
      isConcurrencySafe: () => false,
      prompt: async () => {
        return [
          '## ExitWorktree Tool',
          'Exits the current worktree and returns to the original working directory.',
          'The worktree is NOT automatically cleaned up — if it has changes, you will',
          'be prompted to keep or discard them.',
        ].join('\n');
      },
    },
    async (_input: Record<string, never>) => {
      const service = getWorktreeService();
      if (!service) {
        return 'Worktree service is not available.';
      }

      if (!service.isInWorktree) {
        return 'Not currently in a worktree. Nothing to exit.';
      }

      const prevWorkDir = service.currentWorkDir;
      const popped = service.exitWorktree();

      if (!popped) {
        return 'Not currently in a worktree. Nothing to exit.';
      }

      const dirty = await service.isWorktreeDirty(prevWorkDir);

      const parts: string[] = [
        `Exited worktree at ${prevWorkDir}.`,
        `Working directory restored to: ${service.currentWorkDir}`,
      ];

      if (dirty) {
        parts.push(
          '',
          `⚠ The worktree at ${prevWorkDir} has uncommitted changes.`,
          `Branch: ${popped.worktreeBranch ?? 'detached'}`,
          'The worktree directory and branch have been preserved. Clean up manually when ready:',
          `  git -C "${service.repoRootPath}" worktree remove --force "${prevWorkDir}"`,
        );
      }

      return parts.join('\n');
    },
  );
}
