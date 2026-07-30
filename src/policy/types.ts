export type PolicyScope = 'host' | 'user' | 'project' | 'session';

export interface PolicyRule {
  id: string;
  effect: 'allow' | 'deny' | 'ask';
  tool?: string;
  pathPattern?: string;
  reason?: string;
}

export interface PolicyDocument {
  version: 1;
  revision: number;
  scope: PolicyScope;
  settings: Record<string, unknown>;
  rules: PolicyRule[];
  lockedSettings?: string[];
  updatedAt: string;
}

export interface ResolvedPolicy {
  settings: Record<string, unknown>;
  rules: PolicyRule[];
  lockedSettings: string[];
  sources: PolicyScope[];
}
