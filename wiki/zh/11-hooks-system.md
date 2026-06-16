# 11 — 钩子系统

## 架构

钩子是生命周期回调，在 agent 执行管道的特定点注入自定义行为。无需修改核心源码即可扩展 SDK。

位置：`src/hooks/actoviqHooks.ts`

### 钩子类型

| 钩子 | 触发时机 | 用例 |
|---|---|---|
| **SessionStart** | 新会话开始执行前 | 初始化上下文、验证环境 |
| **PostSampling** | 每次模型响应后 | 过滤/修改输出、注入指导 |
| **PostRun** | 运行完成后 | 日志、指标、清理 |
| **Stop** | 运行中止或出错时 | 优雅关闭、资源释放 |

### 钩子组合

通过合并策略组合钩子：base hooks + extra hooks = 合并数组。不覆盖——所有注册的钩子都会运行。

```typescript
function mergeActoviqHooks(base, extra): ActoviqHooks | undefined {
  return {
    sessionStart: [...(base?.sessionStart ?? []), ...(extra?.sessionStart ?? [])],
    postSampling: [...(base?.postSampling ?? []), ...(extra?.postSampling ?? [])],
    postRun: [...(base?.postRun ?? []), ...(extra?.postRun ?? [])],
    stopHooks: [...(base?.stopHooks ?? []), ...(extra?.stopHooks ?? [])],
  };
}
```

### PostSampling 钩子

```typescript
type ActoviqPostSamplingHook = (context: {
  sessionId?: string; runId: string;
  messages: MessageParam[]; model: string;
}) => Promise<{ messages?: MessageParam[] } | void>;
```

钩子接收完整的消息数组，可以返回修改后的消息。

### 消息标准化

```typescript
function normalizeActoviqHookMessages(messages?: MessageParam[]): MessageParam[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter(m =>
    (m.role === 'user' || m.role === 'assistant') &&
    (typeof m.content === 'string' || Array.isArray(m.content))
  );
}
```
