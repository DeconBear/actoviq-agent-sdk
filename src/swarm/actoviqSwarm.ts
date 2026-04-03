import type {
  ActoviqBackgroundTaskRecord,
  ActoviqMailboxMessage,
  ActoviqSwarmRunResult,
  ActoviqSwarmRuntimeContext,
  ActoviqTeammateRecord,
  ActoviqTeammateTranscript,
  CreateActoviqSwarmOptions,
  CreateActoviqTeammateOptions,
  WaitForActoviqBackgroundTaskOptions,
} from '../types.js';
import type { AgentSession } from '../runtime/agentSession.js';
import type { MailboxStore } from '../storage/mailboxStore.js';
import type { TeammateStore } from '../storage/teammateStore.js';
import { createId, nowIso } from '../runtime/helpers.js';
import type { MessageParam } from '../provider/types.js';

interface ActoviqSwarmBindings {
  createAgentSession(agent: string, options: { title: string; metadata: Record<string, unknown> }): Promise<AgentSession>;
  launchBackgroundOnSession(
    session: AgentSession,
    agent: string,
    prompt: string,
    options: { parentRunId: string; parentSessionId?: string },
  ): Promise<ActoviqBackgroundTaskRecord>;
  resumeSession(sessionId: string): Promise<AgentSession>;
  getBackgroundTask(taskId: string): Promise<ActoviqBackgroundTaskRecord | undefined>;
}

interface ContinueActoviqTeammateOptions {
  prompt?: string;
  maxPasses?: number;
}

const DEFAULT_MAILBOX_CONTINUATION_PROMPT =
  'Continue with the latest teammate messages, preserve continuity, and only report back when you have meaningful progress.';

export class ActoviqSwarmTeammateHandle {
  constructor(
    private readonly team: ActoviqSwarmTeam,
    readonly name: string,
  ) {}

  state(): Promise<ActoviqTeammateRecord | undefined> {
    return this.team.getTeammate(this.name);
  }

  run(prompt: string): Promise<ActoviqSwarmRunResult> {
    return this.team.run(this.name, prompt);
  }

  runBackground(
    prompt: string,
    options: WaitForActoviqBackgroundTaskOptions = {},
  ): Promise<ActoviqBackgroundTaskRecord> {
    return this.team.runBackground(this.name, prompt, options);
  }

  inbox(): Promise<ActoviqMailboxMessage[]> {
    return this.team.inbox(this.name);
  }

  message(text: string, from?: string): Promise<ActoviqMailboxMessage> {
    return this.team.message(this.name, text, from);
  }

  session(): Promise<AgentSession> {
    return this.team.session(this.name);
  }

  continueFromMailbox(
    options: ContinueActoviqTeammateOptions = {},
  ): Promise<ActoviqSwarmRunResult | undefined> {
    return this.team.continueFromMailbox(this.name, options);
  }

  recover(): Promise<ActoviqTeammateRecord> {
    return this.team.recover(this.name);
  }

  transcript(): Promise<ActoviqTeammateTranscript> {
    return this.team.transcript(this.name);
  }

  reenter(options: ContinueActoviqTeammateOptions = {}): Promise<ActoviqSwarmRunResult | undefined> {
    return this.team.reenter(this.name, options);
  }
}

export class ActoviqSwarmTeam {
  private readonly mailboxContinuations = new Map<
    string,
    Promise<ActoviqSwarmRunResult | undefined>
  >();
  private runtimeContext: ActoviqSwarmRuntimeContext = {};

  constructor(
    private readonly bindings: ActoviqSwarmBindings,
    private readonly teammateStore: TeammateStore,
    private readonly mailboxStore: MailboxStore,
    readonly name: string,
    readonly leader: string,
    private readonly continuous = false,
  ) {}

