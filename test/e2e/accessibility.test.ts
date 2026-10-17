import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analysisSchema } from '../../packages/core/dist/index.js';
import { hornet, clearSignins, journeys, readRun, resetFixture, secret } from './helper.js';

beforeAll(async () => {
  clearSignins();
  await resetFixture();
});

type Step = { type: string; status: string; error?: string; accessibility?: { name: string; violations: { rule: string; impact: string; count: number }[] } };

function stepsOf(result: Record<string, unknown>): Step[] {
  return (result.users as { journeys: { steps: Step[] }[] }[]).flatMap((user) => user.journeys.flatMap((journey) => journey.steps));
}

function findFile(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    } else if (entry.name === name) return path;
  }
  return undefined;
}

describe('the accessibility step', () => {
  it('records planted faults without failing the journey, and lists them in the summary', () => {
    const run = hornet(['suite', '--project', 'fixture', '--json', '--journey', join(journeys, 'a11y.journey.yaml')]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const report = readRun();
    analysisSchema.parse(report.analysis);
    const check = stepsOf(report.result).find((step) => step.type === 'accessibility');
    expect(check?.status).toBe('pass');
    const rules = check?.accessibility?.violations.map((violation) => violation.rule) ?? [];
    for (const rule of ['image-alt', 'label', 'button-name', 'color-contrast']) expect(rules, rule).toContain(rule);
    expect(check?.accessibility?.violations[0]?.impact).toBe('critical');
    expect(report.summary).toContain('but the accessibility check found problems');
    expect(report.summary).toContain('Accessibility · planted-page (/a11y):');
    expect(report.summary).toContain('Images must have alternative text');
    expect(report.summary).not.toContain(secret);
    const file = findFile(report.dir, 'accessibility-planted-page.json');
    expect(file).toBeTruthy();
    const saved = JSON.parse(readFileSync(file as string, 'utf8')) as { standard: string; violations: { id: string; nodes: { target: string; html: string }[] }[]; wcag22?: { focus_not_obscured: { checked: number } } };
    expect(saved.standard).toBe('wcag22aa');
    expect(saved.wcag22?.focus_not_obscured.checked).toBeGreaterThan(0);
    expect(saved.violations.find((violation) => violation.id === 'label')?.nodes[0]?.target).toBe('#nameless');
    expect(readFileSync(join(report.dir, 'analysis.md'), 'utf8')).toContain('Accessibility: wcag22aa');
  });

  it('fails the step on fail_on and leaves out excluded parts of the page', () => {
    const run = hornet(['journey', join(journeys, 'a11y-strict.journey.yaml'), '--project', 'fixture', '--json']);
    expect(run.status).toBe(1);
    const check = stepsOf(readRun().result).find((step) => step.type === 'accessibility');
    expect(check?.status).toBe('fail');
    expect(check?.error).toMatch(/^accessibility: 2 problems at or above critical/);
    const rules = check?.accessibility?.violations.map((violation) => violation.rule) ?? [];
    expect(rules).toContain('image-alt');
    expect(rules).not.toContain('button-name');
  });
});
