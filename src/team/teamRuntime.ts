/**
 * Team runtime — centralized member execution for every team mode.
 *
 * All team modes (reviewer, panel-analysis) run their members through a single
 * path here, so identity, preflight, concurrency, streaming, token accounting,
 * status, and cleanup are handled in exactly one place instead of being
 * duplicated per mode.
 *
 * Leaf module: it imports `agentClient` only lazily (inside `runMemberAgent`)
 * to avoid the agentClient → modelTeam → teamRuntime require cycle. The
 * top-level import of `createAgentSdk` is type-only (erased at runtime).
 */
import type { createAgentSdk as CreateAgentSdk } from '../runtime/agentClient.js';
import type {
  AgentPoolSlot,
  AgentRunOptions,
  AgentToolDefinition,
  MemberStatus,
  TeamEvent,
  TeamMember,
} from '../types.js';
import { AgentPool } from './agentPool.js';

/** Resolve a `$ENV_VAR` apiKey reference; literal keys pass through unchanged. */
export function resolveApiKey(apiKey?: string): string | undefined {
  if (!apiKey) return undefined;
  if (apiKey.startsWith('$')) return process.env[apiKey.slice(1)];
  return apiKey;
}

/** Combine the caller's abort signal with a per-call timeout (if set). */
export function memberSignal(signal: AbortSignal | undefined, timeoutMs?: number): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return signal;
  const signals = [signal, AbortSignal.timeout(timeoutMs)].filter((s): s is AbortSignal => s != null);
  return AbortSignal.any(signals);
}

/** Run `fn` over `items` with at most `limit` in flight; preserves input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Default read-only tool names for graph agent nodes (matches buildReadOnlyExpertTools). */
export const TEAM_READ_ONLY_EXPERT_TOOL_NAMES = ['Read', 'Glob', 'Grep', 'WebFetch', 'TavilySearch'] as const;

/** Read-only tool set for expert/reviewer agents (no write/edit/bash/delegation). */
export async function buildReadOnlyExpertTools(cwd: string): Promise<AgentToolDefinition[]> {
  const { createActoviqFileTools } = await import('../tools/actoviqFileTools.js');
  const { createActoviqWebTools } = await import('../tools/actoviqWebTools.js');
  const { createTavilySearchTool } = await import('../tools/tavilySearch.js');
  const READ_ONLY_FILE_TOOLS = new Set(['Read', 'Glob', 'Grep']);
  return [
    ...createActoviqFileTools({ cwd }).filter((t) => READ_ONLY_FILE_TOOLS.has(t.name)),
    ...createActoviqWebTools().filter((t) => t.name === 'WebFetch'),
    createTavilySearchTool(),
  ];
}

export interface MemberIdentity {
  id: string;
  model: string;
  role?: string;
}

/**
 * Assign each member a stable, unique identity for reports/events/status.
 * Preference: explicit id → name → role → model; duplicates get a `#n` suffix so
 * two members sharing a model (the common default) never collide in labels.
 */
export function buildMemberIdentities(
  members: Array<{ id?: string; name?: string; role?: string; model?: string }>,
): MemberIdentity[] {
  const used = new Map<string, number>();
  return members.map((member) => {
    const base = (member.id ?? member.name ?? member.role ?? member.model ?? 'member').trim() || 'member';
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const id = seen === 0 ? base : `${base}#${seen + 1}`;
    return { id, model: member.model ?? '', role: member.role };
  });
}

export interface PreflightResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate a member's configuration before running it. Conservative on purpose:
 * it flags only unambiguous misconfigurations (a `$ENV_VAR` apiKey whose variable
 * is unset, or a missing model) so members relying on global credentials still run.
 */
export function preflightMember(member: TeamMember): PreflightResult {
  if (!member.model || !member.model.trim()) {
    return { ok: false, error: 'no model configured' };
  }
  if (member.apiKey && member.apiKey.startsWith('$') && !process.env[member.apiKey.slice(1)]) {
    return { ok: false, error: `missing environment variable ${member.apiKey.slice(1)} for apiKey` };
  }
  return { ok: true };
}

