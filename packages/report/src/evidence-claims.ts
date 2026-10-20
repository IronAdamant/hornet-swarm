import { stepStatusSchema, type RunResult } from '@hornet-swarm/core';
import { z } from 'zod';

/** The one functional and chaos scale, from docs/severity.md. */
export const SEVERITIES = ['High', 'Medium', 'Low'] as const;

const RUN_ID = z.string().regex(/^run_[A-Za-z0-9_-]+$/, 'a run id looks like run_20261014-211436_0139bb');
const NAME = z.string().regex(/^[a-z0-9-]+$/, 'a label or journey id is lower-case letters, digits, and dashes');
const RELATIVE_PATH = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), 'a file is named by its path inside the run folder');

export const evidenceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('step'), run: RUN_ID, label: NAME, journey: NAME, step: z.number().int().nonnegative(), status: stepStatusSchema }).strict(),
  z.object({ kind: z.literal('signin'), run: RUN_ID, label: NAME, status: stepStatusSchema }).strict(),
  z.object({ kind: z.literal('quote'), run: RUN_ID, label: NAME, journey: NAME.optional(), step: z.number().int().nonnegative().optional(), text: z.string().min(4) }).strict(),
  z.object({ kind: z.literal('file'), run: RUN_ID, path: RELATIVE_PATH }).strict(),
]);

export const findingSchema = z
  .object({
    id: z.string().regex(/^[A-Z]+-\d+$/, 'a finding id looks like F-01'),
    severity: z.enum(SEVERITIES),
    title: z.string().min(1),
    claim: z.string().min(1),
    evidence: z.array(evidenceRefSchema).min(1, 'a finding needs at least one piece of evidence from a saved run'),
  })
  .strict();

export const findingsInputSchema = z.object({ project: NAME, findings: z.array(findingSchema).min(1) }).strict();

export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type Finding = z.infer<typeof findingSchema>;

/** One saved run, as the controller reads it from disk. */
export type SavedRun = {
  result: RunResult;
  /** The page text saved for a step: the failure snapshot and the text beside any named screenshot. */
  pageTexts: (label: string, journeyId: string, step: number) => string[];
  hasFile: (relativePath: string) => boolean;
};

/** How often a cited outcome happened across every saved run of the project that reached it. */
export type Reproduction = { label: string; where: string; status: string; matched: number; reached: number };

/**
 * A finding whose every piece of evidence was found in a saved run. The private field makes the
 * type nominal, so `verifyFindings` is the only way to get one and the renderer takes nothing else.
 */
export class VerifiedFinding {
  readonly #verified = true;

  private constructor(
    readonly finding: Finding,
    readonly reproduction: readonly Reproduction[],
  ) {}

  static verifyAll(input: unknown, runs: ReadonlyMap<string, SavedRun>): { project?: string; verified: VerifiedFinding[]; problems: string[] } {
    const parsed = findingsInputSchema.safeParse(input);
    if (!parsed.success) return { verified: [], problems: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'findings'}: ${issue.message}`) };
    const { project, findings } = parsed.data;
    const problems: string[] = [];
    const verified: VerifiedFinding[] = [];
    for (const finding of findings) {
      const own = finding.evidence.flatMap((ref) => {
        const problem = refProblem(ref, project, runs);
        return problem ? [`${finding.id}: ${problem}`] : [];
      });
      if (own.length > 0) problems.push(...own);
      else verified.push(new VerifiedFinding(finding, reproductionOf(finding, runs)));
    }
    return { project, verified, problems };
  }

  /** True only for a finding `verifyAll` made, so a plain object shaped like one is refused at run time too. */
  static isVerified(value: unknown): value is VerifiedFinding {
    return typeof value === 'object' && value !== null && #verified in value;
  }
}

export function verifyFindings(input: unknown, runs: ReadonlyMap<string, SavedRun>): ReturnType<typeof VerifiedFinding.verifyAll> {
  return VerifiedFinding.verifyAll(input, runs);
}

function refProblem(ref: EvidenceRef, project: string, runs: ReadonlyMap<string, SavedRun>): string | undefined {
  const saved = runs.get(ref.run);
  if (!saved || saved.result.project !== project) return `${ref.run} is not a saved run of ${project}.`;
  if (ref.kind === 'file') return saved.hasFile(ref.path) ? undefined : `${ref.run} has no file ${ref.path}.`;
  const user = saved.result.users.find((entry) => entry.label === ref.label);
  if (!user) return `${ref.run} did not run ${ref.label}.`;
  if (ref.kind === 'signin') {
    return user.phase1.status === ref.status ? undefined : `${ref.run} recorded ${ref.label}'s sign-in as ${user.phase1.status}, not ${ref.status}.`;
  }
  if (ref.kind === 'quote' && ref.journey === undefined) {
    return contains([user.phase1.error ?? ''], ref.text) ? undefined : `${ref.run} has no sign-in text for ${ref.label} that reads "${ref.text}".`;
  }
  const journey = user.journeys.find((entry) => entry.id === ref.journey);
  if (!journey) return `${ref.run} did not run ${ref.journey} for ${ref.label}.`;
  if (ref.step === undefined) return `a quote from ${ref.journey} names the step it came from.`;
  const step = journey.steps.find((entry) => entry.index === ref.step);
  if (!step) return `${ref.run} recorded no step ${ref.step} in ${ref.journey} for ${ref.label}.`;
  if (ref.kind === 'step') {
    return step.status === ref.status ? undefined : `${ref.run} recorded ${ref.label} · ${ref.journey} · step ${ref.step} as ${step.status}, not ${ref.status}.`;
  }
  const texts = [step.error ?? '', ...saved.pageTexts(ref.label, journey.id, step.index)];
  return contains(texts, ref.text) ? undefined : `${ref.run} saved no page text or error for ${ref.label} · ${ref.journey} · step ${ref.step} that reads "${ref.text}".`;
}

