import { describe, expect, it } from 'vitest';

import { decideActoviqToolPermission } from '../src/runtime/actoviqPermissions.js';
import { createAskUserQuestionTool } from '../src/tools/askUserQuestion/AskUserQuestionTool.js';

describe('AskUserQuestion interactive approval', () => {
  it('declares requiresUserInteraction so bypass mode still asks', () => {
    const tool = createAskUserQuestionTool();
    expect(tool.requiresUserInteraction?.()).toBe(true);
    expect(tool.isReadOnly?.()).toBe(true);
  });

  it('passes updatedInput from the approver through the permission decision', async () => {
    const decision = await decideActoviqToolPermission({
      mode: 'bypassPermissions',
      rules: [],
      approver: async () => ({
        behavior: 'allow',
        reason: 'answered',
        updatedInput: {
          questions: [{ question: 'Pick?', header: 'Mode', options: [] }],
          answers: { Mode: 'A' },
        },
      }),
      adapter: {
        isReadOnly: () => true,
        requiresUserInteraction: () => true,
      },
      runId: 'run-1',
      workDir: process.cwd(),
      toolName: 'AskUserQuestion',
      publicName: 'AskUserQuestion',
      prompt: 'q',
      toolInput: {
        questions: [{ question: 'Pick?', header: 'Mode', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }],
      },
      iteration: 1,
    });

    expect(decision.behavior).toBe('allow');
    expect(decision.updatedInput).toEqual({
      questions: [{ question: 'Pick?', header: 'Mode', options: [] }],
      answers: { Mode: 'A' },
    });
  });
});