export interface RunMemberOptions {
  identity: MemberIdentity;
  member: TeamMember;
  task: string;
  systemPrompt: string;
  cwd: string;
  tools: AgentToolDefinition[];
  maxIterations: number;
  timeoutMs?: number;
  /** @deprecated Whole-run retries are unsafe for side-effecting agents and are ignored. */
  reconnectAttempts?: number;
  signal?: AbortSignal;
  permissionMode?: AgentRunOptions['permissionMode'];
  permissions?: AgentRunOptions['permissions'];
  classifier?: AgentRunOptions['classifier'];
  approver?: AgentRunOptions['approver'];
  hooks?: AgentRunOptions['hooks'];
  /** Runtime-owned concurrency controller. Omit only for a standalone one-member call. */
  pool?: AgentPool;
  round: number;
  onEvent?: (event: TeamEvent) => void;
}

export interface MemberRunResult {
  report: string;
  status: MemberStatus;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The single member runner shared by all team modes. Handles, in one place:
 *  - preflight (skips clearly-misconfigured members with a structured status)
 *  - AgentPool slot acquire/release
 *  - SDK lifecycle (create → stream → close)
 *  - progress events (started / per tool.call / completed)
 *  - token accounting + tool-call counting
 *  - error capture into a structured MemberStatus (never throws)
 */
export async function runMemberAgent(opts: RunMemberOptions): Promise<MemberRunResult> {
  const {
    identity,
    member,
    task,
    systemPrompt,
    cwd,
    tools,
    maxIterations,
    timeoutMs,
    signal,
    round,
    onEvent,
  } = opts;
  const startedAt = Date.now();
  const base = { id: identity.id, model: identity.model, role: identity.role };

  const pre = preflightMember(member);
  if (!pre.ok) {
    const status: MemberStatus = { ...base, ok: false, skipped: true, error: pre.error, toolCalls: 0, durationMs: 0 };
    onEvent?.({ type: 'team.member.completed', ...base, round, ok: false, toolCalls: 0, durationMs: 0, error: pre.error });
    return { report: `[unavailable: ${identity.id} — ${pre.error}]`, status, inputTokens: 0, outputTokens: 0 };
  }

  onEvent?.({ type: 'team.member.started', ...base, round });

  const pool = opts.pool ?? new AgentPool(1);
  let slot: AgentPoolSlot | undefined;
  let sdk: Awaited<ReturnType<typeof CreateAgentSdk>> | undefined;

  try {
    slot = await pool.acquire(timeoutMs);
    const { createAgentSdk } = await import('../runtime/agentClient.js');
    sdk = await createAgentSdk({
      model: member.model,
      provider: member.provider,
      baseURL: member.baseURL,
      authToken: resolveApiKey(member.apiKey),
      maxTokens: member.maxTokens ?? 32000,
      workDir: cwd,
      tools,
      permissionMode: opts.permissionMode ?? 'default',
      permissions: opts.permissions,
      classifier: opts.classifier,
      approver: opts.approver,
      hooks: opts.hooks,
      maxToolIterations: maxIterations,
      systemPrompt,
    });
    const stream = sdk.stream(task, { signal: memberSignal(signal, timeoutMs) });
    for await (const event of stream) {
      if (event.type === 'tool.call' && onEvent) {
        onEvent({ type: 'team.member.tool', id: identity.id, model: identity.model, round, tool: event.call.publicName });
      }
    }
    const result = await stream.result;
    const inputTokens = result.usage?.input_tokens ?? 0;
    const outputTokens = result.usage?.output_tokens ?? 0;
    const toolCalls = result.toolCalls.length;
    const durationMs = Date.now() - startedAt;
    const status: MemberStatus = { ...base, ok: true, toolCalls, durationMs };
    onEvent?.({ type: 'team.member.completed', ...base, round, ok: true, toolCalls, durationMs });
    return { report: result.text, status, inputTokens, outputTokens };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAt;
    const status: MemberStatus = { ...base, ok: false, error: message, toolCalls: 0, durationMs };
    onEvent?.({ type: 'team.member.completed', ...base, round, ok: false, toolCalls: 0, durationMs, error: message });
    return { report: `[ERROR: ${identity.id} (${identity.model}) failed — ${message}]`, status, inputTokens: 0, outputTokens: 0 };
  } finally {
    if (sdk) await sdk.close();
    slot?.release();
  }
}
