import { execFileSync } from 'node:child_process';
import { chmodSync, rmSync, statSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { home, hornet } from './helper.js';
import { join } from 'node:path';

const project = 'outputperms';
const runner = 'hornet-swarm-outputperms-qa-user-1';
const proxy = 'hornet-swarm-proxy-outputperms';
const output = join(home, 'runners', project, 'qa-user-1');

describe('runner output folder', () => {
  afterAll(() => {
    docker(['rm', '-f', runner, proxy]);
    rmSync(output, { recursive: true, force: true });
  });

  it('creates an owner-only folder and refuses a looser one when the runner is reused', () => {
    docker(['rm', '-f', runner]);
    rmSync(output, { recursive: true, force: true });
    const up = hornet(['env', 'up', '--project', project, '--count', '1', '--json'], undefined, 180_000);
    expect(up.status, up.stdout + up.stderr).toBe(0);
    const created = statSync(output);
    expect(created.mode & 0o777).toBe(0o700);
    expect(created.uid).toBe(process.getuid());
    expect(created.gid).toBe(process.getgid());

    chmodSync(output, 0o777);
    const again = hornet(['env', 'up', '--project', project, '--count', '1', '--json'], undefined, 180_000);
    expect(again.status).not.toBe(0);
    const body = again.stdout + again.stderr;
    expect(body).toContain(`The runner output folder is open to other accounts: ${output}`);
    expect(statSync(output).mode & 0o777).toBe(0o777);
  }, 180_000);
});

function docker(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('docker', args, { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: failed.status ?? 1,
      stdout: String(failed.stdout ?? ''),
      stderr: String(failed.stderr ?? ''),
    };
  }
}
