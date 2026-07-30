import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createAssistantGlobalTools,
  buildAssistantGlobalSystemPrompt,
  readAssistantConfig,
  writeAssistantConfig,
  listAssistantProjectBriefs,
  isAssistantScope,
} from '../src/manager/assistantGlobalTools.js';
import { rememberWorkspace } from '../src/gui/workspaceRegistry.js';
import { writeWorkspaceNote } from '../src/gui/workspaceNote.js';
import { writeProjectMeta } from '../src/gui/projectMeta.js';
import { addBridgeConfig } from '../src/parity/bridgeConfigs.js';
import type { AgentToolDefinition } from '../src/types.js';

let workDir: string;
let homeDir: string;
let otherProject: string;

beforeEach(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-work-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-home-'));
  otherProject = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-other-'));
  await rememberWorkspace(otherProject, homeDir);
  await writeWorkspaceNote(otherProject, homeDir, 'Other project brief');
  await writeProjectMeta(otherProject, homeDir, { status: 'in_progress' });
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(otherProject, { recursive: true, force: true });
});

async function callTool(tool: AgentToolDefinition, input: unknown = {}) {
  return (tool.execute as (i: unknown, c: unknown) => Promise<unknown>)(input, {});
}

describe('assistant global helpers', () => {
  it('recognizes AssistantScope values', () => {
    expect(isAssistantScope('global')).toBe(true);
    expect(isAssistantScope('project')).toBe(true);
    expect(isAssistantScope('other')).toBe(false);
  });

  it('persists assistant.json model/bridgeConfig', async () => {
    await writeAssistantConfig({
      model: 'gpt-test',
      bridgeConfig: 'demo',
      activeSessionId: 'global-session-2',
    }, homeDir);
    await expect(readAssistantConfig(homeDir)).resolves.toEqual({
      model: 'gpt-test',
      bridgeConfig: 'demo',
      activeSessionId: 'global-session-2',
    });
  });

  it('lists project briefs with notes and status', async () => {
    const briefs = await listAssistantProjectBriefs(homeDir, workDir);
    expect(briefs.some(item => path.resolve(item.path) === path.resolve(otherProject))).toBe(true);
    const other = briefs.find(item => path.resolve(item.path) === path.resolve(otherProject))!;
    expect(other.note).toContain('Other project brief');
    expect(other.status).toBe('in_progress');
  });
});

describe('createAssistantGlobalTools', () => {
  it('exposes overview + settings tools and never Write/Edit/Bash', async () => {
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
    });
    const names = tools.map(tool => tool.name);
    expect(names).toContain('ListProjects');
    expect(names).toContain('GetProjectOverview');
    expect(names).toContain('UpdateGuiPreferences');
    expect(names).toContain('UpdateRuntimeEnv');
    expect(names).toContain('UpsertBridgeConfig');
    expect(names).toContain('OpenProject');
    for (const forbidden of ['Bash', 'Write', 'Edit', 'Task', 'TeamAsk']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('ListProjects and GetProjectOverview return registered workspaces', async () => {
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
    });
    const list = await callTool(tools.find(tool => tool.name === 'ListProjects')!);
    expect(JSON.stringify(list)).toContain(JSON.stringify(otherProject).slice(1, -1));
    const overview = await callTool(tools.find(tool => tool.name === 'GetProjectOverview')!, {
      projectPath: otherProject,
    });
    expect(JSON.stringify(overview)).toContain('Other project brief');
    expect(JSON.stringify(overview)).toContain('in_progress');
  });

  it('rejects unknown projectPath', async () => {
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
    });
    const unknown = path.join(os.tmpdir(), `asst-unknown-${Date.now()}`);
    fs.mkdirSync(unknown);
    try {
      await expect(
        callTool(tools.find(tool => tool.name === 'GetProjectOverview')!, {
          projectPath: unknown,
        }),
      ).rejects.toThrow(/Unknown project path/i);
    } finally {
      fs.rmSync(unknown, { recursive: true, force: true });
    }
  });

  it('redacts bridge API keys in list/upsert results', async () => {
    addBridgeConfig({
      name: 'secret-bridge',
      runtime: 'hadamard',
      provider: 'anthropic',
      apiKey: 'sk-secret-should-not-leak',
      model: 'claude-test',
    }, homeDir);
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
    });
    const listed = await callTool(tools.find(tool => tool.name === 'ListBridgeConfigs')!);
    const listedText = JSON.stringify(listed);
    expect(listedText).toContain('secret-bridge');
    expect(listedText).toContain('"hasApiKey":true');
    expect(listedText).not.toContain('sk-secret-should-not-leak');

    const upserted = await callTool(tools.find(tool => tool.name === 'UpsertBridgeConfig')!, {
      name: 'secret-bridge-2',
      runtime: 'hadamard',
      provider: 'anthropic',
      apiKey: 'sk-another-secret',
      model: 'claude-test',
    });
    const upsertText = JSON.stringify(upserted);
    expect(upsertText).toContain('secret-bridge-2');
    expect(upsertText).not.toContain('sk-another-secret');
  });

  it('UpdateRuntimeEnv does not echo API keys', async () => {
    const patches: Record<string, unknown>[] = [];
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
      applySettings: async (patch) => {
        patches.push(patch);
        return { ok: true, detail: 'saved' };
      },
    });
    const result = await callTool(tools.find(tool => tool.name === 'UpdateRuntimeEnv')!, {
      defaultModel: 'demo-model',
      apiKey: 'sk-write-only',
    });
    expect(patches[0]).toMatchObject({ defaultModel: 'demo-model', apiKey: 'sk-write-only' });
    expect(JSON.stringify(result)).not.toContain('sk-write-only');
    expect(result).toMatchObject({ ok: true, apiKeySet: true });
  });

  it('builds a Global system prompt with hard rules', () => {
    const prompt = buildAssistantGlobalSystemPrompt(workDir);
    expect(prompt).toContain('Global scope');
    expect(prompt).toContain('ListProjects');
    expect(prompt).toMatch(/no Write\/Edit\/Bash/i);
  });
});
