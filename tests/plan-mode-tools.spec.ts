import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildPlanFileName,
  createPlanModeTools,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  formatPlanTimestamp,
  listPlanFiles,
  PLAN_CURRENT_POINTER,
  planFilePath,
  readPlanFile,
} from '../src/tools/planMode/PlanModeTools.js';
import type { HadamardPermissionMode } from '../src/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('plan mode tools', () => {
  it('enters read-only planning and persists the proposed plan for approval', async () => {
    const planDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-plan-mode-'));
    tempDirs.push(planDir);
    const modes: HadamardPermissionMode[] = [];
    const tools = createPlanModeTools('C:\\workspace', {
      planDir,
      onPlanModeChange: mode => { modes.push(mode); },
      now: () => new Date('2026-08-04T10:09:30.000Z'),
      createId: () => '11111111-2222-3333-4444-555555555555',
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
    expect(path.basename(result.planFile)).toBe(
      'plan-20260804T100930Z-11111111-2222-3333-4444-555555555555.md',
    );
    expect(await readFile(result.planFile, 'utf8')).toContain('Ask the user to approve');
    expect(await readFile(path.join(planDir, PLAN_CURRENT_POINTER), 'utf8')).toContain(
      'plan-20260804T100930Z-11111111-2222-3333-4444-555555555555.md',
    );
    expect(result).toMatchObject({
      status: 'awaiting_approval',
      approvalRequired: true,
      actions: ['approve', 'revise'],
    });
    expect(enter.isReadOnly?.({})).toBe(true);
    expect(exit.isReadOnly?.({ plan: 'x' })).toBe(true);
  });

  it('keeps each ExitPlanMode write as a distinct versioned file', async () => {
    const planDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-plan-hist-'));
    tempDirs.push(planDir);
    let n = 0;
    const tools = createPlanModeTools('C:\\workspace', {
      planDir,
      now: () => new Date(Date.UTC(2026, 7, 4, 10, 0, n)),
      createId: () => `00000000-0000-4000-8000-00000000000${n++}`,
    });
    const exit = tools.find(tool => tool.name === EXIT_PLAN_MODE_TOOL_NAME)!;

    await exit.execute({ plan: 'first' }, {} as never);
    await exit.execute({ plan: 'second' }, {} as never);

    const names = (await readdir(planDir)).filter(name => name.endsWith('.md')).sort();
    expect(names).toEqual([
      'plan-20260804T100000Z-00000000-0000-4000-8000-000000000000.md',
      'plan-20260804T100001Z-00000000-0000-4000-8000-000000000001.md',
    ]);
    expect(await readFile(path.join(planDir, names[0]!), 'utf8')).toBe('first');
    expect(await readFile(path.join(planDir, names[1]!), 'utf8')).toBe('second');
  });

  it('formats timestamps and file names for lexical ordering', () => {
    expect(formatPlanTimestamp(new Date('2026-08-04T10:09:30.456Z'))).toBe('20260804T100930Z');
    expect(buildPlanFileName({
      now: new Date('2026-08-04T10:09:30.456Z'),
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })).toBe('plan-20260804T100930Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.md');
  });
});

describe('plan file helpers with HADAMARD_HOME', () => {
  it('resolves the current plan via pointer and lists history', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'hadamard-home-'));
    tempDirs.push(home);
    const prev = process.env.HADAMARD_HOME;
    process.env.HADAMARD_HOME = home;
    try {
      const workDir = 'E:\\project_software\\hadamard';
      const projectKey = workDir.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40);
      const planDir = path.join(home, 'projects', projectKey);
      await mkdir(planDir, { recursive: true });
      const older = 'plan-20260101T000000Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.md';
      const newer = 'plan-20260804T120000Z-11111111-2222-3333-4444-555555555555.md';
      await writeFile(path.join(planDir, older), 'old plan', 'utf8');
      await writeFile(path.join(planDir, newer), 'new plan', 'utf8');
      await writeFile(path.join(planDir, PLAN_CURRENT_POINTER), `${newer}\n`, 'utf8');

      expect(planFilePath(workDir)).toBe(path.join(planDir, newer));
      expect(readPlanFile(workDir)).toBe('new plan');
      expect(listPlanFiles(workDir)).toEqual([
        path.join(planDir, older),
        path.join(planDir, newer),
      ]);
    } finally {
      if (prev === undefined) delete process.env.HADAMARD_HOME;
      else process.env.HADAMARD_HOME = prev;
    }
  });
});
