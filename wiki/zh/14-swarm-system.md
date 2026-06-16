# 14 — Swarm 系统

## 架构

Swarm 系统通过邮箱通信模式提供长期的多 agent 协作。与子代理（一次性或等待完成）不同，Swarm 队友跨交互持久存在并异步交换消息。

位置：`src/swarm/actoviqSwarm.ts`

### Swarm vs 子代理

| | 子代理 | Swarm |
|---|---|---|
| **生命周期** | 单次任务后终止 | 跨多次交互持久存在 |
| **通信** | 输入 → 输出（一次性） | 邮箱（异步消息传递） |
| **协调** | 父代理编排 | Lead agent 监督同伴 |
| **状态** | 仅会话内 | 持久的队友状态 |
| **用例** | 委派一个任务 | 随时间推移协作 |

## 邮箱模式

```
队友 A                      邮箱                      队友 B
    │                         │                          │
    │── send(msg to B) ──────▶│                          │
    │                         │── 存储消息               │
    │                         │                          │── receive() ──▶
    │                         │                          │   读取消息
    │                         │                          │── send(reply) ──▶
    │── receive() ───────────▶│                          │
    │   读取回复               │                          │
```

### 核心 API

```typescript
class ActoviqSwarmApi {
  async createTeam(name, config) → ActoviqSwarmTeam
  async listTeams() → ActoviqSwarmTeamSummary[]
}

class ActoviqSwarmTeammateHandle {
  async send(to, message) → void       // 发送到邮箱
  async receive() → MailboxMessage[]   // 从邮箱接收
  async run(prompt) → AgentRunResult   // 运行对话
}
```

### `MailboxStore`

```typescript
class MailboxStore {
  async send(msg) → void     // 持久化消息
  async receive(name) → []   // 读取并标记为已投递
  async list(name) → []      // 所有消息
}
```
