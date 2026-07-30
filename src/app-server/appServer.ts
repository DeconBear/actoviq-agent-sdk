import type { ActoviqAgentClient } from '../runtime/agentClient.js';
import type { AgentSession } from '../runtime/agentSession.js';
import { GoalService } from '../goal/goalService.js';
import type { StoredApproval } from '../policy/approvalPolicy.js';
import { APP_SERVER_PROTOCOL_VERSION, type AppServerNotification, type AppServerRequest, type AppServerResponse } from './protocol.js';

export type AppServerEmit = (notification: AppServerNotification) => void;

const MAX_LIVE_SESSIONS = 32;

export class AppServer {
  private readonly liveSessions = new Map<string, AgentSession>();

  constructor(private readonly sdk: ActoviqAgentClient) {}

  async handle(request: AppServerRequest, emit?: AppServerEmit): Promise<AppServerResponse> {
    try {
      return {
        version: APP_SERVER_PROTOCOL_VERSION,
        id: request.id,
        result: await this.dispatch(request.method, request.params ?? {}, emit),
      };
    } catch (error) {
      return {
        version: APP_SERVER_PROTOCOL_VERSION,
        id: request.id,
        error: {
          code: 'APP_SERVER_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    emit?: AppServerEmit,
  ): Promise<unknown> {
    if (method === 'initialize') {
      return {
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        capabilities: APP_SERVER_CAPABILITIES,
      };
    }
    if (method === 'capability/list') return APP_SERVER_CAPABILITIES;
    if (method === 'session/list') return this.sdk.sessions.list();
    if (method === 'session/tree') return this.sdk.sessionGraph.roots();
    if (method === 'session/create') {
      const session = await this.sdk.createSession({
        title: stringParam(params, 'title', false),
        model: stringParam(params, 'model', false),
      });
      this.rememberSession(session);
      return session.snapshot();
    }
    if (method === 'session/open') {
      const session = await this.openSession(stringParam(params, 'sessionId'));
      return session.snapshot();
    }
    if (method === 'session/close') {
      const sessionId = stringParam(params, 'sessionId');
      this.liveSessions.delete(sessionId);
      return { closed: true };
    }
    if (method === 'session/send') {
      const sessionId = stringParam(params, 'sessionId');
      const session = await this.openSession(sessionId);
      const stream = session.stream(stringParam(params, 'input'));
      if (emit) {
        // Consume the event stream to completion before returning so response
        // ordering stays behind session/event notifications on stdio/WS.
        for await (const event of stream) {
          emit({
            version: APP_SERVER_PROTOCOL_VERSION,
            type: 'event',
            method: 'session/event',
            params: { sessionId, event },
          });
        }
      }
      return stream.result;
    }
    if (method === 'diff/get') {
      return this.sdk.getSessionDiff(stringParam(params, 'sessionId'));
    }
    if (method === 'diff/apply') {
      if (params.confirm !== true) throw new Error('diff/apply requires confirm:true.');
      return this.sdk.applySessionDiff(
        stringParam(params, 'sessionId'),
        stringParam(params, 'targetDir', false),
      );
    }
    if (method === 'checkpoint/list') {
      return this.sdk.checkpoints.list(stringParam(params, 'sessionId'));
    }
    if (method === 'checkpoint/preview') {
      return this.sdk.checkpoints.preview(
        stringParam(params, 'sessionId'),
        stringParam(params, 'checkpointId'),
      );
    }
    if (method === 'checkpoint/restore') {
      if (params.confirm !== true) throw new Error('checkpoint/restore requires confirm:true.');
      const mode = checkpointMode(params.mode);
      return this.sdk.checkpoints.restore({
        sessionId: stringParam(params, 'sessionId'),
        checkpointId: stringParam(params, 'checkpointId'),
        mode,
      });
    }
    if (method === 'goal/get') {
      return this.goalService(await this.openSession(stringParam(params, 'sessionId'))).read();
    }
    if (method === 'goal/create') {
      return this.goalService(await this.openSession(stringParam(params, 'sessionId'))).create({
        objective: stringParam(params, 'objective'),
        completionCriteria: stringParam(params, 'completionCriteria', false),
      });
    }
    if (method === 'goal/transition') {
      const status = stringParam(params, 'status');
      if (status !== 'active' && status !== 'paused') {
        throw new Error('status must be active or paused.');
      }
      return this.goalService(await this.openSession(stringParam(params, 'sessionId')))
        .transition(status);
    }
    if (method === 'goal/revise') {
      return this.goalService(await this.openSession(stringParam(params, 'sessionId'))).revise({
        objective: stringParam(params, 'objective', false),
        completionCriteria: stringParam(params, 'completionCriteria', false),
        expectedRevision: numberParam(params, 'expectedRevision', false),
      });
    }
    if (method === 'approval/list') return this.sdk.approvalPolicy.list();
    if (method === 'approval/remember') {
      if (params.confirm !== true) {
        throw new Error('approval/remember requires confirm:true.');
      }
      const approval = parseStoredApproval(params.approval);
      await this.sdk.approvalPolicy.remember(approval);
      return { saved: true };
    }
    throw new Error(`Unknown app-server method: ${method}`);
  }

  private async openSession(sessionId: string): Promise<AgentSession> {
    const session = this.liveSessions.get(sessionId) ?? await this.sdk.resumeSession(sessionId);
    this.rememberSession(session);
    return session;
  }

  private rememberSession(session: AgentSession): void {
    // Refresh insertion order so LRU eviction drops the oldest idle handle.
    this.liveSessions.delete(session.id);
    this.liveSessions.set(session.id, session);
    while (this.liveSessions.size > MAX_LIVE_SESSIONS) {
      const oldest = this.liveSessions.keys().next().value;
      if (!oldest) break;
      this.liveSessions.delete(oldest);
    }
  }

  private goalService(session: AgentSession): GoalService {
    return GoalService.forSession(session);
  }
}

const APP_SERVER_CAPABILITIES = [
  'sessions',
  'streaming',
  'session-tree',
  'diff',
  'checkpoints',
  'goals',
  'approvals',
] as const;

function stringParam(params: Record<string, unknown>, name: string): string;
function stringParam(
  params: Record<string, unknown>,
  name: string,
  required: false,
): string | undefined;
function stringParam(
  params: Record<string, unknown>,
  name: string,
  required = true,
): string | undefined {
  const value = params[name];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (required) throw new Error(`${name} is required.`);
  return undefined;
}

function numberParam(
  params: Record<string, unknown>,
  name: string,
  required: false,
): number | undefined {
  const value = params[name];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (required) throw new Error(`${name} is required.`);
  return undefined;
}

function checkpointMode(value: unknown): 'files' | 'conversation' | 'both' {
  if (value === undefined) return 'both';
  if (value === 'files' || value === 'conversation' || value === 'both') return value;
  throw new Error('mode must be files, conversation, or both.');
}

function parseStoredApproval(value: unknown): StoredApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('approval/remember requires an approval object.');
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const tool = typeof record.tool === 'string' ? record.tool.trim() : '';
  if (!id) throw new Error('approval.id is required.');
  if (!tool) throw new Error('approval.tool is required.');
  if (record.behavior !== 'allow' && record.behavior !== 'deny') {
    throw new Error('approval.behavior must be allow or deny.');
  }
  if (record.pathPrefix !== undefined && typeof record.pathPrefix !== 'string') {
    throw new Error('approval.pathPrefix must be a string when provided.');
  }
  if (
    record.expiresAt !== undefined
    && (typeof record.expiresAt !== 'string' || Number.isNaN(Date.parse(record.expiresAt)))
  ) {
    throw new Error('approval.expiresAt must be an ISO timestamp when provided.');
  }
  if (record.behavior === 'allow' && tool !== 'Read' && tool !== 'Glob' && tool !== 'Grep') {
    if (typeof record.pathPrefix !== 'string' || !record.pathPrefix.trim()) {
      throw new Error(
        'approval/remember allow rules for mutating tools require a pathPrefix scope.',
      );
    }
  }
  return {
    id,
    tool,
    behavior: record.behavior,
    ...(typeof record.pathPrefix === 'string' && record.pathPrefix.trim()
      ? { pathPrefix: record.pathPrefix.trim() }
      : {}),
    ...(typeof record.expiresAt === 'string' ? { expiresAt: record.expiresAt } : {}),
    createdAt: typeof record.createdAt === 'string' && record.createdAt.trim()
      ? record.createdAt
      : new Date().toISOString(),
  };
}
