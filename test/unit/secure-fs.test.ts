import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendPrivateFile,
  assertGroupSocket,
  chosenDir,
  copyPrivateTree,
  fixedText,
  groupSharedDir,
  InsecurePathError,
  privateDir,
  Redactor,
  rewritePrivateFileInPlace,
  withSocketUmask,
  writePrivateFile,
  writeRedactedFile,
} from '../../packages/core/src/index.ts';

const mode = (path: string): number => lstatSync(path).mode & 0o777;
const scratch = (): string => mkdtempSync(join(tmpdir(), 'hornet-secure-fs-'));

describe('secure-fs creates private paths at creation', () => {
  it('makes folders 0700 and files 0600 whatever the umask is', () => {
    const previous = process.umask(0o000);
    try {
      const root = scratch();
      const folder = privateDir(join(root, 'a', 'b'));
      expect(mode(join(root, 'a'))).toBe(0o700);
      expect(mode(folder)).toBe(0o700);
      writePrivateFile(join(folder, 'state.json'), '{}');
      expect(mode(join(folder, 'state.json'))).toBe(0o600);
      appendPrivateFile(join(folder, 'audit.log'), 'line\n');
      expect(mode(join(folder, 'audit.log'))).toBe(0o600);
      writeRedactedFile(join(root, 'chosen', 'evidence.zip'), fixedText('zip\n'), { parent: 'chosen' });
      expect(mode(join(root, 'chosen', 'evidence.zip'))).toBe(0o600);
      expect(mode(chosenDir(join(root, 'out')))).toBe(0o700);
    } finally {
      process.umask(previous);
    }
  });

  it('refuses a folder other accounts can open, and leaves its mode alone', () => {
    const root = scratch();
    const loose = join(root, 'home');
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    expect(() => privateDir(loose)).toThrow(InsecurePathError);
    expect(() => privateDir(loose)).toThrow(/chmod -R go-rwx/);
    expect(mode(loose)).toBe(0o755);
    expect(() => privateDir(loose, { looseMessage: 'custom' })).toThrow('custom');
  });

  it('refuses a link where a private folder or file belongs, and never writes through it', () => {
    const root = scratch();
    const elsewhere = privateDir(join(root, 'elsewhere'));
    symlinkSync(elsewhere, join(root, 'linked'));
    expect(() => privateDir(join(root, 'linked'))).toThrow(/symbolic link/);
    expect(() => writePrivateFile(join(root, 'linked', 'file'), 'x')).toThrow(/symbolic link/);

    const target = join(elsewhere, 'target');
    writeFileSync(target, 'original');
    const link = join(privateDir(join(root, 'home')), 'token');
    symlinkSync(target, link);
    expect(() => rewritePrivateFileInPlace(link, 'new')).toThrow(/symbolic link/);
    expect(() => appendPrivateFile(link, 'new')).toThrow();
    writePrivateFile(link, 'replaced');
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('original');
  });

  it('refuses a loose file before rewriting it in place, and keeps the inode of a private one', () => {
    const root = privateDir(join(scratch(), 'tokens'));
    const file = join(root, 'qa-user-1.token');
    rewritePrivateFileInPlace(file, 'first\n');
    const inode = statSync(file).ino;
    rewritePrivateFileInPlace(file, 'second\n');
    expect(statSync(file).ino).toBe(inode);
    expect(readFileSync(file, 'utf8')).toBe('second\n');
    chmodSync(file, 0o644);
    expect(() => rewritePrivateFileInPlace(file, 'third\n')).toThrow(InsecurePathError);
    expect(readFileSync(file, 'utf8')).toBe('second\n');
  });

  it('copies a tree into private paths and skips links a runner left in it', () => {
    const root = scratch();
    const source = join(root, 'source');
    mkdirSync(join(source, 'nested'), { recursive: true, mode: 0o755 });
    writeFileSync(join(source, 'nested', 'shot.txt'), 'text', { mode: 0o644 });
    symlinkSync('/etc/passwd', join(source, 'escape'));
    const destination = join(root, 'copy');
    copyPrivateTree(source, destination);
    expect(mode(join(destination, 'nested'))).toBe(0o700);
    expect(mode(join(destination, 'nested', 'shot.txt'))).toBe(0o600);
    expect(() => lstatSync(join(destination, 'escape'))).toThrow();
  });

  it('shares a socket folder with one group only, and binds the socket 0660 with no window', async () => {
    const root = scratch();
    const folder = groupSharedDir(join(root, 'control'));
    expect(mode(folder) & 0o707).toBe(0o700);
    const open = join(root, 'open');
    mkdirSync(open, { mode: 0o777 });
    chmodSync(open, 0o777);
    expect(() => groupSharedDir(open)).toThrow(InsecurePathError);

    const socketPath = join(folder, 'runner.sock');
    const server = createServer();
    withSocketUmask(() => server.listen(socketPath));
    await new Promise((done) => server.once('listening', done));
    try {
      expect(mode(socketPath)).toBe(0o660);
      expect(() => assertGroupSocket(socketPath)).not.toThrow();
      chmodSync(socketPath, 0o666);
      expect(() => assertGroupSocket(socketPath)).toThrow(InsecurePathError);
    } finally {
      server.close();
    }
  });

  it('writes a report only as sealed content', () => {
    const redactor = new Redactor();
    redactor.register('qa-user-1.password', 'correct-horse-battery');
    const folder = privateDir(join(scratch(), 'run'));
    writeRedactedFile(join(folder, 'summary.md'), redactor.seal('typed correct-horse-battery into the form'));
    expect(readFileSync(join(folder, 'summary.md'), 'utf8')).toBe('typed [REDACTED:qa-user-1.password] into the form');
  });
});
