import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';
import { saveTeamDefinition } from '../src/team/teamDefinitions.js';
import { saveWorkflow } from '../src/workflow/workflowPersistence.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('GUI Automation workflow API', () => {
  it('accepts Agent workflows, rejects other Agent definitions, and preserves legacy scripts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-gui-automation-'));
    tempDirs.push(root);
    const workDir = path.join(root, 'work');
    const homeDir = path.join(root, 'home');
    await mkdir(workDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
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
    await saveWorkflow('legacy-review', 'return "legacy";', { projectDir: workDir });

    const server = await startHadamardGuiServer({
      workDir,
      homeDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });
    const create = async (body: Record<string, unknown>) => {
      const response = await fetch(new URL('api/scheduled-tasks', server.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hadamard-token': server.token,
        },
        body: JSON.stringify({ kind: 'workflow', cron: '0 9 * * *', ...body }),
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };

    try {
      const created = await create({ workflowName: 'daily-review', workflowSource: 'agent' });
      expect(created.status).toBe(200);
      expect(created.body.task).toMatchObject({
        workflowName: 'daily-review',
        workflowSource: 'agent',
      });

      const rejected = await create({ workflowName: 'panel-analysis', workflowSource: 'agent' });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toContain('not an Agent workflow');

      const legacy = await create({ workflowName: 'legacy-review' });
      expect(legacy.status).toBe(200);
      expect(legacy.body.task.workflowSource).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
