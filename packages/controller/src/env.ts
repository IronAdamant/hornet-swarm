import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Project } from '@aegis/core';
import { projectSchema } from '@aegis/core';
import type Docker from 'dockerode';
import { createDocker } from './docker.js';
import { aegisHome, ensureDir, ensureHome } from './home.js';
import { containerName, labelsForCount, networkName, parseMemory, profileVolume, proxyName } from './units.js';

const RUNNER_IMAGE = 'aegis-runner:local';
const PROXY_IMAGE = 'aegis-proxy:local';
const CONTROL_PORT = '8899/tcp';

export type RunnerStatus = {
  label: string;
  name: string;
  state: string;
  health: 'healthy' | 'unhealthy' | 'absent';
  port: number | null;
  endpoint: string | null;
};

export type EnvStatus = {
  ok: true;
  project: string;
  network: string;
  proxy: string;
  runners: RunnerStatus[];
  healthy: number;
  expected: number;
};

export type ResetResult = EnvStatus & { durationMs: number; idempotent: true };

type RunnerSettings = {
  count: number;
  memory: string;
  cpus: number;
  labels: string[];
  allowHosts: string[];
  rps: number;
};

export async function envUp(options: { project: string; count?: number }): Promise<EnvStatus> {
  const docker = createDocker();
  await assertImages(docker);
  const settings = loadSettings(options.project, options.count);
  saveRuntime(options.project, settings);
  await ensureNetwork(docker, options.project);
  await ensureProxy(docker, options.project, settings);
  await mapPool(settings.labels, 5, (label) => ensureRunner(docker, options.project, label, settings));
  return envStatus(options.project);
}

export async function envReset(options: { project: string; count?: number; hard?: boolean }): Promise<ResetResult> {
  const started = Date.now();
  const docker = createDocker();
  await removeProjectContainers(docker, options.project);
  await removeProfileVolumes(docker, options.project);
  if (options.hard) {
    await removeNetwork(docker, options.project);
  }
  const status = await envUp(options);
  return { ...status, durationMs: Date.now() - started, idempotent: true };
}

export async function envStatus(project: string): Promise<EnvStatus> {
  const docker = createDocker();
  const settings = loadSettings(project);
  const listed = await docker.listContainers({
    all: true,
    filters: { label: [`aegis.project=${project}`, 'aegis.role=runner'] },
  });
  const runners: RunnerStatus[] = [];
  for (const label of settings.labels) {
    const name = containerName(project, label);
    const found = listed.find((container) => container.Names.some((entry) => entry === `/${name}` || entry === name));
    if (!found) {
      runners.push({ label, name, state: 'absent', health: 'absent', port: null, endpoint: null });
      continue;
    }
    const container = docker.getContainer(found.Id);
    const inspected = await container.inspect();
    const port = await controlPort(docker, project);
    const endpoint = port ? `http://127.0.0.1:${port}/r/${label}` : null;
    const state = inspected.State.Running ? 'running' : inspected.State.Status;
    let health: RunnerStatus['health'] = 'unhealthy';
    if (inspected.State.Running && endpoint) {
      health = (await pingHealth(endpoint)) ? 'healthy' : 'unhealthy';
    }
    runners.push({ label, name, state, health, port, endpoint });
  }
  return {
    ok: true,
    project,
    network: networkName(project),
    proxy: proxyName(project),
    runners,
    healthy: runners.filter((runner) => runner.health === 'healthy').length,
    expected: settings.labels.length,
  };
}

