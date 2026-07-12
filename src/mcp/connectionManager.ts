import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'node:crypto';
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
  /** Retain only non-secret identity; transport credentials stay in the client. */
  server: Pick<ExternalServerDefinition, 'kind' | 'name'>;
  client: McpClientLike;
  catalog?: {
    expiresAt: number;
    tools: Awaited<ReturnType<Client['listTools']>>['tools'];
  };
}

export type McpClientLike = Pick<Client, 'connect' | 'listTools' | 'callTool' | 'close'>;

export interface McpConnectionManagerOptions {
  requestTimeoutMs?: number;
  catalogTtlMs?: number;
  clientFactory?: () => McpClientLike;
}

export interface ResolveMcpToolsOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class McpConnectionManager {
  private readonly connections = new Map<string, ExternalConnection>();
  private readonly pendingConnections = new Map<string, Promise<ExternalConnection>>();
  private readonly requestTimeoutMs: number;
  private readonly catalogTtlMs: number;
  private readonly clientFactory: () => McpClientLike;

  constructor(
    private readonly clientInfo: { name: string; version: string },
    options: McpConnectionManagerOptions = {},
  ) {
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? 120_000,
      'requestTimeoutMs',
    );
    this.catalogTtlMs = positiveInteger(options.catalogTtlMs ?? 30_000, 'catalogTtlMs');
    this.clientFactory = options.clientFactory ?? (() => new Client(this.clientInfo));
  }

  async resolveToolAdapters(
    localTools: AgentToolDefinition[] = [],
    servers: AgentMcpServerDefinition[] = [],
    options: ResolveMcpToolsOptions = {},
  ): Promise<ResolvedToolAdapter[]> {
    const adapters: ResolvedToolAdapter[] = [];
    for (const localTool of localTools) {
      adapters.push(createLocalToolAdapter(localTool));
      for (const alias of localTool.aliases ?? []) {
        adapters.push(createLocalToolAdapter(localTool, alias, localTool.name));
      }
    }

    const externalServers: ExternalServerDefinition[] = [];
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
          for (const alias of localTool.aliases ?? []) {
            adapters.push(
              createLocalToolAdapter(
                localTool,
                qualifyToolName(prefix, alias),
                localTool.name,
                server.name,
              ),
            );
          }
        }
        continue;
      }
      externalServers.push(server);
    }

    const externalAdapters = await Promise.all(externalServers.map(async (server) => {
      const connection = await this.getConnection(server, options);
      const listedTools = await this.listTools(connection, options);
      const prefix = server.prefix ?? sanitizeToolSegment(server.name);
      const serverAdapters: ResolvedToolAdapter[] = [];

      for (const listedTool of listedTools) {
        const publicName = qualifyToolName(prefix, listedTool.name);
        assertPublicToolName(publicName);

        serverAdapters.push({
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
            readonly: (listedTool as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint ?? undefined,
          },
          interruptBehavior: 'cancel',
          execute: (input, context) =>
            this.callExternalTool(connection, listedTool.name, input, context),
        });
      }
      return serverAdapters;
    }));
    adapters.push(...externalAdapters.flat());

    ensureUniqueToolNames(adapters);
    return adapters;
  }

  async closeAll(): Promise<void> {
    const pending = await Promise.allSettled(this.pendingConnections.values());
    for (const result of pending) {
      if (result.status === 'fulfilled') {
        this.connections.set(result.value.key, result.value);
      }
    }
    for (const connection of this.connections.values()) {
      await connection.client.close().catch(() => undefined);
    }
    this.connections.clear();
    this.pendingConnections.clear();
  }

  private async getConnection(
    server: ExternalServerDefinition,
    options: ResolveMcpToolsOptions,
  ): Promise<ExternalConnection> {
    const key = connectionKey(server);
    const existing = this.connections.get(key);
    if (existing) {
      return existing;
    }

    const pending = this.pendingConnections.get(key);
    if (pending) {
      return pending;
    }

    const connecting = this.connect(server, key, options);
    this.pendingConnections.set(key, connecting);
    try {
      const connection = await connecting;
      await this.evictSupersededConnections(server, key);
      this.connections.set(key, connection);
      return connection;
    } finally {
      this.pendingConnections.delete(key);
    }
  }

  private async connect(
    server: ExternalServerDefinition,
    key: string,
    options: ResolveMcpToolsOptions,
  ): Promise<ExternalConnection> {
    const client = this.clientFactory();
    const requestOptions = this.requestOptions(options);

    try {
      if (server.kind === 'stdio') {
        const transport = new StdioClientTransport({
          command: server.command,
          args: server.args,
          env: server.env,
          cwd: server.cwd,
          stderr: server.stderr ?? 'inherit',
        });
        await client.connect(transport, requestOptions);
      } else {
        const transport = new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: server.headers ? { headers: server.headers } : undefined,
          sessionId: server.sessionId,
        });
        await client.connect(transport, requestOptions);
      }
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }

    return {
      key,
      server: { kind: server.kind, name: server.name },
      client,
    };
  }

  private async listTools(
    connection: ExternalConnection,
    options: ResolveMcpToolsOptions,
  ): Promise<Awaited<ReturnType<Client['listTools']>>['tools']> {
    if (connection.catalog && connection.catalog.expiresAt > Date.now()) {
      return connection.catalog.tools;
    }
    try {
      const listed = await connection.client.listTools(undefined, this.requestOptions(options));
      connection.catalog = {
        expiresAt: Date.now() + this.catalogTtlMs,
        tools: listed.tools,
      };
      return listed.tools;
    } catch (error) {
      await this.invalidateConnection(connection);
      throw error;
    }
  }

  private requestOptions(options: ResolveMcpToolsOptions) {
    const timeout = options.timeoutMs ?? this.requestTimeoutMs;
    return {
      signal: options.signal,
      timeout,
      maxTotalTimeout: timeout,
    };
  }

  private async evictSupersededConnections(
    server: ExternalServerDefinition,
    currentKey: string,
  ): Promise<void> {
    const superseded = [...this.connections.values()].filter(
      connection =>
        connection.key !== currentKey &&
        connection.server.kind === server.kind &&
        connection.server.name === server.name,
    );
    for (const connection of superseded) {
      await this.invalidateConnection(connection);
    }
  }

  private async invalidateConnection(connection: ExternalConnection): Promise<void> {
    if (this.connections.get(connection.key) === connection) {
      this.connections.delete(connection.key);
    }
    await connection.client.close().catch(() => undefined);
  }

  private async callExternalTool(
    connection: ExternalConnection,
    toolName: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ResolvedToolExecutionResult> {
    if (!isRecord(input)) {
      throw new ConfigurationError(
        `MCP tool "${toolName}" requires an object input, but received ${typeof input}.`,
      );
    }

    let result: Awaited<ReturnType<Client['callTool']>>;
    try {
      result = await connection.client.callTool(
        { name: toolName, arguments: input },
        undefined,
        this.requestOptions({ signal: context.signal }),
      );
    } catch (error) {
      // Never replay a tool call here: the remote side may have completed its
      // side effect before the transport failed. Reconnect on the next call.
      await this.invalidateConnection(connection);
      throw error;
    }

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
  const fingerprint = server.kind === 'stdio'
    ? {
        kind: server.kind,
        name: server.name,
        command: server.command,
        args: server.args ?? [],
        env: sortRecord(server.env),
        cwd: server.cwd ?? null,
        stderr: server.stderr ?? 'inherit',
      }
    : {
        kind: server.kind,
        name: server.name,
        url: String(server.url),
        headers: sortRecord(server.headers),
        sessionId: server.sessionId ?? null,
      };
  return createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
}

function sortRecord(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  ));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
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



