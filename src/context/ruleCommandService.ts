import path from 'node:path';

import { RuleStore } from './ruleStore.js';

export interface RuleCommandResult {
  message: string;
  items?: Array<{ label: string; description?: string }>;
}

export class RuleCommandService {
  private readonly user: RuleStore;
  private readonly project: RuleStore;

  constructor(homeDir: string, workDir: string) {
    this.user = new RuleStore(path.join(homeDir, 'rules.json'));
    this.project = new RuleStore(path.join(workDir, '.actoviq', 'rules.json'));
  }

  async execute(input: string): Promise<RuleCommandResult> {
    const [action = 'list', ...rest] = input.trim().split(/\s+/);
    if (action === 'list') {
      const rules = [...await this.user.list(), ...await this.project.list()];
      return {
        message: `${rules.length} rule(s).`,
        items: rules.map(rule => ({
          label: `${rule.id} · ${rule.scope}${rule.enabled ? '' : ' · disabled'}`,
          description: `${rule.pattern ? `${rule.pattern} · ` : ''}${rule.content}`,
        })),
      };
    }
    if (action === 'add') {
      const scope = rest.shift();
      if (scope !== 'user' && scope !== 'project' && scope !== 'path') {
        throw new Error('Usage: /rules add user|project <content> | add path <pattern> <content>');
      }
      const pattern = scope === 'path' ? rest.shift() : undefined;
      const content = rest.join(' ').trim();
      const rule = await (scope === 'user' ? this.user : this.project).add({
        scope,
        pattern,
        content,
        source: 'interactive-command',
      });
      return { message: `Rule added: ${rule.id}.` };
    }
    const ruleId = rest[0];
    if (!ruleId) throw new Error(`Usage: /rules ${action} <rule-id>`);
    for (const store of [this.user, this.project]) {
      if (action === 'remove' && await store.remove(ruleId)) {
        return { message: `Rule removed: ${ruleId}.` };
      }
      if (action === 'enable' || action === 'disable') {
        if ((await store.list()).some(rule => rule.id === ruleId)) {
          await store.setEnabled(ruleId, action === 'enable');
          return { message: `Rule ${action}d: ${ruleId}.` };
        }
      }
    }
    throw new Error(`Rule not found: ${ruleId}`);
  }
}
