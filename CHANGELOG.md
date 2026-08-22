# Changelog

## Unreleased

### Changed

- **BREAKING (package names): the `@mir-stream` scope is gone from both published
  libraries.**

  | Old | New |
  |---|---|
  | `@mir-stream/webchannel-client` | `openclaw-webchannel-client` |
  | `@mir-stream/webchannel-saas` | `openclaw-webchannel-saas` |
  | `openclaw-webchannel` (plugin) | *unchanged* |

  The scope was never a design choice — GitHub Packages requires scope to equal
  the repo owner. `0.6.1` moved these packages to public npm, where unscoped
  names are first-come-first-served, so the scope became a vestige of a registry
  they no longer use. All three artifacts now share the `openclaw-webchannel`
  prefix. This is a rename only: no API, behaviour, or protocol change, and
  `WEBCHANNEL_PROTOCOL_VERSION` is untouched.

  **The old scoped names will be unpublished after this release.** Migration is
  therefore required, and a plain `npm update` will not do it — nothing resolves
  an old name to a new one. Uninstall the old names, install the new ones, and
  rewrite your import specifiers: see
  [Migrating an existing consumer](docs/PUBLISHING.md#migrating-an-existing-consumer).

## 0.6.1

A rendering-fidelity patch. Two long-standing delivery bugs are fixed on the
plugin side; there is **no protocol break, no API change, and no client code
change** (`WEBCHANNEL_PROTOCOL_VERSION` stays `3`).

- **Every streamed message reached the browser twice (issue #172).** In
  partial-streaming mode an assistant message was delivered once as its own
  streamed bubble and again as an independent `agent_message` from the
  authorized-block path — a two-message turn rendered as **four** bubbles.
  Verified against the pinned core bundle, the authorized block is a redundant
  re-render of the partial stream (core feeds the same visible text to both), so
  the block's wire frame is now suppressed when its own assistant message
  already streamed that text. The match is identity-first — each lane is stamped
  with core's 1-based `assistantMessageIndex` — not positional, and independent
  delivery is preserved unchanged as the recovery path for a message whose own
  frame failed to ship.

- **A second final overwrote the wrong bubble (issue #173).** An ordinary answer
  final always overwrote the *current* message, so when the turn's last
  assistant message is tool-only — the shape where core emits one final per
  text-bearing message — a later final landed on top of a message it did not
  belong to. Finals are now routed to the message they belong to and settle on
  that message's own id. Notices, errors, and finals after a terminal error are
  unchanged. One exotic shape remains imperfect (3+ text messages, tool-only
  last, and a middle frame dropped mid-turn): finals are identity-less on the
  wire, so the pairing is positional and can shift, surfacing one stray bubble
  that self-heals on reload. The sound fix is the authoritative snapshot still to
  come.

- **`webchannel-client` and `webchannel-saas` now publish to the public npm
  registry.** They were on GitHub Packages, which demands an authenticated
  `read:packages` token for *every* consumer read — even of a public package —
  so each downstream project, CI job, Docker build and deploy host needed a
  credential just to `npm install`, and real consumers vendored the packages
  through a pinned checkout instead. The repo has been public and all three
  packages MIT since 0.6.0, so that gate protected nothing. Both now ship to
  `registry.npmjs.org` by the same OIDC trusted-publishing path the plugin
  already used — no long-lived token in CI — and carry a `--provenance`
  attestation linking the tarball to the workflow run that built it. **Consumers
  need no `.npmrc` and no token:** `npm install @mir-stream/webchannel-saas@0.6.1`
  now just works. Package contents are unchanged; this is a distribution change
  only. See `docs/PUBLISHING.md`, including the one-time manual bootstrap each
  new package name needs before npm will accept an OIDC publish.

Both delivery fixes are phases 1 and 2 of the delivery-render redesign tracked
in **issue #212**, and they remove most of #174 as a consequence. All three
packages move to `0.6.1` together under the 3-way version lockstep; the client
bundle is code-identical to `0.6.0` and upgrading it is optional.

Internally this cycle also replaced the CI cache-health guard with a
version-aware probe run inside the install composite, deleting the raced
fallback apparatus it had accumulated (#205, #210). No shipped code is affected.

## 0.6.0

- **New: a structured tool-activity surface on the channel (issue #97).** Until
  now the only thing a browser peer learned about the agent's tool work was
  whatever the progress draft happened to be showing: transient text, on a path a
  short tool call can complete without ever flushing, and that turn settlement
  replaces with the final answer. An embedder had nothing it could style, count,
  or correlate. The plugin now emits an additive `tool_activity` frame per tool
  call — `{turnId, id, name?, phase?, status?, summary?, argKeys?}` — and the
  client exposes it as `WebChannelState.toolActivity: ToolActivityItem[]` (new
  exported type `ToolActivityItem`). It mirrors the reasoning lane end to end:
  sourced directly from the agent event stream rather than from the
  progress-draft writer, upserted by id and correlated by `turnId` across a
  call's start/update/terminal phases, bounded (the wrapper retains the most
  recent 100), and **ephemeral — it is not durable history and does not survive
  a reload or a register-time history snapshot.** The pre-existing progress-text
  path is byte-for-byte unchanged, so nothing that renders it today moves.

  **`argKeys` carries argument KEY NAMES only, never argument values**, because
  tool arguments routinely hold file contents, paths, and secrets. The same
  boundary governs the rest of the frame: an item core marks hidden from channel
  progress is suppressed along with the derived command/patch companions that
  the pinned runtime does not itself flag; patch summaries are admitted only
  after reduction to the runtime's count-only grammar (`3 added, 1 modified`),
  never file paths; and command, tool, and search summaries — which can carry
  output or query bodies — are withheld entirely.

  There is **no config gate and no opt-out**: unlike the reasoning lane, tool
  activity is always on for every peer the channel serves. Consider that before
  upgrading if your browser peers are less trusted than your operators. The
  surface is deliberately narrow metadata, but a tool *name* still describes
  what the agent is doing. The value redactor, the full tool outcome
  (`onToolResult` / `onCommandOutput` / `onPatchSummary`), non-streaming-mode
  wiring, and a durable after-settle record are deliberate follow-ups, not
  oversights.

- **Stable assistant-message identity on the wire (issue #111).** `agent_message`
  frames now carry an optional `assistantMessageIndex`, and `ChatMessage`
  exposes it, so a client can reconcile a register-time history snapshot against
  the bubbles already on screen by exact match instead of the text/positional
  heuristic. It is populated **only** for authorized block deliveries, where
  core's runtime dispatch info carries a true per-assistant-message identity.
  Final, notice, and error deliveries omit it, because core stamps one
  turn-level index on every retained final payload and reading it there would
  misattribute one retained message to another. It is **live-only and not a
  durable key**: the ordinal is run/attempt-local, can repeat within one user
  turn after model fallback, and is deliberately absent from `HistoryMessage`.
  The client uses it as a tier-0 match scoped through the anchor's live `turnId`
  and falls back to the existing heuristic, untouched, whenever the field is
  absent.

- **No protocol break in this release.** `WEBCHANNEL_PROTOCOL_VERSION` stays
  `3`. Both wire additions above are optional and additive in both directions —
  an older client ignores the new frame and the new field, and an older agent
  simply never sends them — so no lockstep upgrade is imposed by the protocol.
  The plugin, client, and SaaS packages still move together at `0.6.0`, and you
  need both sides upgraded to actually see the new surface.

- **All three published packages are now MIT licensed.** `openclaw-webchannel`
  previously declared no `license` field at all, and
  `@mir-stream/webchannel-client` and `@mir-stream/webchannel-saas` were marked
  `UNLICENSED`. Each package now declares `MIT` and ships a `LICENSE` file
  inside its published tarball.

- **The source repository is public, and `openclaw-webchannel` now publishes
  with npm provenance.** The package had been installable from public npm for
  several releases while its source repository was private, so nothing tied a
  published tarball to the code that produced it — and `docsPath` pointed at a
  repository nobody outside the org could open (issue #188). Both follow from
  the repository going public. Provenance attestation is restricted to public
  source repositories, so from 0.6.0 every release carries a signed link back to
  the workflow run that built it, verifiable with `npm audit signatures`.

- The channel now registers complete presentation metadata (issue #170). Pinned
  openclaw `2026.7.1-2` was filling in the missing `label`, `selectionLabel`,
  `docsPath`, and `blurb` itself and emitting a warning-shaped "registered
  incomplete metadata" diagnostic on **every** gateway boot; supplying all four
  stops it. The separate pre-load `openclaw.channel` catalog block in
  `package.json` — which is what represents this channel to an operator while
  the bundle is not loaded at all — now carries the same four values, and a
  cross-assertion keeps the two surfaces from drifting apart again.

- The demo widget's composer keeps its in-flight affordance alive across the
  whole of a multi-step turn (issue #96). The Send/Stop label is re-derived from
  the live draft by every writer instead of being latched by a guard in the
  handler, so it no longer reverts between agent bubbles; the gap hint is
  actually reachable; and a follow-up typed while a turn is still running is no
  longer swallowed.

## 0.5.0

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

## 0.4.0

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
- **Breaking:** replace `EnrollmentStore`, `MemoryEnrollmentStore`, and
  `MemoryAgentKeyRegistry` with the required atomic `EnrollmentRepository` and
  `MemoryEnrollmentRepository`; adapters must implement the repository-authoritative
  asynchronous `now()` clock accessor.
- **Breaking:** `ApproveOutcome` adds `in_progress`; operator HTTP adapters map
  it to `409 approval_in_progress`. Deny may now terminate an approving lease,
  preempting an approve still in flight on the same instance.
- Polling an approved record after `expiresAt` returns its credentials during
  retention instead of overwriting approval with expiry.

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
