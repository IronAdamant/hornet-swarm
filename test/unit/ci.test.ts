import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

describe('continuous integration', () => {
  it('runs build, lint, unit tests, and the redaction gate on Linux, and leaves end-to-end manual', () => {
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toMatch(/^on:\n {2}push:\n {2}pull_request:/m);
    expect(workflow).toContain('runs-on: ubuntu-latest');
    expect(workflow).toContain('pnpm build');
    expect(workflow).toContain('pnpm lint');
    expect(workflow).toContain('pnpm test');
    expect(workflow).toContain('pnpm test:coverage');
    expect(workflow).toContain('SOPS_AGE_KEY<<EOF');
    expect(workflow).toContain('cat "$key_file"');
    expect(workflow).toContain('pnpm test:e2e');
    expect(workflow).toContain('does not run `pnpm test:e2e`');
    expect(workflow).not.toMatch(/runs-on:\s*macos/);

    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('pnpm test:e2e');
    expect(readme).toContain('does not run `pnpm test:e2e`');
    expect(readme).toContain('stays manual');

    const coverage = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
    expect(coverage).toContain('packages/core/src/redactor.ts');
    expect(coverage).toMatch(/lines:\s*90/);

    const clean = runEslint('export const ready = true;\n');
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    const broken = runEslint('debugger;\n');
    expect(broken.status).toBe(1);
    expect(broken.stdout + broken.stderr).toContain('no-debugger');
  });
});

function runEslint(source: string): { status: number | null; stdout: string; stderr: string } {
  const file = join(root, 'test/unit/lint-probe.ts');
  try {
    writeFileSync(file, source);
    const result = spawnSync('pnpm', ['exec', 'eslint', file], { cwd: root, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(file, { force: true });
  }
}
