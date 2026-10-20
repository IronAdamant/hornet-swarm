import { describe, expect, it } from 'vitest';
import {
  proxyContainerOptions,
  proxyIsolationProblems,
  relayReachableThrough,
  runnerContainerOptions,
  runnerIsolationProblems,
  type IsolationView,
} from '../../packages/controller/src/runner-isolation.ts';
import { controlVolume, networkName, proxyName } from '../../packages/controller/src/units.ts';
import { fileAt, hasRevision } from '../support/git-history.ts';

const project = 'shop';
const label = 'qa-user-1';
const tokenDir = '/Users/owner/.hornet-swarm/runner-tokens/shop';
const spec = runnerContainerOptions({
  project,
  label,
  name: 'hornet-swarm-shop-qa-user-1',
  volume: 'hornet-swarm-shop-qa-user-1-profile',
  outDir: '/Users/owner/.hornet-swarm/runners/shop/qa-user-1',
  tokenFile: `${tokenDir}/qa-user-1.token`,
  seccomp: '{"defaultAction":"SCMP_ACT_ERRNO"}',
  memory: 1024 ** 3,
  cpus: 1,
});
const view = (): IsolationView => ({ env: [...spec.Env], host: structuredClone(spec.HostConfig) });

describe('runner isolation invariants', () => {
  it('passes the one runner spec, as created and as Docker reports it back', () => {
    expect(runnerIsolationProblems(view(), project, label)).toEqual([]);
    const inspected = view();
    inspected.host.CapAdd = ['CAP_SETUID', 'CAP_SETGID', 'CAP_SETPCAP'];
    inspected.host.CapDrop = ['CAP_ALL'];
    inspected.host.PortBindings = {};
    expect(runnerIsolationProblems(inspected, project, label)).toEqual([]);
  });

  it.each<[string, (target: IsolationView) => void, RegExp]>([
    ['the default bridge network', (target) => (target.host.NetworkMode = 'bridge'), /network is bridge/],
    ['the host network', (target) => (target.host.NetworkMode = 'host'), /network is host/],
    ['a published control port', (target) => (target.host.PortBindings = { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '8787' }] }), /publishes ports 8787\/tcp/],
    ['privileged mode', (target) => (target.host.Privileged = true), /privileged/],
    ['a network capability', (target) => (target.host.CapAdd = ['SETUID', 'NET_ADMIN']), /adds capabilities NET_ADMIN/],
    ['kept capabilities', (target) => (target.host.CapDrop = []), /does not drop all/],
    ['no-new-privileges off', (target) => (target.host.SecurityOpt = ['seccomp={}']), /new privileges/],
    ['seccomp unconfined', (target) => (target.host.SecurityOpt = ['no-new-privileges:true', 'seccomp=unconfined']), /seccomp/],
    ['a writable root', (target) => (target.host.ReadonlyRootfs = false), /writable root/],
    ['every token mounted', (target) => (target.host.Binds = [...(target.host.Binds ?? []).slice(0, 3), `${tokenDir}:/tokens`]), /only its own token/],
    ['another label\'s token', (target) => (target.host.Binds = [...(target.host.Binds ?? []).slice(0, 3), `${tokenDir}/qa-user-2.token:/tokens/qa-user-1.token:ro`]), /only its own token/],
    ['a writable token', (target) => (target.host.Binds = [...(target.host.Binds ?? []).slice(0, 3), `${tokenDir}/qa-user-1.token:/tokens/qa-user-1.token`]), /only its own token/],
    ['the Docker socket', (target) => target.host.Binds?.push('/var/run/docker.sock:/var/run/docker.sock'), /Docker socket/],
    ['the directory that holds the Docker socket', (target) => target.host.Binds?.push('/var/run:/var/run'), /Docker socket/],
    ['the token directory mounted somewhere else', (target) => target.host.Binds?.push(`${tokenDir}:/host-tokens:ro`), /token directory/],
    ['another project\'s control folder', (target) => (target.host.Binds = (target.host.Binds ?? []).map((bind) => bind.replace(controlVolume(project), controlVolume('other')))), /control folder/],
    ['a token in the environment', (target) => target.env.push('AEGIS_CONTROL_TOKEN=abc'), /token in its environment/],
  ])('refuses %s', (_name, change, problem) => {
    const target = view();
    change(target);
    expect(runnerIsolationProblems(target, project, label).join('; ')).toMatch(problem);
  });

  it('refuses a reused runner that is also attached to another network', () => {
    const target = view();
    target.networks = [networkName(project), 'bridge'];
    expect(runnerIsolationProblems(target, project, label).join('; ')).toMatch(/also attached to bridge/);
    target.networks = [networkName(project)];
    expect(runnerIsolationProblems(target, project, label)).toEqual([]);
  });

  it('passes the one proxy spec and refuses a relay or egress port opened beyond loopback', () => {
    const proxy = proxyContainerOptions(project, proxyName(project), []);
    const proxyView = (): IsolationView => ({ env: [], host: structuredClone(proxy.HostConfig) });
    expect(proxyIsolationProblems(proxyView())).toEqual([]);
    const everyAddress = proxyView();
    everyAddress.host.PortBindings = { '8899/tcp': [{ HostIp: '', HostPort: '' }] };
    expect(proxyIsolationProblems(everyAddress).join('; ')).toMatch(/every address/);
    const egress = proxyView();
    egress.host.PortBindings = { ...egress.host.PortBindings, '8888/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] };
    expect(proxyIsolationProblems(egress).join('; ')).toMatch(/publishes 8888/);
  });

  it('finds allow-list entries that would carry a page to the relay', () => {
    expect(relayReachableThrough(['host.docker.internal:8091', 'shop.test:443'], 49153)).toEqual([]);
    expect(relayReachableThrough(['host.docker.internal'], 49153)).toEqual(['host.docker.internal']);
    expect(relayReachableThrough(['localhost:49153'], 49153)).toEqual(['localhost:49153']);
    expect(relayReachableThrough(['shop.test:8899'], 49153)).toEqual(['shop.test:8899']);
  });
});

