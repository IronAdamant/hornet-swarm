/**
 * A client report lists issues found on the pages tested. It never says a site meets a standard,
 * because automated checks and a sample of pages cannot show that. These are the words that would
 * say it, in any form, including a denial such as "this is not a compliance certificate": a reader
 * skimming for the word still finds it.
 */
const FORBIDDEN_CLAIMS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bcomplian(?:t|ce|cy)\b/i, why: 'claims or mentions compliance' },
  { pattern: /\bnon-?complian(?:t|ce)\b/i, why: 'claims or mentions compliance' },
  { pattern: /\bcertif(?:y|ied|ies|ication|icate|icates)\b/i, why: 'claims or mentions certification' },
  { pattern: /\baccredit(?:ed|ation)?\b/i, why: 'claims accreditation' },
  { pattern: /\bconforman(?:t|ce)\b/i, why: 'claims conformance' },
  { pattern: /\bconform(?:s|ing)?\s+(?:to|with)\s+(?:the\s+)?WCAG\b/i, why: 'claims conformance' },
  { pattern: /\bfully accessible\b/i, why: 'claims the site is fully accessible' },
  { pattern: /\b(?:meets|passes|passed|satisfies)\s+(?:all\s+(?:of\s+)?)?(?:the\s+)?WCAG\b/i, why: 'claims the site meets WCAG' },
  { pattern: /\bWCAG(?:\s+2\.[0-2])?(?:\s+A{1,3})?\s+(?:approved|verified|passed)\b/i, why: 'claims the site passed WCAG' },
];

export type ForbiddenClaim = { text: string; why: string; index: number };

export function forbiddenClaims(text: string): ForbiddenClaim[] {
  const found: ForbiddenClaim[] = [];
  for (const { pattern, why } of FORBIDDEN_CLAIMS) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(global)) found.push({ text: match[0], why, index: match.index ?? 0 });
  }
  return found.sort((left, right) => left.index - right.index);
}

export class ForbiddenClaimError extends Error {
  constructor(
    readonly where: string,
    readonly claims: ForbiddenClaim[],
  ) {
    super(`${where} ${claims.map((claim) => `"${claim.text}" (${claim.why})`).join(', ')}. A report lists issues found against WCAG 2.2 AA on the tested pages; it never claims a site meets a standard.`);
    this.name = 'ForbiddenClaimError';
  }
}

/** Throws when the text would tell a reader the site is compliant, certified, or meets WCAG. */
export function assertNoComplianceClaim(text: string, where: string): void {
  const claims = forbiddenClaims(text);
  if (claims.length > 0) throw new ForbiddenClaimError(where, claims);
}
