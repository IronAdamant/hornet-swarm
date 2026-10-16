import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import JSZip from 'jszip';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import {
  fixedText,
  matchGlob,
  quoteBrokenCardJson,
  Redactor,
  SESSION_HEADER_NAMES,
  UnredactableError,
  writeRedactedFile,
  type Redacted,
  type RedactedBytes,
} from '@hornet-swarm/core';

const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export function walkFiles(dir: string): string[] {
  const found: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    // A link written by a runner could point anywhere on this Mac. It is never read or rewritten.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) found.push(...walkFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/** Masks every file in place. Returns the files that masking could not clean; each was quarantined. */
export async function redactTree(dir: string, redactor: Redactor): Promise<string[]> {
  const withheld: string[] = [];
  for (const file of walkFiles(dir)) {
    const done = file.endsWith('.zip') ? await redactZip(file, redactor) : file.endsWith('.png') ? redactPng(file, redactor) : redactText(file, redactor);
    if (done === 'withheld') withheld.push(file);
  }
  return withheld;
}

export async function scanTree(dir: string, redactor: Redactor): Promise<string[]> {
  const hits: string[] = [];
  for (const file of walkFiles(dir)) {
    const bytes = readFileSync(file);
    if (file.endsWith('.zip')) {
      hits.push(...(await scanZipBuffer(bytes, redactor, file)));
      continue;
    }
    if (redactor.contains(bytes.toString('utf8')) || redactor.contains(bytes.toString('latin1'))) hits.push(file);
  }
  return hits;
}

/** A trace saved inside an evidence zip is a zip entry. Scan it the same way as a file on disk. */
async function scanZipBuffer(bytes: Buffer, redactor: Redactor, label: string): Promise<string[]> {
  const hits: string[] = [];
  if (redactor.contains(bytes.toString('utf8')) || redactor.contains(bytes.toString('latin1'))) hits.push(label);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    if (hits.length === 0) hits.push(label);
    return hits;
  }
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (!entry || entry.dir) continue;
    const data = await entry.async('nodebuffer');
    const where = `${label}!${name}`;
    if (name.endsWith('.zip')) {
      hits.push(...(await scanZipBuffer(data, redactor, where)));
      continue;
    }
    if (redactor.contains(data.toString('utf8')) || redactor.contains(data.toString('latin1'))) hits.push(where);
  }
  return hits;
}

export function quarantineFile(file: string): void {
  unlinkSync(file);
  writeRedactedFile(`${file}.quarantined`, fixedText('quarantined\n'));
}

export async function writeEvidenceZip(sourceDir: string, destination: string, redactor: Redactor): Promise<void> {
  const hits = await scanTree(sourceDir, redactor);
  if (hits.length > 0) throw new Error('evidence failed the redaction scan');
  const zip = new JSZip();
  const skipped = resolve(destination);
  const files = walkFiles(sourceDir)
    .filter((file) => resolve(file) !== skipped)
    .map((file) => {
    const data = readFileSync(file);
    const path = relative(sourceDir, file);
    zip.file(path, data);
    return { path, sha256: createHash('sha256').update(data).digest('hex') };
  });
  zip.file('manifest.json', `${JSON.stringify({ created_at: new Date().toISOString(), files }, null, 2)}\n`);
  writeRedactedFile(destination, redactor.sealBytes(await zip.generateAsync({ type: 'nodebuffer' })), { parent: 'chosen' });
}

export function compareScreenshots(before: Buffer, after: Buffer): { visual: 'same' | 'changed'; ratio: number } {
  const left = PNG.sync.read(before);
  const right = PNG.sync.read(after);
  if (left.width !== right.width || left.height !== right.height) return { visual: 'changed', ratio: 1 };
  const diff = new PNG({ width: left.width, height: left.height });
  const mismatches = pixelmatch(left.data, right.data, diff.data, left.width, left.height, { threshold: 0.1 });
  const ratio = mismatches / (left.width * left.height);
  return { visual: ratio > 0.01 ? 'changed' : 'same', ratio };
}

