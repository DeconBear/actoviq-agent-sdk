/**
 * Goal tools - the controlled interface the agent uses to read and update the
 * active goal. GetGoal/CreateGoal/UpdateGoal mirror Claude Code's TodoWrite
 * philosophy: the model declares state, the service validates it.
 *
 * Only the runtime may mark a goal `complete` or `blocked`, and only with
 * evidence (a note). The UI never calls these tools; it uses the slash
 * commands which call GoalService transition/revise directly.
 *
 * The tools are read-only in the permission sense (they mutate only session
 * metadata, never workspace files), so they do not require approval.
 */
import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';
import { GoalService } from './goalService.js';
import type { Goal, GoalStatus } from './types.js';

export const GET_GOAL_TOOL_NAME = 'GetGoal';
export const CREATE_GOAL_TOOL_NAME = 'CreateGoal';
export const UPDATE_GOAL_TOOL_NAME = 'UpdateGoal';

export const GOAL_TOOLS_PROMPT = `## GetGoal / CreateGoal / UpdateGoal

Use these tools to manage the active session goal. A goal is a session-scoped
execution contract with an objective, optional completion criteria, a budget,
and progress evidence. The active goal is injected into your context each turn.

- GetGoal: read the current goal (objective, status, criteria, budget, recent evidence).
- CreateGoal: set a new goal (replaces any existing one). Use when the user gives a task with a clear objective.
- UpdateGoal: record progress, or request a terminal status. "complete" is a request that the runtime settles after the turn and requires runtime-observed evidence refs when completion criteria exist. A "blocked" report is audited; the Goal becomes blocked only after the same reason repeats for three consecutive Goal turns. "paused"/"active" status changes are user-driven via /goal, not this tool.

Record progress with UpdateGoal at meaningful checkpoints. Mark complete only when the completion criteria are genuinely met, and include evidence. Report blocked only when you cannot proceed, with a concrete reason. Include expectedRevision after GetGoal when coordinating concurrent updates.`;

export interface GoalToolContext {
  /** Provides the GoalService for the current session. */
  getGoalService: () => GoalService;
}

export function createGoalTools(ctx: GoalToolContext): AgentToolDefinition[] {
  const get = tool(
    {
      name: GET_GOAL_TOOL_NAME,
      description:
        'Read the active session goal: objective, status, completion criteria, budget, and recent progress evidence. Use this to recall what you are working toward.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
      prompt: () => GOAL_TOOLS_PROMPT,
    },
    async () => {
      const service = ctx.getGoalService();
      const goal = await service.read();
      return { goal: goal ? summarizeGoal(goal) : null };
    },
  );

  const create = tool(
    {
      name: CREATE_GOAL_TOOL_NAME,
      description:
        'Create a new session goal (replaces any existing goal). Use only when the user explicitly asks to start or set a Goal. Provide a concise objective and, if known, measurable completion criteria and an optional budget.',
      inputSchema: z.strictObject({
        objective: z.string().min(1).describe('The goal objective: what success looks like, concisely.'),
        completionCriteria: z.string().optional().describe('Measurable criteria for declaring the goal complete.'),
        budget: z.strictObject({
          maxTurns: z.number().int().nonnegative().optional(),
          maxToolIterations: z.number().int().nonnegative().optional(),
          maxTokens: z.number().int().nonnegative().optional(),
        }).optional().describe('Optional execution budget. Unset fields mean unbounded.'),
      }),
      isReadOnly: () => true,
      prompt: () => GOAL_TOOLS_PROMPT,
    },
    async (input) => {
      const service = ctx.getGoalService();
      const goal = await service.create({
        objective: input.objective,
        ...(input.completionCriteria ? { completionCriteria: input.completionCriteria } : {}),
        ...(input.budget ? { budget: input.budget } : {}),
      });
      return { goal: summarizeGoal(goal), created: true };
    },
  );

  const update = tool(
    {
      name: UPDATE_GOAL_TOOL_NAME,
      description:
        'Update the active goal: record progress evidence, or transition status. Use status "complete" (with evidence note) when the objective is met, or "blocked" (with reason) when you cannot proceed. Do not use this tool to pause/resume - that is user-driven via /goal.',
      inputSchema: z.strictObject({
        status: z.enum(['active', 'complete', 'blocked']).optional()
          .describe('New status. "complete" and "blocked" require evidence/reason. Omit to record progress only.'),
        note: z.string().optional().describe('Progress evidence or completion evidence. Required for "complete".'),
        reason: z.string().optional().describe('Block reason. Required for "blocked".'),
        evidenceRefs: z.array(z.string()).optional()
          .describe('Runtime-observed evidence refs for a completion request, for example tool:<call-id>.'),
        turn: z.number().int().nonnegative().optional().describe('Runtime turn index when a block was detected.'),
        expectedRevision: z.number().int().nonnegative().optional()
          .describe('Revision returned by GetGoal. The update is rejected if another actor changed the Goal.'),
      }),
      isReadOnly: () => true,
      prompt: () => GOAL_TOOLS_PROMPT,
    },
    async (input) => {
      const service = ctx.getGoalService();
      const status = input.status as GoalStatus | undefined;
      if (status === 'complete') {
        const result = await service.requestCompletion({
          note: input.note ?? '',
          ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
          ...(typeof input.expectedRevision === 'number'
            ? { expectedRevision: input.expectedRevision }
            : {}),
        });
        return formatResult(result);
      }
      if (status === 'blocked') {
        const result = await service.block({
          reason: input.reason ?? '',
          ...(typeof input.turn === 'number' ? { turn: input.turn } : {}),
          ...(typeof input.expectedRevision === 'number'
            ? { expectedRevision: input.expectedRevision }
            : {}),
        });
        return formatResult(result);
      }
      if (!input.note) {
        return { ok: false, message: 'UpdateGoal requires a note when recording progress.' };
      }
      const result = await service.progress({
        note: input.note,
        ...(typeof input.expectedRevision === 'number'
          ? { expectedRevision: input.expectedRevision }
          : {}),
      });
      return formatResult(result);
    },
  );

  return [get, create, update];
}

function summarizeGoal(goal: Goal): Record<string, unknown> {
  return {
    objective: goal.objective,
    status: goal.status,
    ...(goal.completionCriteria ? { completionCriteria: goal.completionCriteria } : {}),
    ...(goal.budget ? { budget: goal.budget } : {}),
    consumption: goal.consumption,
    evidence: goal.evidence.slice(-5),
    blockAudit: goal.blockAudit.slice(-5),
    turnReceipts: goal.turnReceipts.slice(-5),
    ...(goal.completionRequest ? { completionRequest: goal.completionRequest } : {}),
    revision: goal.revision,
    updatedAt: goal.updatedAt,
  };
}

function formatResult(result: { ok: true; goal: Goal } | { ok: false; reason: string; message: string }): Record<string, unknown> {
  if (result.ok) {
    return { ok: true, goal: summarizeGoal(result.goal) };
  }
  return { ok: false, reason: result.reason, message: result.message };
}
