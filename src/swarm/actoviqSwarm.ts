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
    const running = {
      ...teammate,
      status: 'running' as const,
      lastTaskDescription: prompt,
      updatedAt: nowIso(),
    };
    await this.teammateStore.save(running);
    try {
      const result = await session.send(prompt);
      const updated = {
        ...running,
        status: 'idle' as const,
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
    const task = await this.bindings.launchBackgroundOnSession(session, teammate.agentName, prompt, {
      parentRunId: createId(),
      parentSessionId: session.id,
    });
    await this.teammateStore.save({
      ...teammate,
      status: 'running',
      taskId: task.id,
      lastTaskDescription: prompt,
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
      teammates.map(teammate =>
        this.mailboxStore.post(this.name, teammate.name, {
          from: this.leader,
          kind: 'user',
          text,
          createdAt: nowIso(),
        }),
      ),
    );
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
