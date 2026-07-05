/**
 * Project Manager — a per-project governance agent (Hadamard SDK).
 *
 * The Manager maintains the project's progress documents and answers
 * direction/priority questions. Hard constraints (enforced here, not by
 * prompt):
 *
 *   - Tools: Read/Glob/Grep (scoped by `readScope`) + WebFetch + PlanWrite +
 *     ProgressWrite. No Write/Edit/Bash/shell, no Team tools, no Task.
 *   - Writes: only `plan.json` and `PROGRESS.md` inside the project store
 *     (`~/.actoviq/projects/<hash>/`), via the two dedicated tools whose
 *     target paths are hard-coded. Optional opt-in mirror of PROGRESS.md to
 *     `<workDir>/.actoviq/PROGRESS.md`.
 *   - Read scope: `workspace-only` (default) | `workspace+docs` |
 *     `explicit-allowlist` — enforced by wrapping the read tools' execute.
 *
 * Host surfaces (GUI/TUI) collect git summaries and conversation previews
 * themselves and inject them as context; the Manager has no shell.
 */
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import { getActoviqProjectSessionDirectory } from '../config/projectSessionDirectory.js';
import { isRecord } from '../runtime/helpers.js';
import type { AgentToolDefinition } from '../types.js';

// ── Progress documents ────────────────────────────────────────────

export interface ProjectPlanMilestone {
  title: string;
  due?: string;
  status?: string;
  notes?: string;
}

export interface ProjectPlan {
  milestones: ProjectPlanMilestone[];
  today: string[];
  upcoming: string[];
}

export const EMPTY_PROJECT_PLAN: ProjectPlan = { milestones: [], today: [], upcoming: [] };

export function managerPlanPath(workDir: string, homeDir: string): string {
  return path.join(getActoviqProjectSessionDirectory(workDir, homeDir), 'plan.json');
}

export function managerProgressPath(workDir: string, homeDir: string): string {
  return path.join(getActoviqProjectSessionDirectory(workDir, homeDir), 'PROGRESS.md');
}

