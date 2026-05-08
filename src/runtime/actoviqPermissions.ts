import type {
  ActoviqCanUseTool,
  ActoviqPermissionDecision,
  ActoviqPermissionMode,
  ActoviqPermissionRule,
  ActoviqToolApprover,
  ActoviqToolClassifier,
} from '../types.js';
import { nowIso } from './helpers.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardToRegExp(pattern: string): RegExp {
  return new RegExp(
    `^${pattern.split('*').map(segment => escapeRegExp(segment)).join('.*')}$`,
    'i',
  );
}

function matchesRule(
  rule: ActoviqPermissionRule,
  publicName: string,
  input: unknown,
): boolean {
  if (!wildcardToRegExp(rule.toolName).test(publicName)) {
    return false;
  }
  if (!rule.matcher?.trim()) {
    return true;
  }
  return wildcardToRegExp(rule.matcher).test(JSON.stringify(input ?? {}));
}

export async function decideActoviqToolPermission(input: {
  mode: ActoviqPermissionMode;
  rules: ActoviqPermissionRule[];
  classifier?: ActoviqToolClassifier;
  approver?: ActoviqToolApprover;
  canUseTool?: ActoviqCanUseTool;
  adapter?: {
    isReadOnly?: (input?: unknown) => boolean;
    requiresUserInteraction?: () => boolean;
    checkPermissions?: (
      context: { mode: ActoviqPermissionMode; runId: string; sessionId?: string },
    ) => Promise<'allow' | 'deny' | 'ask' | void> | 'allow' | 'deny' | 'ask' | void;
  };
  runId: string;
  sessionId?: string;
  workDir: string;
  toolName: string;
  publicName: string;
  prompt: string;
  toolInput: unknown;
  iteration: number;
}): Promise<ActoviqPermissionDecision> {
  const timestamp = nowIso();

  // Step 0: canUseTool callback — fires before all rules and classifiers
  if (input.canUseTool) {
    const outcome = await input.canUseTool({
      runId: input.runId,
      sessionId: input.sessionId,
      workDir: input.workDir,
      toolName: input.toolName,
      publicName: input.publicName,
      input: input.toolInput,
      prompt: input.prompt,
      iteration: input.iteration,
    });
    if (outcome) {
      if (outcome.behavior === 'ask') {
        return resolveActoviqAskPermission(
          input,
          {
            toolName: input.toolName,
            publicName: input.publicName,
            behavior: 'deny',
            reason: outcome.reason ?? `Tool ${input.publicName} requires approval.`,
            source: 'canUseTool',
            timestamp,
          },
          timestamp,
        );
      }
      return {
        toolName: input.toolName,
        publicName: input.publicName,
        behavior: outcome.behavior === 'allow' ? 'allow' : 'deny',
        reason: outcome.reason ?? `Decision from canUseTool: ${outcome.behavior}.`,
        source: 'canUseTool',
        timestamp,
      };
    }
  }

  // Step 1: Per-tool checkPermissions — tool declares its own permission behavior
  if (input.adapter?.checkPermissions) {
    const result = await input.adapter.checkPermissions({
      mode: input.mode,
      runId: input.runId,
      sessionId: input.sessionId,
    });
    if (result === 'ask') {
      return resolveActoviqAskPermission(
        input,
        {
          toolName: input.toolName,
          publicName: input.publicName,
          behavior: 'deny',
          reason: `Tool ${input.publicName} requires approval via checkPermissions.`,
          source: 'mode',
          timestamp,
        },
        timestamp,
      );
    }
    if (result === 'allow' || result === 'deny') {
      return {
        toolName: input.toolName,
        publicName: input.publicName,
        behavior: result,
        reason: `Tool ${input.publicName} checkPermissions: ${result}.`,
        source: 'mode',
        timestamp,
      };
    }
  }

  const matchedRule = input.rules.find(rule =>
    matchesRule(rule, input.publicName, input.toolInput),
  );
  if (matchedRule) {
    if (matchedRule.behavior === 'ask') {
      return resolveActoviqAskPermission(
        input,
        {
          toolName: input.toolName,
          publicName: input.publicName,
          behavior: 'deny',
          reason: `Tool ${input.publicName} requires approval before execution.`,
          source: 'rule',
          matchedRule: matchedRule.toolName,
          timestamp,
        },
        timestamp,
      );
    }
    return {
      toolName: input.toolName,
      publicName: input.publicName,
      behavior: matchedRule.behavior === 'deny' ? 'deny' : 'allow',
      reason:
        matchedRule.behavior === 'allow'
          ? `Allowed by permission rule ${matchedRule.toolName}.`
          : `Denied by permission rule ${matchedRule.toolName}.`,
      source: 'rule',
      matchedRule: matchedRule.toolName,
      timestamp,
    };
  }

  if (input.classifier) {
    const outcome = await input.classifier({
      runId: input.runId,
      sessionId: input.sessionId,
      workDir: input.workDir,
      toolName: input.toolName,
      publicName: input.publicName,
      input: input.toolInput,
      prompt: input.prompt,
      iteration: input.iteration,
    });
    if (outcome) {
      if (outcome.behavior === 'ask') {
        return resolveActoviqAskPermission(
          input,
          {
            toolName: input.toolName,
            publicName: input.publicName,
            behavior: 'deny',
            reason: outcome.reason,
            source: 'classifier',
            timestamp,
          },
          timestamp,
        );
      }
      return {
        toolName: input.toolName,
        publicName: input.publicName,
        behavior: outcome.behavior === 'allow' ? 'allow' : 'deny',
        reason: outcome.reason,
        source: 'classifier',
        timestamp,
      };
    }
  }

  switch (input.mode) {
    case 'bypassPermissions':
      return {
        toolName: input.toolName,
        publicName: input.publicName,
        behavior: 'allow',
        reason: 'Bypass-permissions mode allows tool execution.',
        source: 'mode',
        timestamp,
      };
    case 'plan': {
      const readOnly = input.adapter?.isReadOnly?.(input.toolInput) ?? false;
      return {
        toolName: input.toolName,
        publicName: input.publicName,
        behavior: readOnly ? 'allow' : 'deny',
        reason: readOnly
          ? 'Plan mode allows read-only tool execution.'
          : 'Plan mode blocks mutating tools until the plan is approved.',
        source: 'mode',
        timestamp,
      };
    }
    case 'acceptEdits': {
      const classified = input.adapter?.isReadOnly !== undefined;
      return {
        toolName: input.toolName,
        publicName: input.publicName,
        behavior: classified ? 'allow' : 'deny',
        reason: classified
          ? 'acceptEdits mode allows classified tools.'
          : 'acceptEdits mode blocks unsupported high-risk tools.',
        source: 'mode',
        timestamp,
      };
    }
    case 'auto':
    case 'default':
    default:
      return {
        toolName: input.toolName,
        publicName: input.publicName,
        behavior: 'allow',
        reason: `${input.mode} mode allows tool execution by default.`,
        source: 'mode',
        timestamp,
      };
  }
}

