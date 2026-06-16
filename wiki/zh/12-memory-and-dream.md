# 12 — 记忆与梦境

## 架构

记忆系统提供跨会话的持久化、上下文感知知识。Dream 系统执行反思性整合——定期回顾最近的会话并提取持久的记忆。

位置：`src/memory/actoviqMemory.ts`, `src/memory/actoviqDream.ts`

### 记忆存储布局

```
~/.actoviq/projects/<hash>/memory/
├── MEMORY.md                 # 所有记忆的索引
├── user-expertise.md         # 单独的记忆文件
├── project-architecture.md
└── reference-api-docs.md
```

### 记忆文件格式

```markdown
---
name: user-expertise
description: 用户是资深 TypeScript 开发者
metadata:
  type: user
---

用户是资深 TypeScript 开发者，专注于 agent 系统。
**Why:** 从对话模式中确定。
**How to apply:** 使用 TypeScript 惯用模式；避免解释基础知识。
```

### 记忆类型

| 类型 | 用途 | 示例 |
|---|---|---|
| `user` | 用户是谁 | 角色、专长、偏好 |
| `project` | 正在进行的工作 | 架构决策、约束 |
| `feedback` | 用户对工作方式的指导 | "始终使用 Zod 做验证" |
| `reference` | 外部资源 | URL、仪表板、工单 |

### Dream 过程

```
Dream 触发（自动或通过 /dream 手动）
    │
    ▼
1. 获取锁（tryAcquireActoviqConsolidationLock — 防止并发）
    │
    ▼
2. 识别自上次整合以来的会话
    │
    ▼
3. 为每个会话提取值得记忆的内容
    │
    ▼
4. 运行整合模型遍历
    • 读取现有记忆 + 回顾会话摘要
    • 创建新记忆 / 更新冲突记忆 / 修剪废弃记忆
    │
    ▼
5. 写入更新的 MEMORY.md + 记忆文件
    │
    ▼
6. 记录整合时间戳（recordActoviqConsolidation）
    │
    ▼
7. 释放锁
```

### Dream 锁

基于文件的锁（`dream.lock`）防止并发的 dream 过程损坏记忆文件。如果锁过期（超过锁超时时间），则打破并重新获取。

### 记忆新鲜度

```typescript
function getActoviqMemoryFreshnessNote(ageMs: number): string {
  if (ageMs < 3600000) return ' (created < 1 hour ago)';
  if (ageMs < 86400000) return ` (created ${Math.round(ageMs / 3600000)}h ago)`;
  return ` (created ${Math.round(ageMs / 86400000)}d ago)`;
}
```
