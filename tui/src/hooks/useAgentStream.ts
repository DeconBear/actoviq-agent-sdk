import { useState, useRef, useCallback } from 'react';
import type { AgentSession, AgentRunResult } from 'actoviq-agent-sdk';
import type { UIMessage, ContentBlock, ToolStatus } from '../context.js';

export interface UseAgentStreamOptions {
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
    let currentText = '';

    try {
      const stream = session.stream(text, { signal: mergedSignal });

      for await (const event of stream) {
        switch (event.type) {
          case 'response.text.delta': {
            currentText = event.snapshot ?? (currentText + event.delta);
            setStreamingText(currentText);
            // Build live blocks for rendering
            const liveBlocks: ContentBlock[] = [
              ...blocks,
              ...(currentText ? [{ type: 'text' as const, text: currentText }] : []),
            ];
            setStreamingBlocks(liveBlocks);
            break;
          }
          case 'tool.call': {
            const input = isRecord(event.call.input) ? event.call.input : { value: event.call.input };
            const toolBlock: ContentBlock = {
              type: 'tool_use',
              id: event.call.id,
              name: event.call.name,
              input,
              status: 'pending',
            };
            blocks.push(toolBlock);

            if (options?.onPermissionRequest) {
              const allowed = await options.onPermissionRequest(
                event.call.name,
                input,
              );
              if (!allowed) {
                toolBlock.status = 'error';
              } else {
                toolBlock.status = 'running';
              }
            } else {
              toolBlock.status = 'running';
            }
            setStreamingBlocks([...blocks]);
            break;
          }
          case 'tool.result': {
            const toolBlock = blocks.find(
              (b) => b.type === 'tool_use' && b.id === event.result.id,
            ) as Extract<ContentBlock, { type: 'tool_use' }> | undefined;
            if (toolBlock) {
              toolBlock.status = event.result.isError ? 'error' : 'done';
            }
            blocks.push({
              type: 'tool_result',
              toolUseId: event.result.id,
              content: event.result.isError
                ? `Error: ${event.result.outputText}`
                : JSON.stringify(event.result.output ?? event.result.outputText),
              isError: event.result.isError,
              durationMs: event.result.durationMs,
            });
            setStreamingBlocks([...blocks]);
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

      // Finalize: promote streaming blocks to a message
      if (currentText && !blocks.some((b) => b.type === 'text' && b.text === currentText)) {
        blocks.push({ type: 'text', text: currentText });
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
        };
        setMessages((prev) => [...prev, assistantMsg]);
        setStreamingText('');
        setStreamingBlocks([]);
      }
    } catch (e: unknown) {
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
