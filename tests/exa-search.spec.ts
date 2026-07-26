import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createExaSearchTool,
  resolveExaApiKey,
  runExaSearch,
} from '../src/tools/exaSearch.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EXA_API_KEY;
});

describe('Exa search tool', () => {
  it('resolves an explicit API key before the environment', async () => {
    process.env.EXA_API_KEY = 'env-key';
    expect(await resolveExaApiKey('explicit-key')).toBe('explicit-key');
  });

  it('formats successful Exa responses for the model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        requestId: 'req-1',
        resolvedSearchType: 'auto',
        results: [{
          title: 'Exa docs',
          url: 'https://exa.ai/docs',
          highlights: ['Neural search for LLMs'],
        }],
      }),
    })));

    const text = await runExaSearch({
      query: 'exa neural search',
      type: 'auto',
      num_results: 3,
      include_text: false,
      include_highlights: true,
    }, { apiKey: 'test-key' });

    expect(text).toContain('Query: "exa neural search"');
    expect(text).toContain('Exa docs');
    expect(text).toContain('https://exa.ai/docs');
    expect(text).toContain('Neural search for LLMs');
  });

  it('exposes a read-only ExaSearch tool', async () => {
    const tool = createExaSearchTool({ apiKey: 'test-key' });
    expect(tool.name).toBe('ExaSearch');
    expect(tool.isReadOnly?.({
      query: 'x',
      type: 'auto',
      num_results: 1,
      include_text: true,
      include_highlights: true,
    })).toBe(true);
  });
});
