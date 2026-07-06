/**
 * Shared team-member system prompt assembly — used by graph runtime and GUI preview.
 */
import type { TeamMember } from '../types.js';

/** Prepended to every graph agent node at runtime (see modelTeam.runGraphMode). */
export const TEAM_GRAPH_MEMBER_FRAMING = [
  'You are an agent node in a collaboration graph of specialist agents.',
  'Work the task you are given; upstream teammates\' outputs (when present) appear as',
  '"Input from <id>" sections — build on them instead of re-deriving their work.',
  'A failed upstream appears as a [FAILED …] marker: proceed with what you have and',
  'note the gap. Produce a focused, decision-useful report for your downstream teammates.',
  'If you have a NotifyTeammate tool, use it to hand off work or push findings to the',
  'listed teammates when your findings are ready for them.',
].join(' ');

/** Assignment block derived from member metadata (responsibility, scope, workspace, etc.). */
export function buildMemberAssignmentPrompt(member: TeamMember): string {
  const lines: string[] = [];
  if (member.responsibility) lines.push(`Responsibility: ${member.responsibility}`);
  if (member.dependsOn?.length) lines.push(`Coordinate after: ${member.dependsOn.join(', ')}`);
  if (member.reviews?.length) lines.push(`Review these teammates' work: ${member.reviews.join(', ')}`);
  if (member.toolScope?.length) lines.push(`Expected tool scope: ${member.toolScope.join(', ')}`);
  if (member.runtime) lines.push(`Preferred runtime: ${member.runtime}`);
  if (member.workspaceAccess === 'full') lines.push('Workspace access: full filesystem');
  else if (member.workspaceAccess === 'workspace') lines.push('Workspace access: project workspace only');
  return lines.length ? ['## Team assignment', ...lines].join('\n') : '';
}

/** Full system prompt sent to a graph agent member (framing + assignment + specialist prompt). */
export function buildMemberSystemPrompt(base: string, member: TeamMember): string {
  return [base, buildMemberAssignmentPrompt(member), member.systemPrompt].filter(Boolean).join('\n\n');
}

/** Default graph-agent system prompt (framing + node fields + stored specialist prompt). */
export function resolveGraphNodeSystemPrompt(
  node: TeamMember,
  options?: { framing?: string; reviewerContext?: string },
): string {
  const framing = options?.framing ?? TEAM_GRAPH_MEMBER_FRAMING;
  let prompt = buildMemberSystemPrompt(framing, node);
  const ctx = options?.reviewerContext?.trim();
  if (ctx) {
    prompt = `${prompt}\n\n## Context from the calling agent\n${ctx}`;
  }
  return prompt;
}
