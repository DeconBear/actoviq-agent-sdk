import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import type { HookHandlerAdapter } from '../hookTypes.js';

const execFile = promisify(execFileCallback);

export const runCommandHook: HookHandlerAdapter = async ({ definition, input, signal }) => {
  if (definition.handler.type !== 'command') throw new Error('Expected command hook.');
  const result = await execFile(
    definition.handler.command,
    definition.handler.args ?? [],
    {
      cwd: definition.handler.cwd ?? input.cwd,
      env: {
        ...process.env,
        HADAMARD_HOOK_EVENT: input.event,
        HADAMARD_HOOK_RUN_ID: input.runId,
        HADAMARD_HOOK_SESSION_ID: input.sessionId ?? '',
        HADAMARD_HOOK_TOOL: input.toolName ?? '',
        HADAMARD_HOOK_INPUT: JSON.stringify(input.payload),
      },
      encoding: 'utf8',
      windowsHide: true,
      signal,
      maxBuffer: 1024 * 1024,
    },
  );
  const feedback = result.stdout.trim();
  return {
    behavior: 'continue',
    ...(feedback ? { feedback } : {}),
  };
};
