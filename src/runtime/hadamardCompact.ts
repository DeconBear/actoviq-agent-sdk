import type { MessageParam } from '../provider/types.js';
import type {
  HadamardCompactBoundaryMetadata,
  HadamardCompactTrigger,
  HadamardCompactConfig,
  HadamardMicrocompactBoundaryMetadata,
  HadamardSessionCompactResult,
  HadamardSessionMemoryRuntimeState,
  HadamardTranscriptBoundary,
  AgentSessionCompactOptions,
  ModelApi,
  ModelRequest,
  StoredSession,
} from '../types.js';
import { HadamardProviderApiError } from '../errors.js';
import { extractTextFromContent } from './messageUtils.js';
import { nowIso } from './helpers.js';
import {
  estimateHadamardConversationTokens,
  filterHadamardMessagesForSessionMemory,
  serializeHadamardSessionMemoryRuntimeState,
} from '../memory/hadamardSessionMemoryState.js';

export const HADAMARD_COMPACT_STATE_KEY = '__hadamardCompactState';
export const HADAMARD_COMPACT_HISTORY_KEY = '__hadamardCompactHistory';
export const HADAMARD_MICROCOMPACT_CLEARED_MESSAGE = '[Old tool result content cleared]';
export const HADAMARD_RECENT_FILES_KEY = '__hadamardRecentFiles';
export const HADAMARD_RECENT_SKILLS_KEY = '__hadamardRecentSkills';
const MAX_RECENT_FILES = 5;
const MAX_RECENT_SKILLS = 5;

interface PersistedCompactState {
  compactCount: number;
  microcompactCount: number;
  consecutiveFailures: number;
  lastCompactedAt?: string;
  lastSummaryMessage?: string;
  lastTrigger?: HadamardCompactTrigger;
  lastFailureAt?: string;
  lastError?: string;
}

interface PersistedCompactHistoryEntry {
  kind: 'compact' | 'microcompact';
  timestamp: string;
  trigger: HadamardCompactTrigger;
  metadata?: HadamardCompactBoundaryMetadata | HadamardMicrocompactBoundaryMetadata;
  logicalParentUuid?: string | null;
}

const PROMPT_TOO_LONG_PATTERNS = [
  'prompt is too long',
  'prompt too long',
  'conversation too long',
  'context length',
  'too many input tokens',
  'input is too long',
  'request is too large',
];
const MAX_COMPACT_PROMPT_TOO_LONG_RETRIES = 3;
const MAX_COMPACT_SUMMARY_TOKENS = 20_000;
const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;
const compactionFailureCounts = new Map<string, number>();

export interface HadamardCompactExecutionContext {
  workDir: string;
  systemPrompt?: string;
  model: string;
  modelApi: ModelApi;
  compactConfig: HadamardCompactConfig;
  runtimeState: HadamardSessionMemoryRuntimeState;
  reportedInputTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getPersistedHadamardCompactState(
  metadata: Record<string, unknown> | undefined,
): PersistedCompactState {
  const raw = metadata?.[HADAMARD_COMPACT_STATE_KEY];
  if (!raw || typeof raw !== 'object') {
    return {
      compactCount: 0,
      microcompactCount: 0,
      consecutiveFailures: 0,
    };
  }

  const state = raw as Record<string, unknown>;
  return {
    compactCount: typeof state.compactCount === 'number' ? state.compactCount : 0,
    microcompactCount: typeof state.microcompactCount === 'number' ? state.microcompactCount : 0,
    consecutiveFailures:
      typeof state.consecutiveFailures === 'number' ? state.consecutiveFailures : 0,
    lastCompactedAt:
      typeof state.lastCompactedAt === 'string' ? state.lastCompactedAt : undefined,
    lastSummaryMessage:
      typeof state.lastSummaryMessage === 'string' ? state.lastSummaryMessage : undefined,
    lastTrigger:
      state.lastTrigger === 'auto' ||
      state.lastTrigger === 'manual' ||
      state.lastTrigger === 'reactive'
        ? state.lastTrigger
        : undefined,
    lastFailureAt:
      typeof state.lastFailureAt === 'string' ? state.lastFailureAt : undefined,
    lastError: typeof state.lastError === 'string' ? state.lastError : undefined,
  };
}

export function serializeHadamardCompactState(state: PersistedCompactState): Record<string, unknown> {
  return {
    compactCount: state.compactCount,
    microcompactCount: state.microcompactCount,
    consecutiveFailures: state.consecutiveFailures,
    lastCompactedAt: state.lastCompactedAt,
    lastSummaryMessage: state.lastSummaryMessage,
    lastTrigger: state.lastTrigger,
    lastFailureAt: state.lastFailureAt,
    lastError: state.lastError,
  };
}

export function getPersistedHadamardCompactHistory(
  metadata: Record<string, unknown> | undefined,
): HadamardTranscriptBoundary[] {
  const raw = metadata?.[HADAMARD_COMPACT_HISTORY_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry): HadamardTranscriptBoundary[] => {
    if (!isRecord(entry)) {
      return [];
    }

    const kind = entry.kind === 'compact' || entry.kind === 'microcompact' ? entry.kind : undefined;
    const uuid = typeof entry.uuid === 'string' ? entry.uuid : undefined;
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
    const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
    if (!kind || !uuid || !timestamp || !sessionId) {
      return [];
    }

    return [
      {
        kind,
        uuid,
        timestamp,
        sessionId,
        logicalParentUuid:
          typeof entry.logicalParentUuid === 'string' ? entry.logicalParentUuid : null,
        metadata: isRecord(entry.metadata)
          ? (entry.metadata as HadamardCompactBoundaryMetadata | HadamardMicrocompactBoundaryMetadata)
          : undefined,
        raw: entry,
      },
    ];
  });
}

