import { z } from 'zod';

import type { AgentSession } from '../runtime/agentSession.js';
import type { ActoviqAgentClient } from '../runtime/agentClient.js';
import { tool } from '../runtime/tools.js';
import type {
  ActoviqPermissionMode,
  AgentEvent,
  AgentRunOptions,
  AgentRunResult,
  AgentToolDefinition,
} from '../types.js';
import { agentProfileRunOverrides, resolveSelectableAgentRun } from '../config/agentProfiles.js';
import {
  buildDecomposeIssuePrompt,
  buildManagerSystemPrompt,
  createManagerTools,
  readManagerConfig,
  readProgressFile,
  readProjectPlanFile,
} from '../manager/projectManager.js';
import {
  addIssueComment,
  listProjectIssues,
  transitionProjectIssue,
  updateProjectIssue,
  type IssueStorageMode,
  type ProjectIssue,
} from './issueStore.js';

export interface ExecuteProjectIssueOptions {
  sdk: ActoviqAgentClient;
  managerSession: AgentSession;
  workDir: string;
  homeDir: string;
  storageMode: IssueStorageMode;
  issue: ProjectIssue;
  agentProfile?: string;
  defaultModel?: string;
  permissionMode?: ActoviqPermissionMode;
  systemPrompt?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface ExecuteProjectIssueResult {
  issue: ProjectIssue;
  session: AgentSession;
  brief: string;
  result: AgentRunResult;
  reported: boolean;
}

export function createIssueReportTool(options: {
  workDir: string;
  homeDir: string;
  storageMode: IssueStorageMode;
  issueId: string;
  onReported?: (issue: ProjectIssue) => void;
}): AgentToolDefinition {
  return tool(
    {
      name: 'IssueReport',
      description: 'Report an issue as ready for review or blocked, with evidence.',
      inputSchema: z.strictObject({
        status: z.enum(['in_review', 'blocked']),
        summary: z.string().min(1),
        followUps: z.array(z.string()).optional(),
      }),
      isReadOnly: () => false,
      isDestructive: () => false,
    },
    async (input) => {
      const followUps = input.followUps?.length
        ? `\nFollow-ups:\n${input.followUps.map(item => `- ${item}`).join('\n')}`
        : '';
      await addIssueComment(
        options.workDir,
        options.homeDir,
        options.issueId,
        {
          actor: 'agent',
          kind: 'progress',
          body: `${input.summary}${followUps}`,
        },
        options.storageMode,
      );
      const issue = await transitionProjectIssue(
        options.workDir,
        options.homeDir,
        options.issueId,
        input.status,
        'agent',
        options.storageMode,
      );
      if (!issue) {
        throw new Error(`Issue not found: ${options.issueId}`);
      }
      options.onReported?.(issue);
      return {
        status: issue.status,
        issueId: issue.id,
        issueNumber: issue.number,
      };
    },
  );
}

export async function executeProjectIssue(
  options: ExecuteProjectIssueOptions,
): Promise<ExecuteProjectIssueResult> {
  let issue = options.issue;
  if (issue.status !== 'todo' && issue.status !== 'backlog') {
    throw new Error(`Issue must be todo or backlog before dispatch; current status is ${issue.status}.`);
  }

  const managerConfig = await readManagerConfig(options.workDir, options.homeDir);
  const managerTools = await createManagerTools({
    workDir: options.workDir,
    homeDir: options.homeDir,
    config: managerConfig,
    issueStorageMode: options.storageMode,
  });
  const [plan, progress] = await Promise.all([
    readProjectPlanFile(options.workDir, options.homeDir),
    readProgressFile(options.workDir, options.homeDir),
  ]);
  const briefPrompt = buildDecomposeIssuePrompt(issue, {
    currentPlanJson: JSON.stringify(plan, null, 2),
    currentProgress: progress ?? undefined,
  });
  const managerRunOptions = {
    systemPrompt: buildManagerSystemPrompt(options.workDir, managerConfig),
    tools: managerTools,
    signal: options.signal,
    model: managerConfig.model ?? options.defaultModel,
    __actoviqUseDefaultTools: false,
    __actoviqAllowedTools: managerTools.map(tool => tool.name),
  } as AgentRunOptions;
  const managerStream = options.managerSession.stream(briefPrompt, managerRunOptions);
  for await (const event of managerStream) {
    options.onEvent?.(event);
  }
  const managerResult = await managerStream.result;
  const brief = managerResult.text.trim() || [
    `# ${issue.title}`,
    issue.description,
    ...issue.acceptanceCriteria.map(criterion => `- ${criterion}`),
  ].filter(Boolean).join('\n\n');

  const profileName = options.agentProfile?.trim() || issue.agentConfig;
  const profile = profileName
    ? await resolveSelectableAgentRun(profileName, options.homeDir)
    : undefined;
  const model = profile?.model ?? options.defaultModel;
  const permissionMode = profile?.profile.permissionMode ?? options.permissionMode;
  const workerSession = await options.sdk.createSession({
    title: `ISS-${issue.number} ${issue.title}`.slice(0, 120),
    ...(model ? { model } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    metadata: {
      __actoviqIssueId: issue.id,
      __actoviqIssueNumber: issue.number,
      __actoviqIssueKey: `ISS-${issue.number}`,
      __actoviqAgentProfile: profileName ?? null,
      __actoviqRuntime: profile?.bridgeConfig.runtime ?? 'hadamard',
      __actoviqConfigName: profile?.bridgeConfig.name ?? null,
    },
  });

  const sessionIds = [...new Set([...issue.sessionIds, workerSession.id])];
  issue = await updateProjectIssue(
    options.workDir,
    options.homeDir,
    issue.id,
    {
      brief,
      agentConfig: profileName ?? issue.agentConfig ?? null,
      sessionIds,
      activeSessionId: workerSession.id,
    },
    options.storageMode,
  ) ?? issue;
  if (issue.status === 'backlog') {
    issue = await transitionProjectIssue(
      options.workDir,
      options.homeDir,
      issue.id,
      'todo',
      'system',
      options.storageMode,
    ) ?? issue;
  }
  issue = await transitionProjectIssue(
    options.workDir,
    options.homeDir,
    issue.id,
    'in_progress',
    'system',
    options.storageMode,
  ) ?? issue;

  let reported = false;
  const reportTool = createIssueReportTool({
    workDir: options.workDir,
    homeDir: options.homeDir,
    storageMode: options.storageMode,
    issueId: issue.id,
    onReported: next => {
      reported = true;
      issue = next;
    },
  });
  const workerPrompt = [
    brief,
    '',
    'Operational requirement: update the issue before ending this run.',
    'After completing all work and self-checks, call IssueReport with status="in_review".',
    'If blocked, call IssueReport with status="blocked" and explain the blocker.',
  ].join('\n');

  try {
    const workerStream = workerSession.stream(workerPrompt, {
      systemPrompt: [
        options.systemPrompt,
        `You are working on ISS-${issue.number}: ${issue.title}.`,
        profile?.profile.systemPromptAppend
          ? `Agent profile instructions:\n${profile.profile.systemPromptAppend}`
          : undefined,
      ].filter(Boolean).join('\n\n'),
      tools: [reportTool],
      ...(model ? { model } : {}),
      ...(profile?.modelApi ? { modelApi: profile.modelApi } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...agentProfileRunOverrides(profile?.profile),
      signal: options.signal,
    });
    for await (const event of workerStream) {
      options.onEvent?.(event);
    }
    const result = await workerStream.result;

    if (!reported) {
      await addIssueComment(
        options.workDir,
        options.homeDir,
        issue.id,
        {
          actor: 'system',
          kind: 'system',
          body: 'Worker session ended without IssueReport; Project Manager reconciliation started.',
        },
        options.storageMode,
      );
      const reconcilePrompt = [
        `Reconcile ISS-${issue.number}; its worker session ended without IssueReport.`,
        `Worker session: ${workerSession.id}`,
        `Worker final response:\n${result.text || '(no final text)'}`,
        'Use IssueGet, IssueUpdate, and IssueComment. Move to in_review only with completion evidence,',
        'to blocked for a concrete blocker, or back to todo when implementation remains.',
      ].join('\n\n');
      const reconcileStream = options.managerSession.stream(reconcilePrompt, managerRunOptions);
      for await (const event of reconcileStream) {
        options.onEvent?.(event);
      }
      await reconcileStream.result;
      const reconciled = (await listProjectIssues(
        options.workDir,
        options.homeDir,
        options.storageMode,
      )).find(candidate => candidate.id === issue.id);
      if (reconciled?.status === 'in_progress') {
        await addIssueComment(
          options.workDir,
          options.homeDir,
          issue.id,
          {
            actor: 'system',
            kind: 'system',
            body: 'Manager reconciliation ended without settling the issue; reset to todo for safe redispatch.',
          },
          options.storageMode,
        );
        await transitionProjectIssue(
          options.workDir,
          options.homeDir,
          issue.id,
          'todo',
          'system',
          options.storageMode,
        );
      }
    }

    issue = (await listProjectIssues(
      options.workDir,
      options.homeDir,
      options.storageMode,
    )).find(candidate => candidate.id === issue.id) ?? issue;
    return { issue, session: workerSession, brief, result, reported };
  } catch (error) {
    if (!reported) {
      await addIssueComment(
        options.workDir,
        options.homeDir,
        issue.id,
        {
          actor: 'system',
          kind: 'system',
          body: `Issue dispatch failed or ended before reporting: ${(error as Error).message}`,
        },
        options.storageMode,
      ).catch(() => undefined);
      const latest = (await listProjectIssues(
        options.workDir,
        options.homeDir,
        options.storageMode,
      )).find(candidate => candidate.id === issue.id);
      if (latest?.status === 'in_progress') {
        await transitionProjectIssue(
          options.workDir,
          options.homeDir,
          issue.id,
          'todo',
          'system',
          options.storageMode,
        ).catch(() => undefined);
      }
    }
    throw error;
  }
}
