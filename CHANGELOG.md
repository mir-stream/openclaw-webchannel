# Changelog

## Unreleased

- Hardened both NATS WebSocket transports with stable subscription replay,
  byte-accurate bounded framing, per-phase handshake deadlines, and stale
  async-connection generation guards.

## 0.3.0

### BREAKING

- Agent key registry SPI is v2 (`getActive/register/revokeActive/listHistory`) with activation-token CAS, permanent tombstones, and non-lossy history; a registry is now required by `DeviceFlowEnrollment`.
- `approve()` now returns the `ApproveOutcome` discriminated union and explicit key replacement requires the displayed `activationId`.
- Enrollment `accountId` is required end-to-end; implicit enrollment defaults and the legacy `~/.openclaw-webchannel/credentials.json` reader fallback were removed. Move legacy credentials once to `~/.openclaw-webchannel/<account>/credentials.json`.
- Reference-server approve, deny, and revoke require `Authorization: Bearer $ENROLLMENT_ADMIN_TOKEN` and fail closed when it is unset.
- Revoked plugin identities recover through the documented offline credential reset/re-enrollment procedure; no online reset API is provided.

- Removed the legacy direct-gateway browser client export and transport.
- Removed `auth.ticketParam`; existing values produce a targeted migration error.
- Removed untargeted recipient guessing; unresolved outbound sends are logged and dropped.
- Removed automatic admission, unauthenticated NATS mode, and the live legacy key-exchange subject. Existing removed config shapes fail with migration guidance.
- Static NATS credential accounts cannot serve until authenticated registration for BYO-NATS lands in P0-3.
- Client construction now requires a non-empty bootstrap JWT plus registration material containing both Ed25519 and X25519 private keys.
- Register-delivered protocol version remains v1: the surviving register, wrapped-key, and envelope wire formats are unchanged. Replies without a version remain compatible; mismatches are terminal.

The plugin, client, and SaaS packages must be released together at version `0.3.0`.
# Unreleased

- **Breaking:** replace `EnrollmentStore`, `MemoryEnrollmentStore`, and
  `MemoryAgentKeyRegistry` with the required atomic `EnrollmentRepository` and
  `MemoryEnrollmentRepository`.
- **Breaking:** `ApproveOutcome` adds `in_progress`; operator HTTP adapters map
  it to `409 approval_in_progress`. Deny may now terminate an approving lease.
- Polling an approved record after `expiresAt` returns its credentials during
  retention instead of overwriting approval with expiry.
