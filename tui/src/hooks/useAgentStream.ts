import { useState, useRef, useCallback } from 'react';
import type { AgentSession, AgentRunResult } from 'actoviq-agent-sdk';
import type { UIMessage, ContentBlock, AgentPhase } from '../context.js';

export interface UseAgentStreamOptions {
  model?: string;
  onPermissionRequest?: (
    toolName: string,
    args: Record<string, unknown>,
    toolDescription?: string,
  ) => Promise<boolean>;
  signal?: AbortSignal;
}

export function useAgentStream() {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingBlocks, setStreamingBlocks] = useState<ContentBlock[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [phase, setPhase] = useState<AgentPhase>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  const pendingToolsRef = useRef(0);
  const inWorkflowRef = useRef(false);
  const inStepRef = useRef(false);

  // Throttle mechanism: batches rapid setStreamingBlocks calls (e.g. text deltas)
  // to prevent per-token terminal repaints that break scroll position.
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingBlocks = useRef<ContentBlock[] | null>(null);

  const scheduleUpdate = useCallback((blocks: ContentBlock[], immediate = false) => {
    if (immediate) {
      if (throttleTimer.current) {
        clearTimeout(throttleTimer.current);
        throttleTimer.current = null;
      }
      pendingBlocks.current = null;
      setStreamingBlocks(blocks);
      return;
    }
    pendingBlocks.current = blocks;
    if (!throttleTimer.current) {
      throttleTimer.current = setTimeout(() => {
        throttleTimer.current = null;
        if (pendingBlocks.current) {
          setStreamingBlocks(pendingBlocks.current);
          pendingBlocks.current = null;
        }
      }, 50);
    }
  }, []);

  const flushPending = useCallback(() => {
    if (throttleTimer.current) {
      clearTimeout(throttleTimer.current);
      throttleTimer.current = null;
    }
    if (pendingBlocks.current) {
      setStreamingBlocks(pendingBlocks.current);
      pendingBlocks.current = null;
    }
  }, []);

  const send = useCallback(async (
    session: AgentSession,
    text: string,
    options?: UseAgentStreamOptions,
  ) => {
    if (sendingRef.current) return;
    sendingRef.current = true;

    setStreamingText('');
    setStreamingBlocks([]);
    setError(null);
    setResult(null);
    setStreaming(true);
    setPhase('waiting');
    pendingToolsRef.current = 0;
    inWorkflowRef.current = false;
    inStepRef.current = false;

    const userMsg: UIMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    const controller = new AbortController();
    abortRef.current = controller;

    let mergedSignalCleanup: (() => void) | undefined;
    let mergedSignal: AbortSignal = controller.signal;
    if (options?.signal) {
      const res = anySignal([options.signal, controller.signal]);
      mergedSignal = res.signal;
      mergedSignalCleanup = res.cleanup;
    }

    let blocks: ContentBlock[] = [];
    let currentIteration = 0;
    let currentText = '';
    let runId = '';
    let hasCompactBoundary = false;

    try {
      const stream = session.stream(text, { signal: mergedSignal, model: options?.model });

      for await (const event of stream) {
        switch (event.type) {
          case 'run.started': {
            runId = event.runId;
            setPhase('waiting');
            break;
          }

          case 'request.started': {
            currentIteration = event.iteration;
            flushPending();
            if (currentIteration > 0) {
              blocks = [...blocks, { type: 'separator', iteration: currentIteration, runId }];
              scheduleUpdate(blocks, true);
            }
            setPhase('waiting');
            break;
          }

          case 'response.text.delta': {
            currentText = event.snapshot ?? (currentText + event.delta);
            setStreamingText(currentText);
            const liveBlocks: ContentBlock[] = [
              ...blocks,
              ...(currentText ? [{ type: 'text' as const, text: currentText }] : []),
            ];
            scheduleUpdate(liveBlocks); // throttled — per-token, no immediate flush
            setPhase('generating');
            break;
          }

          case 'response.content': {
            const content = event.content as { type: string; text?: string; thinking?: string };
            if (content.type === 'thinking' && content.thinking) {
              blocks = [...blocks, { type: 'thinking', text: content.thinking, collapsed: false }];
              scheduleUpdate(blocks, true);
              setPhase('thinking');
            } else if (content.type === 'text' && content.text) {
              currentText = content.text;
              setStreamingText(currentText);
              scheduleUpdate(blocks, true);
              setPhase('generating');
            }
            break;
          }

          case 'response.message': {
            // The final message from a single request — capture full text if not already tracked
            const contentBlocks = event.message.content;
            if (Array.isArray(contentBlocks)) {
              for (const cb of contentBlocks) {
                const typed = cb as { type: string; text?: string; thinking?: string };
                if (typed.type === 'text' && typed.text) {
                  const txt = typed.text;
                  const hasText = blocks.some((b) => b.type === 'text');
                  if (hasText) {
                    blocks = blocks.map((b) => b.type === 'text' ? { type: 'text' as const, text: txt } : b);
                  } else {
                    blocks = [...blocks, { type: 'text' as const, text: txt }];
                  }
                }
              }
            }
            break;
          }

          case 'tool.call': {
            flushPending();
            pendingToolsRef.current++;
            setPhase('tool-calling');
            const input = isRecord(event.call.input) ? event.call.input : { value: event.call.input };
            const toolBlock: ContentBlock = {
              type: 'tool_use',
              id: event.call.id,
              name: event.call.name,
              input,
              status: 'pending',
              iteration: currentIteration,
              provider: event.call.provider,
            };
            blocks = [...blocks, toolBlock];
            scheduleUpdate(blocks, true);

            let status: 'running' | 'error' = 'running';
            if (options?.onPermissionRequest) {
              const allowed = await options.onPermissionRequest(
                event.call.name,
                input,
              );
              status = allowed ? 'running' : 'error';
            }
            blocks = blocks.map((b) =>
              b.type === 'tool_use' && b.id === event.call.id ? { ...b, status } : b,
            );
            scheduleUpdate(blocks, true);
            break;
          }

          case 'tool.permission': {
            // Permission decisions are handled inline in tool.call above
            break;
          }

          case 'tool.progress': {
            if (event.data) {
              const msg = typeof event.data.message === 'string'
                ? event.data.message
                : event.data.type
                  ? `${event.data.type}...`
                  : undefined;
              if (msg) {
                blocks = blocks.map((b) =>
                  b.type === 'tool_use' && b.id === event.toolUseId ? { ...b, progressMessage: msg } : b,
                );
                scheduleUpdate(blocks, false);
              }
            }
            break;
          }

          case 'tool.result': {
            flushPending();
            pendingToolsRef.current = Math.max(0, pendingToolsRef.current - 1);
            blocks = blocks.map((b) =>
              b.type === 'tool_use' && b.id === event.result.id
                ? { ...b, status: event.result.isError ? 'error' : 'done' }
                : b,
            );
            const resultContent = event.result.isError
              ? event.result.outputText
              : formatToolOutput(event.result.output ?? event.result.outputText);
            blocks = [...blocks, {
              type: 'tool_result',
              toolUseId: event.result.id,
              content: resultContent,
              isError: event.result.isError,
              durationMs: event.result.durationMs,
              iteration: currentIteration,
            }];
            scheduleUpdate(blocks, true);
            if (pendingToolsRef.current === 0 && !inWorkflowRef.current) {
              setPhase('waiting');
            }
            break;
          }

          case 'session.compacted': {
            hasCompactBoundary = true;
            break;
          }

          case 'response.completed': {
            setResult(event.result);
            if (!inWorkflowRef.current && pendingToolsRef.current === 0) {
              setPhase('idle');
            }
            break;
          }

          case 'error': {
            setError(event.error.message);
            setPhase('idle');
            break;
          }

          case 'workflow.start': {
            inWorkflowRef.current = true;
            setPhase('planning');
            break;
          }

          case 'step.start': {
            inStepRef.current = true;
            setPhase('workflow-step');
            break;
          }

          case 'step.done': {
            inStepRef.current = false;
            if (inWorkflowRef.current) {
              setPhase('planning');
            } else if (pendingToolsRef.current > 0) {
              setPhase('tool-calling');
            } else {
              setPhase('waiting');
            }
            break;
          }

          case 'workflow.done': {
            inWorkflowRef.current = false;
            inStepRef.current = false;
            if (pendingToolsRef.current > 0) {
              setPhase('tool-calling');
            } else {
              setPhase('idle');
            }
            break;
          }
        }
      }

      // Flush any pending throttled updates
      flushPending();

      // Finalize: ensure live text is captured
      if (currentText && !blocks.some((b) => b.type === 'text' && b.text === currentText)) {
        // Replace or add text block
        const existingIdx = blocks.findIndex((b) => b.type === 'text');
        if (existingIdx >= 0) {
          blocks[existingIdx] = { type: 'text', text: currentText };
        } else {
          blocks.push({ type: 'text', text: currentText });
        }
      }

      if (blocks.length > 0 || currentText) {
        const finalBlocks: ContentBlock[] = blocks.length > 0
          ? blocks
          : [{ type: 'text', text: currentText }];
        const assistantMsg: UIMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: finalBlocks,
          timestamp: new Date().toISOString(),
          compactBoundary: hasCompactBoundary || undefined,
        };
        setMessages((prev) => [...prev, assistantMsg]);
        setStreamingText('');
        setStreamingBlocks([]);
      }
    } catch (e: unknown) {
      flushPending();
      const err = e as Error & { name?: string };
      if (err?.name === 'AbortError') {
        if (blocks.length > 0) {
          const assistantMsg: UIMessage = {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: blocks,
            timestamp: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, assistantMsg]);
          setStreamingText('');
          setStreamingBlocks([]);
        }
      } else {
        setError(err instanceof Error ? err.message : String(e));
      }
    } finally {
      if (throttleTimer.current) {
        clearTimeout(throttleTimer.current);
        throttleTimer.current = null;
      }
      pendingBlocks.current = null;
      pendingToolsRef.current = 0;
      inWorkflowRef.current = false;
      inStepRef.current = false;
      mergedSignalCleanup?.();
      if (abortRef.current === controller) {
        setStreaming(false);
        setPhase('idle');
        abortRef.current = null;
      }
      sendingRef.current = false;
    }
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setStreamingText('');
    setStreamingBlocks([]);
    setError(null);
  }, []);

  return {
    messages,
    streamingText,
    streamingBlocks,
    streaming,
    phase,
    error,
    result,
    send,
    abort,
    clearMessages,
  } as const;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function formatToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return '';
  try {
    const json = JSON.stringify(output, null, 2);
    return json.length > 2000 ? json.slice(0, 2000) + '\n...' : json;
  } catch {
    return String(output);
  }
}

function anySignal(signals: AbortSignal[]): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return { signal: controller.signal, cleanup: () => {} };
    }
    const listener = () => controller.abort(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', listener));
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const fn of cleanups) fn();
    },
  };
}
