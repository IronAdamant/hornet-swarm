import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Redacted, RedactedBytes } from './redactor.js';

/**
 * The only module allowed to create files, folders, and sockets (eslint.config.js enforces it).
 * Every path is born owner-only. An existing path that other accounts can open, that is a
 * symbolic link, or that another non-root account owns is refused and left unchanged.
 */

export class InsecurePathError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'InsecurePathError';
  }
}

export type PathGuard = {
  /** Replaces the default message for a path that other accounts can open. */
  looseMessage?: string;
};

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SHARED_DIR_MODE = 0o770;
const OWNER_ONLY = 0o077;
const NO_OTHERS = 0o007;
const SOCKET_UMASK = 0o117;

/** Creates `path` and any missing parents at 0700, or checks that an existing folder is still private. */
export function privateDir(path: string, guard: PathGuard = {}): string {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  checkPath(path, 'dir', OWNER_ONLY, guard);
  return path;
}

/** Creates one new 0700 folder and throws EEXIST if anything is already there. Locks rely on that failure. */
export function exclusivePrivateDir(path: string): string {
  mkdirSync(path, { mode: PRIVATE_DIR_MODE });
  return path;
}

/**
 * A folder someone else picked and may own, such as an `--out` folder or the runner's mounted
 * /out. A missing folder is made at 0700; an existing one is used as it is.
 */
export function chosenDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  return path;
}

/** A folder shared with one group, such as the runner's control socket folder. Other accounts get nothing. */
export function groupSharedDir(path: string, guard: PathGuard = {}): string {
  mkdirSync(path, { recursive: true, mode: SHARED_DIR_MODE });
  checkPath(path, 'dir', NO_OTHERS, guard);
  return path;
}

/** Throws unless `path` is a real file or folder, owned by this account or root, with no group or other bits. */
export function assertPrivatePath(path: string, kind: 'file' | 'dir', guard: PathGuard = {}): void {
  checkPath(path, kind, OWNER_ONLY, guard);
}

export type WriteOptions = {
  /**
   * `private` (the default) creates a missing parent at 0700 and refuses a parent that is a link or
   * another account's. `chosen` is a folder the owner named, such as `--out ~/Desktop`: it is
   * created at 0700 if missing, and an existing one's mode is the owner's business.
   */
  parent?: 'private' | 'chosen';
};

/**
 * Writes a state file at 0600, such as the lease table, a token, or a runtime setting. A run's
 * reports and artifacts go through writeRedactedFile instead. The bytes go to a new file opened
 * with O_EXCL and are renamed into place, so a reader never sees half a file and a link at `path`
 * is replaced rather than followed.
 */
export function writePrivateFile(path: string, data: string | Uint8Array, options: WriteOptions = {}): void {
  prepareParent(path, options.parent ?? 'private');
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(), PRIVATE_FILE_MODE);
  try {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    closeSync(fd);
    renameSync(temp, path);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Already closed before the rename failed.
    }
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Replaces a file's contents without changing its inode. A file bind-mounted into a container,
 * such as a runner's control token, must keep its inode, or the container goes on reading the old
 * one. A missing file is created at 0600; an existing one must already be private.
 */
export function rewritePrivateFileInPlace(path: string, data: string, guard: PathGuard = {}): void {
  prepareParent(path, 'private');
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(), PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    checkPath(path, 'file', OWNER_ONLY, guard);
    fd = openSync(path, constants.O_WRONLY | noFollow());
  }
  try {
    checkStats(fstatSync(fd), path, 'file', OWNER_ONLY, guard);
    ftruncateSync(fd, 0);
    const bytes = Buffer.from(data, 'utf8');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
  } finally {
    closeSync(fd);
  }
}

