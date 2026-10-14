export type TemplateContext = {
  vars?: Record<string, string>;
  users?: Record<string, { vars?: Record<string, string> }>;
  /** `{{run.id}}` and `{{run.label}}`, so a sign-up journey can use a fresh made-up email on every run. */
  run?: { id: string; label: string };
};

export function renderTemplate(input: string, context: TemplateContext): string {
  return input.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, raw: string) => {
    const path = raw.trim().split('.');
    if (path[0] === 'vars' && path.length === 2) return context.vars?.[path[1] ?? ''] ?? match;
    // {{date.+30}} is the date 30 days from today, so a booking journey never asks for a past date.
    if (path[0] === 'date' && path.length === 2 && /^[+-]\d{1,4}$/.test(path[1] ?? '')) {
      const day = new Date(Date.now() + Number(path[1]) * 86_400_000);
      return day.toISOString().slice(0, 10);
    }
    // {{self.vars.city}} is the running label's own value, so one journey checks each account's details.
    if (path[0] === 'self' && path[1] === 'vars' && path.length === 3 && context.run) {
      return context.users?.[context.run.label]?.vars?.[path[2] ?? ''] ?? match;
    }
    if (path[0] === 'run' && path.length === 2 && (path[1] === 'id' || path[1] === 'label')) return context.run?.[path[1]] ?? match;
    // {{run.tag}} is the run id's last part, such as 7f1685, for sites that limit how long a username may be.
    if (path[0] === 'run' && path[1] === 'tag' && path.length === 2 && context.run) return context.run.id.split('_').pop() ?? context.run.id;
    if (path[0] === 'users' && path[2] === 'vars' && path.length === 4) {
      return context.users?.[path[1] ?? '']?.vars?.[path[3] ?? ''] ?? match;
    }
    return match;
  });
}
