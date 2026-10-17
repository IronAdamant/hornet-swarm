import { readFileSync, readSync } from 'node:fs';

/** A control token is one short line. A longer read is not a token. */
const MAX_TOKEN_BYTES = 4096;

export type ControlTokenSource = { file?: string; fd?: number };

/**
 * Reads the runner control token. An open descriptor is preferred: the entrypoint opens the
 * token as root, then drops to the runner user. On Linux that user cannot read a host-owned
 * mode-0600 bind mount, but the descriptor stays readable and still sees an in-place rotation.
 * With no descriptor, the path is read. Any failure returns an empty string, which refuses the request.
 */
export function readControlToken(source: ControlTokenSource): string {
  if (isTokenFd(source.fd)) {
    try {
      const buffer = Buffer.alloc(MAX_TOKEN_BYTES);
      const read = readSync(source.fd, buffer, 0, MAX_TOKEN_BYTES, 0);
      return buffer.subarray(0, read).toString('utf8').trim();
    } catch {
      return '';
    }
  }
  if (!source.file) return '';
  try {
    return readFileSync(source.file, 'utf8').trim();
  } catch {
    return '';
  }
}

/** The descriptor the entrypoint exports. Standard streams are never a token descriptor. */
export function controlTokenFd(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const fd = Number(raw);
  return fd >= 3 ? fd : undefined;
}

/** What `main` passes to the control server. A descriptor wins over the path. */
export function tokenSourceFromEnv(env: NodeJS.ProcessEnv): ControlTokenSource {
  const file = env.AEGIS_CONTROL_TOKEN_FILE || undefined;
  const fd = controlTokenFd(env.AEGIS_CONTROL_TOKEN_FD);
  return fd === undefined ? { file } : { file, fd };
}

function isTokenFd(fd: number | undefined): fd is number {
  return typeof fd === 'number' && Number.isInteger(fd) && fd >= 3;
}
