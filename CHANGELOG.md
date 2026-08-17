# Changelog

## Unreleased

- **New: `openclaw-webchannel-rotate-key`, an offline conversation-key rotation
  command (issue #158).** Until now the only way an operator could replace a
  leaked K was to delete state files by hand — destructive, account-wide, and
  unauditable. The plugin package now ships a dedicated entry that rotates one
  named peer, or one reviewed account, through the §8.2 commit protocol and
  verifies both complete durable documents by reading them back. ClawHub does
  not expose npm bins on the shell PATH; the runbook resolves the installed root
  with `openclaw plugins inspect webchannel --json` and invokes the entry with
  Node. It is deliberately a separate process from the gateway: it cannot open
  a transport, and the account-wide mutation module is absent from the gateway
  bundle. A dry run is the default; account-wide is never implied and its
  `--apply` requires the tuple-and-target-set digest printed by the matching dry
  run; a digest from another tenant/account is refused before writes. An
  account-wide rotation commits each document exactly once regardless of peer
  count, which a regression test pins. Existing locks and atomic-write temp
  artifacts on a shared store now fail closed without local-PID takeover or
  automatic cleanup, and apply failures distinguish unverified durable state
  from a verified commit whose lock cleanup failed. Deployments using the
  low-level exact credential-file override can pass the same absolute path as
  `--credential-path`; offline previews preserve and refuse ownership-ambiguous
  legacy K when that option is omitted or wrong instead of quarantining it and
  publishing an empty v2 key store. Operators must resolve and invoke the entry
  in the stopped gateway's same service identity/HOME, mount namespace, and
  OpenClaw profile/state/config selection, then match the dry-run tuple directory
  before apply; an explicit v2 root does not relocate legacy discovery.

  It does **not** prove that the gateway is stopped, and does not claim to:
  this is a library and cannot know your deployment topology, so the controller
  attestation originally proposed in #158 was dropped (decision of 2026-08-16).
  Bringing observed replicas to zero first is an operator obligation, imposed by
  step ① of `docs/CREDENTIAL_CONTAINMENT_RUNBOOK.md`. Rotation is supported
  only for one local tuple store or one authoritative tuple store shared by all
  replicas; independent replica volumes must be escalated, not rotated in turn.

- **New: `docs/CREDENTIAL_CONTAINMENT_RUNBOOK.md` (issue #83)** — the operator
  procedure for a leaked browser credential, agent credential, or conversation
  key. It branches by deployment class on the first screen, because the correct
  order differs by class, and it marks the stop-first order as load-bearing.

- Reasoning delivery now suppresses the pinned CLI runtime's exact durable
  replay only while its matching live burst remains open and its live send
  succeeded. A rejected live send retains the durable fallback. Independent
  durable blocks — including equal or shared-prefix text — still render in full
  under distinct reasoning ids and never enter the answer lane.

- **Breaking (wire protocol v3):** the client↔plugin register hop changed in four
  ways. `WEBCHANNEL_PROTOCOL_VERSION` goes 2 → 3, and the plugin, client, and SaaS
  packages must be released together at `0.4.0`. A v2 browser against a v3 agent is
  refused with a terminal `protocol_mismatch` (426) before any key work; a v3
  browser against a v2 agent is refused the same way.

  1. **`clientNonce` register-reply freshness anchor.** The register request now
     carries a mandatory browser-generated random `clientNonce`, and the agent binds
     it — together with the peer id — into the wrapped-conversation-key AAD. The
     wrapped key was authenticated but not fresh, so a hostile relay could capture a
     register reply and re-serve it verbatim; that is inert only while K never
     rotates. The anchor is added now, while it is cheap, so a later K rotation
     cannot turn a captured reply into a session hijack. It is regenerated per
     register *attempt*, never echoed by the agent, and never read back off the
     wire. See `docs/AUTH.md`.
  2. **`unregister` requires proof of possession (issue #51).** Teardown was
     authenticated by JWT + tenant + subject match alone, and the bootstrap JWT
     crosses the untrusted relay in plaintext, so a relay-positioned observer could
     capture `{op:"unregister", token}` and replay it until the JWT expired,
     dropping the victim's subscription and session key each time with no signal to
     the victim. It now requires the same single-use PoP challenge/response as
     `register`.
  3. **The PoP proof is bound to its operation.** The signed message is now
     `webchannel-pop:{op}:{peerId}:{nonce}` (was `webchannel-pop:{peerId}:{nonce}`),
     and the two **exported client function signatures** moved with it:
     `popSignedMessage(peerId, nonce)` → `popSignedMessage(op, peerId, nonce)` and
     `signPop(key, peerId, nonce)` → `signPop(key, op, peerId, nonce)`. Any caller
     that builds register frames by hand must pass the op.
     Both operations draw from the same per-peer nonce bucket, so a proof minted for
     `register` was also a valid `unregister` proof — and a relay could obtain an
     unconsumed one for free by *suppressing* the register frame, which is
     indistinguishable from the dropped frame the client retry loop absorbs. This
     breaks the register direction too, which is why it ships in this release
     rather than costing a second hard break later.
  4. **Embedder note.** A client that sends a token-only `unregister` to a v3 agent
     gets a **silent no-op** — unregister is fire-and-forget with no reply on any
     path, and the version check sits after the unregister branch, so there is no
     426 and no error. This is required by the no-oracle contract but is
     undiagnosable client-side. Use `unregisterWithPop()` from
     `@mir-stream/webchannel-client`, which runs challenge → sign → publish.
     `generateClientNonce` is intentionally *not* exported: the anchor has exactly
     one legitimate producer, `registerWithPop`.

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
relay bootstrap/NATS authorizations and active sessions, then rotate K. Review
the full exposure window and history as an incident. Deleting the old
configuration, restarting only some replicas, or waiting for token expiry is
**not** revocation.

**Correction.** An earlier revision of this entry also told operators to
"invalidate the old encrypted peer state through a verified control". There is
no such state, so an operator following that instruction had nowhere to go. K
seals no history at rest: the history authority is OpenClaw core's session
transcript (plaintext JSONL, owner-only), and `sendHistory` seals each frame with
the **current** K at delivery time, so replacing K needs no invalidation pass —
the next read-and-deliver reseals. What this plugin writes at rest is
`credentials.json`, `conversation-keys.json`, the generation sidecar, and legacy
migration artifacts, and nothing else.

**The #72 deferral is now resolved for the containment path.** Revocation is
available to a self-contained deployment that holds its operator seed
(`addRevocation` plus the full/Dir resolver's `$SYS.REQ.CLAIMS.UPDATE`, with
readback), and K rotation is available as the offline
`openclaw-webchannel-rotate-key` command. Both are procedures, not automation:
`docs/CREDENTIAL_CONTAINMENT_RUNBOOK.md` is the operator runbook and is the
document this entry now points to. What remains unproven is stated there —
nothing in this repository can verify that every replica was stopped before K was
rotated; that precondition is enforced by the operator, not by tooling. If you
cannot follow that runbook for a deployment, the original guidance stands: do not
improvise by deleting files or running an unverified migration — keep the
accounts disabled and escalate through the service's incident-response process.

- Each enabled account now completes pure account planning and immutable,
  account-bound auth preparation before that account consumes transport
  credentials or performs network I/O, then transactionally publishes its
  serving runtime only after JWKS readiness and register-subscription
  installation. Issuer derivation may read the account's memoized enrollment
  metadata when required. Accounts start independently: no generation-wide
  collision preflight is required because signed tenant and account-id audience
  claims distinguish their token populations.
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
- Wire protocol v2 is a breaking lockstep client/plugin upgrade: register versions are mandatory in both directions and bounded ingress overload has an explicit terminal `inbound_rejected` result.

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
