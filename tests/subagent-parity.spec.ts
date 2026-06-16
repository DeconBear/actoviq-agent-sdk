import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createActoviqCoreTools,
  createAgentSdk,
  tool,
  type ModelApi,
  type ModelRequest,
  type ModelStreamHandle,
} from '../src/index.js';
import type { Message, MessageStreamEvent } from '../src/provider/types.js';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
let messageId = 0;

beforeEach(() => {
  messageId = 0;
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })),
  );
});

function makeMessage(
  content: Message['content'],
  stopReason: 'end_turn' | 'tool_use' = 'end_turn',
): Message {
  messageId += 1;
  return {
    id: `subagent_msg_${messageId}`,
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 10,
      output_tokens: 5,
    },
  } as Message;
}

class NoStream implements ModelStreamHandle {
  finalMessage(): Promise<Message> {
    throw new Error('Streaming is not expected in this test.');
  }

  async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
    throw new Error('Streaming is not expected in this test.');
  }
}

class RecordingModelApi implements ModelApi {
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly respond: (request: ModelRequest, index: number) => Message,
  ) {}

  async createMessage(request: ModelRequest): Promise<Message> {
    this.requests.push(structuredClone(request));
    return this.respond(request, this.requests.length - 1);
  }

  streamMessage(): ModelStreamHandle {
    return new NoStream();
  }
}

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function requestText(request: ModelRequest): string {
  return JSON.stringify(request.messages);
}

const isCI = process.env.CI === 'true';

