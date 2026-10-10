import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectRuntime } from '../../packages/controller/src/docker.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(root, 'packages/cli/dist/main.js');

describe('runtime detection', () => {
  it('names Docker Desktop when that is the engine', () => {
    expect(detectRuntime({ OperatingSystem: 'Docker Desktop', Name: 'docker-desktop' })).toBe('docker-desktop');
    expect(detectRuntime({ OperatingSystem: 'OrbStack', Name: 'orbstack' })).toBe('orbstack');
    expect(detectRuntime({ OperatingSystem: 'Debian', Name: 'colima' })).toBe('colima');
  });

  it('doctor --json reports the live Docker API', () => {
    const stdout = execFileSync(process.execPath, [cli, 'doctor', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    const report = JSON.parse(stdout) as {
      ok: boolean;
      runtime: string;
      docker: { apiVersion: string; serverVersion: string; arch: string };
    };
    expect(report.ok).toBe(true);
    expect(report.runtime).toBe('docker-desktop');
    expect(report.docker.apiVersion).toMatch(/^\d+\.\d+/);
    expect(report.docker.serverVersion.length).toBeGreaterThan(0);
    expect(report.docker.arch).toBe('arm64');
  });
});
