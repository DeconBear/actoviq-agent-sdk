import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool as ProviderTool } from '../provider/types.js';

import type {
  AgentMcpServerDefinition,
  AgentToolDefinition,
  ResolvedToolAdapter,
  ResolvedToolExecutionResult,
  StdioMcpServerDefinition,
  StreamableHttpMcpServerDefinition,
  ToolExecutionContext,
} from '../types.js';
import { ConfigurationError } from '../errors.js';
import { isRecord } from '../runtime/helpers.js';
import {
  assertPublicToolName,
  createLocalToolAdapter,
  qualifyToolName,
  sanitizeToolSegment,
} from '../runtime/tools.js';

type ExternalServerDefinition = StdioMcpServerDefinition | StreamableHttpMcpServerDefinition;

interface ExternalConnection {
  key: string;
  server: ExternalServerDefinition;
  client: Client;
}

export class McpConnectionManager {
  private readonly connections = new Map<string, ExternalConnection>();

  constructor(private readonly clientInfo: { name: string; version: string }) {}

  async resolveToolAdapters(
    localTools: AgentToolDefinition[] = [],
    servers: AgentMcpServerDefinition[] = [],
  ): Promise<ResolvedToolAdapter[]> {
    const adapters: ResolvedToolAdapter[] = localTools.map((tool) => createLocalToolAdapter(tool));

    for (const server of servers) {
      if (server.kind === 'local') {
        const prefix = server.prefix ?? sanitizeToolSegment(server.name);
        for (const localTool of server.tools) {
          adapters.push(
            createLocalToolAdapter(
              localTool,
              qualifyToolName(prefix, localTool.name),
              localTool.name,
              server.name,
            ),
          );
        }
        continue;
      }

      const connection = await this.getConnection(server);
      const listed = await connection.client.listTools();
      const prefix = server.prefix ?? sanitizeToolSegment(server.name);

      for (const listedTool of listed.tools) {
        const publicName = qualifyToolName(prefix, listedTool.name);
        assertPublicToolName(publicName);

        adapters.push({
          publicName,
          sourceName: listedTool.name,
          provider: 'mcp',
          mcpServerName: server.name,
          providerTool: {
            name: publicName,
            description:
              listedTool.description ??
              `Tool exposed by MCP server "${server.name}".`,
            input_schema: listedTool.inputSchema as ProviderTool['input_schema'],
          },
          execute: (input, context) =>
            this.callExternalTool(connection, listedTool.name, input, context),
        });
      }
    }

    ensureUniqueToolNames(adapters);
    return adapters;
  }

  async closeAll(): Promise<void> {
    for (const connection of this.connections.values()) {
      await connection.client.close().catch(() => undefined);
    }
    this.connections.clear();
  }

  private async getConnection(server: ExternalServerDefinition): Promise<ExternalConnection> {
    const key = connectionKey(server);
    const existing = this.connections.get(key);
    if (existing) {
      return existing;
    }

    const client = new Client({
      name: this.clientInfo.name,
      version: this.clientInfo.version,
    });

    if (server.kind === 'stdio') {
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: server.cwd,
        stderr: server.stderr ?? 'inherit',
      });
      await client.connect(transport);
    } else {
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: server.headers ? { headers: server.headers } : undefined,
        sessionId: server.sessionId,
      });
      await client.connect(transport);
    }

    const connection: ExternalConnection = {
      key,
      server,
      client,
    };
    this.connections.set(key, connection);
    return connection;
  }

  private async callExternalTool(
    connection: ExternalConnection,
    toolName: string,
    input: unknown,
    _context: ToolExecutionContext,
  ): Promise<ResolvedToolExecutionResult> {
    if (!isRecord(input)) {
      throw new ConfigurationError(
        `MCP tool "${toolName}" requires an object input, but received ${typeof input}.`,
      );
    }

    const result = await connection.client.callTool({
      name: toolName,
      arguments: input,
    });

    const text = mcpCallResultToText(result);
    const isError = isRecord(result) && result.isError === true;

    return {
      content: text,
      text,
      rawOutput: result,
      isError,
    };
  }
}

function connectionKey(server: ExternalServerDefinition): string {
  if (server.kind === 'stdio') {
    return `stdio:${server.name}:${server.command}:${(server.args ?? []).join(' ')}`;
  }
  return `streamable_http:${server.name}:${String(server.url)}`;
}

function ensureUniqueToolNames(adapters: ResolvedToolAdapter[]): void {
  const seen = new Set<string>();
  for (const adapter of adapters) {
    if (seen.has(adapter.publicName)) {
      throw new ConfigurationError(`Duplicate tool name "${adapter.publicName}" was detected.`);
    }
    seen.add(adapter.publicName);
  }
}

function mcpCallResultToText(result: unknown): string {
  if (!isRecord(result)) {
    return JSON.stringify(result, null, 2);
  }

  const content = result.content;
  const fragments: string[] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) {
        fragments.push(JSON.stringify(block));
        continue;
      }
      switch (block.type) {
        case 'text':
          if (typeof block.text === 'string') {
            fragments.push(block.text);
          }
          break;
        case 'resource':
          if (isRecord(block.resource)) {
            if (typeof block.resource.text === 'string') {
              fragments.push(block.resource.text);
            } else if (typeof block.resource.uri === 'string') {
              fragments.push(`[resource] ${block.resource.uri}`);
            }
          }
          break;
        case 'resource_link':
          fragments.push(
            `[resource_link] ${String(block.name ?? '')} ${String(block.uri ?? '')}`.trim(),
          );
          break;
        case 'image':
          fragments.push(`[image] ${String(block.mimeType ?? 'unknown')}`);
          break;
        case 'audio':
          fragments.push(`[audio] ${String(block.mimeType ?? 'unknown')}`);
          break;
        default:
          fragments.push(JSON.stringify(block, null, 2));
          break;
      }
    }
  }

  if (isRecord(result.structuredContent)) {
    fragments.push(JSON.stringify(result.structuredContent, null, 2));
  }

  if (fragments.length === 0 && 'toolResult' in result) {
    fragments.push(JSON.stringify(result.toolResult, null, 2));
  }

  return fragments.filter(Boolean).join('\n\n');
}



