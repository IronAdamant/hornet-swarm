import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { cpus, networkInterfaces, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Project } from '@hornet-swarm/core';
import { copyPrivateFile, privateDir, projectSchema, rewriteForContainer, writePrivateFile } from '@hornet-swarm/core';
import type Docker from 'dockerode';
import { createDocker, detectRuntime } from './docker.js';
import { aegisHome, ensureHome } from './home.js';
import { controlTokenDir, ensureControlToken, runnerFetch } from './runner-auth.js';
import { HornetError } from './errors.js';
import {
  assertIsolated,
  CONTROL_PORT,
  PROXY_IMAGE,
  proxyContainerOptions,
  proxyIsolationProblems,
  relayReachableThrough,
  RUNNER_IMAGE,
  runnerContainerOptions,
  runnerIsolationProblems,
  type IsolationView,
} from './runner-isolation.js';
import { containerName, controlVolume, labelsForCount, networkName, parseMemory, profileVolume, proxyName } from './units.js';


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

/** An existing directory that other accounts can open is refused. Its mode is left unchanged. */
export function prepareRunnerTokenDir(project: string, label: string, home = aegisHome()): string {
  const tokenDir = privateDir(controlTokenDir(project, home), { looseMessage: 'The control token directory is open to other accounts.' });
  ensureControlToken(project, label, home);
  return tokenDir;
}

export function prepareRunnerOutputDir(project: string, label: string, home = aegisHome()): string {
  const directory = join(home, 'runners', project, label);
  return privateDir(directory, { looseMessage: `The runner output folder is open to other accounts: ${directory}` });
}

export async function envUp(options: { project: string; count?: number }): Promise<EnvStatus> {
  const docker = createDocker();
  await assertImages(docker);
  const settings = loadSettings(options.project, options.count);
  saveRuntime(options.project, settings, options.count !== undefined || savedCount(options.project) !== undefined);
  await ensureNetwork(docker, options.project);
  await ensureControlVolume(docker, options.project);
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
    rebuildImages();
  }
  const status = await envUp(options);
  return { ...status, durationMs: Date.now() - started, idempotent: true };
}

export function containerChosen(entry: { Names: string[]; Labels?: Record<string, string> }, project: string, label?: string): boolean {
  if (!label) return true;
  const wanted = containerName(project, label);
  return entry.Names.some((name) => name === `/${wanted}` || name === wanted) || entry.Labels?.['hornet-swarm.user'] === label;
}

export async function stopRunners(project: string, label?: string): Promise<void> {
  const docker = createDocker();
  const listed = await docker.listContainers({
    all: true,
    filters: { label: [`hornet-swarm.project=${project}`, 'hornet-swarm.role=runner'] },
  });
  await Promise.all(
    listed.filter((entry) => containerChosen(entry, project, label)).map(async (entry) => {
      const container = docker.getContainer(entry.Id);
      try {
        await container.stop({ t: 1 });
      } catch {
        await container.kill().catch(() => undefined);
      }
    }),
  );
}

/**
 * Refuses a runner that is already on the machine but no longer matches the isolation spec.
 * `env up` replaces that container. A job must not start it or talk to it.
 */
export async function assertExistingRunnerIsolated(project: string, label: string): Promise<void> {
  const docker = createDocker();
  const existing = await findContainer(docker, containerName(project, label));
  if (!existing) return;
  assertIsolated(`The runner for ${label}`, runnerProblemsFromInspect(await existing.inspect(), project, label));
}

export async function startStoppedRunner(project: string, label: string): Promise<boolean> {
  const docker = createDocker();
  const existing = await findContainer(docker, containerName(project, label));
  if (!existing) return false;
  const inspected = await existing.inspect();
  if (runnerProblemsFromInspect(inspected, project, label).length > 0) return false;
  if (!inspected.State.Running) {
    try {
      await existing.start();
    } catch {
      return false;
    }
  }
  let endpoint: string;
  try {
    endpoint = await waitForEndpoint(docker, project, label);
  } catch {
    return false;
  }
  return waitHealthy(project, endpoint, 20_000);
}

