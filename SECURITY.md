# Security

Hornet Swarm may only be pointed at systems you own, systems you are authorised in writing to test, or public sites that publish that they exist for test-automation practice. A `public_practice` authorisation records where the site says so and refuses chaos, access-control probing, and heavy traffic. The authorisation file is a technical check that records that permission. It is not a substitute for the permission itself.

Do not put real customer passwords in the store. Use accounts that were created for testing. Hornet Swarm encrypts those values with age, keeps the private key in the macOS Keychain, and sends them into a runner only while a job is running. Agents, logs, screenshots, traces, and reports are supposed to show labels such as `qa-user-1`, not the password.

Redaction looks for each stored value as typed, lowercased where that applies, and in every encoding a browser or HTTP client uses: HTML form encoding (where a space is `+` and `!'()~` are percent-encoded), `encodeURIComponent`, base64, HTML escaping, and JSON escaping. Request and response bodies for the project's `auth.auth_endpoints` are dropped from the HAR and the trace. Cookie, Set-Cookie, Authorization, and Proxy-Authorization headers are masked in every request. Screenshots and the screencast frames inside a trace are read with OCR, and a frame that shows a secret is replaced.

If a saved result still contains a secret, Hornet Swarm marks the run as a redaction failure and removes that file. Do not share the folder until you have checked it.

The local credential page answers only on `127.0.0.1`, refuses requests from other sites, and its setup form carries a token. Runners reach only the project's origins, by exact host and port, through the egress proxy. Each runner can read only its own control token.

Agents can engage the kill switch. Only you can release it.

Hornet Swarm will not solve CAPTCHAs or second-factor challenges. A TOTP code is filled only when you turn that on for the project and store the authenticator secret yourself.

Stopping a run: `hornet-swarm kill`. Allow runs again: `hornet-swarm kill --release`. You can attach those commands to a macOS Shortcut. There is no global kill hotkey inside Hornet Swarm.
