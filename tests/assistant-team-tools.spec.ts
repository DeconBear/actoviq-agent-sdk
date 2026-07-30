import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rememberWorkspace } from '../src/gui/workspaceRegistry.js';
import { createAssistantTeamTools } from '../src/team/assistantTeamTools.js';
import { TeamProposalStore } from '../src/team/teamProposalService.js';
import type { AgentToolDefinition, TeamDefinition } from '../src/types.js';

let projectDir: string;
let otherProject: string;
let homeDir: string;

function definition(): TeamDefinition {
  return {
    name: 'assistant-team',
    mode: 'graph',
    version: 3,
    orchestration: 'graph',
    members: [],
    nodes: [
      { kind: 'task', id: 'task' },
      { kind: 'agent', id: 'worker', model: 'model-a' },
      { kind: 'return', id: 'return', returnMode: 'payload' },
    ],
    edges: [
      { from: 'task', to: 'worker' },
      { from: 'worker', to: 'return' },
    ],
  };
}

async function callTool(tool: AgentToolDefinition, input: unknown) {
  return (tool.execute as (value: unknown, context: unknown) => Promise<unknown>)(input, {});
}

beforeEach(async () => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-team-project-'));
  otherProject = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-team-other-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-team-home-'));
  await rememberWorkspace(otherProject, homeDir);
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(otherProject, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('Assistant Team tools', () => {
  it('requires an explicit registered project for Global Assistant', async () => {
    const tools = createAssistantTeamTools({
      scope: 'global',
      assistantSessionId: 'global-1',
      currentWorkDir: projectDir,
      homeDir,
      proposals: new TeamProposalStore(),
    });
    const propose = tools.find(item => item.name === 'ProposeTeamGraph')!;
    await expect(callTool(propose, {
      definition: definition(),
      explanation: '',
    })).rejects.toThrow(/explicit projectPath/i);
    await expect(callTool(propose, {
      projectPath: path.join(homeDir, 'unknown'),
      definition: definition(),
      explanation: '',
    })).rejects.toThrow(/Unknown project path/i);
  });

  it('stages a structured proposal for a registered Global project', async () => {
    const proposals = new TeamProposalStore();
    const tools = createAssistantTeamTools({
      scope: 'global',
      assistantSessionId: 'global-1',
      currentWorkDir: projectDir,
      homeDir,
      proposals,
    });
    const result = await callTool(tools.find(item => item.name === 'ProposeTeamGraph')!, {
      projectPath: otherProject,
      definition: definition(),
      explanation: 'Create a worker Team.',
    }) as { kind: string; proposalId: string };
    expect(result.kind).toBe('team.proposal');
    expect(proposals.get(result.proposalId)?.projectPath).toBe(path.resolve(otherProject));
  });

  it('locks Project Manager to its current project', async () => {
    const proposals = new TeamProposalStore();
    const tools = createAssistantTeamTools({
      scope: 'project',
      assistantSessionId: 'manager-1',
      currentWorkDir: projectDir,
      homeDir,
      proposals,
    });
    const propose = tools.find(item => item.name === 'ProposeTeamGraph')!;
    await expect(callTool(propose, {
      projectPath: otherProject,
      definition: definition(),
      explanation: '',
    })).rejects.toThrow(/current project/i);
    const result = await callTool(propose, {
      definition: definition(),
      explanation: '',
    }) as { proposalId: string };
    expect(proposals.get(result.proposalId)?.projectPath).toBe(path.resolve(projectDir));
  });
});
