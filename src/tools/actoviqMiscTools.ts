/**
 * Miscellaneous tools — Config, ToolSearch, SendMessage, Skill
 * Schemas and descriptions match Claude Code exactly.
 */
import { z } from 'zod';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';

// ── Config ──────────────────────────────────────────────────────

export const CONFIG_TOOL_NAME = 'Config';

export function createConfigTool(): AgentToolDefinition {
  return tool(
    {
      name: CONFIG_TOOL_NAME,
      description: 'Read or write configuration settings.',
      inputSchema: z.strictObject({
        setting: z.string().describe('The configuration key to read or write'),
        value: z.union([z.string(), z.number(), z.boolean()]).optional().describe('The value to set. Omit to read current value.'),
      }),
      isReadOnly: () => true,
    },
    async ({ setting, value }) => {
      return { setting, value: value ?? null };
    },
  );
}

// ── ToolSearch ──────────────────────────────────────────────────

export const TOOL_SEARCH_TOOL_NAME = 'ToolSearch';

export function createToolSearchTool(): AgentToolDefinition {
  return tool(
    {
      name: TOOL_SEARCH_TOOL_NAME,
      description: 'Search for available tools by keyword. Use "select:<name>" to load a specific tool.',
      inputSchema: z.object({
        query: z.string().describe('Query to find tools. Use "select:<tool_name>" for direct selection, or keywords to search.'),
        max_results: z.number().optional().default(5).describe('Maximum number of results to return (default: 5)'),
      }),
      isReadOnly: () => true,
    },
    async ({ query, max_results }) => {
      return { matches: [], query, total_deferred_tools: 0, max_results };
    },
  );
}

// ── SendMessage ─────────────────────────────────────────────────

export function createSendMessageTool(): AgentToolDefinition {
  return tool(
    {
      name: 'SendMessage',
      description: 'Send a message to another agent or team member.',
      inputSchema: z.strictObject({
        to: z.string().describe('The recipient agent or team name'),
        summary: z.string().describe('A short summary of the message'),
        message: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('The message content'),
      }),
    },
    async ({ to, summary, message }) => {
      return { to, summary, message: typeof message === 'string' ? message : JSON.stringify(message) };
    },
  );
}

// ── Skill ───────────────────────────────────────────────────────

export const SKILL_TOOL_NAME = 'Skill';

export function createSkillTool(): AgentToolDefinition {
  return tool(
    {
      name: SKILL_TOOL_NAME,
      description: 'Invoke a registered skill by name.',
      inputSchema: z.strictObject({
        skill: z.string().describe('The name of the skill to invoke'),
        args: z.string().optional().describe('Optional arguments for the skill'),
      }),
    },
    async ({ skill, args }) => {
      return { skill, args, note: 'Skill execution requires skill registry.' };
    },
  );
}

// ── RemoteTrigger ───────────────────────────────────────────────

export function createRemoteTriggerTool(): AgentToolDefinition {
  return tool(
    {
      name: 'RemoteTrigger',
      description: 'Manage remote triggers for scheduled or event-driven execution.',
      inputSchema: z.strictObject({
        action: z.enum(['list', 'get', 'create', 'update', 'run']).describe('Action to perform'),
        trigger_id: z.string().optional().describe('Trigger ID (required for get, update, run)'),
        body: z.record(z.string(), z.unknown()).optional().describe('Trigger configuration body'),
      }),
    },
    async ({ action, trigger_id, body }) => {
      return { action, trigger_id, body };
    },
  );
}

// ── Factory ─────────────────────────────────────────────────────

export function createActoviqMiscTools(): AgentToolDefinition[] {
  return [
    createConfigTool(),
    createToolSearchTool(),
    createSendMessageTool(),
    createSkillTool(),
    createRemoteTriggerTool(),
  ];
}