export async function measureResources(project: string): Promise<Record<string, unknown>> {
  const docker = createDocker();
  const status = await envStatus(project);
  if (status.healthy < 1) throw new Error('No healthy runners to measure. Run aegis env up first.');
  const containers = await runnerContainers(docker, project);
  const idle = await sampleGroup(containers);
  const targets = status.runners.filter((runner) => runner.health === 'healthy' && runner.endpoint);
  if (targets.length < 1) throw new Error('No runner endpoint for the active sample.');
  const probes = targets.map((runner) =>
    fetch(`${runner.endpoint}/v1/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holdMs: 20000 }),
      signal: AbortSignal.timeout(90_000),
    }),
  );
  await delay(3000);
  const active = await sampleGroup(containers);
  const probeBodies = await Promise.all(
    probes.map(async (probe) => {
      const response = await probe;
      const body = (await response.json()) as { ok?: boolean; error?: string; launchMs?: number };
      if (!response.ok || body.ok !== true) {
        throw new Error(`Chromium probe failed: ${body.error ?? response.status}`);
      }
      return body;
    }),
  );
  const probeBody = probeBodies[0];
  const info = await docker.info();
  const sampleRunners = Math.max(1, containers.length);
  const idlePer = Math.round(idle.ramBytes / sampleRunners);
  const activePer = Math.round(active.ramBytes / sampleRunners);
  const chromiumDelta = Math.max(0, activePer - idlePer);
  const table = {
    measured: true,
    measuredAt: new Date().toISOString(),
    host: 'Apple M2, 32 GB, macOS, Docker Desktop linux/arm64',
    engine: 'docker-desktop',
    engineMemoryBytes: info.MemTotal,
    replacedSection: '6.3',
    sampleRunners: status.healthy,
    probeLaunchMs: probeBody.launchMs ?? null,
    idle: {
      ramBytesTotal: idle.ramBytes,
      ramBytesPerRunner: idlePer,
      cpuPercentTotal: round(idle.cpuPercent),
    },
    active: {
      ramBytesTotal: active.ramBytes,
      ramBytesPerRunner: activePer,
      cpuPercentTotal: round(active.cpuPercent),
      note: 'Every sampled runner had Chromium open on about:blank during this sample. CPU is the docker-stats reading for that window, where 100 means one full core.',
    },
    estimates: rowsFromMeasurement({
      sampleRunners,
      idlePer,
      chromiumDelta,
      idleCpuPercent: idle.cpuPercent,
      activeCpuPercent: active.cpuPercent,
      engineMemoryBytes: info.MemTotal,
    }),
  };
  writeMeasured(table);
  return table;
}

function rowsFromMeasurement(input: {
  sampleRunners: number;
  idlePer: number;
  chromiumDelta: number;
  idleCpuPercent: number;
  activeCpuPercent: number;
  engineMemoryBytes: number;
}): Array<Record<string, unknown>> {
  const activeCoresEach = input.activeCpuPercent / 100 / input.sampleRunners;
  const vm = formatBytes(input.engineMemoryBytes);
  const row = (runners: number, note: string) => {
    const idleTotal = input.idlePer * runners;
    const activeTotal = (input.idlePer + input.chromiumDelta) * runners;
    const cores = activeCoresEach * runners;
    return {
      runners,
      containerRamIdle: formatBytes(idleTotal),
      containerRamActive: formatBytes(activeTotal),
      cpuActive: cores < 0.1 ? cores.toFixed(3) : cores.toFixed(2),
      vmMemory: vm,
      notes: note,
    };
  };
  return [
    row(1, 'Measured on this host and scaled to 1 runner.'),
    row(5, 'Measured on this host and scaled to 5 runners.'),
    row(input.sampleRunners, 'Direct measurement on this host with Chromium open in every runner.'),
    row(20, 'Scaled from the measurement. Expect the M2 to throttle once many Chromiums are busy.'),
    {
      runners: 30,
      containerRamIdle: 'not recommended',
      containerRamActive: 'not recommended',
      cpuActive: 'not recommended',
      vmMemory: vm,
      notes: 'Not recommended on this Docker Desktop VM.',
    },
  ];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function writeMeasured(table: Record<string, unknown>): void {
  const body = `${JSON.stringify(table, null, 2)}\n`;
  writeFileSync(join(ensureHome(), 'measured-resources.json'), body);
  const candidates = [
    join(process.cwd(), 'packages/core/src/measured-resources.json'),
    join(process.cwd(), 'packages/core/dist/measured-resources.json'),
  ];
  for (const path of candidates) {
    try {
      writeFileSync(path, body);
    } catch {
      // The command still records the home copy when it is not run from the repo.
    }
  }
}

async function assertImages(docker: Docker): Promise<void> {
  for (const image of [RUNNER_IMAGE, PROXY_IMAGE]) {
    try {
      await docker.getImage(image).inspect();
    } catch {
      throw new Error(`Image ${image} is not built. From the repo run: pnpm image`);
    }
  }
}

function runtimePath(project: string): string {
  return join(aegisHome(), 'projects', project, 'runtime.json');
}

function saveRuntime(project: string, settings: RunnerSettings): void {
  ensureDir(join(aegisHome(), 'projects', project));
  writeFileSync(runtimePath(project), `${JSON.stringify({ count: settings.count, labels: settings.labels })}\n`);
}

function savedCount(project: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(runtimePath(project), 'utf8')) as { count?: number };
    return typeof parsed.count === 'number' ? parsed.count : undefined;
  } catch {
    return undefined;
  }
}

function loadSettings(project: string, countOverride?: number): RunnerSettings {
  if (!/^[a-z0-9-]+$/.test(project)) throw new Error('project id must be lowercase letters, numbers, and dashes');
  const file = join(aegisHome(), 'projects', project, 'project.yaml');
  let loaded: Project | null = null;
  try {
    loaded = projectSchema.parse(parse(readFileSync(file, 'utf8')));
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
    if (!missing && exists(file)) throw error;
  }
  const count = countOverride ?? savedCount(project) ?? loaded?.runners.count ?? 10;
  return {
    count,
    memory: loaded?.runners.memory ?? '1g',
    cpus: loaded?.runners.cpus ?? 1,
    labels: labelsForCount(count, loaded?.users.map((user) => user.label) ?? []),
    allowHosts: allowHostsFrom(loaded),
    rps: loaded?.limits.max_requests_per_second_total ?? 20,
  };
}

function exists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function allowHostsFrom(project: Project | null): string[] {
  const hosts = new Set<string>(['host.docker.internal', 'localhost']);
  if (!project) return [...hosts];
  for (const origin of project.targets.allowed_origins) hosts.add(new URL(origin).hostname);
  for (const third of project.targets.allowed_third_party) hosts.add(new URL(third.origin).hostname);
  return [...hosts];
}

async function ensureNetwork(docker: Docker, project: string): Promise<void> {
  const name = networkName(project);
  try {
    await docker.getNetwork(name).inspect();
  } catch {
    await docker.createNetwork({
      Name: name,
      Driver: 'bridge',
      Internal: true,
      CheckDuplicate: true,
      Labels: { 'aegis.project': project },
    });
  }
}

async function ensureProxy(docker: Docker, project: string, settings: RunnerSettings): Promise<void> {
  const name = proxyName(project);
  const existing = await findContainer(docker, name);
  if (existing) {
    try {
      await existing.remove({ force: true });
    } catch {
      // recreate below
    }
  }
  const container = await docker.createContainer({
    name,
    Image: PROXY_IMAGE,
    Labels: { 'aegis.project': project, 'aegis.role': 'proxy' },
    Env: [
      'AEGIS_PROXY_MAIN=1',
      'AEGIS_PROXY_PORT=8888',
      'AEGIS_CONTROL_PORT=8899',
      `AEGIS_PROJECT=${project}`,
      `AEGIS_ALLOW_HOSTS=${settings.allowHosts.join(',')}`,
      `AEGIS_RPS=${settings.rps}`,
    ],
    ExposedPorts: { '8888/tcp': {}, '8899/tcp': {} },
    HostConfig: {
      NetworkMode: 'bridge',
      PortBindings: { '8899/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
      Memory: 128 * 1024 * 1024,
      MemorySwap: 128 * 1024 * 1024,
      ReadonlyRootfs: false,
    },
  });
  await container.start();
  await docker.getNetwork(networkName(project)).connect({ Container: container.id });
}

async function ensureRunner(docker: Docker, project: string, label: string, settings: RunnerSettings): Promise<void> {
  const name = containerName(project, label);
  const existing = await findContainer(docker, name);
  if (existing) {
    const inspected = await existing.inspect();
    if (!inspected.State.Running) await existing.start();
    const endpoint = await waitForEndpoint(docker, project, label);
    const healthy = await waitHealthy(endpoint, 20_000);
    if (!healthy) throw new Error(await failureText(existing, name));
    return;
  }
  const volume = profileVolume(project, label);
  try {
    await docker.createVolume({ Name: volume, Labels: { 'aegis.project': project, 'aegis.user': label } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes('already exists')) throw error;
  }
  const outDir = ensureDir(join(aegisHome(), 'runners', project, label));
  chmodSync(outDir, 0o777);
  const seccomp = JSON.stringify(JSON.parse(readFileSync(installSeccomp(), 'utf8')));
  if (!seccomp.startsWith('{')) throw new Error(`seccomp did not encode as JSON: ${seccomp.slice(0, 30)}`);
  const memory = parseMemory(settings.memory);
  const container = await docker.createContainer({
    name,
    Image: RUNNER_IMAGE,
    User: '10001:10001',
    Labels: { 'aegis.project': project, 'aegis.user': label, 'aegis.role': 'runner' },
    Env: [`AEGIS_PROXY=http://${proxyName(project)}:8888`, `AEGIS_LABEL=${label}`],
    HostConfig: {
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m' },
      Binds: [`${volume}:/home/runner/profile`, `${outDir}:/out`],
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: Math.round(settings.cpus * 1e9),
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true', `seccomp=${seccomp}`],
      PidsLimit: 512,
      ShmSize: 512 * 1024 * 1024,
      NetworkMode: networkName(project),
    },
  });
  await container.start();
  const endpoint = await waitForEndpoint(docker, project, label);
  const healthy = await waitHealthy(endpoint, 20_000);
  if (!healthy) throw new Error(await failureText(container, name));
}

