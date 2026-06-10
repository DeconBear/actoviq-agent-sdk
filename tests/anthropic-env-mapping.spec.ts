import { describe, expect, it } from 'vitest';

import { mapActoviqEnvToAnthropicEnv } from '../src/index.js';

describe('mapActoviqEnvToAnthropicEnv', () => {
  it('derives ANTHROPIC_* variables from Actoviq settings env keys', () => {
    const mapped = mapActoviqEnvToAnthropicEnv({
      ACTOVIQ_AUTH_TOKEN: 'token-1',
      ACTOVIQ_BASE_URL: 'https://example.test/anthropic',
      ACTOVIQ_DEFAULT_medium_MODEL: 'medium-model',
      ACTOVIQ_DEFAULT_max_MODEL: 'max-model',
      ACTOVIQ_DEFAULT_min_MODEL: 'min-model',
    });

    expect(mapped).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'token-1',
      ANTHROPIC_BASE_URL: 'https://example.test/anthropic',
      ANTHROPIC_DEFAULT_medium_MODEL: 'medium-model',
      ANTHROPIC_DEFAULT_max_MODEL: 'max-model',
      ANTHROPIC_DEFAULT_min_MODEL: 'min-model',
      ANTHROPIC_SMALL_FAST_MODEL: 'min-model',
    });
  });

  it('keeps explicit ANTHROPIC_* values from the source env', () => {
    const mapped = mapActoviqEnvToAnthropicEnv({
      ACTOVIQ_AUTH_TOKEN: 'actoviq-token',
      ANTHROPIC_AUTH_TOKEN: 'explicit-token',
      ACTOVIQ_DEFAULT_min_MODEL: 'min-model',
      ANTHROPIC_SMALL_FAST_MODEL: 'explicit-fast-model',
    });

    // Explicit ANTHROPIC_AUTH_TOKEN and ANTHROPIC_SMALL_FAST_MODEL win; the
    // min alias key itself is still derived because it was not set explicitly.
    expect(mapped).toEqual({
      ANTHROPIC_DEFAULT_min_MODEL: 'min-model',
    });
  });

  it('ignores missing and empty values', () => {
    expect(mapActoviqEnvToAnthropicEnv({})).toEqual({});
    expect(mapActoviqEnvToAnthropicEnv({ ACTOVIQ_AUTH_TOKEN: '' })).toEqual({});
  });
});
