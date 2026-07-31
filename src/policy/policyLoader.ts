import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { PolicyDocument, PolicyScope } from './types.js';

export async function loadPolicyDocuments(options: {
  homeDir: string;
  workDir: string;
  explicit?: PolicyDocument[];
}): Promise<PolicyDocument[]> {
  const candidates: Array<{ filePath: string; scope: PolicyScope }> = [
    {
      filePath: process.env.HADAMARD_HOST_POLICY
        ? path.resolve(process.env.HADAMARD_HOST_POLICY)
        : path.join(options.homeDir, 'policy', 'host.json'),
      scope: 'host',
    },
    { filePath: path.join(options.homeDir, 'policy', 'user.json'), scope: 'user' },
    { filePath: path.join(options.workDir, '.hadamard', 'policy.json'), scope: 'project' },
  ];
  const loaded: PolicyDocument[] = [];
  for (const candidate of candidates) {
    try {
      loaded.push(parsePolicyDocument(
        JSON.parse(await readFile(candidate.filePath, 'utf8')),
        candidate.scope,
      ));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`Invalid ${candidate.scope} policy at ${candidate.filePath}: ${(error as Error).message}`);
    }
  }
  for (const document of options.explicit ?? []) {
    loaded.push(parsePolicyDocument(document, document.scope));
  }
  return loaded;
}

function parsePolicyDocument(value: unknown, expectedScope: PolicyScope): PolicyDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Policy must be an object.');
  }
  const record = value as Partial<PolicyDocument>;
  if (record.version !== 1 || record.scope !== expectedScope) {
    throw new Error(`Policy must use version 1 and scope "${expectedScope}".`);
  }
  if (!record.settings || typeof record.settings !== 'object' || Array.isArray(record.settings)) {
    throw new Error('Policy settings must be an object.');
  }
  if (!Array.isArray(record.rules)) throw new Error('Policy rules must be an array.');
  return {
    version: 1,
    scope: expectedScope,
    revision: Number.isSafeInteger(record.revision) && (record.revision ?? -1) >= 0
      ? record.revision!
      : 0,
    settings: structuredClone(record.settings),
    rules: record.rules.map((rule, index) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        throw new Error(`Policy rule ${index} must be an object.`);
      }
      const candidate = rule as PolicyDocument['rules'][number];
      if (
        typeof candidate.id !== 'string'
        || !['allow', 'deny', 'ask'].includes(candidate.effect)
      ) throw new Error(`Policy rule ${index} is invalid.`);
      return { ...candidate };
    }),
    ...(Array.isArray(record.lockedSettings)
      ? {
          lockedSettings: record.lockedSettings.filter(
            (item): item is string => typeof item === 'string' && item.length > 0,
          ),
        }
      : {}),
    updatedAt: typeof record.updatedAt === 'string'
      ? record.updatedAt
      : new Date(0).toISOString(),
  };
}
