# 21 — Model Team 多模型协作

v0.5.0 新增的多模型协作系统，支持四种协作模式。
位置：`src/team/*`

## 架构

遵循 Hadamard Agent Harness 设计原则：**提供脚手架，不设约束**。模型自主决定何时收敛、何时迭代、何时接受/拒绝建议。

```
createModelTeam(definition)
    │
    ├── Panel Mode      ── 多模型并行回答 + Primary 合成裁决
    ├── Router Mode     ── 用户配置分类器 → 专家分发
    ├── Discussion Mode ── 轮次发言 + Facilitator 子代理 + Primary 终裁
    └── Executor-Reviewer ── Executor 执行 + Reviewer 建议 + Executor 终裁
```

## 四种模式

### Panel 模式（融合式多轮审议）

多个模型并行回答同一问题，Primary 接收所有回复后自主判断：是否收敛，还是需要下一轮。

```
User Prompt
     │
     ▼
┌─────────────────────────────────────┐
│  Round N                            │
│  ┌───────┐ ┌───────┐ ┌───────┐     │
│  │Model A│ │Model B│ │Model C│  并行│
│  └───┬───┘ └───┬───┘ └───┬───┘     │
│      └─────────┼─────────┘          │
│                ▼                    │
│         ┌────────────┐              │
│         │Primary Model│  裁决收敛?   │
│         └────────────┘              │
└─────────────────────────────────────┘
```

特点：
- Primary 模型完全自主——无相似度阈值、无分数截断、无轮次上限
- 上下文累积——每轮 Primary 看到所有历史响应
- 优雅降级——成员失败返回错误标记，Primary 继续处理

```typescript
const panel = await sdk.createTeam({
  mode: 'panel',
  members: [
    { model: 'MiniMax-M3', provider: 'anthropic', baseURL: 'https://api.minimaxi.com/anthropic/v1' },
    { model: 'deepseek-v4-pro', provider: 'anthropic', baseURL: 'https://api.deepseek.com/anthropic/v1' },
  ],
  primary: { model: 'deepseek-v4-pro' },
});

const result = await panel.ask('Analyze the security implications of...');
// result.answer, result.rounds, result.panelResponses, result.cost
```

### Router 模式（用户配置分发）

用户定义分类类别、每个类别的模型和系统提示词。Router 模型分类请求并分发。

```typescript
const router = await sdk.createTeam({
  mode: 'router',
  router: { model: 'claude-haiku-4-5' },
  specialists: {
    coding: { model: 'claude-sonnet-4-6', description: 'Programming tasks' },
    writing: { model: 'gpt-4o', description: 'Writing tasks' },
  },
  fallback: { model: 'claude-sonnet-4-6' },
});
```

### Discussion 模式（圆桌讨论）

每个成员按序发言，后来者看到之前所有的发言。每轮后 Facilitator 子代理给出总结和裁决建议，Primary 做最终决定。

### Executor-Reviewer 模式（执行者-评审者）

Executor 产出，Reviewer 提供自由文本建议，Executor 有最终决定权（接受/拒绝/部分接受/定稿）。

## Key 特性

### 独立 Provider 配置

每个成员可有独立的 provider、baseURL、apiKey：

```typescript
{ model: 'gpt-4o', provider: 'openai', baseURL: '...', apiKey: '$OPENAI_KEY' }
```

`$ENV_VAR` 引用在运行时解析，不写入磁盘。

### Team Tool

将团队包装为 Agent 可调用的工具：

```typescript
const tool = createTeamTool(definition);
// tool.interruptBehavior = 'block' — 不被 SendMessage 中断
// tool 使用团队自身的 timeoutMs
```

### 全局 AgentPool

所有并行工作（Workflows、Teams、Swarms）共享一个全局并发池，cap = min(16, cpuCores - 2)。

### 定价与费用追踪

- 内置 `src/team/pricing.ts`：20+ 模型定价
- 用户覆盖：`~/.actoviq/pricing.json`
- 费用追踪：每模型 input/output tokens + estimatedCost

### 团队定义持久化

```bash
~/.actoviq/teams/security-auditors.json   # 个人
.actoviq/teams/security-auditors.json     # 项目
```

项目覆盖个人。通过 `loadTeamDefinition()` / `saveTeamDefinition()` 操作。

## TUI/REPL 集成

```
/team list          — 列出已保存的团队
/team ask <name> <prompt>  — 向团队提问
```

## 设计决策

- **ADR-6**：无限迭代默认——模型自主决定收敛
- **ADR-7**：Provider 独立——每成员独立 resolveRuntimeConfig
- **ADR-8**：全局并发池——避免各功能模块重复计算并发上限