export async function readProjectPlanFile(workDir: string, homeDir: string): Promise<ProjectPlan> {
  try {
    const raw = await readFile(managerPlanPath(workDir, homeDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProjectPlan>;
    return {
      milestones: Array.isArray(parsed.milestones) ? parsed.milestones : [],
      today: Array.isArray(parsed.today) ? parsed.today : [],
      upcoming: Array.isArray(parsed.upcoming) ? parsed.upcoming : [],
    };
  } catch {
    return { ...EMPTY_PROJECT_PLAN, milestones: [], today: [], upcoming: [] };
  }
}

export async function writeProjectPlanFile(workDir: string, homeDir: string, plan: ProjectPlan): Promise<void> {
  const filePath = managerPlanPath(workDir, homeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(plan, null, 2), 'utf8');
}

export async function readProgressFile(workDir: string, homeDir: string): Promise<string | null> {
  try {
    return await readFile(managerProgressPath(workDir, homeDir), 'utf8');
  } catch {
    return null;
  }
}

// ── Manager configuration (manager.json) ─────────────────────────

export type ManagerReadScope = 'workspace-only' | 'workspace+docs' | 'explicit-allowlist';

export interface ManagerConfig {
  /** Model override for manager runs. Empty/absent → session default. */
  model?: string;
  /** Read scope policy (default workspace-only). */
  readScope: ManagerReadScope;
  /** Extra readable paths for `workspace+docs` / `explicit-allowlist`. */
  allowedReadPaths: string[];
  /** Opt-in mirror of PROGRESS.md to `<workDir>/.actoviq/PROGRESS.md`. */
  mirrorProgressToWorkspace: boolean;
  /** Optional extra instructions appended to the manager system prompt. */
  promptOverride?: string;
}

export const DEFAULT_MANAGER_CONFIG: ManagerConfig = {
  readScope: 'workspace-only',
  allowedReadPaths: [],
  mirrorProgressToWorkspace: false,
};

export function managerConfigPath(workDir: string, homeDir: string): string {
  return path.join(getActoviqProjectSessionDirectory(workDir, homeDir), 'manager.json');
}

export async function readManagerConfig(workDir: string, homeDir: string): Promise<ManagerConfig> {
  try {
    const raw = JSON.parse(await readFile(managerConfigPath(workDir, homeDir), 'utf8'));
    if (!isRecord(raw)) return { ...DEFAULT_MANAGER_CONFIG };
    const readScope: ManagerReadScope =
      raw.readScope === 'workspace+docs' || raw.readScope === 'explicit-allowlist'
        ? raw.readScope
        : 'workspace-only';
    return {
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
      readScope,
      allowedReadPaths: Array.isArray(raw.allowedReadPaths)
        ? raw.allowedReadPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : [],
      mirrorProgressToWorkspace: raw.mirrorProgressToWorkspace === true,
      promptOverride:
        typeof raw.promptOverride === 'string' && raw.promptOverride.trim() ? raw.promptOverride : undefined,
    };
  } catch {
    return { ...DEFAULT_MANAGER_CONFIG };
  }
}

export async function writeManagerConfig(workDir: string, homeDir: string, config: ManagerConfig): Promise<void> {
  const filePath = managerConfigPath(workDir, homeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(config, null, 2), 'utf8');
}

// ── Read-scope enforcement ────────────────────────────────────────

function normalizeRoot(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '');
}

function isWithin(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Compute the roots the manager may read, per config. */
export function resolveManagerReadRoots(workDir: string, homeDir: string, config: ManagerConfig): string[] {
  const roots = [normalizeRoot(workDir), normalizeRoot(getActoviqProjectSessionDirectory(workDir, homeDir))];
  if (config.readScope === 'workspace+docs' || config.readScope === 'explicit-allowlist') {
    for (const extra of config.allowedReadPaths) roots.push(normalizeRoot(extra));
  }
  return roots;
}

/**
 * Wrap a read-only tool so any path-like input outside the allowed roots is
 * rejected before execution. Relative paths resolve against `workDir`.
 */
function restrictToolReadScope(
  toolDef: AgentToolDefinition,
  roots: string[],
  workDir: string,
): AgentToolDefinition {
  const originalExecute = toolDef.execute;
  return {
    ...toolDef,
    execute: async (input: unknown, context: unknown) => {
      if (isRecord(input)) {
        for (const key of ['file_path', 'path']) {
          const value = input[key];
          if (typeof value === 'string' && value.trim()) {
            const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(workDir, value);
            if (!roots.some((root) => isWithin(resolved, root))) {
              throw new Error(
                `Manager read scope violation: "${value}" is outside the allowed roots. ` +
                  'Adjust manager.readScope / allowedReadPaths to widen access.',
              );
            }
          }
        }
      }
      return (originalExecute as (i: unknown, c: unknown) => unknown)(input, context);
    },
  } as AgentToolDefinition;
}

// ── Manager tools ─────────────────────────────────────────────────

export interface CreateManagerToolsOptions {
  workDir: string;
  homeDir: string;
  config?: ManagerConfig;
}

const MANAGER_READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);

/**
 * The Manager's entire tool surface. By construction there is no Write, Edit,
 * Bash, shell, Team, or Task tool here — the only mutations possible are the
 * two progress documents, at hard-coded paths.
 */
export async function createManagerTools(options: CreateManagerToolsOptions): Promise<AgentToolDefinition[]> {
  const { workDir, homeDir } = options;
  const config = options.config ?? (await readManagerConfig(workDir, homeDir));
  const roots = resolveManagerReadRoots(workDir, homeDir, config);

  const { createActoviqFileTools } = await import('../tools/actoviqFileTools.js');
  const { createActoviqWebTools } = await import('../tools/actoviqWebTools.js');

  const readTools = createActoviqFileTools({ cwd: workDir })
    .filter((t) => MANAGER_READ_TOOLS.has(t.name))
    .map((t) => restrictToolReadScope(t, roots, workDir));
  const webTools = createActoviqWebTools().filter((t) => t.name === 'WebFetch');

  const planWrite = tool(
    {
      name: 'PlanWrite',
      description:
        'Replace the structured project plan (plan.json): milestones, today, upcoming. ' +
        'This is the ONLY way to update the plan. Always read the current plan first and preserve entries you are not changing.',
      inputSchema: z.strictObject({
        milestones: z
          .array(
            z.strictObject({
              title: z.string().describe('Milestone title'),
              due: z.string().optional().describe('Due date (free-form, e.g. 2026-07-12)'),
              status: z.string().optional().describe('Status, e.g. planned | active | blocked | done'),
              notes: z.string().optional().describe('Short notes'),
            }),
          )
          .describe('Full milestone list (replaces the existing list)'),
        today: z.array(z.string()).describe('Full "today" item list (replaces the existing list)'),
        upcoming: z.array(z.string()).describe('Full "upcoming" item list (replaces the existing list)'),
      }),
      isReadOnly: () => false,
      serialize: (output: { path: string }) => `Plan written to ${output.path}`,
    },
    async (input) => {
      const plan: ProjectPlan = {
        milestones: input.milestones,
        today: input.today,
        upcoming: input.upcoming,
      };
      await writeProjectPlanFile(workDir, homeDir, plan);
      return { path: managerPlanPath(workDir, homeDir) };
    },
  );

  const progressWrite = tool(
    {
      name: 'ProgressWrite',
      description:
        'Replace PROGRESS.md — the human-readable progress document (summary, risks, decisions, changelog). ' +
        'This is the ONLY way to update it. Read the current content first and carry forward sections that are still accurate.',
      inputSchema: z.strictObject({
        content: z.string().describe('The full new PROGRESS.md markdown content'),
      }),
      isReadOnly: () => false,
      serialize: (output: { path: string; mirrored?: string }) =>
        `Progress written to ${output.path}${output.mirrored ? ` (mirrored to ${output.mirrored})` : ''}`,
    },
    async (input) => {
      const filePath = managerProgressPath(workDir, homeDir);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, input.content, 'utf8');
      let mirrored: string | undefined;
      if (config.mirrorProgressToWorkspace) {
        const mirrorPath = path.join(workDir, '.actoviq', 'PROGRESS.md');
        await mkdir(path.dirname(mirrorPath), { recursive: true });
        await writeFile(mirrorPath, input.content, 'utf8');
        mirrored = mirrorPath;
      }
      return { path: filePath, mirrored };
    },
  );

  return [...readTools, ...webTools, planWrite, progressWrite];
}

