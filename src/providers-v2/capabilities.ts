import { CapabilityError } from '../core/index.js';
import type { ModelRef } from '../core/index.js';

import type {
  ModelCapabilities,
  ModelCapabilitiesSource,
  ModelCapability,
  ModelRequest,
  ResolvedModel,
} from './types.js';

export const MINIMAL_MODEL_CAPABILITIES: ModelCapabilities = Object.freeze({
  input: Object.freeze({
    text: true,
    image: false,
    audio: false,
    document: false,
    artifact: false,
  }),
  output: Object.freeze({
    text: true,
    image: false,
    audio: false,
    structured: false,
  }),
  tools: Object.freeze({
    function: false,
    parallel: false,
    hosted: false,
  }),
  reasoning: Object.freeze({
    request: false,
    opaqueRoundTrip: false,
  }),
  streaming: false,
  promptCaching: false,
  stopSequences: false,
  providerRawRoundTrip: false,
});

export const OPENAI_RESPONSES_CAPABILITIES: ModelCapabilities = mergeModelCapabilities(
  MINIMAL_MODEL_CAPABILITIES,
  {
    input: { image: true },
    output: { structured: true },
    tools: { function: true, parallel: true, hosted: true },
    reasoning: { request: true, opaqueRoundTrip: true },
    streaming: true,
    promptCaching: true,
    providerRawRoundTrip: true,
  },
);

export const OPENAI_CHAT_COMPAT_CAPABILITIES: ModelCapabilities = mergeModelCapabilities(
  MINIMAL_MODEL_CAPABILITIES,
  {
    input: { image: true },
    output: { structured: true },
    tools: { function: true, parallel: true },
    streaming: true,
    stopSequences: true,
    providerRawRoundTrip: true,
  },
);

export const ANTHROPIC_MESSAGES_CAPABILITIES: ModelCapabilities = mergeModelCapabilities(
  MINIMAL_MODEL_CAPABILITIES,
  {
    input: { image: true, document: true },
    output: { structured: true },
    tools: { function: true, parallel: true },
    reasoning: { request: true, opaqueRoundTrip: true },
    streaming: true,
    promptCaching: true,
    stopSequences: true,
    providerRawRoundTrip: true,
  },
);

type DeepCapabilityPatch = {
  readonly input?: Partial<ModelCapabilities['input']>;
  readonly output?: Partial<ModelCapabilities['output']>;
  readonly tools?: Partial<ModelCapabilities['tools']>;
  readonly reasoning?: Partial<ModelCapabilities['reasoning']>;
  readonly streaming?: boolean;
  readonly promptCaching?: boolean;
  readonly stopSequences?: boolean;
  readonly providerRawRoundTrip?: boolean;
};

export function mergeModelCapabilities(
  base: ModelCapabilities,
  patch: DeepCapabilityPatch,
): ModelCapabilities {
  return Object.freeze({
    input: Object.freeze({ ...base.input, ...patch.input }),
    output: Object.freeze({ ...base.output, ...patch.output }),
    tools: Object.freeze({ ...base.tools, ...patch.tools }),
    reasoning: Object.freeze({ ...base.reasoning, ...patch.reasoning }),
    streaming: patch.streaming ?? base.streaming,
    promptCaching: patch.promptCaching ?? base.promptCaching,
    stopSequences: patch.stopSequences ?? base.stopSequences,
    providerRawRoundTrip: patch.providerRawRoundTrip ?? base.providerRawRoundTrip,
  });
}

export async function resolveModelCapabilities(
  source: ModelCapabilitiesSource | undefined,
  defaults: ModelCapabilities,
  model: ResolvedModel,
): Promise<ModelCapabilities> {
  if (!source) {
    return defaults;
  }
  if (typeof source === 'function') {
    return mergeModelCapabilities(await source(model), {});
  }
  if (isCapabilities(source)) {
    return mergeModelCapabilities(source, {});
  }
  return mergeModelCapabilities(source[model.modelId] ?? source['*'] ?? defaults, {});
}

