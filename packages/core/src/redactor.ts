const HEADER_NAMES = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);

export type RegisteredSecret = { label: string; value: string };

export class Redactor {
  private forms: { form: string; token: string }[] = [];

  register(label: string, value: string): void {
    if (!value) return;
    const token = `[REDACTED:${label}]`;
    const forms = new Set<string>([value, encodeURIComponent(value), Buffer.from(value, 'utf8').toString('base64')]);
    forms.add(JSON.stringify(value).slice(1, -1));
    forms.add(htmlEscape(value));
    if (label.endsWith('.username')) forms.add(value.toLowerCase());
    for (const form of forms) {
      if (form.length < 4) continue;
      this.forms.push({ form, token });
    }
    this.forms.sort((left, right) => right.form.length - left.form.length);
  }

  registerAll(secrets: RegisteredSecret[]): void {
    for (const secret of secrets) this.register(secret.label, secret.value);
  }

  redact(input: string): string {
    let output = input;
    const seen = new Set<string>();
    for (const { form, token } of this.forms) {
      if (seen.has(form) || !output.includes(form)) continue;
      seen.add(form);
      output = output.split(form).join(token);
    }
    return output;
  }

  contains(input: string): boolean {
    return this.forms.some(({ form }) => form.length > 0 && input.includes(form));
  }

  redactUnknown(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((entry) => this.redactUnknown(entry));
    if (value && typeof value === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (HEADER_NAMES.has(key.toLowerCase())) {
          output[key] = '[REDACTED:header]';
          continue;
        }
        if (key === 'value' || key === 'password' || key === 'secret' || key === 'totp_secret') {
          output[key] = '[REDACTED:field]';
          continue;
        }
        output[key] = this.redactUnknown(entry);
      }
      return output;
    }
    return value;
  }
}

export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function maskHeader(name: string, value: string, redactor: Redactor): string {
  if (HEADER_NAMES.has(name.toLowerCase())) return '[REDACTED:header]';
  return redactor.redact(value);
}
