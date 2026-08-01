import { describe, expect, it } from 'vitest';

import { shouldShowDefaultModelOnboarding } from '../src/gui/hadamardGui.js';

describe('default model onboarding gate', () => {
  it('opens only when settings model configuration and provider configs are both empty', () => {
    expect(shouldShowDefaultModelOnboarding({}, 0)).toBe(true);
    expect(shouldShowDefaultModelOnboarding({ env: {} }, 0)).toBe(true);
    expect(shouldShowDefaultModelOnboarding({ env: { HADAMARD_MODEL: 'model-a' } }, 0)).toBe(false);
    expect(shouldShowDefaultModelOnboarding({}, 1)).toBe(false);
    expect(shouldShowDefaultModelOnboarding({ env: { HADAMARD_MODEL: 'model-a' } }, 1)).toBe(false);
  });
});
