import { parse } from 'yaml';
import { interactiveOriginAllowed } from './policy.js';
import { journeySchema, type Journey, type Project } from './schemas.js';
import { renderTemplate, type TemplateContext } from './template.js';

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
  const templateContext: TemplateContext = {
    vars: journey.vars,
    users: Object.fromEntries(project.users.map((user) => [user.label, { vars: user.vars }])),
    run: { id: 'run_validate', label: journey.users[0] ?? 'qa-user-1' },
  };
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
    if ('assert' in step && step.assert.type === 'field_value') {
      if (!step.assert.selector || step.assert.value === undefined) errors.push(`step ${index}: field_value needs a selector and a value`);
      if (step.assert.selector === project.auth.selectors.password) errors.push(`step ${index}: field_value may not read the password field`);
    }
    if ('assert' in step && step.assert.type !== 'field_value' && step.assert.selector !== undefined) {
      errors.push(`step ${index}: only field_value takes a selector`);
    }
    if ('select' in step) {
      const modes = [step.select.value, step.select.label].filter((value) => value !== undefined);
      if (modes.length !== 1) errors.push(`step ${index}: select needs exactly one of value or label`);
    }
    if ('screenshot' in step && knownSecrets.some((secret) => secret.length >= 1 && step.screenshot.name.includes(secret))) {
      errors.push(`step ${index}: literal value matches a stored secret`);
    }
    if ('navigate' in step) {
      // The URL is checked as the runner will open it: templates filled, then resolved against
      // the base URL, so `{{vars.site}}` and `//other.host/` are checked like a written address.
      const rendered = renderTemplate(step.navigate.url, templateContext);
      const decision = interactiveOriginAllowed(project, rendered);
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
