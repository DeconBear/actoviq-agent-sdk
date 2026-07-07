/**
 * ModelTeam — multi-model cooperation via graph v3 (Task → agents → Return).
 * Legacy `panel-analysis` / `reviewer` definitions are migrated to graph
 * metadata at load/save/runtime. `orchestratePanel` remains exported for tests.
 */
import type {
  TeamDefinition,
  TeamMember,
  TeamCost,
  ExpertPanelReport,
  GraphTeamResult,
  MemberStatus,
  ModelTeamResult,
  AgentToolDefinition,
  TeamGraphReturnMode,
  TeamAskOptions,
  TeamEvent,
} from '../types.js';
import { estimateCost, hasFullPricing } from './pricing.js';
import {
  buildMemberIdentities,
  runMemberAgent,
} from './teamRuntime.js';
import { buildGraphNodeTools, canonicalizeTeamDefinition, createNotifyTeammateTool, migrateTeamDefinitionToV3, orchestrateGraph } from './teamGraph.js';
import { listTeamAgentLabels, loadTeamDefinition } from './teamDefinitions.js';
import { resolveGraphNodeSystemPrompt } from './teamPrompts.js';

// ═══════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════

/** Label panel/graph agent reports for human-readable void-Return answers. */
export function formatExpertPanelReports(
  reports: Array<{ id?: string; model?: string; report: string }>,
): string {
  return reports
    .map((r) => `### ${r.id ?? r.model ?? 'agent'}\n${r.report}`)
    .join('\n\n---\n\n');
}