export function requiredCapabilitiesForRequest(
  request: ModelRequest,
  options: { readonly streaming?: boolean } = {},
): readonly ModelCapability[] {
  const required = new Set<ModelCapability>();
  required.add('output.text');

  if (options.streaming) {
    required.add('streaming');
  }
  if (request.outputSchema) {
    required.add('output.structured');
  }
  if (request.reasoning) {
    required.add('reasoning.request');
  }
  if (request.promptCacheKey) {
    required.add('promptCaching');
  }
  if (request.stopSequences && request.stopSequences.length > 0) {
    required.add('stopSequences');
  }
  if (request.tools && request.tools.length > 0) {
    required.add('tools.function');
    if (request.tools.some(tool => tool.hosted)) {
      required.add('tools.hosted');
    }
  }
  if (request.parallelToolCalls) {
    required.add('tools.parallel');
  }

  for (const modality of request.outputModalities ?? []) {
    required.add(`output.${modality}` as ModelCapability);
  }

  for (const item of request.input) {
    const record = item as unknown as Record<string, unknown>;
    switch (record.type) {
      case 'text':
        required.add('input.text');
        break;
      case 'image':
        required.add('input.image');
        break;
      case 'audio':
        required.add('input.audio');
        break;
      case 'document':
        required.add('input.document');
        break;
      case 'artifact':
      case 'artifact_ref':
        required.add('input.artifact');
        break;
      case 'tool_call':
      case 'tool_result':
        required.add('tools.function');
        break;
      case 'reasoning':
        required.add('reasoning.opaqueRoundTrip');
        break;
      case 'structured':
      case 'refusal':
      case 'error':
        required.add('input.text');
        break;
      case 'raw':
        required.add('providerRawRoundTrip');
        break;
      default:
        break;
    }
  }

  return [...required];
}

export function unsupportedCapabilities(
  capabilities: ModelCapabilities,
  required: readonly ModelCapability[],
): readonly ModelCapability[] {
  return required.filter(capability => !hasCapability(capabilities, capability));
}

export function assertRequestCapabilities(
  providerId: string,
  model: ResolvedModel,
  capabilities: ModelCapabilities,
  request: ModelRequest,
  options: { readonly streaming?: boolean } = {},
): void {
  validateProviderRawItems(providerId, request);
  const missing = unsupportedCapabilities(
    capabilities,
    requiredCapabilitiesForRequest(request, options),
  );
  if (missing.length === 0) {
    return;
  }

  throw new CapabilityError(
    `Model ${providerId}/${model.modelId} does not support required capabilities: ${missing.join(', ')}.`,
    {
      providerId,
      model: model.modelId,
      capability: missing.join(','),
    },
  );
}

export function modelRefParts(
  ref: ModelRef,
  defaultProviderId?: string,
): { providerId: string; modelId: string } {
  if (typeof ref === 'string') {
    const separator = ref.indexOf(':');
    if (separator < 0 && defaultProviderId && ref.length > 0) {
      return { providerId: defaultProviderId, modelId: ref };
    }
    if (separator <= 0 || separator === ref.length - 1) {
      throw new TypeError(
        `ModelRef string must use "provider:model" syntax when no default provider is available; received ${ref}.`,
      );
    }
    return { providerId: ref.slice(0, separator), modelId: ref.slice(separator + 1) };
  }

  const record = ref as unknown as Record<string, unknown>;
  const providerId = stringValue(record.provider) ?? stringValue(record.providerId);
  const modelId = stringValue(record.model) ?? stringValue(record.modelId) ?? stringValue(record.id);
  if (!providerId || !modelId) {
    throw new TypeError('ModelRef must contain non-empty provider and model identifiers.');
  }
  return { providerId, modelId };
}

export function createModelRef(providerId: string, modelId: string): ModelRef {
  return { provider: providerId, model: modelId } as ModelRef;
}

export function hasCapability(
  capabilities: ModelCapabilities,
  capability: ModelCapability,
): boolean {
  const [group, member] = capability.split('.') as [string, string | undefined];
  if (!member) {
    return Boolean(capabilities[group as keyof ModelCapabilities]);
  }
  const value = capabilities[group as keyof ModelCapabilities];
  return typeof value === 'object' && value !== null
    ? Boolean((value as unknown as Record<string, unknown>)[member])
    : false;
}

function isCapabilities(value: object): value is ModelCapabilities {
  return 'input' in value && 'output' in value && 'tools' in value && 'reasoning' in value;
}

function validateProviderRawItems(providerId: string, request: ModelRequest): void {
  for (const item of request.input) {
    const record = item as unknown as Record<string, unknown>;
    if (
      record.type === 'raw' &&
      typeof record.provider === 'string' &&
      record.provider !== providerId
    ) {
      throw new CapabilityError(
        `Raw item for provider ${record.provider} cannot be sent to provider ${providerId}.`,
        {
          providerId,
          model: providerId,
          capability: 'providerRawRoundTrip',
        },
      );
    }
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
