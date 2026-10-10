# Example files for the Aegis QA Harness spec

- `config.yaml` — global `~/.aegis/config.yaml`.
- `projects/consistencyhub/project.yaml` — a project config (targets, auth, runners, limits, users with non-secret vars).
- `projects/consistencyhub/secrets.sops.example.yaml` — the DECRYPTED view of the per-project encrypted secret store (labels only ever leave the broker; values never do).
- `authorisations/consistencyhub-owner.yaml` — owner-basis authorisation record (self-owned app).
- `authorisations/client-staging-contract.yaml` — contract-basis authorisation record (client staging under written authorisation).
- `journeys/consistencyhub/01-signin-dashboard.journey.yaml` — Phase 2 example A (basic).
- `journeys/consistencyhub/02-tenant-isolation.journey.yaml` — Phase 2 example B (multi-tenant data isolation).

See ../SPEC.md for the full specification.
