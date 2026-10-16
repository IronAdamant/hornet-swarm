import { basename } from 'node:path';
import { CONTROL_RELAY_PORT, splitAllowEntry } from './egress-proxy.js';
import { HornetError } from './errors.js';
import { controlVolume, networkName, proxyName } from './units.js';

export const RUNNER_IMAGE = 'hornet-swarm-runner:local';
export const PROXY_IMAGE = 'hornet-swarm-proxy:local';
export const CONTROL_PORT = `${CONTROL_RELAY_PORT}/tcp`;

const ALLOWED_CAPS = new Set(['SETUID', 'SETGID', 'SETPCAP']);
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal', '0.0.0.0']);

type PortBinding = { HostIp?: string; HostPort?: string };

/** The parts of a container's settings that decide what its browser can reach. Same shape for a create request and an inspect result. */
export type IsolationView = {
  env: string[];
  host: {
    NetworkMode?: string;
    Binds?: string[] | null;
    PortBindings?: Record<string, PortBinding[] | null> | null;
    PublishAllPorts?: boolean;
    Privileged?: boolean;
    CapAdd?: string[] | null;
    CapDrop?: string[] | null;
    SecurityOpt?: string[] | null;
    ReadonlyRootfs?: boolean;
  };
  /** Networks from an inspected container. Absent on a create request, which has only NetworkMode. */
  networks?: string[];
};

export type RunnerSpecInput = {
  project: string;
  label: string;
  name: string;
  volume: string;
  outDir: string;
  tokenFile: string;
  seccomp: string;
  memory: number;
  cpus: number;
};

/** The only runner container settings. Every runner is made from these and checked against runnerIsolationProblems first. */
export function runnerContainerOptions(input: RunnerSpecInput) {
  const { project, label } = input;
  return {
    name: input.name,
    Image: RUNNER_IMAGE,
    // Root keeps SETUID so entrypoint.sh can drop Node, then Chrome, to other users.
    User: '0:0',
    Labels: { 'hornet-swarm.project': project, 'hornet-swarm.user': label, 'hornet-swarm.role': 'runner' },
    Env: [
      `AEGIS_PROXY=http://${proxyName(project)}:8888`,
      `AEGIS_LABEL=${label}`,
      `AEGIS_CONTROL_SOCKET=/control/${label}.sock`,
      `AEGIS_CONTROL_TOKEN_FILE=/tokens/${label}.token`,
    ],
    HostConfig: {
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m' },
      // Only this label's token is mounted, read-only. A runner cannot read another runner's token.
      Binds: [`${input.volume}:/home/runner/profile`, `${input.outDir}:/out`, `${controlVolume(project)}:/control`, `${input.tokenFile}:/tokens/${label}.token:ro`],
      Memory: input.memory,
      MemorySwap: input.memory,
      NanoCpus: Math.round(input.cpus * 1e9),
      CapAdd: ['SETUID', 'SETGID', 'SETPCAP'],
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true', `seccomp=${input.seccomp}`],
      PidsLimit: 512,
      ShmSize: 512 * 1024 * 1024,
      NetworkMode: networkName(project),
    },
  };
}

/** The only proxy container settings. The relay port is published on this Mac's loopback only, and the egress port not at all. */
export function proxyContainerOptions(project: string, name: string, env: string[]) {
  return {
    name,
    Image: PROXY_IMAGE,
    Labels: { 'hornet-swarm.project': project, 'hornet-swarm.role': 'proxy' },
    Env: env,
    ExposedPorts: { '8888/tcp': {}, [CONTROL_PORT]: {} },
    HostConfig: {
      NetworkMode: 'bridge',
      Binds: [`${controlVolume(project)}:/control`],
      PortBindings: { [CONTROL_PORT]: [{ HostIp: '127.0.0.1', HostPort: '' }] },
      Memory: 128 * 1024 * 1024,
      MemorySwap: 128 * 1024 * 1024,
      ReadonlyRootfs: false,
    },
  };
}

