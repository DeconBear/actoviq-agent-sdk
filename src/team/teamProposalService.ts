import { createHash, randomUUID } from 'node:crypto';

import type { TeamDefinition, TeamGraphEdge, TeamGraphNode } from '../types.js';
import {
  canonicalizeTeamDefinition,
  graphNodeRef,
  migrateTeamDefinitionToGraph,
  toPersistedTeamDefinition,
  validateTeamGraph,
} from './teamGraph.js';
import {
  computeTeamGraphAutoLayout,
  pickAutoEdgeRoute,
  type GraphRect,
} from './teamGraphLayout.js';
import {
  loadTeamDefinition,
  saveTeamDefinition,
  type LoadedTeamDefinition,
} from './teamDefinitions.js';

export type TeamProposalStatus = 'pending' | 'applied' | 'rejected' | 'conflict';

export interface TeamProposalDiff {
  addedNodes: string[];
  removedNodes: string[];
  changedNodes: string[];
  addedEdges: string[];
  removedEdges: string[];
  changedEdges: string[];
}

export interface TeamGraphProposal {
  id: string;
  assistantSessionId: string;
  projectPath: string;
  teamName: string;
  baseFingerprint: string | null;
  baseSource: LoadedTeamDefinition['source'] | null;
  explanation: string;
  problems: string[];
  diff: TeamProposalDiff;
  draft: TeamDefinition;
  status: TeamProposalStatus;
  createdAt: string;
  appliedAt?: string;
}

export interface StageTeamProposalInput {
  assistantSessionId: string;
  projectPath: string;
  definition: TeamDefinition;
  explanation?: string;
  homeDir?: string;
}

export interface ApplyTeamProposalResult {
  proposal: TeamGraphProposal;
  filePath: string;
}

export class TeamProposalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamProposalConflictError';
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function teamDefinitionFingerprint(definition: TeamDefinition): string {
  const persisted = toPersistedTeamDefinition(definition);
  return createHash('sha256')
    .update(JSON.stringify(stableValue(persisted)))
    .digest('hex');
}

function nodeKey(node: TeamGraphNode): string {
  return graphNodeRef(node);
}

function edgeKey(edge: TeamGraphEdge): string {
  return [
    edge.from,
    edge.to,
    edge.channel ?? 'message',
    edge.trigger ?? 'on_complete',
    edge.condition ?? '',
    edge.loop ? 'loop' : '',
    edge.direction ?? 'directed',
  ].join('\u0000');
}

function edgeLabel(edge: TeamGraphEdge): string {
  const arrow = edge.direction === 'undirected' ? ' ↔ ' : ' → ';
  const detail = [
    edge.trigger && edge.trigger !== 'on_complete' ? edge.trigger : '',
    edge.condition ? `if ${edge.condition}` : '',
    edge.loop ? 'loop' : '',
  ].filter(Boolean).join(', ');
  return `${edge.from}${arrow}${edge.to}${detail ? ` (${detail})` : ''}`;
}

function comparableNode(node: TeamGraphNode): unknown {
  const copy = structuredClone(node);
  delete copy.ui;
  return stableValue(copy);
}

