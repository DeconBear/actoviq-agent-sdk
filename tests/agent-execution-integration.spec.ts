import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HADAMARD_AGENT_PATH_KEY,
  HADAMARD_EXECUTION_ID_KEY,
  HADAMARD_PARENT_EXECUTION_ID_KEY,
  HADAMARD_ROOT_EXECUTION_ID_KEY,
  AgentExecutionStore,
  SessionStore,
  clearLoadedJsonConfig,
  createAgentSdk,
  createTodoWriteTool,
  type AgentEvent,
  type ModelApi,
  type ModelRequest,
  type ModelStreamHandle,
} from '../src/index.js';
import type { Message, MessageStreamEvent } from '../src/provider/types.js';
import type {
  HadamardBackgroundTaskManager,
  ReserveHadamardBackgroundTaskInputResult,
} from '../src/runtime/hadamardBackgroundTasks.js';

const tempDirs: string[] = [];
let messageId = 0;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

beforeEach(() => {
  messageId = 0;
  clearLoadedJsonConfig();
});

afterEach(async () => {
  clearLoadedJsonConfig();
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
    id: `agent_execution_message_${messageId}`,
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

class ScriptedStream implements ModelStreamHandle {
  constructor(
    private readonly events: MessageStreamEvent[],
    private readonly message: Message,
  ) {}

  async finalMessage(): Promise<Message> {
    return this.message;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
    for (const event of this.events) {
      yield event;
    }
  }
}

class ScriptedModelApi implements ModelApi {
  readonly createCalls: ModelRequest[] = [];
  readonly streamCalls: ModelRequest[] = [];

  constructor(
    private readonly createResponse: (request: ModelRequest, index: number) => Message,
    private readonly streamResponse?: (
      request: ModelRequest,
      index: number,
    ) => { events: MessageStreamEvent[]; message: Message },
  ) {}

  async createMessage(request: ModelRequest): Promise<Message> {
    this.createCalls.push(structuredClone(request));
    return this.createResponse(request, this.createCalls.length - 1);
  }

  streamMessage(request: ModelRequest): ModelStreamHandle {
    this.streamCalls.push(structuredClone(request));
    if (!this.streamResponse) {
      throw new Error('Unexpected streamMessage call.');
    }
    const response = this.streamResponse(request, this.streamCalls.length - 1);
    return new ScriptedStream(response.events, response.message);
  }
}

async function createFixture(prefix: string): Promise<{
  root: string;
  homeDir: string;
  workDir: string;
  sessionDirectory: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  const homeDir = path.join(root, 'home');
  const workDir = path.join(root, 'work');
  const sessionDirectory = path.join(root, 'sessions');
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  return { root, homeDir, workDir, sessionDirectory };
}

function requestText(request: ModelRequest): string {
  return JSON.stringify(request.messages);
}

describe('Hadamard Agent execution integration', () => {
  it('persists a foreground Task as a root/child graph with an independent child conversation', async () => {
    const fixture = await createFixture('hadamard-agent-execution-foreground-');
    const childPrompt = 'Inspect execution persistence and report one concise finding.';
    const childReply = 'Child review complete: execution state is persisted.';
    const modelApi = new ScriptedModelApi(
      request => {
        if (request.system?.includes('execution integration reviewer')) {
          return makeMessage([{ type: 'text', text: childReply }]);
        }
        throw new Error(`Unexpected non-stream request: ${requestText(request)}`);
      },
      (_request, index) => {
        if (index === 0) {
          return {
            events: [],
            message: makeMessage(
              [{
                type: 'tool_use',
                id: 'toolu_execution_delegate',
                name: 'Task',
                input: {
                  description: 'Inspect execution persistence',
                  prompt: childPrompt,
                  subagent_type: 'execution-reviewer',
                  name: 'persistence-reviewer',
                },
              }],
              'tool_use',
            ),
          };
        }
        return {
          events: [{
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Parent received the delegated review.' },
          } as MessageStreamEvent],
          message: makeMessage([{
            type: 'text',
            text: 'Parent received the delegated review.',
          }]),
        };
      },
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      homeDir: fixture.homeDir,
      workDir: fixture.workDir,
      sessionDirectory: fixture.sessionDirectory,
      modelApi,
      agents: [{
        name: 'execution-reviewer',
        description: 'Review deterministic execution integration state.',
        systemPrompt: 'You are the execution integration reviewer.',
      }],
      disableDefaultAgents: true,
      disableDefaultSkills: true,
      loadDefaultAgentDirectories: false,
      loadDefaultSkillDirectories: false,
      permissionMode: 'bypassPermissions',
    });

    try {
      const parent = await sdk.createSession({ title: 'Execution graph parent', kind: 'main' });
      const stream = parent.stream('Delegate the execution persistence review.');
      const streamedEvents: AgentEvent[] = [];
      for await (const event of stream) {
        streamedEvents.push(event);
      }
      const result = await stream.result;

      expect(result.executionId).toBe(parent.id);
      expect(result.executionNodeId).toBe(parent.id);
      expect(result.text).toBe('Parent received the delegated review.');

      const executionEvents = streamedEvents.filter(
        (event): event is Extract<AgentEvent, { type: 'agent.execution' }> =>
          event.type === 'agent.execution',
      );
      expect(executionEvents.length).toBeGreaterThan(0);
      expect(executionEvents.map(event => event.event.type)).toEqual(
        expect.arrayContaining([
          'thread.started',
          'turn.started',
          'edge.started',
          'turn.completed',
          'edge.completed',
        ]),
      );
      expect(executionEvents.some(event =>
        event.event.type === 'thread.started' &&
        event.event.parentExecutionId === parent.id &&
        event.event.agentName === 'execution-reviewer',
      )).toBe(true);

      const persisted = await new AgentExecutionStore(fixture.sessionDirectory)
        .getSnapshot(parent.id);
      expect(persisted).toBeDefined();
      expect(persisted?.nodes).toHaveLength(2);
      const rootNode = persisted?.nodes.find(node => node.id === parent.id);
      const childNode = persisted?.nodes.find(node => node.parentExecutionId === parent.id);
      expect(rootNode).toMatchObject({
        sessionId: parent.id,
        kind: 'root',
        canonicalPath: '/root',
        agentStatus: 'completed',
      });
      expect(childNode).toMatchObject({
        kind: 'subagent',
        parentExecutionId: parent.id,
        parentSessionId: parent.id,
        agentName: 'execution-reviewer',
        nickname: 'persistence-reviewer',
        agentStatus: 'completed',
      });
      expect(childNode?.sessionId).not.toBe(parent.id);
      expect(persisted?.edges).toEqual([
        expect.objectContaining({
          callId: 'toolu_execution_delegate',
          kind: 'delegate',
          status: 'completed',
          sourceExecutionId: parent.id,
          targetExecutionId: childNode?.id,
          sourceSessionId: parent.id,
          targetSessionId: childNode?.sessionId,
        }),
      ]);

      const sessionStore = new SessionStore(fixture.sessionDirectory);
      const [storedParent, storedChild] = await Promise.all([
        sessionStore.load(parent.id),
        sessionStore.load(childNode!.sessionId),
      ]);
      expect(storedParent).toMatchObject({ id: parent.id, kind: 'main' });
      expect(storedChild).toMatchObject({
        id: childNode?.sessionId,
        kind: 'agent',
        parentSessionId: parent.id,
      });
      expect(storedChild.runs).toHaveLength(1);
      expect(JSON.stringify(storedChild.messages)).toContain(childPrompt);
      expect(JSON.stringify(storedChild.messages)).toContain(childReply);
    } finally {
      await sdk.close();
    }
  });

  it('projects TodoWrite output into the current and future execution plan', async () => {
    const fixture = await createFixture('hadamard-agent-execution-plan-');
    const modelApi = new ScriptedModelApi((request, index) => {
      if (index === 0) {
        return makeMessage(
          [{
            type: 'tool_use',
            id: 'toolu_execution_plan',
            name: 'TodoWrite',
            input: {
              todos: [
                {
                  content: 'Inspect execution events',
                  status: 'completed',
                  activeForm: 'Inspecting execution events',
                },
                {
                  content: 'Implement the execution panel',
                  status: 'in_progress',
                  activeForm: 'Implementing the execution panel',
                },
                {
                  content: 'Run visual verification',
                  status: 'pending',
                  activeForm: 'Running visual verification',
                },
              ],
            },
          }],
          'tool_use',
        );
      }
      expect(requestText(request)).toContain('Todos have been modified successfully');
      return makeMessage([{ type: 'text', text: 'Plan recorded.' }]);
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      homeDir: fixture.homeDir,
      workDir: fixture.workDir,
      sessionDirectory: fixture.sessionDirectory,
      modelApi,
      tools: [createTodoWriteTool()],
      disableDefaultAgents: true,
      disableDefaultSkills: true,
      loadDefaultAgentDirectories: false,
      loadDefaultSkillDirectories: false,
      permissionMode: 'bypassPermissions',
    });

    try {
      const result = await sdk.run('Track the Agent execution view work.');
      expect(result.executionId).toBeTruthy();

      const persisted = await new AgentExecutionStore(fixture.sessionDirectory)
        .getSnapshot(result.executionId!);
      expect(persisted?.nodes).toHaveLength(1);
      expect(persisted?.nodes[0]?.currentPlan).toEqual([
        expect.objectContaining({
          title: 'Inspect execution events',
          status: 'completed',
          description: 'Inspecting execution events',
        }),
        expect.objectContaining({
          title: 'Implement the execution panel',
          status: 'in_progress',
          description: 'Implementing the execution panel',
        }),
        expect.objectContaining({
          title: 'Run visual verification',
          status: 'pending',
          description: 'Running visual verification',
        }),
      ]);
      expect(persisted?.events).toContainEqual(expect.objectContaining({
        type: 'plan.updated',
        executionId: result.executionNodeId,
      }));
      expect(await sdk.executions.getTree(result.executionId!)).toMatchObject({
        rootExecutionId: result.executionId,
        nodeCount: 1,
        edgeCount: 0,
        root: {
          node: {
            id: result.executionNodeId,
            agentStatus: 'completed',
          },
        },
      });
    } finally {
      await sdk.close();
    }
  });

  it('keeps one stable execution node when a completed background agent is resumed', async () => {
    const fixture = await createFixture('hadamard-agent-execution-resume-');
    const firstPrompt = 'Inspect the first background execution state.';
    const followUpPrompt = 'Re-check the same execution state after the follow-up.';
    const modelApi = new ScriptedModelApi(request => {
      expect(request.system).toContain('stable background execution reviewer');
      const text = requestText(request);
      if (text.includes(followUpPrompt)) {
        expect(text).toContain(firstPrompt);
        return makeMessage([{ type: 'text', text: 'Follow-up review complete.' }]);
      }
      expect(text).toContain(firstPrompt);
      return makeMessage([{ type: 'text', text: 'Initial background review complete.' }]);
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      homeDir: fixture.homeDir,
      workDir: fixture.workDir,
      sessionDirectory: fixture.sessionDirectory,
      modelApi,
      agents: [{
        name: 'background-reviewer',
        description: 'Review background execution state.',
        systemPrompt: 'You are the stable background execution reviewer.',
      }],
      disableDefaultAgents: true,
      disableDefaultSkills: true,
      loadDefaultAgentDirectories: false,
      loadDefaultSkillDirectories: false,
      permissionMode: 'bypassPermissions',
    });

    try {
      const parent = await sdk.createSession({ title: 'Background execution parent', kind: 'main' });
      const launched = await sdk.agents.launchBackground(
        'background-reviewer',
        firstPrompt,
        { parentRunId: 'background-parent-run', parentSessionId: parent.id },
      );
      const firstTask = await sdk.tasks.wait(launched.id, { timeoutMs: 5_000 });
      expect(firstTask).toMatchObject({
        status: 'completed',
        sessionId: expect.any(String),
        executionId: parent.id,
        executionNodeId: expect.any(String),
      });

      const firstSnapshot = await sdk.executions.getSnapshot(parent.id);
      const firstChild = firstSnapshot?.nodes.find(node => node.parentExecutionId === parent.id);
      expect(firstSnapshot?.nodes).toHaveLength(2);
      expect(firstChild).toMatchObject({
        id: firstTask.executionNodeId,
        sessionId: firstTask.sessionId,
        runIds: [firstTask.runId],
        agentStatus: 'completed',
      });

      const sendMessage = sdk.getTool('SendMessage');
      expect(sendMessage).toBeDefined();
      const routed = await sendMessage!.execute(
        { to: firstTask.sessionId!, message: followUpPrompt, summary: 'Re-check state' },
        {
          runId: 'background-parent-follow-up',
          sessionId: parent.id,
          cwd: fixture.workDir,
          prompt: followUpPrompt,
          iteration: 1,
          toolUseId: 'toolu_execution_resume',
          metadata: {
            [HADAMARD_EXECUTION_ID_KEY]: parent.id,
            [HADAMARD_ROOT_EXECUTION_ID_KEY]: parent.id,
            [HADAMARD_AGENT_PATH_KEY]: '/root',
          },
          permissionMode: 'bypassPermissions',
        },
      ) as { status: string; taskId: string; agentId: string };
      expect(routed).toMatchObject({
        status: 'resumed',
        agentId: firstTask.sessionId,
      });
      const resumedTask = await sdk.tasks.wait(routed.taskId, { timeoutMs: 5_000 });
      expect(resumedTask).toMatchObject({
        status: 'completed',
        sessionId: firstTask.sessionId,
        executionId: parent.id,
        executionNodeId: firstTask.executionNodeId,
        resumedFromTaskId: firstTask.id,
        seenInputIds: ['toolu_execution_resume'],
      });

      const resumedSnapshot = await new AgentExecutionStore(fixture.sessionDirectory)
        .getSnapshot(parent.id);
      expect(resumedSnapshot?.nodes).toHaveLength(2);
      const resumedChild = resumedSnapshot?.nodes.find(node => node.id === firstChild?.id);
      expect(resumedChild?.runIds).toEqual([firstTask.runId, resumedTask.runId]);
      expect(resumedSnapshot?.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'delegate',
          status: 'completed',
          targetExecutionId: firstChild?.id,
        }),
        expect.objectContaining({
          callId: 'toolu_execution_resume',
          kind: 'message',
          status: 'completed',
          targetExecutionId: firstChild?.id,
        }),
        expect.objectContaining({
          callId: 'toolu_execution_resume:resume',
          kind: 'resume',
          status: 'completed',
          targetExecutionId: firstChild?.id,
        }),
      ]));

      const storedChild = await new SessionStore(fixture.sessionDirectory).load(firstTask.sessionId!);
      expect(storedChild).toMatchObject({
        kind: 'agent',
        parentSessionId: parent.id,
      });
      expect(storedChild.runs).toHaveLength(2);
      expect(JSON.stringify(storedChild.messages)).toContain(firstPrompt);
      expect(JSON.stringify(storedChild.messages)).toContain(followUpPrompt);
      expect(JSON.stringify(storedChild.messages)).toContain('Follow-up review complete.');
    } finally {
      await sdk.close();
    }
  });

  it('serializes concurrent cross-client resumes of one completed background agent', async () => {
    const fixture = await createFixture('hadamard-agent-execution-concurrent-resume-');
    const initialPrompt = 'Complete the initial background review.';
    const followUpB = 'Continue the background review from client B.';
    const followUpC = 'Continue the background review from client C.';
    const firstFollowUpStarted = deferred<void>();
    const releaseFirstFollowUp = deferred<void>();
    let followUpRequestCount = 0;
    let activeFollowUpRequests = 0;
    let maxActiveFollowUpRequests = 0;
    const modelApi: ModelApi = {
      async createMessage(request) {
        const text = requestText(request);
        if (!text.includes(followUpB) && !text.includes(followUpC)) {
          expect(text).toContain(initialPrompt);
          return makeMessage([{ type: 'text', text: 'Initial background review complete.' }]);
        }

        followUpRequestCount += 1;
        const requestNumber = followUpRequestCount;
        activeFollowUpRequests += 1;
        maxActiveFollowUpRequests = Math.max(
          maxActiveFollowUpRequests,
          activeFollowUpRequests,
        );
        if (requestNumber === 1) {
          firstFollowUpStarted.resolve(undefined);
        }
        try {
          if (requestNumber === 1) {
            await releaseFirstFollowUp.promise;
          }
          return makeMessage([{
            type: 'text',
            text: `Concurrent follow-up ${requestNumber} complete.`,
          }]);
        } finally {
          activeFollowUpRequests -= 1;
        }
      },
      streamMessage() {
        throw new Error('Unexpected streamMessage call.');
      },
    };
    const sdkOptions = {
      model: 'test-model',
      homeDir: fixture.homeDir,
      workDir: fixture.workDir,
      sessionDirectory: fixture.sessionDirectory,
      modelApi,
      agents: [{
        name: 'concurrent-reviewer',
        description: 'Review concurrent background resume behavior.',
        systemPrompt: 'You are the concurrent background execution reviewer.',
      }],
      disableDefaultAgents: true,
      disableDefaultSkills: true,
      loadDefaultAgentDirectories: false,
      loadDefaultSkillDirectories: false,
      permissionMode: 'bypassPermissions' as const,
    };
    const sdkA = await createAgentSdk(sdkOptions);
    let sdkB: Awaited<ReturnType<typeof createAgentSdk>> | undefined;
    let sdkC: Awaited<ReturnType<typeof createAgentSdk>> | undefined;
    const bothReservationsReady = deferred<void>();

    try {
      const parent = await sdkA.createSession({
        title: 'Concurrent background execution parent',
        kind: 'main',
      });
      const launched = await sdkA.agents.launchBackground(
        'concurrent-reviewer',
        initialPrompt,
        { parentRunId: 'concurrent-background-parent', parentSessionId: parent.id },
      );
      const initialTask = await sdkA.tasks.wait(launched.id, { timeoutMs: 5_000 });
      expect(initialTask).toMatchObject({
        status: 'completed',
        sessionId: expect.any(String),
        executionId: parent.id,
      });

      sdkB = await createAgentSdk(sdkOptions);
      sdkC = await createAgentSdk(sdkOptions);
      let reservationCount = 0;
      for (const sdk of [sdkB, sdkC]) {
        const manager = (
          sdk as unknown as { backgroundTaskManager: HadamardBackgroundTaskManager }
        ).backgroundTaskManager;
        const reserveInput = manager.reserveInput.bind(manager);
        vi.spyOn(manager, 'reserveInput').mockImplementation(
          async (...args): Promise<ReserveHadamardBackgroundTaskInputResult> => {
            const reservation = await reserveInput(...args);
            reservationCount += 1;
            if (reservationCount === 2) {
              bothReservationsReady.resolve(undefined);
            }
            await Promise.race([
              bothReservationsReady.promise,
              delay(2_000).then(() => {
                throw new Error('Timed out waiting for both terminal-task reservations.');
              }),
            ]);
            return reservation;
          },
        );
      }

      const sendMessageB = sdkB.getTool('SendMessage');
      const sendMessageC = sdkC.getTool('SendMessage');
      expect(sendMessageB).toBeDefined();
      expect(sendMessageC).toBeDefined();
      const createContext = (toolUseId: string, prompt: string) => ({
        runId: `concurrent-parent-${toolUseId}`,
        sessionId: parent.id,
        cwd: fixture.workDir,
        prompt,
        iteration: 1,
        toolUseId,
        metadata: {
          [HADAMARD_EXECUTION_ID_KEY]: parent.id,
          [HADAMARD_ROOT_EXECUTION_ID_KEY]: parent.id,
          [HADAMARD_AGENT_PATH_KEY]: '/root',
        },
        permissionMode: 'bypassPermissions' as const,
      });
      const [routedB, routedC] = await Promise.all([
        sendMessageB!.execute(
          {
            to: initialTask.sessionId!,
            message: followUpB,
            summary: 'Continue from client B',
          },
          createContext('toolu_concurrent_resume_b', followUpB),
        ),
        sendMessageC!.execute(
          {
            to: initialTask.sessionId!,
            message: followUpC,
            summary: 'Continue from client C',
          },
          createContext('toolu_concurrent_resume_c', followUpC),
        ),
      ]) as [
        { status: string; taskId: string; agentId: string },
        { status: string; taskId: string; agentId: string },
      ];

      expect(routedB).toMatchObject({
        status: 'resumed',
        agentId: initialTask.sessionId,
      });
      expect(routedC).toMatchObject({
        status: 'resumed',
        agentId: initialTask.sessionId,
      });
      expect(routedB.taskId).not.toBe(routedC.taskId);

      await firstFollowUpStarted.promise;
      await delay(75);
      expect(followUpRequestCount).toBe(1);
      expect(maxActiveFollowUpRequests).toBe(1);

      releaseFirstFollowUp.resolve(undefined);
      const [taskB, taskC] = await Promise.all([
        sdkB.tasks.wait(routedB.taskId, { timeoutMs: 5_000 }),
        sdkC.tasks.wait(routedC.taskId, { timeoutMs: 5_000 }),
      ]);
      expect(taskB.status).toBe('completed');
      expect(taskC.status).toBe('completed');
      expect(followUpRequestCount).toBe(2);
      expect(maxActiveFollowUpRequests).toBe(1);

      const storedChild = await new SessionStore(fixture.sessionDirectory)
        .load(initialTask.sessionId!);
      const storedMessages = storedChild.messages.map(message => JSON.stringify(message.content));
      expect(storedMessages.filter(text => text.includes(followUpB))).toHaveLength(1);
      expect(storedMessages.filter(text => text.includes(followUpC))).toHaveLength(1);

      const snapshot = await sdkA.executions.getSnapshot(parent.id);
      for (const callId of ['toolu_concurrent_resume_b', 'toolu_concurrent_resume_c']) {
        expect(snapshot?.edges).toContainEqual(expect.objectContaining({
          callId,
          kind: 'message',
          status: 'completed',
        }));
      }
      expect(snapshot?.edges.filter(edge =>
        edge.kind === 'message' && edge.status === 'failed',
      )).toHaveLength(0);
    } finally {
      bothReservationsReady.resolve(undefined);
      releaseFirstFollowUp.resolve(undefined);
      vi.restoreAllMocks();
      await sdkC?.close();
      await sdkB?.close();
      await sdkA.close();
    }
  }, 15_000);

  it('forks a child agent conversation into a clean, independent execution root', async () => {
    const fixture = await createFixture('hadamard-agent-execution-fork-');
    const modelApi = new ScriptedModelApi((request, index) => {
      expect(request.system).toContain('fork isolation reviewer');
      return makeMessage([{
        type: 'text',
        text: index === 0 ? 'Original child turn complete.' : 'Forked root turn complete.',
      }]);
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      homeDir: fixture.homeDir,
      workDir: fixture.workDir,
      sessionDirectory: fixture.sessionDirectory,
      modelApi,
      agents: [{
        name: 'fork-reviewer',
        description: 'Exercise Agent session fork isolation.',
        systemPrompt: 'You are the fork isolation reviewer.',
      }],
      disableDefaultAgents: true,
      disableDefaultSkills: true,
      loadDefaultAgentDirectories: false,
      loadDefaultSkillDirectories: false,
      permissionMode: 'bypassPermissions',
    });

    try {
      const parent = await sdk.createSession({ title: 'Fork topology parent', kind: 'main' });
      const originalExecutionId = 'fork-source-child-execution';
      const originalChild = await sdk.agents.createSession('fork-reviewer', {
        title: 'Fork source child',
        kind: 'agent',
        parentSessionId: parent.id,
        metadata: {
          [HADAMARD_EXECUTION_ID_KEY]: originalExecutionId,
          [HADAMARD_ROOT_EXECUTION_ID_KEY]: parent.id,
          [HADAMARD_PARENT_EXECUTION_ID_KEY]: parent.id,
          [HADAMARD_AGENT_PATH_KEY]: '/root/fork-reviewer',
          __hadamardParentSessionId: parent.id,
          __hadamardBackgroundParentRunId: 'source-parent-run',
          __hadamardBackgroundParentSessionId: parent.id,
        },
      });
      await originalChild.send('Run the original child turn.');
      expect(await sdk.executions.get(originalExecutionId)).toMatchObject({
        id: originalExecutionId,
        rootExecutionId: parent.id,
        parentExecutionId: parent.id,
        sessionId: originalChild.id,
      });

      const originalSession = await sdk.sessions.get(originalChild.id);
      const forked = await originalSession.fork({ title: 'Independent fork' });
      const forkedBeforeRun = forked.snapshot();
      expect(forked.id).not.toBe(originalChild.id);
      expect(forkedBeforeRun.parentSessionId).toBeUndefined();
      for (const key of [
        HADAMARD_EXECUTION_ID_KEY,
        HADAMARD_ROOT_EXECUTION_ID_KEY,
        HADAMARD_PARENT_EXECUTION_ID_KEY,
        HADAMARD_AGENT_PATH_KEY,
        '__hadamardParentSessionId',
        '__hadamardBackgroundParentRunId',
        '__hadamardBackgroundParentSessionId',
      ]) {
        expect(forkedBeforeRun.metadata).not.toHaveProperty(key);
      }

      const forkedResult = await forked.send('Run as a new independent root.');
      expect(forkedResult).toMatchObject({
        executionId: forked.id,
        executionNodeId: forked.id,
        text: 'Forked root turn complete.',
      });
      const forkedSnapshot = await new AgentExecutionStore(fixture.sessionDirectory)
        .getSnapshot(forked.id);
      expect(forkedSnapshot).toMatchObject({
        rootExecutionId: forked.id,
        nodes: [expect.objectContaining({
          id: forked.id,
          sessionId: forked.id,
          rootExecutionId: forked.id,
          parentExecutionId: null,
          parentSessionId: null,
          canonicalPath: '/root',
          kind: 'root',
          agentStatus: 'completed',
        })],
      });
      expect(forkedSnapshot?.nodes).toHaveLength(1);
      expect(await sdk.executions.get(originalExecutionId)).toMatchObject({
        id: originalExecutionId,
        sessionId: originalChild.id,
      });
      expect(await sdk.executions.get(forked.id)).not.toMatchObject({
        id: originalExecutionId,
      });
    } finally {
      await sdk.close();
    }
  });
});
