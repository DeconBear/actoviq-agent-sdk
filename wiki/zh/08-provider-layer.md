# 08 — Provider 层

## 架构

Provider 层在统一的 `ModelApi` 接口后抽象模型 API。两个实现分别处理 Anthropic 和 OpenAI 的通信协议，提供自动协议转换。

位置：`src/runtime/actoviqModelApi.ts`, `src/provider/openai-model-api.ts`

### `ModelApi` 接口

```typescript
interface ModelApi {
  createMessage(request: ModelRequest): Promise<Message>;
  streamMessage(request: ModelRequest): ModelStreamHandle;
}
```

### Provider 选择

```
resolveRuntimeConfig() → config.provider
    │
    ▼
provider === 'openai' → new OpenaiModelApi(config)
otherwise             → new ActoviqModelApi(config)
```

### OpenAI 协议转换

`OpenaiModelApi` 处理格式差异：

| 概念 | Anthropic 格式 | OpenAI 格式 |
|---|---|---|
| **系统提示词** | 请求的 `system` 字段 | `{ role: "system", content }` 消息 |
| **工具** | `{ name, description, input_schema }` | `{ type: "function", function: { name, parameters } }` |
| **工具调用** | `{ type: "tool_use", id, name, input }` | `{ role: "assistant", tool_calls: [...] }` |
| **工具结果** | `{ type: "tool_result", tool_use_id, content }` | `{ role: "tool", tool_call_id, content }` |

### Provider 特定怪异行为

| Provider | 问题 | 处理方式 |
|---|---|---|
| DeepSeek (Anthropic 端点) | 拒绝工具上的 `type: "custom"` | 发送前去除工具定义中的 `type` 字段 |
| 非 Anthropic 提供者 | 不支持 `context_management` | 跳过请求中的 `context_management` |
| OpenAI 兼容 | 不同错误响应格式 | 标准化为 `ActoviqProviderApiError` |

### `robustJsonParse()`

处理来自 provider 的畸形的 JSON——特别是未转义的 Windows 路径：
- 标准 `JSON.parse`
- 转义未转义的反斜杠
- 修复尾部逗号
- 处理截断的 JSON