/** Every way this runner's settings would let its browser reach a control surface or another runner's token. Empty means isolated. */
export function runnerIsolationProblems(view: IsolationView, project: string, label: string): string[] {
  const problems: string[] = [];
  const host = view.host;
  if (host.NetworkMode !== networkName(project)) problems.push(`network is ${host.NetworkMode ?? 'default'}, not the internal ${networkName(project)}`);
  if (publishedPorts(host).length > 0 || host.PublishAllPorts) problems.push(`publishes ports ${publishedPorts(host).join(', ') || 'all'}`);
  if (host.Privileged) problems.push('is privileged');
  const dropped = (host.CapDrop ?? []).map(capName);
  if (!dropped.includes('ALL')) problems.push('does not drop all capabilities');
  const added = (host.CapAdd ?? []).map(capName).filter((cap) => !ALLOWED_CAPS.has(cap));
  if (added.length > 0) problems.push(`adds capabilities ${added.join(', ')}`);
  const security = host.SecurityOpt ?? [];
  if (!security.includes('no-new-privileges:true')) problems.push('allows new privileges');
  if (!security.some((option) => option.startsWith('seccomp=') && option !== 'seccomp=unconfined')) problems.push('has no seccomp profile');
  if (!host.ReadonlyRootfs) problems.push('has a writable root filesystem');
  const binds = (host.Binds ?? []).map(parseBind);
  const tokenBinds = binds.filter((bind) => bind.target === '/tokens' || bind.target.startsWith('/tokens/'));
  const ownToken = `/tokens/${label}.token`;
  if (tokenBinds.length !== 1 || tokenBinds[0]?.target !== ownToken || basename(tokenBinds[0].source) !== `${label}.token` || !tokenBinds[0].readOnly) {
    problems.push(`must mount only its own token, read-only, at ${ownToken}`);
  }
  if (binds.some((bind) => exposesDockerSocket(bind.source))) problems.push('mounts the Docker socket');
  const ownTokenBind = tokenBinds.length === 1 ? tokenBinds[0] : undefined;
  if (ownTokenBind) {
    for (const problem of tokenDirectoryBinds(binds, ownTokenBind)) problems.push(problem);
  }
  const control = binds.find((bind) => bind.target === '/control');
  if (control && control.source !== controlVolume(project)) problems.push(`mounts ${control.source} as its control folder`);
  if (!view.env.includes(`AEGIS_CONTROL_TOKEN_FILE=${ownToken}`)) problems.push('does not read its token from its own token file');
  if (view.env.some((entry) => entry.startsWith('AEGIS_CONTROL_TOKEN='))) problems.push('carries a control token in its environment');
  const extraNetworks = (view.networks ?? []).filter((network) => network !== networkName(project));
  if (extraNetworks.length > 0) problems.push(`is also attached to ${extraNetworks.join(', ')}`);
  return problems;
}

/** Every way the proxy's settings would expose the relay or the egress port beyond this Mac's loopback. */
export function proxyIsolationProblems(view: IsolationView): string[] {
  const problems: string[] = [];
  const host = view.host;
  if ((host.NetworkMode ?? 'bridge') !== 'bridge' && host.NetworkMode !== 'default') problems.push(`network is ${host.NetworkMode}`);
  if (host.Privileged) problems.push('is privileged');
  if (host.PublishAllPorts) problems.push('publishes every port');
  for (const [port, bindings] of Object.entries(host.PortBindings ?? {})) {
    if (port !== CONTROL_PORT) problems.push(`publishes ${port}`);
    for (const binding of bindings ?? []) {
      if (binding.HostIp !== '127.0.0.1') problems.push(`publishes ${port} on ${binding.HostIp || 'every address'}`);
    }
  }
  return problems;
}

/**
 * Allow-list entries that would let a page reach the relay through the egress proxy. The relay is
 * published on this Mac's loopback, which host.docker.internal reaches from a container.
 */
export function relayReachableThrough(allow: string[], relayPort: number | null): string[] {
  return allow.filter((entry) => {
    const { host, port } = splitAllowEntry(entry);
    if (port === CONTROL_RELAY_PORT) return true;
    if (!LOOPBACK_NAMES.has(host)) return false;
    return port === undefined || port === relayPort;
  });
}

export function assertIsolated(what: string, problems: string[]): void {
  if (problems.length === 0) return;
  throw new HornetError(`${what} is not isolated: ${problems.join('; ')}. Nothing was started. Run: hornet-swarm env reset`, 4);
}

function publishedPorts(host: IsolationView['host']): string[] {
  return Object.entries(host.PortBindings ?? {})
    .filter(([, bindings]) => (bindings ?? []).length > 0)
    .map(([port]) => port);
}

function capName(cap: string): string {
  return cap.toUpperCase().replace(/^CAP_/, '');
}

function parseBind(bind: string): { source: string; target: string; readOnly: boolean } {
  const [source = '', target = '', options = ''] = bind.split(':');
  return { source, target, readOnly: options.split(',').includes('ro') };
}

/** A mount of the socket's parent directory exposes it even when the source path does not end in docker.sock. */
function exposesDockerSocket(source: string): boolean {
  const normalized = source.replace(/\/+$/, '');
  return normalized === '/var/run' || normalized === '/run' || normalized.endsWith('docker.sock');
}

/**
 * Any other mount that is a token file, or a directory that contains this runner's token.
 * The one allowed mount is the runner's own token file.
 */
function tokenDirectoryBinds(binds: { source: string; target: string }[], own: { source: string; target: string }): string[] {
  const slash = own.source.lastIndexOf('/');
  const tokenDir = slash > 0 ? own.source.slice(0, slash) : '';
  const problems: string[] = [];
  for (const bind of binds) {
    if (bind.source === own.source && bind.target === own.target) continue;
    const source = bind.source.replace(/\/+$/, '');
    if (source.endsWith('.token')) problems.push('mounts a token file besides its own');
    else if (tokenDir && source && (source === tokenDir || tokenDir.startsWith(`${source}/`) || source.startsWith(`${tokenDir}/`))) {
      problems.push(`mounts ${source}, which can reach the token directory`);
    }
  }
  return problems;
}
