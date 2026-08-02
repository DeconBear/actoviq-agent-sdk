import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveScheduledAutomationWorkflow } from '../src/scheduling/index.js';
import { saveTeamDefinition } from '../src/team/teamDefinitions.js';
import { saveWorkflow } from '../src/workflow/workflowPersistence.js';

describe('Automation workflow targets', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-automation-workflow-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('resolves new Automation tasks to Agent-page workflow squads', async () => {
    await saveTeamDefinition({
      name: 'daily-review',
      mode: 'graph',
      version: 3,
      orchestration: 'graph',
      squadType: 'workflow',
      members: [],
      nodes: [],
      edges: [],
      workflowTree: {
        id: 'review',
        type: 'agent',
        label: 'Review',
        prompt: 'Review {{input}}',
        children: [],
      },
    }, { projectDir: workDir });

    const target = resolveScheduledAutomationWorkflow({
      workflowName: 'daily-review',
      workflowSource: 'agent',
    }, workDir);

    expect(target.source).toBe('agent');
    if (target.source === 'agent') {
      expect(target.definition.squadType).toBe('workflow');
      expect(target.definition.workflowTree?.id).toBe('review');
    }
  });

  it('keeps unmarked historical tasks on the legacy script runtime', async () => {
    await saveWorkflow('legacy-review', 'return "legacy";', { projectDir: workDir });

    const target = resolveScheduledAutomationWorkflow({
      workflowName: 'legacy-review',
    }, workDir);

    expect(target.source).toBe('script');
    if (target.source === 'script') expect(target.workflow.script).toContain('legacy');
  });

  it('rejects a non-workflow Agent definition', async () => {
    await saveTeamDefinition({
      name: 'graph-only',
      mode: 'graph',
      version: 3,
      orchestration: 'graph',
      squadType: 'subagent',
      members: [],
      nodes: [],
      edges: [],
    }, { projectDir: workDir });

    expect(() => resolveScheduledAutomationWorkflow({
      workflowName: 'graph-only',
      workflowSource: 'agent',
    }, workDir)).toThrow('not an Agent workflow');
  });
});
