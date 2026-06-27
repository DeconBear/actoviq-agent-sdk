/**
 * Multi-provider abstraction for the bridge SDK's directCli mode.
 *
 * The vendored-bundle path and the original Claude Code `-p` stream-json path
 * are both the `claude` provider. `pi` and `codex` reuse the same spawn +
 * line-by-line JSONL pipeline but speak their own wire protocols, so each
 * provider supplies four pieces the rest of `actoviqBridgeSdk.ts` stays
 * protocol-agnostic around:
 *
 *   1. executable resolution (which binary on PATH, default error message)
 *   2. argv construction (the provider's CLI flags + prompt placement)
 *   3. child-process env injection (provider-specific credential variables)
 *   4. event normalization (provider JSONL → the `system/assistant/result`
 *      trio `execute()` already switches on — plus claude content-block shape)
 *
 * Normalization is stateful (pi's session id arrives once in a header line;
 * codex's model is never in the stream; assistant text accumulates across
 * deltas), so each provider hands back a fresh normalizer per run.
 */

import type {
  ActoviqBridgeJsonEvent,
  ActoviqBridgeRunOptions,
  RuntimeProviderId,
} from '../types.js';

import { ActoviqBridgeProcessError } from '../errors.js';
import { mapActoviqEnvToAnthropicEnv } from '../config/anthropicEnvMapping.js';
import {
  findExecutableOnPath,
  isExecutable,
} from './bridgeExecResolver.js';

/**
 * Per-run state + the translate step. `translate(rawLine)` returns the
 * normalized event to forward, or `null` to drop the line (e.g. a provider
 * status event with no bridge equivalent). Multiple native events may map to
 * a single normalized event; one native event may also emit several.
 */
export interface BridgeEventNormalizer {
  translate(raw: Record<string, unknown>): ActoviqBridgeJsonEvent[];
}

export interface RuntimeProvider {
  readonly id: RuntimeProviderId;
  /** Binary name looked up on PATH when `executable` is not provided. */
  readonly pathBinary: string;
  /** Human-readable name for "not found on PATH" errors. */
  readonly displayName: string;

  resolveExecutable(explicitPath?: string): Promise<string>;
  buildArgs(prompt: string, options: ActoviqBridgeRunOptions): string[];
  /**
   * Build the child env. `settingsEnv` is the `~/.actoviq/settings.json` env
   * block; `baseEnv` is the inherited process env already filtered to
   * string values. Providers emit whatever credential variables their CLI
   * reads (claude: ANTHROPIC_*, pi/codex: their own).
   */
  buildChildEnv(
    baseEnv: Record<string, string>,
    settingsEnv: Record<string, string>,
    overrides?: Record<string, string>,
  ): Record<string, string>;
  /** A fresh normalizer for one run. */
  createNormalizer(): BridgeEventNormalizer;
}

/** Shared base for executable resolution (PATH lookup + explicit-path check). */
export abstract class BaseRuntimeProvider implements RuntimeProvider {
  abstract readonly id: RuntimeProviderId;
  abstract readonly pathBinary: string;
  abstract readonly displayName: string;

  async resolveExecutable(explicitPath?: string): Promise<string> {
    if (explicitPath) {
      if (!(await isExecutable(explicitPath))) {
        throw new ActoviqBridgeProcessError(
          `The configured executable was not found or is not executable: ${explicitPath}`,
        );
      }
      return explicitPath;
    }
    const pathCandidate = await findExecutableOnPath(this.pathBinary);
    if (pathCandidate) {
      return pathCandidate;
    }
    throw new ActoviqBridgeProcessError(
      `No "${this.pathBinary}" executable was found on PATH. Install ${this.displayName} or pass { executable } explicitly.`,
    );
  }

  abstract buildArgs(prompt: string, options: ActoviqBridgeRunOptions): string[];
  abstract buildChildEnv(
    baseEnv: Record<string, string>,
    settingsEnv: Record<string, string>,
    overrides?: Record<string, string>,
  ): Record<string, string>;
  abstract createNormalizer(): BridgeEventNormalizer;
}

/**
 * Build a single normalized event with common optional fields pre-stamped.
 * Normalizers route every native event through this so the downstream
 * `execute()` switch (system/assistant/result) and `runtimeInfoFromInitEvent`
 * keep working untouched.
 */
export function bridgeEvent(
  type: string,
  fields: Record<string, unknown> = {},
): ActoviqBridgeJsonEvent {
  return { type, ...fields } as ActoviqBridgeJsonEvent;
}

let currentProvider: RuntimeProvider | undefined;

export function getDefaultProviderId(): RuntimeProviderId {
  return 'claude';
}

export function resolveProvider(id?: RuntimeProviderId): RuntimeProvider {
  const resolved = id ?? getDefaultProviderId();
  if (resolved === 'claude') return claudeProvider;
  if (resolved === 'pi') return piProvider;
  if (resolved === 'codex') return codexProvider;
  throw new ActoviqBridgeProcessError(`Unknown bridge provider: ${String(resolved)}`);
}