export function timingChanged(beforeMs: number, afterMs: number): boolean {
  return afterMs - beforeMs > 300 && afterMs > beforeMs * 1.2;
}

type Outcome = 'kept' | 'rewritten' | 'withheld';

/** Writes sealed content over `file`, or quarantines `file` when `seal` finds a secret it cannot mask. */
function replaceOrQuarantine(file: string, seal: () => Redacted | RedactedBytes): Outcome {
  try {
    writeRedactedFile(file, seal());
    return 'rewritten';
  } catch (error) {
    if (!(error instanceof UnredactableError)) throw error;
    quarantineFile(file);
    return 'withheld';
  }
}

function redactText(file: string, redactor: Redactor): Outcome {
  const raw = readFileSync(file);
  const text = raw.toString('utf8');
  const latin = raw.toString('latin1');
  if (redactor.contains(text) || redactor.contains(latin)) return replaceOrQuarantine(file, () => redactor.seal(text));
  // A card token saved with no quotes is not a secret any more. Quoting it keeps the HAR parseable.
  const repaired = quoteBrokenCardJson(text);
  if (repaired === text) return 'kept';
  return replaceOrQuarantine(file, () => redactor.seal(repaired));
}

function redactPng(file: string, redactor: Redactor): Outcome {
  if (!redactor.contains(ocr(file))) return 'kept';
  return replaceOrQuarantine(file, () => redactor.sealBytes(PLACEHOLDER_PNG));
}

const IMAGE_ENTRY = /\.(png|jpe?g|webp)$/i;

/**
 * Rewrites only the entries that still hold a secret. Text entries are redacted in place.
 * Image entries, including the screencast JPEG frames, are read with OCR and replaced when
 * they show a secret. Any other binary entry that holds a secret is dropped. Every other
 * entry keeps its original bytes, so the trace viewer can still open the file.
 */
async function redactZip(file: string, redactor: Redactor): Promise<Outcome> {
  const zip = await JSZip.loadAsync(readFileSync(file));
  if (!(await redactLoadedZip(zip, redactor))) return 'kept';
  const next = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  try {
    writeRedactedFile(file, redactor.sealBytes(next));
    return 'rewritten';
  } catch (error) {
    if (!(error instanceof UnredactableError)) throw error;
    unlinkSync(file);
    writeRedactedFile(`${file}.dropped`, fixedText('trace dropped because redaction could not clean it\n'));
    return 'rewritten';
  }
}

async function redactLoadedZip(zip: JSZip, redactor: Redactor): Promise<boolean> {
  let changed = false;
  const images: { name: string; bytes: Buffer }[] = [];
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (!entry || entry.dir) continue;
    const bytes = await entry.async('nodebuffer');
    if (name.endsWith('.zip')) {
      try {
        const nested = await JSZip.loadAsync(bytes);
        if (await redactLoadedZip(nested, redactor)) {
          zip.file(name, await nested.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
          changed = true;
        }
        continue;
      } catch {
        // Not a zip. Fall through and treat the bytes like any other entry.
      }
    }
    if (IMAGE_ENTRY.test(name)) {
      images.push({ name, bytes });
      continue;
    }
    const text = strictUtf8(bytes);
    if (text !== undefined) {
      const next = redactor.contains(text) ? redactor.redact(text) : quoteBrokenCardJson(text);
      if (next === text) continue;
      zip.file(name, next);
      changed = true;
      continue;
    }
    if (redactor.contains(bytes.toString('latin1'))) {
      zip.remove(name);
      zip.file(`${name}.dropped`, 'dropped because it held a secret\n');
      changed = true;
    }
  }
  const flagged = await mapLimit(images, 4, async ({ name, bytes }) =>
    redactor.contains(bytes.toString('latin1')) || redactor.contains(await ocrBuffer(bytes)) ? name : undefined,
  );
  for (const name of flagged) {
    if (!name) continue;
    zip.file(name, PLACEHOLDER_PNG);
    changed = true;
  }
  return changed;
}

function strictUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(lanes);
  return results;
}

