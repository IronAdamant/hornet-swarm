export function parseMemory(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(k|m|g)?b?$/i.exec(value.trim());
  if (!match) throw new Error(`Unrecognised memory size: ${value}`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase();
  const factor = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1;
  return Math.round(amount * factor);
}

export function labelsForCount(count: number, projectLabels: string[] = []): string[] {
  if (count < 1 || count > 30) throw new Error('runner count must be from 1 to 30');
  if (projectLabels.length >= count) return projectLabels.slice(0, count);
  return Array.from({ length: count }, (_, index) => `qa-user-${index + 1}`);
}

export function containerName(project: string, label: string): string {
  return `aegis-${project}-${label}`;
}

export function proxyName(project: string): string {
  return `aegis-proxy-${project}`;
}

export function networkName(project: string): string {
  return `aegis-net-${project}`;
}

export function profileVolume(project: string, label: string): string {
  return `aegis-profile-${project}-${label}`;
}
