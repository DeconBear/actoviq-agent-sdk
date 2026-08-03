import { describe, expect, it } from 'vitest';

import {
  parseHadamardSessionMemoryExtractionOutput,
  redactMemorySecrets,
} from '../src/index.js';

describe('Session Memory structured extraction', () => {
  const existing = '# Session Title\n_guide_\n\nExisting note';

  it('preserves the previous note for no-output responses', () => {
    expect(parseHadamardSessionMemoryExtractionOutput(
      '{"noOutput":true,"content":""}',
      existing,
    )).toEqual({ noOutput: true, content: existing });
  });

  it('removes JSON fences and redacts secrets before runtime persistence', () => {
    const parsed = parseHadamardSessionMemoryExtractionOutput(
      '```json\n{"noOutput":false,"content":"# Session Title\\n_guide_\\n\\napi_key=secret-value"}\n```',
      existing,
    );
    expect(parsed.noOutput).toBe(false);
    expect(parsed.content).toContain('api_key=[REDACTED_SECRET]');
    expect(parsed.content).not.toContain('secret-value');
  });

  it('redacts common provider credentials', () => {
    expect(redactMemorySecrets('sk-abcdefghijklmnop ghp_abcdefghijklmnopqrst'))
      .toBe('[REDACTED_SECRET] [REDACTED_SECRET]');
  });
});
