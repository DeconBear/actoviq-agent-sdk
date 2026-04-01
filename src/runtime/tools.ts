import type { Tool as ProviderTool, ToolResultBlockParam } from '../provider/types.js';
import { z } from 'zod';

import { ConfigurationError, ToolExecutionError } from '../errors.js';
import type {
  AgentToolDefinition,
  CreateToolOptions,
  ResolvedToolAdapter,
  ResolvedToolExecutionResult,
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
    execute: async (input: unknown, context: ToolExecutionContext) => {
      try {
        const parsedInput = await definition.inputSchema.parseAsync(input);
        const output = await definition.execute(parsedInput, context);
        if (definition.outputSchema) {
          await definition.outputSchema.parseAsync(output);
        }
        return normalizeToolExecutionResult(definition.serialize?.(output), output);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new ToolExecutionError(
            publicName,
            `Invalid tool input for "${publicName}": ${error.message}`,
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
    name: publicName,
    description: definition.description,
    input_schema: definition.inputJsonSchema as ProviderTool['input_schema'],
    strict: definition.strict ?? true,
    input_examples: definition.examples,
  };
}

function toInputJsonSchema(schema: z.ZodType, toolName: string): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema);
  if (!isRecord(jsonSchema) || jsonSchema.type !== 'object') {
    throw new ConfigurationError(
      `Tool "${toolName}" must use a Zod object schema for its input.`,
    );
  }
  return jsonSchema;
}




