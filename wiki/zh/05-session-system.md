# 05 — 会话系统

## 架构

会话是 Hadamard SDK 中的状态单元。所有内容——消息、运行、权限、元数据、检查点——都存储在 `StoredSession` 中，以 JSON 文件形式持久化到磁盘。

### 设计理念

- **调用间无状态**：加载 → 运行 → 保存。崩溃恢复是天然的
- **人类可读**：JSON 文件可检查、编辑、备份
- **按工作区隔离**：`~/.actoviq/projects/<hash>/sessions/<id>.json`
- **无数据库依赖**：在任何文件系统上工作，可移植

## 模块设计

### 文件

| 文件 | 角色 |
|---|---|
| `storage/sessionStore.ts` | JSON 文件 CRUD + 检查点 + 原子写入 |
| `runtime/agentSession.ts` | 内存封装，提供 run/stream/compact/dream API |
| `runtime/sessionManager.ts` | 空闲超时、自动修剪、统计 |
| `runtime/actoviqSessionPermissions.ts` | 权限状态持久化 |

### `AgentSession` — 封装器

位置：`src/runtime/agentSession.ts:97`

```
AgentSession
├── 属性（从存储读取）
│   ├── id, title, model, messages, metadata, tags
│   └── permissionContext（从 metadata 计算）
│
├── 执行
│   ├── send(prompt, options?) → AgentRunResult
│   ├── stream(prompt, options?) → AgentRunStream
│   ├── runSkill / streamSkill
│
├── 状态管理
│   ├── setModel / setPermissionContext / setHooks
│   ├── rename / setTags / mergeMetadata
│
├── 生命周期
│   ├── delete() / fork() / snapshot()
│
├── 记忆与压缩
│   ├── extractMemory / dream / compact / compactState
│
└── 检查点
    ├── saveCheckpoint / restoreCheckpoint / listCheckpoints / deleteCheckpoint
```

### `AgentSessionBindings` 模式

`AgentSession` 不直接调用 `ActoviqAgentClient`。它接收一个 `bindings` 对象，包含回调函数。这避免了循环依赖，使 `AgentSession` 可以用模拟 bindings 进行测试。

### `SessionStore` — 持久化

```
SessionStore(rootDirectory)
├── create(options?) → StoredSession
├── save(session) → void              [原子写入：临时文件 + 重命名]
├── load(sessionId) → StoredSession   [失败抛出 SessionNotFoundError]
├── list() → SessionSummary[]         [逐文件错误隔离]
├── delete / updateStatus / updateLastActiveAt / fork
├── saveCheckpoint / loadCheckpoint / listCheckpoints / deleteCheckpoint
```

### 原子写入

```typescript
async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tempPath = `${filePath}.${createId()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}
```

先写入临时文件，再原子重命名。防止因部分写入导致的损坏。

### 逐文件错误隔离

`list()` 和 `listCheckpoints()` 为每个文件捕获错误，跳过损坏条目而不是让整个列表操作失败。这样单个损坏文件不会隐藏所有其他会话。

### `StoredSession` Schema

```typescript
interface StoredSession {
  version: 1;
  id: string; title: string; model: string;
  messages: MessageParam[];
  runs: AgentRunRecord[];
  status: 'active' | 'idle' | 'closed';
  createdAt: string; updatedAt: string; lastActiveAt: string;
  metadata: Record<string, unknown>;
  tags: string[]; systemPrompt?: string;
}
```

### `SessionManager` — 生命周期

- **空闲超时**：关闭超过 N ms 不活跃的会话
- **自动修剪**：删除超过 N 天的会话
- **统计**：activeCount, idleCount, closedCount
