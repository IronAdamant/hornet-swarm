// Compile-time proofs, checked by `pnpm typecheck` against the built packages.
import { findingsMarkdown, verifyFindings, type Finding, type SavedRun } from '../../packages/report/dist/index.js';

declare const input: unknown;
declare const runs: ReadonlyMap<string, SavedRun>;
declare const finding: Finding;

findingsMarkdown(verifyFindings(input, runs).verified);

// @ts-expect-error A finding is rendered only after verifyFindings found its evidence.
findingsMarkdown([finding]);
// @ts-expect-error An object shaped like a verified finding is still not one.
findingsMarkdown([{ finding, reproduction: [] }]);