export async function envStatus(project: string): Promise<EnvStatus> {
  const docker = createDocker();
  const settings = loadSettings(project);
  const listed = await docker.listContainers({
    all: true,
    filters: { label: [`hornet-swarm.project=${project}`, 'hornet-swarm.role=runner'] },
  });
  const port = await controlPort(docker, project);
  const runners = await Promise.all(
    settings.labels.map((label) => {
      const name = containerName(project, label);
      const found = listed.find((container) => container.Names.some((entry) => entry === `/${name}` || entry === name));
      return describeRunner(docker, project, label, found ? docker.getContainer(found.Id) : null, port);
    }),
  );
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

/** One runner's state and health. A job only needs its own runner, so it does not ping the whole fleet. */
export async function runnerStatus(project: string, label: string): Promise<RunnerStatus> {
  const docker = createDocker();
  const container = await findContainer(docker, containerName(project, label));
  return describeRunner(docker, project, label, container, container ? await controlPort(docker, project) : null);
}

async function describeRunner(docker: Docker, project: string, label: string, container: Docker.Container | null, port: number | null): Promise<RunnerStatus> {
  const name = containerName(project, label);
  if (!container) return { label, name, state: 'absent', health: 'absent', port: null, endpoint: null };
  const inspected = await container.inspect();
  const endpoint = port ? `http://127.0.0.1:${port}/r/${label}` : null;
  const state = inspected.State.Running ? 'running' : inspected.State.Status;
  let health: RunnerStatus['health'] = 'unhealthy';
  if (inspected.State.Running && endpoint) {
    health = (await pingHealth(project, endpoint)) ? 'healthy' : 'unhealthy';
  }
  return { label, name, state, health, port, endpoint };
}

export async function measureResources(project: string): Promise<Record<string, unknown>> {
  const docker = createDocker();
  const status = await envStatus(project);
  if (status.healthy < 1) throw new Error('No healthy runners to measure. Run hornet-swarm env up first.');
  const containers = await runnerContainers(docker, project);
  const idle = await sampleGroup(containers);
  const targets = status.runners.filter((runner): runner is typeof runner & { endpoint: string } => runner.health === 'healthy' && typeof runner.endpoint === 'string');
  if (targets.length < 1) throw new Error('No runner endpoint for the active sample.');
  const probes = targets.map((runner) =>
    runnerFetch(project, runner.endpoint, '/v1/probe', {
      method: 'POST',
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
    host: hostDescription(info),
    engine: detectRuntime(info),
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

/** The machine the figures came from, as this Mac and its engine report it. */
export function hostDescription(info: { OperatingSystem?: string; Name?: string; Architecture?: string; OSType?: string }): string {
  const chip = cpus()[0]?.model?.trim() || 'unknown CPU';
  const memory = `${Math.round(totalmem() / 1024 ** 3)} GB`;
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform;
  const engine = `${info.OperatingSystem ?? 'container engine'} ${info.OSType ?? 'linux'}/${info.Architecture ?? 'unknown'}`;
  return `${chip}, ${memory}, ${platform}, ${engine}`;
}

/**
 * The measurement is saved in the Hornet Swarm home, which loadResourceTable reads before the
 * packaged figures. The repo's own files are never changed by a command.
 */
function writeMeasured(table: Record<string, unknown>): void {
  writePrivateFile(join(ensureHome(), 'measured-resources.json'), `${JSON.stringify(table, null, 2)}\n`);
}

function repoRoot(): string {
  const fromPackage = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  for (const root of [process.cwd(), fromPackage]) {
    if (existsSync(join(root, 'scripts/build-image.sh'))) return root;
  }
  throw new Error('Cannot find scripts/build-image.sh. Run this command from the Hornet Swarm repo.');
}

function rebuildImages(): void {
  const root = repoRoot();
  try {
    execFileSync('bash', [join(root, 'scripts/build-image.sh')], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    });
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : '';
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String((error as { stdout?: unknown }).stdout ?? '') : '';
    throw new Error(`Image rebuild failed. ${(stderr || stdout).slice(-2000)}`, { cause: error });
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

/** `chosen` records a count the owner picked with --count, which sticks. A default follows the project file. */
function saveRuntime(project: string, settings: RunnerSettings, chosen: boolean): void {
  privateDir(join(aegisHome(), 'projects', project));
  writePrivateFile(runtimePath(project), `${JSON.stringify({ count: settings.count, labels: settings.labels, chosen })}\n`);
}

/**
 * The count the owner chose with --count on an earlier start. A count that only came from the
 * project file is not kept, so a project that gains a label gets a runner for it on the next start.
 */
export function savedCount(project: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(runtimePath(project), 'utf8')) as { count?: number; chosen?: boolean };
    return parsed.chosen === true && typeof parsed.count === 'number' ? parsed.count : undefined;
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
    allowHosts: allowHostsFrom(loaded, localAddresses()),
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

/**
 * The egress proxy allows exact host and port pairs. A local origin is also allowed under the
 * name the container uses for this Mac. The credential page port is allowed so a runner can
 * wait for a texted or emailed code. No other port on this Mac is reachable.
 */
export function allowHostsFrom(project: Project | null, localAddresses: readonly string[] = [], credentialPort = Number(process.env.AEGIS_CREDENTIAL_PORT ?? 7781)): string[] {
  const hosts = new Set<string>([`host.docker.internal:${credentialPort}`]);
  if (!project) return [...hosts];
  const origins = [project.targets.base_url, ...project.targets.allowed_origins, ...project.targets.allowed_third_party.map((third) => third.origin)];
  for (const origin of origins) {
    for (const url of [origin, rewriteForContainer(origin, localAddresses)]) {
      const parsed = new URL(url);
      const host = parsed.hostname.includes(':') && !parsed.hostname.startsWith('[') ? `[${parsed.hostname}]` : parsed.hostname;
      hosts.add(`${host}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`);
    }
  }
  return [...hosts];
}

function localAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((entries) => (entries ?? []).map((entry) => entry.address));
}

async function ensureNetwork(docker: Docker, project: string): Promise<void> {
  const name = networkName(project);
  let existing: { Internal?: boolean } | undefined;
  try {
    existing = (await docker.getNetwork(name).inspect()) as { Internal?: boolean };
  } catch {
    existing = undefined;
  }
  // A runner's only way out is the egress proxy. A network with its own route out is never used.
  if (existing && !existing.Internal) throw new HornetError(`The network ${name} has a route out of Docker. Nothing was started. Run: hornet-swarm env reset --project ${project}`, 4);
  if (!existing) {
    await docker.createNetwork({
      Name: name,
      Driver: 'bridge',
      Internal: true,
      CheckDuplicate: true,
      Labels: { 'hornet-swarm.project': project },
    });
  }
}

async function ensureProxy(docker: Docker, project: string, settings: RunnerSettings): Promise<void> {
  const name = proxyName(project);
  const env = [
    'AEGIS_PROXY_MAIN=1',
    'AEGIS_PROXY_PORT=8888',
    'AEGIS_CONTROL_PORT=8899',
    `AEGIS_PROJECT=${project}`,
    `AEGIS_ALLOW_HOSTS=${settings.allowHosts.join(',')}`,
    `AEGIS_RPS=${settings.rps}`,
    'AEGIS_CONTROL_DIR=/control',
  ];
  const existing = await findContainer(docker, name);
  if (existing) {
    // A running proxy with the same image and settings is kept, so env up does not cut off runs in flight.
    if (await proxyCurrent(docker, existing, env, project)) return;
    try {
      await existing.remove({ force: true });
    } catch {
      // recreate below
    }
  }
  const options = proxyContainerOptions(project, name, env);
  assertIsolated('The proxy', proxyIsolationProblems({ env: options.Env, host: options.HostConfig }));
  const container = await docker.createContainer(options);
  await container.start();
  // Bind 8899 to the bridge address before the project network exists, so the browser cannot open it.
  await waitForBridgeGateway(docker, project);
  const opened = relayReachableThrough(settings.allowHosts, await controlPort(docker, project));
  if (opened.length > 0) {
    await container.remove({ force: true }).catch(() => undefined);
    assertIsolated('The proxy', [`its allow list reaches the control relay: ${opened.join(', ')}`]);
  }
  await docker.getNetwork(networkName(project)).connect({ Container: container.id });
}

async function proxyCurrent(docker: Docker, container: Docker.Container, env: string[], project: string): Promise<boolean> {
  try {
    const inspected = await container.inspect();
    const wanted = (await docker.getImage(PROXY_IMAGE).inspect()).Id;
    const current = new Set(inspected.Config.Env ?? []);
    const networks = Object.keys(inspected.NetworkSettings?.Networks ?? {});
    return (
      inspected.State.Running &&
      inspected.Image === wanted &&
      proxyIsolationProblems({ env: inspected.Config.Env ?? [], host: inspected.HostConfig }).length === 0 &&
      env.every((entry) => current.has(entry)) &&
      networks.includes(networkName(project)) &&
      (await controlPort(docker, project)) !== null
    );
  } catch {
    return false;
  }
}

function runnerProblemsFromInspect(
  inspected: {
    Config?: { Env?: string[] | null };
    HostConfig?: IsolationView['host'];
    NetworkSettings?: { Networks?: Record<string, unknown> | null };
  },
  project: string,
  label: string,
): string[] {
  const host = inspected.HostConfig ?? {};
  return runnerIsolationProblems(
    {
      env: [...(inspected.Config?.Env ?? [])],
      host: {
        NetworkMode: host.NetworkMode,
        Binds: host.Binds,
        PortBindings: host.PortBindings,
        PublishAllPorts: host.PublishAllPorts,
        Privileged: host.Privileged,
        CapAdd: host.CapAdd,
        CapDrop: host.CapDrop,
        SecurityOpt: host.SecurityOpt,
        ReadonlyRootfs: host.ReadonlyRootfs,
      },
      networks: Object.keys(inspected.NetworkSettings?.Networks ?? {}),
    },
    project,
    label,
  );
}

async function ensureRunner(docker: Docker, project: string, label: string, settings: RunnerSettings): Promise<void> {
  // A reused container returns before anything below this. Loose token or output folders refuse startup.
  const tokenDir = prepareRunnerTokenDir(project, label);
  const outDir = prepareRunnerOutputDir(project, label);
  const name = containerName(project, label);
  const existing = await findContainer(docker, name);
  if (existing) {
    const inspected = await existing.inspect();
    let wanted: string;
    try {
      wanted = (await docker.getImage(RUNNER_IMAGE).inspect()).Id;
    } catch {
      wanted = '';
    }
    // An image we could not identify is not reused. Treating that failure as a match kept whatever was already there.
    const sameImage = wanted !== '' && inspected.Image === wanted;
    // A runner made by an older version, or changed by hand, is replaced rather than trusted.
    const isolated = runnerProblemsFromInspect(inspected, project, label).length === 0;
    if (sameImage && isolated) {
      if (!inspected.State.Running) await existing.start();
      const endpoint = await waitForEndpoint(docker, project, label);
      const healthy = await waitHealthy(project, endpoint, 20_000);
      if (healthy) return;
    }
    await existing.remove({ force: true });
  }
  const volume = profileVolume(project, label);
  try {
    await docker.createVolume({ Name: volume, Labels: { 'hornet-swarm.project': project, 'hornet-swarm.user': label } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes('already exists')) throw error;
  }
  const seccomp = JSON.stringify(JSON.parse(readFileSync(installSeccomp(), 'utf8')));
  if (!seccomp.startsWith('{')) throw new Error(`seccomp did not encode as JSON: ${seccomp.slice(0, 30)}`);
  const memory = parseMemory(settings.memory);
  const options = runnerContainerOptions({ project, label, name, volume, outDir, tokenFile: join(tokenDir, `${label}.token`), seccomp, memory, cpus: settings.cpus });
  assertIsolated(`The runner for ${label}`, runnerIsolationProblems({ env: options.Env, host: options.HostConfig }, project, label));
  const container = await docker.createContainer(options);
  await container.start();
  const endpoint = await waitForEndpoint(docker, project, label);
  const healthy = await waitHealthy(project, endpoint, 20_000);
  if (!healthy) throw new Error(await failureText(container, name));
}

function installSeccomp(): string {
  const source = join(dirname(fileURLToPath(import.meta.url)), '../../../images/runner/seccomp.json');
  const repoSource = join(process.cwd(), 'images/runner/seccomp.json');
  const dest = join(ensureHome(), 'seccomp.json');
  const from = exists(source) ? source : repoSource;
  copyPrivateFile(from, dest);
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

async function waitForBridgeGateway(docker: Docker, project: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const port = await controlPort(docker, project);
    if (port && (await tcpOpen(port))) return;
    await delay(200);
  }
  throw new Error('Control gateway did not listen on the bridge address.');
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
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

async function pingHealth(project: string, endpoint: string): Promise<boolean> {
  try {
    const response = await runnerFetch(project, endpoint, '/health', { method: 'GET', signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function waitHealthy(project: string, endpoint: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingHealth(project, endpoint)) return true;
    await delay(300);
  }
  return false;
}

async function ensureControlVolume(docker: Docker, project: string): Promise<void> {
  const name = controlVolume(project);
  try {
    await docker.getVolume(name).inspect();
  } catch {
    await docker.createVolume({ Name: name, Labels: { 'hornet-swarm.project': project, 'hornet-swarm.role': 'control' } });
  }
  const container = await docker.createContainer({
    Image: PROXY_IMAGE,
    User: '0:0',
    Entrypoint: ['sh', '-c', 'chown 10001:10010 /control && chmod 0770 /control'],
    HostConfig: { Binds: [`${name}:/control`] },
  });
  try {
    await container.start();
    const result = await container.wait();
    if (result.StatusCode !== 0) throw new Error('Could not prepare the control socket directory.');
  } finally {
    await container.remove({ force: true }).catch(() => undefined);
  }
}

async function failureText(container: Docker.Container, name: string): Promise<string> {
  let logs: string;
  try {
    const raw = await container.logs({ stdout: true, stderr: true, tail: 40 });
    logs = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  } catch {
    logs = '';
  }
  return `Runner ${name} did not become healthy.\n${logs.slice(-1500)}`;
}

async function removeProjectContainers(docker: Docker, project: string): Promise<void> {
  const listed = await docker.listContainers({ all: true, filters: { label: [`hornet-swarm.project=${project}`] } });
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
  const volumes = await docker.listVolumes({ filters: { label: [`hornet-swarm.project=${project}`] } });
  for (const volume of volumes.Volumes ?? []) {
    if (!volume.Name.startsWith(`hornet-swarm-profile-${project}-`)) continue;
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
    filters: { label: [`hornet-swarm.project=${project}`, 'hornet-swarm.role=runner'] },
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
    const raw = parse(readFileSync(join(aegisHome(), 'config.yaml'), 'utf8')) as { default_project?: string };
    if (raw.default_project) return raw.default_project;
  } catch {
    // no config yet
  }
  return 'default';
}
