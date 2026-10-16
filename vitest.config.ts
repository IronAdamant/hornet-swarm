import { defineConfig } from 'vitest/config';
import { guardChildProcesses, OFFLINE_NETWORK_GUARD } from './test/support/offline-network-env.ts';

guardChildProcesses();

export default defineConfig({
  test: {
    setupFiles: [OFFLINE_NETWORK_GUARD],
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/redactor.ts', 'packages/core/src/policy.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 90,
      },
    },
  },
});
