export type TemplateContext = {
  vars?: Record<string, string>;
  users?: Record<string, { vars?: Record<string, string> }>;
};

export function renderTemplate(input: string, context: TemplateContext): string {
  return input.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, raw: string) => {
    const path = raw.trim().split('.');
    if (path[0] === 'vars' && path.length === 2) return context.vars?.[path[1] ?? ''] ?? match;
    if (path[0] === 'users' && path[2] === 'vars' && path.length === 4) {
      return context.users?.[path[1] ?? '']?.vars?.[path[3] ?? ''] ?? match;
    }
    return match;
  });
}