  async spawn(options: CreateActoviqTeammateOptions): Promise<ActoviqSwarmRunResult> {
    const createdAt = nowIso();
    const session = await this.bindings.createAgentSession(options.agent, {
      title: `${options.name}: ${options.prompt.slice(0, 80)}`,
      metadata: {
        __actoviqSwarmTeam: this.name,
        __actoviqTeammateName: options.name,
      },
    });
    const teammate = await this.teammateStore.create(this.name, {
      name: options.name,
      agentName: options.agent,
      sessionId: session.id,
      status: 'idle',
      leaderName: this.leader,
      originPrompt: options.prompt,
      lineage: [`spawn:${options.agent}`],
      mailboxDepth: 0,
      mailboxMessageCount: 0,
      mailboxTurns: 0,
      runCount: 0,
      backgroundRunCount: 0,
      recoveryCount: 0,
      createdAt,
      updatedAt: createdAt,
    });
    await this.mailboxStore.post(this.name, this.leader, {
      from: options.name,
      kind: 'status',
      text: `Teammate ${options.name} joined team ${this.name}.`,
      createdAt,
      metadata: { sessionId: session.id, agent: options.agent },
    });
    const result = await this.run(options.name, options.prompt);
    return {
      ...result,
      teammate: (await this.getTeammate(options.name)) ?? teammate,
    };
  }

  setRuntimeContext(context: ActoviqSwarmRuntimeContext = {}): void {
    this.runtimeContext = {
      hooks: context.hooks,
      permissionMode: context.permissionMode,
      permissions: context.permissions ? [...context.permissions] : undefined,
      classifier: context.classifier,
      approver: context.approver,
    };
  }

  clearRuntimeContext(): void {
    this.runtimeContext = {};
  }

  async listTeammates(): Promise<ActoviqTeammateRecord[]> {
    return this.syncTeammateStatuses(await this.teammateStore.list(this.name));
  }

  teammate(name: string): ActoviqSwarmTeammateHandle {
    return new ActoviqSwarmTeammateHandle(this, name);
  }

  async getTeammate(name: string): Promise<ActoviqTeammateRecord | undefined> {
    return this.teammateStore.load(this.name, name);
  }

  async session(name: string): Promise<AgentSession> {
    const teammate = await this.requireTeammate(name);
    const session = await this.bindings.resumeSession(teammate.sessionId);
    this.applyRuntimeContext(session);
    await this.teammateStore.save({
      ...teammate,
      lastResumedAt: nowIso(),
      updatedAt: nowIso(),
    });
    return session;
  }

  async run(name: string, prompt: string): Promise<ActoviqSwarmRunResult> {
    return this.runInternal(name, prompt, 'prompt');
  }

  async continueFromMailbox(
    name: string,
    options: ContinueActoviqTeammateOptions = {},
  ): Promise<ActoviqSwarmRunResult | undefined> {
    const existing = this.mailboxContinuations.get(name);
    if (existing) {
      return existing;
    }

    const continuation = (async () => {
      const maxPasses = Math.max(1, options.maxPasses ?? 8);
      let lastResult: ActoviqSwarmRunResult | undefined;

      for (let index = 0; index < maxPasses; index += 1) {
        const teammate = await this.requireTeammate(name);
        if (teammate.status === 'running') {
          return lastResult;
        }

        const pending = await this.mailboxStore.list(this.name, name);
        if (pending.length === 0) {
          return lastResult;
        }

        lastResult = await this.runInternal(
          name,
          options.prompt ?? DEFAULT_MAILBOX_CONTINUATION_PROMPT,
          'mailbox',
        );
      }

      return lastResult;
    })().finally(() => {
      this.mailboxContinuations.delete(name);
    });

    this.mailboxContinuations.set(name, continuation);
    return continuation;
  }

  async continueAllFromMailbox(
    options: ContinueActoviqTeammateOptions = {},
  ): Promise<ActoviqSwarmRunResult[]> {
    const results: ActoviqSwarmRunResult[] = [];
    const maxPasses = Math.max(1, options.maxPasses ?? 8);

    for (let index = 0; index < maxPasses; index += 1) {
      let progressed = false;
      const teammates = await this.listTeammates();

      for (const teammate of teammates) {
        if (teammate.status === 'running') {
          continue;
        }
        const pending = await this.mailboxStore.list(this.name, teammate.name);
        if (pending.length === 0) {
          continue;
        }
        const result = await this.continueFromMailbox(teammate.name, {
          prompt: options.prompt,
          maxPasses: 1,
        });
        if (result) {
          progressed = true;
          results.push(result);
        }
      }

      if (!progressed) {
        break;
      }
    }

    return results;
  }

