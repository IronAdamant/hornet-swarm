import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setSecret } from '../../packages/controller/dist/broker.js';

const home = join(homedir(), '.aegis');
const port = 4173;
const password = 'FixtureOnly-s3cret"<&value>';
const password2 = 'FixtureOnly-other"<&value>';
const projectDir = join(home, 'projects', 'fixture');
mkdirSync(join(home, 'authorisations'), { recursive: true });
mkdirSync(projectDir, { recursive: true });

writeFileSync(
  join(home, 'authorisations', 'fixture-owner.yaml'),
  `id: fixture-owner
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
activities: [signin_smoke, functional_e2e, access_control_checks, chaos]
exclusions: []
valid_from: "2026-01-01"
valid_until: "2027-12-31"
document:
  path: fixture-owner.txt
  sha256: "0000000000000000000000000000000000000000000000000000000000000000"
notes: Local fixture only.
`,
);

writeFileSync(
  join(projectDir, 'project.yaml'),
  `id: fixture
name: Fixture
authorisation_id: fixture-owner
environment: test
targets:
  base_url: http://127.0.0.1:${port}
  allowed_origins:
    - http://127.0.0.1:${port}
    - http://host.docker.internal:${port}
  allowed_third_party: []
auth:
  signin_url: /login
  selectors:
    username: "#email"
    password: "#password"
    submit: "role=button[name='Sign in']"
  success:
    - { type: url_contains, value: "/dashboard" }
    - { type: selector_visible, value: "[data-testid='user-menu']" }
  auth_endpoints: ["**/login"]
  totp:
    enabled: false
  access_denied_markers: ["access denied", "not authorised", "not authorized", "forbidden", "not found"]
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
  - { label: qa-user-1, role: consultant, tenant: A1, vars: { tenant_slug: a1, owned_resource_id: res_a1_001 } }
  - { label: qa-user-2, role: consultant, tenant: B1, vars: { tenant_slug: b1, owned_resource_id: res_b1_002 } }
`,
);

setSecret('fixture', 'qa-user-1', 'username', 'qa1@example.test', home);
setSecret('fixture', 'qa-user-1', 'password', password, home);
setSecret('fixture', 'qa-user-2', 'username', 'qa2@example.test', home);
setSecret('fixture', 'qa-user-2', 'password', password2, home);

const reset = await fetch(`http://127.0.0.1:${port}/__admin/reset`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    users: [
      { email: 'qa1@example.test', password, label: 'qa-user-1', tenant: 'a1', resources: ['res_a1_001'] },
      { email: 'qa2@example.test', password: password2, label: 'qa-user-2', tenant: 'b1', resources: ['res_b1_002'] },
    ],
  }),
});
if (!reset.ok) throw new Error(`fixture reset failed ${reset.status}`);
process.stdout.write('fixture prepared\n');
