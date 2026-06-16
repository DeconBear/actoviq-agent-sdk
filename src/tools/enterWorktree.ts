/**
 * EnterWorktree tool — creates an isolated git worktree and switches
 * the agent's working directory into it.
 */
import { z } from 'zod';
import { tool } from '../runtime/tools.js';
import type { ToolExecutionContext } from '../types.js';
import type { WorktreeService } from '../worktree/worktreeService.js';

export const ENTER_WORKTREE_TOOL_NAME = 'EnterWorktree';

const enterWorktreeSchema = z.strictObject({
  path: z.string().optional().describe('Path to an existing worktree to enter'),
  name: z.string().optional().describe('Name for the new worktree (generates branch worktree-<name>)'),
  branch: z.string().optional().describe('Explicit branch name (overrides auto-generated)'),
  ref: z.string().optional().describe('Git ref to checkout (default: HEAD or origin/HEAD per baseRef)'),
  detach: z.boolean().optional().describe('Create detached HEAD worktree'),
  pr: z.string().optional().describe('PR number (e.g. "1234") or full GitHub PR URL'),
});

type EnterWorktreeInput = z.infer<typeof enterWorktreeSchema>;

export function createEnterWorktreeTool(getWorktreeService: () => WorktreeService | undefined) {
  return tool(
    {
      name: ENTER_WORKTREE_TOOL_NAME,
      description:
        'Creates an isolated git worktree and switches the agent\'s working directory into it. ' +
        'Pass a path to switch into an existing worktree. ' +
        'From within a worktree, only the path form is available and the target must be under .actoviq/worktrees/.',
      inputSchema: enterWorktreeSchema,
      isConcurrencySafe: () => false,
      prompt: async () => {
        return [
          '## EnterWorktree Tool',
          'Creates an isolated git worktree for parallel work. Use when:',
          '- Working on multiple features/bugs simultaneously',
          '- Testing changes in isolation without affecting the main checkout',
          '- Reviewing PRs in a clean workspace',
          '',
          'Parameters:',
          '- `name`: Human-readable name (auto-generates branch worktree-<name>)',
          '- `branch`: Explicit branch name (overrides auto-generated)',
          '- `ref`: Git ref to base the worktree on',
          '- `detach`: Create a detached HEAD worktree',
          '- `pr`: PR number or URL to check out',
          '- `path`: Enter an existing worktree by path',
          '',
          'After entering, all file operations use the worktree directory. Use ExitWorktree to return.',
        ].join('\n');
      },
    },
    async (input: EnterWorktreeInput, context: ToolExecutionContext) => {
      const service = getWorktreeService();
      if (!service) {
        return 'Worktree service is not available. Ensure the project is a git repository.';
      }

      // Enter existing worktree
      if (input.path) {
        const entry = await service.enterWorktree(input.path, input.branch);
        return `Entered existing worktree at ${entry.workDir} (branch: ${entry.worktreeBranch ?? 'detached'}).\n\n` +
          `Working directory is now: ${entry.workDir}\n` +
          `Use ExitWorktree to return to the original directory.`;
      }

      // Create new worktree
      if (service.isInWorktree) {
        return 'Cannot create a new worktree from within a worktree. Use the path form to switch to another existing worktree, or ExitWorktree first.';
      }

      const entry = await service.createAndEnterWorktree({
        name: input.name,
        branch: input.branch,
        ref: input.ref,
        detach: input.detach,
        pr: input.pr,
      });

      const parts: string[] = [
        `Created worktree at ${entry.workDir}`,
        `Branch: ${entry.worktreeBranch ?? 'detached HEAD'}`,
        `Working directory is now: ${entry.workDir}`,
        '',
        'Use ExitWorktree to return to the original directory.',
      ];

      if (input.pr) {
        parts.unshift(`Checked out PR #${input.pr.replace(/^#/, '')}`);
      }

      return parts.join('\n');
    },
  );
}
