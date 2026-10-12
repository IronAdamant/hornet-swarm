import { parse } from 'yaml';
import { interactiveOriginAllowed } from './policy.js';
import { journeySchema, type Journey, type Project } from './schemas.js';

export type JourneyValidation = { valid: boolean; errors: string[]; journey?: Journey };

export function validateJourneyDocument(
  input: unknown,
  project: Project,
  knownSecrets: string[] = [],
): JourneyValidation {
  const parsed = journeySchema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
  }
  const journey = parsed.data;
  const errors: string[] = [];
  journey.steps.forEach((step, index) => {
    if ('fill' in step) {
      const modes = [step.fill.value, step.fill.credential, step.fill.totp].filter((value) => value !== undefined);
      if (modes.length !== 1) errors.push(`step ${index}: fill needs exactly one of value, credential, or totp`);
      if (step.fill.credential && !/^[a-z0-9-]+\.[a-z_]+$/i.test(step.fill.credential)) {
        errors.push(`step ${index}: credential must look like qa-user-1.password or self.password`);
      }
      if (step.fill.totp && !/^(qa-user-\d+|self)$/.test(step.fill.totp)) {
        errors.push(`step ${index}: totp must be a user label or self`);
      }
      if (step.fill.value && knownSecrets.some((secret) => secret.length >= 1 && step.fill.value?.includes(secret))) {
        errors.push(`step ${index}: literal value matches a stored secret`);
      }
    }
    if ('screenshot' in step && knownSecrets.some((secret) => secret.length >= 1 && step.screenshot.name.includes(secret))) {
      errors.push(`step ${index}: literal value matches a stored secret`);
    }
    if ('navigate' in step && /^[a-z][a-z0-9+.-]*:/i.test(step.navigate.url)) {
      const decision = interactiveOriginAllowed(project, step.navigate.url);
      if (!decision.ok) errors.push(`step ${index}: ${decision.reason}`);
    }
    if ('upload' in step && (step.upload.fixture.includes('..') || step.upload.fixture.startsWith('/'))) {
      errors.push(`step ${index}: fixture path must stay inside the fixtures directory`);
    }
  });
  return errors.length === 0 ? { valid: true, errors: [], journey } : { valid: false, errors };
}

export function validateJourneyYaml(text: string, project: Project, knownSecrets: string[] = []): JourneyValidation {
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : 'invalid yaml'] };
  }
  return validateJourneyDocument(document, project, knownSecrets);
}

/** `self.password` and `fill.totp: self` mean the label running the journey, so one journey can serve many accounts. */
export function resolveSelf(handle: string, label: string): string {
  if (handle === 'self') return label;
  return handle.startsWith('self.') ? `${label}${handle.slice(4)}` : handle;
}
