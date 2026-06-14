import { describe, expect, it } from 'vitest';

import { mapActoviqEnvToAnthropicEnv } from '../src/index.js';

describe('mapActoviqEnvToAnthropicEnv', () => {
  it('derives ANTHROPIC_* variables from Actoviq settings env keys', () => {
    const mapped = mapActoviqEnvToAnthropicEnv({
      ACTOVIQ_AUTH_TOKEN: 'token-1',
      ACTOVIQ_BASE_URL: 'https://example.test/anthropic',
      ACTOVIQ_MODEL: 'balanced-model',
      ACTOVIQ_DEFAULT_MIN_MODEL: 'small-model',
    });

    expect(mapped).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'token-1',
      ANTHROPIC_BASE_URL: 'https://example.test/anthropic',
      ANTHROPIC_MODEL: 'balanced-model',
      ANTHROPIC_SMALL_FAST_MODEL: 'small-model',
    });
  });

  it('keeps explicit ANTHROPIC_* values from the source env', () => {
    const mapped = mapActoviqEnvToAnthropicEnv({
      ACTOVIQ_AUTH_TOKEN: 'actoviq-token',
      ANTHROPIC_AUTH_TOKEN: 'explicit-token',
      ACTOVIQ_DEFAULT_MIN_MODEL: 'small-model',
      ANTHROPIC_SMALL_FAST_MODEL: 'explicit-fast-model',
    });

    expect(mapped).toEqual({
      ANTHROPIC_MODEL: 'small-model',
    });
  });

  it('ignores missing and empty values', () => {
    expect(mapActoviqEnvToAnthropicEnv({})).toEqual({});
    expect(mapActoviqEnvToAnthropicEnv({ ACTOVIQ_AUTH_TOKEN: '' })).toEqual({});
  });

  it('resolves neutral model aliases before mapping provider environment variables', () => {
    expect(
      mapActoviqEnvToAnthropicEnv({
        ACTOVIQ_MODEL: 'medium',
        ACTOVIQ_DEFAULT_MIN_MODEL: 'small-model',
        ACTOVIQ_DEFAULT_MEDIUM_MODEL: 'balanced-model',
        ACTOVIQ_DEFAULT_MAX_MODEL: 'large-model',
      }),
    ).toEqual({
      ANTHROPIC_MODEL: 'balanced-model',
      ANTHROPIC_SMALL_FAST_MODEL: 'small-model',
    });
  });

  it('uses the configured neutral default tier when ACTOVIQ_MODEL is omitted', () => {
    expect(
      mapActoviqEnvToAnthropicEnv({
        ACTOVIQ_DEFAULT_MIN_MODEL: 'small-model',
        ACTOVIQ_DEFAULT_MAX_MODEL: 'large-model',
      }),
    ).toEqual({
      ANTHROPIC_MODEL: 'large-model',
      ANTHROPIC_SMALL_FAST_MODEL: 'small-model',
    });
  });
});
