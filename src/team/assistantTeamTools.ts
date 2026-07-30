import path from 'node:path';
import { z } from 'zod';

import { readWorkspaceRegistry } from '../gui/workspaceRegistry.js';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition, TeamDefinition } from '../types.js';
import { listTeamDefinitions, loadTeamDefinition } from './teamDefinitions.js';
import {
  TeamProposalStore,
  type TeamGraphProposal,
} from './teamProposalService.js';

export type AssistantTeamToolScope = 'global' | 'project';

export interface AssistantTeamToolHost {
  scope: AssistantTeamToolScope;
  assistantSessionId: string;
  currentWorkDir: string;
  homeDir: string;
  proposals: TeamProposalStore;
  onProposal?: (proposal: TeamGraphProposal) => void;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function resolveProjectPath(
  host: AssistantTeamToolHost,
  requested?: string,
): Promise<string> {
  if (host.scope === 'project') {
    if (requested && !samePath(requested, host.currentWorkDir)) {
      throw new Error('Project Manager Team tools are restricted to the current project.');
    }
    return path.resolve(host.currentWorkDir);
  }
  if (!requested?.trim()) {
    throw new Error('Global Assistant Team tools require an explicit projectPath from ListProjects.');
  }
  const resolved = path.resolve(requested);
  const registry = await readWorkspaceRegistry(host.homeDir);
  const registered = [
    host.currentWorkDir,
    ...registry.map(project => project.path),
  ].some(projectPath => samePath(projectPath, resolved));
  if (!registered) {
    throw new Error(
      `Unknown project path: ${resolved}. Use ListProjects and pass a registered workspace path.`,
    );
  }
  return resolved;
}

export function buildAssistantTeamSystemPrompt(scope: AssistantTeamToolScope): string {
  const projectRule = scope === 'global'
    ? 'Always pass an explicit registered projectPath obtained from ListProjects.'
    : 'Team tools are fixed to the current project; never target another project.';
  return [
    '',
    'Team Graph proposals:',
    `- ${projectRule}`,
    '- Use ListTeams and GetTeamGraph before changing an existing Team.',
    '- Call ProposeTeamGraph with a complete graph-v3 TeamDefinition JSON and a concise explanation.',
    '- ProposeTeamGraph only stages a draft. It never writes a Team file.',
    '- Tell the user to inspect the structured Proposal card and use Preview or Apply.',
    '- Never claim that a Team was saved until the user explicitly applies the proposal.',
    '- Built-in Teams are immutable; create a new name when adapting one.',
  ].join('\n');
}

export function createAssistantTeamTools(
  host: AssistantTeamToolHost,
): AgentToolDefinition[] {
  const projectPathSchema = host.scope === 'global'
    ? z.string().min(1).describe('Absolute registered project path from ListProjects')
    : z.string().optional().describe('Omit for Project Manager; it always uses the current project');

  const ListTeams = tool(
    {
      name: 'ListTeams',
      description: 'List Team definitions visible to the target project, including source and graph size.',
      inputSchema: z.strictObject({ projectPath: projectPathSchema }),
      isReadOnly: () => true,
    },
    async input => {
      const projectPath = await resolveProjectPath(host, input.projectPath);
      return {
        projectPath,
        teams: listTeamDefinitions(projectPath, host.homeDir).map(team => ({
          name: team.name,
          source: team.source,
          description: team.definition.description ?? '',
          nodeCount: team.definition.nodes?.length ?? 0,
          edgeCount: team.definition.edges?.length ?? 0,
        })),
      };
    },
  );

  const GetTeamGraph = tool(
    {
      name: 'GetTeamGraph',
      description: 'Read one complete Team graph before proposing a modification.',
      inputSchema: z.strictObject({
        projectPath: projectPathSchema,
        teamName: z.string().min(1),
      }),
      isReadOnly: () => true,
    },
    async input => {
      const projectPath = await resolveProjectPath(host, input.projectPath);
      const team = loadTeamDefinition(input.teamName, projectPath, host.homeDir);
      if (!team) throw new Error(`Unknown Team: ${input.teamName}`);
      return {
        projectPath,
        name: team.name,
        source: team.source,
        definition: team.definition,
      };
    },
  );

  const ProposeTeamGraph = tool(
    {
      name: 'ProposeTeamGraph',
      description: 'Stage a complete Team graph draft for user Preview/Apply. This tool never writes to disk.',
      inputSchema: z.strictObject({
        projectPath: projectPathSchema,
        definition: z.record(z.string(), z.unknown())
          .describe('Complete TeamDefinition JSON, preferably graph v3 with stable node ids'),
        explanation: z.string().default(''),
      }),
      isReadOnly: () => false,
      isDestructive: () => false,
    },
    async input => {
      const projectPath = await resolveProjectPath(host, input.projectPath);
      const proposal = host.proposals.stage({
        assistantSessionId: host.assistantSessionId,
        projectPath,
        definition: input.definition as unknown as TeamDefinition,
        explanation: input.explanation,
        homeDir: host.homeDir,
      });
      host.onProposal?.(proposal);
      return {
        kind: 'team.proposal',
        proposalId: proposal.id,
        projectPath: proposal.projectPath,
        teamName: proposal.teamName,
        explanation: proposal.explanation,
        problems: proposal.problems,
        diff: proposal.diff,
        status: proposal.status,
      };
    },
  );

  return [ListTeams, GetTeamGraph, ProposeTeamGraph];
}