/** Package-private seam for tests that need the ambient provider. */
export function _setCurrentProvider(provider: RuntimeProvider | undefined): void {
  currentProvider = provider;
}
export function _getCurrentProvider(): RuntimeProvider | undefined {
  return currentProvider;
}

// ---------------------------------------------------------------------------
// claude provider (stream-json — the original protocol)
// ---------------------------------------------------------------------------

class ClaudeProvider extends BaseRuntimeProvider {
  readonly id = 'claude' as const;
  readonly pathBinary = 'claude';
  readonly displayName = 'Claude Code (@anthropic-ai/claude-code)';

  buildArgs(prompt: string, _options: ActoviqBridgeRunOptions): string[] {
    // The full flag set lives in actoviqBridgeSdk.buildCliArgs(); claude is the
    // default and keeps using that builder. Other providers override buildArgs.
    // (buildCliArgs is invoked directly from actoviqBridgeSdk.ts for the claude
    // path; this indirection exists so the provider list is exhaustive.)
    return ['-p', prompt];
  }

  buildChildEnv(
    baseEnv: Record<string, string>,
    settingsEnv: Record<string, string>,
    overrides?: Record<string, string>,
  ): Record<string, string> {
    // Actoviq settings are the single source of model/credential config: derive
    // ANTHROPIC_* equivalents so the Claude Code-based child process does not
    // silently fall back to ~/.claude/settings.json or keychain credentials.
    // Derived values override inherited process.env ANTHROPIC_* entries, while
    // explicit ANTHROPIC_* keys in the settings env block and caller overrides win.
    return {
      ...baseEnv,
      ...mapActoviqEnvToAnthropicEnv(settingsEnv),
      ...settingsEnv,
      ...(overrides ?? {}),
    };
  }

  createNormalizer(): BridgeEventNormalizer {
    // claude's stream-json is already the canonical system/assistant/result shape.
    return { translate: raw => [raw as ActoviqBridgeJsonEvent] };
  }
}

// ---------------------------------------------------------------------------
// pi provider (pi -p --mode json)
// ---------------------------------------------------------------------------

class PiProvider extends BaseRuntimeProvider {
  readonly id = 'pi' as const;
  readonly pathBinary = 'pi';
  readonly displayName = 'pi CLI (@earendil-works/pi-coding-agent)';

  buildArgs(prompt: string, options: ActoviqBridgeRunOptions): string[] {
    const args = ['-p', '--mode', 'json'];
    // Ephemeral, non-interactive, no trust prompt — matches a headless bridge run.
    args.push('--no-session', '--no-approve');
    if (options.model) {
      // pi accepts "provider/id"; pass through unchanged.
      args.push('--model', options.model);
    }
    if (options.appendSystemPrompt) {
      args.push('--append-system-prompt', options.appendSystemPrompt);
    } else if (options.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt);
    }
    // pi takes the prompt as the final positional argument.
    args.push(prompt);
    return args;
  }

  buildChildEnv(
    baseEnv: Record<string, string>,
    settingsEnv: Record<string, string>,
    overrides?: Record<string, string>,
  ): Record<string, string> {
    // pi reads *_API_KEY by provider (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.).
    // We pass the Actoviq settings env through unchanged; callers set the
    // provider-specific key directly. No ANTHROPIC_* remapping for non-claude.
    return { ...baseEnv, ...settingsEnv, ...(overrides ?? {}) };
  }

  createNormalizer(): BridgeEventNormalizer {
    return new PiNormalizer();
  }
}

class PiNormalizer implements BridgeEventNormalizer {
  private sessionId: string | undefined;
  private cwd: string | undefined;
  private model: string | undefined;
  private initEmitted = false;
  private pendingAssistantText = '';