/** The runner's Env and Binds as a past commit wrote them, with this file's values put in. */
function pastRunnerView(revision: string): IsolationView {
  const source = fileAt(revision, 'packages/controller/src/env.ts');
  const block = source.slice(source.indexOf('Image: RUNNER_IMAGE'));
  const values: Record<string, string> = {
    volume: 'hornet-swarm-shop-qa-user-1-profile',
    outDir: '/Users/owner/.hornet-swarm/runners/shop/qa-user-1',
    'controlVolume(project)': controlVolume(project),
    tokenDir,
    label,
    'proxyName(project)': proxyName(project),
  };
  const fill = (text: string): string =>
    text
      .replace('${join(tokenDir, `${label}.token`)}', `${tokenDir}/${label}.token`)
      .replace(/\$\{([^}]+)\}/g, (_match, expression: string) => values[expression] ?? `?${expression}`);
  const strings = (array: string): string[] => [...array.matchAll(/`((?:[^`]|`[^`]*`)*?)`/g)].map((match) => fill(match[1] ?? ''));
  const env = /Env: \[([\s\S]*?)\],/.exec(block)?.[1] ?? '';
  const binds = /Binds: \[([\s\S]*?)\],/.exec(block)?.[1] ?? '';
  return { env: strings(env), host: { ...structuredClone(spec.HostConfig), Binds: strings(binds) } };
}

describe('each runner invariant fails on the real spec it is meant to stop', () => {
  it.skipIf(!hasRevision('a19653a'))('a19653a^: the runner read no token file, so its control API had no per-runner token', () => {
    expect(runnerIsolationProblems(pastRunnerView('a19653a^'), project, label).join('; ')).toMatch(/does not read its token/);
  });

  it.skipIf(!hasRevision('6184a74'))('6184a74^: every runner mounted the whole token folder, so it could read every other runner\'s token', () => {
    const past = pastRunnerView('6184a74^');
    expect(past.host.Binds).toContain(`${tokenDir}:/tokens`);
    expect(runnerIsolationProblems(past, project, label).join('; ')).toMatch(/only its own token/);
  });

  it('the spec today passes', () => {
    expect(runnerIsolationProblems(view(), project, label)).toEqual([]);
  });
});
