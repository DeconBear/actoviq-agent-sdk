export interface Metadata {
  user_id?: string | null;
  [key: string]: unknown;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: unknown;
  inference_geo?: unknown;
  [key: string]: unknown;
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | string;

export interface TextBlock {
  type: 'text';
  text: string;
  [key: string]: unknown;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
  [key: string]: unknown;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DocumentBlock {
  type: 'document';
  source: {
    type?: string;
    media_type?: string;
    data?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | ContentBlockParam[];
  is_error?: boolean;
  [key: string]: unknown;
}

export interface GenericContentBlock {
  type: string;
  [key: string]: unknown;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | DocumentBlock
  | GenericContentBlock;

export type ContentBlockParam = ContentBlock | ToolResultBlockParam | GenericContentBlock;

export interface Message {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ContentBlock[];
  stop_reason: StopReason | null;
  stop_sequence?: string | null;
  usage?: Usage;
  [key: string]: unknown;
}

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlockParam[];
}

export interface Tool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
  input_examples?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export type ToolChoice =
  | {
      type: 'auto' | 'any' | 'tool';
      name?: string;
      disable_parallel_tool_use?: boolean;
      [key: string]: unknown;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

export interface TextDelta {
  type: 'text_delta';
  text: string;
}

export interface InputJsonDelta {
  type: 'input_json_delta';
  partial_json: string;
}

export interface ThinkingDelta {
  type: 'thinking_delta';
  thinking: string;
  signature?: string;
}

export type ContentBlockDelta = TextDelta | InputJsonDelta | ThinkingDelta | Record<string, unknown>;

export interface MessageStartEvent {
  type: 'message_start';
  message: Message;
}

export interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: ContentBlock;
}

export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: ContentBlockDelta;
}

export interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

export interface MessageDeltaEvent {
  type: 'message_delta';
  delta?: {
    stop_reason?: StopReason | null;
    stop_sequence?: string | null;
    [key: string]: unknown;
  };
  usage?: Usage;
}

export interface MessageStopEvent {
  type: 'message_stop';
}

export interface GenericMessageStreamEvent {
  type: string;
  [key: string]: unknown;
}

export type MessageStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | GenericMessageStreamEvent;