  translate(raw: Record<string, unknown>): ActoviqBridgeJsonEvent[] {
    const type = typeof raw.type === 'string' ? raw.type : '';

    if (type === 'session') {
      this.sessionId = typeof raw.id === 'string' ? raw.id : this.sessionId;
      this.cwd = typeof raw.cwd === 'string' ? raw.cwd : this.cwd;
      // No init emission yet — wait for agent_start so we mirror claude's
      // "runtime ready" semantics. The session header carries no model.
      return [];
    }

    if (type === 'agent_start' && !this.initEmitted) {
      this.initEmitted = true;
      const init = bridgeEvent('system', {
        subtype: 'init',
        session_id: this.sessionId ?? '',
        cwd: this.cwd,
        // pi exposes no tool/skill/agent catalog in its stream; introspection
        // methods will return empty/limited data for this provider.
        tools: [],
        mcp_servers: [],
        slash_commands: [],
        agents: [],
        skills: [],
        plugins: [],
        model: this.model,
      });
      return [init];
    }

    if (type === 'message_update') {
      // Assistant streaming deltas. Accumulate text; emit assistant text deltas
      // in the claude stream_event shape so existing delta consumers work.
      const ame = raw.assistantMessageEvent;
      if (isRecord(ame) && ame.type === 'text_delta' && typeof ame.delta === 'string') {
        this.pendingAssistantText += ame.delta;
        return [bridgeEvent('stream_event', {
          session_id: this.sessionId ?? '',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: ame.delta },
          },
        })];
      }
      return [];
    }

    if (type === 'message_end') {
      const message = raw.message;
      if (isRecord(message) && message.role === 'assistant') {
        // Capture model from the finalized assistant message (only place it appears).
        if (typeof message.model === 'string') {
          this.model = message.model;
        }
        const text = extractPiAssistantText(message);
        return [bridgeEvent('assistant', {
          session_id: this.sessionId ?? '',
          message: {
            role: 'assistant',
            content: text ? [{ type: 'text', text }] : [],
          },
        })];
      }
      return [];
    }

    if (type === 'agent_end') {
      return [bridgeEvent('result', {
        subtype: 'success',
        session_id: this.sessionId ?? '',
        is_error: false,
        result: this.pendingAssistantText,
        stop_reason: 'end_turn',
        num_turns: 1,
      })];
    }

    return [];
  }
}

function extractPiAssistantText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }
  return content
    .map(block => {
      if (!isRecord(block)) return '';
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .join('');
}

// ---------------------------------------------------------------------------
// codex provider (codex exec --json)
// ---------------------------------------------------------------------------

class CodexProvider extends BaseRuntimeProvider {
  readonly id = 'codex' as const;
  readonly pathBinary = 'codex';
  readonly displayName = 'Codex CLI (@openai/codex)';

  buildArgs(prompt: string, options: ActoviqBridgeRunOptions): string[] {
    const args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '--ephemeral'];
    // Autonomous: no approval prompt can block a non-TTY run.
    args.push('--dangerously-bypass-approvals-and-sandbox');
    if (options.model) {
      args.push('-m', options.model);
    }
    if (options.systemPrompt) {
      args.push('-c', `system_prompt="${options.systemPrompt.replace(/"/g, '\\"')}"`);
    }
    if (typeof options.maxTurns === 'number') {
      args.push('-c', `max_turns=${options.maxTurns}`);
    }
    args.push(prompt);
    return args;
  }

  buildChildEnv(
    baseEnv: Record<string, string>,
    settingsEnv: Record<string, string>,
    overrides?: Record<string, string>,
  ): Record<string, string> {
    // codex reads OPENAI_API_KEY / config.toml. Pass Actoviq env through.
    return { ...baseEnv, ...settingsEnv, ...(overrides ?? {}) };
  }

  createNormalizer(): BridgeEventNormalizer {
    return new CodexNormalizer();
  }
}

class CodexNormalizer implements BridgeEventNormalizer {
  private threadId: string | undefined;
  private initEmitted = false;

  translate(raw: Record<string, unknown>): ActoviqBridgeJsonEvent[] {
    const type = typeof raw.type === 'string' ? raw.type : '';

    if (type === 'thread.started') {
      this.threadId = typeof raw.thread_id === 'string' ? raw.thread_id : this.threadId;
      if (!this.initEmitted) {
        this.initEmitted = true;
        return [bridgeEvent('system', {
          subtype: 'init',
          session_id: this.threadId ?? '',
          // codex exec JSONL carries no model/tools catalog.
          tools: [],
          mcp_servers: [],
          slash_commands: [],
          agents: [],
          skills: [],
          plugins: [],
          model: undefined,
        })];
      }
      return [];
    }

    if (type === 'item.completed') {
      const item = raw.item;
      if (isRecord(item) && item.type === 'agent_message' && typeof item.text === 'string') {
        return [bridgeEvent('assistant', {
          session_id: this.threadId ?? '',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: item.text }],
          },
        })];
      }
      return [];
    }

    if (type === 'turn.completed') {
      return [bridgeEvent('result', {
        subtype: 'success',
        session_id: this.threadId ?? '',
        is_error: false,
        stop_reason: 'end_turn',
        num_turns: 1,
      })];
    }

    if (type === 'turn.failed' || type === 'error') {
      const message = typeof raw.message === 'string'
        ? raw.message
        : (isRecord(raw.error) && typeof raw.error.message === 'string' ? raw.error.message : 'codex run failed');
      return [bridgeEvent('result', {
        subtype: 'error',
        session_id: this.threadId ?? '',
        is_error: true,
        result: message,
        stop_reason: 'error',
        num_turns: 1,
      })];
    }

    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export const claudeProvider: RuntimeProvider = new ClaudeProvider();
export const piProvider: RuntimeProvider = new PiProvider();
export const codexProvider: RuntimeProvider = new CodexProvider();

export const BRIDGE_PROVIDERS: Record<RuntimeProviderId, RuntimeProvider> = {
  claude: claudeProvider,
  pi: piProvider,
  codex: codexProvider,
};
