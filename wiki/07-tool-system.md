# 07 — Tool System

## Architecture

Tools are the SDK's action primitives. Every tool is a `{ name, inputSchema,
execute, prompt? }` quadruple. The `tool()` factory wraps Zod schemas into
JSON Schema with `additionalProperties: false`.

### Design Principles

- **Self-describing**: each tool declares its schema, description, and
  optional prompt for the model
- **Zod-first**: input validation via Zod v4, auto-converted to JSON Schema
- **Strict by default**: `strictObject()` → `additionalProperties: false`
- **Metadata-rich**: `isReadOnly`, `isDestructive`, `isConcurrencySafe`,
  `checkPermissions`, `interruptBehavior`, `maxResultSizeChars`

## Module Design

### Files

| File | Role |
|---|---|
| `runtime/tools.ts` | `tool()` factory, `assertPublicToolName`, `toInputJsonSchema`, adapter creation |
| `tools/actoviqCoreTools.ts` | All 22+ core tools assembled |
| `tools/actoviqFileTools.ts` | Read, Write, Edit, Glob, Grep |
| `tools/actoviqWebTools.ts` | WebFetch, WebSearch |
| `tools/actoviqTaskTools.ts` | TaskCreate, TaskUpdate, TaskList, TaskGet, TaskOutput, TaskStop |
| `tools/actoviqShellTools.ts` | PowerShell |
| `tools/actoviqNotebookEdit.ts` | NotebookEdit |
| `tools/actoviqMiscTools.ts` | Config, ToolSearch, Skill |
| `tools/bash/BashTool.ts` | Bash execution |
| `tools/todo/TodoWriteTool.ts` | Todo tracking |
| `tools/askUserQuestion/AskUserQuestionTool.ts` | Interactive questions |
| `runtime/actoviqAgents.ts` | Agent, Task, SendMessage (dynamic tools) |
| `runtime/actoviqToolCatalog.ts` | Tool metadata resolution and catalog |

### Tool Categories

| Category | Tools | Key Characteristics |
|---|---|---|
| **File** | Read, Write, Edit, Glob, Grep | Read-before-write enforcement on Write/Edit |
| **Shell** | Bash, PowerShell | Configurable timeout, sandbox support |
| **Task** | TaskCreate, Update, List, Get, Output, Stop | Task lifecycle management |
| **Agent** | Agent, Task, SendMessage | Dynamic: created per-session with agent definitions |
| **Web** | WebFetch, WebSearch | External network access |
| **Interaction** | AskUserQuestion, TodoWrite | Require user interaction |
| **Meta** | Config, ToolSearch, Skill, NotebookEdit | SDK introspection |

### Tool Registration Flow

```
1. Tool defined via tool({ name, inputSchema, ... }, execute)
    → AgentToolDefinition created
    → JSON Schema generated from Zod schema
    → additionalProperties: false enforced

2. Tool registered in createAgentSdk()
    → Passed as defaultTools
    → Merged with session-specific tools
    → MCP tools resolved at connection time

3. Tool resolution per iteration (in executeConversation)
    → Local tools → adapters
    → MCP tools → adapters (from connectionManager)
    → Deduplicated by qualified name
    → Aliases expanded (e.g., Task alias for Agent)

4. Tool prompts collected
    → collectToolPrompts() iterates all tools
    → Each tool's optional prompt() function called
    → Prompt strings appended to system prompt
```

### Tool Execution Flow

```
Model calls tool with input
    │
    ▼
1. Input validation
    adapter.inputSchema.parse(toolUse.input)
    → Zod validation error → ToolExecutionError
    │
    ▼
2. Permission check
    decideActoviqToolPermission({ mode, rules, toolName, ... })
    → deny → ToolExecutionError (blocked)
    → allow → continue
    │
    ▼
3. Execute
    adapter.execute(parsedInput, context)
    → context: { runId, sessionId, cwd, metadata, iteration, ... }
    │
    ▼