describe('Hadamard SDK subagent parity', () => {
  it.skipIf(isCI)('exposes Agent with Task compatibility and injects background completion notifications', async () => {
    const sessionDirectory = await tempDirectory('actoviq-subagent-notify-');
    const modelApi = new RecordingModelApi(request => {
      if (request.system?.includes('focused code-review subagent')) {
        return makeMessage([{ type: 'text', text: 'Background review complete.' }]);
      }
      const text = requestText(request);
      if (text.includes('<task_notification>')) {
        return makeMessage([{ type: 'text', text: 'Notification received.' }]);
      }
      if (text.includes('tool_result')) {
        return makeMessage([{ type: 'text', text: 'Review launched.' }]);
      }
      return makeMessage(
        [{
          type: 'tool_use',
          id: 'launch_background_review',
          name: 'Task',
          input: {
            description: 'Review release flow',
            prompt: 'Review the release flow and report the result.',
            subagent_type: 'code-reviewer',
            run_in_background: true,
            name: 'release-reviewer',
          },
        }],
        'tool_use',
      );
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      effort: 'high',
    });

    try {
      const session = await sdk.createSession({ title: 'parent' });
      await session.send('Launch the review.');
      const task = (await sdk.tasks.list())[0];
      expect(task?.agentName).toBe('release-reviewer');
      await sdk.tasks.wait(task!.id);
      await session.send('Continue after background work.');

      const parentRequest = modelApi.requests.find(request =>
        request.tools?.some(toolDefinition => toolDefinition.name === 'Agent'),
      );
      expect(parentRequest?.tools?.map(toolDefinition => toolDefinition.name)).toEqual(
        expect.arrayContaining(['Agent', 'Task', 'SendMessage']),
      );
      expect(modelApi.requests.some(request =>
        requestText(request).includes('<task_notification>') &&
        requestText(request).includes('Background review complete.'),
      )).toBe(true);
      const childRequest = modelApi.requests.find(request =>
        request.system?.includes('focused code-review subagent'),
      );
      expect(childRequest?.effort).toBe('high');
    } finally {
      await sdk.close();
    }
  });

  it.skipIf(isCI)('resumes a completed agent through SendMessage with session context preserved', async () => {
    const sessionDirectory = await tempDirectory('actoviq-subagent-resume-');
    const modelApi = new RecordingModelApi(request => {
      if (request.system?.includes('focused debugging subagent')) {
        return makeMessage([{
          type: 'text',
          text: requestText(request).includes('Check the follow-up')
            ? 'Follow-up complete.'
            : 'Initial debugging complete.',
        }]);
      }
      if (requestText(request).includes('tool_result')) {
        return makeMessage([{ type: 'text', text: 'Debugger launched.' }]);
      }
      return makeMessage(
        [{
          type: 'tool_use',
          id: 'launch_debugger',
          name: 'Agent',
          input: {
            description: 'Debug release issue',
            prompt: 'Inspect the initial failure.',
            subagent_type: 'debugger',
            run_in_background: true,
            name: 'release-debugger',
          },
        }],
        'tool_use',
      );
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
    });

    try {
      const parent = await sdk.createSession({ title: 'parent' });
      await parent.send('Launch the debugger.');
      const firstTask = (await sdk.tasks.list())[0]!;
      await sdk.tasks.wait(firstTask.id);

      const sendMessage = sdk.getTool('SendMessage');
      const routed = await sendMessage!.execute(
        {
          to: 'release-debugger',
          summary: 'Follow up',
          message: 'Check the follow-up and compare it with your initial result.',
        },
        {
          runId: 'parent_follow_up',
          sessionId: parent.id,
          cwd: process.cwd(),
          metadata: {},
          prompt: 'Continue the debugger.',
          iteration: 1,
        },
      ) as { status: string; taskId: string; agentId: string };
      expect(routed.status).toBe('resumed');
      expect(routed.agentId).toBe(firstTask.sessionId);
      const resumedTask = await sdk.tasks.wait(routed.taskId);
      expect(resumedTask.resumedFromTaskId).toBe(firstTask.id);
      expect(resumedTask.text).toContain('Follow-up complete');

      const followUpRequest = modelApi.requests.find(request =>
        request.system?.includes('focused debugging subagent') &&
        requestText(request).includes('Check the follow-up'),
      );
      expect(requestText(followUpRequest!)).toContain('Inspect the initial failure');
    } finally {
      await sdk.close();
    }
  });

  it('delivers SendMessage input to a running agent at the next tool boundary', async () => {
    const sessionDirectory = await tempDirectory('actoviq-subagent-steer-');
    let releaseGate!: () => void;
    let markGateStarted!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve;
    });
    const gateStarted = new Promise<void>(resolve => {
      markGateStarted = resolve;
    });
    const waitGate = tool(
      {
        name: 'WaitGate',
        description: 'Wait until the test releases the gate.',
        inputSchema: z.strictObject({}),
      },
      async () => {
        markGateStarted();
        await gate;
        return 'released';
      },
    );
    const modelApi = new RecordingModelApi(request => {
      if (request.system?.includes('focused debugging subagent')) {
        const text = requestText(request);
        if (text.includes('User message sent while you were working')) {
          return makeMessage([{ type: 'text', text: 'Steering message observed.' }]);
        }
        return makeMessage(
          [{
            type: 'tool_use',
            id: 'wait_for_steering',
            name: 'WaitGate',
            input: {},
          }],
          'tool_use',
        );
      }
      if (requestText(request).includes('tool_result')) {
        return makeMessage([{ type: 'text', text: 'Debugger is running.' }]);
      }
      return makeMessage(
        [{
          type: 'tool_use',
          id: 'launch_running_debugger',
          name: 'Agent',
          input: {
            description: 'Run steerable debugger',
            prompt: 'Wait for a follow-up instruction.',
            subagent_type: 'debugger',
            run_in_background: true,
            name: 'steerable-debugger',
          },
        }],
        'tool_use',
      );
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      modelApi,
      tools: [waitGate],
      permissionMode: 'bypassPermissions',
    });

    try {
      const parent = await sdk.createSession({ title: 'parent' });
      await parent.send('Launch the steerable debugger.');
      await gateStarted;
      const sendMessage = sdk.getTool('SendMessage')!;
      const routed = await sendMessage.execute(
        {
          to: 'steerable-debugger',
          message: 'Inspect the second failure path before completing.',
        },
        {
          runId: 'steering_parent',
          sessionId: parent.id,
          cwd: process.cwd(),
          metadata: {},
          prompt: 'Steer the running agent.',
          iteration: 1,
        },
      ) as { status: string; taskId: string };
      expect(routed.status).toBe('queued');
      releaseGate();
      const completed = await sdk.tasks.wait(routed.taskId);
      expect(completed.text).toContain('Steering message observed');
      expect(modelApi.requests.some(request =>
        requestText(request).includes('Inspect the second failure path'),
      )).toBe(true);
    } finally {
      releaseGate();
      await sdk.close();
    }
  });

  it('loads project agent Markdown definitions and applies tool boundaries', async () => {
    const root = await tempDirectory('actoviq-subagent-definitions-');
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'project');
    const sessionDirectory = path.join(root, 'sessions');
    await mkdir(path.join(workDir, '.actoviq', 'agents'), { recursive: true });
    await writeFile(
      path.join(workDir, '.actoviq', 'agents', 'auditor.md'),
      [
        '---',
        'name: auditor',
        'description: Audit code without nested delegation',
        'tools: Read, Grep, Glob',
        'disallowedTools: Write, Edit',
        'skills: release-checklist',
        'effort: high',
        'permissionMode: plan',
        'memory: project',
        '---',
        'You are a project audit specialist.',
      ].join('\n'),
      'utf8',
    );
    const modelApi = new RecordingModelApi(request =>
      makeMessage([{ type: 'text', text: request.system?.includes('project audit specialist')
        ? 'Audit complete.'
        : 'Main complete.' }]),
    );
    const sdk = await createAgentSdk({
      homeDir,
      workDir,
      sessionDirectory,
      model: 'test-model',
      modelApi,
      tools: createActoviqCoreTools({ cwd: workDir }),
    });

    try {
      expect(sdk.agents.get('auditor')).toMatchObject({
        source: 'project',
        allowedTools: ['Read', 'Grep', 'Glob'],
        disallowedTools: ['Write', 'Edit'],
        skills: ['release-checklist'],
        effort: 'high',
        permissionMode: 'plan',
        memory: 'project',
      });
      await sdk.runWithAgent('auditor', 'Audit the project.');
      const childRequest = modelApi.requests.find(request =>
        request.system?.includes('project audit specialist'),
      )!;
      expect(childRequest.tools?.map(toolDefinition => toolDefinition.name)).toEqual(
        expect.arrayContaining(['Read', 'Grep', 'Glob']),
      );
      expect(childRequest.tools?.map(toolDefinition => toolDefinition.name)).not.toEqual(
        expect.arrayContaining(['Agent', 'Task', 'Write', 'Edit']),
      );
      expect(childRequest.effort).toBe('high');
    } finally {
      await sdk.close();
    }
  });

  it('runs editing agents in retained worktrees without changing the parent checkout', async () => {
    const root = await tempDirectory('actoviq-subagent-worktree-');
    const repository = path.join(root, 'repository');
    const sessionDirectory = path.join(root, 'sessions');
    await mkdir(repository, { recursive: true });
    await writeFile(path.join(repository, 'base.txt'), 'base\n', 'utf8');
    await execFile('git', ['init'], { cwd: repository, windowsHide: true });
    await execFile('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repository,
      windowsHide: true,
    });
    await execFile('git', ['config', 'user.name', 'Test User'], {
      cwd: repository,
      windowsHide: true,
    });
    await execFile('git', ['add', '.'], { cwd: repository, windowsHide: true });
    await execFile('git', ['commit', '-m', 'initial'], {
      cwd: repository,
      windowsHide: true,
    });

    const modelApi = new RecordingModelApi(request => {
      if (request.system?.includes('general-purpose Actoviq subagent')) {
        const text = requestText(request);
        if (text.includes('tool_result')) {
          return makeMessage([{ type: 'text', text: 'Isolated edit complete.' }]);
        }
        return makeMessage(
          [{
            type: 'tool_use',
            id: 'write_isolated_file',
            name: 'Bash',
            input: {
              command: 'node -e "require(\'fs\').writeFileSync(\'agent.txt\', \'isolated\\n\')"',
              description: 'Write isolated marker',
            },
          }],
          'tool_use',
        );
      }
      if (requestText(request).includes('tool_result')) {
        return makeMessage([{ type: 'text', text: 'Delegation complete.' }]);
      }
      return makeMessage(
        [{
          type: 'tool_use',
          id: 'launch_isolated_agent',
          name: 'Agent',
          input: {
            description: 'Make isolated edit',
            prompt: 'Create agent.txt in your current working directory.',
            subagent_type: 'general-purpose',
            isolation: 'worktree',
          },
        }],
        'tool_use',
      );
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      workDir: repository,
      sessionDirectory,
      modelApi,
      tools: createActoviqCoreTools({ cwd: repository }),
      permissionMode: 'bypassPermissions',
    });

    let worktreePath: string | undefined;
    try {
      const result = await sdk.run('Delegate the isolated edit.');
      const agentCall = result.toolCalls.find(call => call.publicName === 'Agent');
      const output = agentCall?.output as { worktreePath?: string };
      worktreePath = output.worktreePath;
      expect(worktreePath).toBeTruthy();
      expect(await readFile(path.join(worktreePath!, 'agent.txt'), 'utf8')).toBe('isolated\n');
      await expect(readFile(path.join(repository, 'agent.txt'), 'utf8')).rejects.toThrow();
    } finally {
      await sdk.close();
      if (worktreePath) {
        await execFile('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: repository,
          windowsHide: true,
        }).catch(() => undefined);
      }
    }
  });
});