// ── Prompts ───────────────────────────────────────────────────────

export function buildManagerSystemPrompt(workDir: string, config?: ManagerConfig): string {
  const base = [
    'You are the project Manager for the workspace at ' + workDir + '.',
    '',
    'Your job: maintain the project progress documents, summarize risks and blockers, and respond to direction / priority / milestone adjustments from the user.',
    '',
    'Hard rules:',
    '- You NEVER modify project source code. You have no Write/Edit/Bash tools; do not attempt workarounds.',
    '- The ONLY documents you maintain are the structured plan (via the PlanWrite tool) and PROGRESS.md (via the ProgressWrite tool).',
    '- Use Read/Glob/Grep to inspect the project and WebFetch for reference material. Cite file paths in your findings.',
    '- Before updating a document, read its current state and preserve everything still accurate.',
    '- Keep PROGRESS.md human-readable: a short status summary, milestones, risks/blockers, notable decisions, and a dated changelog section.',
    '- You do not run teams or delegate to other agents. If multi-perspective research would help, recommend the user run `/team ask` in the main conversation instead.',
    '- Be concise and concrete. Prefer verifiable statements over speculation.',
  ].join('\n');
  const override = config?.promptOverride?.trim();
  return override ? base + '\n\nAdditional project-specific instructions:\n' + override : base;
}

export interface ManagerUpdateContext {
  /** Conversation summaries collected by the host (title, date, preview). */
  conversationSummaries?: string;
  /** Read-only git summary collected by the host (branch, dirty, recent commits). */
  gitSummary?: string;
  /** Current plan.json content (JSON string), if any. */
  currentPlanJson?: string;
  /** Current PROGRESS.md content, if any. */
  currentProgress?: string;
  /** Extra user instruction for this update. */
  instruction?: string;
}

/** Build the "Update progress" run prompt from host-collected context. */
export function buildUpdateProgressPrompt(context: ManagerUpdateContext): string {
  const parts: string[] = [
    'Update the project progress documents based on the context below.',
    '',
    '1. Update the structured plan with PlanWrite: reconcile milestones/today/upcoming with what actually happened.',
    '2. Update PROGRESS.md with ProgressWrite: refresh the status summary, note risks/blockers, and append a dated changelog entry for this update.',
    'Keep both faithful to the evidence; do not invent progress.',
  ];
  if (context.instruction?.trim()) {
    parts.push('', 'User instruction for this update:', context.instruction.trim());
  }
  if (context.currentPlanJson) {
    parts.push('', '--- Current plan.json ---', context.currentPlanJson);
  }
  parts.push(
    '',
    '--- Current PROGRESS.md ---',
    context.currentProgress?.trim() ? context.currentProgress : '(none yet — create it)',
  );
  if (context.conversationSummaries?.trim()) {
    parts.push('', '--- Recent conversations (collected by the host) ---', context.conversationSummaries.trim());
  }
  if (context.gitSummary?.trim()) {
    parts.push('', '--- Git status (read-only, collected by the host) ---', context.gitSummary.trim());
  }
  return parts.join('\n');
}
