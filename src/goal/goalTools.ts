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
export const PLAN_GOAL_TOOL_NAME = 'PlanGoal';

export const GOAL_TOOLS_PROMPT = `## GetGoal / CreateGoal / UpdateGoal

Use these tools to manage the active project goal. A goal is a project-scoped
execution contract with an objective, optional completion criteria, a budget,
and progress evidence. The active goal is injected into your context each turn.

- GetGoal: read the current goal (objective, status, criteria, budget, recent evidence).
- CreateGoal: set a new goal (replaces any existing one). Use when the user gives a task with a clear objective.
- PlanGoal: replace or extend the ordered work frontier. Use it when the runtime requests a replan or the bootstrap item needs decomposition.
- UpdateGoal: request a work-item transition, record progress, or request a terminal status. Work-item and Goal completion are settled after the turn and require runtime-observed evidence refs. A "blocked" report is audited; the Goal becomes blocked only after the same reason repeats for three consecutive Goal turns. "paused"/"active" status changes are user-driven via /goal, not this tool.

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

  const plan = tool(
    {
      name: PLAN_GOAL_TOOL_NAME,
      description:
        'Write a validated ordered Goal frontier. Replace the bootstrap plan when decomposing a Goal; extend only when adding successors.',
      inputSchema: z.strictObject({
        replace: z.boolean().optional().describe('Replace the existing frontier. Defaults to true.'),
        reason: z.string().optional().describe('Why this plan or replan is needed.'),
        expectedRevision: z.number().int().nonnegative().optional(),
        items: z.array(z.strictObject({
          id: z.string().optional(),
          role: z.enum(['agent', 'user']).optional(),
          priority: z.enum(['P0', 'P1', 'P2']).optional(),
          taskClass: z.enum(['advancement', 'verification', 'monitor', 'user_gate']).optional(),
          actionKind: z.string().optional(),
          text: z.string().min(1),
          dependsOn: z.array(z.string()).optional(),
          successorOf: z.string().optional(),
          resumeWhen: z.string().optional(),
        })).min(1),
      }),
      isReadOnly: () => true,
      prompt: () => GOAL_TOOLS_PROMPT,
    },
    async input => {
      const result = await ctx.getGoalService().plan({
        items: input.items,
        ...(input.replace !== undefined ? { replace: input.replace } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(typeof input.expectedRevision === 'number' ? { expectedRevision: input.expectedRevision } : {}),
      });
      return formatResult(result);
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
        workItemId: z.string().optional().describe('Selected Goal work item to update.'),
        workItemStatus: z.enum(['open', 'done', 'deferred', 'cancelled']).optional(),
        noFollowupReason: z.string().optional()
          .describe('Explicit terminal rationale when completing the final work item without a successor.'),
        resumeWhen: z.string().optional().describe('Exact condition for a deferred item to become runnable.'),
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
      if (input.workItemId || input.workItemStatus) {
        if (!input.workItemId || !input.workItemStatus) {
          return { ok: false, message: 'workItemId and workItemStatus must be provided together.' };
        }
        const result = await service.requestWorkItemUpdate({
          workItemId: input.workItemId,
          status: input.workItemStatus,
          note: input.note ?? '',
          ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
          ...(input.noFollowupReason ? { noFollowupReason: input.noFollowupReason } : {}),
          ...(input.resumeWhen ? { resumeWhen: input.resumeWhen } : {}),
          ...(typeof input.expectedRevision === 'number' ? { expectedRevision: input.expectedRevision } : {}),
        });
        return formatResult(result);
      }
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

  return [get, create, plan, update];
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
    workItems: goal.workItems,
    planRevision: goal.planRevision,
    replanAudit: goal.replanAudit.slice(-5),
    ...(goal.noFollowupReason ? { noFollowupReason: goal.noFollowupReason } : {}),
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
