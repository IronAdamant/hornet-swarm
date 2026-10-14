import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { authorisationSchema, globalConfigSchema, journeySchema, projectSchema } from '../../packages/core/src/schemas.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readYaml(path: string): unknown {
  return parse(readFileSync(path, 'utf8'));
}

describe('example configs match the schemas', () => {
  it('parses the global config', () => {
    const value = globalConfigSchema.parse(readYaml(join(root, 'examples/config.yaml')));
    expect(value.runtime).toBe('auto');
    expect(value.default_project).toBe('example-app');
  });

  it('parses the example project', () => {
    const value = projectSchema.parse(readYaml(join(root, 'examples/projects/example-app/project.yaml')));
    expect(value.users).toHaveLength(10);
    expect(value.phase2.gate).toBe('all');
    expect(value.targets.base_url).toBe('https://staging.example.com');
  });

  it('parses both authorisation records', () => {
    const owner = authorisationSchema.parse(readYaml(join(root, 'examples/authorisations/example-app-owner.yaml')));
    const client = authorisationSchema.parse(readYaml(join(root, 'examples/authorisations/client-staging-contract.yaml')));
    expect(owner.basis).toBe('owner');
    expect(client.basis).toBe('contract');
    expect(owner.scope.domains).toContain('localhost');
  });

  it('parses both example journeys', () => {
    const signin = journeySchema.parse(
      readYaml(join(root, 'examples/journeys/example-app/01-signin-dashboard.journey.yaml')),
    );
    const isolation = journeySchema.parse(
      readYaml(join(root, 'examples/journeys/example-app/02-tenant-isolation.journey.yaml')),
    );
    expect(signin.id).toBe('signin-dashboard');
    expect(signin.steps.length).toBeGreaterThan(5);
    expect(isolation.id).toBe('tenant-isolation');
    expect(isolation.steps.some((step) => 'assert' in step && step.assert.type === 'access_denied')).toBe(true);
  });
});
