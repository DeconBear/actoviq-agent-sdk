/**
 * Plan-mode tools (EnterPlanMode / ExitPlanMode) — give the agent a structured
 * way to research-then-propose before touching code, mirroring Claude Code.
 *
 * In `plan` permission mode the engine already blocks mutating tools; these
 * tools give the agent the *vocabulary* to enter/exit planning and to present
 * its plan. EnterPlanMode flips the session to plan mode; ExitPlanMode writes
 * the plan to a per-project plan file and returns it so the TUI can show it
 * and the user can approve (switching out of plan mode) or revise.
 *
 * Each ExitPlanMode call writes a unique file
 * (`plan-<UTC-timestamp>-<uuid>.md`) so history is preserved. A small
 * `plan.current` pointer tracks the latest plan for `/plan view|open|approve`.
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

import { tool } from '../../runtime/tools.js';
import { resolveHadamardHome } from '../../config/hadamardHome.js';
import type { AgentToolDefinition, HadamardPermissionMode } from '../../types.js';

export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode';
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode';

/** Pointer file that names the latest plan markdown (relative basename). */
export const PLAN_CURRENT_POINTER = 'plan.current';

/** Versioned plan files: plan-20260804T100930Z-<uuid>.md */
export const PLAN_FILE_PATTERN = /^plan-(\d{8}T\d{6}Z)-([0-9a-f-]{36})\.md$/i;

/** Legacy single-file name kept readable as a fallback. */
export const LEGACY_PLAN_FILE = 'plan.md';

export const EXIT_PLAN_MODE_PROMPT = `## ExitPlanMode

Use this tool ONLY when you have finished researching and are ready to present a plan. Calling it writes the plan to the project's plan file and signals the user to review it. While in plan mode you must NOT attempt to make changes — research with read-only tools (Read/Glob/Grep/Bash read-only), then call ExitPlanMode with a concise plan. After the user approves, the plan is the source of truth: implement it, tracking progress with TodoWrite.`;

export interface PlanModeToolContext {
  /** Called when the agent requests entering/exiting plan mode. */
  onPlanModeChange?: (mode: HadamardPermissionMode) => void | Promise<void>;
  /** Per-project plan directory (plan file is written here). */
  planDir?: string;
  /** Optional clock/uuid hooks for tests. */
  now?: () => Date;
  createId?: () => string;
}

function resolvePlanDir(workDir: string): string {
  const projectKey = workDir.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40) || 'default';
  return path.join(resolveHadamardHome(), 'projects', projectKey);
}

export function planDirFor(workDir: string): string {
  return resolvePlanDir(workDir);
}

/** UTC stamp suitable for filenames and lexical sort (newest last). */
export function formatPlanTimestamp(date: Date = new Date()): string {
  const iso = date.toISOString(); // 2026-08-04T10:09:30.123Z
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function buildPlanFileName(opts?: { now?: Date; id?: string }): string {
  const stamp = formatPlanTimestamp(opts?.now ?? new Date());
  const id = opts?.id ?? randomUUID();
  return `plan-${stamp}-${id}.md`;
}

function readCurrentPointer(planDir: string): string | null {
  const pointerPath = path.join(planDir, PLAN_CURRENT_POINTER);
  if (!existsSync(pointerPath)) return null;
  const name = readFileSync(pointerPath, 'utf-8').trim();
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  const full = path.join(planDir, name);
  return existsSync(full) ? full : null;
}

function listVersionedPlanNames(planDir: string): string[] {
  if (!existsSync(planDir)) return [];
  return readdirSync(planDir)
    .filter(name => PLAN_FILE_PATTERN.test(name))
    .sort();
}

/**
 * Absolute path of the current (latest) plan file for this workDir.
 * Prefers `plan.current` pointer, then newest versioned file, then legacy `plan.md`.
 */
export function planFilePath(workDir: string): string {
  const planDir = resolvePlanDir(workDir);
  const pointed = readCurrentPointer(planDir);
  if (pointed) return pointed;
  const versioned = listVersionedPlanNames(planDir);
  if (versioned.length > 0) {
    return path.join(planDir, versioned[versioned.length - 1]!);
  }
  return path.join(planDir, LEGACY_PLAN_FILE);
}

export function readPlanFile(workDir: string): string | null {
  const p = planFilePath(workDir);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}

/** All retained plan files for a workDir, oldest → newest. */
export function listPlanFiles(workDir: string): string[] {
  const planDir = resolvePlanDir(workDir);
  const versioned = listVersionedPlanNames(planDir).map(name => path.join(planDir, name));
  const legacy = path.join(planDir, LEGACY_PLAN_FILE);
  if (versioned.length === 0 && existsSync(legacy)) return [legacy];
  return versioned;
}

function writeCurrentPointerSync(planDir: string, fileName: string): void {
  writeFileSync(path.join(planDir, PLAN_CURRENT_POINTER), `${fileName}\n`, 'utf-8');
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
      await ctx.onPlanModeChange?.('plan');
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
      const fileName = buildPlanFileName({
        now: ctx.now?.() ?? new Date(),
        id: ctx.createId?.() ?? randomUUID(),
      });
      const planFile = path.join(planDir, fileName);
      await mkdir(planDir, { recursive: true });
      await writeFile(planFile, plan, 'utf-8');
      writeCurrentPointerSync(planDir, fileName);
      return {
        plan,
        planFile,
        status: 'awaiting_approval',
        approvalRequired: true,
        actions: ['approve', 'revise'],
        note: 'Plan written. The user must approve it before implementation. Plan mode remains active until approval.',
      };
    },
  );

  return [enter, exit];
}
