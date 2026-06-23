/**
 * ModelTeam — multi-model cooperation core.
 * Modes: Panel-Analysis (unified read-only expert panel + optional convergence),
 * Router, Discussion, Executor-Reviewer. (`panel` and `analysis` are retained as
 * aliases that route to the Panel-Analysis engine; the old pure-text panel
 * implementation has been retired.)
 * All modes follow the Hadamard Agent Harness principle: provide
 * scaffolding, not constraints. Models decide when to converge.
 */
import type {
  TeamDefinition,
  TeamMember,
  ReviewerResult,
  TeamCost,
  AnalysisResult,
  ExpertPanelReport,
  MemberStatus,
  ModelTeamResult,
  AgentToolDefinition,
  ModelApi,
  TeamAskOptions,
  TeamEvent,
} from '../types.js';
import { estimateCost, hasFullPricing } from './pricing.js';
import { resolveRuntimeConfig } from '../config/resolveRuntimeConfig.js';
import { createActoviqModelApi } from '../runtime/actoviqModelApi.js';
import { createOpenaiModelApi } from '../provider/openai-model-api.js';
import type { MessageParam } from '../provider/types.js';
import {
  buildMemberIdentities,
  buildReadOnlyExpertTools,
  mapWithConcurrency,
  memberSignal,
  resolveApiKey,
  runMemberAgent,
} from './teamRuntime.js';

// ═══════════════════════════════════════════════════════════════════
//  Per-member ModelApi instantiation
// ═══════════════════════════════════════════════════════════════════

interface MemberApi {
  api: ModelApi;
  model: string;
  maxTokens: number;
}

async function createMemberApi(member: TeamMember): Promise<MemberApi> {
  const resolved = await resolveRuntimeConfig({
    model: member.model,
    provider: member.provider,
    baseURL: member.baseURL,
    authToken: resolveApiKey(member.apiKey),
    maxTokens: member.maxTokens ?? 32000,
    workDir: process.cwd(),
  });

  const api = resolved.provider === 'openai'
    ? createOpenaiModelApi(resolved)
    : createActoviqModelApi(resolved);

  return { api, model: resolved.model, maxTokens: member.maxTokens ?? 32000 };
}

// ═══════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════

async function singleModelCall(
  memberApi: MemberApi,
  prompt: string,
  systemPrompt?: string,
  signal?: AbortSignal,
): Promise<{ content: string; inputTokens: number; outputTokens: number; durationMs: number }> {
  const startedAt = Date.now();
  const messages: MessageParam[] = [{ role: 'user', content: prompt }];

  const response = await memberApi.api.createMessage({
    model: memberApi.model,
    messages,
    max_tokens: memberApi.maxTokens,
    system: systemPrompt,
    signal,
  });


  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as any).text)
    .join('');

  return {
    content: text,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    durationMs: Date.now() - startedAt,
  };
}

