# Changelog

## 0.3.0

### BREAKING

- Removed the legacy direct-gateway browser client export and transport.
- Removed `auth.ticketParam`; existing values produce a targeted migration error.
- Removed untargeted recipient guessing; unresolved outbound sends are logged and dropped.

The plugin, client, and SaaS packages must be released together at version `0.3.0`.
