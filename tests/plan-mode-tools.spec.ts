import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createPlanModeTools,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from '../src/tools/planMode/PlanModeTools.js';
import type { ActoviqPermissionMode } from '../src/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('plan mode tools', () => {
  it('enters read-only planning and persists the proposed plan for approval', async () => {
    const planDir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-plan-mode-'));
    tempDirs.push(planDir);
    const modes: ActoviqPermissionMode[] = [];
    const tools = createPlanModeTools('C:\\workspace', {
      planDir,
      onPlanModeChange: mode => { modes.push(mode); },
    });
    const enter = tools.find(tool => tool.name === ENTER_PLAN_MODE_TOOL_NAME)!;
    const exit = tools.find(tool => tool.name === EXIT_PLAN_MODE_TOOL_NAME)!;

    await enter.execute({}, {} as never);
    const result = await exit.execute({
      plan: '1. Inspect the runtime.\n2. Ask the user to approve implementation.',
    }, {} as never) as {
      planFile: string;
      status: string;
      approvalRequired: boolean;
      actions: string[];
    };

    expect(modes).toEqual(['plan']);
    expect(await readFile(result.planFile, 'utf8')).toContain('Ask the user to approve');
    expect(result).toMatchObject({
      status: 'awaiting_approval',
      approvalRequired: true,
      actions: ['approve', 'revise'],
    });
    expect(enter.isReadOnly?.({})).toBe(true);
    expect(exit.isReadOnly?.({ plan: 'x' })).toBe(true);
  });
});
