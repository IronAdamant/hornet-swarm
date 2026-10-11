import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import JSZip from 'jszip';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { Redactor } from '@hornet-swarm/core';

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
    if (entry.isDirectory()) found.push(...walkFiles(path));
    else found.push(path);
  }
  return found;
}

export async function redactTree(dir: string, redactor: Redactor): Promise<void> {
  for (const file of walkFiles(dir)) {
    if (file.endsWith('.zip')) await redactZip(file, redactor);
    else if (file.endsWith('.png')) redactPng(file, redactor);
    else redactText(file, redactor);
  }
}

export async function scanTree(dir: string, redactor: Redactor): Promise<string[]> {
  const hits: string[] = [];
  for (const file of walkFiles(dir)) {
    const bytes = readFileSync(file);
    if (redactor.contains(bytes.toString('utf8')) || redactor.contains(bytes.toString('latin1'))) {
      hits.push(file);
      continue;
    }
    if (!file.endsWith('.zip')) continue;
    try {
      const zip = await JSZip.loadAsync(bytes);
      for (const name of Object.keys(zip.files)) {
        const entry = zip.files[name];
        if (!entry || entry.dir) continue;
        const text = await entry.async('string');
        if (redactor.contains(text)) hits.push(`${file}!${name}`);
      }
    } catch {
      hits.push(file);
    }
  }
  return hits;
}

export function quarantineFile(file: string): void {
  unlinkSync(file);
  writeFileSync(`${file}.quarantined`, 'quarantined\n');
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
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, await zip.generateAsync({ type: 'nodebuffer' }));
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

function redactText(file: string, redactor: Redactor): void {
  const raw = readFileSync(file);
  const text = raw.toString('utf8');
  const latin = raw.toString('latin1');
  if (!redactor.contains(text) && !redactor.contains(latin)) return;
  writeFileSync(file, redactor.redact(text));
}

function redactPng(file: string, redactor: Redactor): void {
  const text = ocr(file);
  if (redactor.contains(text)) writeFileSync(file, PLACEHOLDER_PNG);
}

async function redactZip(file: string, redactor: Redactor): Promise<void> {
  const zip = await JSZip.loadAsync(readFileSync(file));
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (!entry || entry.dir) continue;
    if (name.endsWith('.png')) {
      const bytes = await entry.async('nodebuffer');
      const temp = `${file}.${name.replace(/[^\w.]+/g, '_')}.ocr.png`;
      writeFileSync(temp, bytes);
      const text = ocr(temp);
      unlinkSync(temp);
      if (redactor.contains(text) || redactor.contains(bytes.toString('latin1'))) zip.file(name, PLACEHOLDER_PNG);
      continue;
    }
    const text = await entry.async('string');
    zip.file(name, redactor.redact(text));
  }
  const next = await zip.generateAsync({ type: 'nodebuffer' });
  if (redactor.contains(next.toString('latin1'))) {
    unlinkSync(file);
    writeFileSync(`${file}.dropped`, 'trace dropped because redaction could not clean it\n');
    return;
  }
  writeFileSync(file, next);
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
