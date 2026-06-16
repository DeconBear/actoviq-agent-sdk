# 08 — Provider Layer

## Architecture

The provider layer abstracts the model API behind a unified `ModelApi` interface.
Two implementations handle Anthropic and OpenAI wire formats, with automatic
protocol translation for cross-provider compatibility.

### Design Rationale

- **Single interface**: `createMessage()` + `streamMessage()` for all providers
- **Protocol translation**: OpenAI adapter converts Anthropic↔OpenAI formats
- **Provider-specific quirks**: handled at the adapter level, invisible to ReAct loop

## Module Design

### Files

| File | Role |
|---|---|
| `runtime/actoviqModelApi.ts` | Native Anthropic wire format |
| `provider/openai-model-api.ts` | OpenAI Chat Completions API adapter |
| `provider/types.ts` | Message, stream event, tool type definitions |
| `provider/json-parse.ts` | Robust JSON parsing (handles malformed paths) |

### `ModelApi` Interface

```typescript
interface ModelApi {
  createMessage(request: ModelRequest): Promise<Message>;
  streamMessage(request: ModelRequest): ModelStreamHandle;
}
```

### Provider Selection

```
resolveRuntimeConfig() → config.provider
    │
    ▼
agentClient.ts:
    provider === 'openai' → new OpenaiModelApi(config)
    otherwise             → new ActoviqModelApi(config)
```

Both receive the same `config` (baseURL, authToken, model, maxTokens, etc.).

### `ModelRequest` Structure

```typescript
interface ModelRequest {
  model: string;
  system?: string;
  messages: MessageParam[];
  tools?: Tool[];
  max_tokens: number;
  temperature?: number;
  // Anthropic-specific
  thinking?: { type: 'enabled'; budget_tokens: number };
  // OpenAI-specific (translated by adapter)
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}
```

### OpenAI Protocol Translation

`OpenaiModelApi` handles the format differences:

| Concept | Anthropic Format | OpenAI Format |
|---|---|---|
| **System prompt** | `system` field on request | `{ role: "system", content }` message |
| **Tools** | `{ name, description, input_schema }` | `{ type: "function", function: { name, description, parameters } }` |
| **Tool use** | `{ type: "tool_use", id, name, input }` | `{ role: "assistant", tool_calls: [{ id, function: { name, arguments } }] }` |
| **Tool result** | `{ type: "tool_result", tool_use_id, content }` | `{ role: "tool", tool_call_id, content }` |
| **Stop reason** | `stop_reason: "end_turn" | "tool_use"` | `finish_reason: "stop" | "tool_calls"` |

## Code Details

### `ActoviqModelApi`

Location: `src/runtime/actoviqModelApi.ts`

Native Anthropic Messages API client. Sends requests directly to the configured
`baseURL` with Anthropic wire format. No translation needed.

Key behaviors:
- Reads `x-api-key` from config for auth
- Supports `anthropic-beta` headers for features
- Handles streaming via SSE (`text/event-stream`)
- Returns `Message` objects with `content` array (text + tool_use blocks)

### `OpenaiModelApi`

Location: `src/provider/openai-model-api.ts`

Translates between Anthropic SDK's internal format and OpenAI Chat Completions.

**Request translation**:
```typescript
// Anthropic input → OpenAI request
async createMessage(request: ModelRequest): Promise<Message> {
  const openaiMessages = convertToOpenAiMessages(request);
  const openaiTools = request.tools?.map(convertTool);
  
  const response = await fetch(`${baseURL}/chat/completions`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: request.model,
      messages: openaiMessages,
      tools: openaiTools,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
    }),
  });
  
  return convertFromOpenAiResponse(response);
}
```

**Message conversion**:
- `{ role: "user", content: [tool_result] }` → `{ role: "tool", tool_call_id, content }`
- Tool results from tool_use blocks are matched by ID and merged into the
  assistant message's `tool_calls` array

### Provider-Specific Quirks

| Provider | Quirk | Handling |
|---|---|---|
| DeepSeek (Anthropic endpoint) | Rejects `type: "custom"` on tools | Strip `type` field from tool definitions before sending |
| Non-Anthropic providers | No `context_management` support | Skip `context_management` in requests (checked via `isAnthropicAPI`) |
| OpenAI-compatible | Different error response format | Normalized to `ActoviqProviderApiError` |
| Small providers | May not support streaming | Graceful fallback to non-streaming |

### `robustJsonParse()`

Location: `src/provider/json-parse.ts`

Handles malformed JSON from providers — specifically unescaped Windows paths:

```typescript
// Input:  {"file": "C:\Users\qzx\file.txt"}  ← invalid JSON
// Output: {"file": "C:\\Users\\qzx\\file.txt"} ← valid JSON
```

The parser attempts progressively more aggressive fixes:
1. Standard `JSON.parse`
2. Escape unescaped backslashes
3. Fix trailing commas
4. Handle truncated JSON (close open brackets)
