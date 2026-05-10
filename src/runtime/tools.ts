import type { Tool as ProviderTool, ToolResultBlockParam } from '../provider/types.js';
import { z } from 'zod';

import { ConfigurationError, ToolExecutionError } from '../errors.js';
import type {
  AgentToolDefinition,
  CreateToolOptions,
  ResolvedToolAdapter,
  ResolvedToolExecutionResult,
  ToolCallProgress,
  ToolExecutionContext,
} from '../types.js';
import { isRecord } from './helpers.js';
import { extractTextFromToolResultContent } from './messageUtils.js';

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function tool<Input, Output>(
  config: CreateToolOptions<Input, Output>,
  execute: AgentToolDefinition<Input, Output>['execute'],
): AgentToolDefinition<Input, Output> {
  assertPublicToolName(config.name);
  const inputJsonSchema = toInputJsonSchema(config.inputSchema, config.name);
  return {
    kind: 'local',
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    inputJsonSchema,
    serialize: config.serialize,
    execute,
    strict: config.strict ?? true,
    examples: config.examples,
    isReadOnly: config.isReadOnly,
    isDestructive: config.isDestructive,
    requiresUserInteraction: config.requiresUserInteraction,
    isConcurrencySafe: config.isConcurrencySafe,
    checkPermissions: config.checkPermissions,
    aliases: config.aliases,
    userFacingName: config.userFacingName,
    searchHint: config.searchHint,
    interruptBehavior: config.interruptBehavior ?? 'block',
    isResultTruncated: config.isResultTruncated,
    maxResultSizeChars: config.maxResultSizeChars ?? 50_000,
    inputsEquivalent: config.inputsEquivalent,
    validateInput: config.validateInput,
    getToolUseSummary: config.getToolUseSummary,
    prompt: config.prompt,
  };
}

export function sanitizeToolSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || 'tool';
}

export function qualifyToolName(prefix: string | undefined, name: string): string {
  if (!prefix) {
    return name;
  }
  const qualified = `${sanitizeToolSegment(prefix)}__${sanitizeToolSegment(name)}`;
  return qualified.slice(0, 128);
}

export function assertPublicToolName(name: string): void {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new ConfigurationError(
      `Tool name "${name}" is invalid. Use only letters, digits, "_" or "-".`,
    );
  }
}

export function createLocalToolAdapter(
  definition: AgentToolDefinition,
  publicName = definition.name,
  sourceName = definition.name,
  mcpServerName?: string,
): ResolvedToolAdapter {
  assertPublicToolName(publicName);
  return {
    publicName,
    sourceName,
    provider: mcpServerName ? 'mcp' : 'local',
    mcpServerName,
    providerTool: buildProviderTool(definition, publicName),
    isReadOnly: definition.isReadOnly as ((input?: unknown) => boolean) | undefined,
    isDestructive: definition.isDestructive as ((input?: unknown) => boolean) | undefined,
    requiresUserInteraction: definition.requiresUserInteraction,
    isConcurrencySafe: definition.isConcurrencySafe,
    checkPermissions: definition.checkPermissions as ResolvedToolAdapter['checkPermissions'],
    execute: async (input: unknown, context: ToolExecutionContext, onProgress?: ToolCallProgress) => {
      try {
        const parsedInput = await definition.inputSchema.parseAsync(input);
        const output = await definition.execute(parsedInput, context, onProgress);
        if (definition.outputSchema) {
          await definition.outputSchema.parseAsync(output);
        }
        return normalizeToolExecutionResult(definition.serialize?.(output), output);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new ToolExecutionError(
            publicName,
            formatZodValidationError(publicName, error, input),
            { cause: error },
          );
        }
        throw error;
      }
    },
  };
}

export function normalizeToolExecutionResult(
  serialized: string | ToolResultBlockParam['content'] | undefined,
  rawOutput: unknown,
): ResolvedToolExecutionResult {
  const content = serialized ?? defaultSerializedOutput(rawOutput);
  return {
    content,
    text: textFromToolResultContent(content),
    rawOutput,
    isError: false,
  };
}

export function textFromToolResultContent(content?: ToolResultBlockParam['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const extracted = extractTextFromToolResultContent(content);
  if (extracted) {
    return extracted;
  }
  return content.map((entry) => JSON.stringify(entry)).join('\n');
}

function defaultSerializedOutput(value: unknown): ToolResultBlockParam['content'] {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value, null, 2);
  }
  if (isRecord(value)) {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function buildProviderTool(
  definition: AgentToolDefinition,
  publicName: string,
): ProviderTool {
  return {
    type: 'custom',
    name: publicName,
    description: definition.description,
    input_schema: definition.inputJsonSchema as ProviderTool['input_schema'],
    strict: definition.strict ?? true,
    input_examples: definition.examples,
    readonly: definition.isReadOnly?.(undefined) ?? undefined,
  };
}

function toInputJsonSchema(schema: z.ZodType, toolName: string): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema);
  if (!isRecord(jsonSchema) || jsonSchema.type !== 'object') {
    throw new ConfigurationError(
      `Tool "${toolName}" must use a Zod object schema for its input.`,
    );
  }
  // Reject unexpected parameters at the API level (Claude Code pattern)
  if (jsonSchema.additionalProperties === undefined) {
    jsonSchema.additionalProperties = false;
  }
  return jsonSchema;
}

/**
 * Format Zod validation errors into model-friendly messages.
 * Claude Code-style: clearly states what parameter was missing,
 * unexpected, or had the wrong type — so the model can self-correct.
 */
function formatZodValidationError(toolName: string, error: z.ZodError, rawInput: unknown): string {
  const lines: string[] = [`Invalid input for "${toolName}":`];

  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? `'${issue.path.join('.')}'` : 'input';

    // Unexpected keys (strictObject / additionalProperties rejection)
    if (issue.code === 'unrecognized_keys') {
      for (const k of (issue as { keys: string[] }).keys) {
        lines.push(`  - unexpected parameter '${k}'`);
      }
      continue;
    }

    // Required but missing — invalid_type where the value was undefined
    if (issue.code === 'invalid_type' && issue.input === undefined) {
      lines.push(`  - ${path} is required but missing`);
      continue;
    }

    // Wrong type
    if (issue.code === 'invalid_type') {
      const received = typeof issue.input;
      const expected = (issue as { expected: string }).expected;
      lines.push(`  - ${path} should be ${expected}, received ${received}`);
      continue;
    }

    // Invalid value (enum, literal mismatch, etc.)
    if (issue.code === 'invalid_value') {
      const values = (issue as { values: unknown[] }).values ?? [];
      lines.push(`  - ${path} should be one of [${values.map(String).join(', ')}], received ${JSON.stringify(issue.input)}`);
      continue;
    }

    // Fallback: Zod's built-in message
    lines.push(`  - ${path}: ${issue.message}`);
  }

  // Show what was actually received (truncated)
  const rawStr = typeof rawInput === 'string'
    ? rawInput
    : JSON.stringify(rawInput);
  lines.push(`\nReceived: ${rawStr.length > 300 ? rawStr.slice(0, 300) + '...' : rawStr}`);

  return lines.join('\n');
}




