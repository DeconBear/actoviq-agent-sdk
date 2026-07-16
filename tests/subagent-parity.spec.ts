import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  clearLoadedJsonConfig,
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
  clearLoadedJsonConfig();
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
    const homeDir = await tempDirectory('actoviq-subagent-home-');
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
      homeDir,
      modelApi,
      effort: 'high',
    });

    try {
      const session = await sdk.createSession({ title: 'parent' });
      await session.send('Launch the review.');
      const task = (await sdk.tasks.list())[0];
      expect(task?.agentName).toBe('release-reviewer');
      const completedTask = await sdk.tasks.wait(task!.id);
      expect(completedTask.status).toBe('completed');
      expect(completedTask.text).toContain('Background review complete.');

      let deliveredNotification = false;
      for (const prompt of [
        'Continue after background work.',
        'Continue after background work again.',
      ]) {
        await session.send(prompt);
        deliveredNotification = modelApi.requests.some(request =>
          requestText(request).includes('<task_notification>') &&
          requestText(request).includes('Background review complete.'),
        );
        if (deliveredNotification) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }

      const parentRequest = modelApi.requests.find(request =>
        request.tools?.some(toolDefinition => toolDefinition.name === 'Agent'),
      );
      expect(parentRequest?.tools?.map(toolDefinition => toolDefinition.name)).toEqual(
        expect.arrayContaining(['Agent', 'Task', 'SendMessage']),
      );
      expect(deliveredNotification).toBe(true);
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
    const homeDir = await tempDirectory('actoviq-subagent-home-');
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
      homeDir,
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

  it('delivers and deduplicates SendMessage input across SDK clients', async () => {
    const sessionDirectory = await tempDirectory('actoviq-subagent-steer-');
    const homeDir = await tempDirectory('actoviq-subagent-steer-home-');
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
    const followUp = 'Inspect the second failure path before completing.';
    const modelApiA = new RecordingModelApi(request => {
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
    const modelApiB = new RecordingModelApi(() => {
      throw new Error('The sending SDK must not run the background agent.');
    });
    const sdkA = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      modelApi: modelApiA,
      tools: [waitGate],
      permissionMode: 'bypassPermissions',
    });
    let sdkB: Awaited<ReturnType<typeof createAgentSdk>> | undefined;

    try {
      const parent = await sdkA.createSession({ title: 'parent' });
      await parent.send('Launch the steerable debugger.');
      await gateStarted;
      sdkB = await createAgentSdk({
        model: 'test-model',
        sessionDirectory,
        homeDir,
        modelApi: modelApiB,
        permissionMode: 'bypassPermissions',
      });
      const sendMessage = sdkB.getTool('SendMessage')!;
      const toolContext = {
        runId: 'steering_parent',
        sessionId: parent.id,
        cwd: process.cwd(),
        metadata: {},
        prompt: 'Steer the running agent.',
        iteration: 1,
        toolUseId: 'toolu_cross_client_message',
      };
      const routed = await sendMessage.execute(
        {
          to: 'steerable-debugger',
          message: followUp,
        },
        toolContext,
      ) as { status: string; taskId: string };
      expect(routed.status).toBe('queued');
      await expect(sendMessage.execute(
        { to: routed.taskId, message: followUp },
        toolContext,
      )).resolves.toMatchObject({
        status: 'duplicate',
        taskStatus: 'running',
        taskId: routed.taskId,
        replayed: true,
      });
      await expect(sdkB.tasks.get(routed.taskId)).resolves.toMatchObject({
        queuedMessageCount: 1,
        queuedInputs: [
          expect.objectContaining({
            id: 'toolu_cross_client_message',
            text: followUp,
            edgeCallId: 'toolu_cross_client_message',
          }),
        ],
        seenInputIds: ['toolu_cross_client_message'],
      });
      releaseGate();
      const completed = await sdkA.tasks.wait(routed.taskId);
      expect(completed.text).toContain('Steering message observed');
      const deliveryRequests = modelApiA.requests.filter(request =>
        requestText(request).includes(followUp),
      );
      expect(deliveryRequests).toHaveLength(1);
      expect(requestText(deliveryRequests[0]!).split(followUp)).toHaveLength(2);
      expect(modelApiB.requests).toHaveLength(0);

      const taskIdsBeforeReplay = (await sdkA.tasks.list()).map(task => task.id).sort();
      await expect(sendMessage.execute(
        { to: routed.taskId, message: followUp },
        toolContext,
      )).resolves.toMatchObject({
        status: 'duplicate',
        taskId: routed.taskId,
        replayed: true,
      });
      expect((await sdkA.tasks.list()).map(task => task.id).sort()).toEqual(taskIdsBeforeReplay);
      expect(modelApiA.requests.filter(request =>
        requestText(request).includes(followUp),
      )).toHaveLength(1);
      const execution = await sdkA.executions.getSnapshot(parent.id);
      expect(execution?.edges.filter(edge =>
        edge.callId === 'toolu_cross_client_message',
      )).toHaveLength(1);
    } finally {
      releaseGate();
      await sdkB?.close();
      await sdkA.close();
    }
  });

  it('resumes a follow-up that races with background task settlement', async () => {
    const sessionDirectory = await tempDirectory('actoviq-subagent-settlement-race-');
    const homeDir = await tempDirectory('actoviq-subagent-settlement-home-');
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
        name: 'SettlementGate',
        description: 'Wait until the settlement race is released.',
        inputSchema: z.strictObject({}),
      },
      async () => {
        markGateStarted();
        await gate;
        return 'released';
      },
    );
    const followUp = 'Inspect the late settlement race.';
    let originalAgentCalls = 0;
    const modelApi = new RecordingModelApi(request => {
      const text = requestText(request);
      if (text.includes(followUp)) {
        return makeMessage([{ type: 'text', text: 'Late follow-up resumed safely.' }]);
      }
      originalAgentCalls += 1;
      if (originalAgentCalls === 1) {
        return makeMessage(
          [{
            type: 'tool_use',
            id: 'wait_for_settlement_race',
            name: 'SettlementGate',
            input: {},
          }],
          'tool_use',
        );
      }
      return makeMessage([{ type: 'text', text: 'Original background turn completed.' }]);
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      modelApi,
      tools: [waitGate],
      agents: [{
        name: 'settlement-debugger',
        description: 'Exercise the SendMessage settlement boundary.',
        systemPrompt: 'You are the settlement race subagent.',
      }],
      disableDefaultAgents: true,
      disableDefaultSkills: true,
      loadDefaultAgentDirectories: false,
      loadDefaultSkillDirectories: false,
      permissionMode: 'bypassPermissions',
    });

    try {
      const parent = await sdk.createSession({ title: 'settlement race parent' });
      const launched = await sdk.agents.launchBackground(
        'settlement-debugger',
        'Wait for the settlement boundary.',
        { parentRunId: 'settlement_parent', parentSessionId: parent.id },
      );
      await gateStarted;

      type BackgroundManagerProbe = {
        get(taskId: string): Promise<{ status: string } | undefined>;
        reserveInput(taskId: string, input: unknown): Promise<unknown>;
      };
      const manager = (sdk as unknown as { backgroundTaskManager: BackgroundManagerProbe })
        .backgroundTaskManager;
      const originalGet = manager.get.bind(manager);
      const originalReserveInput = manager.reserveInput.bind(manager);
      const reserveSpy = vi.spyOn(manager, 'reserveInput').mockImplementationOnce(
        async (taskId, input) => {
          releaseGate();
          const deadline = Date.now() + 5_000;
          while (true) {
            const current = await originalGet(taskId);
            if (
              current?.status === 'completed' ||
              current?.status === 'failed' ||
              current?.status === 'cancelled'
            ) {
              break;
            }
            if (Date.now() >= deadline) {
              throw new Error('Background task did not reach settlement in time.');
            }
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          return originalReserveInput(taskId, input);
        },
      );

      const sendMessage = sdk.getTool('SendMessage')!;
      const routed = await sendMessage.execute(
        { to: launched.sessionId!, message: followUp },
        {
          runId: 'settlement_message_parent',
          sessionId: parent.id,
          cwd: process.cwd(),
          metadata: {},
          prompt: followUp,
          iteration: 1,
          toolUseId: 'toolu_settlement_message',
        },
      ) as { status: string; taskId: string; agentId: string };
      reserveSpy.mockRestore();

      expect(routed).toMatchObject({
        status: 'resumed',
        agentId: launched.sessionId,
      });
      const resumed = await sdk.tasks.wait(routed.taskId, { timeoutMs: 5_000 });
      expect(resumed).toMatchObject({
        status: 'completed',
        text: expect.stringContaining('Late follow-up resumed safely.'),
      });
      expect(resumed.seenInputIds).toContain('toolu_settlement_message');
      expect(
        modelApi.requests.filter(request => requestText(request).includes(followUp)),
      ).toHaveLength(1);
      expect(
        (await sdk.tasks.list()).filter(task => task.resumedFromTaskId === launched.id),
      ).toHaveLength(1);
      const taskIdsBeforeReplay = (await sdk.tasks.list()).map(task => task.id).sort();
      await expect(sendMessage.execute(
        { to: launched.sessionId!, message: followUp },
        {
          runId: 'settlement_message_parent',
          sessionId: parent.id,
          cwd: process.cwd(),
          metadata: {},
          prompt: followUp,
          iteration: 1,
          toolUseId: 'toolu_settlement_message',
        },
      )).resolves.toMatchObject({
        status: 'duplicate',
        replayed: true,
      });
      expect((await sdk.tasks.list()).map(task => task.id).sort()).toEqual(taskIdsBeforeReplay);
      expect(
        modelApi.requests.filter(request => requestText(request).includes(followUp)),
      ).toHaveLength(1);
      const execution = await sdk.executions.getSnapshot(parent.id);
      expect(execution?.edges.filter(edge =>
        edge.callId === 'toolu_settlement_message',
      )).toHaveLength(1);
      expect(execution?.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          callId: 'toolu_settlement_message',
          kind: 'message',
          status: 'completed',
        }),
        expect.objectContaining({
          callId: 'toolu_settlement_message:resume',
          kind: 'resume',
          status: 'completed',
        }),
      ]));
    } finally {
      releaseGate();
      vi.restoreAllMocks();
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
      const parentEdit = await readFile(path.join(repository, 'agent.txt'), 'utf8')
        .catch(() => undefined);
      const diagnostic = `Agent tool output: ${JSON.stringify(output)}`;
      expect(parentEdit, diagnostic).toBeUndefined();
      expect(worktreePath, diagnostic).toBeTruthy();
      expect(await readFile(path.join(worktreePath!, 'agent.txt'), 'utf8')).toBe('isolated\n');
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
