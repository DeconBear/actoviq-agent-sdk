export type RuleScope = 'user' | 'project' | 'path';

export interface ContextRule {
  id: string;
  scope: RuleScope;
  content: string;
  pattern?: string;
  enabled: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedContextRules {
  rules: ContextRule[];
  prompt: string;
}