  async recover(name: string): Promise<ActoviqTeammateRecord> {
    const teammate = await this.requireTeammate(name);
    const recovered: ActoviqTeammateRecord = {
      ...teammate,
      status: 'idle',
      taskId: undefined,
      recoveryCount: (teammate.recoveryCount ?? 0) + 1,
      lastActiveAt: nowIso(),
      updatedAt: nowIso(),
      lineage: appendLineageMarker(teammate.lineage, 'recovered'),
    };
    await this.teammateStore.save(recovered);
    return recovered;
  }

  async transcript(name: string): Promise<ActoviqTeammateTranscript> {
    const teammate = await this.requireTeammate(name);
    const session = await this.bindings.resumeSession(teammate.sessionId);
    const [leaderInbox, teammateInbox] = await Promise.all([
      this.mailboxStore.list(this.name, this.leader),
      this.mailboxStore.list(this.name, name),
    ]);
    return {
      teammate,
      sessionId: session.id,
      messages: session.messages,
      leaderInbox,
      teammateInbox,
    };
  }

  async reenter(
    name: string,
    options: ContinueActoviqTeammateOptions = {},
  ): Promise<ActoviqSwarmRunResult | undefined> {
    const teammate = await this.requireTeammate(name);
    const pending = await this.mailboxStore.list(this.name, name);
    if (pending.length > 0) {
      return this.continueFromMailbox(name, options);
    }
    if (options.prompt?.trim()) {
      return this.runInternal(name, options.prompt, 'prompt');
    }
    if (teammate.lastTaskDescription?.trim()) {
      return this.runInternal(name, teammate.lastTaskDescription, 'prompt');
    }
    return undefined;
  }

  async runBackground(
    name: string,
    prompt: string,
    _options: WaitForActoviqBackgroundTaskOptions = {},
  ): Promise<ActoviqBackgroundTaskRecord> {
    const teammate = await this.requireTeammate(name);
    const session = await this.bindings.resumeSession(teammate.sessionId);
    this.applyRuntimeContext(session);
    const injectedMessages = await this.drainMailboxMessagesForTeammate(name);
    const task = await this.bindings.launchBackgroundOnSession(
      session,
      teammate.agentName,
      composeTeammatePrompt(injectedMessages, prompt),
      {
        parentRunId: createId(),
        parentSessionId: session.id,
      },
    );
    await this.teammateStore.save({
      ...teammate,
      status: 'running',
      taskId: task.id,
      lastTaskDescription: prompt,
      mailboxDepth: 0,
      backgroundRunCount: (teammate.backgroundRunCount ?? 0) + 1,
      mailboxMessageCount: (teammate.mailboxMessageCount ?? 0) + injectedMessages.length,
      lastMailboxMessageId: injectedMessages.at(-1)?.id,
      lastResumedAt: nowIso(),
      updatedAt: nowIso(),
      lineage: appendLineageMarker(teammate.lineage, `background:${task.id}`),
    });
    await this.mailboxStore.post(this.name, this.leader, {
      from: name,
      kind: 'status',
      text: `Background task ${task.id} started for ${name}.`,
      createdAt: nowIso(),
      metadata: { taskId: task.id, sessionId: session.id },
    });
    return task;
  }

