import type {
  ActoviqCanUseTool,
  ActoviqPermissionDecision,
  ActoviqPermissionMode,
  ActoviqPermissionRule,
  ActoviqToolApprover,
  ActoviqToolClassifier,
} from '../types.js';
import { nowIso } from './helpers.js';
import { checkSafety } from './safetyChecks.js';

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

  // ── Step 1: Deny rules (highest priority) ─────────────────────
  const denyRule = input.rules.find(
    (rule) => rule.behavior === 'deny' && matchesRule(rule, input.publicName, input.toolInput),
  );
  if (denyRule) {
    return {
      toolName: input.toolName,
      publicName: input.publicName,
      behavior: 'deny',
      reason: `Denied by permission rule ${denyRule.toolName}.`,
      source: 'rule',
      matchedRule: denyRule.toolName,
      timestamp,
    };
  }

  // ── Step 2: Tool-specific checkPermissions ────────────────────
  if (input.adapter?.checkPermissions) {
    const result = await input.adapter.checkPermissions({
      mode: input.mode,
      runId: input.runId,
      sessionId: input.sessionId,
    });
    if (result === 'deny') {
      return {
        toolName: input.toolName,
        publicName: input.publicName,
        behavior: 'deny',
        reason: `Tool ${input.publicName} denied via checkPermissions.`,
        source: 'mode',
        timestamp,
      };
    }
    if (result === 'allow') {
      return {
        toolName: input.toolName,
        publicName: input.publicName,
        behavior: 'allow',
        reason: `Tool ${input.publicName} allowed via checkPermissions.`,
        source: 'mode',
        timestamp,
      };
    }
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
  }

  // ── Step 3: Safety checks ─────────────────────────────────────
  const safetyResult = checkSafety({
    toolName: input.toolName,
    publicName: input.publicName,
    toolInput: input.toolInput,
    workDir: input.workDir,
  });
  if (safetyResult.blocked) {
    return {
      toolName: input.toolName,
      publicName: input.publicName,
      behavior: 'deny',
      reason: safetyResult.reason ?? 'Blocked by safety check.',
      source: 'mode',
      timestamp,
    };
  }

  // ── Step 4: Ask rules ─────────────────────────────────────────
  const askRule = input.rules.find(
    (rule) => rule.behavior === 'ask' && matchesRule(rule, input.publicName, input.toolInput),
  );
  if (askRule) {
    return resolveActoviqAskPermission(
      input,
      {
        toolName: input.toolName,
        publicName: input.publicName,
        behavior: 'deny',
        reason: `Tool ${input.publicName} requires approval before execution.`,
        source: 'rule',
        matchedRule: askRule.toolName,
        timestamp,
      },
      timestamp,
    );
  }

  // ── Step 5: Classifier ────────────────────────────────────────
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
      if (outcome.behavior === 'deny') {
        return {
          toolName: input.toolName,
          publicName: input.publicName,
          behavior: 'deny',
          reason: outcome.reason,
          source: 'classifier',
          timestamp,
        };
      }
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
      if (outcome.behavior === 'allow') {
        return {
          toolName: input.toolName,
          publicName: input.publicName,
          behavior: 'allow',
          reason: outcome.reason,
          source: 'classifier',
          timestamp,
        };
      }
    }
  }

  // ── Step 6: canUseTool callback ────────────────────────────────
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
      if (outcome.behavior === 'deny') {
        return {
          toolName: input.toolName,
          publicName: input.publicName,
          behavior: 'deny',
          reason: outcome.reason ?? `Denied by canUseTool.`,
          source: 'canUseTool',
          timestamp,
        };
      }
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
        behavior: 'allow',
        reason: outcome.reason ?? `Allowed by canUseTool.`,
        source: 'canUseTool',
        timestamp,
      };
    }
  }

  // ── Step 7: Always-allow rules ───────────────────────────────
  const allowRule = input.rules.find(
    (rule) => rule.behavior === 'allow' && matchesRule(rule, input.publicName, input.toolInput),
  );
  if (allowRule) {
    return {
      toolName: input.toolName,
      publicName: input.publicName,
      behavior: 'allow',
      reason: `Allowed by permission rule ${allowRule.toolName}.`,
      source: 'rule',
      matchedRule: allowRule.toolName,
      timestamp,
    };
  }

  // ── Step 8: Mode-based fallback ─────────────────────────────
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
