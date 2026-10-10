import { estimatesFor } from '@aegis/core';
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
};

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
  };
}
