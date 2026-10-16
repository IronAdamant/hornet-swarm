import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** An owner-authorised `fixture` project for the offline test app, with one label, qa-user-1. */
export function writeAuthorisedProject(home: string): void {
  const projectDir = join(home, 'projects', 'fixture');
  mkdirSync(join(home, 'authorisations'), { recursive: true, mode: 0o700 });
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  const documentBody = 'Fixture owner authorisation for the offline test app.\n';
  writeFileSync(join(home, 'authorisations', 'fixture-owner.txt'), documentBody);
  const documentHash = createHash('sha256').update(documentBody).digest('hex');
  writeFileSync(join(home, 'authorisations', 'fixture-owner.yaml'), `id: fixture-owner
basis: owner
client: Iron Adamant (self-owned)
authoriser:
  name: Aron Amos
  role: Owner
  email: aron.amos@ironadamant.com
granted_to: Aron Amos (Iron Adamant)
scope:
  domains: [localhost, host.docker.internal]
  environments: [test]
activities: [signin_smoke]
exclusions: []
valid_from: "2026-01-01"
valid_until: "2027-12-31"
document:
  path: fixture-owner.txt
  sha256: "${documentHash}"
notes: Local fixture only.
`);
  writeFileSync(join(projectDir, 'project.yaml'), `id: fixture
name: Fixture
authorisation_id: fixture-owner
environment: test
targets:
  base_url: http://127.0.0.1:4173
  allowed_origins:
    - http://127.0.0.1:4173
  allowed_third_party: []
auth:
  signin_url: /login
  selectors:
    username: "#email"
    password: "#password"
    submit: "role=button[name='Sign in']"
  success:
    - { type: url_contains, value: "/dashboard" }
  auth_endpoints: ["**/login"]
  totp:
    enabled: false
runners:
  count: 1
  memory: 1g
  cpus: 1
limits:
  max_parallel_runners: 1
  max_requests_per_second_per_runner: 5
  max_requests_per_second_total: 20
  min_step_delay_ms: 50
  max_run_duration_min: 30
  max_signin_attempts_per_user_per_hour: 30
phase2:
  gate: all
journeys_dir: ./journeys
users:
  - { label: qa-user-1, role: consultant, tenant: A1, vars: { tenant_slug: a1 } }
`);
}
