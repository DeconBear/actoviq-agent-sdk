/**
 * Team Run tree view — pure state + text formatting shared by GUI, TUI, and REPL.
 *
 * Plan: TEAM_GRAPH_ORCHESTRATION_05Jul2026.md §3.6 / Phase 5.
 * One event source (`TeamEvent`); legacy panel/reviewer runs have no edges and
 * render as a flat roster; graph runs nest children under fired edges.
 */
import type { TeamEvent, TeamGraphChannel, TeamGraphReturnMode, TeamGraphTrigger } from '../types.js';

export type TeamRunMemberStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface TeamRunMemberView {
  id: string;
  model?: string;
  role?: string;
  status: TeamRunMemberStatus;
  currentTool?: string;
  error?: string;
  toolCalls?: number;
  durationMs?: number;
}

export interface TeamRunEdgeView {
  from: string;
  to: string;
  trigger: TeamGraphTrigger;
  channel: TeamGraphChannel;
}

export interface TeamRunViewState {
  label?: string;
  mode?: string;
  round: number;
  members: TeamRunMemberView[];
  edges: TeamRunEdgeView[];
  returnNodeId?: string;
  returnMode?: TeamGraphReturnMode;
  returnValue?: string;
  incompleteReason?: string;
  completed: boolean;
}

export interface FormatTeamRunTreeOptions {
  /** Prefix each line (e.g. TUI dim escape). */
  prefix?: string;
  /** Max meta column width before truncation. */
  metaWidth?: number;
}

export function createTeamRunViewState(label?: string): TeamRunViewState {
  return { label, round: 0, members: [], edges: [], completed: false };
}

function upsertMember(state: TeamRunViewState, id: string, patch: Partial<TeamRunMemberView>): void {
  let member = state.members.find((m) => m.id === id);
  if (!member) {
    member = { id, status: 'pending' };
    state.members.push(member);
  }
  Object.assign(member, patch);
}

function normalizeStatus(raw?: string): TeamRunMemberStatus {
  const st = (raw || 'pending').toLowerCase();
  if (st === 'running' || st === 'active') return 'running';
  if (st === 'done' || st === 'completed') return 'done';
  if (st === 'error') return 'error';
  if (st === 'skipped') return 'skipped';
  return 'pending';
}

/** Apply one TeamEvent to the run view (mirrors GUI `forwardTeamEvent` semantics). */
export function applyTeamRunEvent(state: TeamRunViewState, event: TeamEvent): TeamRunViewState {
  switch (event.type) {
    case 'team.started':
      state.mode = event.mode;
      state.round = 0;
      state.completed = false;
      state.incompleteReason = undefined;
      state.members = event.members.map((m) => ({
        id: m.id,
        model: m.model,
        role: m.role,
        status: 'pending',
      }));
      state.edges = [];
      break;
    case 'team.member.started':
      upsertMember(state, event.id, {
        model: event.model,
        role: event.role,
        status: 'running',
      });
      state.round = event.round;
      break;
    case 'team.member.tool':
      upsertMember(state, event.id, { status: 'running', currentTool: event.tool });
      break;
    case 'team.member.completed':
      upsertMember(state, event.id, {
        model: event.model,
        role: event.role,
        status: event.ok ? 'done' : 'error',
        error: event.error,
        toolCalls: event.toolCalls,
        durationMs: event.durationMs,
        currentTool: undefined,
      });
      break;
    case 'team.round.completed':
      state.round = event.round;
      break;
    case 'team.edge.triggered':
      state.edges.push({
        from: event.from,
        to: event.to,
        trigger: event.trigger,
        channel: event.channel,
      });
      break;
    case 'team.returned':
      state.returnNodeId = event.nodeId;
      state.returnMode = event.returnMode;
      state.returnValue = event.returnValue;
      break;
    case 'team.completed':
      state.completed = true;
      state.incompleteReason = event.incompleteReason;
      break;
    default:
      break;
  }
  return state;
}

function statusGlyph(status: TeamRunMemberStatus): string {
  switch (status) {
    case 'running': return '●';
    case 'done': return '✓';
    case 'error': return '✗';
    case 'skipped': return '○';
    default: return '○';
  }
}

function memberLabel(member: TeamRunMemberView): string {
  return (member.role || member.id).trim() || member.id;
}

