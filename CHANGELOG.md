# Changelog

## 0.3.0

### BREAKING

- Removed the legacy direct-gateway browser client export and transport.
- Removed `auth.ticketParam`; existing values produce a targeted migration error.
- Removed untargeted recipient guessing; unresolved outbound sends are logged and dropped.
- Removed automatic admission, unauthenticated NATS mode, and the live legacy key-exchange subject. Existing removed config shapes fail with migration guidance.
- Static NATS credential accounts cannot serve until authenticated registration for BYO-NATS lands in P0-3.
- Client construction now requires a non-empty bootstrap JWT plus registration material containing both Ed25519 and X25519 private keys.
- Register-delivered protocol version remains v1: the surviving register, wrapped-key, and envelope wire formats are unchanged. Replies without a version remain compatible; mismatches are terminal.

The plugin, client, and SaaS packages must be released together at version `0.3.0`.
