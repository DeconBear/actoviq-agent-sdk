import { isRecord } from '../runtime/helpers.js';
import type {
  ActoviqBridgeEventAnalysis,
  ActoviqBridgeJsonEvent,
  ActoviqBridgeTaskInvocation,
  ActoviqBridgeToolProvider,
  ActoviqBridgeToolRequest,
  ActoviqBridgeToolResultSummary,
} from '../types.js';

function getBlockProvider(blockType: string): ActoviqBridgeToolProvider {
  switch (blockType) {
    case 'tool_use':
      return 'runtime';
    case 'server_tool_use':
      return 'server';
    case 'mcp_tool_use':
      return 'mcp';
    default:
      return 'unknown';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function getActoviqBridgeTextDelta(event: ActoviqBridgeJsonEvent): string | undefined {
  if (event.type !== 'stream_event' || !isRecord(event.event)) {
    return undefined;
  }

  const nestedEvent = event.event;
  if (nestedEvent.type !== 'content_block_delta' || !isRecord(nestedEvent.delta)) {
    return undefined;
  }

  const delta = nestedEvent.delta;
  return delta.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : undefined;
}

export function extractActoviqBridgeToolRequests(
  event: ActoviqBridgeJsonEvent,
): ActoviqBridgeToolRequest[] {
  if (event.type !== 'assistant' || !isRecord(event.message) || !Array.isArray(event.message.content)) {
    return [];
  }

  return event.message.content.flatMap(block => {
    if (!isRecord(block) || typeof block.type !== 'string') {
      return [];
    }

    if (!['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(block.type)) {
      return [];
    }

    return [
      {
        id: typeof block.id === 'string' ? block.id : undefined,
        name: typeof block.name === 'string' ? block.name : 'unknown-tool',
        provider: getBlockProvider(block.type),
        blockType: block.type,
        input: block.input,
      } satisfies ActoviqBridgeToolRequest,
    ];
  });
}

export function extractActoviqBridgeToolResults(
  event: ActoviqBridgeJsonEvent,
): ActoviqBridgeToolResultSummary[] {
  if (event.type !== 'user' || !isRecord(event.message) || !Array.isArray(event.message.content)) {
    return [];
  }

  return event.message.content.flatMap(block => {
    if (!isRecord(block) || typeof block.type !== 'string') {
      return [];
    }

    if (block.type !== 'tool_result' && !block.type.endsWith('tool_result')) {
      return [];
    }

    return [
      {
        toolUseId:
          typeof block.tool_use_id === 'string' ? block.tool_use_id : 'unknown-tool-call',
        isError: block.is_error === true,
        blockType: block.type,
        content: block.content,
      } satisfies ActoviqBridgeToolResultSummary,
    ];
  });
}

export function extractActoviqBridgeTaskInvocations(
  event: ActoviqBridgeJsonEvent,
): ActoviqBridgeTaskInvocation[] {
  return extractActoviqBridgeToolRequests(event).flatMap(request => {
    if (request.name !== 'Task') {
      return [];
    }

    const input = asRecord(request.input);
    if (!input) {
      return [];
    }

    return [
      {
        id: request.id,
        name: request.name,
        provider: request.provider,
        description: typeof input.description === 'string' ? input.description : undefined,
        prompt:
          typeof input.prompt === 'string'
            ? input.prompt
            : typeof input.task === 'string'
              ? input.task
              : undefined,
        subagentType:
          typeof input.subagent_type === 'string'
            ? input.subagent_type
            : typeof input.agent === 'string'
              ? input.agent
              : typeof input.agent_type === 'string'
                ? input.agent_type
                : undefined,
        input,
      } satisfies ActoviqBridgeTaskInvocation,
    ];
  });
}

export function analyzeActoviqBridgeEvents(
  events: Iterable<ActoviqBridgeJsonEvent>,
): ActoviqBridgeEventAnalysis {
  const textDeltas: string[] = [];
  const toolRequests: ActoviqBridgeToolRequest[] = [];
  const toolResults: ActoviqBridgeToolResultSummary[] = [];
  const taskInvocations: ActoviqBridgeTaskInvocation[] = [];

  for (const event of events) {
    const delta = getActoviqBridgeTextDelta(event);
    if (delta) {
      textDeltas.push(delta);
    }

    const requests = extractActoviqBridgeToolRequests(event);
    if (requests.length > 0) {
      toolRequests.push(...requests);
    }

    const results = extractActoviqBridgeToolResults(event);
    if (results.length > 0) {
      toolResults.push(...results);
    }

    const tasks = extractActoviqBridgeTaskInvocations(event);
    if (tasks.length > 0) {
      taskInvocations.push(...tasks);
    }
  }

  return {
    textDeltas,
    toolRequests,
    toolResults,
    taskInvocations,
  };
}