function memberMeta(member: TeamRunMemberView, metaWidth: number): string {
  if (member.status === 'running') return member.currentTool || 'running';
  if (member.status === 'error') return (member.error || 'error').slice(0, metaWidth);
  if (member.status === 'done') {
    const bits: string[] = [];
    if (member.toolCalls != null) bits.push(`${member.toolCalls} tools`);
    if (member.durationMs != null) bits.push(`${Math.round(member.durationMs / 1000)}s`);
    return bits.join(' · ');
  }
  if (member.status === 'skipped') return 'skipped';
  return 'pending';
}

/**
 * Render the Team Run tree as plain-text lines (TUI/REPL). Returns an empty
 * array when there are no members (caller should hide the section).
 */
export function formatTeamRunTreeLines(
  state: TeamRunViewState,
  options: FormatTeamRunTreeOptions = {},
): string[] {
  const prefix = options.prefix ?? '';
  const metaWidth = options.metaWidth ?? 48;
  if (!state.members.length) return [];

  const lines: string[] = [];
  const head = [
    'Team run',
    state.label ? `· ${state.label}` : '',
    state.mode ? `· ${state.mode}` : '',
    state.completed ? '' : '· running',
  ].filter(Boolean).join(' ');
  lines.push(`${prefix}${head}`);

  const byId = new Map(state.members.map((m) => [m.id, m]));
  const placed = new Set<string>();
  const children = new Map<string, TeamRunEdgeView[]>();
  for (const edge of state.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    if (placed.has(edge.to)) continue;
    placed.add(edge.to);
    const list = children.get(edge.from) ?? [];
    list.push(edge);
    children.set(edge.from, list);
  }

  const rendered = new Set<string>();
  const renderNode = (id: string, depth: number, edge?: TeamRunEdgeView): void => {
    if (rendered.has(id)) return;
    rendered.add(id);
    const member = byId.get(id) ?? { id, status: 'pending' as const };
    const indent = '  '.repeat(depth);
    const branch = depth > 0 ? '↳ ' : '';
    const channel = edge && edge.channel !== 'message' ? ` · ${edge.channel}` : '';
    const meta = memberMeta(member, metaWidth);
    const metaSuffix = meta ? `  ${meta}` : '';
    lines.push(
      `${prefix}${indent}${statusGlyph(member.status)} ${branch}${memberLabel(member)}${channel}${metaSuffix}`,
    );
    for (const child of children.get(id) ?? []) renderNode(child.to, depth + 1, child);
  };

  for (const member of state.members) {
    if (!placed.has(member.id)) renderNode(member.id, 0);
  }
  for (const member of state.members) renderNode(member.id, 0);

  if (state.incompleteReason) {
    lines.push(`${prefix}! ${state.incompleteReason}`);
  }
  if (state.returnNodeId) {
    const mode = state.returnMode === 'payload' ? 'payload' : 'void';
    lines.push(`${prefix}↩ return · ${state.returnNodeId} (${mode})`);
  }
  return lines;
}

/** Build view state from a member-status snapshot (e.g. GUI `/api/state` runs). */
export function teamRunViewFromSnapshot(snapshot: {
  label?: string;
  team?: {
    mode?: string;
    round?: number;
    members?: Array<{ id: string; model?: string; role?: string; status?: string; currentTool?: string; error?: string; toolCalls?: number; durationMs?: number }>;
    edges?: Array<{ from: string; to: string; trigger?: string; channel?: string }>;
    incompleteReason?: string;
  };
  status?: string;
}): TeamRunViewState {
  const team = snapshot.team;
  if (!team?.members?.length) return createTeamRunViewState(snapshot.label);
  return {
    label: snapshot.label,
    mode: team.mode,
    round: team.round ?? 0,
    completed: snapshot.status !== 'running',
    incompleteReason: team.incompleteReason,
    members: team.members.map((m) => ({
      id: m.id,
      model: m.model,
      role: m.role,
      status: normalizeStatus(m.status),
      currentTool: m.currentTool,
      error: m.error,
      toolCalls: m.toolCalls,
      durationMs: m.durationMs,
    })),
    edges: (team.edges ?? []).map((e) => ({
      from: e.from,
      to: e.to,
      trigger: (e.trigger ?? 'on_complete') as TeamGraphTrigger,
      channel: (e.channel ?? 'message') as TeamGraphChannel,
    })),
  };
}
