/**
 * ModelTeam — multi-model cooperation core.
 * Supports Panel, Router, Discussion, and Executor-Reviewer modes.
 * All modes follow the Hadamard Agent Harness principle: provide
 * scaffolding, not constraints. Models decide when to converge.
 */
import type {
  TeamDefinition,
  TeamMember,
  TeamResult,
  PanelResult,
  RouterResult,
  DiscussionResult,
  ExecutorReviewerResult,
  TeamPanelResponse,
  TeamCost,
  ExecutorReviewerDecision,
  ModelTeamResult,
  AgentToolDefinition,
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

async function createMemberApi(member: TeamMember, homeDir?: string): Promise<MemberApi> {
  const resolved = await resolveRuntimeConfig({
    model: member.model,
    provider: member.provider,
    baseURL: member.baseURL,
    authToken: resolveApiKey(member.apiKey),
    maxTokens: member.maxTokens ?? 32000,
    homeDir,
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
//  Panel Mode — multi-round autonomous deliberation
// ═══════════════════════════════════════════════════════════════════

async function runPanelMode(
  prompt: string,
  definition: TeamDefinition,
  signal?: AbortSignal,
): Promise<PanelResult> {
  const startedAt = Date.now();
  const primaryApi: MemberApi = await createMemberApi(definition.primary!, definition.members[0]?.baseURL);
  const memberApis: MemberApi[] = await Promise.all(definition.members.map((m) => createMemberApi(m)));

  let rounds = 0;
  const allResponses: TeamPanelResponse[] = [];
  const modelSet = new Set(definition.members.map((m) => m.model));
  modelSet.add(definition.primary!.model);

  const perModelTokens = new Map<string, { input: number; output: number }>();
  let totalInput = 0;
  let totalOutput = 0;

  // Round 1: parallel panel
  rounds++;
  const round1Start = Date.now();
  const pool = getGlobalAgentPool();

  const panelResults = await Promise.all(
    definition.members.map(async (member, i) => {
      const slot = await pool.acquire(definition.timeoutMs);
      try {
        const localSignal = definition.timeoutMs
          ? AbortSignal.any([signal, AbortSignal.timeout(definition.timeoutMs)].filter((s): s is AbortSignal => s != null))
          : signal;

        const result = await singleModelCall(
          memberApis[i]!,
          prompt,
          member.systemPrompt,
          localSignal,
        );

        const resp: TeamPanelResponse = {
          round: 1,
          model: member.model,
          content: result.content,
          tokens: { input: result.inputTokens, output: result.outputTokens },
          durationMs: result.durationMs,
        };

        // Track tokens
        const existing = perModelTokens.get(member.model) ?? { input: 0, output: 0 };
        existing.input += result.inputTokens;
        existing.output += result.outputTokens;
        perModelTokens.set(member.model, existing);
        totalInput += result.inputTokens;
        totalOutput += result.outputTokens;

        return resp;
      } catch {
        // Graceful degradation: return error marker
        return {
          round: 1 as const,
          model: member.model,
          content: `[ERROR: ${member.model} failed to respond]`,
          tokens: { input: 0, output: 0 },
          durationMs: Date.now() - round1Start,
        } satisfies TeamPanelResponse;
      } finally {
        slot.release();
      }
    }),
  );

  allResponses.push(...panelResults);

  // Primary model analyzes and decides
  const panelSummary = allResponses
    .map((r) => `### ${r.model}\n${r.content}`)
    .join('\n\n---\n\n');

  const analysisPrompt = [
    'You are the primary decision-maker in a multi-model panel.',
    'Below are responses from multiple models to the same question.',
    '',
    'Your task:',
    '1. Analyze the responses — note agreements, contradictions, unique insights',
    '2. Decide whether the answer is complete or needs another round',
    '3. If complete, synthesize a comprehensive final answer',
    '4. If not complete, specify what needs further exploration',
    '',
    'Original question:',
    prompt,
    '',
    'Panel responses:',
    panelSummary,
    '',
    'Respond in one of these formats:',
    '',
    'To FINALIZE (answer is complete):',
    'FINALIZE',
    '<your comprehensive synthesized answer>',
    '',
    'To CONTINUE (need another round):',
    'CONTINUE',
    '<refined question for the next round>',
    '<specific aspects to explore>',
  ].join('\n');

  const primaryResult = await singleModelCall(primaryApi, analysisPrompt, definition.primary?.systemPrompt, signal);
  totalInput += primaryResult.inputTokens;
  totalOutput += primaryResult.outputTokens;

  const primaryModel = definition.primary!.model;
  const existing = perModelTokens.get(primaryModel) ?? { input: 0, output: 0 };
  existing.input += primaryResult.inputTokens;
  existing.output += primaryResult.outputTokens;
  perModelTokens.set(primaryModel, existing);

  // Parse primary decision
  const isContinue = primaryResult.content.trim().startsWith('CONTINUE');
  let finalAnswer: string;

  if (isContinue) {
    // Additional rounds — primary model continues to deliberate
    const refinedQuestion = primaryResult.content.replace(/^CONTINUE\s*/i, '').trim();
    let currentQuestion = refinedQuestion || prompt;
    let converged = false;

    while (!converged && rounds < 100) { // Safety cap, but primary decides convergence
      rounds++;
      const roundStart = Date.now();

      const roundResults = await Promise.all(
        definition.members.map(async (member, i) => {
          const slot = await pool.acquire(definition.timeoutMs);
          try {
            const result = await singleModelCall(
              memberApis[i]!,
              `[Round ${rounds}] ${currentQuestion}\n\nPrevious round context:\n${panelSummary}`,
              member.systemPrompt,
              signal,
            );

            const resp: TeamPanelResponse = {
              round: rounds,
              model: member.model,
              content: result.content,
              tokens: { input: result.inputTokens, output: result.outputTokens },
              durationMs: Date.now() - roundStart,
            };

            const ex = perModelTokens.get(member.model) ?? { input: 0, output: 0 };
            ex.input += result.inputTokens;
            ex.output += result.outputTokens;
            perModelTokens.set(member.model, ex);
            totalInput += result.inputTokens;
            totalOutput += result.outputTokens;

            return resp;
          } catch {
            return {
              round: rounds,
              model: member.model,
              content: `[ERROR: ${member.model} failed]`,
              tokens: { input: 0, output: 0 },
              durationMs: Date.now() - roundStart,
            } satisfies TeamPanelResponse;
          } finally {
            slot.release();
          }
        }),
      );

      allResponses.push(...roundResults);

      const roundSummary = roundResults
        .map((r) => `### ${r.model}\n${r.content}`)
        .join('\n\n---\n\n');

      const followUpPrompt = [
        `Round ${rounds} panel responses to: "${currentQuestion}"`,
        '',
        roundSummary,
        '',
        'Decision: FINALIZE (synthesize answer) or CONTINUE (refine question)?',
      ].join('\n');

      const followUpResult = await singleModelCall(primaryApi, followUpPrompt, definition.primary?.systemPrompt, signal);
      totalInput += followUpResult.inputTokens;
      totalOutput += followUpResult.outputTokens;

      const pex = perModelTokens.get(primaryModel) ?? { input: 0, output: 0 };
      pex.input += followUpResult.inputTokens;
      pex.output += followUpResult.outputTokens;
      perModelTokens.set(primaryModel, pex);

      if (followUpResult.content.trim().startsWith('FINALIZE')) {
        finalAnswer = followUpResult.content.replace(/^FINALIZE\s*/i, '').trim();
        converged = true;
      } else {
        currentQuestion = followUpResult.content.replace(/^CONTINUE\s*/i, '').trim() || currentQuestion;
      }
    }

    if (!converged) {
      finalAnswer = primaryResult.content;
    }
  } else {
    finalAnswer = primaryResult.content.replace(/^FINALIZE\s*/i, '').trim();
  }

  const cost = computeCost([...modelSet], totalInput, totalOutput, perModelTokens);

  return {
    answer: finalAnswer!,
    mode: 'panel',
    rounds,
    panelResponses: allResponses,
    cost,
    durationMs: Date.now() - startedAt,
  };
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
  const routerApi: MemberApi = await createMemberApi(definition.router!, definition.members[0]?.baseURL);
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

  const classifyResult = await singleModelCall(routerApi, classificationPrompt, definition.router?.systemPrompt, signal);

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

  const result = await singleModelCall(chosenApi, prompt, chosenMember.systemPrompt, signal);

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
  const primaryApi: MemberApi = await createMemberApi(definition.primary!, definition.members[0]?.baseURL);
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

  while (!converged && rounds < 100) {
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

      const result = await singleModelCall(memberApis[i]!, speakPrompt, member.systemPrompt, signal);

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

    const facilitatorResult = await singleModelCall(facilitatorApi, facilitatorPrompt, definition.facilitator?.systemPrompt, signal);

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

    const primaryResult = await singleModelCall(primaryApi, primaryDecisionPrompt, definition.primary?.systemPrompt, signal);

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
  const executorApi = await createMemberApi(definition.executor!, definition.members[0]?.baseURL);
  const reviewerApi = await createMemberApi(definition.reviewer!, definition.members[0]?.baseURL);

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

  // Iteration 1: Executor produces initial output
  iterations++;
  const execResult = await singleModelCall(executorApi, prompt, definition.executor?.systemPrompt, signal);
  currentOutput = execResult.content;
  perModelTokens.set(definition.executor!.model, { input: execResult.inputTokens, output: execResult.outputTokens });
  totalInput += execResult.inputTokens;
  totalOutput += execResult.outputTokens;

  while (!converged && iterations < 100) {
    // Reviewer critiques
    const reviewPrompt = [
      'You are an experienced reviewer providing constructive feedback.',
      'Review the following output and suggest improvements.',
      '',
      'Original request:',
      prompt,
      '',
      'Current output:',
      currentOutput,
      '',
      'Provide specific, actionable feedback. You are an advisor — the executor makes final decisions.',
    ].join('\n');

    const reviewResult = await singleModelCall(reviewerApi, reviewPrompt, definition.reviewer?.systemPrompt, signal);
    reviews.push({ iteration: iterations, feedback: reviewResult.content });

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
      'Your current output:',
      currentOutput,
      '',
      'Reviewer feedback:',
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

    const decisionResult = await singleModelCall(executorApi, decisionPrompt, definition.executor?.systemPrompt, signal);

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
//  ModelTeam class
// ═══════════════════════════════════════════════════════════════════

export class ModelTeam {
  readonly name: string;
  readonly definition: TeamDefinition;
  private depth = 0;

  constructor(definition: TeamDefinition, depth?: number) {
    this.name = definition.name;
    this.definition = definition;
    this.depth = depth ?? 0;
  }

  /**
   * Ask the team a question. Returns the synthesized answer.
   * Panel/Discussion: primary model decides when to converge.
   * Router: classifies and dispatches.
   * Executor-Reviewer: executor decides when done.
   */
  async ask(prompt: string, signal?: AbortSignal): Promise<ModelTeamResult> {
    switch (this.definition.mode) {
      case 'panel':
        return runPanelMode(prompt, this.definition, signal);
      case 'router':
        return runRouterMode(prompt, this.definition, signal);
      case 'discussion':
        return runDiscussionMode(prompt, this.definition, signal);
      case 'executor-reviewer':
        return runExecutorReviewerMode(prompt, this.definition, signal);
      default:
        throw new Error(`Unknown team mode: ${(this.definition as any).mode}`);
    }
  }

  /** Get the team's recursion depth (for protection). */
  get currentDepth(): number {
    return this.depth;
  }
}

/**
 * Create a ModelTeam from a definition or from disk.
 */
export function createModelTeam(
  definition: TeamDefinition,
  depth?: number,
): ModelTeam {
  // Validate
  validateTeamDefinition(definition);
  return new ModelTeam(definition, depth);
}

function validateTeamDefinition(def: TeamDefinition): void {
  if (!def.name) throw new Error('Team definition must have a name.');
  if (!def.mode) throw new Error('Team definition must specify a mode.');

  switch (def.mode) {
    case 'panel':
      if (!def.primary) throw new Error('Panel mode requires a primary member.');
      if (!def.members || def.members.length === 0) throw new Error('Panel mode requires at least one panel member.');
      if (def.members.length > 8) throw new Error('Panel mode supports at most 8 members.');
      break;
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
    description: definition.description ?? `Multi-model team (${definition.mode} mode)`,
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
      additionalProperties: false,
    },
    async execute(input: unknown) {
      const { prompt } = input as { prompt: string };
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
      'Call this tool with a { prompt } to get a multi-model synthesized answer.',
      `Members: ${definition.members?.map((m) => m.model).join(', ') ?? 'configured via definition'}`,
    ].join('\n'),
  };
}
