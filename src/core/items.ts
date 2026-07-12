import type { JsonObject, JsonValue } from './json.js';

export type MessageRole = 'system' | 'user' | 'assistant';

interface ItemBase {
  /** Stable item identity when one is supplied by the runtime or provider. */
  readonly id?: string;
  readonly metadata?: JsonObject;
}

export interface TextItem extends ItemBase {
  readonly type: 'text';
  readonly role: MessageRole;
  readonly text: string;
}

export type ImageSource =
  | {
      readonly kind: 'url';
      readonly url: string;
    }
  | {
      readonly kind: 'base64';
      readonly mediaType: string;
      readonly data: string;
    }
  | {
      /** A provider or artifact-store file reference resolved by an adapter. */
      readonly kind: 'file';
      readonly fileId: string;
    };

export interface ImageItem extends ItemBase {
  readonly type: 'image';
  readonly role?: 'user' | 'assistant';
  readonly source: ImageSource;
  readonly detail?: 'auto' | 'low' | 'high';
  readonly altText?: string;
}

export type AudioSource =
  | {
      readonly kind: 'url';
      readonly url: string;
    }
  | {
      readonly kind: 'base64';
      readonly mediaType: string;
      readonly data: string;
    }
  | {
      readonly kind: 'file';
      readonly fileId: string;
    };

export interface AudioItem extends ItemBase {
  readonly type: 'audio';
  readonly role?: 'user' | 'assistant';
  readonly source: AudioSource;
  readonly transcript?: string;
}

export type DocumentSource =
  | {
      readonly kind: 'url';
      readonly url: string;
    }
  | {
      readonly kind: 'base64';
      readonly mediaType: string;
      readonly data: string;
    }
  | {
      readonly kind: 'file';
      readonly fileId: string;
    };

export interface DocumentItem extends ItemBase {
  readonly type: 'document';
  readonly role?: 'user' | 'assistant';
  readonly source: DocumentSource;
  readonly name?: string;
  readonly mediaType?: string;
}

/** Reference to a large or durable payload held outside the conversation. */
export interface ArtifactRefItem extends ItemBase {
  readonly type: 'artifact_ref';
  readonly artifactId: string;
  readonly name?: string;
  readonly mediaType?: string;
  readonly description?: string;
}

export interface ToolCallItem extends ItemBase {
  readonly type: 'tool_call';
  /** Correlates the call with exactly one ToolResultItem. */
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

export interface ToolResultItem extends ItemBase {
  readonly type: 'tool_result';
  readonly callId: string;
  readonly name?: string;
  readonly status: 'success' | 'error';
  readonly output: JsonValue;
}

export interface HandoffCallItem extends ItemBase {
  readonly type: 'handoff_call';
  readonly id: string;
  readonly targetAgentId: string;
  readonly input: JsonValue;
}

export interface HandoffResultItem extends ItemBase {
  readonly type: 'handoff_result';
  readonly callId: string;
  readonly targetAgentId: string;
  readonly status: 'success' | 'error';
  readonly output: JsonValue;
}

/**
 * Provider reasoning is opaque by default. Adapters may expose a human-safe
 * summary, but core never assumes it can inspect or reproduce `opaque`.
 */
export interface ReasoningItem extends ItemBase {
  readonly type: 'reasoning';
  readonly provider?: string;
  readonly summary?: string;
  readonly opaque: JsonValue;
}

/** Lossless escape hatch for provider data that has no canonical equivalent. */
export interface RawItem extends ItemBase {
  readonly type: 'raw';
  readonly provider: string;
  readonly value: JsonValue;
}

/** Validated structured output kept as an item as well as a typed RunResult. */
export interface StructuredOutputItem extends ItemBase {
  readonly type: 'structured';
  readonly role: 'assistant';
  readonly value: JsonValue;
  readonly schemaName?: string;
}

export interface RefusalItem extends ItemBase {
  readonly type: 'refusal';
  readonly role: 'assistant';
  readonly message: string;
  readonly providerData?: JsonValue;
}

export interface ErrorItem extends ItemBase {
  readonly type: 'error';
  readonly source: 'model' | 'tool' | 'handoff' | 'provider' | 'runtime';
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly callId?: string;
  readonly details?: JsonObject;
}

export type CanonicalItem =
  | TextItem
  | ImageItem
  | AudioItem
  | DocumentItem
  | ArtifactRefItem
  | ToolCallItem
  | ToolResultItem
  | HandoffCallItem
  | HandoffResultItem
  | ReasoningItem
  | RawItem
  | StructuredOutputItem
  | RefusalItem
  | ErrorItem;

/**
 * Items accepted at a model boundary. This includes prior model output so a
 * complete canonical transcript can be replayed without provider types.
 */
export type InputItem = CanonicalItem;

export type AssistantTextItem = TextItem & { readonly role: 'assistant' };
export type AssistantImageItem = Omit<ImageItem, 'role'> & {
  readonly role?: 'assistant';
};
export type AssistantAudioItem = Omit<AudioItem, 'role'> & {
  readonly role?: 'assistant';
};
export type AssistantDocumentItem = Omit<DocumentItem, 'role'> & {
  readonly role?: 'assistant';
};

/** Items that a model/runtime may append while executing a turn. */
export type OutputItem =
  | AssistantTextItem
  | AssistantImageItem
  | AssistantAudioItem
  | AssistantDocumentItem
  | ArtifactRefItem
  | ToolCallItem
  | ToolResultItem
  | HandoffCallItem
  | HandoffResultItem
  | ReasoningItem
  | RawItem
  | StructuredOutputItem
  | RefusalItem
  | ErrorItem;
