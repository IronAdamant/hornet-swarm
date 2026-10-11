# Captcha and a second code

Status: open. No code change in this note.

## What the source does

`classifyChallenge` in `packages/runner/src/job.ts` returns `captcha` when the page text contains "verify you are human" or the HTML matches reCAPTCHA, hCaptcha, Turnstile, or Arkose. It returns `2fa` for a visible one-time field, or for wording that a code was texted or emailed plus a non-password field. Password fields are ignored. Hidden fields are ignored because detection uses `input:visible`.

After a step returns, that challenge blocks the rest of the journey. The 2fa stop is skipped only when the journey itself has a `fill.totp` step. A stored authenticator code is posted to the runner as `${label}.totp_code`. A code from SMS or email is not.

The summary says a person needs to look at the page. JUnit records the blocked step as a failure. The other-account sentence is used only when a journey name contains `denied` and the status is `fail`. A blocked captcha does not use that sentence.

Nothing in the runner sends the screenshot to Grok or Grok Bot, and nothing accepts an answer and continues the browser.

## Amendment I would make

Leave both stops in place. Do not add a model call, a typed-answer tool, or a resume of the journey.

The useful amendment is wording in the parent packet: this journey is finished, and the screenshot is for a person to look at. The parent checks the packet against the task. It does not solve the challenge.

A stored TOTP journey stays as it is. SMS and email stay a stop unless that journey already fills TOTP.

## Out of scope

Solving an image captcha, a texted code, or an emailed code. The fixture access-denied 403 and the tenant-isolation journey are not captchas.
