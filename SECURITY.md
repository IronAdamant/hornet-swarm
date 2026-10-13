# Security

Hornet Swarm may only be pointed at systems you own, systems you are authorised in writing to test, or public sites that publish that they exist for test-automation practice. A `public_practice` authorisation records where the site says so and refuses chaos, access-control probing, and heavy traffic. The authorisation file is a technical check that records that permission. It is not a substitute for the permission itself.

Do not put real customer passwords in the store. Use accounts that were created for testing. Hornet Swarm encrypts those values with age, keeps the private key in the macOS Keychain, and sends them into a runner only while a job is running. Agents, logs, screenshots, traces, and reports are supposed to show labels such as `qa-user-1`, not the password.

Redaction looks for each stored value as typed, lowercased where that applies, and in every encoding a browser or HTTP client uses: HTML form encoding (where a space is `+` and `!'()~` are percent-encoded), `encodeURIComponent`, base64 and base64url at any byte offset (so a password inside an encoded JSON body or a Basic auth header is found), HTML escaping, and JSON escaping. Request and response bodies for the project's `auth.auth_endpoints`, and always for its sign-in page, are dropped from the HAR and the trace, so a session token in a login response is not kept. Cookie, Set-Cookie, Authorization, Proxy-Authorization, X-Api-Key, X-Auth-Token, X-Access-Token, X-CSRF-Token, and X-XSRF-Token headers are masked in every request. Screenshots and the screencast frames inside a trace are read with OCR, and a frame that shows a secret is replaced.

If a saved result still contains a secret, Hornet Swarm marks the run as a redaction failure and removes that file. Do not share the folder until you have checked it.

An owner or contract authorisation must keep its signed document. A run stops when that file is missing or its sha256 has changed. The authorisation's `activities` are enforced: a journey needs `functional_e2e`, and an access check needs `access_control_checks`. `exclusions` cannot be checked by software. They are shown to every agent, and you remain responsible for them.

The age key is stored in the Keychain through `security`'s standard input, so it never appears in a process list. Passive third parties are never navigated to or typed into, even by a link or a script on the page.

The local credential page answers only on `127.0.0.1`, refuses requests from other sites, and its setup form carries a token. A login entered on the page must be for the project's own website. Runners reach only the project's origins, by exact host and port, through the egress proxy. Each runner can read only its own control token. A runner's results are moved out of its folder in one rename before they are read, so a link the runner wrote can never make the harness read or delete a file elsewhere on this Mac.

Chromium runs with `--no-sandbox` inside the runner container. Its own sandbox needs user namespaces or a setuid helper, and the container's seccomp profile and `no-new-privileges` refuse both. The container, the separate browser user, and the egress proxy are the isolation. Treat a runner that visited a hostile page as untrusted.

Agents can engage the kill switch. Only you can release it.

Hornet Swarm will not solve CAPTCHAs or second-factor challenges. A TOTP code is filled only when you turn that on for the project and store the authenticator secret yourself.

Stopping a run: `hornet-swarm kill`. Allow runs again: `hornet-swarm kill --release`. You can attach those commands to a macOS Shortcut. There is no global kill hotkey inside Hornet Swarm.
