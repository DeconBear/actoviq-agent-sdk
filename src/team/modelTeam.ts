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
  TeamResult,
  RouterResult,
  DiscussionResult,
  ExecutorReviewerResult,
  TeamCost,
  ExecutorReviewerDecision,
  AnalysisResult,
  ExpertPanelReport,
  ModelTeamResult,
  AgentToolDefinition,
  AgentPoolSlot,
  ModelApi,
} from '../types.js';
import { getGlobalAgentPool } from './agentPool.js';
import { estimateCost, hasFullPricing } from './pricing.js';
import { createId } from '../runtime/helpers.js';
import { resolveRuntimeConfig } from '../config/resolveRuntimeConfig.js';
import { ActoviqModelApi, createActoviqModelApi } from '../runtime/actoviqModelApi.js';
import { OpenaiModelApi, createOpenaiModelApi } from '../provider/openai-model-api.js';
import type { MessageParam, ToolResultBlockParam } from '../provider/types.js';

// ═══════════════════════════════════════════════════════════════════
//  Per-member ModelApi instantiation
// ═══════════════════════════════════════════════════════════════════

function resolveApiKey(apiKey?: string): string | undefined {
  if (!apiKey) return undefined;
  if (apiKey.startsWith('$')) {
    const varName = apiKey.slice(1);
    return process.env[varName];
  }
  return apiKey;
}

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
//  Concurrency + timeout helpers
// ═══════════════════════════════════════════════════════════════════

/** Combine the caller's abort signal with a per-call timeout (if set). */
function memberSignal(signal: AbortSignal | undefined, timeoutMs?: number): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return signal;
  const signals = [signal, AbortSignal.timeout(timeoutMs)].filter((s): s is AbortSignal => s != null);
  return AbortSignal.any(signals);
}

