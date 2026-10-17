import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');

describe('the runner image bundle', () => {
  it('is a module Node can parse, with one createRequire binding', () => {
    const script = readFileSync(join(root, 'scripts/build-image.sh'), 'utf8');
    const banner = /--banner:js="([^"]+)"/.exec(script)?.[1];
    expect(banner).toBeTruthy();
    const directory = mkdtempSync(join(tmpdir(), 'hornet-runner-bundle-'));
    const out = join(directory, 'main.js');
    try {
      execFileSync(
        'pnpm',
        [
          'exec',
          'esbuild',
          'packages/runner/src/main.ts',
          '--bundle',
          '--platform=node',
          '--format=esm',
          '--external:playwright',
          '--external:playwright-core',
          '--external:axe-core',
          `--banner:js=${banner}`,
          `--outfile=${out}`,
        ],
        { cwd: root },
      );
      execFileSync(process.execPath, ['--check', out]);
      const bundled = readFileSync(out, 'utf8');
      const bare = bundled.match(/import \{ createRequire \} from ['"]node:module['"]/g) ?? [];
      expect(bare).toHaveLength(1);
      expect(bundled).toContain('import { createRequire as __hornetCreateRequire }');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
