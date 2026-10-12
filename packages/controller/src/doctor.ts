import { execFileSync } from 'node:child_process';
import { estimatesFor } from '@hornet-swarm/core';
import { createDocker, detectRuntime, type RuntimeName } from './docker.js';

export type DoctorReport = {
  ok: true;
  runtime: RuntimeName;
  runtimeName: string;
  docker: {
    apiVersion: string;
    serverVersion: string;
    os: string;
    arch: string;
    cpus: number;
    memoryBytes: number;
    operatingSystem: string;
  };
  estimate: ReturnType<typeof estimatesFor>;
  power: PowerReport;
};

export type PowerReport = { system_sleep_minutes: number | null; summary: string };

/**
 * Reads the system sleep setting from `pmset -g`. The suite never turns sleep off. A closed
 * lid sleeps a MacBook whatever this says, unless it is in clamshell mode.
 */
export function powerReport(pmsetOutput?: string): PowerReport {
  let output = pmsetOutput;
  if (output === undefined) {
    if (process.platform !== 'darwin') return { system_sleep_minutes: null, summary: 'Sleep check skipped: not macOS.' };
    try {
      output = execFileSync('pmset', ['-g'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return { system_sleep_minutes: null, summary: 'Sleep check failed: pmset did not answer. A closed lid will still freeze a run.' };
    }
  }
  const match = /^\s*sleep\s+(\d+)/m.exec(output);
  const minutes = match ? Number(match[1]) : null;
  const lid = 'Closing the lid still sleeps the Mac and freezes the run, unless it is in clamshell mode.';
  if (minutes === null) return { system_sleep_minutes: null, summary: `Sleep setting not found. ${lid}` };
  if (minutes === 0) return { system_sleep_minutes: 0, summary: `System sleep is off. ${lid}` };
  return { system_sleep_minutes: minutes, summary: `System sleep is allowed after ${minutes} idle minutes, which can freeze a long run. ${lid}` };
}

const RUNTIME_LABEL: Record<RuntimeName, string> = {
  orbstack: 'OrbStack',
  colima: 'Colima',
  'docker-desktop': 'Docker Desktop',
  docker: 'Docker',
};

export async function runDoctor(estimateN = 10): Promise<DoctorReport> {
  const docker = createDocker();
  const [version, info] = await Promise.all([docker.version(), docker.info()]);
  const runtime = detectRuntime(info);
  await docker.ping();
  return {
    ok: true,
    runtime,
    runtimeName: RUNTIME_LABEL[runtime],
    docker: {
      apiVersion: version.ApiVersion ?? '',
      serverVersion: version.Version ?? info.ServerVersion ?? '',
      os: version.Os ?? info.OSType ?? '',
      arch: version.Arch ?? info.Architecture ?? '',
      cpus: info.NCPU ?? 0,
      memoryBytes: info.MemTotal ?? 0,
      operatingSystem: info.OperatingSystem ?? '',
    },
    estimate: estimatesFor(estimateN),
    power: powerReport(),
  };
}
