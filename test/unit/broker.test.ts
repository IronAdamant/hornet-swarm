import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { injectSecrets, listFields, listLabels, setSecret } from '../../packages/controller/src/broker.ts';

const secret = 's3cret"<&broker-value>';
const username = 'QA1@Example.TEST';

describe('secret broker', () => {
  it('stores with sops, injects over HTTP, and never returns a secret value', async () => {
    const home = mkdtempSync(join(homedir(), '.aegis', 'work-broker-'));
    const stored = setSecret('fixture', 'qa-user-1', 'password', secret, home);
    setSecret('fixture', 'qa-user-1', 'username', username, home);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(listLabels('fixture', home)).toEqual(['qa-user-1']);
    expect(listFields('fixture', 'qa-user-1', home).sort()).toEqual(['password', 'username']);
    const encrypted = readFileSync(join(home, 'projects', 'fixture', 'secrets.sops.yaml'), 'utf8');
    expect(encrypted).not.toContain(secret);
    expect(encrypted).not.toContain(username);

    const seen: string[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        seen.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, handles: ['qa-user-1.username', 'qa-user-1.password'] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const result = await injectSecrets('fixture', 'qa-user-1', `http://127.0.0.1:${address.port}`, home);
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(username);
    expect(result.handles).toEqual(['qa-user-1.username', 'qa-user-1.password']);
    const posted = JSON.parse(seen[0] ?? '{}') as { credentials: { handle: string; value: string }[] };
    expect(posted.credentials.find((entry) => entry.handle === 'qa-user-1.password')?.value).toBe(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    const pub = readFileSync(join(home, 'age.pub'), 'utf8');
    expect(pub.startsWith('age1')).toBe(true);
    expect(pub).not.toContain('AGE-SECRET-KEY-');
  });
});