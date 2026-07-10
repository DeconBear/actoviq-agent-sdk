import { describe, expect, it } from 'vitest';

import { createBashTool } from '../src/tools/bash/BashTool.js';
import type { ActoviqBackgroundTaskRecord, ToolExecutionContext } from '../src/types.js';

describe('Bash background tasks', () => {
  it('registers run_in_background commands with the runtime task manager', async () => {
    let launchOptions: {
      subagentType: string;
      description: string;
      workDir: string;
      parentRunId?: string;
      parentSessionId?: string;
      agentName?: string;
      outputFile?: string | ((taskId: string) => string);
    } | undefined;
    const task: ActoviqBackgroundTaskRecord = {
      id: 'task_bash_1',
      status: 'queued',
      description: 'List files',
      subagentType: 'bash',
      outputFile: 'unused',
      workDir: 'C:/work',
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
    };
    const bash = createBashTool({
      backgroundTaskManager: {
        async launch(options) {
          launchOptions = options;
          return {
            ...task,
            description: options.description,
            outputFile:
              typeof options.outputFile === 'function'
                ? options.outputFile(task.id)
                : options.outputFile ?? task.outputFile,
            parentRunId: options.parentRunId,
            parentSessionId: options.parentSessionId,
            agentName: options.agentName,
          };
        },
      },
    });

    const result = await bash.execute(
      { command: 'ls -la', description: 'List files', run_in_background: true },
      {
        runId: 'run_1',
        sessionId: 'session_1',
        cwd: 'C:/work',
        metadata: {},
        prompt: 'list',
        iteration: 1,
      } satisfies ToolExecutionContext,
    );

    expect(launchOptions?.subagentType).toBe('bash');
    expect(launchOptions?.parentRunId).toBe('run_1');
    expect(launchOptions?.parentSessionId).toBe('session_1');
    expect(result).toMatchObject({
      exitCode: 0,
      backgroundTaskId: 'task_bash_1',
    });
    expect(String((result as { outputFile?: unknown }).outputFile)).toContain(
      '.actoviq-artifacts',
    );
  });
});
