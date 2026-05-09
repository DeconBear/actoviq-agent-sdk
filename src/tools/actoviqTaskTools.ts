/**
 * Actoviq Task Tools — TaskCreate, TaskUpdate, TaskList, TaskGet, TaskStop, TaskOutput
 * Schemas and descriptions match Claude Code exactly.
 */
import { z } from 'zod';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';

// ── TaskCreate ──────────────────────────────────────────────────

export const TASK_CREATE_TOOL_NAME = 'TaskCreate';

export const TASK_CREATE_DESCRIPTION = 'Create a new task in the task list.';

export function createTaskCreateTool(): AgentToolDefinition {
  return tool(
    {
      name: TASK_CREATE_TOOL_NAME,
      description: TASK_CREATE_DESCRIPTION,
      inputSchema: z.strictObject({
        subject: z.string().describe('A brief title for the task'),
        description: z.string().describe('What needs to be done'),
        activeForm: z.string().optional().describe(
          'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
        ),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Arbitrary metadata to attach to the task'),
      }),
      isConcurrencySafe: () => true,
    },
    async ({ subject, description, activeForm, metadata }) => {
      const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return { task: { id, subject, description, activeForm, metadata } };
    },
  );
}

// ── TaskUpdate ──────────────────────────────────────────────────

export const TASK_UPDATE_TOOL_NAME = 'TaskUpdate';

export function createTaskUpdateTool(): AgentToolDefinition {
  return tool(
    {
      name: TASK_UPDATE_TOOL_NAME,
      description: 'Update the status, subject, or description of a task.',
      inputSchema: z.strictObject({
        taskId: z.string().describe('The ID of the task to update'),
        subject: z.string().optional().describe('Updated task title'),
        description: z.string().optional().describe('Updated task description'),
        activeForm: z.string().optional().describe('Updated present continuous form'),
        status: z.enum(['pending', 'in_progress', 'completed']).optional().describe('Task status'),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      isConcurrencySafe: () => true,
    },
    async (input) => {
      return { taskId: input.taskId, updated: input };
    },
  );
}

// ── TaskList ────────────────────────────────────────────────────

export function createTaskListTool(): AgentToolDefinition {
  return tool(
    {
      name: 'TaskList',
      description: 'List all tasks in the current session.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => {
      return { tasks: [] };
    },
  );
}

// ── TaskGet ─────────────────────────────────────────────────────

export function createTaskGetTool(): AgentToolDefinition {
  return tool(
    {
      name: 'TaskGet',
      description: 'Retrieve a specific task by ID.',
      inputSchema: z.strictObject({
        taskId: z.string().describe('The ID of the task to get'),
      }),
      isReadOnly: () => true,
    },
    async ({ taskId }) => {
      return { taskId };
    },
  );
}

// ── TaskStop ────────────────────────────────────────────────────

export function createTaskStopTool(): AgentToolDefinition {
  return tool(
    {
      name: 'TaskStop',
      description: 'Stop a running task.',
      inputSchema: z.strictObject({
        task_id: z.string().describe('The ID of the task to stop'),
      }),
      isConcurrencySafe: () => true,
    },
    async ({ task_id }) => {
      return { task_id, stopped: true };
    },
  );
}

// ── TaskOutput ──────────────────────────────────────────────────

export function createTaskOutputTool(): AgentToolDefinition {
  return tool(
    {
      name: 'TaskOutput',
      description: 'Retrieve output from a completed or running task.',
      inputSchema: z.strictObject({
        task_id: z.string().describe('The ID of the task to get output for'),
        block: z.boolean().optional().describe('Wait for task to complete before returning'),
        timeout: z.number().optional().describe('Max wait time in milliseconds'),
      }),
      isReadOnly: () => true,
    },
    async ({ task_id }) => {
      return { task_id, output: '' };
    },
  );
}

// ── Factory ─────────────────────────────────────────────────────

export function createActoviqTaskTools(): AgentToolDefinition[] {
  return [
    createTaskCreateTool(),
    createTaskUpdateTool(),
    createTaskListTool(),
    createTaskGetTool(),
    createTaskStopTool(),
    createTaskOutputTool(),
  ];
}