function contains(texts: string[], quote: string): boolean {
  const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
  const wanted = squash(quote);
  return texts.some((text) => squash(text).includes(wanted));
}

function reproductionOf(finding: Finding, runs: ReadonlyMap<string, SavedRun>): Reproduction[] {
  const seen = new Map<string, Reproduction>();
  for (const ref of finding.evidence) {
    if (ref.kind !== 'step' && ref.kind !== 'signin') continue;
    const where = ref.kind === 'step' ? `${ref.journey} · step ${ref.step}` : 'sign-in';
    const key = `${ref.label}|${where}|${ref.status}`;
    if (seen.has(key)) continue;
    let matched = 0;
    let reached = 0;
    for (const saved of runs.values()) {
      const user = saved.result.users.find((entry) => entry.label === ref.label);
      const status =
        ref.kind === 'signin'
          ? user?.phase1.status
          : user?.journeys.find((entry) => entry.id === ref.journey)?.steps.find((entry) => entry.index === ref.step)?.status;
      if (!status) continue;
      reached += 1;
      if (status === ref.status) matched += 1;
    }
    seen.set(key, { label: ref.label, where, status: ref.status, matched, reached });
  }
  return [...seen.values()];
}

/** Markdown for verified findings only. Each one lists its evidence and how often it happened. */
export function findingsMarkdown(findings: readonly VerifiedFinding[]): string {
  if (!findings.every((finding) => VerifiedFinding.isVerified(finding))) throw new Error('Only findings from verifyFindings can be rendered.');
  const sections = findings.map(({ finding, reproduction }) => {
    const evidence = finding.evidence.map((ref) => `- ${describeRef(ref)}`);
    const seen = reproduction.map(
      (entry) => `- ${entry.label} · ${entry.where}: ${entry.status} in ${entry.matched} of ${entry.reached} saved ${entry.reached === 1 ? 'run' : 'runs'} that reached it.`,
    );
    return [`## ${finding.id} · ${finding.severity} · ${finding.title}`, '', finding.claim, '', 'Evidence:', ...evidence, ...(seen.length > 0 ? ['', 'How often:', ...seen] : [])].join('\n');
  });
  return `${sections.join('\n\n')}\n`;
}

function describeRef(ref: EvidenceRef): string {
  if (ref.kind === 'file') return `${ref.run} · file ${ref.path}`;
  if (ref.kind === 'signin') return `${ref.run} · ${ref.label} · sign-in: ${ref.status}`;
  if (ref.kind === 'step') return `${ref.run} · ${ref.label} · ${ref.journey} · step ${ref.step}: ${ref.status}`;
  return `${ref.run} · ${ref.label}${ref.journey ? ` · ${ref.journey} · step ${ref.step}` : ' · sign-in'}: "${ref.text}"`;
}

/**
 * The runner sits beside the browser, so its word alone is not a pass. A pass counts only when it
 * recorded every step of the journey it was sent, in order, and each one passed or was skipped.
 */
export function unsupportedPass(report: { status: string; steps: ReadonlyArray<{ index: number; status: string }> }, sentSteps: number): string | undefined {
  if (report.status !== 'passed') return undefined;
  if (report.steps.length !== sentSteps) return `The runner reported a pass but recorded ${report.steps.length} of ${sentSteps} steps.`;
  const wrong = report.steps.find((step, position) => step.index !== position || (step.status !== 'pass' && step.status !== 'skipped'));
  if (wrong) return `The runner reported a pass but recorded step ${wrong.index} as ${wrong.status}.`;
  return undefined;
}
