import type {
  ActoviqPermissionDecision,
  ActoviqPermissionMode,
  ActoviqPermissionRule,
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

export function isReadOnlyActoviqTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized.includes('read') ||
    normalized.includes('glob') ||
    normalized.includes('grep') ||
    normalized.includes('search') ||
    normalized.includes('list') ||
    normalized.includes('fetch') ||
    normalized.includes('get')
  );
}

export function isMutatingActoviqTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized.includes('write') ||
    normalized.includes('edit') ||
    normalized.includes('delete') ||
    normalized.includes('move') ||
    normalized.includes('rename') ||
    normalized.includes('bash') ||
    normalized.includes('powershell') ||
    normalized.includes('task') ||
    normalized.includes('computer_') ||
    normalized.includes('keypress') ||
    normalized.includes('type_text')
  );
}

export async function decideActoviqToolPermission(input: {
  mode: ActoviqPermissionMode;
  rules: ActoviqPermissionRule[];
  classifier?: ActoviqToolClassifier;
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
  const matchedRule = input.rules.find(rule =>
    matchesRule(rule, input.publicName, input.toolInput),
  );
  if (matchedRule) {
    return {
      toolName: input.toolName,
      publicName: input.publicName,
      behavior: matchedRule.behavior === 'deny' || matchedRule.behavior === 'ask' ? 'deny' : 'allow',
      reason:
        matchedRule.behavior === 'allow'
          ? `Allowed by permission rule ${matchedRule.toolName}.`
          : matchedRule.behavior === 'ask'
            ? `Tool ${input.publicName} requires approval, and the clean SDK is running non-interactively.`
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
      return {
        toolName: input.toolName,
        publicName: input.publicName,
        behavior: outcome.behavior === 'allow' ? 'allow' : 'deny',
        reason:
          outcome.behavior === 'ask'
            ? `${outcome.reason} Approval is required, but interactive permission prompts are unavailable in the clean SDK path.`
            : outcome.reason,
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
    case 'plan':
      return {
        toolName: input.toolName,
        publicName: input.publicName,
        behavior: isMutatingActoviqTool(input.publicName) ? 'deny' : 'allow',
        reason: isMutatingActoviqTool(input.publicName)
          ? 'Plan mode blocks mutating tools until the plan is approved.'
          : 'Plan mode allows read-only tool execution.',
        source: 'mode',
        timestamp,
      };
    case 'acceptEdits':
      return {
        toolName: input.toolName,
        publicName: input.publicName,
        behavior:
          isMutatingActoviqTool(input.publicName) || isReadOnlyActoviqTool(input.publicName)
            ? 'allow'
            : 'deny',
        reason:
          isMutatingActoviqTool(input.publicName) || isReadOnlyActoviqTool(input.publicName)
            ? 'acceptEdits mode allows standard file and shell tools.'
            : 'acceptEdits mode blocks unsupported high-risk tools.',
        source: 'mode',
        timestamp,
      };
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
