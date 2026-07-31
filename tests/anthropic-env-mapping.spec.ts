import { describe, expect, it } from 'vitest';

import { mapHadamardEnvToAnthropicEnv } from '../src/index.js';

describe('mapHadamardEnvToAnthropicEnv', () => {
  it('derives ANTHROPIC_* variables from Hadamard settings env keys', () => {
    const mapped = mapHadamardEnvToAnthropicEnv({
      HADAMARD_AUTH_TOKEN: 'token-1',
      HADAMARD_BASE_URL: 'https://example.test/anthropic',
      HADAMARD_MODEL: 'balanced-model',
      HADAMARD_DEFAULT_MIN_MODEL: 'small-model',
    });

    expect(mapped).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'token-1',
      ANTHROPIC_BASE_URL: 'https://example.test/anthropic',
      ANTHROPIC_MODEL: 'balanced-model',
      ANTHROPIC_SMALL_FAST_MODEL: 'small-model',
    });
  });

  it('keeps explicit ANTHROPIC_* values from the source env', () => {
    const mapped = mapHadamardEnvToAnthropicEnv({
      HADAMARD_AUTH_TOKEN: 'hadamard-token',
      ANTHROPIC_AUTH_TOKEN: 'explicit-token',
      HADAMARD_DEFAULT_MIN_MODEL: 'small-model',
      ANTHROPIC_SMALL_FAST_MODEL: 'explicit-fast-model',
    });

    expect(mapped).toEqual({
      ANTHROPIC_MODEL: 'small-model',
    });
  });

  it('ignores missing and empty values', () => {
    expect(mapHadamardEnvToAnthropicEnv({})).toEqual({});
    expect(mapHadamardEnvToAnthropicEnv({ HADAMARD_AUTH_TOKEN: '' })).toEqual({});
  });

  it('resolves neutral model aliases before mapping provider environment variables', () => {
    expect(
      mapHadamardEnvToAnthropicEnv({
        HADAMARD_MODEL: 'medium',
        HADAMARD_DEFAULT_MIN_MODEL: 'small-model',
        HADAMARD_DEFAULT_MEDIUM_MODEL: 'balanced-model',
        HADAMARD_DEFAULT_MAX_MODEL: 'large-model',
      }),
    ).toEqual({
      ANTHROPIC_MODEL: 'balanced-model',
      ANTHROPIC_SMALL_FAST_MODEL: 'small-model',
    });
  });

  it('uses the configured neutral default tier when HADAMARD_MODEL is omitted', () => {
    expect(
      mapHadamardEnvToAnthropicEnv({
        HADAMARD_DEFAULT_MIN_MODEL: 'small-model',
        HADAMARD_DEFAULT_MAX_MODEL: 'large-model',
      }),
    ).toEqual({
      ANTHROPIC_MODEL: 'large-model',
      ANTHROPIC_SMALL_FAST_MODEL: 'small-model',
    });
  });
});
