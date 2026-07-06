/**
 * Team member system prompt assembly — shared by graph runtime and GUI preview.
 */
import { describe, it, expect } from 'vitest';
import {
  TEAM_GRAPH_MEMBER_FRAMING,
  buildMemberAssignmentPrompt,
  buildMemberSystemPrompt,
  resolveGraphNodeSystemPrompt,
} from '../src/team/teamPrompts.js';

describe('teamPrompts', () => {
  it('buildMemberSystemPrompt composes framing, assignment, and specialist prompt', () => {
    const member = {
      model: 'm1',
      role: 'researcher',
      systemPrompt: 'Expert researcher. Investigate with read-only tools; cite sources.',
      responsibility: 'Gather evidence',
      workspaceAccess: 'workspace' as const,
    };
    const prompt = buildMemberSystemPrompt(TEAM_GRAPH_MEMBER_FRAMING, member);
    expect(prompt.startsWith(TEAM_GRAPH_MEMBER_FRAMING)).toBe(true);
    expect(prompt).toContain('## Team assignment');
    expect(prompt).toContain('Responsibility: Gather evidence');
    expect(prompt).toContain('Workspace access: project workspace only');
    expect(prompt).toContain(member.systemPrompt);
  });

  it('resolveGraphNodeSystemPrompt appends reviewer context when provided', () => {
    const member = { model: 'm1', role: 'reviewer', systemPrompt: 'Review carefully.' };
    const prompt = resolveGraphNodeSystemPrompt(member, { reviewerContext: 'Focus on auth.js' });
    expect(prompt).toContain('Review carefully.');
    expect(prompt).toContain('## Context from the calling agent');
    expect(prompt).toContain('Focus on auth.js');
  });

  it('buildMemberAssignmentPrompt omits empty assignment block', () => {
    expect(buildMemberAssignmentPrompt({ model: 'm1' })).toBe('');
  });
});

describe('built-in preset systemPrompt parity', () => {
  it('graph agent nodes carry legacy template specialist prompts', async () => {
    const { BUILT_IN_TEAM_DEFINITIONS } = await import('../src/team/teamDefinitions.js');
    const { graphNodeKind, graphNodeRef } = await import('../src/team/teamGraph.js');

    const legacyPrompts: Record<string, Record<string, string>> = {
      'panel-analysis': {
        researcher: 'Expert researcher. Investigate with read-only tools; cite sources.',
        skeptic: 'Rigorous skeptic. Verify with sources; challenge assumptions.',
        synthesizer: 'Synthesizer. Reconcile the panel findings into the best answer and decide when they suffice.',
      },
      analysis: {
        researcher: 'Expert researcher. Deep, source-grounded analysis.',
        skeptic: 'Rigorous skeptic. Verify with sources; challenge assumptions.',
      },
      reviewer: {
        reviewer: 'Meticulous reviewer. Surface only genuine, verifiable issues with file:line evidence; never speculate.',
      },
      'quick-review': {
        reviewer: 'Fast, focused reviewer for small changes. Check only what changed; report genuine, verifiable issues with file:line evidence. Be brief.',
      },
      'security-audit': {
        attacker: 'Offensive security analyst. Hunt for injection points, unsafe deserialization, path traversal, command execution, and secret leakage. Cite file:line for every finding.',
        auditor: 'Defensive security auditor. Review authentication, authorization, input validation at boundaries, and dependency risks. Only report verifiable issues with file:line evidence.',
        synthesizer: 'Security lead. Merge the findings, drop speculation, rank by severity, and decide when the audit is sufficient.',
      },
    };

    for (const [name, def] of Object.entries(BUILT_IN_TEAM_DEFINITIONS)) {
      const expected = legacyPrompts[name]!;
      for (const node of def.nodes ?? []) {
        if (graphNodeKind(node) !== 'agent') continue;
        const role = (node.role ?? node.name ?? graphNodeRef(node)).toLowerCase();
        const want = expected[role];
        expect(node.systemPrompt, `${name}:${role}`).toBe(want);
        const effective = resolveGraphNodeSystemPrompt({ ...node, model: node.model ?? '' });
        expect(effective, `${name}:${role}:effective`).toContain(want!);
        expect(effective, `${name}:${role}:framing`).toContain('collaboration graph');
      }
    }
  });
});
