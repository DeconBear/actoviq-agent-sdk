# 16 — MCP Integration

## Architecture

The MCP (Model Context Protocol) integration connects external tool servers to
the agent. Local, stdio, and streamable HTTP servers are supported. MCP tools
appear alongside native tools in the model's tool catalog.

Location: `src/mcp/connectionManager.ts`

### Server Types

| Kind | Connection | Example |
|---|---|---|
| `local` | Direct function calls (in-process) | Bundled tools exposed as MCP |
| `stdio` | Child process (stdin/stdout JSON-RPC) | Language servers, CLI tools |
| `streamable_http` | HTTP with SSE streaming | Remote tool servers |

## Module Design

### `McpConnectionManager`

```
McpConnectionManager
├── resolveToolAdapters(localTools, servers) → ResolvedToolAdapter[]
│   ├── Local tools: create adapter directly
│   ├── Local MCP servers: prefix tool names with server name
│   └── External servers: connect, list tools, create adapters
│
├── connectToExternal(server) → void
│   ├── Stdio: spawn process, JSON-RPC over stdin/stdout
│   └── Streamable HTTP: HTTP POST + SSE
│
├── closeAll() → void
│   └── Disconnect all external connections
│
└── connections: Map<key, ExternalConnection>
```

### Tool Name Qualification

MCP tools from external servers get prefixed to avoid name collisions:

```typescript
function qualifyToolName(prefix: string, name: string): string {
  return `${sanitizeToolSegment(prefix)}__${sanitizeToolSegment(name)}`;
}
// Example: "filesystem" server + "read" tool → "filesystem__read"
```

### Tool Adapter

```typescript
interface ResolvedToolAdapter {
  name: string;                          // Qualified name
  inputSchema: z.ZodType;               // Zod schema for input
  execute: (input, context) => Promise<ResolvedToolExecutionResult>;
  isReadOnly?: (input?) => boolean;
  isDestructive?: (input?) => boolean;
  // ... metadata
}
```

## Code Details

### Connection Setup (Stdio)

```typescript
// StdioClientTransport spawns a child process
const transport = new StdioClientTransport({
  command: server.command,
  args: server.args,
  env: { ...process.env, ...server.env },
});

const client = new Client({ name: 'actoviq', version: '1.0.0' }, {
  capabilities: { tools: {} },
});

await client.connect(transport);
```

### Connection Setup (Streamable HTTP)

```typescript
const transport = new StreamableHTTPClientTransport({
  url: server.url,
  headers: server.headers,
});

const client = new Client(/* ... */);
await client.connect(transport);
```

### Tool Listing & Adapter Creation

```typescript
async resolveToolAdapters(
  localTools: AgentToolDefinition[],
  servers: AgentMcpServerDefinition[],
): Promise<ResolvedToolAdapter[]> {
  const adapters: ResolvedToolAdapter[] = [];

  // Local tools: wrap directly
  for (const tool of localTools) {
    adapters.push(createLocalToolAdapter(tool));
    for (const alias of tool.aliases ?? []) {
      adapters.push(createLocalToolAdapter(tool, alias, tool.name));
    }
  }

  // MCP servers
  for (const server of servers) {
    if (server.kind === 'local') {
      // In-process MCP: prefix + wrap
      for (const tool of server.tools) {
        adapters.push(createLocalToolAdapter(tool, qualifyToolName(prefix, tool.name), ...));
      }
    } else {
      // External MCP: connect + list tools + wrap
      await this.connectToExternal(server);
      const { tools } = await client.listTools();
      for (const mcpTool of tools) {
        adapters.push(createMcpToolAdapter(mcpTool, server, client));
      }
    }
  }

  return adapters;
}
```

### MCP Tool Execution

```typescript
function createMcpToolAdapter(
  mcpTool: McpTool,
  server: ExternalServerDefinition,
  client: Client,
): ResolvedToolAdapter {
  return {
    name: qualifyToolName(server.name, mcpTool.name),
    inputSchema: mcpTool.inputSchema ? jsonSchemaToZod(mcpTool.inputSchema) : z.object({}),
    execute: async (input, context) => {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: input as Record<string, unknown>,
      });
      return {
        output: result.content?.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n'),
        isError: result.isError ?? false,
      };
    },
  };
}
```

### MCP Lifecycle

```
SDK init:
    resolveToolAdapters() → connect to all configured MCP servers
    │
Session run:
    resolveToolAdapters() → ensure connections alive
    │
SDK close:
    closeAll() → disconnect all MCP clients
```
