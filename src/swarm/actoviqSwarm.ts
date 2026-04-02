import type {
  ActoviqBackgroundTaskRecord,
  ActoviqMailboxMessage,
  ActoviqSwarmRunResult,
  ActoviqTeammateRecord,
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
}

export class ActoviqSwarmTeam {
  constructor(
    private readonly bindings: ActoviqSwarmBindings,
    private readonly teammateStore: TeammateStore,
    private readonly mailboxStore: MailboxStore,
    readonly name: string,
    readonly leader: string,
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
      mailboxDepth: 0,
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
    return this.bindings.resumeSession(teammate.sessionId);
  }

  async run(name: string, prompt: string): Promise<ActoviqSwarmRunResult> {
    const teammate = await this.requireTeammate(name);
    const session = await this.bindings.resumeSession(teammate.sessionId);
    const injectedMessages = await this.drainMailboxMessagesForTeammate(name);
    const running = {
      ...teammate,
      status: 'running' as const,
      lastTaskDescription: prompt,
      mailboxDepth: 0,
      updatedAt: nowIso(),
    };
    await this.teammateStore.save(running);
    try {
      const result = await session.send(composeTeammateInput(injectedMessages, prompt));
      const updated = {
        ...running,
        status: 'idle' as const,
        lastRunId: result.runId,
        lastCompletedAt: nowIso(),
        updatedAt: nowIso(),
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
      };
    } catch (error) {
      const updated = {
        ...running,
        status: 'failed' as const,
        updatedAt: nowIso(),
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

  async runBackground(
    name: string,
    prompt: string,
    _options: WaitForActoviqBackgroundTaskOptions = {},
  ): Promise<ActoviqBackgroundTaskRecord> {
    const teammate = await this.requireTeammate(name);
    const session = await this.bindings.resumeSession(teammate.sessionId);
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
      updatedAt: nowIso(),
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
            ? 'completed'
            : task.status === 'cancelled'
              ? 'cancelled'
              : 'failed',
        lastRunId: task.runId ?? teammate.lastRunId,
        lastCompletedAt: task.completedAt ?? teammate.lastCompletedAt,
        updatedAt: nowIso(),
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
