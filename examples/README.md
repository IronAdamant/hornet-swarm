# Example files for the Hornet Swarm QA Harness spec

- `config.yaml` — global `~/.hornet-swarm/config.yaml`.
- `projects/example-app/project.yaml` — a project config (targets, auth, runners, limits, users with non-secret vars).
- `projects/example-app/secrets.sops.example.yaml` — the DECRYPTED view of the per-project encrypted secret store (labels only ever leave the broker; values never do).
- `authorisations/example-app-owner.yaml` — owner-basis authorisation record (self-owned app).
- `authorisations/client-staging-contract.yaml` — contract-basis authorisation record (client staging under written authorisation).
- `journeys/example-app/01-signin-dashboard.journey.yaml` — Phase 2 example A (basic).
- `journeys/example-app/02-tenant-isolation.journey.yaml` — Phase 2 example B (multi-tenant data isolation).

See ../SPEC.md for the full specification.
