import Docker from 'dockerode';

export type RuntimeName = 'orbstack' | 'colima' | 'docker-desktop' | 'docker';

export function createDocker(): Docker {
  return new Docker();
}

export function detectRuntime(info: { OperatingSystem?: string; Name?: string }): RuntimeName {
  const blob = `${info.OperatingSystem ?? ''} ${info.Name ?? ''}`.toLowerCase();
  if (blob.includes('orbstack')) return 'orbstack';
  if (blob.includes('colima')) return 'colima';
  if (blob.includes('docker desktop')) return 'docker-desktop';
  return 'docker';
}