/** Run fn over items with at most `limit` in flight; preserves input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// ═══════════════════════════════════════════════════════════════════
//  Router Mode — user-configured dispatch
// ═══════════════════════════════════════════════════════════════════

async function runRouterMode(
  prompt: string,
  definition: TeamDefinition,
  signal?: AbortSignal,
): Promise<RouterResult> {
  const startedAt = Date.now();
  const routerApi: MemberApi = await createMemberApi(definition.router!);
  const specialistApis = new Map<string, MemberApi>();
  for (const [key, spec] of Object.entries(definition.specialists ?? {})) {
    specialistApis.set(key, await createMemberApi(spec));
  }
  const fallbackApi: MemberApi | null = definition.fallback ? await createMemberApi(definition.fallback) : null;

  // Build classification prompt
  const specialistDescriptions = Object.entries(definition.specialists ?? {})
    .map(([key, spec]) => `- ${key}: ${spec.description ?? 'General tasks'}`)
    .join('\n');

  const classificationPrompt = definition.classificationPrompt ?? [
    'You are a task classifier. Based on the user\'s request, determine which specialist should handle it.',
    '',
    'Available specialists:',
    specialistDescriptions,
    definition.fallback ? `- fallback: ${definition.fallback.description ?? 'General assistance'}` : null,
    '',
    'User request:',
    prompt,
    '',
    'Return ONLY the specialist name (one word, lowercase).',
  ].filter(Boolean).join('\n');

  const classifyResult = await singleModelCall(routerApi, classificationPrompt, definition.router?.systemPrompt, memberSignal(signal, definition.timeoutMs));

  const specialistKey = classifyResult.content.trim().toLowerCase();
  const validKeys = Object.keys(definition.specialists ?? {});

  let chosenApi: MemberApi;
  let chosenKey: string;
  let chosenMember: TeamMember;

  if (validKeys.includes(specialistKey)) {
    chosenApi = specialistApis.get(specialistKey)!;
    chosenKey = specialistKey;
    chosenMember = definition.specialists![specialistKey]!;
  } else if (fallbackApi) {
    chosenApi = fallbackApi;
    chosenKey = 'fallback';
    chosenMember = definition.fallback!;
  } else {
    // No fallback, pick first specialist
    chosenKey = validKeys[0] ?? 'default';
    chosenApi = specialistApis.get(chosenKey)!;
    chosenMember = definition.specialists![chosenKey]!;
  }

  const result = await singleModelCall(chosenApi, prompt, chosenMember.systemPrompt, memberSignal(signal, definition.timeoutMs));

  const modelSet = new Set<string>();
  modelSet.add(definition.router!.model);
  modelSet.add(chosenMember.model);

  const perModelTokens = new Map<string, { input: number; output: number }>();
  perModelTokens.set(definition.router!.model, { input: classifyResult.inputTokens, output: classifyResult.outputTokens });
  perModelTokens.set(chosenMember.model, { input: result.inputTokens, output: result.outputTokens });

  const cost = computeCost(
    [...modelSet],
    classifyResult.inputTokens + result.inputTokens,
    classifyResult.outputTokens + result.outputTokens,
    perModelTokens,
  );

  return {
    answer: result.content,
    mode: 'router',
    specialist: chosenKey,
    classification: classifyResult.content,
    cost,
    durationMs: Date.now() - startedAt,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  Discussion Mode — roundtable for hard problems
// ═══════════════════════════════════════════════════════════════════

async function runDiscussionMode(
  prompt: string,
  definition: TeamDefinition,
  signal?: AbortSignal,
): Promise<DiscussionResult> {
  const startedAt = Date.now();
  const primaryApi: MemberApi = await createMemberApi(definition.primary!);
  const memberApis: MemberApi[] = await Promise.all(definition.members.map((m) => createMemberApi(m)));
  const facilitatorApi = definition.facilitator
    ? await createMemberApi(definition.facilitator)
    : primaryApi; // fallback: primary acts as facilitator

  let rounds = 0;
  let converged = false;
  let finalAnswer = '';
  const facilitatorVerdicts: DiscussionResult['facilitatorVerdicts'] = [];
  const modelSet = new Set<string>();
  definition.members.forEach((m) => modelSet.add(m.model));
  modelSet.add(definition.primary!.model);
  if (definition.facilitator) modelSet.add(definition.facilitator.model);

  const perModelTokens = new Map<string, { input: number; output: number }>();
  let totalInput = 0;
  let totalOutput = 0;

  let discussionTranscript = `# Discussion Topic\n${prompt}\n\n`;
  const maxRounds = definition.maxRounds ?? 100;

  while (!converged && rounds < maxRounds) {
    rounds++;

    // Sequential speaking: each member sees prior speakers
    for (let i = 0; i < definition.members.length; i++) {
      const member = definition.members[i]!;
      const speakPrompt = [
        `## Discussion Round ${rounds}`,
        '',
        `Topic: ${prompt}`,
        '',
        'Previous discussion:',
        discussionTranscript,
        '',
        `You are ${member.model}. Please contribute your perspective. ` +
        'Consider what previous speakers have said. Build on agreements, address disagreements.',
      ].join('\n');

      const result = await singleModelCall(memberApis[i]!, speakPrompt, member.systemPrompt, memberSignal(signal, definition.timeoutMs));

      discussionTranscript += `\n### ${member.model} (Round ${rounds})\n${result.content}\n`;

      const ex = perModelTokens.get(member.model) ?? { input: 0, output: 0 };
      ex.input += result.inputTokens;
      ex.output += result.outputTokens;
      perModelTokens.set(member.model, ex);
      totalInput += result.inputTokens;
      totalOutput += result.outputTokens;
    }

    // Facilitator subagent rules after the round
    const facilitatorPrompt = [
      'You are a discussion facilitator. Review the roundtable transcript and provide:',
      '',
      '1. **Summary**: Key points raised, areas of agreement and disagreement',
      '2. **Progress Assessment**: Is the discussion converging? Are there blockers?',
      '3. **Verdict**: Should discussion CONTINUE or FINALIZE?',
      '',
      'Respond in this format:',
      '',
      'SUMMARY:',
      '<summary>',
      '',
      'VERDICT: CONTINUE|FINALIZE',
      '',
      'If CONTINUE, add:',
      'NEXT_TOPIC: <what the next round should focus on>',
      '',
      'Discussion transcript:',
      discussionTranscript,
    ].join('\n');

    const facilitatorResult = await singleModelCall(facilitatorApi, facilitatorPrompt, definition.facilitator?.systemPrompt, memberSignal(signal, definition.timeoutMs));

    if (definition.facilitator) {
      const fex = perModelTokens.get(definition.facilitator.model) ?? { input: 0, output: 0 };
      fex.input += facilitatorResult.inputTokens;
      fex.output += facilitatorResult.outputTokens;
      perModelTokens.set(definition.facilitator.model, fex);
    }
    totalInput += facilitatorResult.inputTokens;
    totalOutput += facilitatorResult.outputTokens;

    const summaryMatch = facilitatorResult.content.match(/SUMMARY:\s*\n([\s\S]*?)(?=\nVERDICT:|$)/i);
    const verdictMatch = facilitatorResult.content.match(/VERDICT:\s*(CONTINUE|FINALIZE)/i);
    const nextTopicMatch = facilitatorResult.content.match(/NEXT_TOPIC:\s*(.+)/i);

    const verdict = verdictMatch?.[1]?.toUpperCase() === 'FINALIZE' ? 'finalize' as const : 'continue' as const;

    facilitatorVerdicts.push({
      round: rounds,
      summary: summaryMatch?.[1]?.trim() ?? facilitatorResult.content,
      verdict,
    });

    // Primary model makes final decision
    const primaryDecisionPrompt = [
      'As the primary decision-maker, review the facilitator\'s report and the full discussion.',
      '',
      'Facilitator recommendation:',
      facilitatorResult.content,
      '',
      'Full discussion transcript:',
      discussionTranscript,
      '',
      'You may override the facilitator\'s recommendation. Decide:',
      '- FINALIZE: synthesize the solution and deliver it',
      '- CONTINUE: specify what the next round should address',
      '',
      'Respond with FINALIZE or CONTINUE followed by your reasoning/output.',
    ].join('\n');

    const primaryResult = await singleModelCall(primaryApi, primaryDecisionPrompt, definition.primary?.systemPrompt, memberSignal(signal, definition.timeoutMs));

    const pex = perModelTokens.get(definition.primary!.model) ?? { input: 0, output: 0 };
    pex.input += primaryResult.inputTokens;
    pex.output += primaryResult.outputTokens;
    perModelTokens.set(definition.primary!.model, pex);
    totalInput += primaryResult.inputTokens;
    totalOutput += primaryResult.outputTokens;

    if (primaryResult.content.trim().startsWith('FINALIZE')) {
      finalAnswer = primaryResult.content.replace(/^FINALIZE\s*/i, '').trim();
      converged = true;
    } else {
      const nextTopic = nextTopicMatch?.[1] ?? primaryResult.content.replace(/^CONTINUE\s*/i, '').trim();
      discussionTranscript += `\n### Facilitator (Round ${rounds})\nVerdict: CONTINUE\nNext topic: ${nextTopic}\n`;
    }
  }

  if (!converged) {
    finalAnswer = discussionTranscript;
  }

  const cost = computeCost([...modelSet], totalInput, totalOutput, perModelTokens);

  return {
    answer: finalAnswer,
    mode: 'discussion',
    rounds,
    facilitatorVerdicts,
    cost,
    durationMs: Date.now() - startedAt,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  Executor-Reviewer Mode — advisory critique loop
// ═══════════════════════════════════════════════════════════════════

async function runExecutorReviewerMode(
  prompt: string,
  definition: TeamDefinition,
  signal?: AbortSignal,
): Promise<ExecutorReviewerResult> {
  const startedAt = Date.now();
  const executorApi = await createMemberApi(definition.executor!);
  const reviewerApi = await createMemberApi(definition.reviewer!);

  const decisions: ExecutorReviewerDecision[] = [];
  const reviews: Array<{ iteration: number; feedback: string }> = [];
  const modelSet = new Set([definition.executor!.model, definition.reviewer!.model]);
  const perModelTokens = new Map<string, { input: number; output: number }>();
  let totalInput = 0;
  let totalOutput = 0;
  let iterations = 0;
  let converged = false;
  let finalAnswer = '';
  let currentOutput = '';
  const maxIterations = definition.maxIterations ?? 100;
  // Full history visible to both roles each iteration (plan: prevents the
  // reviewer from repeating already-addressed or rejected suggestions).
  const transcript: string[] = [];

  // Iteration 1: Executor produces initial output
  iterations++;
  const execResult = await singleModelCall(executorApi, prompt, definition.executor?.systemPrompt, memberSignal(signal, definition.timeoutMs));
  currentOutput = execResult.content;
  transcript.push(`## Iteration 1 — Executor output\n${currentOutput}`);
  perModelTokens.set(definition.executor!.model, { input: execResult.inputTokens, output: execResult.outputTokens });
  totalInput += execResult.inputTokens;
  totalOutput += execResult.outputTokens;

  while (!converged && iterations < maxIterations) {
    // Reviewer critiques
    const reviewPrompt = [
      'You are an experienced reviewer providing constructive feedback.',
      'The history below shows prior outputs, your earlier reviews, and the executor\'s decisions (including which suggestions were rejected and why). Do NOT repeat suggestions already addressed or explicitly rejected — focus on new, unaddressed improvements.',
      '',
      'Original request:',
      prompt,
      '',
      'History so far:',
      transcript.join('\n\n---\n\n'),
      '',
      'Latest output to review:',
      currentOutput,
      '',
      'Provide specific, actionable feedback. You are an advisor — the executor makes final decisions.',
    ].join('\n');

    const reviewResult = await singleModelCall(reviewerApi, reviewPrompt, definition.reviewer?.systemPrompt, memberSignal(signal, definition.timeoutMs));
    reviews.push({ iteration: iterations, feedback: reviewResult.content });
    transcript.push(`## Iteration ${iterations} — Reviewer feedback\n${reviewResult.content}`);

    const rex = perModelTokens.get(definition.reviewer!.model) ?? { input: 0, output: 0 };
    rex.input += reviewResult.inputTokens;
    rex.output += reviewResult.outputTokens;
    perModelTokens.set(definition.reviewer!.model, rex);
    totalInput += reviewResult.inputTokens;
    totalOutput += reviewResult.outputTokens;

    // Executor decides: accept/reject/partial/finalize
    const decisionPrompt = [
      'You are the executor with final authority. Review the feedback and decide.',
      '',
      'Original request:',
      prompt,
      '',
      'History so far (prior outputs, reviews, and your past decisions):',
      transcript.join('\n\n---\n\n'),
      '',
      'Your current output:',
      currentOutput,
      '',
      'Latest reviewer feedback:',
      reviewResult.content,
      '',
      'Decide (respond with exactly one action keyword followed by explanation/output):',
      '- ACCEPT: incorporate the feedback and provide revised output',
      '- REJECT: explain why the suggestion is not accepted',
      '- PARTIAL: accept some suggestions, reject others, provide revised output',
      '- FINALIZE: the work is done, deliver final output',
      '',
      'Format: ACTION_KEYWORD',
      '<explanation or revised output>',
    ].join('\n');

    const decisionResult = await singleModelCall(executorApi, decisionPrompt, definition.executor?.systemPrompt, memberSignal(signal, definition.timeoutMs));

    const dex = perModelTokens.get(definition.executor!.model) ?? { input: 0, output: 0 };
    dex.input += decisionResult.inputTokens;
    dex.output += decisionResult.outputTokens;
    perModelTokens.set(definition.executor!.model, dex);
    totalInput += decisionResult.inputTokens;
    totalOutput += decisionResult.outputTokens;

    // Parse decision
    const lines = decisionResult.content.trim().split('\n');
    const actionLine = lines[0]?.trim().toUpperCase() ?? '';
    const explanation = lines.slice(1).join('\n').trim();

    let action: ExecutorReviewerDecision['action'];
    if (actionLine.startsWith('FINALIZE')) {
      action = 'finalize';
      finalAnswer = explanation || currentOutput;
      converged = true;
    } else if (actionLine.startsWith('ACCEPT')) {
      action = 'accept';
      currentOutput = explanation || decisionResult.content;
    } else if (actionLine.startsWith('REJECT')) {
      action = 'reject';
      // Keep current output, note rejection
    } else if (actionLine.startsWith('PARTIAL')) {
      action = 'partial';
      currentOutput = explanation || decisionResult.content;
    } else {
      // Default: treat as finalize
      action = 'finalize';
      finalAnswer = decisionResult.content;
      converged = true;
    }

    decisions.push({
      iteration: iterations,
      action,
      explanation: explanation || decisionResult.content,
    });
    transcript.push(`## Iteration ${iterations} — Executor decision (${action})\n${explanation || decisionResult.content}`);

    iterations++;
  }

  if (!converged) {
    finalAnswer = currentOutput;
  }

  const cost = computeCost([...modelSet], totalInput, totalOutput, perModelTokens);

  return {
    answer: finalAnswer,
    mode: 'executor-reviewer',
    iterations,
    decisions,
    reviews,
    cost,
    durationMs: Date.now() - startedAt,
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
): Promise<AnalysisResult> {
  const startedAt = Date.now();
  // Lazy imports avoid a circular dependency (agentClient imports modelTeam).
  const { createAgentSdk } = await import('../runtime/agentClient.js');
  const { createActoviqFileTools } = await import('../tools/actoviqFileTools.js');
  const { createActoviqWebTools } = await import('../tools/actoviqWebTools.js');
  const { createTavilySearchTool } = await import('../tools/tavilySearch.js');

  const cwd = process.cwd();
  const READ_ONLY_FILE_TOOLS = new Set(['Read', 'Glob', 'Grep']);
  const buildReadOnlyTools = (): AgentToolDefinition[] => [
    ...createActoviqFileTools({ cwd }).filter((t) => READ_ONLY_FILE_TOOLS.has(t.name)),
    ...createActoviqWebTools().filter((t) => t.name === 'WebFetch'),
    createTavilySearchTool(),
  ];

  // Bounded ReAct depth per member so a panel can't run away (configurable).
  const memberMaxIterations = definition.maxIterations ?? 16;
  const pool = getGlobalAgentPool();
  const perModelTokens = new Map<string, { input: number; output: number }>();
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

  // One investigation round: every member investigates `question` in parallel as
  // a read-only ReAct agent. `priorContext` (earlier rounds' findings) lets
  // members build on the deliberation instead of starting cold.
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
      async (member): Promise<ExpertPanelReport> => {
        const start = Date.now();
        let slot: AgentPoolSlot | undefined;
        let sdk: Awaited<ReturnType<typeof createAgentSdk>> | undefined;
        try {
          slot = await pool.acquire();
          sdk = await createAgentSdk({
            model: member.model,
            provider: member.provider,
            baseURL: member.baseURL,
            authToken: resolveApiKey(member.apiKey),
            maxTokens: member.maxTokens ?? 32000,
            workDir: cwd,
            tools: buildReadOnlyTools(),
            permissionMode: 'bypassPermissions',
            maxToolIterations: memberMaxIterations,
            systemPrompt: member.systemPrompt
              ? `${analysisFraming}\n\n${member.systemPrompt}`
              : analysisFraming,
          });
          const result = await sdk.run(memberPrompt, {
            signal: memberSignal(signal, definition.timeoutMs),
          });
          const input = result.requests.reduce((s, r) => s + (r.usage?.input_tokens ?? 0), 0);
          const output = result.requests.reduce((s, r) => s + (r.usage?.output_tokens ?? 0), 0);
          const ex = perModelTokens.get(member.model) ?? { input: 0, output: 0 };
          ex.input += input;
          ex.output += output;
          perModelTokens.set(member.model, ex);
          totalInput += input;
          totalOutput += output;
          return {
            model: member.model,
            report: result.text,
            toolCalls: result.toolCalls.length,
            durationMs: Date.now() - start,
            round,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            model: member.model,
            report: `[ERROR: ${member.model} analysis failed — ${message}]`,
            toolCalls: 0,
            durationMs: Date.now() - start,
            round,
          };
        } finally {
          if (sdk) await sdk.close();
          slot?.release();
        }
      },
    );
  };

  const resultMode: 'analysis' | 'panel-analysis' =
    definition.mode === 'analysis' ? 'analysis' : 'panel-analysis';

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
  });

  const cost = computeCost([...perModelTokens.keys()], totalInput, totalOutput, perModelTokens);
  return {
    answer,
    mode: resultMode,
    reports,
    rounds,
    cost,
    durationMs: Date.now() - startedAt,
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
}): Promise<{ answer: string; rounds: number; reports: ExpertPanelReport[] }> {
  const label = (rs: ExpertPanelReport[]): string =>
    rs.map((r) => `### ${r.model}\n${r.report}`).join('\n\n---\n\n');

  const allReports: ExpertPanelReport[] = [];
  let rounds = 1;
  let currentReports = await opts.investigate(1, opts.prompt);
  allReports.push(...currentReports);

  // No primary → single-pass advisory (original `analysis` behavior).
  if (!opts.decide) {
    return { answer: label(currentReports), rounds, reports: allReports };
  }

  const deliberationLog: string[] = [`## Round 1 — Panel findings\n${label(currentReports)}`];
  while (true) {
    const content = await opts.decide(deliberationLog.join('\n\n---\n\n'), rounds);
    const wantsContinue = content.trim().toUpperCase().startsWith('CONTINUE');
    if (wantsContinue && rounds < opts.maxRounds) {
      const refined = content.replace(/^CONTINUE\s*/i, '').trim() || opts.prompt;
      deliberationLog.push(`## Round ${rounds} — Primary decision\nCONTINUE: ${refined}`);
      rounds++;
      currentReports = await opts.investigate(rounds, refined, label(currentReports));
      allReports.push(...currentReports);
      deliberationLog.push(`## Round ${rounds} — Panel findings\n${label(currentReports)}`);
    } else {
      // FINALIZE, or the safety cap was reached mid-deliberation.
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
   * Ask the team a question. Returns the synthesized answer.
   * Panel/Discussion: primary model decides when to converge.
   * Router: classifies and dispatches.
   * Executor-Reviewer: executor decides when done.
   */
  async ask(prompt: string, signal?: AbortSignal): Promise<ModelTeamResult> {
    switch (this.definition.mode) {
      case 'router':
        return runRouterMode(prompt, this.definition, signal);
      case 'discussion':
        return runDiscussionMode(prompt, this.definition, signal);
      case 'executor-reviewer':
        return runExecutorReviewerMode(prompt, this.definition, signal);
      case 'panel': // alias: retired pure-text panel now runs the unified engine
      case 'analysis':
      case 'panel-analysis':
        return runPanelAnalysisMode(prompt, this.definition, signal);
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
    case 'router':
      if (!def.router) throw new Error('Router mode requires a router member.');
      if (!def.specialists || Object.keys(def.specialists).length === 0) throw new Error('Router mode requires at least one specialist.');
      break;
    case 'discussion':
      if (!def.primary) throw new Error('Discussion mode requires a primary member.');
      if (!def.members || def.members.length < 2) throw new Error('Discussion mode requires at least 2 members.');
      break;
    case 'executor-reviewer':
      if (!def.executor) throw new Error('Executor-Reviewer mode requires an executor.');
      if (!def.reviewer) throw new Error('Executor-Reviewer mode requires a reviewer.');
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

  return {
    kind: 'local',
    name: definition.name,
    description:
      definition.description ??
      (definition.mode === 'analysis' || definition.mode === 'panel-analysis'
        ? 'Expert panel: independent read-only multi-model analysis (advisory; optional primary-driven convergence). You decide what to do with the findings.'
        : `Multi-model team (${definition.mode} mode)`),
    inputSchema: {
      parse: (input: unknown) => input as { prompt: string },
      _type: undefined,
    } as any,
    inputJsonSchema: {
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
      // Accept the prompt however the model phrases the call (bare string or any
      // of a few common keys) so a formatting quirk never drops the panel.
      const obj = (input ?? {}) as Record<string, unknown>;
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
      });
    },
    interruptBehavior: 'block',
    isConcurrencySafe: () => false,
    prompt: async () => [
      `## ${definition.name} (Model Team: ${definition.mode})`,
      definition.description ?? '',
      '',
      definition.mode === 'analysis' || definition.mode === 'panel-analysis'
        ? 'Call this tool with a { prompt } to have an expert panel of independent read-only agents investigate (read local code + search the web) and each return a findings report. They only analyze and advise — you keep full control and decide what to do with their input. With a configured primary the panel also converges over multiple rounds into a synthesized answer. Use it to assist analysis on large or complex tasks.'
        : 'Call this tool with a { prompt } to get a multi-model synthesized answer.',
      `Members: ${definition.members?.map((m) => m.model).join(', ') ?? 'configured via definition'}`,
    ].join('\n'),
  };
}