4. Result formatting
    • Success → { type: "tool_result", tool_use_id, content: [text] }
    • Error → { type: "tool_result", tool_use_id, is_error: true, content: [error] }
    • Oversized → truncated to maxResultSizeChars (default 50K)
    │
    ▼
5. Push into conversation
    { role: "user", content: [tool_result] }
```

## Code Details

### `tool()` Factory

Location: `src/runtime/tools.ts:18`

```typescript
export function tool<Input, Output>(
  config: CreateToolOptions<Input, Output>,
  execute: AgentToolDefinition<Input, Output>['execute'],
): AgentToolDefinition<Input, Output> {
  assertPublicToolName(config.name);
  const inputJsonSchema = toInputJsonSchema(config.inputSchema, config.name);
  return {
    kind: 'local',
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    inputJsonSchema,
    execute,
    strict: config.strict ?? true,
    isReadOnly: config.isReadOnly,
    isDestructive: config.isDestructive,
    requiresUserInteraction: config.requiresUserInteraction,
    isConcurrencySafe: config.isConcurrencySafe,
    checkPermissions: config.checkPermissions,
    aliases: config.aliases,
    interruptBehavior: config.interruptBehavior ?? 'block',
    maxResultSizeChars: config.maxResultSizeChars ?? 50_000,
    prompt: config.prompt,
    // ... more metadata fields
  };
}
```

### Tool Name Validation

```typescript
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function assertPublicToolName(name: string): void {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new ConfigurationError(
      `Tool name "${name}" is invalid. Use only letters, digits, "_" or "-".`
    );
  }
}
```

### Zod → JSON Schema Conversion

```typescript
function toInputJsonSchema(schema: z.ZodType, toolName: string): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema);
  if (!isRecord(jsonSchema) || jsonSchema.type !== 'object') {
    throw new ConfigurationError(
      `Tool "${toolName}" must use a Zod object schema for its input.`
    );
  }
  // Enforce strict mode (Claude Code pattern)
  if (jsonSchema.additionalProperties === undefined) {
    jsonSchema.additionalProperties = false;
  }
  return jsonSchema;
}
```

### `createActoviqCoreTools()`

Location: `src/tools/actoviqCoreTools.ts`

Assembles all 22+ tools into a single array. Accepts options for:
- `cwd`: working directory for Bash/PowerShell
- `skills`: skill definitions for Skill tool
- `agents`: agent definitions for Agent/Task tool
- `mcpServers`: MCP server list for ToolSearch

```typescript
export function createActoviqCoreTools(
  options: ActoviqCoreToolsOptions = {},
): AgentToolDefinition[] {
  return [
    // File tools
    ...createActoviqFileTools({ cwd: options.cwd }),
    // Shell tools
    createBashTool({ cwd: options.cwd }),
    createPowerShellTool({ cwd: options.cwd }),
    // Task tools
    ...createActoviqTaskTools(),
    // Interaction
    createTodoWriteTool(),
    createAskUserQuestionTool(),
    // Meta
    ...createActoviqMiscTools(options),
    // Web
    ...createActoviqWebTools(),
    // Agent delegation
    ...(hasAgents ? createActoviqTaskTools({ agents: options.agents }) : []),
  ];
}
```

### `collectToolPrompts()`

Location: `src/runtime/agentClient.ts:3756`

```typescript
function collectToolPrompts(
  tools: AgentToolDefinition[],
  context: { workDir: string; permissionMode?: ActoviqPermissionMode },
): Promise<string[]> {
  // Call each tool's optional prompt() function
  // Collect non-empty prompt strings
  // These are injected into the system prompt before the model request
}
```

### File Tools: Read-Before-Write

Write and Edit tools enforce that the file must have been read in the current
session. This prevents the model from writing to files it hasn't inspected.

### Bash Tool: Windows Support

On Windows, the Bash tool uses Git Bash for POSIX command execution. A
PowerShell tool is also available as a native alternative.

### Tool Aliases

Tools can declare aliases. The primary use case is `Agent` with alias `Task`
for Claude Code compatibility. Aliases are expanded at adapter creation time:
the same `execute` function serves both names.
