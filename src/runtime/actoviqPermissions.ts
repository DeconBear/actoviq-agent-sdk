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

const FILE_EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

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

interface PermissionInput {
  mode: ActoviqPermissionMode;
  rules: ActoviqPermissionRule[];
  classifier?: ActoviqToolClassifier;
  approver?: ActoviqToolApprover;
  canUseTool?: ActoviqCanUseTool;
  adapter?: {
    isReadOnly?: (input?: unknown) => boolean;
    isDestructive?: (input?: unknown) => boolean;
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
}

function decision(
  input: PermissionInput,
  behavior: 'allow' | 'deny',
  reason: string,
  source: ActoviqPermissionDecision['source'],
  timestamp: string,
  matchedRule?: string,
): ActoviqPermissionDecision {
  return {
    toolName: input.toolName,
    publicName: input.publicName,
    behavior,
    reason,
    source,
    matchedRule,
    timestamp,
  };
}

export async function decideActoviqToolPermission(
  input: PermissionInput,
): Promise<ActoviqPermissionDecision> {
  const timestamp = nowIso();

  const denyRule = input.rules.find(
    rule =>
      rule.behavior === 'deny' &&
      matchesRule(rule, input.publicName, input.toolInput),
  );
  if (denyRule) {
    return decision(
      input,
      'deny',
      `Denied by permission rule ${denyRule.toolName}.`,
      'rule',
      timestamp,
      denyRule.toolName,
    );
  }

  const safetyResult = checkSafety({
    toolName: input.toolName,
    publicName: input.publicName,
    toolInput: input.toolInput,
    workDir: input.workDir,
  });
  if (safetyResult.blocked) {
    return decision(
      input,
      'deny',
      safetyResult.reason ?? 'Blocked by safety check.',
      'mode',
      timestamp,
    );
  }

  if (input.adapter?.checkPermissions) {
    const toolDecision = await input.adapter.checkPermissions({
      mode: input.mode,
      runId: input.runId,
      sessionId: input.sessionId,
    });
    if (toolDecision === 'deny') {
      return decision(
        input,
        'deny',
        `Tool ${input.publicName} denied via checkPermissions.`,
        'mode',
        timestamp,
      );
    }
    if (toolDecision === 'allow') {
      return decision(
        input,
        'allow',
        `Tool ${input.publicName} allowed via checkPermissions.`,
        'mode',
        timestamp,
      );
    }
    if (toolDecision === 'ask') {
      return resolveActoviqAskPermission(
        input,
        decision(
          input,
          'deny',
          `Tool ${input.publicName} requires approval via checkPermissions.`,
          'mode',
          timestamp,
        ),
        timestamp,
      );
    }
  }

  const askRule = input.rules.find(
    rule =>
      rule.behavior === 'ask' &&
      matchesRule(rule, input.publicName, input.toolInput),
  );
  if (askRule) {
    return resolveActoviqAskPermission(
      input,
      decision(
        input,
        'deny',
        `Tool ${input.publicName} requires approval before execution.`,
        'rule',
        timestamp,
        askRule.toolName,
      ),
      timestamp,
    );
  }

  if (input.adapter?.requiresUserInteraction?.()) {
    return resolveActoviqAskPermission(
      input,
      decision(
        input,
        'deny',
        `Tool ${input.publicName} requires interactive approval.`,
        'mode',
        timestamp,
      ),
      timestamp,
    );
  }

  if (input.mode === 'bypassPermissions') {
    return decision(
      input,
      'allow',
      'Bypass-permissions mode allows tool execution.',
      'mode',
      timestamp,
    );
  }

  const allowRule = input.rules.find(
    rule =>
      rule.behavior === 'allow' &&
      matchesRule(rule, input.publicName, input.toolInput),
  );
  if (allowRule) {
    return decision(
      input,
      'allow',
      `Allowed by permission rule ${allowRule.toolName}.`,
      'rule',
      timestamp,
      allowRule.toolName,
    );
  }

  const readOnly = input.adapter?.isReadOnly?.(input.toolInput) ?? false;
  if (readOnly) {
    return decision(
      input,
      'allow',
      `${input.mode} mode allows read-only tool execution.`,
      'mode',
      timestamp,
    );
  }

  if (input.mode === 'acceptEdits' && FILE_EDIT_TOOLS.has(input.publicName)) {
    return decision(
      input,
      'allow',
      'acceptEdits mode allows workspace file edits.',
      'mode',
      timestamp,
    );
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
    if (outcome?.behavior === 'allow') {
      return decision(input, 'allow', outcome.reason, 'classifier', timestamp);
    }
    if (outcome?.behavior === 'deny') {
      return decision(input, 'deny', outcome.reason, 'classifier', timestamp);
    }
    if (outcome?.behavior === 'ask') {
      return resolveActoviqAskPermission(
        input,
        decision(input, 'deny', outcome.reason, 'classifier', timestamp),
        timestamp,
      );
    }
  }

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
    if (outcome?.behavior === 'allow') {
      return decision(
        input,
        'allow',
        outcome.reason ?? 'Allowed by canUseTool.',
        'canUseTool',
        timestamp,
      );
    }
    if (outcome?.behavior === 'deny') {
      return decision(
        input,
        'deny',
        outcome.reason ?? 'Denied by canUseTool.',
        'canUseTool',
        timestamp,
      );
    }
    if (outcome?.behavior === 'ask') {
      return resolveActoviqAskPermission(
        input,
        decision(
          input,
          'deny',
          outcome.reason ?? `Tool ${input.publicName} requires approval.`,
          'canUseTool',
          timestamp,
        ),
        timestamp,
      );
    }
  }

