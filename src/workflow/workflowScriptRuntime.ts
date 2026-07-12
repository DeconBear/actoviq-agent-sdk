/**
 * WorkflowScriptRuntime — executes dynamic workflow JavaScript scripts
 * in a trusted node:vm compatibility context with a Host Bridge for
 * agent()/parallel()/pipeline().
 *
 * node:vm is not a security boundary. Omitting fs/net/process reduces accidental
 * capability exposure; untrusted scripts require an isolated executor.
 */
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import type {
  WorkflowMeta,
  WorkflowScriptContext,
  WorkflowAgentOptions,
  WorkflowRunState,
  WorkflowResumeState,
  WorkflowAgentCallRecord,
  WorkflowPhaseProgress,
  WorkflowCacheEntry,
  WorkflowBudget,
  AgentToolDefinition,
} from '../types.js';
import type { ActoviqAgentClient } from '../runtime/agentClient.js';
import { ConfigurationError, RunAbortedError } from '../errors.js';

// ═══════════════════════════════════════════════════════════════════
//  StructuredOutput tool for schema enforcement (append mode)
// ═══════════════════════════════════════════════════════════════════

const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput';

function createStructuredOutputTool(schema: Record<string, unknown>): AgentToolDefinition {
  return {
    kind: 'local',
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description:
      'Return your final structured result. You MUST call this tool with your answer ' +
      'when you have completed the task. All fields in the schema are required unless marked optional.',
    inputSchema: {
      parse: (input: unknown) => input,
      _type: undefined,
    } as any,
    inputJsonSchema: schema,
    async execute(input: unknown) {
      return JSON.stringify(input);
    },
    interruptBehavior: 'block',
    isConcurrencySafe: () => true,
  };
}

