# Gaps after the unattended suite

All four notes below are closed. Each note's status line says what changed. The investigation text is kept as the record.

The build plan was [plan.md](plan.md). Its two sections, the human code entry and the kill check, are in the source. A texted or emailed code waits for a human operator. The kill path is checked when a job response still returns. Captcha stays the current stop. Lid sleep, the keychain, and a cloud Bot stay with the owner.

The notes below are the investigation. The code work in `../plan.md` sections 1–12 landed in `2493d12`. That plan file still describes those sections as open.

The owner keeps the Mac powered on, handles the lock screen and the closed lid, and keeps Docker up. These notes say how the suite behaves under those conditions and the amendment worth making later.

## How I would amend them

1. **Lid and keychain.** Do not disable sleep from the suite, and do not switch the Mac over to `SOPS_AGE_KEY`. Read the age key once per process after the keychain has already unlocked, and reuse it until the process exits. Add a doctor line that says whether sleep is still allowed. The owner still chooses clamshell or a sleep setting.
2. **Parent and duration.** Do not add a daemon and do not chain the next suite. Put `max_run_duration_min` and the deadline in the parent packet so a local Grok Bot can see why a long run stopped. The Bot starts another suite itself if it wants one.
3. **Captcha and a texted or emailed code.** Do not send the image to a model and do not accept an answer back into the browser. Keep the stop. Name it in the packet as a final stop for that journey.
4. **Kill recorded on a response that still returns.** If the kill file is present and the in-flight job response still comes back, record `killed` and stop the project runners. Today that path can return the runner's own report with `killed: false`.

## Files

- [lid-and-lock.md](lid-and-lock.md)
- [parent-and-duration.md](parent-and-duration.md)
- [captcha-and-second-factor.md](captcha-and-second-factor.md)
- [kill-success-path.md](kill-success-path.md)