function ocr(file: string): string {
  try {
    return execFileSync('tesseract', [file, 'stdout', '-l', 'eng'], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

/** Reads a frame through tesseract's stdin, so the unmasked frame is never written to disk. */
function ocrBuffer(bytes: Buffer): Promise<string> {
  return new Promise<string>((done) => {
    const child = execFile('tesseract', ['stdin', 'stdout', '-l', 'eng'], { encoding: 'utf8', timeout: 30_000 }, (error, stdout) => done(error ? '' : stdout));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(bytes);
  });
}

const SESSION_HEADERS = SESSION_HEADER_NAMES;
const AUTH_BODY = '[REDACTED:auth_endpoint]';

type HarLike = {
  request?: { url?: string; headers?: { name: string; value: string }[]; cookies?: unknown[]; postData?: Record<string, unknown> };
  response?: { headers?: { name: string; value: string }[]; cookies?: unknown[]; content?: Record<string, unknown> };
};

/**
 * Masks session headers and cookies in every request, and drops request and response bodies
 * for URLs that match the project's auth_endpoints. Applies to network.har files and to the
 * network log inside trace.zip. A rewritten file is also sealed with `redactor`. Returns how
 * many bodies were dropped.
 */
export async function sanitizeNetworkLogs(dir: string, authEndpoints: string[], redactor: Redactor): Promise<number> {
  let dropped = 0;
  for (const file of walkFiles(dir)) {
    if (file.endsWith('.har')) {
      let har: { log?: { entries?: HarLike[] } };
      try {
        har = JSON.parse(readFileSync(file, 'utf8')) as typeof har;
      } catch {
        continue;
      }
      const sha1s = new Set<string>();
      for (const entry of har.log?.entries ?? []) dropped += sanitizeEntry(entry, authEndpoints, sha1s);
      replaceOrQuarantine(file, () => redactor.seal(JSON.stringify(har)));
      continue;
    }
    if (!file.endsWith('.zip')) continue;
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(readFileSync(file));
    } catch {
      continue;
    }
    const sha1s = new Set<string>();
    let changed = false;
    for (const name of Object.keys(zip.files)) {
      if (!name.endsWith('.network') || zip.files[name]?.dir) continue;
      const lines = (await zip.files[name]!.async('string')).split('\n');
      const next = lines.map((line) => {
        if (!line.trim()) return line;
        try {
          const event = JSON.parse(line) as { snapshot?: HarLike };
          if (!event.snapshot) return line;
          dropped += sanitizeEntry(event.snapshot, authEndpoints, sha1s);
          return JSON.stringify(event);
        } catch {
          return line;
        }
      });
      zip.file(name, next.join('\n'));
      changed = true;
    }
    for (const sha1 of sha1s) {
      for (const name of Object.keys(zip.files)) {
        if (name === `resources/${sha1}` || name.startsWith(`resources/${sha1}.`)) zip.remove(name);
      }
    }
    if (changed) {
      const next = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      replaceOrQuarantine(file, () => redactor.sealBytes(next));
    }
  }
  return dropped;
}

function sanitizeEntry(entry: HarLike, authEndpoints: string[], sha1s: Set<string>): number {
  for (const side of [entry.request, entry.response]) {
    if (!side) continue;
    side.headers = (side.headers ?? []).map((header) =>
      SESSION_HEADERS.has(header.name.toLowerCase()) ? { ...header, value: '[REDACTED:header]' } : header,
    );
    if (side.cookies) side.cookies = [];
  }
  const url = entry.request?.url ?? '';
  if (!authEndpoints.some((pattern) => matchGlob(pattern, url))) return 0;
  const request = entry.request;
  if (request?.postData) {
    if (typeof request.postData._sha1 === 'string') sha1s.add(request.postData._sha1);
    request.postData = { mimeType: request.postData.mimeType ?? '', text: AUTH_BODY };
  }
  const response = entry.response;
  if (response?.content) {
    if (typeof response.content._sha1 === 'string') sha1s.add(response.content._sha1);
    response.content = { size: 0, mimeType: response.content.mimeType ?? '', text: AUTH_BODY };
  }
  return 1;
}