  const destructive =
    input.adapter?.isDestructive?.(input.toolInput) ??
    (input.adapter?.isReadOnly ? !readOnly : false);

  if (input.mode === 'plan' && destructive) {
    return decision(
      input,
      'deny',
      'Plan mode blocks mutating tools until the plan is approved.',
      'mode',
      timestamp,
    );
  }

  if (destructive) {
    if (!input.approver) {
      return decision(
        input,
        'deny',
        `${input.mode} mode requires approval for mutating tools, but no approver is available.`,
        'mode',
        timestamp,
      );
    }
    return resolveActoviqAskPermission(
      input,
      decision(
        input,
        'deny',
        `${input.mode} mode requires approval for mutating tools.`,
        'mode',
        timestamp,
      ),
      timestamp,
    );
  }

  if (input.mode !== 'plan' && input.adapter?.isReadOnly === undefined) {
    return decision(
      input,
      'allow',
      `${input.mode} mode allows tools that do not declare a mutation classification.`,
      'mode',
      timestamp,
    );
  }

  if (input.mode === 'plan') {
    return decision(
      input,
      'deny',
      'Plan mode blocks mutating tools until the plan is approved.',
      'mode',
      timestamp,
    );
  }

  if (!input.approver) {
    return decision(
      input,
      'allow',
      `${input.mode} mode allows unclassified tools when no interactive approver is configured.`,
      'mode',
      timestamp,
    );
  }

  return resolveActoviqAskPermission(
    input,
    decision(
      input,
      'deny',
      `${input.mode} mode requires approval for mutating or unclassified tools.`,
      'mode',
      timestamp,
    ),
    timestamp,
  );
}

async function resolveActoviqAskPermission(
  input: PermissionInput,
  baseDecision: ActoviqPermissionDecision,
  timestamp: string,
): Promise<ActoviqPermissionDecision> {
  if (!input.approver) {
    return {
      ...baseDecision,
      behavior: 'deny',
      reason: `${baseDecision.reason} Approval is required, but no approver is available.`,
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

  const resolved = decision(
    input,
    approval?.behavior === 'allow' ? 'allow' : 'deny',
    approval?.reason ??
      (approval?.behavior === 'allow'
        ? `Approved ${baseDecision.publicName} for execution.`
        : `${baseDecision.reason} Approval was denied.`),
    'approver',
    timestamp,
    baseDecision.matchedRule,
  );
  if (approval?.behavior === 'allow' && approval.updatedInput !== undefined) {
    resolved.updatedInput = approval.updatedInput;
  }
  return resolved;
}
