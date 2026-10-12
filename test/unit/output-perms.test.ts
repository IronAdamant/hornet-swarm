import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { prepareRunnerOutputDir } from '../../packages/controller/src/env.ts';

describe('runner output folder permissions', () => {
  const home = mkdtempSync(join(tmpdir(), 'hornet-output-perms-'));
  const project = 'fixture';
  const label = 'qa-user-1';

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('creates an output folder owned by the controller user at mode 0700', () => {
    const directory = prepareRunnerOutputDir(project, label, home);
    const status = statSync(directory);
    expect(status.mode & 0o777).toBe(0o700);
    expect(status.uid).toBe(process.getuid());
    expect(status.gid).toBe(process.getgid());
    expect(prepareRunnerOutputDir(project, label, home)).toBe(directory);
  });

  it('refuses a looser output folder and leaves its mode unchanged', () => {
    const loose = mkdtempSync(join(tmpdir(), 'hornet-output-loose-'));
    try {
      const directory = prepareRunnerOutputDir(project, label, loose);
      chmodSync(directory, 0o777);
      let accepted = '';
      expect(() => {
        accepted = prepareRunnerOutputDir(project, label, loose);
      }).toThrow(`The runner output folder is open to other accounts: ${directory}`);
      expect(accepted).toBe('');
      expect(statSync(directory).mode & 0o777).toBe(0o777);
    } finally {
      rmSync(loose, { recursive: true, force: true });
    }
  });
});
