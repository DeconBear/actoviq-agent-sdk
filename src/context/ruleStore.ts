import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';
import type { ContextRule } from './ruleTypes.js';

export class RuleStore {
  constructor(private readonly filePath: string) {}

  async list(): Promise<ContextRule[]> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      return Array.isArray(value) ? value.filter(isContextRule) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async add(input: Pick<ContextRule, 'scope' | 'content' | 'pattern' | 'source'>): Promise<ContextRule> {
    if (!input.content.trim()) throw new Error('Rule content cannot be empty.');
    if (input.scope === 'path' && !input.pattern?.trim()) {
      throw new Error('Path-scoped rules require a pattern.');
    }
    const rules = await this.list();
    const now = new Date().toISOString();
    const rule: ContextRule = {
      id: randomUUID(),
      scope: input.scope,
      content: input.content.trim(),
      pattern: input.pattern?.trim(),
      enabled: true,
      source: input.source,
      createdAt: now,
      updatedAt: now,
    };
    rules.push(rule);
    await this.write(rules);
    return rule;
  }

  async remove(ruleId: string): Promise<boolean> {
    const rules = await this.list();
    const next = rules.filter(rule => rule.id !== ruleId);
    if (next.length === rules.length) return false;
    await this.write(next);
    return true;
  }

  async setEnabled(ruleId: string, enabled: boolean): Promise<ContextRule> {
    const rules = await this.list();
    const rule = rules.find(item => item.id === ruleId);
    if (!rule) throw new Error(`Rule not found: ${ruleId}`);
    rule.enabled = enabled;
    rule.updatedAt = new Date().toISOString();
    await this.write(rules);
    return rule;
  }

  private async write(rules: ContextRule[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJsonAtomic(this.filePath, rules);
  }
}

function isContextRule(value: unknown): value is ContextRule {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Partial<ContextRule>;
  return typeof rule.id === 'string'
    && (rule.scope === 'user' || rule.scope === 'project' || rule.scope === 'path')
    && typeof rule.content === 'string'
    && typeof rule.enabled === 'boolean'
    && typeof rule.source === 'string';
}