function installSeccomp(): string {
  const source = join(dirname(fileURLToPath(import.meta.url)), '../../../images/runner/seccomp.json');
  const repoSource = join(process.cwd(), 'images/runner/seccomp.json');
  const dest = join(ensureHome(), 'seccomp.json');
  const from = exists(source) ? source : repoSource;
  copyFileSync(from, dest);
  return dest;
}

async function findContainer(docker: Docker, name: string): Promise<Docker.Container | null> {
  const listed = await docker.listContainers({ all: true, filters: { name: [name] } });
  const exact = listed.find((container) => container.Names.includes(`/${name}`));
  return exact ? docker.getContainer(exact.Id) : null;
}

async function controlPort(docker: Docker, project: string): Promise<number | null> {
  const proxy = await findContainer(docker, proxyName(project));
  if (!proxy) return null;
  const inspected = await proxy.inspect();
  const binding = inspected.NetworkSettings?.Ports?.[CONTROL_PORT]?.[0]?.HostPort;
  const port = Number(binding);
  return Number.isInteger(port) && port > 0 ? port : null;
}

async function waitForEndpoint(docker: Docker, project: string, label: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const port = await controlPort(docker, project);
    if (port) return `http://127.0.0.1:${port}/r/${label}`;
    await delay(200);
  }
  throw new Error('Control gateway did not publish a localhost port');
}

