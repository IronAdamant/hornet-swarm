# Security

Hornet Swarm may only be pointed at systems you own, or systems you are authorised in writing to test. The authorisation file is a technical check that records that permission. It is not a substitute for the permission itself.

Do not put real customer passwords in the store. Use accounts that were created for testing. Hornet Swarm encrypts those values with age, keeps the private key in the macOS Keychain, and sends them into a runner only while a job is running. Agents, logs, screenshots, traces, and reports are supposed to show labels such as `qa-user-1`, not the password.

If a saved result still contains a secret, Hornet Swarm marks the run as a redaction failure and removes that file. Do not share the folder until you have checked it.

Hornet Swarm will not solve CAPTCHAs or second-factor challenges. A TOTP code is filled only when you turn that on for the project and store the authenticator secret yourself.

Stopping a run: `hornet-swarm kill`. Allow runs again: `hornet-swarm kill --release`. You can attach those commands to a macOS Shortcut. There is no global kill hotkey inside Hornet Swarm.