function appendPersistedCompactHistory(
  session: StoredSession,
  entry: PersistedCompactHistoryEntry,
): void {
  const existing = getPersistedHadamardCompactHistory(session.metadata);
  const nextBoundary: HadamardTranscriptBoundary = {
    kind: entry.kind,
    uuid: `${session.id}:${existing.length + 1}:${entry.kind}`,
    timestamp: entry.timestamp,
    sessionId: session.id,
    logicalParentUuid: entry.logicalParentUuid ?? null,
    metadata: entry.metadata,
    raw: {
      kind: entry.kind,
      timestamp: entry.timestamp,
      trigger: entry.trigger,
      metadata: entry.metadata,
    },
  };
  const history = [...existing, nextBoundary].slice(-25);
  session.metadata[HADAMARD_COMPACT_HISTORY_KEY] = history.map(boundary => ({
    kind: boundary.kind,
    uuid: boundary.uuid,
    timestamp: boundary.timestamp,
    sessionId: boundary.sessionId,
    logicalParentUuid: boundary.logicalParentUuid,
    metadata: boundary.metadata,
  }));
}

function getLatestPersistedCompactBoundary(
  session: StoredSession,
): HadamardTranscriptBoundary | undefined {
  const history = getPersistedHadamardCompactHistory(session.metadata);
  return history.length > 0 ? history.at(-1) : undefined;
}

function getPersistedCompactContinuationDepth(
  session: StoredSession,
): number {
  return getPersistedHadamardCompactHistory(session.metadata).filter(
    boundary => boundary.kind === 'compact',
  ).length;
}

function compactToolResultContent(
  messages: readonly MessageParam[],
  config: HadamardCompactConfig,
): { messages: MessageParam[]; clearedCount: number; clearedToolIds: string[] } {
  const cloneMessages = (): MessageParam[] => messages.map(message => structuredClone(message));

  if (!config.microcompactEnabled) {
    return {
      messages: cloneMessages(),
      clearedCount: 0,
      clearedToolIds: [],
    };
  }

  const toolResultPositions: Array<{
    messageIndex: number;
    blockIndex: number;
    toolUseId?: string;
  }> = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      continue;
    }

    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex];
      if (!isRecord(block) || block.type !== 'tool_result') {
        continue;
      }
      const text = extractTextFromToolResultContent(block.content);
      if (text.length < config.microcompactMinContentChars) {
        continue;
      }
      toolResultPositions.push({
        messageIndex,
        blockIndex,
        toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
      });
    }
  }

  if (toolResultPositions.length <= config.microcompactKeepRecentToolResults) {
    return {
      messages: cloneMessages(),
      clearedCount: 0,
      clearedToolIds: [],
    };
  }

  const keepStart = Math.max(
    toolResultPositions.length - config.microcompactKeepRecentToolResults,
    0,
  );
  const clearPositions = toolResultPositions.slice(0, keepStart);
  const nextMessages = cloneMessages();
  const clearedToolIds = clearPositions
    .map(position => position.toolUseId)
    .filter((toolUseId): toolUseId is string => typeof toolUseId === 'string');

  for (const position of clearPositions) {
    const message = nextMessages[position.messageIndex];
    if (!message || !Array.isArray(message.content)) {
      continue;
    }
    const block = message.content[position.blockIndex];
    if (!isRecord(block) || block.type !== 'tool_result') {
      continue;
    }
    block.content = HADAMARD_MICROCOMPACT_CLEARED_MESSAGE;
  }

  return {
    messages: nextMessages,
    clearedCount: clearPositions.length,
    clearedToolIds,
  };
}

function truncateMessagesForCompactRetry(
  messages: readonly MessageParam[],
): MessageParam[] | undefined {
  if (messages.length <= 1) {
    return undefined;
  }

  const dropCount = Math.min(Math.max(1, Math.floor(messages.length * 0.2)), messages.length - 1);
  return messages.slice(dropCount);
}

function buildFailedCompactResult(
  session: StoredSession,
  persistedState: PersistedCompactState,
  trigger: HadamardCompactTrigger,
  tokenEstimateBefore: number,
  runtimeState: HadamardSessionMemoryRuntimeState,
  error: unknown,
): {
  session: StoredSession;
  result: HadamardSessionCompactResult;
} {
  const failedAt = nowIso();
  const failedSession = structuredClone(session);
  const message = error instanceof Error ? error.message : String(error);
  const consecutiveFailures = persistedState.consecutiveFailures + 1;
  failedSession.updatedAt = failedAt;
  failedSession.metadata[HADAMARD_COMPACT_STATE_KEY] =
    serializeHadamardCompactState({
      ...persistedState,
      consecutiveFailures,
      lastFailureAt: failedAt,
      lastError: message,
    });
  return {
    session: failedSession,
    result: {
      compacted: false,
      trigger,
      reason: 'failed',
      tokenEstimateBefore,
      compactCount: persistedState.compactCount,
      microcompactCount: persistedState.microcompactCount,
      consecutiveFailures,
      error: message,
      state: runtimeState,
    },
  };
}

function extractTextFromToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map(block => {
      if (!isRecord(block)) {
        return '';
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
      if (block.type === 'document' && isRecord(block.source) && typeof block.source.data === 'string') {
        return block.source.data;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Merge config-level compactInstructions with per-call summaryInstructions.
 * Per-call instructions take precedence and are appended after config-level.
 */
function mergeCompactInstructions(
  configInstructions: string | undefined,
  perCallInstructions: string | undefined,
): string | undefined {
  const parts: string[] = [];
  if (configInstructions?.trim()) parts.push(configInstructions.trim());
  if (perCallInstructions?.trim()) parts.push(perCallInstructions.trim());
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function buildCompactSummaryPrompt(
  notes: string,
  preservedMessagesCount: number,
  summaryInstructions?: string,
  promptMode: 'hybrid' | 'structured' | 'free' = 'hybrid',
): string {
  const customInstructions = summaryInstructions?.trim()
    ? `\nUser guidance for this summary (follow these priorities):\n${summaryInstructions.trim()}\n`
    : '';

  const preamble = [
    'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
    'You already have all the context you need in the conversation above.',
    'Tool calls will be REJECTED — you will fail the task.',
    '',
  ];

  const conversationBlock = [
    '',
    '<conversation_to_summarize>',
    notes,
    '</conversation_to_summarize>',
  ];

  if (promptMode === 'free') {
    // Codex-style: free-form handoff summary, minimal structural constraints.
    return [
      ...preamble,
      'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary',
      'for another LLM that will resume the task.',
      '',
      `The most recent ${preservedMessagesCount} messages will be kept verbatim after your summary; summarize only the earlier conversation shown below.`,
      '',
      'Include:',
      '- Current progress and key decisions made',
      '- Important context, constraints, or user preferences',
      '- What remains to be done (clear next steps)',
      '- Any critical data, examples, or references needed to continue',
      '- ALL user messages (non-tool) so no instruction or feedback is lost',
      '',
      'Be concise, structured, and focused on helping the next LLM seamlessly',
      'continue the work. Wrap the summary in <summary> tags.',
      customInstructions.trim(),
      ...conversationBlock,
    ].filter(Boolean).join('\n');
  }

  if (promptMode === 'structured') {
    // Legacy 9-section fixed format — best for weaker models that need rigid scaffolding.
    return [
      ...preamble,
      'Your task is to create a detailed summary of the earlier portion of this engineering conversation. The summary will replace those messages, so it must capture every technical detail, decision, and piece of state needed to continue the work without losing context.',
      `The most recent ${preservedMessagesCount} messages will be kept verbatim after your summary; summarize only the earlier conversation shown below.`,
      '',
      'Before writing the summary, wrap a brief private analysis in <analysis> tags: walk through the conversation chronologically and check you have identified the user requests, your actions, file changes, errors, and open work. The analysis is a scratchpad and will be discarded.',
      '',
      'Then write the summary inside <summary> tags with these sections:',
      '1. Primary Request and Intent: every explicit user request and the underlying goal, in detail.',
      '2. Key Technical Concepts: technologies, frameworks, and architectural decisions in play.',
      '3. Files and Code Sections: specific files examined, created, or modified; include the important code snippets or content fragments and why they matter.',
      '4. Errors and Fixes: every error hit, how it was fixed, and any user feedback on the fix.',
      '5. Problem Solving: problems solved so far and any ongoing troubleshooting state.',
      '6. All User Messages: a list of every non-tool user message, so no instruction or feedback is lost.',
      '7. Pending Tasks: work the user explicitly asked for that is not finished yet.',
      '8. Current Work: precisely what was being worked on immediately before this summary, with file names and code where applicable.',
      '9. Optional Next Step: the single next step that directly continues the most recent explicit request, with a supporting quote from the recent conversation; omit it if the last task was completed and nothing was queued.',
      customInstructions.trim(),
      ...conversationBlock,
    ].filter(Boolean).join('\n');
  }

  // Hybrid mode (default): adaptive sections + mandatory user-message preservation.
  return [
    ...preamble,
    'You are compacting a long-running engineering conversation. Your summary will REPLACE the earlier messages, so it must preserve all information needed to continue seamlessly.',
    `The most recent ${preservedMessagesCount} messages will be kept verbatim after your summary; summarize only the earlier conversation shown below.`,
    '',
    'Before writing the summary, wrap a brief private analysis in <analysis> tags: identify user requests, key actions, file changes, errors, and open work. The analysis is a scratchpad and will be discarded.',
    '',
    'Then write the summary inside <summary> tags. Adapt the structure to the conversation content:',
    '',
    'MANDATORY (always include):',
    '- All User Messages: list every non-tool user message verbatim or near-verbatim, so no instruction or feedback is lost.',
    '- Current State: what was being worked on immediately before this summary, with file names and code where applicable.',
    '- Pending Work: explicit user requests that remain unfinished, with clear next steps.',
    '',
    'ADAPTIVE (include when relevant, omit when not):',
    '- Key decisions and their rationale',
    '- Files modified/created with important code fragments',
    '- Errors encountered and how they were resolved',
    '- Technical concepts, frameworks, and architectural patterns in play',
    '- User preferences and constraints discovered during the session',
    '',
    'Principles:',
    '- Be dense and concise; prefer bullet points over prose.',
    '- Do NOT pad sections with irrelevant content — skip what does not apply.',
    '- Preserve exact file paths, function names, and error messages.',
    customInstructions.trim(),
    ...conversationBlock,
  ].filter(Boolean).join('\n');
}

/**
 * Strips the <analysis> scratchpad and unwraps <summary> tags from a compact
 * summary response. The analysis improves summary quality while drafting but
 * has no value once written; only the summary body re-enters the context.
 */
export function formatHadamardCompactSummary(raw: string): string {
  let formatted = raw.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '');
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch?.[1]) {
    formatted = summaryMatch[1];
  } else {
    formatted = formatted.replace(/<\/?summary>/gi, '');
  }
  return formatted.trim();
}

function buildPostCompactSummaryMessage(summary: string, trigger: HadamardCompactTrigger): MessageParam {
  return {
    role: 'user',
    content: `<system-reminder>\nThis session was ${trigger === 'auto' ? 'automatically' : trigger === 'manual' ? 'manually' : 'reactively'} compacted to save context. Earlier conversation summary:\n\n${summary}\n\nContinue directly from the preserved recent messages without asking the user to repeat prior context.\n</system-reminder>`,
  };
}

const SUMMARY_TOOL_RESULT_MAX_CHARS = 1_500;
const SUMMARY_TOOL_INPUT_MAX_CHARS = 400;

/**
 * Serialize messages for the compact summary request. Unlike
 * extractTextFromContent, this keeps tool_use names/inputs and truncated
 * tool_result text so the summary can reference concrete commands, files,
 * and errors from the session.
 */
function serializeMessagesForSummary(messages: readonly MessageParam[]): string {
  return messages
    .map(message => {
      const label = message.role === 'assistant' ? 'Assistant' : 'User';
      const body = serializeContentForSummary(message.content);
      return body ? `${label}:\n${body}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function serializeContentForSummary(content: MessageParam['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map(block => {
      if (!isRecord(block)) {
        return '';
      }
      switch (block.type) {
        case 'text':
          return typeof block.text === 'string' ? block.text : '';
        case 'thinking':
          return '';
        case 'tool_use': {
          const name = typeof block.name === 'string' ? block.name : 'tool';
          let input = '';
          try {
            input = JSON.stringify(block.input ?? {});
          } catch {
            input = '';
          }
          if (input.length > SUMMARY_TOOL_INPUT_MAX_CHARS) {
            input = `${input.slice(0, SUMMARY_TOOL_INPUT_MAX_CHARS)}…`;
          }
          return `[tool_use ${name}] ${input}`;
        }
        case 'tool_result': {
          const text = extractTextFromToolResultContent(block.content);
          if (!text) {
            return '[tool_result]';
          }
          const truncated =
            text.length > SUMMARY_TOOL_RESULT_MAX_CHARS
              ? `${text.slice(0, SUMMARY_TOOL_RESULT_MAX_CHARS)}… [truncated]`
              : text;
          return `[tool_result${block.is_error ? ' error' : ''}] ${truncated}`;
        }
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

export function trackRecentFile(session: StoredSession, filePath: string): void {
  const files: string[] = (
    Array.isArray(session.metadata[HADAMARD_RECENT_FILES_KEY])
      ? session.metadata[HADAMARD_RECENT_FILES_KEY]
      : []
  ) as string[];
  const deduped = files.filter((f) => f !== filePath);
  deduped.push(filePath);
  session.metadata[HADAMARD_RECENT_FILES_KEY] = deduped.slice(-MAX_RECENT_FILES);
}

export function trackRecentSkill(session: StoredSession, skillName: string): void {
  const skills: string[] = (
    Array.isArray(session.metadata[HADAMARD_RECENT_SKILLS_KEY])
      ? session.metadata[HADAMARD_RECENT_SKILLS_KEY]
      : []
  ) as string[];
  const deduped = skills.filter((s) => s !== skillName);
  deduped.push(skillName);
  session.metadata[HADAMARD_RECENT_SKILLS_KEY] = deduped.slice(-MAX_RECENT_SKILLS);
}

function buildPostCompactContextMessages(
  session: StoredSession,
): MessageParam[] {
  const messages: MessageParam[] = [];
  const recentFiles: string[] = (
    Array.isArray(session.metadata[HADAMARD_RECENT_FILES_KEY])
      ? session.metadata[HADAMARD_RECENT_FILES_KEY]
      : []
  ) as string[];
  const recentSkills: string[] = (
    Array.isArray(session.metadata[HADAMARD_RECENT_SKILLS_KEY])
      ? session.metadata[HADAMARD_RECENT_SKILLS_KEY]
      : []
  ) as string[];

  if (recentFiles.length > 0) {
    messages.push({
      role: 'user',
      content: `<system-reminder>\nRecently accessed files (may be relevant to continue):\n${recentFiles.map((f) => `- ${f}`).join('\n')}\n</system-reminder>`,
    });
  }

  if (recentSkills.length > 0) {
    messages.push({
      role: 'user',
      content: `<system-reminder>\nPreviously invoked skills:\n${recentSkills.map((s) => `- ${s}`).join('\n')}\n</system-reminder>`,
    });
  }

  return messages;
}

/**
 * Extend the preserve-start index backwards so that any tool_result blocks
 * in the preserved portion have their corresponding tool_use blocks also
 * preserved.  Without this, compaction can create orphaned tool_result
 * blocks that cause provider-side HTTP 400 errors ("unexpected tool_use_id").
 */
function extendPreserveToIncludeReferencedToolUses(
  messages: readonly MessageParam[],
  preserveStart: number,
): number {
  if (preserveStart <= 0 || preserveStart >= messages.length) {
    return preserveStart;
  }

  const kept = messages.slice(preserveStart);
  const referencedIds = new Set<string>();
  for (const msg of kept) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (
        isRecord(block) &&
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        referencedIds.add(block.tool_use_id);
      }
    }
  }

  if (referencedIds.size === 0) return preserveStart;

  // Walk backwards from preserveStart - 1 to find assistant messages that
  // contain any of the referenced tool_use blocks.  Extend preserveStart
  // to include the earliest such assistant message.
  let extended = preserveStart;
  for (let i = preserveStart - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (
        isRecord(block) &&
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        referencedIds.has(block.id)
      ) {
        referencedIds.delete(block.id);
        extended = Math.min(extended, i);
      }
    }
    if (referencedIds.size === 0) break;
  }

  return extended;
}

export async function compactHadamardSession(
  session: StoredSession,
  options: AgentSessionCompactOptions & { trigger: HadamardCompactTrigger },
  context: HadamardCompactExecutionContext,
): Promise<{
  session: StoredSession;
  result: HadamardSessionCompactResult;
}> {
  const persistedState = getPersistedHadamardCompactState(session.metadata);
  const consecutiveFailures = persistedState.consecutiveFailures;
  if (consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
    return {
      session,
      result: {
        compacted: false,
        trigger: options.trigger,
        reason: 'circuit_breaker_open',
        tokenEstimateBefore: estimateHadamardConversationTokens(session.messages),
        compactCount: persistedState.compactCount,
        microcompactCount: persistedState.microcompactCount,
        consecutiveFailures,
        error: persistedState.lastError,
        state: context.runtimeState,
      },
    };
  }

  const filteredMessages = filterHadamardMessagesForSessionMemory(session.messages);
  const compactableMessages =
    options.trigger === 'reactive' &&
    filteredMessages.length < 2 &&
    session.messages.length > filteredMessages.length
      ? session.messages.map(message => structuredClone(message))
      : filteredMessages;
  // Estimate against the real session prefix. Microcompact is only a
  // preprocess for full summary — never a standalone mutation that would
  // break automatic prompt-prefix caches used by createAgentSdk / hadamard-tui.
  const localTokenEstimate = estimateHadamardConversationTokens(compactableMessages);
  const tokenEstimateBefore = context.reportedInputTokens ?? localTokenEstimate;
  const microcompacted = compactToolResultContent(compactableMessages, context.compactConfig);

  if (!context.compactConfig.enabled) {
    return {
      session,
      result: {
        compacted: false,
        trigger: options.trigger,
        reason: 'disabled',
        tokenEstimateBefore,
        compactCount: persistedState.compactCount,
        microcompactCount: persistedState.microcompactCount,
        state: context.runtimeState,
      },
    };
  }

  if (compactableMessages.length === 0) {
    return {
      session,
      result: {
        compacted: false,
        trigger: options.trigger,
        reason: 'no_messages',
        tokenEstimateBefore,
        compactCount: persistedState.compactCount,
        microcompactCount: persistedState.microcompactCount,
        state: context.runtimeState,
      },
    };
  }

  const effectiveThreshold = resolveHadamardCompactBudget(
    context.compactConfig,
  ).autoCompactTokenLimit;

  if (!options.force && tokenEstimateBefore < effectiveThreshold) {
    return {
      session,
      result: {
        compacted: false,
        trigger: options.trigger,
        reason: 'threshold_not_met',
        tokenEstimateBefore,
        compactCount: persistedState.compactCount,
        microcompactCount: persistedState.microcompactCount,
        state: context.runtimeState,
      },
    };
  }

  let preserveStart = resolvePreserveStartIndex(
    microcompacted.messages,
    context.compactConfig,
    options.preserveRecentMessages,
  );

  // Extend preserve window backwards to include tool_use blocks referenced
  // by tool_result blocks in the preserved portion. Without this, compaction
  // can create orphaned tool_result blocks that cause provider-side
  // "unexpected tool_use_id" HTTP 400 errors.
  preserveStart = extendPreserveToIncludeReferencedToolUses(
    microcompacted.messages,
    preserveStart,
  );

  const messagesToSummarize = microcompacted.messages.slice(0, preserveStart);
  const messagesToKeep = microcompacted.messages.slice(preserveStart);

  if (messagesToSummarize.length === 0) {
    return {
      session,
      result: {
        compacted: false,
        trigger: options.trigger,
        reason: 'threshold_not_met',
        tokenEstimateBefore,
        compactCount: persistedState.compactCount,
        microcompactCount: persistedState.microcompactCount,
        state: context.runtimeState,
      },
    };
  }

  let retryCount = 0;
  let droppedMessages = 0;
  let retryMessagesToSummarize = messagesToSummarize;
  let response: Awaited<ReturnType<ModelApi['createMessage']>>;

  while (true) {
    try {
      const rewritePrompt = buildCompactSummaryPrompt(
        serializeMessagesForSummary(retryMessagesToSummarize),
        messagesToKeep.length,
        mergeCompactInstructions(context.compactConfig.compactInstructions, options.summaryInstructions),
        context.compactConfig.compactPromptMode ?? 'hybrid',
      );

      const request: ModelRequest = {
        model: options.model ?? context.model,
        max_tokens: Math.min(
          options.maxTokens ?? context.compactConfig.maxSummaryTokens,
          MAX_COMPACT_SUMMARY_TOKENS,
        ),
        system:
          'You are compacting a long-running engineering session. Produce a dense but concise continuation summary.',
        metadata: {
          hadamard_internal_task: 'compact',
          hadamard_compact_retry_count: retryCount,
        },
        messages: [
          {
            role: 'user',
            content: rewritePrompt,
          },
        ],
        signal: options.signal,
      };
      response = await context.modelApi.createMessage(request);
      break;
    } catch (error) {
      if (
        retryCount >= MAX_COMPACT_PROMPT_TOO_LONG_RETRIES ||
        !isHadamardPromptTooLongError(error)
      ) {
        return buildFailedCompactResult(
          session,
          persistedState,
          options.trigger,
          tokenEstimateBefore,
          context.runtimeState,
          error,
        );
      }

      const truncated = truncateMessagesForCompactRetry(retryMessagesToSummarize);
      if (!truncated) {
        return buildFailedCompactResult(
          session,
          persistedState,
          options.trigger,
          tokenEstimateBefore,
          context.runtimeState,
          error,
        );
      }

      droppedMessages += retryMessagesToSummarize.length - truncated.length;
      retryMessagesToSummarize = truncated;
      retryCount += 1;
    }
  }
  const summary = formatHadamardCompactSummary(extractTextFromContent(response.content));
  if (!summary) {
    return buildFailedCompactResult(
      session,
      persistedState,
      options.trigger,
      tokenEstimateBefore,
      context.runtimeState,
      new Error('Compaction returned an empty summary.'),
    );
  }
  const compactedAt = nowIso();
  const nextRuntimeState: HadamardSessionMemoryRuntimeState = {
    ...context.runtimeState,
    pendingPostCompaction: false,
  };

  const contextMessages = buildPostCompactContextMessages(session);
  const nextMessages = [
    buildPostCompactSummaryMessage(summary, options.trigger),
    ...contextMessages,
    ...messagesToKeep,
  ];
  const nextSession = structuredClone(session);
  const latestBoundary = getLatestPersistedCompactBoundary(nextSession);
  const continuationDepth = getPersistedCompactContinuationDepth(nextSession) + 1;
  nextSession.messages = nextMessages;
  nextSession.updatedAt = compactedAt;
  nextSession.metadata[HADAMARD_COMPACT_STATE_KEY] = serializeHadamardCompactState({
    compactCount: persistedState.compactCount + 1,
    microcompactCount: persistedState.microcompactCount + microcompacted.clearedCount,
    consecutiveFailures: 0,
    lastCompactedAt: compactedAt,
    lastSummaryMessage: summary,
    lastTrigger: options.trigger,
  });
  nextSession.metadata.__hadamardCompactSummary = summary;
  nextSession.metadata.__hadamardCompactTrigger = options.trigger;
  nextSession.metadata.__hadamardCompactPreservedMessages = messagesToKeep.length;
  nextSession.metadata.__hadamardSessionMemoryState =
    serializeHadamardSessionMemoryRuntimeState(nextRuntimeState);
  appendPersistedCompactHistory(nextSession, {
    kind: 'compact',
    timestamp: compactedAt,
    trigger: options.trigger,
    logicalParentUuid: latestBoundary?.uuid,
    metadata: {
      trigger: options.trigger,
      preTokens: tokenEstimateBefore,
      messagesSummarized: retryMessagesToSummarize.length,
      preservedMessages: messagesToKeep.length,
      droppedMessages,
      retryCount,
      continuationDepth,
      userContext: summary,
    },
  });

  return {
    session: nextSession,
    result: {
      compacted: true,
      trigger: options.trigger,
      reason: 'compacted',
      tokenEstimateBefore,
      tokenEstimateAfter: estimateHadamardConversationTokens(nextMessages),
      summaryMessage: summary,
      messagesRemoved: retryMessagesToSummarize.length + droppedMessages,
      compactCount: persistedState.compactCount + 1,
      microcompactCount: persistedState.microcompactCount + microcompacted.clearedCount,
      state: nextRuntimeState,
    },
  };
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;
const DEFAULT_AUTO_COMPACT_PERCENT = 90;

export interface HadamardCompactBudget {
  rawContextWindowTokens: number;
  effectiveContextWindowTokens: number;
  autoCompactTokenLimit: number;
  source: 'explicit' | 'derived' | 'fallback';
}

export function resolveHadamardCompactBudget(
  config: HadamardCompactConfig,
): HadamardCompactBudget {
  const configuredWindow = positiveInteger(config.contextWindowTokens);
  const maxWindow = positiveInteger(config.maxContextWindowTokens);
  const rawContextWindowTokens = Math.max(
    1,
    maxWindow == null
      ? configuredWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS
      : Math.min(configuredWindow ?? maxWindow, maxWindow),
  );
  const percent = Math.min(
    Math.max(config.effectiveContextWindowPercent ?? DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT, 1),
    100,
  );
  const derivedLimit = Math.max(
    1,
    Math.floor(rawContextWindowTokens * DEFAULT_AUTO_COMPACT_PERCENT / 100),
  );
  const explicitLimit = positiveInteger(config.autoCompactTokenLimit)
    ?? positiveInteger(config.loopAutoCompactThresholdTokens)
    ?? positiveInteger(config.autoCompactThresholdTokens);
  return {
    rawContextWindowTokens,
    effectiveContextWindowTokens: Math.max(
      1,
      Math.floor(rawContextWindowTokens * percent / 100),
    ),
    autoCompactTokenLimit: Math.min(explicitLimit ?? derivedLimit, derivedLimit),
    source: explicitLimit != null
      ? 'explicit'
      : config.contextWindowSource === 'fallback' || configuredWindow == null
        ? 'fallback'
        : configuredWindow != null
        ? 'derived'
        : 'fallback',
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function resolvePreserveStartIndex(
  messages: readonly MessageParam[],
  config: HadamardCompactConfig,
  preserveRecentMessagesOverride?: number,
): number {
  if (preserveRecentMessagesOverride != null || config.preserveRecentUserTokens == null) {
    const count = Math.max(
      preserveRecentMessagesOverride ?? config.preserveRecentMessages,
      1,
    );
    return Math.max(messages.length - count, 0);
  }
  const budget = Math.max(config.preserveRecentUserTokens, 1);
  let start = Math.max(messages.length - 1, 0);
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const tokens = estimateHadamardConversationTokens([messages[index]!]);
    if (used > 0 && used + tokens > budget) break;
    used += tokens;
    start = index;
    if (used >= budget) break;
  }
  return start;
}

export interface HadamardLoopCompactContext {
  model: string;
  modelApi: ModelApi;
  compactConfig: HadamardCompactConfig;
  /** max_tokens reserved for the model response in regular requests. */
  maxTokens: number;
  /**
   * Real input token count reported by the previous provider response. When
   * available this includes system/tool overhead that the local message-only
   * estimate cannot see, so it is a better trigger for the next in-loop compact.
   */
  lastRequestInputTokens?: number;
  /**
   * Rolling calibration derived from provider usage versus local estimates.
   * This keeps proactive compaction useful immediately after a compact, when
   * no directly comparable previous request remains.
   */
  tokenEstimateMultiplier?: number;
  /** Baseline tokens carried into a body-after-prefix compact window. */
  compactWindowPrefixTokens?: number;
  fixedInputTokens?: number;
  /** Circuit-breaker key; use the runId so one bad run cannot poison others. */
  runKey: string;
  signal?: AbortSignal;
  /**
   * Reactive mode: the provider already rejected the request as too long, so
   * token estimates are known to undercount. Skips threshold checks and goes
   * all the way to summary compaction even when microcompact alone would
   * appear sufficient. Only `compactConfig.enabled === false` still disables.
   */
  force?: boolean;
  /**
   * Per-call summary instructions merged with config-level compactInstructions.
   * Allows the ReAct loop caller to inject task-specific guidance.
   */
  summaryInstructions?: string;
}

export interface HadamardLoopCompactOutcome {
  messages: MessageParam[];
  compacted: boolean;
  tokenEstimateBefore: number;
  tokenEstimateAfter: number;
  messagesSummarized: number;
  preservedMessages: number;
  clearedToolResults: number;
  summary?: string;
  reason?: 'disabled' | 'threshold_not_met' | 'microcompact' | 'compacted' | 'failed' | 'circuit_breaker_open';
  consecutiveFailures?: number;
  error?: string;
}

/**
 * Derive the in-loop auto-compact trigger from the configured context window,
 * mirroring Claude Code's `effective window - output reserve - buffer` shape.
 */
export function getHadamardLoopAutoCompactThreshold(
  config: HadamardCompactConfig,
  _maxTokens: number,
): number {
  return resolveHadamardCompactBudget(config).autoCompactTokenLimit;
}

/**
 * In-loop (mid-run) auto-compact for a live conversation array.
 *
 * Unlike compactHadamardSession this operates on the in-flight ReAct loop
 * conversation, so a single long run with many tool calls cannot grow past
 * the context window. It never throws: on failure it records a circuit
 * breaker strike and returns the conversation unchanged so the run can
 * continue (the provider request may still succeed or trigger the
 * reactive-compact path).
 */
export async function compactHadamardConversationIfNeeded(
  messages: readonly MessageParam[],
  context: HadamardLoopCompactContext,
): Promise<HadamardLoopCompactOutcome> {
  const config = context.compactConfig;
  const tokenEstimateMultiplier = Math.min(
    Math.max(context.tokenEstimateMultiplier ?? 1, 0.5),
    8,
  );
  const tokenEstimateBefore = Math.ceil(
    (estimateHadamardConversationTokens(messages) + (context.fixedInputTokens ?? 0))
      * tokenEstimateMultiplier,
  );
  const unchanged: HadamardLoopCompactOutcome = {
    messages: [...messages],
    compacted: false,
    tokenEstimateBefore,
    tokenEstimateAfter: tokenEstimateBefore,
    messagesSummarized: 0,
    preservedMessages: messages.length,
    clearedToolResults: 0,
  };

  if (!config.enabled || (!context.force && config.loopAutoCompactEnabled === false)) {
    return { ...unchanged, reason: 'disabled' };
  }

  const threshold = getHadamardLoopAutoCompactThreshold(config, context.maxTokens);
  const activeTokens = context.lastRequestInputTokens ?? tokenEstimateBefore;
  const triggerTokens = config.autoCompactTokenLimitScope === 'body_after_prefix'
    ? Math.max(activeTokens - (context.compactWindowPrefixTokens ?? 0), 0)
    : activeTokens;
  if (!context.force && triggerTokens < threshold) {
    return { ...unchanged, reason: 'threshold_not_met' };
  }

  const failureKey = `loop:${context.runKey}`;
  const consecutiveFailures = compactionFailureCounts.get(failureKey) ?? 0;
  if (consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
    return {
      ...unchanged,
      reason: 'circuit_breaker_open',
      consecutiveFailures,
      error: 'In-loop compaction failed repeatedly.',
    };
  }

  // Stage 1: clear old large tool results only as preprocess for Stage 2
  // summary. Never write microcompact-only mutations back into the live
  // conversation — that breaks automatic prefix caches (DeepSeek, etc.).
  const microcompacted = compactToolResultContent(messages, config);

  // Stage 2: summarize older turns, preserving the recent tail and any
  // tool_use blocks referenced by preserved tool_results.
  let preserveStart = resolvePreserveStartIndex(microcompacted.messages, config);
  if (context.force && preserveStart === 0) {
    // Reactive recovery on a short conversation: the default preserve window
    // would leave nothing to summarize. Preserve only the last message so the
    // forced compact can still shrink the request.
    preserveStart = Math.max(microcompacted.messages.length - 1, 0);
  }
  preserveStart = extendPreserveToIncludeReferencedToolUses(
    microcompacted.messages,
    preserveStart,
  );

  const messagesToSummarize = microcompacted.messages.slice(0, preserveStart);
  const messagesToKeep = microcompacted.messages.slice(preserveStart);
  if (messagesToSummarize.length === 0 || messagesToKeep.length === 0) {
    return { ...unchanged, reason: 'threshold_not_met' };
  }

  let retryCount = 0;
  let retryMessagesToSummarize = messagesToSummarize;
  let response: Awaited<ReturnType<ModelApi['createMessage']>>;
  while (true) {
    try {
      const rewritePrompt = buildCompactSummaryPrompt(
        serializeMessagesForSummary(retryMessagesToSummarize),
        messagesToKeep.length,
        mergeCompactInstructions(config.compactInstructions, context.summaryInstructions),
        config.compactPromptMode ?? 'hybrid',
      );
      response = await context.modelApi.createMessage({
        model: context.model,
        max_tokens: Math.min(config.maxSummaryTokens, MAX_COMPACT_SUMMARY_TOKENS),
        system:
          'You are compacting a long-running engineering session. Produce a dense but concise continuation summary.',
        metadata: {
          hadamard_internal_task: 'loop_compact',
          hadamard_compact_retry_count: retryCount,
        },
        messages: [{ role: 'user', content: rewritePrompt }],
        signal: context.signal,
      });
      compactionFailureCounts.delete(failureKey);
      break;
    } catch (error) {
      if (
        retryCount < MAX_COMPACT_PROMPT_TOO_LONG_RETRIES &&
        isHadamardPromptTooLongError(error)
      ) {
        const truncated = truncateMessagesForCompactRetry(retryMessagesToSummarize);
        if (truncated) {
          retryMessagesToSummarize = truncated;
          retryCount += 1;
          continue;
        }
      }
      const nextFailures = consecutiveFailures + 1;
      compactionFailureCounts.set(failureKey, nextFailures);
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...unchanged,
        reason: 'failed',
        consecutiveFailures: nextFailures,
        error: message,
      };
    }
  }

  const summary = formatHadamardCompactSummary(extractTextFromContent(response.content));
  if (!summary) {
    const nextFailures = consecutiveFailures + 1;
    compactionFailureCounts.set(failureKey, nextFailures);
    return {
      ...unchanged,
      reason: 'failed',
      consecutiveFailures: nextFailures,
      error: 'Compaction returned an empty summary.',
    };
  }

  const nextMessages = [
    buildPostCompactSummaryMessage(summary, context.force ? 'reactive' : 'auto'),
    ...messagesToKeep,
  ];
  return {
    messages: nextMessages,
    compacted: true,
    tokenEstimateBefore,
    tokenEstimateAfter: Math.ceil(
      estimateHadamardConversationTokens(nextMessages) * tokenEstimateMultiplier,
    ),
    messagesSummarized: messagesToSummarize.length,
    preservedMessages: messagesToKeep.length,
    clearedToolResults: microcompacted.clearedCount,
    summary,
    reason: 'compacted',
  };
}

/**
 * Record in-loop conversation compactions (auto or reactive) on a persisted
 * session so compact state and boundary history stay coherent with the
 * summary boundaries that now live in the session messages.
 */
export function recordHadamardLoopCompactionsOnSession(
  session: StoredSession,
  compactions: readonly import('../types.js').AgentLoopCompactionRecord[],
): void {
  for (const compaction of compactions) {
    const persisted = getPersistedHadamardCompactState(session.metadata);
    const latestBoundary = getLatestPersistedCompactBoundary(session);
    const timestamp = nowIso();
    if (compaction.messagesSummarized > 0) {
      const continuationDepth = getPersistedCompactContinuationDepth(session) + 1;
      session.metadata[HADAMARD_COMPACT_STATE_KEY] = serializeHadamardCompactState({
      compactCount: persisted.compactCount + 1,
      microcompactCount: persisted.microcompactCount + compaction.clearedToolResults,
      consecutiveFailures: 0,
        lastCompactedAt: timestamp,
        lastSummaryMessage: compaction.summary ?? persisted.lastSummaryMessage,
        lastTrigger: compaction.trigger,
      });
      appendPersistedCompactHistory(session, {
        kind: 'compact',
        timestamp,
        trigger: compaction.trigger,
        logicalParentUuid: latestBoundary?.uuid,
        metadata: {
          trigger: compaction.trigger,
          preTokens: compaction.tokenEstimateBefore,
          messagesSummarized: compaction.messagesSummarized,
          preservedMessages: compaction.preservedMessages,
          continuationDepth,
          userContext: compaction.summary,
        },
      });
    } else if (compaction.clearedToolResults > 0) {
      session.metadata[HADAMARD_COMPACT_STATE_KEY] = serializeHadamardCompactState({
        ...persisted,
        microcompactCount: persisted.microcompactCount + compaction.clearedToolResults,
      });
      appendPersistedCompactHistory(session, {
        kind: 'microcompact',
        timestamp,
        trigger: compaction.trigger,
        logicalParentUuid: latestBoundary?.uuid,
        metadata: {
          trigger: compaction.trigger,
          preTokens: compaction.tokenEstimateBefore,
          tokensSaved: compaction.tokenEstimateBefore - compaction.tokenEstimateAfter,
        },
      });
    }
  }
}

export function isHadamardPromptTooLongError(error: unknown): boolean {
  if (error instanceof HadamardProviderApiError) {
    if (error.status === 400 || error.status === 413) {
      const normalized = error.message.toLowerCase();
      return PROMPT_TOO_LONG_PATTERNS.some(pattern => normalized.includes(pattern));
    }
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const normalized = error.message.toLowerCase();
  return PROMPT_TOO_LONG_PATTERNS.some(pattern => normalized.includes(pattern));
}
