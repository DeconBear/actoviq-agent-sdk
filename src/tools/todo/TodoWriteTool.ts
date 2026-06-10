import { z } from 'zod';
import { tool } from '../../runtime/tools.js';
import type { AgentToolDefinition } from '../../types.js';

export const TODO_WRITE_TOOL_NAME = 'TodoWrite';

const TodoStatusSchema = z.enum(['pending', 'in_progress', 'completed']);

const TodoItemSchema = z.object({
  content: z.string().min(1, 'Content cannot be empty'),
  status: TodoStatusSchema,
  activeForm: z.string().min(1, 'Active form cannot be empty'),
});

const TodoListSchema = z.array(TodoItemSchema);

export const TODO_PROMPT = `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.

## When to Use This Tool
Use proactively in these scenarios:

1. Complex multi-step tasks - 3 or more distinct steps
2. Non-trivial tasks requiring careful planning
3. User explicitly requests todo list
4. User provides multiple tasks (numbered or comma-separated)
5. After receiving new instructions - capture requirements as todos
6. When starting a task - mark it in_progress BEFORE beginning (limit ONE at a time)
7. After completing a task - mark completed, add follow-up tasks discovered

## When NOT to Use
Skip when: single straightforward task, trivial task, purely conversational/informational request.

## Task States and Management

1. Task States: pending, in_progress, completed
   - content: imperative form describing what to do (e.g., "Run tests")
   - activeForm: present continuous form shown during execution (e.g., "Running tests")

2. Task Management:
   - Update status in real-time, mark complete IMMEDIATELY after finishing
   - Exactly ONE task in_progress at any time
   - Complete current tasks before starting new ones
   - Remove irrelevant tasks from the list

3. Task Completion Requirements:
   - ONLY mark completed when FULLY accomplished
   - If you encounter errors or cannot finish, keep in_progress
   - When blocked, create a new task describing the issue

When in doubt, use this tool. Proactive task management demonstrates attentiveness.`;

export const TODO_DESCRIPTION =
  'Update the todo list for the current session. To be used proactively to track progress and pending tasks. At least one task should be in_progress at all times. Always provide both content (imperative) and activeForm (present continuous) for each task.';

type TodoItem = z.infer<typeof TodoItemSchema>;

// Todo state is scoped per session (falling back to run) so long sessions can
// re-read prior state and the result snapshot stays accurate across turns.
const MAX_TRACKED_TODO_SCOPES = 256;
const todoStateByScope = new Map<string, TodoItem[]>();

function rememberTodos(scopeKey: string, todos: TodoItem[]): TodoItem[] {
  const previous = todoStateByScope.get(scopeKey) ?? [];
  // Refresh insertion order so the eviction below drops the stalest scope.
  todoStateByScope.delete(scopeKey);
  todoStateByScope.set(scopeKey, todos);
  if (todoStateByScope.size > MAX_TRACKED_TODO_SCOPES) {
    const oldest = todoStateByScope.keys().next().value;
    if (oldest !== undefined) {
      todoStateByScope.delete(oldest);
    }
  }
  return previous;
}

export function getActoviqTodoSnapshot(scopeKey: string): TodoItem[] {
  return todoStateByScope.get(scopeKey) ?? [];
}

function formatTodoLine(todo: TodoItem): string {
  const marker = todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]';
  const suffix = todo.status === 'in_progress' ? ` (in progress: ${todo.activeForm})` : '';
  return `${marker} ${todo.content}${suffix}`;
}

export function formatActoviqTodoListLines(todos: TodoItem[]): string {
  return todos.map(formatTodoLine).join('\n');
}

function buildTodoResultText(todos: TodoItem[]): string {
  const lines = formatActoviqTodoListLines(todos);
  return [
    'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable.',
    '',
    '<system-reminder>',
    'Current todo list state:',
    lines || '(empty)',
    'Continue working through pending items; keep exactly one task in_progress.',
    '</system-reminder>',
  ].join('\n');
}

export function createTodoWriteTool(): AgentToolDefinition {
  return tool(
    {
      name: TODO_WRITE_TOOL_NAME,
      description: TODO_DESCRIPTION,
      inputSchema: z.strictObject({
        todos: TodoListSchema.describe('The updated todo list'),
      }),
      isReadOnly: () => true,
      prompt: () => TODO_PROMPT,
      serialize: (output) => buildTodoResultText((output as { newTodos: TodoItem[] }).newTodos),
    },
    async ({ todos }, context) => {
      const scopeKey = context.sessionId ?? context.runId;
      const oldTodos = rememberTodos(scopeKey, todos);
      return {
        oldTodos,
        newTodos: todos,
      };
    },
  );
}
