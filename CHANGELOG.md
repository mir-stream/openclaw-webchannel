# Changelog

## Unreleased

- **Breaking (issue #54):** `auth.jwt.audience` has been removed. JWT `aud` is
  now the canonical runtime account id or an array of authorized account ids in
  one tenant; generic/shared IdP audiences are no longer accepted. The signed
  `tenant` claim is mandatory and must match exactly. Remove the old config key
  before upgrading; any enabled account containing it fails closed with
  migration guidance. This supersedes #65's partial audience-pin proposal.

### Security upgrade / incident response for issue #54

Deployments that previously served more than one account with the same issuer
and shared audience must treat that service as potentially exposed. A token for
one account may have admitted access to another peer, including that peer's
conversation key K and history. Upgrading prevents new cross-account admission;
it cannot restore secrecy for keys or ciphertext that may already have been
exposed.

Before re-enabling an affected account, drain and stop **every** vulnerable
replica and keep all affected accounts disabled. Revoke the affected issuer and
relay bootstrap/NATS authorizations and active sessions, then rotate K and
invalidate the old encrypted peer state through a verified control. Review the
full exposure window and history as an incident. Deleting the old configuration,
restarting only some replicas, or waiting for token expiry is **not** revocation.

Integrated, verified K rotation/state invalidation is tracked by #72. If that
control is not available for a deployment, do not improvise by deleting files or
running an unverified migration: keep the accounts disabled and escalate through
the service's incident-response process.

- Account startup now completes cache-free planning for every enabled account
  before credential/network I/O, then transactionally publishes each serving
  runtime only after JWKS readiness and register-subscription installation.
- The shared enrollment HTTP handler no longer exposes `/bootstrap`. Normal
  browser flows consume a server-authorized tenant/account tuple; standalone
  unauthenticated minting is test-only and requires an explicit fixed tuple.
- **Breaking API:** bootstrap claims no longer duplicate `aud` into a top-level
  `accountId` output claim; consumers must read scalar/array `aud`. The shared
  handler and minimal-consumer `bootstrap` callback options are removed.
- Plugin, client, and SaaS release metadata move in lockstep at `0.3.0`.
- Security incident context remains tracked in #72; durable storage follow-up
  remains tracked in #71.
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
  `MemoryEnrollmentRepository`; adapters must implement the repository-authoritative
  asynchronous `now()` clock accessor.
- **Breaking:** `ApproveOutcome` adds `in_progress`; operator HTTP adapters map
  it to `409 approval_in_progress`. Deny may now terminate an approving lease,
  preempting an approve still in flight on the same instance.
- Polling an approved record after `expiresAt` returns its credentials during
  retention instead of overwriting approval with expiry.
