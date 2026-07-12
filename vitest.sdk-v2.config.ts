import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 15_000,
    include: [
      'tests/core-*.spec.ts',
      'tests/provider-v2-*.spec.ts',
      'tests/agent-runtime-v2.spec.ts',
      'tests/middleware-v2.spec.ts',
      'tests/runtime-services-v2.spec.ts',
      'tests/runtime-tools-v2.spec.ts',
      'tests/runtime-session-v2.spec.ts',
      'tests/legacy-session-cutover.spec.ts',
      'tests/runtime-v2-boundaries.spec.ts',
      'tests/runtime-boundary-coverage.spec.ts',
      'tests/node-checkpoint-adapter.spec.ts',
      'tests/orchestration-v2.spec.ts',
      'tests/orchestration-coverage.spec.ts',
      'tests/profiles-v2.spec.ts',
      'tests/compat-provider-runtime.spec.ts',
      'tests/sdk-v2-coverage.spec.ts',
    ],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: [
        'src/core/**/*.ts',
        'src/runtime-v2/**/*.ts',
        'src/providers-v2/**/*.ts',
        'src/orchestration/**/*.ts',
      ],
      // The bidirectional 0.x ModelApi bridge is a compat façade with its own
      // migration suite; the stable v2 provider contract gate excludes it.
      exclude: ['src/providers-v2/legacy.ts'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage/sdk-v2',
      thresholds: {
        lines: 85,
        branches: 85,
      },
    },
  },
});