async function resolveActoviqAskPermission(
  input: {
    mode: ActoviqPermissionMode;
    approver?: ActoviqToolApprover;
    runId: string;
    sessionId?: string;
    workDir: string;
    toolName: string;
    publicName: string;
    prompt: string;
    toolInput: unknown;
    iteration: number;
  },
  baseDecision: ActoviqPermissionDecision,
  timestamp: string,
): Promise<ActoviqPermissionDecision> {
  if (!input.approver) {
    return {
      ...baseDecision,
      behavior: 'deny',
      reason: `${baseDecision.reason} Approval is required, but interactive approval is unavailable in the clean SDK path.`,
      timestamp,
    };
  }

  const approval = await input.approver({
    runId: input.runId,
    sessionId: input.sessionId,
    workDir: input.workDir,
    toolName: input.toolName,
    publicName: input.publicName,
    input: input.toolInput,
    prompt: input.prompt,
    iteration: input.iteration,
    mode: input.mode,
    proposedBehavior: 'ask',
    reason: baseDecision.reason,
    source: baseDecision.source === 'rule' ? 'rule' : 'classifier',
    matchedRule: baseDecision.matchedRule,
  });

  return {
    toolName: baseDecision.toolName,
    publicName: baseDecision.publicName,
    behavior: approval?.behavior === 'allow' ? 'allow' : 'deny',
    reason:
      approval?.reason ??
      (approval?.behavior === 'allow'
        ? `Approved ${baseDecision.publicName} for execution.`
        : `${baseDecision.reason} Approval was denied.`),
    source: 'approver',
    matchedRule: baseDecision.matchedRule,
    timestamp,
  };
}