function comparableEdge(edge: TeamGraphEdge): unknown {
  const copy = structuredClone(edge);
  delete copy.ui;
  return stableValue(copy);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

export function diffTeamDefinitions(
  base: TeamDefinition | null,
  draft: TeamDefinition,
): TeamProposalDiff {
  const baseNodes = new Map((base?.nodes ?? []).map(node => [nodeKey(node), node]));
  const draftNodes = new Map((draft.nodes ?? []).map(node => [nodeKey(node), node]));
  const baseEdges = new Map((base?.edges ?? []).map(edge => [edgeKey(edge), edge]));
  const draftEdges = new Map((draft.edges ?? []).map(edge => [edgeKey(edge), edge]));

  return {
    addedNodes: [...draftNodes.keys()].filter(key => !baseNodes.has(key)),
    removedNodes: [...baseNodes.keys()].filter(key => !draftNodes.has(key)),
    changedNodes: [...draftNodes.entries()]
      .filter(([key, node]) => {
        const previous = baseNodes.get(key);
        return previous != null && !valuesEqual(comparableNode(previous), comparableNode(node));
      })
      .map(([key]) => key),
    addedEdges: [...draftEdges.entries()]
      .filter(([key]) => !baseEdges.has(key))
      .map(([, edge]) => edgeLabel(edge)),
    removedEdges: [...baseEdges.entries()]
      .filter(([key]) => !draftEdges.has(key))
      .map(([, edge]) => edgeLabel(edge)),
    changedEdges: [...draftEdges.entries()]
      .filter(([key, edge]) => {
        const previous = baseEdges.get(key);
        return previous != null && !valuesEqual(comparableEdge(previous), comparableEdge(edge));
      })
      .map(([, edge]) => edgeLabel(edge)),
  };
}

function hasPosition(node: TeamGraphNode): boolean {
  return Number.isFinite(node.ui?.x) && Number.isFinite(node.ui?.y);
}

function nodeRect(node: TeamGraphNode): GraphRect | null {
  if (!hasPosition(node)) return null;
  const isPort = node.kind === 'task' || node.kind === 'return';
  return {
    x: node.ui!.x!,
    y: node.ui!.y!,
    w: isPort ? 112 : 168,
    h: isPort ? 48 : 72,
  };
}

/**
 * Preserve hand-edited graph UI while allowing an Assistant to replace the
 * semantic graph. Stable nodes keep coordinates; unchanged edges keep every
 * manual endpoint/curve field. Only missing/new UI receives automatic layout.
 */
export function mergeTeamProposalLayout(
  base: TeamDefinition | null,
  proposed: TeamDefinition,
): TeamDefinition {
  const draft = structuredClone(proposed);
  const baseNodes = new Map((base?.nodes ?? []).map(node => [nodeKey(node), node]));
  const baseEdges = new Map((base?.edges ?? []).map(edge => [edgeKey(edge), edge]));

  draft.nodes = (draft.nodes ?? []).map(node => {
    const previous = baseNodes.get(nodeKey(node));
    if (hasPosition(node) || !previous?.ui || !hasPosition(previous)) return node;
    return {
      ...node,
      ui: {
        ...node.ui,
        x: previous.ui.x,
        y: previous.ui.y,
        ...(node.ui?.groupId == null && previous.ui.groupId ? { groupId: previous.ui.groupId } : {}),
      },
    };
  });

  const positions = computeTeamGraphAutoLayout(draft);
  const missingPositionRefs = new Set(
    (draft.nodes ?? []).filter(node => !hasPosition(node)).map(nodeKey),
  );
  const occupied: GraphRect[] = (draft.nodes ?? [])
    .filter(node => hasPosition(node))
    .map(nodeRect)
    .filter((rect): rect is GraphRect => rect != null);
  const overlaps = (left: GraphRect, right: GraphRect): boolean =>
    left.x < right.x + right.w + 20
    && left.x + left.w + 20 > right.x
    && left.y < right.y + right.h + 20
    && left.y + left.h + 20 > right.y;
  draft.nodes = (draft.nodes ?? []).map((node, index) => {
    if (!missingPositionRefs.has(nodeKey(node))) return node;
    const isPort = node.kind === 'task' || node.kind === 'return';
    const candidate: GraphRect = {
      x: positions[index]?.x ?? 80,
      y: positions[index]?.y ?? 48,
      w: isPort ? 112 : 168,
      h: isPort ? 48 : 72,
    };
    while (occupied.some(rect => overlaps(candidate, rect))) {
      candidate.x += 44;
      candidate.y += 92;
    }
    occupied.push(candidate);
    return { ...node, ui: { ...node.ui, x: candidate.x, y: candidate.y } };
  });

  const nodeByRef = new Map((draft.nodes ?? []).map(node => [nodeKey(node), node]));
  draft.edges = (draft.edges ?? []).map(edge => {
    const previous = baseEdges.get(edgeKey(edge));
    if (previous?.ui && edge.ui == null) {
      return { ...edge, ui: structuredClone(previous.ui) };
    }
    if (edge.ui != null) return edge;
    const fromNode = nodeByRef.get(edge.from);
    const toNode = nodeByRef.get(edge.to);
    const fromRect = fromNode ? nodeRect(fromNode) : null;
    const toRect = toNode ? nodeRect(toNode) : null;
    if (!fromRect || !toRect) return edge;
    const route = pickAutoEdgeRoute(fromRect, toRect, {
      loop: edge.loop,
      selfLoop: edge.from === edge.to,
      fromPortCount: fromNode?.kind === 'task' || fromNode?.kind === 'return' ? 1 : 3,
      toPortCount: toNode?.kind === 'task' || toNode?.kind === 'return' ? 1 : 3,
    });
    return {
      ...edge,
      ui: {
        fromSide: route.fromSide,
        toSide: route.toSide,
        fromPort: route.fromPort,
        toPort: route.toPort,
        c1: route.curve.c1,
        c2: route.curve.c2,
      },
    };
  });
  return draft;
}

function normalizeProposalDefinition(
  definition: TeamDefinition,
  base: TeamDefinition | null,
): { draft: TeamDefinition; problems: string[] } {
  try {
    const migrated = migrateTeamDefinitionToGraph(structuredClone(definition));
    const problems = validateTeamGraph(migrated);
    if (problems.length) {
      return { draft: mergeTeamProposalLayout(base, migrated), problems };
    }
    const canonical = canonicalizeTeamDefinition(migrated);
    return { draft: mergeTeamProposalLayout(base, canonical), problems: [] };
  } catch (error) {
    return {
      draft: structuredClone(definition),
      problems: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export class TeamProposalStore {
  private readonly proposals = new Map<string, TeamGraphProposal>();

  stage(input: StageTeamProposalInput): TeamGraphProposal {
    const name = input.definition.name?.trim();
    if (!name) throw new Error('Team proposal requires a non-empty definition.name.');
    const existing = loadTeamDefinition(name, input.projectPath, input.homeDir);
    if (existing?.source === 'built-in') {
      throw new Error(
        `"${name}" is a built-in Team and cannot be overwritten. Propose a new Team name instead.`,
      );
    }
    const { draft, problems } = normalizeProposalDefinition(
      { ...input.definition, name },
      existing?.definition ?? null,
    );
    const proposal: TeamGraphProposal = {
      id: randomUUID(),
      assistantSessionId: input.assistantSessionId,
      projectPath: input.projectPath,
      teamName: name,
      baseFingerprint: existing ? teamDefinitionFingerprint(existing.definition) : null,
      baseSource: existing?.source ?? null,
      explanation: input.explanation?.trim() ?? '',
      problems,
      diff: diffTeamDefinitions(existing?.definition ?? null, draft),
      draft,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.proposals.set(proposal.id, proposal);
    return structuredClone(proposal);
  }

  get(id: string): TeamGraphProposal | null {
    const proposal = this.proposals.get(id);
    return proposal ? structuredClone(proposal) : null;
  }

  listForSession(assistantSessionId: string): TeamGraphProposal[] {
    return [...this.proposals.values()]
      .filter(item => item.assistantSessionId === assistantSessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(item => structuredClone(item));
  }

  reject(id: string): TeamGraphProposal {
    const proposal = this.requirePending(id);
    proposal.status = 'rejected';
    return structuredClone(proposal);
  }

  async apply(id: string, homeDir?: string): Promise<ApplyTeamProposalResult> {
    const proposal = this.requirePending(id);
    if (proposal.problems.length) {
      throw new Error(`Team proposal is invalid: ${proposal.problems.join('; ')}`);
    }
    const current = loadTeamDefinition(proposal.teamName, proposal.projectPath, homeDir);
    if (current?.source === 'built-in') {
      throw new Error(
        `"${proposal.teamName}" is a built-in Team and cannot be overwritten. Propose a new name.`,
      );
    }
    const currentFingerprint = current ? teamDefinitionFingerprint(current.definition) : null;
    if (currentFingerprint !== proposal.baseFingerprint) {
      proposal.status = 'conflict';
      throw new TeamProposalConflictError(
        `Team "${proposal.teamName}" changed after this proposal was created. Generate a fresh proposal before applying.`,
      );
    }
    const validated = canonicalizeTeamDefinition(proposal.draft);
    const filePath = await saveTeamDefinition(validated, {
      projectDir: proposal.projectPath,
      homeDir,
      overwrite: current != null,
    });
    proposal.status = 'applied';
    proposal.appliedAt = new Date().toISOString();
    return { proposal: structuredClone(proposal), filePath };
  }

  private requirePending(id: string): TeamGraphProposal {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`Unknown Team proposal: ${id}`);
    if (proposal.status !== 'pending') {
      throw new Error(`Team proposal ${id} is already ${proposal.status}.`);
    }
    return proposal;
  }
}
