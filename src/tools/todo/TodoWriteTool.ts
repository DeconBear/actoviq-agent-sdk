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
    },
    async ({ todos }) => {
      return {
        oldTodos: [],
        newTodos: todos,
      };
    },
  );
}
