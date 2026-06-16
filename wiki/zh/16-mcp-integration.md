# 16 — MCP 集成

## 架构

MCP（Model Context Protocol）集成将外部工具服务器连接到 agent。支持本地、stdio 和 streamable HTTP 服务器。MCP 工具在模型的工具目录中与原生工具并列出现。

位置：`src/mcp/connectionManager.ts`

### 服务器类型

| 类型 | 连接方式 | 示例 |
|---|---|---|
| `local` | 直接函数调用（进程内） | 作为 MCP 暴露的内置工具 |
| `stdio` | 子进程（stdin/stdout JSON-RPC） | 语言服务器、CLI 工具 |
| `streamable_http` | HTTP + SSE 流 | 远程工具服务器 |

### `McpConnectionManager`

```
McpConnectionManager
├── resolveToolAdapters(localTools, servers) → ResolvedToolAdapter[]
│   ├── 本地工具：直接创建适配器
│   ├── 本地 MCP 服务器：用服务器名作为工具名前缀
│   └── 外部服务器：连接、列出工具、创建适配器
│
├── connectToExternal(server) → void
│   ├── Stdio：启动进程，stdin/stdout JSON-RPC
│   └── Streamable HTTP：HTTP POST + SSE
│
└── closeAll() → void
    └── 断开所有外部连接
```

### 工具名限定

外部 MCP 服务器的工具名前缀化以避免命名冲突：

```typescript
function qualifyToolName(prefix: string, name: string): string {
  return `${sanitizeToolSegment(prefix)}__${sanitizeToolSegment(name)}`;
}
// 示例："filesystem" 服务器 + "read" 工具 → "filesystem__read"
```

### 连接设置（Stdio）

```typescript
const transport = new StdioClientTransport({
  command: server.command,
  args: server.args,
  env: { ...process.env, ...server.env },
});
const client = new Client({ name: 'actoviq', version: '1.0.0' });
await client.connect(transport);
```

### 连接设置（Streamable HTTP）

```typescript
const transport = new StreamableHTTPClientTransport({
  url: server.url,
  headers: server.headers,
});
```

### MCP 生命周期

```
SDK 初始化：
    resolveToolAdapters() → 连接所有已配置的 MCP 服务器
会话运行：
    resolveToolAdapters() → 确保连接存活
SDK 关闭：
    closeAll() → 断开所有 MCP 客户端
```
