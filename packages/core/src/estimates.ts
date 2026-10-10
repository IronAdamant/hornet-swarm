import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type EstimateRow = {
  runners: number;
  containerRamIdle: string;
  containerRamActive: string;
  cpuActive: string;
  vmMemory: string;
  notes: string;
};

export type MeasuredResources = {
  measured: boolean;
  measuredAt?: string;
  host?: string | null;
  engine?: string;
  replacedSection?: string;
  sampleRunners?: number;
  idle?: { ramBytesTotal: number; ramBytesPerRunner: number; cpuPercentTotal: number };
  active?: { ramBytesTotal: number; ramBytesPerRunner: number; cpuPercentTotal: number };
  estimates: EstimateRow[];
};

export function loadResourceTable(): MeasuredResources {
  const packagedPath = join(dirname(fileURLToPath(import.meta.url)), 'measured-resources.json');
  const packaged = JSON.parse(readFileSync(packagedPath, 'utf8')) as MeasuredResources;
  try {
    const homePath = join(process.env.AEGIS_HOME ?? join(homedir(), '.aegis'), 'measured-resources.json');
    const home = JSON.parse(readFileSync(homePath, 'utf8')) as MeasuredResources;
    if (home.measured) {
      return {
        ...home,
        estimates: home.estimates?.length ? home.estimates : packaged.estimates,
      };
    }
  } catch {
    // No host measurement yet. The packaged spec rows still apply.
  }
  return packaged;
}

export function estimatesFor(runners: number): {
  requested: number;
  specRow: EstimateRow | null;
  measured: MeasuredResources;
  summary: string;
} {
  const measured = loadResourceTable();
  const specRow =
    measured.estimates.find((row) => row.runners === runners) ??
    measured.estimates.find((row) => row.runners === 10) ??
    null;
  const lines = [
    `Resource figures for ${runners} runner(s).`,
    specRow
      ? `Spec §6.3 row: idle ${specRow.containerRamIdle}, active ${specRow.containerRamActive}, CPU ${specRow.cpuActive}, VM ${specRow.vmMemory}.`
      : 'No spec row for that count. Hard cap is 30.',
  ];
  if (measured.measured && measured.idle && measured.active) {
    lines.push(
      `Measured on this host (${measured.engine ?? 'docker'}, ${measured.sampleRunners ?? runners} containers): idle RAM ${formatBytes(measured.idle.ramBytesTotal)} total (${formatBytes(measured.idle.ramBytesPerRunner)} each), idle CPU ${measured.idle.cpuPercentTotal.toFixed(1)}%.`,
    );
    lines.push(
      `Measured with Chromium open: RAM ${formatBytes(measured.active.ramBytesTotal)} total (${formatBytes(measured.active.ramBytesPerRunner)} each), CPU ${measured.active.cpuPercentTotal.toFixed(1)}%.`,
    );
    lines.push('These measured figures replace the §6.3 estimates for capacity planning.');
  } else {
    lines.push('Measured figures are not recorded yet.');
  }
  return { requested: runners, specRow, measured, summary: lines.join('\n') };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