/** Appends to a 0600 log. An existing log that is a link, another account's, or open to others is refused. */
export function appendPrivateFile(path: string, data: string): void {
  prepareParent(path, 'private');
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow(), PRIVATE_FILE_MODE);
  try {
    checkStats(fstatSync(fd), path, 'file', OWNER_ONLY, {});
    appendFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** A run's report or artifact. Only Redactor.seal, Redactor.sealBytes, and fixedText make this content type. */
export function writeRedactedFile(path: string, content: Redacted | RedactedBytes, options: WriteOptions = {}): void {
  writePrivateFile(path, content, options);
}

export function appendRedactedFile(path: string, content: Redacted): void {
  appendPrivateFile(path, content);
}

/**
 * Reads a regular file without following a link. A runner can replace a result file with a link
 * to anything on this machine; `readFileSync` would copy that target into the run.
 */
export function readRegularFile(path: string): Buffer {
  const fd = openNoFollow(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | noFollow());
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new InsecurePathError(`${path} is not a regular file.`, path);
    return readWholeFile(fd);
  } finally {
    closeSync(fd);
  }
}

/** Copies `from` into a new 0600 file at `to`. The source's mode is never carried over, and a link is not followed. */
export function copyPrivateFile(from: string, to: string): void {
  writePrivateFile(to, readRegularFile(from));
}

/**
 * Copies a folder tree into private folders and 0600 files. Links are skipped, never followed,
 * because a runner could write one pointing anywhere on this Mac.
 */
export function copyPrivateTree(from: string, to: string): void {
  privateDir(to);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyPrivateTree(source, target);
    else if (entry.isFile()) copyPrivateFile(source, target);
  }
}

/** A fresh folder under the system temp folder. mkdtemp always creates it at 0700. */
export function privateTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Runs `bind` under a umask that makes a Unix socket 0660 the moment it exists, so there is no
 * window between bind and chmod. `bind` must call listen synchronously.
 */
export function withSocketUmask<T>(bind: () => T): T {
  const previous = process.umask(SOCKET_UMASK);
  try {
    return bind();
  } finally {
    process.umask(previous);
  }
}

/** Throws unless `path` is a Unix socket owned by this account or root that other accounts cannot open. */
export function assertGroupSocket(path: string): void {
  checkPath(path, 'socket', NO_OTHERS, {});
}

function prepareParent(path: string, parent: 'private' | 'chosen'): void {
  const folder = dirname(path);
  if (parent === 'chosen') {
    chosenDir(folder);
    return;
  }
  if (!existsSync(folder)) {
    privateDir(folder);
    return;
  }
  // The folder may have been private when it was made and opened up since. Refuse it before writing.
  checkPath(folder, 'dir', OWNER_ONLY, {});
}

function checkPath(path: string, kind: PathKind, forbidden: number, guard: PathGuard): void {
  checkStats(lstatSync(path), path, kind, forbidden, guard);
}

type PathKind = 'file' | 'dir' | 'socket';

function checkStats(stats: Stats, path: string, kind: PathKind, forbidden: number, guard: PathGuard): void {
  if (stats.isSymbolicLink()) throw new InsecurePathError(`${path} is a symbolic link. Hornet Swarm does not follow links for private files.`, path);
  if (kind === 'dir' && !stats.isDirectory()) throw new InsecurePathError(`${path} is not a folder.`, path);
  if (kind === 'file' && !stats.isFile()) throw new InsecurePathError(`${path} is not a regular file.`, path);
  if (kind === 'socket' && !stats.isSocket()) throw new InsecurePathError(`${path} is not a socket.`, path);
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid && stats.uid !== 0) {
    throw new InsecurePathError(`${path} belongs to another account (uid ${stats.uid}).`, path);
  }
  if ((stats.mode & forbidden) !== 0) {
    const fix = kind === 'dir' ? `chmod -R go-rwx '${path}'` : kind === 'socket' ? `chmod 660 '${path}'` : `chmod 600 '${path}'`;
    throw new InsecurePathError(guard.looseMessage ?? `${path} is open to other accounts (mode ${(stats.mode & 0o777).toString(8)}). Check nothing was read, then run: ${fix}`, path);
  }
}

function noFollow(): number {
  return constants.O_NOFOLLOW ?? 0;
}

function openNoFollow(path: string, flags: number, mode?: number): number {
  try {
    return mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new InsecurePathError(`${path} is a symbolic link. Hornet Swarm does not follow links for private files.`, path);
    }
    throw error;
  }
}

/** `readFileSync` on a descriptor starts at the current offset, which is not always zero. */
function readWholeFile(fd: number): Buffer {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(64 * 1024);
  let offset = 0;
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, offset);
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    offset += n;
  }
  return Buffer.concat(chunks);
}
