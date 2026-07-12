/**
 * Team designer propose helpers — validate/canonicalize LLM drafts without
 * writing to disk. Used by POST /api/team/propose.
 */
import { robustJsonParse } from '../provider/json-parse.js';
import type { TeamDefinition } from '../types.js';
import {
  ensureConfiguredTeamGraph,
  migrateTeamDefinitionToGraph,
  validateTeamGraph,
} from './teamGraph.js';

export type TeamProposeSquadType = 'graph' | 'workflow' | 'subagent';

export interface TeamProposeResult {
  definition: TeamDefinition | null;
  problems: string[];
  explanation?: string;
  rawText?: string;
}

const GRAPH_CONTRACT = `You design Actoviq Team Graph definitions as JSON only.
Hard contract:
- Exactly 1 Task (kind:"task", id typically "task") — Dispatch entry that injects the run prompt.
- Exactly 1 Caller Exit (kind:"return") — void or payload returnMode.
- Middle: any number of agent / team-ref nodes; any directed edges; optional condition / loop / undirected.
- Optional uiGroups for Parallel/Loop visual clusters (engine ignores them).
- Coordinates (ui.x/y) may be omitted.
Return a single JSON object: { "explanation": string, "definition": TeamDefinition }.
TeamDefinition fields: name, mode:"graph", version:3, orchestration:"graph", squadType:"graph", members:[], nodes[], edges[], uiGroups?, maxRounds?.
Do not wrap in markdown fences.`;

export function buildTeamProposeSystemPrompt(squadType: TeamProposeSquadType): string {
  if (squadType === 'workflow') {
    return `You design Actoviq workflow squad trees as JSON only.
Return { "explanation": string, "definition": { name, squadType:"workflow", mode:"graph", members:[], workflowTree } }.
workflowTree nodes: { id, type:"agent"|..., label, prompt?, children? }.
No markdown fences.`;
  }
  if (squadType === 'subagent') {
    return `You design a single-agent (subagent) squad as JSON only.
Return { "explanation": string, "definition": { name, squadType:"subagent", mode:"graph", members:[one agent with role/prompt/model/tools] } }.
No markdown fences.`;
  }
  return GRAPH_CONTRACT;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return robustJsonParse(trimmed, 'team.propose');
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return robustJsonParse(trimmed.slice(start, end + 1), 'team.propose');
    }
    throw new Error('Model response was not valid JSON');
  }
}

/**
 * Parse model text into a draft definition and run migrate+validate.
 * Always returns problems (may be non-empty) together with the draft when parse succeeds.
 */
export function finalizeTeamProposeDraft(
  rawText: string,
  opts?: { squadType?: TeamProposeSquadType; fallbackName?: string },
): TeamProposeResult {
  const squadType = opts?.squadType ?? 'graph';
  let parsed: unknown;
  try {
    parsed = extractJsonObject(rawText);
  } catch (err) {
    return {
      definition: null,
      problems: [(err as Error).message || 'Failed to parse propose JSON'],
      rawText,
    };
  }

  const record = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
  const explanation = typeof record.explanation === 'string' ? record.explanation : undefined;
  const defRaw = (record.definition && typeof record.definition === 'object')
    ? record.definition as TeamDefinition
    : (record as unknown as TeamDefinition);

  if (!defRaw || typeof defRaw !== 'object') {
    return { definition: null, problems: ['Draft JSON missing definition object'], explanation, rawText };
  }

  const named: TeamDefinition = {
    ...defRaw,
    name: typeof defRaw.name === 'string' && defRaw.name.trim()
      ? defRaw.name
      : (opts?.fallbackName || 'proposed-team'),
    members: Array.isArray(defRaw.members) ? defRaw.members : [],
    mode: defRaw.mode || 'graph',
    squadType: defRaw.squadType || squadType,
  };

  if (squadType === 'graph' || named.squadType === 'graph' || named.orchestration === 'graph' || named.mode === 'graph') {
    try {
      const migrated = ensureConfiguredTeamGraph(migrateTeamDefinitionToGraph(named));
      const problems = validateTeamGraph(migrated);
      return { definition: migrated, problems, explanation, rawText };
    } catch (err) {
      return {
        definition: named,
        problems: [(err as Error).message || 'migrate/validate failed'],
        explanation,
        rawText,
      };
    }
  }

  // workflow / subagent — light shape checks only
  const problems: string[] = [];
  if (squadType === 'workflow' && !named.workflowTree) {
    problems.push('workflow squad requires workflowTree');
  }
  if (squadType === 'subagent' && !(named.members?.length)) {
    problems.push('subagent squad requires at least one member');
  }
  return { definition: named, problems, explanation, rawText };
}

export function buildTeamProposeUserPrompt(
  instruction: string,
  current?: TeamDefinition | null,
  mode: 'replace' | 'patch' = 'replace',
): string {
  const parts = [
    `Mode: ${mode}`,
    `Instruction:\n${instruction.trim() || '(no instruction)'}`,
  ];
  if (current) {
    parts.push(
      'Current definition JSON (edit or replace as instructed):\n'
      + JSON.stringify({
        name: current.name,
        squadType: current.squadType || 'graph',
        mode: current.mode,
        version: current.version,
        nodes: current.nodes,
        edges: current.edges,
        uiGroups: current.uiGroups,
        workflowTree: current.workflowTree,
        members: current.members,
        maxRounds: current.maxRounds,
      }),
    );
  }
  return parts.join('\n\n');
}