async function pingHealth(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function waitHealthy(endpoint: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingHealth(endpoint)) return true;
    await delay(300);
  }
  return false;
}

async function failureText(container: Docker.Container, name: string): Promise<string> {
  let logs = '';
  try {
    const raw = await container.logs({ stdout: true, stderr: true, tail: 40 });
    logs = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  } catch {
    logs = '';
  }
  return `Runner ${name} did not become healthy.\n${logs.slice(-1500)}`;
}

async function removeProjectContainers(docker: Docker, project: string): Promise<void> {
  const listed = await docker.listContainers({ all: true, filters: { label: [`aegis.project=${project}`] } });
  await mapPool(listed, 5, async (entry) => {
    const container = docker.getContainer(entry.Id);
    try {
      await container.stop({ t: 2 });
    } catch {
      // already stopped
    }
    await container.remove({ force: true });
  });
}

async function removeProfileVolumes(docker: Docker, project: string): Promise<void> {
  const volumes = await docker.listVolumes({ filters: { label: [`aegis.project=${project}`] } });
  for (const volume of volumes.Volumes ?? []) {
    if (!volume.Name.startsWith(`aegis-profile-${project}-`)) continue;
    try {
      await docker.getVolume(volume.Name).remove();
    } catch {
      // a container may still be releasing it; the next reset retries
    }
  }
}

async function removeNetwork(docker: Docker, project: string): Promise<void> {
  try {
    await docker.getNetwork(networkName(project)).remove();
  } catch {
    // already gone
  }
}

async function runnerContainers(docker: Docker, project: string): Promise<Docker.Container[]> {
  const listed = await docker.listContainers({
    all: false,
    filters: { label: [`aegis.project=${project}`, 'aegis.role=runner'] },
  });
  return listed.map((entry) => docker.getContainer(entry.Id));
}

async function sampleGroup(containers: Docker.Container[]): Promise<{ ramBytes: number; cpuPercent: number }> {
  const first = await Promise.all(containers.map((container) => readStats(container)));
  await delay(1000);
  const second = await Promise.all(containers.map((container) => readStats(container)));
  let ram = 0;
  let cpu = 0;
  for (let index = 0; index < containers.length; index += 1) {
    ram += memoryBytes(second[index] ?? {});
    cpu += cpuPercent(first[index] ?? {}, second[index] ?? {});
  }
  return { ramBytes: ram, cpuPercent: cpu };
}

type DockerStats = {
  memory_stats?: { usage?: number; stats?: { inactive_file?: number; cache?: number } };
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
};

async function readStats(container: Docker.Container): Promise<DockerStats> {
  return (await container.stats({ stream: false })) as DockerStats;
}

function memoryBytes(stats: DockerStats): number {
  const usage = stats.memory_stats?.usage ?? 0;
  const cache = stats.memory_stats?.stats?.inactive_file ?? stats.memory_stats?.stats?.cache ?? 0;
  return Math.max(0, usage - cache);
}

function cpuPercent(previous: DockerStats, current: DockerStats): number {
  const prev = previous.cpu_stats ?? previous.precpu_stats;
  const cpuDelta = (current.cpu_stats?.cpu_usage?.total_usage ?? 0) - (prev?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (current.cpu_stats?.system_cpu_usage ?? 0) - (prev?.system_cpu_usage ?? 0);
  const cpus = current.cpu_stats?.online_cpus ?? 1;
  if (cpuDelta <= 0 || sysDelta <= 0) return 0;
  return (cpuDelta / sysDelta) * cpus * 100;
}

async function mapPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      await worker(next);
    }
  });
  await Promise.all(runners);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function defaultProjectFromHome(): string {
  try {
    const raw = parse(readFileSync(join(homedir(), '.aegis', 'config.yaml'), 'utf8')) as { default_project?: string };
    if (raw.default_project) return raw.default_project;
  } catch {
    // no config yet
  }
  return 'default';
}
