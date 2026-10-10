import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

export type ProxyOptions = {
  port: number;
  allow: string[];
  rps: number;
  log?: (entry: Record<string, unknown>) => void;
};

export function hostAllowed(host: string, allow: string[]): boolean {
  const name = host.trim().toLowerCase().replace(/\.+$/, '');
  return allow.some((entry) => entry.trim().toLowerCase() === name);
}

export function startEgressProxy(options: ProxyOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const allow = options.allow;
  const bucket = new TokenBucket(options.rps);
  const log = options.log ?? ((entry) => process.stdout.write(`${JSON.stringify(entry)}\n`));

  const server = createServer((req, res) => {
    void forwardHttp(req, res, allow, bucket, log);
  });

  server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const target = req.url ?? '';
    const [host, portText] = target.split(':');
    const port = Number(portText ?? 443);
    if (!host || !hostAllowed(host, allow)) {
      log({ event: 'deny', host: host ?? '', port, proto: 'connect' });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.end();
      return;
    }
    if (!bucket.take()) {
      log({ event: 'rate_limited', host, port, proto: 'connect' });
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.end();
      return;
    }
    log({ event: 'allow', host, port, proto: 'connect' });
    const upstream = netConnect(port, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => {
      socket.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '0.0.0.0', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

async function forwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  allow: string[],
  bucket: TokenBucket,
  log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  const urlText = req.url ?? '';
  let target: URL;
  try {
    target = new URL(urlText);
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  if (!hostAllowed(target.hostname, allow)) {
    log({ event: 'deny', host: target.hostname, port: target.port, proto: 'http' });
    res.writeHead(403);
    res.end('blocked');
    return;
  }
  if (!bucket.take()) {
    log({ event: 'rate_limited', host: target.hostname, proto: 'http' });
    res.writeHead(429);
    res.end('rate limited');
    return;
  }
  log({ event: 'allow', host: target.hostname, port: target.port || '80', proto: 'http' });
  const headers = { ...req.headers };
  delete headers['proxy-connection'];
  const upstream = netConnect(Number(target.port || 80), target.hostname, () => {
    const head = `${req.method ?? 'GET'} ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`;
    upstream.write(head);
    req.pipe(upstream);
  });
  upstream.on('data', (chunk) => res.write(chunk));
  upstream.on('end', () => res.end());
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
}

class TokenBucket {
  private tokens: number;
  private updated = Date.now();

  constructor(private readonly rps: number) {
    this.tokens = Math.max(1, rps);
  }

  take(): boolean {
    const now = Date.now();
    const elapsed = (now - this.updated) / 1000;
    this.updated = now;
    this.tokens = Math.min(this.rps, this.tokens + elapsed * this.rps);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export function startControlGateway(options: { port: number; project: string }): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const requested = req.url ?? '/';
    const pathOnly = requested.split('?')[0] ?? '/';
    const match = /^\/r\/([a-z0-9-]+)(\/.*)?$/.exec(pathOnly);
    if (!match?.[1]) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const label = match[1];
    const suffix = `${match[2] && match[2].length > 0 ? match[2] : '/'}${requested.includes('?') ? `?${requested.split('?')[1]}` : ''}`;
    const upstream = httpRequest(
      {
        host: `aegis-${options.project}-${label}`,
        port: 8787,
        path: suffix,
        method: req.method,
        headers: { ...req.headers, host: `aegis-${options.project}-${label}:8787` },
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '0.0.0.0', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function isDirectRun(): boolean {
  if (process.env.AEGIS_PROXY_MAIN === '1') return true;
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const allow = (process.env.AEGIS_ALLOW_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  const port = Number(process.env.AEGIS_PROXY_PORT ?? 8888);
  const rps = Number(process.env.AEGIS_RPS ?? 20);
  void startEgressProxy({ port, allow, rps });
  void startControlGateway({
    port: Number(process.env.AEGIS_CONTROL_PORT ?? 8899),
    project: process.env.AEGIS_PROJECT ?? 'default',
  });
}
