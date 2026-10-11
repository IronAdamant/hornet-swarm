# Lid close and the locked screen

Status: open. No code change in this note.

## What the source does

The suite never calls `caffeinate`, `pmset`, or any other sleep assertion. A search of the product TypeScript finds none.

Closing the laptop lid sleeps a MacBook. Sleep freezes the suite, Docker, and the local parent. On wake, `Date.now()` is compared with the deadline in `packages/controller/src/suite.ts`. The deadline is the run start plus `max_run_duration_min` minutes. If the sleep used up that window, the suite takes the duration path: the run is blocked, the parent status is `duration`, and `killed` is false.

`caffeinate` prevents idle sleep. It does not prevent sleep when the lid closes. Clamshell mode (power, an external display, and an external keyboard or mouse) or an owner sleep setting is what keeps the machine up.

On Darwin, `loadAgeSecret` in `packages/controller/src/broker.ts` always calls `security find-generic-password`. It does not read `SOPS_AGE_KEY`. That variable is only for a non-Mac host. Every decrypt goes through `ageIdentity`, so every secret read hits the keychain again. The item is stored with `-A`, which skips the per-app prompt while the keychain is unlocked. A locked login keychain still fails the read, or waits until the 15-second timeout.

A job that already received its secrets can finish. The next label, or a later redact that opens the secret file, cannot.

## Amendment I would make

Read the age key once, after a successful keychain read, and keep it in that process until exit. The run still cannot start while the keychain is locked. A lock that happens after the first read would no longer fail the next label. Do not write the key to disk. Do not change the Darwin path to require `SOPS_AGE_KEY`.

Add one doctor line: sleep is still allowed, and a closed lid will freeze the run. Do not turn sleep off from the suite.

## Left with the owner

Start the run with the login keychain unlocked, and set it so the lock screen does not lock it. For a closed lid, use clamshell mode or turn system sleep off for the run.
