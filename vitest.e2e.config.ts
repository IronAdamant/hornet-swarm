import { defineConfig } from 'vitest/config';
import { guardChildProcesses, OFFLINE_NETWORK_GUARD } from './test/support/offline-network-env.ts';

guardChildProcesses();

export default defineConfig({
  test: {
    setupFiles: [OFFLINE_NETWORK_GUARD],
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
