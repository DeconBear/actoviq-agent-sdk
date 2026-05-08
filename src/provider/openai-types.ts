// OpenAI Chat Completions API types
// Reference: https://platform.openai.com/docs/api-reference/chat

export interface OpenaiToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface OpenaiTool {
  type: 'function';
  function: OpenaiToolFunction;
}

export type OpenaiToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface OpenaiMessageContentText {
  type: 'text';
  text: string;
}

export interface OpenaiMessageContentImage {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export type OpenaiMessageContent = string | (OpenaiMessageContentText | OpenaiMessageContentImage)[];

export interface OpenaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: OpenaiMessageContent | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenaiToolCall[];
}

export interface OpenaiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenaiChatCompletionRequest {
  model: string;
  messages: OpenaiMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  tools?: OpenaiTool[];
  tool_choice?: OpenaiToolChoice;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  metadata?: Record<string, unknown>;
  parallel_tool_calls?: boolean;
}

export interface OpenaiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    [key: string]: unknown;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    [key: string]: unknown;
  };
}

export interface OpenaiChoice {
  index: number;
  message: OpenaiMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string | null;
  logprobs?: unknown;
}

export interface OpenaiChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenaiChoice[];
  usage?: OpenaiUsage;
  system_fingerprint?: string;
}

// ── Streaming types ────────────────────────────────────────────

export interface OpenaiDelta {
  role?: string;
  content?: string | null;
  tool_calls?: OpenaiDeltaToolCall[];
}

export interface OpenaiDeltaToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenaiChoiceDelta {
  index: number;
  delta: OpenaiDelta;
  finish_reason: string | null;
  logprobs?: unknown;
}

export interface OpenaiChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenaiChoiceDelta[];
  usage?: OpenaiUsage;
}
