import { acquireLease } from '../../packages/controller/src/leases-store.ts';

const home = process.argv[2];
if (!home) {
  process.stderr.write('home required\n');
  process.exit(1);
}
const decision = acquireLease({
  project: 'sigterm-project',
  label: 'qa-user-1',
  agentId: 'sigterm-holder',
  home,
  via: 'cli',
});
if (!decision.ok) {
  process.stderr.write('acquire failed\n');
  process.exit(1);
}
process.stdout.write('held\n');
setInterval(() => undefined, 1_000);