export function resolveGraphDisplayAnswer(params: {
  returnMode?: TeamGraphReturnMode;
  returnValue?: string | null;
  engineAnswer: string;
  reports: ExpertPanelReport[];
  lastFromOutput?: string;
}): string {
  const { returnMode, returnValue, engineAnswer, reports, lastFromOutput } = params;
  if (returnMode === 'payload' && returnValue != null && returnValue !== '') return returnValue;
  if (engineAnswer.trim()) return engineAnswer;

  const finalizeBody = (lastFromOutput ?? '').replace(/^FINALIZE\s*/i, '').trim();
  if (finalizeBody && !finalizeBody.toUpperCase().startsWith('CONTINUE')) return finalizeBody;

  const substantive = reports.filter((r) => r.report.trim());
  if (substantive.length === 1) return substantive[0]!.report;
  if (substantive.length > 1) return formatExpertPanelReports(substantive);
  return '';
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
//  Panel convergence helper (unit-tested; graph v3 primary loops delegate here)
// ═══════════════════════════════════════════════════════════════════

/**
 * Orchestrate the panel over an injectable `investigate` (one round of member
 * reports) and optional `decide` (the primary's synthesize-or-continue call).
 *
 * Exported so convergence logic is unit-testable without real model calls.
 */
export async function orchestratePanel(opts: {
  prompt: string;
  maxRounds: number;
  investigate: (round: number, question: string, priorContext?: string) => Promise<ExpertPanelReport[]>;
  decide?: (deliberationLog: string, round: number) => Promise<string>;
  onEvent?: (event: TeamEvent) => void;
}): Promise<{ answer: string; rounds: number; reports: ExpertPanelReport[] }> {
  const allReports: ExpertPanelReport[] = [];
  let rounds = 1;
  let currentReports = await opts.investigate(1, opts.prompt);
  allReports.push(...currentReports);
  opts.onEvent?.({ type: 'team.round.completed', round: 1, reports: currentReports.length });

  if (!opts.decide) {
    return { answer: formatExpertPanelReports(currentReports), rounds, reports: allReports };
  }

  const deliberationLog: string[] = [`## Round 1 — Panel findings\n${formatExpertPanelReports(currentReports)}`];
  while (true) {
    const content = await opts.decide(deliberationLog.join('\n\n---\n\n'), rounds);
    const wantsContinue = content.trim().toUpperCase().startsWith('CONTINUE');
    if (wantsContinue && rounds < opts.maxRounds) {
      opts.onEvent?.({ type: 'team.synthesis', round: rounds, decision: 'continue' });
      const refined = content.replace(/^CONTINUE\s*/i, '').trim() || opts.prompt;
      deliberationLog.push(`## Round ${rounds} — Primary decision\nCONTINUE: ${refined}`);
      rounds++;
      currentReports = await opts.investigate(rounds, refined, formatExpertPanelReports(currentReports));
      allReports.push(...currentReports);
      opts.onEvent?.({ type: 'team.round.completed', round: rounds, reports: currentReports.length });
      deliberationLog.push(`## Round ${rounds} — Panel findings\n${formatExpertPanelReports(currentReports)}`);
    } else {
      opts.onEvent?.({ type: 'team.synthesis', round: rounds, decision: 'finalize' });
      const answer = wantsContinue
        ? formatExpertPanelReports(currentReports)
        : content.replace(/^FINALIZE\s*/i, '').trim() || formatExpertPanelReports(currentReports);
      return { answer, rounds, reports: allReports };
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Graph Mode — DAG of nodes wired by on_complete edges (wait-all joins)
// ═══════════════════════════════════════════════════════════════════

/**
 * Execute a version-2 graph definition. Entry nodes investigate the prompt in
 * parallel; each completed node fires its `on_complete` edges (streamed as
 * `team.edge.triggered`), and downstream nodes wake once ALL their in-edges
 * delivered (AND-join), receiving the prompt plus rendered upstream payloads.
 * Failures propagate fail-soft as `[FAILED …]` payload markers. Nodes default
 * to the read-only expert toolset; `allowedTools` opts specific core tools in
 * per node. The scheduling loop itself is `orchestrateGraph` (unit-tested with
 * injected runners, same approach as `orchestratePanel`).
 */
async function runGraphMode(
  prompt: string,
  definition: TeamDefinition,
  signal?: AbortSignal,
  workDir?: string,
  onEvent?: (event: TeamEvent) => void,
  reviewerContext?: string,
  teamStack: string[] = [],
): Promise<GraphTeamResult> {
  const startedAt = Date.now();
  const execDef = migrateTeamDefinitionToV3(definition);
  const cwd = workDir ?? process.cwd();
  const agentNodes = (execDef.nodes ?? []).filter((n) => (n.kind ?? 'agent') === 'agent');
  const identities = buildMemberIdentities(agentNodes);
  const squadMaxIterations = definition.maxIterations;
  const squadTimeoutMs = definition.timeoutMs;
  const squadMaxRounds = definition.maxRounds;

  const resolveMemberMaxIterations = (node: typeof agentNodes[number]) => {
    const cap = node.maxIterations ?? squadMaxIterations;
    return cap != null && cap > 0 ? cap : Infinity;
  };
  const resolveMemberTimeout = (node: typeof agentNodes[number]) =>
    node.timeoutMs ?? squadTimeoutMs;
  const resolveGraphMaxRounds = () => {
    const nodeCaps = agentNodes
      .map((n) => n.maxRounds)
      .filter((n): n is number => n != null && n > 0);
    if (nodeCaps.length) return Math.min(...nodeCaps);
    if (squadMaxRounds != null && squadMaxRounds > 0) return squadMaxRounds;
    return Infinity;
  };
  const graphMaxRounds = resolveGraphMaxRounds();
  const execDefWithRounds = graphMaxRounds !== execDef.maxRounds
    ? { ...execDef, maxRounds: graphMaxRounds }
    : execDef;

  const perModelTokens = new Map<string, { input: number; output: number }>();
  const memberStatuses: MemberStatus[] = [];
  const reportsById = new Map<string, ExpertPanelReport>();
  let totalInput = 0;
  let totalOutput = 0;

  onEvent?.({
    type: 'team.started',
    mode: 'graph',
    members: identities.map((identity) => ({ id: identity.id, model: identity.model, role: identity.role })),
  });

  const { answer, skipped, returnValue, returnMode, returnNodeId, rounds, incompleteReason: graphIncomplete, lastFromOutput } = await orchestrateGraph({
    prompt,
    definition: execDefWithRounds,
    onEvent,
    runNode: async (node, identity, task, ctx) => {
      const nodeType = node.type ?? 'react';
      const base = { id: identity.id, model: identity.model, role: identity.role };

      // team-as-agent: invoke a persisted sub-team by teamRef.
      if (nodeType === 'team') {
        const ref = node.teamRef?.trim();
        if (!ref) {
          memberStatuses.push({ ...base, ok: false, error: 'team node missing teamRef', toolCalls: 0, durationMs: 0 });
          return { report: `[team node "${identity.id}" has no teamRef]`, ok: false, error: 'missing teamRef' };
        }
        if (teamStack.includes(ref)) {
          const cycle = [...teamStack, ref].join(' → ');
          memberStatuses.push({ ...base, ok: false, error: `team recursion: ${cycle}`, toolCalls: 0, durationMs: 0 });
          return { report: `[team recursion detected: ${cycle}]`, ok: false, error: 'recursion' };
        }
        const loaded = loadTeamDefinition(ref, cwd);
        if (!loaded) {
          memberStatuses.push({ ...base, ok: false, error: `team "${ref}" not found`, toolCalls: 0, durationMs: 0 });
          return { report: `[team "${ref}" not found]`, ok: false, error: 'team not found' };
        }
        const subStarted = Date.now();
        try {
          const subTeam = new ModelTeam(loaded.definition);
          const subResult = await subTeam.ask(task, signal, { workDir: cwd, onEvent, teamStack: [...teamStack, ref] });
          for (const m of subResult.memberStatuses ?? []) memberStatuses.push(m);
          const subIn = subResult.cost?.totalInputTokens ?? 0;
          const subOut = subResult.cost?.totalOutputTokens ?? 0;
          totalInput += subIn;
          totalOutput += subOut;
          const ex = perModelTokens.get(identity.model) ?? { input: 0, output: 0 };
          ex.input += subIn;
          ex.output += subOut;
          perModelTokens.set(identity.model, ex);
          reportsById.set(identity.id, {
            id: identity.id, role: identity.role, model: identity.model,
            report: subResult.answer, toolCalls: 0, durationMs: Date.now() - subStarted, round: 1,
          });
          return { report: subResult.answer, ok: !subResult.incompleteReason, error: subResult.incompleteReason };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          memberStatuses.push({ ...base, ok: false, error: `team "${ref}" failed: ${msg}`, toolCalls: 0, durationMs: Date.now() - subStarted });
          return { report: `[team "${ref}" failed: ${msg}]`, ok: false, error: msg };
        }
      }

      // single: one LLM call, no tools. react: full ReAct loop.
      const tools = nodeType === 'single' ? [] : await buildGraphNodeTools(node, cwd);
      if (nodeType !== 'single' && ctx.commTargets.length > 0) {
        tools.push(await createNotifyTeammateTool(ctx));
      }
      const member = { ...node, model: node.model ?? identity.model };
      const singleReviewer = execDef.nodes?.filter((n) => (n.kind ?? 'agent') === 'agent').length === 1;
      const systemPrompt = resolveGraphNodeSystemPrompt(member, {
        reviewerContext: singleReviewer ? reviewerContext : undefined,
      });
      const run = await runMemberAgent({
        identity,
        member,
        task,
        systemPrompt,
        cwd,
        tools,
        maxIterations: nodeType === 'single' ? 1 : resolveMemberMaxIterations(node),
        timeoutMs: resolveMemberTimeout(node),
        reconnectAttempts: node.reconnectAttempts ?? 10,
        signal,
        round: 1,
        onEvent,
      });
      const ex = perModelTokens.get(identity.model) ?? { input: 0, output: 0 };
      ex.input += run.inputTokens;
      ex.output += run.outputTokens;
      perModelTokens.set(identity.model, ex);
      totalInput += run.inputTokens;
      totalOutput += run.outputTokens;
      memberStatuses.push(run.status);
      reportsById.set(identity.id, {
        id: identity.id,
        role: identity.role,
        model: identity.model,
        report: run.report,
        toolCalls: run.status.toolCalls ?? 0,
        durationMs: run.status.durationMs ?? 0,
        round: 1,
      });
      return { report: run.report, ok: run.status.ok, error: run.status.error };
    },
  });

  // Nodes that never woke (manual-only in-edges / unreachable) get a skipped status.
  for (const id of skipped) {
    const identity = identities.find((x) => x.id === id)!;
    memberStatuses.push({ id, model: identity.model, role: identity.role, ok: false, skipped: true, error: 'never triggered (no on_complete path from an entry node)', toolCalls: 0, durationMs: 0 });
  }

  const failed = memberStatuses.filter((status) => !status.ok && !status.skipped);
  const incompleteReason = graphIncomplete
    ?? (failed.length > 0
      ? `${failed.length} of ${memberStatuses.length} node run(s) failed`
      : skipped.length > 0
        ? `${skipped.length} node(s) never triggered: ${skipped.join(', ')}`
        : undefined);
  onEvent?.({ type: 'team.completed', mode: 'graph', rounds: rounds ?? 1, incompleteReason });

  const cost = computeCost([...perModelTokens.keys()], totalInput, totalOutput, perModelTokens);
  const reportList = [...reportsById.values()];
  const resolvedAnswer = resolveGraphDisplayAnswer({
    returnMode,
    returnValue,
    engineAnswer: answer,
    reports: reportList,
    lastFromOutput,
  });
  return {
    answer: resolvedAnswer,
    mode: 'graph',
    reports: reportList,
    skippedNodes: skipped,
    returnValue: returnValue ?? null,
    returnMode,
    returnNodeId,
    graphRounds: rounds,
    cost,
    durationMs: Date.now() - startedAt,
    memberStatuses,
    incompleteReason,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  ModelTeam class
// ═══════════════════════════════════════════════════════════════════

export class ModelTeam {
  readonly name: string;
  /** Canonical graph v3 definition (Task + Return ports) used at runtime. */
  readonly definition: TeamDefinition;

  constructor(definition: TeamDefinition) {
    this.definition = canonicalizeTeamDefinition(definition);
    this.name = this.definition.name;
  }

  /**
   * Ask the team. All modes execute through the graph v3 engine (Task → agents → Return).
   * `opts.context` is appended to the reviewer agent's system prompt when the graph
   * has a single payload-return agent (reviewer-style presets).
   */
  async ask(prompt: string, signal?: AbortSignal, opts?: TeamAskOptions): Promise<ModelTeamResult> {
    return runGraphMode(prompt, this.definition, signal, opts?.workDir, opts?.onEvent, opts?.context, opts?.teamStack);
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
  if (!def.mode && def.orchestration !== 'graph') {
    throw new Error('Team definition must specify a mode.');
  }

  // Legacy-mode guards give clearer errors before graph migration.
  if (def.orchestration !== 'graph' && def.mode !== 'graph') {
    switch (def.mode) {
      case 'reviewer':
      case 'executor-reviewer':
        if (!def.reviewer) throw new Error('Reviewer mode requires a reviewer member.');
        break;
      case 'panel':
      case 'analysis':
      case 'panel-analysis':
        if (!def.members || def.members.length === 0) {
          throw new Error('Panel-analysis mode requires at least one panel member.');
        }
        if (def.members.length > 8) throw new Error('Panel-analysis mode supports at most 8 members.');
        break;
    }
  }

  canonicalizeTeamDefinition(def);
}

/** Infer tool UX (reviewer task/context vs panel prompt) from graph v3 shape. */
function inferTeamToolProfile(definition: TeamDefinition): 'reviewer' | 'panel' | 'graph' {
  const nodes = definition.nodes ?? [];
  const agents = nodes.filter((n) => (n.kind ?? 'agent') === 'agent');
  const payloadReturn = nodes.some((n) => n.kind === 'return' && n.returnMode === 'payload');
  if (agents.length === 1 && payloadReturn) return 'reviewer';
  const hasConvergenceLoop = (definition.edges ?? []).some(
    (e) => e.loop
      && (e.condition?.includes('CONTINUE') ?? false)
      && e.from !== 'task',
  );
  if (agents.length > 1 || hasConvergenceLoop) return 'panel';
  return 'graph';
}

/**
 * Create a team tool that agents can invoke.
 * Returns an AgentToolDefinition with interruptBehavior: 'block'.
 */
export function createTeamTool(
  definition: TeamDefinition,
): AgentToolDefinition {
  const team = createModelTeam(definition);
  const profile = inferTeamToolProfile(team.definition);
  const isReviewer = profile === 'reviewer';
  const isPanel = profile === 'panel';
  const isGraph = profile === 'graph';

  return {
    kind: 'local',
    name: definition.name,
    description:
      definition.description ??
      (isReviewer
        ? 'Reviewer: a single read-only agent inspects the project and reports only genuine, verifiable issues. Pass { task } (what to check) and optional { context } (what you did + the results). It advises; you decide.'
        : isPanel
          ? 'Expert panel: independent read-only multi-model analysis (advisory; optional primary-driven convergence). You decide what to do with the findings.'
          : isGraph
            ? 'Agent collaboration graph: entry nodes investigate in parallel and hand off downstream along on_complete edges (wait-all joins). Pass { prompt }; the terminal node reports come back as the answer.'
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
      const toolAnswer = result.returnMode === 'void'
        ? (result.answer.trim() || 'Team completed.')
        : result.returnValue ?? result.answer;
      return JSON.stringify({
        answer: toolAnswer,
        mode: result.mode,
        returnValue: result.returnValue ?? null,
        returnMode: result.returnMode,
        cost: result.cost,
        memberStatuses: result.memberStatuses,
        incompleteReason: result.incompleteReason,
      });
    },
    interruptBehavior: 'block',
    isConcurrencySafe: () => false,
    prompt: async () => [
      `## ${definition.name} (Model Team: graph)`,
      definition.description ?? '',
      '',
      isReviewer
        ? 'Call this tool with { task } (what to scrutinize) and optional { context } (what you did and the results you got). A single read-only agent inspects the code/web and reports only issues it can verify — no speculation. You keep final authority; re-invoke after changes to re-check.'
        : isPanel
          ? 'Call this tool with a { prompt } to have an expert panel of independent read-only agents investigate (read local code + search the web) and each return a findings report. They only analyze and advise — you keep full control and decide what to do with their input. With a configured primary the panel also converges over multiple rounds into a synthesized answer. Use it to assist analysis on large or complex tasks.'
          : 'Call this tool with a { prompt } to get a multi-model synthesized answer.',
      isReviewer
        ? `Reviewer: ${definition.reviewer?.model ?? 'configured via definition'}`
        : isGraph
          ? `Nodes: ${listTeamAgentLabels(definition).join(' → ') || 'configured via definition'}`
          : `Agents: ${listTeamAgentLabels(definition).join(', ') || 'configured via definition'}`,
    ].join('\n'),
  };
}
