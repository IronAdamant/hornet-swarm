import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { authorisationSchema, credentialRequestSchema, domainCovered, projectDomainsAuthorised, projectSchema, authorisationStatus } from '@hornet-swarm/core';
import { writeAudit } from './audit.js';
import { setSecret } from './broker.js';
import { HornetError } from './errors.js';
import { aegisHome, ensureDir } from './home.js';
import { cardsFromForm, saveSwarmBoard, swarmBoardHtml } from './swarm.js';

type CredentialRequest = {
  id: string;
  project: string;
  label: string;
  reason: string;
  status: 'pending' | 'ready' | 'declined' | 'expired';
  createdAt: number;
  tokenHash: string;
  tokenUsed: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
let boundPort = 7781;

export type OperatorGateStatus = 'waiting' | 'declined' | 'touchid' | 'ready';

type OperatorGate = {
  id: string;
  project: string;
  label: string;
  reason: string;
  tokenHash: string;
  notified: boolean;
  status: OperatorGateStatus;
  code?: string;
};

const operatorGates = new Map<string, OperatorGate>();

export function openOperatorGate(input: { project: string; label: string; reason: string }): { id: string; token: string } {
  const token = randomBytes(24).toString('hex');
  const id = randomUUID();
  operatorGates.set(id, {
    id,
    project: input.project,
    label: input.label,
    reason: input.reason,
    tokenHash: hashToken(token),
    notified: false,
    status: 'waiting',
  });
  return { id, token };
}

export function operatorGateView(id: string, token: string): { status: OperatorGateStatus; code?: string } | undefined {
  const gate = findGate(id, token);
  if (!gate) return undefined;
  if (gate.status === 'ready' && gate.code) {
    const code = gate.code;
    gate.code = undefined;
    return { status: 'ready', code };
  }
  return { status: gate.status };
}

export function markOperatorNeeded(home: string, id: string, token: string, port = boundPort): boolean {
  const gate = findGate(id, token);
  if (!gate) return false;
  if (!gate.notified) {
    gate.notified = true;
    notifyOperator(home, gate.project, gate.label, port, token);
  }
  return true;
}

export function submitOperatorCode(
  home: string,
  token: string,
  input: { decision?: string; code?: string },
): { status: number; message: string } {
  const gate = findGateByToken(token);
  if (!gate || gate.status !== 'waiting') {
    return { status: 403, message: 'This link is missing or has already been used.' };
  }
  if (input.decision === 'decline') {
    gate.status = 'declined';
    gate.code = undefined;
    return { status: 200, message: 'The request was declined.' };
  }
  const confirmed = attemptTouchId(touchLog(home));
  if (!confirmed) {
    gate.status = 'touchid';
    gate.code = undefined;
    return { status: 401, message: 'Touch ID was not confirmed.' };
  }
  const code = input.code ?? '';
  if (!code) return { status: 400, message: 'Enter the code from the text or the email.' };
  gate.status = 'ready';
  gate.code = code;
  return { status: 200, message: 'The code was accepted. You can close this page.' };
}

function findGate(id: string, token: string): OperatorGate | undefined {
  const gate = operatorGates.get(id);
  if (!gate || !token || gate.tokenHash !== hashToken(token)) return undefined;
  return gate;
}

function findGateByToken(token: string): OperatorGate | undefined {
  if (!token) return undefined;
  const hash = hashToken(token);
  for (const gate of operatorGates.values()) {
    if (gate.tokenHash === hash) return gate;
  }
  return undefined;
}

export async function requestCredentials(input: unknown, home = aegisHome()): Promise<{ id: string; waiting: true }> {
  const parsed = credentialRequestSchema.safeParse(input);
  if (!parsed.success) throw new HornetError('A credential request only accepts a project, a label, and a reason.', 3);
  const { project, label, reason } = parsed.data;
  assertProjectAuthorised(project, home);
  const port = await ensureCredentialPage(home);
  const token = randomBytes(24).toString('hex');
  const record: CredentialRequest = {
    id: randomUUID(),
    project,
    label,
    reason,
    status: 'pending',
    createdAt: Date.now(),
    tokenHash: hashToken(token),
    tokenUsed: false,
  };
  const requests = readRequests(home);
  requests.push(record);
  writeRequests(home, requests);
  notifyOwner(home, project, label, reason, port, token);
  writeAudit({ interface: 'cli', action: 'request_credentials', project, labels: [label], result: 'pending' }, undefined, home);
  return { id: record.id, waiting: true };
}

export function credentialStatus(id: string, home = aegisHome()): { id: string; waiting?: true; status?: 'ready' | 'declined' | 'expired' } {
  const requests = readRequests(home);
  const record = requests.find((entry) => entry.id === id);
  if (!record) return { id, status: 'expired' };
  if (record.status === 'pending' && Date.now() - record.createdAt > DAY_MS) {
    record.status = 'expired';
    writeRequests(home, requests);
  }
  if (record.status === 'pending') return { id, waiting: true };
  return { id, status: record.status };
}

export function storeOwnerLogin(
  project: string,
  label: string,
  username: string,
  password: string,
  totp: string | undefined,
  home = aegisHome(),
): { ok: true; label: string; status: 'ready' } {
  assertProjectAuthorised(project, home);
  setSecret(project, label, 'username', username, home);
  setSecret(project, label, 'password', password, home);
  if (totp) setSecret(project, label, 'totp_secret', totp, home);
  mark(home, project, label, 'ready');
  writeAudit({ interface: 'cli', action: 'credential_stored', project, labels: [label], result: 'ready' }, undefined, home);
  return { ok: true, label, status: 'ready' };
}

export async function ensureCredentialPage(_home = aegisHome()): Promise<number> {
  const port = Number(process.env.AEGIS_CREDENTIAL_PORT ?? 7781);
  if (await listening(port)) return port;
  const cli = fileURLToPath(new URL('../../cli/dist/main.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'creds', 'serve'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await listening(port)) return port;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new HornetError('The login page did not start.', 4);
}

function listening(port: number): Promise<boolean> {
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

export function startCredentialPage(home = aegisHome(), port = 7781): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void handlePage(req, res, home).catch(() => send(res, 500, 'The page could not be shown.'));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      boundPort = bound;
      resolve({
        port: bound,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

async function handlePage(req: IncomingMessage, res: ServerResponse, home: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/v1/operator-code' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as { project?: string; label?: string; reason?: string };
    if (!body.project || !body.label) {
      send(res, 400, 'A project and a label are required.');
      return;
    }
    const opened = openOperatorGate({
      project: body.project,
      label: body.label,
      reason: body.reason || 'A texted or emailed code is needed.',
    });
    sendJson(res, 200, opened);
    return;
  }
  const codeMatch = url.pathname.match(/^\/v1\/operator-code\/([^/]+)$/);
  if (codeMatch) {
    const id = decodeURIComponent(codeMatch[1] ?? '');
    const token = url.searchParams.get('token') ?? '';
    if (req.method === 'POST') {
      const found = markOperatorNeeded(home, id, token, boundPort);
      send(res, found ? 200 : 404, found ? 'waiting' : 'Not found.');
      return;
    }
    if (req.method === 'GET') {
      const view = operatorGateView(id, token);
      if (!view) {
        send(res, 404, 'Not found.');
        return;
      }
      sendJson(res, 200, view);
      return;
    }
    send(res, 405, 'Method not allowed.');
    return;
  }
  if (url.pathname === '/codes') {
    await handleOperatorCode(req, res, home, url);
    return;
  }
  if (url.pathname === '/setup') {
    await handleSetup(req, res, home, url);
    return;
  }
  if (url.pathname !== '/requests') {
    send(res, 404, 'Not found.');
    return;
  }
  const token = url.searchParams.get('token') ?? '';
  const record = findToken(home, token);
  if (!record || record.tokenUsed) {
    send(res, 403, 'This link is missing or has already been used.');
    return;
  }
  if (req.method === 'GET') {
    send(res, 200, form(record), 'text/html; charset=utf-8');
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, 'Method not allowed.');
    return;
  }
  const body = new URLSearchParams(await readBody(req));
  const decision = body.get('decision');
  if (decision === 'decline') {
    consume(home, record.id, 'declined');
    send(res, 200, 'The request was declined.');
    return;
  }
  const site = body.get('site') ?? '';
  let hostname: string;
  try {
    hostname = new URL(site).hostname;
  } catch {
    send(res, 400, 'Enter a full site address.');
    return;
  }
  if (!hostAuthorised(record.project, hostname, home)) {
    send(res, 400, 'That site is not authorised.');
    return;
  }
  consume(home, record.id, 'pending');
  const confirmed = attemptTouchId(touchLog(home));
  if (!confirmed) {
    send(res, 401, 'Touch ID was not confirmed.');
    return;
  }
  const username = body.get('username') ?? '';
  const password = body.get('password') ?? '';
  const totp = body.get('totp') ?? '';
  if (!username || !password) {
    send(res, 400, 'Username and password are required.');
    return;
  }
  storeOwnerLogin(record.project, record.label, username, password, totp || undefined, home);
  send(res, 200, 'Saved. You can close this page.');
}

async function handleSetup(req: IncomingMessage, res: ServerResponse, home: string, url: URL): Promise<void> {
  if (req.method === 'GET') {
    send(res, 200, swarmBoardHtml(url.searchParams.get('project') ?? 'fixture', home), 'text/html; charset=utf-8');
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, 'Method not allowed.');
    return;
  }
  const body = new URLSearchParams(await readBody(req));
  const confirmed = attemptTouchId(touchLog(home));
  if (!confirmed) {
    send(res, 401, 'Touch ID was not confirmed. Nothing was saved.');
    return;
  }
  try {
    const view = saveSwarmBoard(
      {
        project: body.get('project') ?? '',
        website: body.get('website') ?? '',
        cards: cardsFromForm(body),
        selectors: {
          username: body.get('selector_username') ?? '',
          password: body.get('selector_password') ?? '',
          submit: body.get('selector_submit') ?? '',
          success: body.get('selector_success') ?? '',
        },
      },
      home,
    );
    send(res, 200, `Ready. ${view.agents.length} login${view.agents.length === 1 ? '' : 's'} stored for ${view.website}. Agents can see the site and the personalities.`);
  } catch (error) {
    const message = error instanceof HornetError ? error.message : 'The board could not be saved.';
    send(res, 400, message);
  }
}

async function handleOperatorCode(req: IncomingMessage, res: ServerResponse, home: string, url: URL): Promise<void> {
  const token = url.searchParams.get('token') ?? '';
  const gate = findGateByToken(token);
  if (!gate || gate.status !== 'waiting') {
    send(res, 403, 'This link is missing or has already been used.');
    return;
  }
  if (req.method === 'GET') {
    send(res, 200, codeForm(gate), 'text/html; charset=utf-8');
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, 'Method not allowed.');
    return;
  }
  const body = new URLSearchParams(await readBody(req));
  const result = submitOperatorCode(home, token, { decision: body.get('decision') ?? undefined, code: body.get('code') ?? undefined });
  send(res, result.status, result.message);
}

function codeForm(gate: OperatorGate): string {
  return `<!doctype html><html><head><title>Hornet Swarm code</title></head><body>
<h1>Enter the texted or emailed code</h1>
<p>${escapeText(gate.project)} · ${escapeText(gate.label)}</p>
<p>${escapeText(gate.reason)}</p>
<form method="post">
<label>Code <input name="code" autocomplete="one-time-code" inputmode="numeric"></label>
<button name="decision" value="save">Submit code</button>
<button name="decision" value="decline">Decline</button>
</form></body></html>`;
}

function notifyOperator(home: string, project: string, label: string, port: number, token: string): void {
  const reason = 'A texted or emailed code is needed.';
  const notice = { project, label, reason, url: `http://127.0.0.1:${port}/codes?token=${token}`, at: new Date().toISOString() };
  appendFileSync(join(ensureDir(home), 'notifications.log'), `${JSON.stringify(notice)}\n`);
  const script = `display notification ${JSON.stringify(reason)} with title ${JSON.stringify(`Hornet Swarm ${project}`)} subtitle ${JSON.stringify(label)}`;
  try {
    execFileSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 5_000 });
  } catch {
    // The notification log is the captured copy when Notification Center is unavailable.
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function form(record: CredentialRequest): string {
  return `<!doctype html><html><head><title>Hornet Swarm login</title></head><body>
<h1>Enter a test login</h1>
<p>${escapeText(record.project)} · ${escapeText(record.label)}</p>
<p>${escapeText(record.reason)}</p>
<form method="post">
<label>Site <input name="site" type="url" required></label>
<label>Username <input name="username" autocomplete="off"></label>
<label>Password <input name="password" type="password" autocomplete="off"></label>
<label>Authenticator secret <input name="totp" type="password" autocomplete="off"></label>
<button name="decision" value="save">Save</button>
<button name="decision" value="decline">Decline</button>
</form></body></html>`;
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function attemptTouchId(logFile: string): boolean {
  const source = `import LocalAuthentication
import Foundation
let context = LAContext()
var error: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
  fputs((error?.localizedDescription ?? "Touch ID is not available") + "\\n", stderr)
  exit(1)
}
let sem = DispatchSemaphore(value: 0)
var ok = false
context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Confirm Hornet Swarm credential entry") { success, evalError in
  ok = success
  if let evalError { fputs(evalError.localizedDescription + "\\n", stderr) }
  sem.signal()
}
sem.wait()
exit(ok ? 0 : 1)
`;
  const file = join(tmpdir(), `hornet-swarm-touch-${process.pid}.swift`);
  writeFileSync(file, source);
  try {
    execFileSync('swift', [file], { timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : '';
    const message = error instanceof Error ? error.message : String(error);
    ensureDir(join(logFile, '..'));
    appendFileSync(logFile, `${new Date().toISOString()} ${stderr || message}\n`);
    return false;
  } finally {
    rmSync(file, { force: true });
  }
}

function touchLog(home: string): string {
  return process.env.AEGIS_TOUCHID_LOG ?? join(home, 'touchid.log');
}

function notifyOwner(home: string, project: string, label: string, reason: string, port: number, token: string): void {
  const notice = { project, label, reason, url: `http://127.0.0.1:${port}/requests?token=${token}`, at: new Date().toISOString() };
  appendFileSync(join(ensureDir(home), 'notifications.log'), `${JSON.stringify(notice)}\n`);
  const script = `display notification ${JSON.stringify(reason)} with title ${JSON.stringify(`Hornet Swarm ${project}`)} subtitle ${JSON.stringify(label)}`;
  try {
    execFileSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 5_000 });
  } catch {
    // The notification log is the captured copy when Notification Center is unavailable.
  }
}

function assertProjectAuthorised(projectId: string, home: string): void {
  const project = projectSchema.parse(parse(readFileSync(join(home, 'projects', projectId, 'project.yaml'), 'utf8')));
  const auth = authorisationSchema.parse(parse(readFileSync(join(home, 'authorisations', `${project.authorisation_id}.yaml`), 'utf8')));
  const decision = projectDomainsAuthorised(project, auth);
  if (!decision.ok) throw new HornetError(decision.reason, 3);
}

function hostAuthorised(projectId: string, hostname: string, home: string): boolean {
  try {
    const project = projectSchema.parse(parse(readFileSync(join(home, 'projects', projectId, 'project.yaml'), 'utf8')));
    const auth = authorisationSchema.parse(parse(readFileSync(join(home, 'authorisations', `${project.authorisation_id}.yaml`), 'utf8')));
    if (!authorisationStatus(auth).ok) return false;
    return domainCovered(auth, hostname);
  } catch {
    return false;
  }
}

function findToken(home: string, token: string): CredentialRequest | undefined {
  if (!token) return undefined;
  const hash = hashToken(token);
  return readRequests(home).find((entry) => entry.tokenHash === hash && entry.status === 'pending');
}

function consume(home: string, id: string, status: CredentialRequest['status']): void {
  const requests = readRequests(home);
  const record = requests.find((entry) => entry.id === id);
  if (!record) return;
  record.tokenUsed = true;
  if (status !== 'pending') record.status = status;
  writeRequests(home, requests);
  if (status === 'declined') writeAudit({ interface: 'cli', action: 'credential_declined', project: record.project, labels: [record.label], result: 'declined' }, undefined, home);
}

function mark(home: string, project: string, label: string, status: 'ready'): void {
  const requests = readRequests(home);
  const record = [...requests].reverse().find((entry) => entry.project === project && entry.label === label && entry.status === 'pending');
  if (!record) return;
  record.status = status;
  writeRequests(home, requests);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function readRequests(home: string): CredentialRequest[] {
  try {
    return JSON.parse(readFileSync(join(home, 'credential-requests.json'), 'utf8')) as CredentialRequest[];
  } catch {
    return [];
  }
}

function writeRequests(home: string, requests: CredentialRequest[]): void {
  ensureDir(home);
  writeFileSync(join(home, 'credential-requests.json'), `${JSON.stringify(requests)}\n`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
