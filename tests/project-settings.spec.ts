import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_PROJECT_SETTINGS,
  appendProjectSettingsToPrompt,
  projectSettingsPath,
  readProjectSettings,
  writeProjectSettings,
} from '../src/gui/projectSettings.js';

describe('projectSettings', () => {
  let homeDir = '';
  let workDir = '';

  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    homeDir = '';
    workDir = '';
  });

  it('defaults to coding with empty prompts', async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ps-home-'));
    workDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ps-work-'));
    await expect(readProjectSettings(workDir, homeDir)).resolves.toEqual({
      ...DEFAULT_PROJECT_SETTINGS,
    });
  });

  it('persists workMode, customPrompt, and projectRules', async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ps-home-'));
    workDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ps-work-'));
    const saved = await writeProjectSettings(workDir, homeDir, {
      workMode: 'daily',
      customPrompt: 'Be brief',
      projectRules: 'No drive-by refactors',
    });
    expect(saved.workMode).toBe('daily');
    expect(saved.customPrompt).toBe('Be brief');
    expect(saved.projectRules).toBe('No drive-by refactors');
    expect(saved.updatedAt).toBeTruthy();

    const raw = JSON.parse(await readFile(projectSettingsPath(workDir, homeDir), 'utf8'));
    expect(raw.workMode).toBe('daily');
    await expect(readProjectSettings(workDir, homeDir)).resolves.toMatchObject({
      workMode: 'daily',
      customPrompt: 'Be brief',
      projectRules: 'No drive-by refactors',
    });
  });

  it('appends custom instructions and project rules sections', () => {
    const out = appendProjectSettingsToPrompt('BASE', {
      workMode: 'coding',
      customPrompt: '  Custom  ',
      projectRules: 'Rules\nline2',
    });
    expect(out).toContain('BASE');
    expect(out).toContain('# Custom instructions');
    expect(out).toContain('Custom');
    expect(out).toContain('# Project rules');
    expect(out).toContain('Rules\nline2');
  });

  it('skips empty prompt sections', () => {
    expect(appendProjectSettingsToPrompt('BASE', DEFAULT_PROJECT_SETTINGS)).toBe('BASE');
  });

  it('persists durable Memory settings', async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ps-home-'));
    workDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ps-work-'));
    const saved = await writeProjectSettings(workDir, homeDir, {
      memory: {
        durableMemory: {
          use: true,
          autoDream: true,
          dreamExecutionProfile: { kind: 'agent', name: 'memory-agent' },
          dailyDreamTimeLocal: '4:05',
          lastScheduledDreamDate: '2026-08-04',
        },
      },
    });
    expect(saved.memory.durableMemory).toMatchObject({
      use: true,
      autoDream: true,
      dreamExecutionProfile: { kind: 'agent', name: 'memory-agent' },
      dailyDreamTimeLocal: '04:05',
      lastScheduledDreamDate: '2026-08-04',
    });
  });

  it('requires a project Dream profile before autoDream can be enabled', async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ps-home-'));
    workDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ps-work-'));
    await expect(writeProjectSettings(workDir, homeDir, {
      memory: { durableMemory: { autoDream: true } },
    })).rejects.toThrow(/Select a Dream config or agent/u);
  });
});
