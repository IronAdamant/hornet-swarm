import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { hostAllowed, startEgressProxy } from '../../packages/controller/src/egress-proxy.ts';
import { labelsForCount, parseMemory } from '../../packages/controller/src/units.ts';

describe('runner settings', () => {
  it('parses memory sizes and caps labels at the requested count', () => {
    expect(parseMemory('1g')).toBe(1024 ** 3);
    expect(parseMemory('512m')).toBe(512 * 1024 ** 2);
    expect(labelsForCount(3)).toEqual(['qa-user-1', 'qa-user-2', 'qa-user-3']);
    expect(labelsForCount(2, ['qa-user-9', 'qa-user-8', 'qa-user-7'])).toEqual(['qa-user-9', 'qa-user-8']);
  });
});

describe('egress proxy', () => {
  it('blocks a host that is not on the allowlist and opens one that is', async () => {
    expect(hostAllowed('Host.Docker.Internal', ['host.docker.internal'])).toBe(true);
    expect(hostAllowed('example.com', ['host.docker.internal'])).toBe(false);

    const target = net.createServer((socket) => {
      socket.end('ok');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', () => resolve()));
    const targetPort = (target.address() as net.AddressInfo).port;
    const proxy = await startEgressProxy({ port: 0, allow: ['127.0.0.1'], rps: 20, log() {} });
    try {
      const denied = await connectStatus(proxy.port, `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n`);
      expect(denied).toContain('403');
      const allowed = await connectStatus(
        proxy.port,
        `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`,
      );
      expect(allowed.startsWith('HTTP/1.1 200')).toBe(true);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) => target.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

function connectStatus(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    }, 2000);
  });
}