function validateAgainstSchema(data: unknown, schema: Record<string, unknown>): { valid: boolean; errors?: string[] } {
  if (!schema.properties) return { valid: true };
  if (typeof data !== 'object' || data === null) {
    return { valid: false, errors: ['Output must be a JSON object.'] };
  }

  const errors: string[] = [];
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const required = (schema.required as string[]) ?? [];
  const dataObj = data as Record<string, unknown>;

  // Check required fields
  for (const field of required) {
    if (!(field in dataObj) || dataObj[field] === undefined) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Type check known fields
  for (const [key, propSchema] of Object.entries(props)) {
    if (key in dataObj && dataObj[key] !== undefined) {
      const type = propSchema.type;
      const value = dataObj[key];
      if (type === 'string' && typeof value !== 'string') {
        errors.push(`Field "${key}" must be a string, got ${typeof value}`);
      } else if (type === 'number' && typeof value !== 'number') {
        errors.push(`Field "${key}" must be a number, got ${typeof value}`);
      } else if (type === 'boolean' && typeof value !== 'boolean') {
        errors.push(`Field "${key}" must be a boolean, got ${typeof value}`);
      } else if (type === 'array' && !Array.isArray(value)) {
        errors.push(`Field "${key}" must be an array, got ${typeof value}`);
      }
    }
  }

  return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
}

function tryParseStructuredOutput(text: string): { parsed: unknown; json: string } | null {
  // Try to find JSON in the response (model may wrap it in text)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return { parsed: JSON.parse(jsonMatch[0]), json: jsonMatch[0] };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════

export interface WorkflowRuntimeOptions {
  sdk: ActoviqAgentClient;
  /** Required for the in-process node:vm compatibility executor. */
  trust?: 'trusted' | 'untrusted';
  /** Wall-clock and synchronous CPU deadline. Default: 60 seconds. */
  scriptTimeoutMs?: number;
  maxConcurrent?: number;
  budgetTotal?: number | null;
  signal?: AbortSignal;
  onEvent?: (event: any) => void;
  resumeState?: WorkflowResumeState;
  args?: any;
}

interface PendingAgentCall {
  id: string;
  prompt: string;
  opts: WorkflowAgentOptions;
  phase?: string;
  resolve: (result: any) => void;
  reject: (err: Error) => void;
}

// ═══════════════════════════════════════════════════════════════════
//  Cache key normalization
// ═══════════════════════════════════════════════════════════════════

function sortedJson(obj: unknown): string {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return JSON.stringify(obj.map(sortedJson));
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = (obj as Record<string, unknown>)[key];
  }
  return JSON.stringify(sorted);
}

function canonicalAgentKey(prompt: string, opts: WorkflowAgentOptions, phase?: string): string {
  return `${prompt}|${sortedJson(opts)}|${phase ?? ''}`;
}

// ═══════════════════════════════════════════════════════════════════
//  Script syntax check
// ═══════════════════════════════════════════════════════════════════

const BANNED_GLOBALS = ['Date', 'Math.random', 'process', 'require', 'import', 'fs', 'net', 'child_process'];

function validateScript(script: string): void {
  // Ban Date.now(), Math.random(), new Date() — break determinism for resume
  if (/Date\.now\s*\(/.test(script)) {
    throw new Error('Date.now() is not allowed in workflow scripts (breaks resume determinism).');
  }
  if (/Math\.random\s*\(/.test(script)) {
    throw new Error('Math.random() is not allowed in workflow scripts (breaks resume determinism).');
  }
  if (/new\s+Date\s*\(/.test(script)) {
    throw new Error('new Date() is not allowed in workflow scripts (breaks resume determinism).');
  }

  // Must have export const meta
  if (!/export\s+const\s+meta\s*=/.test(script)) {
    throw new Error('Workflow script must export const meta = { name, description, phases }.');
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Meta extraction
// ═══════════════════════════════════════════════════════════════════

function extractMeta(script: string): WorkflowMeta {
  const metaMatch = script.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\});/);
  if (!metaMatch) {
    throw new Error('Could not extract meta from workflow script.');
  }

  // Validate pure literal (no variables, function calls, template strings)
  const metaBlock = metaMatch[1]!;
  if (/[a-zA-Z_$]\s*\(/.test(metaBlock.replace(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g, '').replace(/`[\s\S]*?`/g, ''))) {
    throw new Error('Workflow meta must be a pure literal — no function calls or computed values.');
  }

  // Evaluate the already-literal-validated metadata in a separate VM context.
  try {
    const metadataContext = {};
    vm.createContext(metadataContext);
    const metaObj = vm.runInContext(`(${metaBlock})`, metadataContext) as WorkflowMeta;
    if (!metaObj.name || !metaObj.description) {
      throw new Error('Workflow meta must include name and description.');
    }
    return metaObj;
  } catch (err: any) {
    if (err.message?.includes('name') || err.message?.includes('description')) throw err;
    throw new Error(`Failed to parse workflow meta: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Host Bridge
// ═══════════════════════════════════════════════════════════════════

class HostBridge {
  private agentQueue: PendingAgentCall[] = [];
  private activeAgents = 0;
  private maxConcurrent: number;
  private totalAgents = 0;
  private readonly maxTotal = 1000;
  private signal?: AbortSignal;
  private sdk: ActoviqAgentClient;
  private cache: Map<string, WorkflowCacheEntry>;
  private resumeCompleted: Set<string>;
  private agentRecords: WorkflowAgentCallRecord[];
  private onEvent?: (event: any) => void;
  private runId: string;

  // Budget tracking
  private budgetTotal: number | null;
  private totalSpentTokens = 0;

  // Phase tracking
  private currentPhase: string | null = null;
  private phases: Map<string, WorkflowPhaseProgress> = new Map();
  private phaseOrder: string[] = [];
  private _logMessages: string[] = [];
  private _errors: WorkflowRunState['errors'] = [];

  constructor(options: WorkflowRuntimeOptions) {
    this.sdk = options.sdk;
    this.maxConcurrent = options.maxConcurrent ?? 16;
    this.budgetTotal = options.budgetTotal ?? null;
    this.signal = options.signal;
    this.onEvent = options.onEvent;
    this.runId = randomUUID();
    this.agentRecords = [];

    // Resume state
    this.cache = options.resumeState?.cache ?? new Map();
    this.resumeCompleted = options.resumeState?.completedAgentIds ?? new Set();

    // Restore phases from resume
    if (options.resumeState?.phases) {
      for (const phase of options.resumeState.phases) {
        this.phases.set(phase.title, phase);
        this.phaseOrder.push(phase.title);
      }
    }
  }

  // ── Budget ─────────────────────────────────────────────────────

  createBudget(): WorkflowBudget {
    return {
      total: this.budgetTotal,
      spent: () => this.totalSpentTokens,
      remaining: () => {
        if (this.budgetTotal === null) return Infinity;
        return Math.max(0, this.budgetTotal - this.totalSpentTokens);
      },
    };
  }

  // ── Phase ──────────────────────────────────────────────────────

  setPhase(title: string): void {
    this.currentPhase = title;
    if (!this.phases.has(title)) {
      const pp: WorkflowPhaseProgress = {
        title,
        agentCount: 0,
        completedCount: 0,
        failedCount: 0,
        totalTokens: 0,
        startedAt: new Date().toISOString(),
      };
      this.phases.set(title, pp);
      this.phaseOrder.push(title);
    }
    this.onEvent?.({
      type: 'workflow.phase.start',
      runId: this.runId,
      phase: title,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Log ────────────────────────────────────────────────────────

  log(message: string): void {
    this._logMessages.push(message);
    this.onEvent?.({
      type: 'workflow.log',
      runId: this.runId,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Agent ──────────────────────────────────────────────────────

  async agent(prompt: string, opts: WorkflowAgentOptions = {}): Promise<any> {
    const phase = opts.phase ?? this.currentPhase ?? undefined;
    const key = canonicalAgentKey(prompt, opts, phase);

    // Cache hit?
    const cached = this.cache.get(key);
    if (cached) {
      const record: WorkflowAgentCallRecord = {
        id: randomUUID(),
        prompt,
        opts,
        phase,
        result: cached.result,
        tokens: cached.tokens,
        durationMs: cached.durationMs,
        startedAt: cached.cachedAt,
        completedAt: cached.cachedAt,
        cached: true,
      };
      this.agentRecords.push(record);

      if (phase) {
        const pp = this.phases.get(phase);
        if (pp) {
          pp.agentCount++;
          pp.completedCount++;
          if (cached.tokens) pp.totalTokens += cached.tokens.input + cached.tokens.output;
        }
      }

      this.onEvent?.({
        type: 'workflow.agent.start',
        runId: this.runId,
        agentId: record.id,
        label: opts.label,
        phase,
        cached: true,
        timestamp: new Date().toISOString(),
      });
      this.onEvent?.({
        type: 'workflow.agent.done',
        runId: this.runId,
        agentId: record.id,
        phase,
        cached: true,
        durationMs: cached.durationMs,
        tokens: cached.tokens,
        timestamp: new Date().toISOString(),
      });

      return cached.result;
    }

    // Check budget
    if (this.budgetTotal !== null && this.totalSpentTokens >= this.budgetTotal) {
      throw new Error('Budget exhausted — cannot spawn more agents.');
    }

    // Check total cap
    if (this.totalAgents >= this.maxTotal) {
      throw new Error('Agent cap reached (1000 total per run).');
    }

    // Wait for concurrency slot
    while (this.activeAgents >= this.maxConcurrent) {
      if (this.signal?.aborted) throw new Error('Aborted.');
      await delay(50);
    }

    this.activeAgents++;
    this.totalAgents++;

    const record: WorkflowAgentCallRecord = {
      id: randomUUID(),
      prompt,
      opts,
      phase,
      startedAt: new Date().toISOString(),
      cached: false,
    };
    this.agentRecords.push(record);

    if (phase) {
      const pp = this.phases.get(phase);
      if (pp) pp.agentCount++;
    }

    this.onEvent?.({
      type: 'workflow.agent.start',
      runId: this.runId,
      agentId: record.id,
      label: opts.label,
      phase,
      cached: false,
      timestamp: record.startedAt,
    });

    try {
      // Execute via SDK
      const session = await this.sdk.createSession({
        title: opts.label ?? `workflow-agent-${record.id.slice(0, 8)}`,
      });

      // Build tool list: user tools + optional StructuredOutput for schema enforcement
      const userTools = opts.tools?.map((t) => this.sdk.getTool(t)).filter((t): t is any => t !== undefined) ?? [];
      const allTools = opts.schema
        ? [...userTools, createStructuredOutputTool(opts.schema)]
        : userTools;

      const maxRetries = 3;
      let lastResult: any;
      let finalTokens: { input: number; output: number } | undefined;

      let execResult = await session.send(prompt, {
        systemPrompt: undefined,
        model: opts.model,
        tools: allTools.length > 0 ? allTools : undefined,
        signal: this.signal,
        permissionMode: 'acceptEdits',
      });

      finalTokens = (execResult.usage?.input_tokens != null && execResult.usage?.output_tokens != null)
        ? { input: execResult.usage.input_tokens, output: execResult.usage.output_tokens }
        : undefined;

      if (!opts.schema) {
        lastResult = execResult.text;
      } else {
        // Schema enforcement with retry
        let validated = false;
        for (let attempt = 0; attempt < maxRetries && !validated; attempt++) {
          if (attempt > 0) {
            // Re-prompt on same session to fix output
            execResult = await session.send(
              'Your previous output did not match the required schema. ' +
              'Please call the StructuredOutput tool with the correct format.',
              {
                systemPrompt: undefined,
                model: opts.model,
                tools: allTools.length > 0 ? allTools : undefined,
                signal: this.signal,
                permissionMode: 'acceptEdits',
              },
            );
            const retryTokens = (execResult.usage?.input_tokens != null && execResult.usage?.output_tokens != null)
              ? { input: execResult.usage.input_tokens, output: execResult.usage.output_tokens }
              : undefined;
            if (retryTokens && finalTokens) {
              finalTokens.input += retryTokens.input;
              finalTokens.output += retryTokens.output;
            }
          }

          const parsed = tryParseStructuredOutput(execResult.text);
          if (parsed) {
            const validation = validateAgainstSchema(parsed.parsed, opts.schema);
            if (validation.valid) {
              lastResult = parsed.parsed;
              validated = true;
              break;
            }
            if (attempt < maxRetries - 1) {
              this.log(`Schema validation failed (attempt ${attempt + 1}): ${validation.errors?.join(', ')}`);
            }
          } else if (attempt < maxRetries - 1) {
            this.log(`No structured output found (attempt ${attempt + 1}), retrying...`);
          }
        }
        if (!validated) {
          lastResult = execResult.text; // Last attempt: return raw text
        }
      }

      record.result = lastResult;
      record.tokens = finalTokens;
      record.completedAt = new Date().toISOString();
      record.durationMs = new Date(record.completedAt).getTime() - new Date(record.startedAt).getTime();

      // Cache
      if (record.tokens) {
        this.totalSpentTokens += record.tokens.input + record.tokens.output;
      }
      this.cache.set(key, {
        key,
        result: record.result,
        tokens: record.tokens,
        durationMs: record.durationMs ?? 0,
        cachedAt: new Date().toISOString(),
      });

      if (phase && record.tokens) {
        const pp = this.phases.get(phase);
        if (pp) {
          pp.completedCount++;
          pp.totalTokens += record.tokens.input + record.tokens.output;
        }
      }

      this.onEvent?.({
        type: 'workflow.agent.done',
        runId: this.runId,
        agentId: record.id,
        phase,
        cached: false,
        durationMs: record.durationMs,
        tokens: record.tokens,
        timestamp: record.completedAt,
      });

      return record.result;
    } catch (err: any) {
      record.error = err.message;
      record.completedAt = new Date().toISOString();
      record.durationMs = new Date(record.completedAt).getTime() - new Date(record.startedAt).getTime();

      if (phase) {
        const pp = this.phases.get(phase);
        if (pp) pp.failedCount++;
      }

      this._errors.push({ agentId: record.id, phase, error: err.message });
      this.log(`Agent "${opts.label ?? record.id}" failed: ${err.message}`);

      this.onEvent?.({
        type: 'workflow.agent.done',
        runId: this.runId,
        agentId: record.id,
        phase,
        cached: false,
        durationMs: record.durationMs,
        error: err.message,
        timestamp: record.completedAt,
      });

      throw err;
    } finally {
      this.activeAgents = Math.max(0, this.activeAgents - 1);
    }
  }

  // ── Parallel ───────────────────────────────────────────────────

  async parallel<T>(thunks: Array<() => Promise<T>>): Promise<(T | null)[]> {
    if (thunks.length > 4096) {
      throw new Error('parallel() supports at most 4096 items.');
    }
    return Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await thunk();
        } catch {
          return null;
        }
      }),
    );
  }

  // ── Pipeline ───────────────────────────────────────────────────

  async pipeline<T, R>(
    items: T[],
    ...stages: Array<(prev: any, item: T, index: number) => Promise<R | null>>
  ): Promise<(R | null)[]> {
    if (items.length > 4096) {
      throw new Error('pipeline() supports at most 4096 items.');
    }

    const results: (R | null)[] = new Array(items.length).fill(null);
    const errors: Array<{ itemIndex: number; stageIndex: number; error: string }> = [];

    // Process each item through all stages independently (no barrier)
    const itemPromises = items.map(async (item, index) => {
      let current: any = null;

      for (let si = 0; si < stages.length; si++) {
        const stage = stages[si]!;
        try {
          const result = await stage(current, item, index);
          if (result === null) {
            // Item skipped
            return null;
          }
          current = result;
        } catch (err: any) {
          errors.push({ itemIndex: index, stageIndex: si, error: err.message });
          this._errors.push({
            agentId: `pipeline-${index}-${si}`,
            error: err.message,
            itemIndex: index,
            stageIndex: si,
          });
          return null; // Item dropped, other items continue
        }
      }

      results[index] = current as R;
      return current;
    });

    await Promise.all(itemPromises);

    // Auto-report failure stats
    if (errors.length > 0) {
      this.log(`${errors.length}/${items.length} items failed across pipeline stages.`);
    }

    return results;
  }

  // ── State snapshot for resume ──────────────────────────────────

  getResumeState(): WorkflowResumeState {
    return {
      runId: this.runId,
      cache: this.cache,
      agentCallIds: this.agentRecords.map((r) => r.id),
      completedAgentIds: new Set(
        this.agentRecords.filter((r) => r.completedAt).map((r) => r.id),
      ),
      phases: [...this.phases.values()],
      errors: [...this._errors],
    };
  }

  getRunState(): WorkflowRunState {
    return {
      runId: this.runId,
      meta: { name: '', description: '' },
      status: 'running',
      phases: [...this.phases.values()],
      agentCalls: this.agentRecords,
      errors: [...this._errors],
      startedAt: '',
      totalTokens: this.totalSpentTokens,
      estimatedCost: null,
    };
  }

  getLogMessages(): string[] {
    return [...this._logMessages];
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Script Runtime
// ═══════════════════════════════════════════════════════════════════

export class WorkflowScriptRuntime {
  private options: WorkflowRuntimeOptions;

  constructor(options: WorkflowRuntimeOptions) {
    this.options = options;
  }

  async execute(script: string): Promise<{
    result: any;
    state: WorkflowRunState;
    resumeState: WorkflowResumeState;
    logs: string[];
  }> {
    if (this.options.trust !== 'trusted') {
      throw new ConfigurationError(
        'WorkflowScriptRuntime uses node:vm, which is only available for explicitly trusted scripts. Use an isolated WorkflowExecutor for untrusted input.',
      );
    }
    // Validate
    validateScript(script);

    // Extract meta
    const meta = extractMeta(script);

    const scriptTimeoutMs = normalizeScriptTimeout(this.options.scriptTimeoutMs);
    const deadlineController = new AbortController();
    const signal = this.options.signal
      ? AbortSignal.any([this.options.signal, deadlineController.signal])
      : deadlineController.signal;
    const bridge = new HostBridge({ ...this.options, signal });

    // Build the restricted host API exposed to the trusted compatibility context.
    const hostApi: WorkflowScriptContext = {
      agent: (prompt: string, opts?: WorkflowAgentOptions) =>
        bridge.agent(prompt, opts),
      parallel: <T>(thunks: Array<() => Promise<T>>) =>
        bridge.parallel(thunks),
      pipeline: <T, R>(
        items: T[],
        ...stages: Array<(prev: any, item: T, index: number) => Promise<R | null>>
      ) => bridge.pipeline(items, ...stages),
      phase: (title: string) => bridge.setPhase(title),
      log: (message: string) => bridge.log(message),
      budget: bridge.createBudget(),
      args: this.options.args,
      meta,
    };

    // Strip the `export const meta = ...` block and execute the script body
    const body = script.replace(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\};/, '').trim();

    // Wrap in async IIFE (vm.runInContext doesn't support top-level await).
    // Wrap in an async IIFE and return its result.
    const wrappedScript = [
      `(async () => {`,
      `const { agent, parallel, pipeline, phase, log, budget, args, meta } = __hostApi__;`,
      body,
      `}).call(null);`,
    ].join('\n');

    this.options.onEvent?.({
      type: 'workflow.script.start',
      runId: bridge.getRunState().runId,
      workflowName: meta.name,
      phases: meta.phases,
      timestamp: new Date().toISOString(),
    });

    const startedAt = Date.now();

    try {
      // node:vm is a trusted compatibility mechanism, not a security sandbox.
      const vmContext = vm.createContext({
        __hostApi__: hostApi,
        console: {
          log: (...args: any[]) => bridge.log(args.map(String).join(' ')),
          error: (...args: any[]) => bridge.log(`[ERROR] ${args.map(String).join(' ')}`),
        },
        setTimeout: () => { throw new Error('setTimeout is not available in workflow scripts.'); },
        setInterval: () => { throw new Error('setInterval is not available in workflow scripts.'); },
        clearTimeout: () => {},
        clearInterval: () => {},
        process: undefined,
        require: undefined,
        import: undefined,
        fs: undefined,
        net: undefined,
        child_process: undefined,
      });

      const execution = Promise.resolve(vm.runInContext(wrappedScript, vmContext, {
        filename: `workflow-${meta.name}.js`,
        timeout: scriptTimeoutMs,
      }));
      const result = await raceWorkflowDeadline(
        execution,
        scriptTimeoutMs,
        deadlineController,
        this.options.signal,
      );

      const durationMs = Date.now() - startedAt;
      const state = bridge.getRunState();
      state.meta = meta;
      state.startedAt = new Date(startedAt).toISOString();
      state.completedAt = new Date().toISOString();
      state.status = 'completed';

      this.options.onEvent?.({
        type: 'workflow.script.done',
        runId: state.runId,
        workflowName: meta.name,
        status: 'completed',
        durationMs,
        agentCount: state.agentCalls.length,
        totalTokens: state.totalTokens,
        errors: state.errors.length > 0 ? state.errors : undefined,
        timestamp: new Date().toISOString(),
      });

      return {
        result,
        state,
        resumeState: bridge.getResumeState(),
        logs: bridge.getLogMessages(),
      };
    } catch (err: any) {
      const durationMs = Date.now() - startedAt;
      const state = bridge.getRunState();
      state.meta = meta;
      state.startedAt = new Date(startedAt).toISOString();
      state.completedAt = new Date().toISOString();
      state.status = 'failed';
      state.errors.push({ agentId: 'script', error: err.message });

      this.options.onEvent?.({
        type: 'workflow.script.done',
        runId: state.runId,
        workflowName: meta.name,
        status: 'failed',
        durationMs,
        agentCount: state.agentCalls.length,
        totalTokens: state.totalTokens,
        errors: state.errors,
        timestamp: new Date().toISOString(),
      });

      throw err;
    }
  }
}

function normalizeScriptTimeout(value: number | undefined): number {
  if (value == null) {
    return 60_000;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError('scriptTimeoutMs must be a positive safe integer.');
  }
  return value;
}

async function raceWorkflowDeadline<T>(
  execution: Promise<T>,
  timeoutMs: number,
  deadlineController: AbortController,
  parentSignal?: AbortSignal,
): Promise<T> {
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, deadlineController.signal])
    : deadlineController.signal;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      const reason = signal.reason;
      finish(() => reject(new RunAbortedError(
        reason instanceof Error ? reason.message : 'The workflow run was aborted.',
        { cause: reason },
      )));
    };
    const timer = setTimeout(() => {
      deadlineController.abort(
        new Error(`Workflow script exceeded its ${timeoutMs}ms deadline.`),
      );
    }, timeoutMs);
    if (typeof timer === 'object') {
      timer.unref?.();
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    execution.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
