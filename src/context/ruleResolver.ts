import type { ContextRule, ResolvedContextRules } from './ruleTypes.js';

export function resolveContextRules(
  rules: ContextRule[],
  touchedPaths: string[] = [],
): ResolvedContextRules {
  const normalizedPaths = touchedPaths.map(value => value.replace(/\\/gu, '/'));
  const selected = rules.filter(rule => {
    if (!rule.enabled) return false;
    if (rule.scope !== 'path') return true;
    return normalizedPaths.some(filePath => globMatches(rule.pattern ?? '', filePath));
  });
  selected.sort((left, right) => scopeWeight(left.scope) - scopeWeight(right.scope));
  return {
    rules: selected,
    prompt: selected.map(rule =>
      `<rule id="${rule.id}" scope="${rule.scope}" source="${rule.source}">\n${rule.content}\n</rule>`,
    ).join('\n\n'),
  };
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*\*/gu, '::DOUBLE_STAR::')
    .replace(/\*/gu, '[^/]*')
    .replace(/::DOUBLE_STAR::/gu, '.*');
  return new RegExp(`^${escaped}$`, 'u').test(value);
}

function scopeWeight(scope: ContextRule['scope']): number {
  return scope === 'user' ? 0 : scope === 'project' ? 1 : 2;
}