  private async runInternal(
    name: string,
    prompt: string,
    source: 'prompt' | 'mailbox',
  ): Promise<ActoviqSwarmRunResult> {
    const teammate = await this.requireTeammate(name);
    const session = await this.bindings.resumeSession(teammate.sessionId);
    this.applyRuntimeContext(session);
    const injectedMessages = await this.drainMailboxMessagesForTeammate(name);
    const processedMailboxMessages = injectedMessages.length;
    const running = {
      ...teammate,
      status: 'running' as const,
      lastTaskDescription: prompt,
      mailboxDepth: 0,
      lastResumedAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.teammateStore.save(running);
    try {
      const result = await session.send(composeTeammateInput(injectedMessages, prompt));
      const updated = {
        ...running,
        status: 'idle' as const,
        lastTaskStatus: 'completed' as const,
        lastRunId: result.runId,
        lastCompletedAt: nowIso(),
        lastActiveAt: nowIso(),
        runCount: (running.runCount ?? 0) + 1,
        mailboxTurns:
          source === 'mailbox'
            ? (running.mailboxTurns ?? 0) + 1
            : running.mailboxTurns ?? 0,
        mailboxMessageCount: (running.mailboxMessageCount ?? 0) + processedMailboxMessages,
        lastMailboxMessageId: injectedMessages.at(-1)?.id ?? running.lastMailboxMessageId,
        updatedAt: nowIso(),
        lineage: appendLineageMarker(running.lineage, `${source}:${result.runId}`),
      };
      await this.teammateStore.save(updated);
      await this.mailboxStore.post(this.name, this.leader, {
        from: name,
        kind: 'task',
        text: result.text,
        createdAt: nowIso(),
        metadata: { sessionId: session.id, runId: result.runId },
      });
      return {
        teammate: updated,
        result,
        source,
        mailboxMessagesProcessed: processedMailboxMessages,
      };
    } catch (error) {
      const updated = {
        ...running,
        status: 'failed' as const,
        lastTaskStatus: 'failed' as const,
        lastActiveAt: nowIso(),
        updatedAt: nowIso(),
        lineage: appendLineageMarker(running.lineage, `${source}:failed`),
      };
      await this.teammateStore.save(updated);
      await this.mailboxStore.post(this.name, this.leader, {
        from: name,
        kind: 'status',
        text: error instanceof Error ? error.message : 'Teammate run failed.',
        createdAt: nowIso(),
      });
      throw error;
    }
  }

  async broadcast(text: string): Promise<ActoviqMailboxMessage[]> {
    const teammates = await this.listTeammates();
    return Promise.all(
      teammates.map(teammate => this.message(teammate.name, text, this.leader)),
    );
  }

  async message(
    recipient: string,
    text: string,
    from = this.leader,
  ): Promise<ActoviqMailboxMessage> {
    const message = await this.mailboxStore.post(this.name, recipient, {
      from,
      kind: from === this.leader ? 'user' : 'task',
      text,
      createdAt: nowIso(),
    });
    const teammate = await this.teammateStore.load(this.name, recipient);
    if (teammate) {
      const depth = (await this.mailboxStore.list(this.name, recipient)).length;
      await this.teammateStore.save({
        ...teammate,
        mailboxDepth: depth,
        updatedAt: nowIso(),
      });
      if (this.continuous && teammate.status !== 'running') {
        void this.continueFromMailbox(recipient).catch(() => undefined);
      }
    }
    return message;
  }

  inbox(recipient = this.leader): Promise<ActoviqMailboxMessage[]> {
    return this.mailboxStore.list(this.name, recipient);
  }

  drainInbox(recipient = this.leader): Promise<ActoviqMailboxMessage[]> {
    return this.mailboxStore.drain(this.name, recipient);
  }

  async waitForIdle(): Promise<ActoviqTeammateRecord[]> {
    while (true) {
      if (this.continuous) {
        await this.continueAllFromMailbox({ maxPasses: 1 });
      }
      const teammates = await this.listTeammates();
      if (teammates.every(teammate => teammate.status !== 'running')) {
        return teammates;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  async shutdown(name?: string): Promise<void> {
    const teammates = name ? [await this.requireTeammate(name)] : await this.listTeammates();
    for (const teammate of teammates) {
      await this.teammateStore.delete(this.name, teammate.name);
      await this.mailboxStore.post(this.name, this.leader, {
        from: teammate.name,
        kind: 'status',
        text: `Teammate ${teammate.name} left team ${this.name}.`,
        createdAt: nowIso(),
      });
    }
  }

  private async requireTeammate(name: string): Promise<ActoviqTeammateRecord> {
    const teammate = await this.getTeammate(name);
    if (!teammate) {
      throw new Error(`No teammate named "${name}" exists in team "${this.name}".`);
    }
    return teammate;
  }

  private async syncTeammateStatuses(
    teammates: ActoviqTeammateRecord[],
  ): Promise<ActoviqTeammateRecord[]> {
    const synced: ActoviqTeammateRecord[] = [];

    for (const teammate of teammates) {
      if (!teammate.taskId || teammate.status !== 'running') {
        synced.push(teammate);
        continue;
      }

      const task = await this.bindings.getBackgroundTask(teammate.taskId);
      if (!task || task.status === 'queued' || task.status === 'running') {
        synced.push(teammate);
        continue;
      }

      const updated: ActoviqTeammateRecord = {
        ...teammate,
        status:
          task.status === 'completed'
            ? 'idle'
            : task.status === 'cancelled'
              ? 'cancelled'
              : 'failed',
        taskId: undefined,
        lastTaskStatus: task.status,
        lastRunId: task.runId ?? teammate.lastRunId,
        lastCompletedAt: task.completedAt ?? teammate.lastCompletedAt,
        lastActiveAt: task.completedAt ?? nowIso(),
        updatedAt: nowIso(),
        lineage: appendLineageMarker(teammate.lineage, `background:${task.status}`),
      };
      await this.teammateStore.save(updated);
      await this.mailboxStore.post(this.name, this.leader, {
        from: teammate.name,
        kind: task.status === 'completed' ? 'task' : 'status',
        text:
          task.status === 'completed'
            ? task.text ?? `Background task ${task.id} completed.`
            : task.error ?? `Background task ${task.id} ${task.status}.`,
        createdAt: nowIso(),
        metadata: {
          taskId: task.id,
          sessionId: task.sessionId,
          runId: task.runId,
          status: task.status,
        },
      });
      synced.push(updated);
    }

    return synced;
  }

  private async drainMailboxMessagesForTeammate(
    teammateName: string,
  ): Promise<ActoviqMailboxMessage[]> {
    const drained = await this.mailboxStore.drain(this.name, teammateName);
    const teammate = await this.teammateStore.load(this.name, teammateName);
    if (teammate) {
      await this.teammateStore.save({
        ...teammate,
        mailboxDepth: 0,
        updatedAt: nowIso(),
      });
    }
    return drained;
  }

  private applyRuntimeContext(session: AgentSession): void {
    session.clearHooks();
    session.clearPermissionContext();

    if (this.runtimeContext.hooks) {
      session.setHooks(this.runtimeContext.hooks);
    }

    if (
      this.runtimeContext.permissionMode ||
      this.runtimeContext.permissions ||
      this.runtimeContext.classifier ||
      this.runtimeContext.approver
    ) {
      session.setPermissionContext({
        mode: this.runtimeContext.permissionMode,
        permissions: this.runtimeContext.permissions,
        classifier: this.runtimeContext.classifier,
        approver: this.runtimeContext.approver,
      });
    }
  }
}

export class ActoviqSwarmApi {
  constructor(
    private readonly bindings: ActoviqSwarmBindings,
    private readonly teammateStore: TeammateStore,
    private readonly mailboxStore: MailboxStore,
  ) {}

  createTeam(options: CreateActoviqSwarmOptions): ActoviqSwarmTeam {
    return new ActoviqSwarmTeam(
      this.bindings,
      this.teammateStore,
      this.mailboxStore,
      options.name,
      options.leader ?? 'leader',
      options.continuous ?? false,
    );
  }
}

function composeTeammateInput(
  mailboxMessages: ActoviqMailboxMessage[],
  prompt: string,
): string | MessageParam['content'] {
  const preface = formatTeammateMailboxMessages(mailboxMessages);
  return preface ? `${preface}\n\n${prompt}` : prompt;
}

function composeTeammatePrompt(
  mailboxMessages: ActoviqMailboxMessage[],
  prompt: string,
): string {
  const input = composeTeammateInput(mailboxMessages, prompt);
  return typeof input === 'string' ? input : JSON.stringify(input);
}

function formatTeammateMailboxMessages(messages: ActoviqMailboxMessage[]): string | undefined {
  if (messages.length === 0) {
    return undefined;
  }
  return messages
    .map(message => {
      const summary = message.kind === 'status' ? ' type="status"' : '';
      return `<teammate-message teammate_id="${message.from}"${summary}>\n${message.text}\n</teammate-message>`;
    })
    .join('\n\n');
}

function appendLineageMarker(
  lineage: string[] | undefined,
  marker: string,
): string[] {
  return [...(lineage ?? []), marker].slice(-16);
}
