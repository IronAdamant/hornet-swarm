import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parse } from 'yaml';
import { authorisationSchema, authorisationStatus, domainCovered, projectSchema, type Authorisation, type PolicyResult, type Project } from '@hornet-swarm/core';
import { HornetError } from './errors.js';

const AUTHORISATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function loadProject(projectId: string, home: string): Project {
  if (!/^[a-z0-9-]+$/.test(projectId)) throw new HornetError('Unknown project.', 3);
  return projectSchema.parse(parse(readFileSync(join(home, 'projects', projectId, 'project.yaml'), 'utf8')));
}

export function loadAuthorisation(id: string, home: string): Authorisation {
  if (!AUTHORISATION_ID.test(id)) throw new HornetError('authorisation_id must be a file name, not a path.', 3);
  return authorisationSchema.parse(parse(readFileSync(join(home, 'authorisations', `${id}.yaml`), 'utf8')));
}

/** `~/` is this account's home. A relative path is read from `<home>/authorisations/`. */
export function documentPath(path: string, home: string): string {
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1));
  if (isAbsolute(path)) return path;
  return join(home, 'authorisations', path);
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The signed document must still be on this Mac and must be the one the record names. A missing
 * file or a different hash stops the run. The message gives the file's real hash, so the owner
 * can record it after checking the document is the right one.
 */
export function documentMatches(auth: Authorisation, home: string): PolicyResult {
  if (!auth.document) return { ok: true };
  const path = documentPath(auth.document.path, home);
  let actual: string;
  try {
    actual = sha256File(path);
  } catch {
    return { ok: false, reason: `authorisation_document_missing:${path}` };
  }
  if (actual !== auth.document.sha256.toLowerCase()) return { ok: false, reason: `authorisation_document_mismatch:${path} has sha256 ${actual}` };
  return { ok: true };
}

/** The authorisation is in force and its document is intact. Throws a policy error otherwise. */
export function assertAuthorisationUsable(auth: Authorisation, home: string, now = new Date()): void {
  const active = authorisationStatus(auth, now);
  if (!active.ok) throw new HornetError(active.reason, 3);
  const document = documentMatches(auth, home);
  if (!document.ok) throw new HornetError(document.reason, 3);
}

/** Whether a hostname is covered by the project's authorisation, which is in force and has its document. */
export function hostAuthorised(projectId: string, hostname: string, home: string): boolean {
  try {
    const project = loadProject(projectId, home);
    const auth = loadAuthorisation(project.authorisation_id, home);
    assertAuthorisationUsable(auth, home);
    return domainCovered(auth, hostname);
  } catch {
    return false;
  }
}
