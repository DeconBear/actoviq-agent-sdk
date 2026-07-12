import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAgentSdk } from '../src/index.js';
import {
  ModelProviderLegacyAdapter,
  OpenAIResponsesProvider,
  type ProviderTransport,
  type ProviderTransportRequest,
} from '../src/providers-v2/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('compat façade with Provider v2', () => {
  it('runs the existing createAgentSdk API through the new provider adapter without output drift', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-compat-v2-'));
    roots.push(root);
    const transport: ProviderTransport = {
      async request(request: ProviderTransportRequest) {
        expect(request.providerId).toBe('openai-responses');
        return {
          id: 'resp_compat_e2e',
          object: 'response',
          status: 'completed',
          output: [{
            type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: 'compat ok' }],
          }],
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        };
      },
      async *stream() {
        throw new Error('not used');
      },
    };
    const provider = new OpenAIResponsesProvider({ transport });
    const sdk = await createAgentSdk({
      homeDir: root,
      workDir: root,
      sessionDirectory: path.join(root, 'sessions'),
      model: 'test-model',
      modelApi: new ModelProviderLegacyAdapter(provider),
      tools: [],
      mcpServers: [],
      disableDefaultAgents: true,
      loadDefaultAgentDirectories: false,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
      compact: { enabled: false },
    });

    try {
      const result = await sdk.run('hello', { systemPrompt: 'Answer briefly.' });
      expect(result).toMatchObject({
        text: 'compat ok',
        stopReason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 2 },
      });
    } finally {
      await sdk.close();
    }
  });
});
