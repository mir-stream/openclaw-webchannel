# Changelog

## Unreleased

### Breaking (wire protocol v4)

- **`WEBCHANNEL_PROTOCOL_VERSION` goes 3 → 4 (#246).** The plugin, client, and
  SaaS packages must be released together, and every gateway **and** every
  browser bundle must be redeployed at the same time. A v3 browser against a v4
  agent is refused with a terminal `protocol_mismatch` (426) before any key work;
  a v4 browser against a v3 agent is refused the same way. The version has been
  mandatory in both directions since `0.3.0` (protocol v2), so there is no
  partial-upgrade mode and no silent degradation — the failure is loud and
  diagnosable by design.

  **Why a bump, when every v6 frame shipped as "additive and safely ignorable".**
  For RENDERING that description was accurate, and it stays accurate. For
  CORRECTNESS it is not, and the v6 slices crossed that line. The `0.7.0` client
  also declares protocol `3`, so it passes the old exact-match gate and then
  silently ignores the frames that keep it in sync. Concretely, a v3 peer talking
  to a v6 agent:

  - **has no `seq`, so it never asks for a gap-sync (#244).** Durable frames now
    carry a per-conversation `seq`; a client that sees a hole sends
    `get_difference` and folds the `difference` reply. This transport is core
    NATS pub/sub — at-most-once, no retention — so for a peer that cannot detect
    the hole, one dropped frame is a **permanent, never-healed divergence**. It
    does not look broken afterwards. It looks like a slightly different
    conversation, forever.
  - **ignores `user_committed` (#245),** so a message sent from one device does
    not appear on the account's other devices until the agent next responds.
  - **drops `history` rows of kind `reasoning` / `tool` / `approval` (#242),** on
    the same `role` guard that made that widening safe. Its transcript therefore
    holds no reasoning id to cite as a paging cursor, and **"load older" stalls
    forever** once an operator enables `capabilities.reasoningDurable` — issue
    **#309**, which this closes.
  - **ignores `ack.committed[]` (#243),** the server-minted durable message id
    and its `seq`, so its own sent messages keep client-minted ids the server's
    system of record does not share.

  **No capability negotiation was added, and that is a decision.** #309 framed
  the fix as negotiation, and negotiation is what you need in order to *withhold*
  a frame kind from one peer while serving it to another. Under an exact-match
  version gate there is no such peer — everything that registers is at this exact
  version. The one shape that would need per-peer withholding, a **live**
  delete/edit frame, is not on this wire at all: `messageDeleted` /
  `messageEdited` exist only as durable event kinds with no producer, reachable
  through `difference`/`history`. A capability carrier would therefore ship with
  zero consumers, and an unexercised mechanism is the kind that is discovered
  broken the first time it matters. The next slice that adds a frame an
  equal-version peer must act on decides bump-vs-negotiate then, under the rule
  written in `protocol.ts`.

  **SaaS.** `packages/saas` never gates on the protocol version — the enrollment
  body's `protocolVersion` is advisory diagnostics, sanitized and stored, never
  part of the trust chain and never an input to approval — so nothing there
  changes behaviourally. It still moves version with the other two under the
  repo's 3-way version lockstep.

  **If you hand-roll a client,** send `protocolVersion: 4` only once it actually
  handles `seq` plus the `get_difference`/`difference` round-trip. Declaring `4`
  without them buys a connection and a silently wrong transcript, which is the
  precise failure this bump exists to prevent.

## 0.7.0

Two unrelated changes ship together. **The two published libraries are renamed**
— `@mir-stream/webchannel-client` and `@mir-stream/webchannel-saas` lose the
scope, and the old names are unpublished after this release, so migration is
required and is not automatic. Separately, **the agent becomes the authoritative
source of the order of a turn's answers**, which closes #174 outright and
dissolves the multi-answer half of #215. It does not close the delivery-render
work: the single-answer Case X is preserved on purpose, and the remaining
limitations are documented below. The wire change is additive and
`WEBCHANNEL_PROTOCOL_VERSION` stays `3`, so the protocol imposes no lockstep —
but the fix has a half on each side of the wire, so seeing it needs the `0.7.0`
plugin *and* the `0.7.0` client. All three packages move to `0.7.0` together
under the 3-way version lockstep.

### Added

- **An authoritative end-of-turn snapshot of the turn's answer bubbles (#174,
  #215).** Until now the transcript a browser rendered was whatever order the
  wire happened to deliver, and the agent had no way to correct it afterwards.
  At settlement the plugin now emits one extra frame —
  `{ type: "turn_snapshot", turnId, answers: Array<{ id, text }>, remove: string[] }`
  — at drain, after the buffered-final flush and immediately before
  `turn_settled`. `answers` is the turn's agent answer bubbles in the plugin's
  own generation order; `remove` names bubbles carrying answer content that
  `answers` already represents. The client applies it as a **pure view**: drop
  the `remove` ids, upsert each `answers` entry by id, reorder answer bubbles
  among the slots answer bubbles already occupy, and clear the typing indicator.
  Every other row — your own messages and their send state, notices, reasoning,
  tool activity, adopted history — is left untouched, as the same object.

  Two visible defects follow from it:
  - **A later assistant message could render above an earlier one (#174).** The
    snapshot states the order outright, so arrival order stops deciding it.
  - **With two or more answers in a turn, a middle answer whose wire frames
    failed left a corrupted bubble plus a stray, mis-routed extra bubble
    (#215).** Each lane's snapshot text is captured *while it streams* and is
    never overwritten by a later final landing on the wrong lane, so a
    mis-routed final cannot corrupt it; where the routing is provably correct
    the lane's full final text is used instead, so nothing a final added beyond
    the last partial is lost. An `answers` entry with an id the browser has
    never seen **recovers** a lane whose frames never arrived, and the duplicate
    extra bubble is named in `remove` — except across a durable-history read,
    where that same mint duplicates instead (second known limitation below).

  **It is additive and safely ignorable.** `WEBCHANNEL_PROTOCOL_VERSION` stays
  `3`, no existing frame or field changed, and a `0.6.x` client that has never
  heard of `turn_snapshot` ignores it and renders exactly as it does today. If
  you hand-roll a client, the only requirement is that an unknown frame type
  stays inert.

  **Nothing is deleted speculatively.** `remove` carries only ids the plugin can
  prove duplicate an `answers` entry — never a notice, an error, or a bubble
  whose content is unique. The two cases carry their own separate proofs: an
  overflow final's bubble is named only when every final in the turn has a
  streamed lane, and a recovery block only when its own lane streamed text.
  Where neither proof holds the plugin names nothing and leaves the bubble
  visible-but-misplaced rather than risk telling the client to delete text that
  exists nowhere else.

  One bounded exception, since "unique" is doing real work in that sentence: on
  the mis-routable buffered path the snapshot carries each lane's *streamed*
  text, so a removed overflow bubble's final-only tail — text a final added
  beyond the last partial, the open VERIFY-1 edge — is dropped from the live
  view. Ordering is what that shape was losing before; this trades a
  correctly-ordered transcript for a possibly-truncated last line, and reload
  restores it from durable history.

  **Known limitations, deliberate and documented.**

  *A message that streams no partials at all* has no streamed text, cannot
  appear in `answers`, and so cannot be placed by the snapshot. That is the same
  final-identity ceiling as #111 — core exposes no per-message identity on a
  final — not a defect in the snapshot, and it is not observed at the middle
  position with the pinned core. It heals on reload, when durable history
  supplies the true order.

  *A snapshot that crosses its own turn's durable-history frame* is not
  reconciled correctly. The client matches on the bubble id it currently holds,
  and history adoption renames those ids. That read is detached, so either order
  is legal: a snapshot arriving **before** adoption is overwritten by it and the
  authoritative correction is lost for the session (**#227**), and one arriving
  **after** adoption misses the renamed bubble and mints a duplicate instead of
  recovering a lane (**#228**, heals on reload). Neither is fixed here, on
  purpose: a fix inside the client would be more of the id-guessing that the
  delivery-journal redesign exists to retire. Reaching either needs a
  durable-history read for the turn to interleave with the snapshot — a second
  device, a reconnect, and a cursor-less `loadHistory()` refresh around a live
  turn all produce that.

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
  an old name to a new one. The order and the version pinning both matter, so
  follow the procedure rather than improvising it:
  [Migrating an existing consumer](docs/PUBLISHING.md#migrating-an-existing-consumer),
  which also covers rewriting your import specifiers.

### Notes

- The snapshot follows #172 and #173, which shipped in `0.6.1`. The one shape
  #173 left imperfect — three or more text messages, a tool-only last message,
  and a middle frame dropped mid-turn — is exactly what the snapshot now
  corrects. **This is not the end of the delivery-render work.** That design has
  since been reboarded onto **#236**, which supersedes the older umbrella and
  absorbs the limitations above; treat #236 as the live tracker and the issue
  numbers in this entry as historical labels for the behaviours they describe.
- Internally this cycle also hardened the release pipeline (#220, #229): the
  tag-dispatch path can no longer start a second release alongside a running
  one, and a new `verify-dist-tags` job fails the release when npm's `latest`
  ends up split across the three packages instead of letting it pass silently.
  No shipped code is affected.

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