function computeCost(
  models: string[],
  inputTokens: number,
  outputTokens: number,
  perModelTokens: Map<string, { input: number; output: number }>,
  homeDir?: string,
): TeamCost {
  const costWarning = !hasFullPricing(models, homeDir);
  let totalEstimatedCost: number | null = 0;
  const breakdown: Array<{ model: string; cost: number }> = [];

  for (const [model, tokens] of perModelTokens) {
    const cost = estimateCost(model, tokens.input, tokens.output, homeDir);
    if (cost !== null) {
      breakdown.push({ model, cost });
      totalEstimatedCost = (totalEstimatedCost ?? 0) + cost;
    } else {
      totalEstimatedCost = null; // null if any model lacks pricing
    }
  }

  return {
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    estimatedCost: totalEstimatedCost,
    breakdown,
    costWarning,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  Reviewer Mode — single read-only ReAct reviewer the main agent invokes
// ═══════════════════════════════════════════════════════════════════

/**
 * A single read-only ReAct agent (Read/Glob/Grep + TavilySearch/WebFetch) that
 * inspects the project and returns confirmed issues. The main agent (the
 * "executor") invokes it as a tool, decides what `context` to inject — what it
 * did and the results it obtained, placed in the reviewer's system prompt — and
 * keeps final authority over the findings. The reviewer is told to scrutinize
 * hard but confirm ONLY issues it can actually verify: no speculation, no
 * fabricated or padded findings.
 */
async function runReviewerMode(
  task: string,
  definition: TeamDefinition,
  signal?: AbortSignal,
  context?: string,
  workDir?: string,
  onEvent?: (event: TeamEvent) => void,
): Promise<ReviewerResult> {
  const startedAt = Date.now();
  const reviewer = definition.reviewer!;
  const cwd = workDir ?? process.cwd();
  const identity = buildMemberIdentities([reviewer])[0]!;

  const reviewerFraming = [
    'You are a meticulous reviewer on a multi-model team.',
    'Inspect the project using ONLY your read-only tools (Read/Glob/Grep) and the web',
    '(TavilySearch/WebFetch). You cannot modify files, write code, or run commands.',
    'Scrutinize as thoroughly as you can and surface every genuine problem — bugs, broken',
    'logic, security holes, missed edge cases, violated requirements — each with concrete',
    'file:line evidence. Critically: confirm ONLY issues you can actually verify from the',
    'code or files. Do not speculate, invent, or pad the list; if something is uncertain,',
    'say so explicitly instead of asserting it. If you find no real issues, say so plainly.',
  ].join(' ');

  const systemPrompt = [
    reviewerFraming,
    context ? `\n## Context from the requesting agent (what it did and obtained)\n${context}` : '',
    reviewer.systemPrompt ? `\n${reviewer.systemPrompt}` : '',
  ].filter(Boolean).join('\n');

  onEvent?.({ type: 'team.started', mode: 'reviewer', members: [{ id: identity.id, model: identity.model, role: identity.role }] });

  const run = await runMemberAgent({
    identity,
    member: reviewer,
    task,
    systemPrompt,
    cwd,
    tools: await buildReadOnlyExpertTools(cwd),
    maxIterations: definition.maxIterations ?? 16,
    timeoutMs: definition.timeoutMs,
    signal,
    round: 1,
    onEvent,
  });

  const perModelTokens = new Map<string, { input: number; output: number }>([
    [reviewer.model, { input: run.inputTokens, output: run.outputTokens }],
  ]);
  const cost = computeCost([reviewer.model], run.inputTokens, run.outputTokens, perModelTokens);
  const incompleteReason = run.status.ok ? undefined : `reviewer failed — ${run.status.error ?? 'unknown error'}`;
  onEvent?.({ type: 'team.completed', mode: 'reviewer', rounds: 1, incompleteReason });

  return {
    answer: run.report,
    mode: 'reviewer',
    report: run.report,
    toolCalls: run.status.toolCalls ?? 0,
    cost,
    durationMs: Date.now() - startedAt,
    memberStatuses: [run.status],
    incompleteReason,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  Panel-Analysis Mode — read-only ReAct expert panel + optional convergence
// ═══════════════════════════════════════════════════════════════════

/**
 * Unified expert panel. Each member is an independent, read-only ReAct agent
 * (Read/Glob/Grep + TavilySearch/WebFetch — no write/edit/bash/delegation) that
 * investigates the task in parallel and returns a findings report.
 *
 * - No `primary` → single-pass advisory: the caller (the main agent) decides
 *   what to do with the concatenated reports (the original `analysis` behavior).
 * - With a `primary` → multi-round convergence: after each round the primary
 *   synthesizes the findings and decides FINALIZE or CONTINUE; on CONTINUE the
 *   panel re-investigates a refined question with prior findings as context.
 *   Harness principle preserved: the primary decides convergence; `maxRounds`
 *   (default 100) is only a safety cap.
 *
 * `analysis` and `panel-analysis` both route here; the result `mode` echoes the
 * requested alias.
 */
async function runPanelAnalysisMode(
  prompt: string,
  definition: TeamDefinition,
  signal?: AbortSignal,
  workDir?: string,
  onEvent?: (event: TeamEvent) => void,
): Promise<AnalysisResult> {
  const startedAt = Date.now();
  const cwd = workDir ?? process.cwd();
  const readOnlyTools = await buildReadOnlyExpertTools(cwd);

  // Bounded ReAct depth per member so a panel can't run away (configurable).
  const memberMaxIterations = definition.maxIterations ?? 16;
  const identities = buildMemberIdentities(definition.members);
  const perModelTokens = new Map<string, { input: number; output: number }>();
  const memberStatuses: MemberStatus[] = [];
  let totalInput = 0;
  let totalOutput = 0;

  const analysisFraming = [
    'You are an analyst on a multi-model expert panel.',
    'Investigate the task using ONLY your read-only tools: read local files (Read/Glob/Grep)',
    'and research the web (TavilySearch/WebFetch). You cannot modify files, write code, or run',
    'commands — you only analyze and advise. Produce a focused findings report: key facts (with',
    'sources), risks, blind spots, concrete recommendations, and anything the main agent should',
    'verify. Be specific and decision-useful.',
  ].join(' ');

  const resultMode: 'analysis' | 'panel-analysis' =
    definition.mode === 'analysis' ? 'analysis' : 'panel-analysis';

  onEvent?.({
    type: 'team.started',
    mode: resultMode,
    members: identities.map((identity) => ({ id: identity.id, model: identity.model, role: identity.role })),
  });

  // One investigation round: every member investigates `question` in parallel as
  // a read-only ReAct agent via the centralized runner. `priorContext` (earlier
  // rounds' findings) lets members build on the deliberation instead of starting cold.
  const investigate = async (
    round: number,
    question: string,
    priorContext?: string,
  ): Promise<ExpertPanelReport[]> => {
    const memberPrompt = priorContext
      ? `${question}\n\n## Prior panel findings (build on these; don't repeat established points)\n${priorContext}`
      : question;
    return mapWithConcurrency(
      definition.members,
      definition.maxParallel ?? definition.members.length,
      async (member, index): Promise<ExpertPanelReport> => {
        const identity = identities[index]!;
        const run = await runMemberAgent({
          identity,
          member,
          task: memberPrompt,
          systemPrompt: member.systemPrompt
            ? `${analysisFraming}\n\n${member.systemPrompt}`
            : analysisFraming,
          cwd,
          tools: readOnlyTools,
          maxIterations: memberMaxIterations,
          timeoutMs: definition.timeoutMs,
          signal,
          round,
          onEvent,
        });
        const ex = perModelTokens.get(member.model) ?? { input: 0, output: 0 };
        ex.input += run.inputTokens;
        ex.output += run.outputTokens;
        perModelTokens.set(member.model, ex);
        totalInput += run.inputTokens;
        totalOutput += run.outputTokens;
        memberStatuses.push(run.status);
        return {
          id: identity.id,
          role: identity.role,
          model: identity.model,
          report: run.report,
          toolCalls: run.status.toolCalls ?? 0,
          durationMs: run.status.durationMs ?? 0,
          round,
        };
      },
    );
  };

  // With a primary, build the decision callback that synthesizes findings and
  // votes FINALIZE/CONTINUE each round; without one, the panel is single-pass.
  let decide: ((deliberationLog: string) => Promise<string>) | undefined;
  if (definition.primary) {
    const primaryApi = await createMemberApi(definition.primary);
    const primaryModel = definition.primary.model;
    const primarySystem = definition.primary.systemPrompt;
    decide = async (deliberationLog: string): Promise<string> => {
      const decisionPrompt = [
        'You are the primary synthesizer over a panel of expert analysts; each investigated the task with read-only tools and reported findings.',
        'Review the full panel findings, then decide whether they are sufficient to answer the task.',
        '',
        'Original task:',
        prompt,
        '',
        'Full panel findings so far:',
        deliberationLog,
        '',
        'Respond in one of these formats:',
        '',
        'To FINALIZE (findings are sufficient):',
        'FINALIZE',
        '<your comprehensive synthesized answer, grounded in the findings>',
        '',
        'To CONTINUE (deeper investigation needed):',
        'CONTINUE',
        '<a refined question and the specific aspects the panel should investigate next>',
      ].join('\n');
      const decision = await singleModelCall(primaryApi, decisionPrompt, primarySystem, memberSignal(signal, definition.timeoutMs));
      totalInput += decision.inputTokens;
      totalOutput += decision.outputTokens;
      const pex = perModelTokens.get(primaryModel) ?? { input: 0, output: 0 };
      pex.input += decision.inputTokens;
      pex.output += decision.outputTokens;
      perModelTokens.set(primaryModel, pex);
      return decision.content;
    };
  }

  const { answer, rounds, reports } = await orchestratePanel({
    prompt,
    maxRounds: definition.maxRounds ?? 100,
    investigate,
    decide,
    onEvent,
  });

  const failed = memberStatuses.filter((status) => !status.ok);
  const incompleteReason = failed.length > 0
    ? `${failed.length} of ${memberStatuses.length} member run(s) failed or were skipped`
    : undefined;
  onEvent?.({ type: 'team.completed', mode: resultMode, rounds, incompleteReason });

  const cost = computeCost([...perModelTokens.keys()], totalInput, totalOutput, perModelTokens);
  return {
    answer,
    mode: resultMode,
    reports,
    rounds,
    cost,
    durationMs: Date.now() - startedAt,
    memberStatuses,
    incompleteReason,
  };
}

/**
 * Orchestrate the panel over an injectable `investigate` (one round of member
 * reports) and optional `decide` (the primary's synthesize-or-continue call).
 *
 * - No `decide` → single-pass advisory: round 1 only; answer = labeled reports.
 * - With `decide` → multi-round convergence: after each round the primary votes
 *   FINALIZE (synthesize) or CONTINUE (refined question); loops until FINALIZE
 *   or `maxRounds` (safety cap). The keyword match is case-insensitive, and any
 *   decision that is not a leading CONTINUE finalizes (graceful default).
 *
 * Exported so the convergence logic is unit-testable without real model calls.
 */
export async function orchestratePanel(opts: {
  prompt: string;
  maxRounds: number;
  investigate: (round: number, question: string, priorContext?: string) => Promise<ExpertPanelReport[]>;
  decide?: (deliberationLog: string, round: number) => Promise<string>;
  onEvent?: (event: TeamEvent) => void;
}): Promise<{ answer: string; rounds: number; reports: ExpertPanelReport[] }> {
  // Label by stable identity (falls back to model) so members sharing a model
  // are still distinguishable in the synthesized output.
  const label = (rs: ExpertPanelReport[]): string =>
    rs.map((r) => `### ${r.id ?? r.model}\n${r.report}`).join('\n\n---\n\n');

  const allReports: ExpertPanelReport[] = [];
  let rounds = 1;
  let currentReports = await opts.investigate(1, opts.prompt);
  allReports.push(...currentReports);
  opts.onEvent?.({ type: 'team.round.completed', round: 1, reports: currentReports.length });

  // No primary → single-pass advisory (original `analysis` behavior).
  if (!opts.decide) {
    return { answer: label(currentReports), rounds, reports: allReports };
  }

  const deliberationLog: string[] = [`## Round 1 — Panel findings\n${label(currentReports)}`];
  while (true) {
    const content = await opts.decide(deliberationLog.join('\n\n---\n\n'), rounds);
    const wantsContinue = content.trim().toUpperCase().startsWith('CONTINUE');
    if (wantsContinue && rounds < opts.maxRounds) {
      opts.onEvent?.({ type: 'team.synthesis', round: rounds, decision: 'continue' });
      const refined = content.replace(/^CONTINUE\s*/i, '').trim() || opts.prompt;
      deliberationLog.push(`## Round ${rounds} — Primary decision\nCONTINUE: ${refined}`);
      rounds++;
      currentReports = await opts.investigate(rounds, refined, label(currentReports));
      allReports.push(...currentReports);
      opts.onEvent?.({ type: 'team.round.completed', round: rounds, reports: currentReports.length });
      deliberationLog.push(`## Round ${rounds} — Panel findings\n${label(currentReports)}`);
    } else {
      // FINALIZE, or the safety cap was reached mid-deliberation.
      opts.onEvent?.({ type: 'team.synthesis', round: rounds, decision: 'finalize' });
      const answer = wantsContinue
        ? label(currentReports) // cap hit: hand back the findings unsynthesized
        : content.replace(/^FINALIZE\s*/i, '').trim() || label(currentReports);
      return { answer, rounds, reports: allReports };
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  ModelTeam class
// ═══════════════════════════════════════════════════════════════════

export class ModelTeam {
  readonly name: string;
  readonly definition: TeamDefinition;

  constructor(definition: TeamDefinition) {
    this.name = definition.name;
    this.definition = definition;
  }

  /**
   * Ask the team. `opts.context` is injected into the reviewer's system prompt
   * (reviewer mode only — what the main agent did and obtained). Returns the
   * mode-specific result.
   */
  async ask(prompt: string, signal?: AbortSignal, opts?: TeamAskOptions): Promise<ModelTeamResult> {
    switch (this.definition.mode) {
      case 'reviewer':
      case 'executor-reviewer': // alias: the retired executor loop now runs the single reviewer
        return runReviewerMode(prompt, this.definition, signal, opts?.context, opts?.workDir, opts?.onEvent);
      case 'panel': // alias: retired pure-text panel now runs the unified engine
      case 'analysis':
      case 'panel-analysis':
        return runPanelAnalysisMode(prompt, this.definition, signal, opts?.workDir, opts?.onEvent);
      default:
        throw new Error(`Unknown team mode: ${(this.definition as any).mode}`);
    }
  }
}

/**
 * Create a ModelTeam from a definition or from disk.
 */
export function createModelTeam(
  definition: TeamDefinition,
): ModelTeam {
  // Validate
  validateTeamDefinition(definition);
  return new ModelTeam(definition);
}

function validateTeamDefinition(def: TeamDefinition): void {
  if (!def.name) throw new Error('Team definition must have a name.');
  if (!def.mode) throw new Error('Team definition must specify a mode.');

  switch (def.mode) {
    case 'reviewer':
    case 'executor-reviewer': // retired alias: needs only a reviewer now
      if (!def.reviewer) throw new Error('Reviewer mode requires a reviewer member.');
      break;
    case 'panel': // retired alias of panel-analysis (primary now optional)
    case 'analysis':
    case 'panel-analysis':
      if (!def.members || def.members.length === 0) throw new Error('Panel-analysis mode requires at least one panel member.');
      if (def.members.length > 8) throw new Error('Panel-analysis mode supports at most 8 members.');
      break;
  }
}

/**
 * Create a team tool that agents can invoke.
 * Returns an AgentToolDefinition with interruptBehavior: 'block'.
 */
export function createTeamTool(
  definition: TeamDefinition,
): AgentToolDefinition {
  const team = createModelTeam(definition);
  const isReviewer = definition.mode === 'reviewer' || definition.mode === 'executor-reviewer';
  const isPanel = definition.mode === 'analysis' || definition.mode === 'panel-analysis';

  return {
    kind: 'local',
    name: definition.name,
    description:
      definition.description ??
      (isReviewer
        ? 'Reviewer: a single read-only agent inspects the project and reports only genuine, verifiable issues. Pass { task } (what to check) and optional { context } (what you did + the results). It advises; you decide.'
        : isPanel
          ? 'Expert panel: independent read-only multi-model analysis (advisory; optional primary-driven convergence). You decide what to do with the findings.'
          : `Multi-model team (${definition.mode} mode)`),
    inputSchema: {
      parse: (input: unknown) => input as { prompt: string },
      _type: undefined,
    } as any,
    inputJsonSchema: isReviewer
      ? {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'What the reviewer should scrutinize' },
            context: { type: 'string', description: 'What you did and the results you obtained (injected into the reviewer system prompt)' },
          },
          required: ['task'],
          additionalProperties: true,
        }
      : {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The question or task for the team' },
          },
          required: ['prompt'],
          // Tolerate extra fields the model may add — a strict schema here caused
          // intermittent "schema error" rejections that silently skipped the panel.
          additionalProperties: true,
        },
    async execute(input: unknown) {
      // Accept the call however the model phrases it (bare string or any of a few
      // common keys) so a formatting quirk never drops the invocation.
      const obj = (input ?? {}) as Record<string, unknown>;
      if (isReviewer) {
        const taskCandidate = typeof input === 'string' ? input : obj.task ?? obj.prompt ?? obj.question ?? obj.input;
        const task = typeof taskCandidate === 'string' ? taskCandidate.trim() : '';
        if (!task) {
          throw new Error(`Reviewer "${definition.name}" requires a non-empty "task" string.`);
        }
        const context = typeof obj.context === 'string' ? obj.context : undefined;
        const result = await team.ask(task, undefined, { context });
        return JSON.stringify({
          answer: result.answer,
          mode: result.mode,
          cost: result.cost,
          memberStatuses: result.memberStatuses,
          incompleteReason: result.incompleteReason,
        });
      }
      const candidate =
        typeof input === 'string'
          ? input
          : obj.prompt ?? obj.query ?? obj.question ?? obj.task ?? obj.input;
      const prompt = typeof candidate === 'string' ? candidate.trim() : '';
      if (!prompt) {
        throw new Error(`Team "${definition.name}" requires a non-empty "prompt" string.`);
      }
      const result = await team.ask(prompt);
      return JSON.stringify({
        answer: result.answer,
        mode: result.mode,
        cost: result.cost,
        memberStatuses: result.memberStatuses,
        incompleteReason: result.incompleteReason,
      });
    },
    interruptBehavior: 'block',
    isConcurrencySafe: () => false,
    prompt: async () => [
      `## ${definition.name} (Model Team: ${definition.mode})`,
      definition.description ?? '',
      '',
      isReviewer
        ? 'Call this tool with { task } (what to scrutinize) and optional { context } (what you did and the results you got). A single read-only agent inspects the code/web and reports only issues it can verify — no speculation. You keep final authority; re-invoke after changes to re-check.'
        : isPanel
          ? 'Call this tool with a { prompt } to have an expert panel of independent read-only agents investigate (read local code + search the web) and each return a findings report. They only analyze and advise — you keep full control and decide what to do with their input. With a configured primary the panel also converges over multiple rounds into a synthesized answer. Use it to assist analysis on large or complex tasks.'
          : 'Call this tool with a { prompt } to get a multi-model synthesized answer.',
      isReviewer
        ? `Reviewer: ${definition.reviewer?.model ?? 'configured via definition'}`
        : `Members: ${definition.members?.map((m) => m.model).join(', ') ?? 'configured via definition'}`,
    ].join('\n'),
  };
}
