import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  configureCompatDiagnostics,
  getCompatDiagnostics,
  recordCompatUsage,
  resetCompatDiagnostics,
} from '../src/compat/diagnostics.js';

afterEach(() => resetCompatDiagnostics());

describe('compatibility diagnostics', () => {
  it('collects process-local migration counts without external I/O', () => {
    const listener = vi.fn();
    configureCompatDiagnostics({ onDiagnostic: listener });
    recordCompatUsage('createAgentSdk');
    recordCompatUsage('createAgentSdk');

    expect(getCompatDiagnostics()).toMatchObject([{
      symbol: 'createAgentSdk', count: 2,
    }]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('can be disabled for hosts that require zero telemetry', () => {
    configureCompatDiagnostics({ enabled: false });
    recordCompatUsage('createAgentSdk');
    expect(getCompatDiagnostics()).toEqual([]);
  });
});
