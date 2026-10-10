import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hornet, root } from './helper.js';

describe('hard reset', () => {
  it('rebuilds the runner and proxy images, then recreates the containers', () => {
    const bundle = join(root, 'images/runner/build/main.js');
    const beforeBundle = statSync(bundle).mtimeMs;
    const beforeNetwork = docker(['network', 'inspect', '-f', '{{.Id}}', 'hornet-swarm-net-fixture']);
    const soft = hornet(['env', 'reset', '--project', 'fixture', '--count', '1', '--json']);
    expect(soft.status, soft.stdout + soft.stderr).toBe(0);
    expect(statSync(bundle).mtimeMs).toBe(beforeBundle);
    expect(docker(['network', 'inspect', '-f', '{{.Id}}', 'hornet-swarm-net-fixture'])).toBe(beforeNetwork);

    const hard = hornet(['env', 'reset', '--project', 'fixture', '--count', '1', '--hard', '--json'], undefined, 600_000);
    expect(hard.status, hard.stdout + hard.stderr).toBe(0);
    const body = JSON.parse(hard.stdout) as { healthy: number; expected: number; idempotent: boolean };
    expect(body.healthy).toBe(1);
    expect(body.expected).toBe(1);
    expect(body.idempotent).toBe(true);
    expect(statSync(bundle).mtimeMs).toBeGreaterThan(beforeBundle);
    expect(docker(['network', 'inspect', '-f', '{{.Id}}', 'hornet-swarm-net-fixture'])).not.toBe(beforeNetwork);
    expect(docker(['inspect', '-f', '{{.Image}}', 'hornet-swarm-fixture-qa-user-1'])).toBe(docker(['image', 'inspect', '-f', '{{.Id}}', 'hornet-swarm-runner:local']));
    expect(docker(['inspect', '-f', '{{.Image}}', 'hornet-swarm-proxy-fixture'])).toBe(docker(['image', 'inspect', '-f', '{{.Id}}', 'hornet-swarm-proxy:local']));
    const status = JSON.parse(hornet(['env', 'status', '--project', 'fixture', '--json']).stdout) as { healthy: number };
    expect(status.healthy).toBe(1);
  }, 600_000);
});

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}
