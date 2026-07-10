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
 *     `explicit-allowlist` | `full-access` — enforced by wrapping the read
 *     tools' execute (`full-access` skips path checks; writes stay limited).
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
import {
  addIssueComment,
  createProjectIssue,
  isIssuePriority,
  isIssueStatus,
  listProjectIssues,
  transitionProjectIssue,
  updateProjectIssue,
  type IssueStorageMode,
  type ProjectIssue,
} from '../issues/issueStore.js';

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

export async function writeProgressFile(workDir: string, homeDir: string, content: string): Promise<string> {
  const filePath = managerProgressPath(workDir, homeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

// ── Manager configuration (manager.json) ─────────────────────────

export type ManagerReadScope =
  | 'workspace-only'
  | 'workspace+docs'
  | 'explicit-allowlist'
  | 'full-access';

export const MANAGER_READ_SCOPES: readonly ManagerReadScope[] = [
  'workspace-only',
  'workspace+docs',
  'explicit-allowlist',
  'full-access',
] as const;

export function isManagerReadScope(value: unknown): value is ManagerReadScope {
  return typeof value === 'string' && (MANAGER_READ_SCOPES as readonly string[]).includes(value);
}

export interface ManagerConfig {
  /**
   * Optional model id override for manager runs.
   * With `bridgeConfig`: overrides that config's default model (same provider/credentials).
   * Without `bridgeConfig`: overrides the session model. Empty/absent → no override.
   */
  model?: string;
  /**
   * Named provider config from `~/.actoviq/bridge-configs.json`. When set, the
   * Manager turn uses that config's model/provider credentials (Hadamard path).
   */
  bridgeConfig?: string;
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
    const readScope: ManagerReadScope = isManagerReadScope(raw.readScope)
      ? raw.readScope
      : 'workspace-only';
    return {
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
      bridgeConfig: typeof raw.bridgeConfig === 'string' && raw.bridgeConfig.trim()
        ? raw.bridgeConfig.trim()
        : undefined,
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

/** Compute the roots the manager may read, per config. Empty = unrestricted. */
export function resolveManagerReadRoots(workDir: string, homeDir: string, config: ManagerConfig): string[] {
  if (config.readScope === 'full-access') return [];
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
  issueStorageMode?: IssueStorageMode;
}

const MANAGER_READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);

function matchesManagerIssue(issue: ProjectIssue, idOrNumber: string | number): boolean {
  return typeof idOrNumber === 'number'
    ? issue.number === idOrNumber
    : issue.id === idOrNumber || String(issue.number) === idOrNumber || `ISS-${issue.number}` === idOrNumber.toUpperCase();
}

function summarizeManagerIssue(issue: ProjectIssue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    key: `ISS-${issue.number}`,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    labels: issue.labels,
    acceptanceCriteria: issue.acceptanceCriteria,
    agentConfig: issue.agentConfig,
    activeSessionId: issue.activeSessionId,
    sessionIds: issue.sessionIds,
    updatedAt: issue.updatedAt,
  };
}

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
    .map((t) => (config.readScope === 'full-access' ? t : restrictToolReadScope(t, roots, workDir)));
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

  const issueStorageMode = options.issueStorageMode ?? 'home';

  const issueList = tool(
    {
      name: 'IssueList',
      description:
        'List project issues from the project issue board. Use this before updating issues so you preserve current state.',
      inputSchema: z.strictObject({
        status: z.string().optional().describe('Optional status filter'),
        includeClosed: z.boolean().optional().describe('Include done/cancelled issues (default false)'),
      }),
      isReadOnly: () => true,
      serialize: (output: { issues: unknown[] }) => `Listed ${output.issues.length} issue(s)`,
    },
    async (input) => {
      const issues = await listProjectIssues(workDir, homeDir, issueStorageMode);
      const filtered = issues
        .filter(issue => !input.status || issue.status === input.status)
        .filter(issue => input.includeClosed === true || (issue.status !== 'done' && issue.status !== 'cancelled'))
        .map(summarizeManagerIssue);
      return { issues: filtered };
    },
  );

  const issueGet = tool(
    {
      name: 'IssueGet',
      description: 'Read one project issue by id, number, or ISS-<number> key.',
      inputSchema: z.strictObject({
        id: z.union([z.string(), z.number()]).describe('Issue id, number, or ISS-<number> key'),
      }),
      isReadOnly: () => true,
      serialize: (output: { issue?: ProjectIssue }) => output.issue ? `Read ISS-${output.issue.number}` : 'Issue not found',
    },
    async (input) => {
      const issues = await listProjectIssues(workDir, homeDir, issueStorageMode);
      return { issue: issues.find(issue => matchesManagerIssue(issue, input.id)) };
    },
  );

  const issueCreate = tool(
    {
      name: 'IssueCreate',
      description:
        'Create a project issue. Write clear acceptance criteria. New issues default to todo; use status=backlog only for parking-lot items.',
      inputSchema: z.strictObject({
        title: z.string().describe('Issue title'),
        description: z.string().optional().describe('Issue description'),
        status: z.string().optional().describe('Optional initial status: todo or backlog'),
        priority: z.string().optional().describe('urgent | high | medium | low | none'),
        labels: z.array(z.string()).optional(),
        acceptanceCriteria: z.array(z.string()).optional(),
        agentConfig: z.string().optional().describe('Optional Agent Profile name to use when dispatching this issue'),
      }),
      isReadOnly: () => false,
      serialize: (output: { issue: ProjectIssue }) => `Created ISS-${output.issue.number}: ${output.issue.title}`,
    },
    async (input) => {
      if (input.status !== undefined && input.status !== 'todo' && input.status !== 'backlog') {
        throw new Error('Manager may create issues only as todo or backlog.');
      }
      if (input.priority !== undefined && !isIssuePriority(input.priority)) {
        throw new Error(`Invalid issue priority: ${input.priority}`);
      }
      const issue = await createProjectIssue(workDir, homeDir, {
        title: input.title,
        description: input.description,
        status: input.status === 'backlog' ? 'backlog' : 'todo',
        priority: isIssuePriority(input.priority) ? input.priority : undefined,
        labels: input.labels,
        acceptanceCriteria: input.acceptanceCriteria,
        createdBy: 'manager',
        agentConfig: input.agentConfig,
      }, issueStorageMode);
      return { issue };
    },
  );

  const issueUpdate = tool(
    {
      name: 'IssueUpdate',
      description:
        'Update an existing project issue. Status changes go through the lifecycle guard. Never set in_progress; dispatch is the only owner of that transition.',
      inputSchema: z.strictObject({
        id: z.union([z.string(), z.number()]).describe('Issue id, number, or ISS-<number> key'),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.string().optional().describe('backlog | todo | in_review | done | blocked | cancelled. in_progress is forbidden here.'),
        priority: z.string().optional().describe('urgent | high | medium | low | none'),
        labels: z.array(z.string()).optional(),
        acceptanceCriteria: z.array(z.string()).optional(),
        agentConfig: z.string().optional(),
        brief: z.string().optional(),
      }),
      isReadOnly: () => false,
      serialize: (output: { issue: ProjectIssue }) => `Updated ISS-${output.issue.number}: ${output.issue.status}`,
    },
    async (input) => {
      if (input.priority !== undefined && !isIssuePriority(input.priority)) {
        throw new Error(`Invalid issue priority: ${input.priority}`);
      }
      const patch: Parameters<typeof updateProjectIssue>[3] = {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(isIssuePriority(input.priority) ? { priority: input.priority } : {}),
        ...(input.labels !== undefined ? { labels: input.labels } : {}),
        ...(input.acceptanceCriteria !== undefined ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
        ...(input.agentConfig !== undefined ? { agentConfig: input.agentConfig } : {}),
        ...(input.brief !== undefined ? { brief: input.brief } : {}),
      };
      let issue = Object.keys(patch).length > 0
        ? await updateProjectIssue(workDir, homeDir, input.id, patch, issueStorageMode)
        : (await listProjectIssues(workDir, homeDir, issueStorageMode)).find(candidate => matchesManagerIssue(candidate, input.id));
      if (!issue) throw new Error(`Issue not found: ${String(input.id)}`);
      if (input.status !== undefined) {
        if (!isIssueStatus(input.status)) throw new Error(`Invalid issue status: ${input.status}`);
        if (input.status === 'in_progress') {
          throw new Error('Manager cannot set in_progress. Start/dispatch the issue instead.');
        }
        issue = await transitionProjectIssue(workDir, homeDir, input.id, input.status, 'manager', issueStorageMode);
        if (!issue) throw new Error(`Issue not found: ${String(input.id)}`);
      }
      return { issue };
    },
  );

  const issueComment = tool(
    {
      name: 'IssueComment',
      description: 'Append a manager comment or progress note to a project issue.',
      inputSchema: z.strictObject({
        id: z.union([z.string(), z.number()]).describe('Issue id, number, or ISS-<number> key'),
        body: z.string().describe('Comment body'),
        kind: z.string().optional().describe('comment | progress | system'),
      }),
      isReadOnly: () => false,
      serialize: (output: { issue: ProjectIssue }) => `Commented on ISS-${output.issue.number}`,
    },
    async (input) => {
      const kind = input.kind === 'progress' || input.kind === 'system' ? input.kind : 'comment';
      const issue = await addIssueComment(workDir, homeDir, input.id, { body: input.body, kind, actor: 'manager' }, issueStorageMode);
      if (!issue) throw new Error(`Issue not found: ${String(input.id)}`);
      return { issue };
    },
  );

  return [...readTools, ...webTools, planWrite, progressWrite, issueList, issueGet, issueCreate, issueUpdate, issueComment];
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
    '- You also maintain the project issue board using IssueList, IssueGet, IssueCreate, IssueUpdate, and IssueComment.',
    '- Create issues with clear acceptance criteria. Keep issue titles actionable and status changes evidence-based.',
    '- Never move an issue to in_progress with IssueUpdate. That status is owned by deterministic dispatch after a worker session starts successfully.',
    '- Use in_review only when worker evidence says the issue is ready for review; move in_review to done only after evidence supports completion.',
    '- Use Read/Glob/Grep to inspect the project and WebFetch for reference material. Cite file paths in your findings.',
    ...(config?.readScope === 'full-access'
      ? ['- Read scope is full-access: you may read any path on this machine. You still cannot write outside plan/PROGRESS.']
      : []),
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
  /** Open PR digest from GitHub REST (host-collected when `GITHUB_TOKEN` is set). */
  githubDigest?: string;
  /** Current plan.json content (JSON string), if any. */
  currentPlanJson?: string;
  /** Current PROGRESS.md content, if any. */
  currentProgress?: string;
  /** Current project issue board as JSON, if any. */
  currentIssuesJson?: string;
  /** Extra user instruction for this update. */
  instruction?: string;
}

export interface IssueDecomposeContext {
  currentPlanJson?: string;
  currentProgress?: string;
}

export function buildDecomposeIssuePrompt(issue: ProjectIssue, context: IssueDecomposeContext = {}): string {
  const parts = [
    `Decompose ISS-${issue.number}: ${issue.title}`,
    '',
    'Produce a detailed worker brief in Markdown. Return only the brief.',
    '',
    'The brief must include:',
    '- Background and relevant project context.',
    '- Objective and non-goals.',
    '- Step-by-step execution plan.',
    '- Verification commands or checks.',
    '- Acceptance criteria copied or refined from the issue.',
    '- Reporting instructions: when all work and self-checks are complete, call IssueReport with status="in_review"; if blocked, call IssueReport with status="blocked" and explain why.',
    '',
    'Issue:',
    JSON.stringify({
      key: `ISS-${issue.number}`,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      labels: issue.labels,
      acceptanceCriteria: issue.acceptanceCriteria,
    }, null, 2),
  ];
  if (context.currentPlanJson) parts.push('', 'Current plan.json:', context.currentPlanJson);
  if (context.currentProgress) parts.push('', 'Current PROGRESS.md:', context.currentProgress);
  return parts.join('\n');
}

/** Human-readable snapshot shown before an Update progress run (plan M3 diff preview). */
export function formatManagerUpdatePreview(plan: ProjectPlan, progress: string | null): string {
  const lines = [
    `plan.json — ${plan.milestones.length} milestones, ${plan.today.length} today, ${plan.upcoming.length} upcoming`,
    `PROGRESS.md — ${progress ? `${progress.length} chars` : '(none yet — will be created)'}`,
  ];
  if (plan.milestones.length) {
    lines.push('Milestones: ' + plan.milestones.map((m) => `${m.title}${m.status ? ` (${m.status})` : ''}`).slice(0, 6).join('; '));
  }
  if (progress?.trim()) {
    const head = progress.trim().slice(0, 500);
    lines.push('', 'PROGRESS preview:', head + (progress.length > 500 ? '…' : ''));
  }
  return lines.join('\n');
}

/** True when a scheduled/manual update should attach a GitHub PR digest. */
export function shouldIncludeGitHubDigest(instruction?: string): boolean {
  const key = (instruction ?? '').trim().toLowerCase();
  return key === 'github-pr-digest' || (key.includes('github') && key.includes('pr'));
}

/** Parse `owner/repo` from a git remote URL (https or git@github.com:). */
export function parseGitHubRepoFromRemote(remoteUrl: string): { owner: string; repo: string } | null {
  const s = remoteUrl.trim();
  const ssh = s.match(/git@github\.com:([^/]+)\/(.+?)(\.git)?$/i);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]!.replace(/\.git$/i, '') };
  try {
    const u = new URL(s.replace(/\.git$/i, ''));
    if (!u.hostname.endsWith('github.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return { owner: parts[0]!, repo: parts[1]! };
  } catch { /* not a URL */ }
  return null;
}

/**
 * Fetch a short open-PR digest via GitHub REST (read-only; no shell).
 * Returns null when `token` is missing or the request fails silently.
 */
export async function fetchGitHubPrDigest(
  token: string | undefined,
  owner: string,
  repo: string,
): Promise<string | null> {
  if (!token?.trim()) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=10`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token.trim()}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!res.ok) return `GitHub API error: HTTP ${res.status}`;
    const pulls = (await res.json()) as Array<{ number: number; title: string; user?: { login?: string } }>;
    if (!Array.isArray(pulls) || pulls.length === 0) return 'Open PRs: none';
    return [
      `Open PRs (${pulls.length} shown):`,
      ...pulls.map((p) => `#${p.number} ${p.title} (@${p.user?.login ?? '?'})`),
    ].join('\n');
  } catch (err: unknown) {
    return `GitHub digest failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Host helper: resolve a PR digest when the update instruction requests it. */
export async function resolveGitHubDigestForUpdate(
  workDir: string,
  instruction?: string,
): Promise<string | undefined> {
  if (!shouldIncludeGitHubDigest(instruction)) return undefined;
  const token = process.env.GITHUB_TOKEN;
  if (!token?.trim()) return undefined;
  let remote = '';
  try {
    const { execSync } = await import('node:child_process');
    remote = execSync('git remote get-url origin', { cwd: workDir, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
  const repo = parseGitHubRepoFromRemote(remote);
  if (!repo) return undefined;
  const digest = await fetchGitHubPrDigest(token, repo.owner, repo.repo);
  return digest ?? undefined;
}

/** Build the "Update progress" run prompt from host-collected context. */
export function buildUpdateProgressPrompt(context: ManagerUpdateContext): string {
  const parts: string[] = [
    'Update the project progress documents based on the context below.',
    '',
    '1. Update the structured plan with PlanWrite: reconcile milestones/today/upcoming with what actually happened.',
    '2. Update PROGRESS.md with ProgressWrite: refresh the status summary, note risks/blockers, and append a dated changelog entry for this update.',
    '3. Reconcile the issue board with IssueGet/IssueUpdate/IssueComment using linked-session evidence. Move in_review to done only when completion is supported; otherwise record what remains.',
    'Keep both faithful to the evidence; do not invent progress.',
  ];
  if (context.instruction?.trim()) {
    parts.push('', 'User instruction for this update:', context.instruction.trim());
  }
  if (context.currentPlanJson) {
    parts.push('', '--- Current plan.json ---', context.currentPlanJson);
  }
  if (context.currentIssuesJson) {
    parts.push('', '--- Current issues.json summary ---', context.currentIssuesJson);
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
  if (context.githubDigest?.trim()) {
    parts.push('', '--- GitHub PR digest (read-only, collected by the host) ---', context.githubDigest.trim());
  }
  return parts.join('\n');
}
