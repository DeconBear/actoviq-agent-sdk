/**
 * Plan-mode tools (EnterPlanMode / ExitPlanMode) — give the agent a structured
 * way to research-then-propose before touching code, mirroring Claude Code.
 *
 * In `plan` permission mode the engine already blocks mutating tools; these
 * tools give the agent the *vocabulary* to enter/exit planning and to present
 * its plan. EnterPlanMode flips the session to plan mode; ExitPlanMode writes
 * the plan to a per-project plan file and returns it so the TUI can show it
 * and the user can approve (switching out of plan mode) or revise.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { tool } from '../../runtime/tools.js';
import type { AgentToolDefinition, ActoviqPermissionMode } from '../../types.js';

export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode';
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode';

export const EXIT_PLAN_MODE_PROMPT = `## ExitPlanMode

Use this tool ONLY when you have finished researching and are ready to present a plan. Calling it writes the plan to the project's plan file and signals the user to review it. While in plan mode you must NOT attempt to make changes — research with read-only tools (Read/Glob/Grep/Bash read-only), then call ExitPlanMode with a concise plan. After the user approves, the plan is the source of truth: implement it, tracking progress with TodoWrite.`;

export interface PlanModeToolContext {
  /** Called when the agent requests entering/exiting plan mode. */
  onPlanModeChange?: (mode: ActoviqPermissionMode) => void;
  /** Per-project plan directory (plan file is written here). */
  planDir?: string;
}

function resolvePlanDir(workDir: string): string {
  const projectKey = workDir.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40) || 'default';
  return path.join(os.homedir(), '.actoviq', 'projects', projectKey);
}

export function planFilePath(workDir: string): string {
  return path.join(resolvePlanDir(workDir), 'plan.md');
}

export function readPlanFile(workDir: string): string | null {
  const p = planFilePath(workDir);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}

/**
 * Build the two plan-mode tools. EnterPlanMode is read-only; ExitPlanMode is
 * read-only too (it writes only the plan file, never workspace code).
 */
export function createPlanModeTools(
  workDir: string,
  ctx: PlanModeToolContext = {},
): AgentToolDefinition[] {
  const planDir = ctx.planDir ?? resolvePlanDir(workDir);

  const enter = tool(
    {
      name: ENTER_PLAN_MODE_TOOL_NAME,
      description:
        'Enter plan mode. Use at the start of a task that needs research before changes — researching, designing, and presenting a plan for approval before any code is written. In plan mode, mutating tools are blocked.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
      prompt: () =>
        `## EnterPlanMode\n\nCall this to enter plan mode for a task that warrants research-then-propose. While in plan mode, you may only read/explore — do not attempt edits. When your plan is ready, call ExitPlanMode.`,
    },
    async () => {
      ctx.onPlanModeChange?.('plan');
      return { mode: 'plan', note: 'Entered plan mode. Mutating tools are now blocked. Research, then call ExitPlanMode with your plan.' };
    },
  );

  const exit = tool(
    {
      name: EXIT_PLAN_MODE_TOOL_NAME,
      description:
        'Present your plan and exit plan mode. Writes the plan to the project plan file and returns it for user review. Call this only after researching; do not call it to ask open-ended questions.',
      inputSchema: z.strictObject({
        plan: z
          .string()
          .min(1)
          .describe('The full plan: a concise ordered list of steps, the files touched, and key decisions/risks. Markdown.'),
      }),
      isReadOnly: () => true,
      prompt: () => EXIT_PLAN_MODE_PROMPT,
    },
    async ({ plan }) => {
      try {
        mkdirSync(planDir, { recursive: true });
        writeFileSync(path.join(planDir, 'plan.md'), plan, 'utf-8');
      } catch {
        // best-effort — the plan still returns to the caller
      }
      return { plan, planFile: path.join(planDir, 'plan.md'), note: 'Plan written. The user can review/approve it (via /plan) before implementation.' };
    },
  );

  return [enter, exit];
}
