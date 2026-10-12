import { chmodSync, cpSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { controlTokenDir, controlTokenPath, ensureControlToken } from '../../packages/controller/src/runner-auth.ts';

describe('control token permissions', () => {
  const home = mkdtempSync(join(tmpdir(), 'hornet-token-perms-'));
  const project = 'fixture';
  const label = 'qa-user-1';

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('creates the token file as owner-only inside an owner-only directory', () => {
    const token = ensureControlToken(project, label, home);
    expect(token.length).toBeGreaterThan(0);
    expect(mode(controlTokenPath(project, label, home))).toBe(0o600);
    expect(mode(controlTokenDir(project, home))).toBe(0o700);
    expect(ensureControlToken(project, label, home)).toBe(token);
  });

  it('refuses a copied token file that other accounts can read', () => {
    const loose = mkdtempSync(join(tmpdir(), 'hornet-token-loose-file-'));
    try {
      cpSync(join(home, 'control'), join(loose, 'control'), { recursive: true });
      chmodSync(controlTokenDir(project, loose), 0o700);
      chmodSync(controlTokenPath(project, label, loose), 0o644);
      let accepted = '';
      expect(() => {
        accepted = ensureControlToken(project, label, loose);
      }).toThrow('The control token file is open to other accounts.');
      expect(accepted).toBe('');
    } finally {
      rmSync(loose, { recursive: true, force: true });
    }
  });

  it('refuses a copied token directory that other accounts can open', () => {
    const loose = mkdtempSync(join(tmpdir(), 'hornet-token-loose-dir-'));
    try {
      cpSync(join(home, 'control'), join(loose, 'control'), { recursive: true });
      chmodSync(controlTokenPath(project, label, loose), 0o600);
      chmodSync(controlTokenDir(project, loose), 0o755);
      let accepted = '';
      expect(() => {
        accepted = ensureControlToken(project, label, loose);
      }).toThrow('The control token directory is open to other accounts.');
      expect(accepted).toBe('');
    } finally {
      rmSync(loose, { recursive: true, force: true });
    }
  });
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}
