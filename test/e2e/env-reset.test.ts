import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(root, 'packages/cli/dist/main.js');

describe('runner fleet', () => {
  it(
    'resets ten runners twice, each time in under 90 seconds',
    () => {
      for (let pass = 0; pass < 2; pass += 1) {
        const started = Date.now();
        const stdout = execFileSync(process.execPath, [cli, 'env', 'reset', '--project', 'm1', '--json'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 90_000,
        });
        const status = JSON.parse(stdout) as {
          healthy: number;
          expected: number;
          idempotent: boolean;
          durationMs: number;
        };
        expect(status.idempotent).toBe(true);
        expect(status.expected).toBe(10);
        expect(status.healthy).toBe(10);
        expect(status.durationMs).toBeLessThan(90_000);
        expect(Date.now() - started).toBeLessThan(90_000);
      }
      const after = JSON.parse(
        execFileSync(process.execPath, [cli, 'env', 'status', '--project', 'm1', '--json'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 30_000,
        }),
      ) as { healthy: number; expected: number };
      expect(after.healthy).toBe(10);
      expect(after.expected).toBe(10);
    },
    200_000,
  );
});
