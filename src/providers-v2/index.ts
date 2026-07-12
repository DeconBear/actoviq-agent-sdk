export type {
  ModelCallContext,
  ModelCapabilities,
  ModelCapabilitiesSource,
  ModelCapability,
  ModelFinishReason,
  ModelOutputSchema,
  ModelProvider,
  ModelReasoningRequest,
  ModelRequest,
  ModelResponse,
  ModelStream,
  ModelStreamEvent,
  ModelToolDefinition,
  ModelToolPolicy,
  ProviderAdapterOptions,
  ProviderTransport,
  ProviderTransportRequest,
  ResolvedModel,
} from './types.js';

export {
  ANTHROPIC_MESSAGES_CAPABILITIES,
  assertRequestCapabilities,
  createModelRef,
  hasCapability,
  mergeModelCapabilities,
  MINIMAL_MODEL_CAPABILITIES,
  modelRefParts,
  OPENAI_CHAT_COMPAT_CAPABILITIES,
  OPENAI_RESPONSES_CAPABILITIES,
  requiredCapabilitiesForRequest,
  resolveModelCapabilities,
  unsupportedCapabilities,
} from './capabilities.js';

export type { ModelRegistryOptions, PreparedModelCall } from './registry.js';
export { ModelRegistry, ModelRegistryError } from './registry.js';

export type { FetchProviderTransportOptions } from './transport.js';
export { FetchProviderTransport, ProviderTransportError } from './transport.js';

export { OpenAIResponsesProvider } from './openai-responses.js';
export { OpenAIChatCompatProvider } from './openai-chat.js';
export { AnthropicModelProvider } from './anthropic.js';

export type { LegacyModelApiProviderOptions } from './legacy.js';
export { LegacyModelApiProvider, ModelProviderLegacyAdapter } from './legacy.js';
