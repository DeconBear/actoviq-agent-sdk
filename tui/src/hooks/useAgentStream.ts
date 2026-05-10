import { useState, useRef, useCallback } from 'react';
import type { AgentSession, AgentRunResult } from 'actoviq-agent-sdk';
import type { UIMessage, ContentBlock } from '../context.js';

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
  const abortRef = useRef<AbortController | null>(null);

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
    setStreamingText('');
    setStreamingBlocks([]);
    setError(null);
    setResult(null);
    setStreaming(true);

    const userMsg: UIMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    const controller = new AbortController();
    abortRef.current = controller;

    const mergedSignal = options?.signal
      ? anySignal([options.signal, controller.signal])
      : controller.signal;

    const blocks: ContentBlock[] = [];
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
            break;
          }

          case 'request.started': {
            currentIteration = event.iteration;
            flushPending();
            if (currentIteration > 0) {
              blocks.push({ type: 'separator', iteration: currentIteration, runId });
              scheduleUpdate([...blocks], true);
            }
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
            break;
          }

          case 'response.content': {
            const content = event.content as { type: string; text?: string; thinking?: string };
            if (content.type === 'thinking' && content.thinking) {
              blocks.push({ type: 'thinking', text: content.thinking, collapsed: false });
              scheduleUpdate([...blocks], true);
            } else if (content.type === 'text' && content.text) {
              currentText = content.text;
              setStreamingText(currentText);
              scheduleUpdate([...blocks], true);
            }
            break;
          }

          case 'response.message': {
            // The final message from a single request — capture full text if not already tracked
            const contentBlocks = event.message.content;
            if (Array.isArray(contentBlocks)) {
              for (const cb of contentBlocks) {
                const typed = cb as { type: string; text?: string; thinking?: string };
                if (typed.type === 'text' && typed.text && !blocks.some(
                  (b) => b.type === 'text' && b.text === typed.text,
                )) {
                  const idx = blocks.findIndex((b) => b.type === 'text');
                  if (idx >= 0) {
                    blocks[idx] = { type: 'text', text: typed.text };
                  } else {
                    blocks.push({ type: 'text', text: typed.text });
                  }
                }
              }
            }
            break;
          }

          case 'tool.call': {
            flushPending();
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
            blocks.push(toolBlock);
            scheduleUpdate([...blocks], true);

            if (options?.onPermissionRequest) {
              const allowed = await options.onPermissionRequest(
                event.call.name,
                input,
              );
              toolBlock.status = allowed ? 'running' : 'error';
            } else {
              toolBlock.status = 'running';
            }
            scheduleUpdate([...blocks], true);
            break;
          }

          case 'tool.permission': {
            // Permission decisions are handled inline in tool.call above
            break;
          }

          case 'tool.progress': {
            const progressBlock = blocks.find(
              (b) => b.type === 'tool_use' && b.id === event.toolUseId,
            ) as Extract<ContentBlock, { type: 'tool_use' }> | undefined;
            if (progressBlock && event.data) {
              const msg = typeof event.data.message === 'string'
                ? event.data.message
                : event.data.type
                  ? `${event.data.type}...`
                  : undefined;
              if (msg) {
                progressBlock.progressMessage = msg;
                scheduleUpdate([...blocks], false);
              }
            }
            break;
          }

          case 'tool.result': {
            flushPending();
            const toolBlock = blocks.find(
              (b) => b.type === 'tool_use' && b.id === event.result.id,
            ) as Extract<ContentBlock, { type: 'tool_use' }> | undefined;
            if (toolBlock) {
              toolBlock.status = event.result.isError ? 'error' : 'done';
            }
            const resultContent = event.result.isError
              ? event.result.outputText
              : formatToolOutput(event.result.output ?? event.result.outputText);
            blocks.push({
              type: 'tool_result',
              toolUseId: event.result.id,
              content: resultContent,
              isError: event.result.isError,
              durationMs: event.result.durationMs,
              iteration: currentIteration,
            });
            scheduleUpdate([...blocks], true);
            break;
          }

          case 'session.compacted': {
            hasCompactBoundary = true;
            break;
          }

          case 'response.completed': {
            setResult(event.result);
            break;
          }

          case 'error': {
            setError(event.error.message);
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
        if (currentText || blocks.length > 0) {
          const finalBlocks: ContentBlock[] = [
            ...blocks,
            ...(currentText ? [{ type: 'text' as const, text: currentText }] : []),
          ];
          const assistantMsg: UIMessage = {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: finalBlocks,
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
      setStreaming(false);
      abortRef.current = null;
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

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
