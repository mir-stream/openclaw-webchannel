# P2 — Advanced / Reliability Gaps (WebChannel vs. Telegram)

> **Scope.** P2 = depth features a mature channel accrues: multi-conversation threading, reactions,
> message edit/quote, ingress durability (no-loss), throttling, observability/audit, and access-
> control depth. Several are **Telegram-shaped** — the value is the *pattern* and the reusable
> `openclaw/plugin-sdk/*` runtime, not a 1:1 port. Assumes P0 (`P0_CORE_CHAT_GAPS.md`) and P1
> (`P1_RICH_UX_GAPS.md`) are understood.
>
> **Reference channel.** Telegram at `/Users/mircorn/workspace/openclaw/extensions/telegram/src/`.
> **openclaw core** (peer dep, sibling): `/Users/mircorn/workspace/openclaw/src/`.
> **Classification.** 🔴 missing · 🟡 server/wire exists, client absent · 🟢 partial.

---

## Framing: what "advanced" means for a browser channel

Telegram's P2 machinery mostly exists to survive a **hostile, stateful, rate-limited external API
with at-least-once delivery** (getUpdates offsets, disk spool, 429 throttling, membership audits).
Our relay (NATS) has **different** properties: no retention (→ *loss*, not duplication, is the
risk), subject-permissioned auth, E2E encryption. So:
- Some P2 items are **more important for us** (ingress durability — NATS drops what no one is
  subscribed to).
- Some are **less important** (Telegram's 429 throttling; we control our own relay).
- Some need a **web-native reinterpretation** (threads = tabs/conversation-switcher, not forum
  topics; reactions = message hover-actions).

Read each gap's "web reinterpretation" note before scoping.

---

## P2-1 — Multi-conversation threading (more than one chat per user)

**Symptom.** A user has exactly one conversation. No way to run parallel threads / topics /
separate sessions, no conversation list.

**Classification.** 🔴 Missing. Our model is one session per peer.

**Where it stands today.** `inbound.ts:160-181` builds a single conversation keyed by `wsKey`
(= peerId): `conversation: { kind: "direct", id: wsKey, label: wsKey }`, one `routeSessionKey`.
One peer = one session. No thread/topic concept.

**Telegram reference (rich — the session-binding model to reuse).**
- `thread-bindings.ts:507` `createTelegramThreadBindingManager` — binds a conversation/topic to an
  agent session with **idle timeout (24h default) + max-age expiry + 60s sweep**; auto-unbinds
  orphaned/failed sessions. `:962/:983` set idle/max-age; `:925` getter.
- `conversation-route.ts:45` `resolveTelegramConversationRoute()` — routes a message to a session
  considering topic-bound agent overrides + configured + runtime bindings; returns a binding mode
  (`none | configured | runtime-bound | plugin-owned`).
- `action-threading.ts:5` `resolveTelegramAutoThreadId`, `threading-tool-context.ts:22`
  `buildTelegramThreadingToolContext`, `auto-topic-label.ts:6` `generateTelegramTopicLabel`
  (uses `reply-dispatch-runtime.generateConversationLabel`, max 128 chars).
- **Reusable core:** `openclaw/plugin-sdk/conversation-runtime` (SessionBindingAdapter, binding
  lifecycle), `openclaw/plugin-sdk/routing` (agent session key building),
  `openclaw/plugin-sdk/plugin-state-runtime` (persistent keyed store),
  `openclaw/plugin-sdk/reply-dispatch-runtime` (`generateConversationLabel`).

**Web reinterpretation.** A "thread" = a named conversation the user can switch between (like
Slack DMs or ChatGPT's sidebar). Map each to a distinct `routeSessionKey`. Auto-label new threads
from the first message (`generateConversationLabel`).

**Implementation sketch.**
1. **Session key:** derive `routeSessionKey` from `peerId + threadId` instead of just `peerId`
   (extend the `wsKey` composition in `inbound.ts:164-170`). One SessionBindingAdapter via
   `conversation-runtime` per thread.
2. **Wire:** add `threadId` to inbound/outbound frames (or a `conversations` list frame +
   `switch_thread` outbound). History (P0-1/2) becomes per-thread.
3. **Client:** a conversation sidebar/switcher; "new thread" button; auto-labeled entries.
4. **Lifecycle:** reuse the binding manager's idle/max-age/sweep so stale threads GC.

**Acceptance.** A user can start multiple named conversations, switch between them (each keeps its
own history + session), start a new one, and stale threads expire per policy.

**Scope note.** Large — touches session keying, wire, history, and UI. High product value (turns a
single-shot widget into a real chat app). Consider its own tracking doc.

---

## P2-2 — Reactions (emoji ack / status)

**Symptom.** No way to react to a message; no emoji-based status signal.

**Classification.** 🔴 Missing.

**Where it stands today.** No reaction concept in wire, server, or client.

**Telegram reference.**
- `reaction-level.ts:16` `resolveTelegramReactionLevel()` (minimal/ack/full → which status phases
  emit reactions) — built on **`openclaw/plugin-sdk/status-helpers` `resolveReactionLevel`**.
- `status-reaction-variants.ts:132-232` — emoji fallback chains per status
  (queued→👀/👍/🔥, thinking→🤔, done→👍/🎉, error→😱…), validated against chat-level allowlists.
  Built on **`openclaw/plugin-sdk/channel-feedback` `StatusReactionEmojis`**.

**Web reinterpretation.** Two separate features hide here:
- **(a) Status-as-reaction** (agent signals "seen/thinking/done" via emoji) — in the browser this
  is better served by the typing indicator (P0-6) + streaming (P0-5), so **low value for us.**
- **(b) User reactions** (thumbs-up/down on an answer) — genuinely useful as **feedback signal**
  (RLHF-style thumbs, or "was this helpful"). This is the part worth building.

**Implementation sketch (focus on (b)).**
1. Client: hover-actions on agent bubbles (👍/👎/copy).
2. Wire: a `reaction { messageId, emoji }` outbound frame.
3. Server: record the reaction against the session/message (feedback log) — could feed evals.

**Acceptance.** A user can thumbs-up/down an agent message; the signal is recorded server-side.
(Status-as-reaction is intentionally out of scope — typing + streaming cover it.)

---

## P2-3 — Message editing & quoting / replies

**Symptom.** No reply-to-quote, no message editing.

**Classification.** 🔴 Missing.

**Where it stands today.** Flat transcript; each message stands alone. No reply references.

**Telegram reference.**
- `reply-parameters.ts:39-116` — `buildTelegramThreadReplyParams`, `buildTelegramSendParams`,
  native-quote message-id helpers (max 1024-char quote).
- `bot/native-quote.ts:51` `buildTelegramNativeQuoteCandidate` — truncate quote + remap entity
  offsets to the quoted substring.
- `bot/reply-threading.ts:10` `resolveReplyToForSend` / `:30` `sendChunkedTelegramReplyText` —
  reply applied on first chunk only. Built on **`openclaw/plugin-sdk/reply-reference`**.

**Web reinterpretation.** Quote-reply = click a prior message → compose with it quoted (standard
chat UX). "Editing" splits into: (a) user edits their own last message + resubmits; (b) agent
message edits — already handled by the streaming draft finalize (P0-5), so no new work.

**Implementation sketch.**
1. Client: "reply" affordance on a bubble → renders a quoted preview above the input; send includes
   `replyTo: messageId`.
2. Wire: add optional `replyTo` to `user_message` (and echo it on `agent_message` so threads of
   reference render).
3. User-edit-resubmit: allow editing the last user message → resend (ties into P0-7 idempotency so
   it's an edit, not a duplicate).

**Acceptance.** A user can quote-reply to a specific earlier message (quoted context renders), and
can edit+resubmit their last message.

**Scope note.** Lower priority; mostly client UX. The agent-edit half is already covered by P0-5.

---

## P2-4 — Ingress durability (no-loss delivery) ⚠️ higher priority for us than for Telegram

**Symptom.** If the agent is momentarily down / not subscribed, messages published to NATS are
**lost** (NATS has no retention). No spool, no offset, no replay.

**Classification.** 🔴 Missing — and **this is the P2 item that matters most for our transport**,
because NATS silently drops messages with no live subscriber (unlike Telegram's at-least-once
getUpdates). The gap has **narrowed since P0-7 shipped**: the duplicate / at-least-once-from-client
side is now covered (see below), so what remains is specifically **agent-down message durability**.

**Where it stands today (narrowed by P0-7).**
- **Now covered by P0-7:** the client replay ledger re-sends unacked `user_message`s on reconnect
  (P0-7b), and server ingress dedupe (`createPersistentDedupe`, SQLite 7-day) + the `ack` frame make
  a re-sent message exactly-once (P0-7a). So a message dropped by a *transient* client/relay blip is
  recovered end-to-end, and duplicates from replay are deduped.
- **Still open (the residual P2-4 gap):** a `user_message` published while the **agent itself is
  down / not subscribed** is still lost — the client replay only helps if the client is the one that
  reconnects; nothing spools the inbound subject on the agent side. The register handler sends a
  history snapshot on (re)connect, papering over *some* browser-side loss, and `nats-channel.ts`
  drops inbound before handshake. There is **no JetStream stream and no disk spool** — no NATS-native
  retention, no processed-offset, no claim/lease.

**Telegram reference (the durability model to adopt).**
- `telegram-ingress-spool.ts` — disk queue with **auto-claimed leases**, stale-claim detection (6h)
  + process-alive check, per-lane sequential ordering, 30-day/1000-entry prune:
  `writeTelegramSpooledUpdate` (`:242`), `claimNextTelegramSpooledUpdate` (`:301`),
  `refreshTelegramSpooledUpdateClaim` (`:343`), `failTelegramSpooledUpdateClaim` (`:360`),
  `isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess` (`:223`). Built on
  **`openclaw/plugin-sdk/channel-outbound` `ChannelIngressQueue`** — *the durable queue runtime to
  reuse.*
- `update-offset-store.ts` — last-processed offset per account with bot-identity rotation
  detection: `readTelegramUpdateOffset` (`:134`), `writeTelegramUpdateOffset` (`:159`). Built on
  **`openclaw/plugin-sdk/plugin-state-runtime` `openKeyedStore`**.

**Web reinterpretation.** We can't offset NATS the way Telegram offsets getUpdates, but we can:
- Use a **JetStream** stream (NATS persistence) for `webchannel.*.in` so messages survive an agent
  restart and are replayed on reconnect (NATS-native durability — likely the cleanest fix).
- Or spool inbound to disk via `ChannelIngressQueue` once received, so a crash mid-turn doesn't
  lose the message (claim/lease/recover exactly like telegram).

**Implementation sketch.**
1. **Evaluate JetStream** for the inbound subject (durable, replay on reconnect) — this may be the
   highest-leverage single change; check whether the deployed nats-server has JetStream enabled.
2. If not JetStream: on receipt (post-handshake), `ChannelIngressQueue.write` before dispatch;
   `claim` → run turn → `release`/`fail`; recover claims from dead processes on startup.
3. ✅ **P0-7 (client replay + ingress dedupe + ack) is already built** — the two ends already give
   end-to-end at-least-once + idempotent for the *client-reconnect* case. P2-4 adds only the
   agent-side durability (spool/JetStream) so an agent-down window doesn't lose the message.

The **JetStream-vs-disk-spool decision stays deferred** (it touches the whole NATS topology — see
memory `nats-cutover-plan`).

**Acceptance.** A message sent while the agent is restarting is processed once the agent is back —
not lost — and a crash mid-turn re-processes on restart without duplication.

**Scope note.** Needs a transport decision (JetStream vs disk spool). **Surface to the user** — it
interacts with the whole NATS topology (see memory `nats-cutover-plan`).

---

## P2-5 — Throttling / rate-limit

**Symptom.** No client-side send throttle; a chatty client could hammer the agent.

**Classification.** 🔴 Missing — but **lower priority for us** (we own the relay; there's no
external 429 to dodge).

**Where it stands today.** No throttle anywhere. The client sends as fast as the user types.

**Telegram reference.**
- `account-throttler.ts:125` `createTelegramAccountThrottler` — fair-queue per chat×topic lane so
  no chat starves others (prevents 429).
- `sendchataction-401-backoff.ts:124` — exp backoff 1s→5min, suspend after 10× 401. Built on
  **`openclaw/plugin-sdk/runtime-env` `computeBackoff` / `sleepWithAbort`**.
- `startup-probe-limiter.ts:81` `withTelegramStartupProbeSlot` (max 2 concurrent startup probes);
  `request-timeouts.ts:50-78` per-method timeouts.

**Web reinterpretation.** The real risk isn't relay 429 — it's **abuse / cost** (a client flooding
the agent = LLM spend). So the useful version is **per-peer inbound rate-limiting at the agent**,
not client-side politeness.

**Implementation sketch.**
1. Server: a per-peer token bucket on inbound `user_message` (drop/queue over the limit), keyed by
   `peerId`. Reuse `runtime-env` backoff primitives.
2. Optional client: debounce/disable send while a turn is in flight (also improves UX).

**Acceptance.** A peer exceeding a configured inbound rate is throttled server-side (not the whole
relay); normal users are unaffected.

**Scope note.** Low priority unless abuse/cost is a near-term concern.

---

## P2-6 — Observability & audit

**Symptom.** Failures are ad-hoc `console.log`/`api.logger` lines; no structured audit of
security-relevant events, no redaction discipline, no channel status telemetry.

**Classification.** 🟢 Partial. There's logging; there's no structured audit/telemetry contract.

**Where it stands today.** `index-nats.ts` logs liberally (`api.logger.warn/error`, `console.log`).
The demo has `/demo/status` + `/demo/users` (`demo-app.html:400,497`). No security-audit collector,
no redaction helper, no `ChannelStatusIssue`/status-patch telemetry.

**Telegram reference.**
- `security-audit.ts:54` `collectTelegramSecurityAuditFindings` — audits allowlist config,
  wildcard exposure, missing guards; 3 severities (info/warn/critical). Uses
  **`openclaw/plugin-sdk/conversation-runtime`** + **`native-command-config-runtime`**.
- `raw-update-log.ts:75` `stringifyTelegramRawUpdateForLog` — **redaction** (strips text/usernames/
  ids/file-ids, truncates, hashes) before logging. Important for our E2E posture — never log
  plaintext.
- `api-logging.ts:28` `withTelegramApiErrorLogging` (**`openclaw/plugin-sdk/runtime-env`
  `createSubsystemLogger`**).
- `webhook-status.ts:7` `createTelegramWebhookStatusPublisher` (**`openclaw/plugin-sdk/gateway-runtime`
  `createConnectedChannelStatusPatch`**) — channel status telemetry.
- `audit.ts:63` `auditTelegramGroupMembership` — startup membership verification (our analog: verify
  the agent is subscribed / relay reachable — overlaps P1-6 doctor).

**Implementation sketch.**
1. **Redaction discipline:** a `stringifyWebchannelForLog` that guarantees no plaintext message
   content / creds hit logs (critical given E2E — the relay never sees plaintext, so neither should
   logs). Model on `raw-update-log.ts:75`.
2. **Security-audit collector:** flag risky config (admission=auto + open dmSecurity — already
   warned at `index-nats.ts:625`; formalize into findings), unset approvers with execApprovals on,
   etc.
3. **Status telemetry:** publish channel status via `gateway-runtime` status-patch (connected,
   last activity) so `openclaw`'s status surfaces webchannel health.

**Acceptance.** Security-relevant misconfig is reported as structured findings; logs are guaranteed
plaintext-free; channel health shows in openclaw status.

---

## P2-7 — Access-control depth

**Symptom.** Access control is coarse: a dmSecurity allowlist + execApprovals.approvers + the demo
users↔aud panel. No pairing flow, no access-groups, no per-conversation policy.

**Classification.** 🟢 Partial. Real controls exist; they're shallower than telegram's.

**Where it stands today.**
- `dmSecurity` allowlist gates peers (`index-nats.ts:625`, manifest `dmSecurity`).
- `execApprovals.approvers` gates who resolves approvals (manifest; falls back to
  `commands.ownerAllowFrom`).
- Demo runtime user↔account (aud) authz panel (`demo-users.ts`, `demo-app.html:342-406`) — grant/
  revoke which accounts a login may reach (see memory `demo-user-login`).
- NATS creds are **tenant-wide** (E2E-only isolation) — a known follow-up (memory
  `demo-user-login`: "NATS creds still tenant-wide … = follow-up").

**Telegram reference.**
- `bot-access.ts:73` `resolveTelegramEffectiveDmPolicy` (pairing/open/allowlist/disabled),
  `:84` `isSenderAllowed`. Uses **`openclaw/plugin-sdk/allow-from`** (`isSenderIdAllowed`,
  `mergeDmAllowFromSources`).
- `dm-access.ts:80` `enforceTelegramDmAccess` — **pairing challenge** for unknown senders via
  **`openclaw/plugin-sdk/channel-pairing` `createChannelPairingChallengeIssuer`** +
  **`conversation-runtime` `upsertChannelPairingRequest`**.
- `access-groups.ts:14` `expandTelegramAllowFromWithAccessGroups` — dynamic group membership via
  **`openclaw/plugin-sdk/security-runtime`**.
- `group-access.ts:43-120` — two-tier base + policy access, topic→group→account→global precedence,
  via **`openclaw/plugin-sdk/runtime-group-policy`**.

**Web reinterpretation.** Our identity is a logged-in SaaS user (peerId = user.uuid), not a
Telegram sender id, so the *mechanism* differs — but the **policy runtimes are reusable**:
- **Pairing** → a "request access" flow for a user not yet granted on an account (mirror
  `channel-pairing` challenge → operator approves in the users↔aud panel).
- **Access-groups** → grant account access by group membership, not just per-user
  (`security-runtime` expansion).
- **Per-account NATS credential scoping** → close the "tenant-wide creds" follow-up so revocation
  is enforced at the NATS layer, not just at bootstrap.

**Implementation sketch.**
1. Formalize DM policy resolution with `plugin-sdk/allow-from` (parity with other channels).
2. Add a pairing/request-access flow using `channel-pairing` + the existing users↔aud panel as the
   approval surface.
3. Adopt `security-runtime` access-groups for grant-by-group.
4. (Security hardening) scope NATS creds per-account/peer so revoke takes effect at the relay, not
   only at next bootstrap — closes the memory `demo-user-login` follow-up.

**Acceptance.** An ungranted user can *request* access (operator approves in-panel); access can be
granted by group; revoking access is enforced at the NATS layer (not just next login).

---

## Suggested execution order (P2)

| Order | Gap | Effort | Why this order |
|---|---|---|---|
| 1 | P2-4 ingress durability | M–L | **Highest reliability value** for our transport (NATS loss). Decide JetStream vs spool. |
| 2 | P2-1 multi-conversation | L | Highest **product** value (single-shot widget → real app). Own doc likely. |
| 3 | P2-6 observability/audit | M | Redaction is a **security must** given E2E; cheap findings collector. |
| 4 | P2-7 access-control depth | M | Closes the tenant-wide-creds follow-up; reuses core runtimes. |
| 5 | P2-2 reactions (feedback) | S | Only the thumbs-feedback half; skip status-as-reaction. |
| 6 | P2-3 edit/quote | S–M | Client UX; agent-edit already done by P0-5. |
| 7 | P2-5 throttling | S | Lowest priority unless abuse/cost pressure. |

**Decisions to surface before coding:** P2-4 (JetStream vs disk spool — touches NATS topology,
see memory `nats-cutover-plan`) and P2-1 (per-thread session keying + wire changes).

---

## Cross-cutting: the reusable `plugin-sdk` runtime map (P0+P1+P2)

Every gap above that says "reuse" points at one of these **verified-present** subpaths
(`openclaw/src/plugin-sdk/<name>.ts`, importable as `openclaw/plugin-sdk/<name>`):

| Runtime | Gaps | What it gives |
|---|---|---|
| `persistent-dedupe` | P0-7 | claimable dedupe (idempotency) |
| `native-command-registry` | P0-3 | command catalog |
| `reply-dispatch-runtime` | P0-3, P0-5, P2-1 | reply payloads, `generateConversationLabel` |
| `approval-delivery-runtime` | P0-4 | native approval capability |
| `interactive-runtime` | P1-5 | `MessagePresentation`, button building |
| `plugin-runtime` | P1-5 | interactive handler dispatch |
| `media-runtime` | P1-4 | media read/save |
| `text-chunking` | P1-1, P1-3 | markdown IR, reasoning strip |
| `agent-runtime` | P1-3 | `formatReasoningMessage` |
| `channel-outbound` | P1-2, P2-4 | draft chunking, `ChannelIngressQueue` |
| `channel-contract` | P1-6 | `ChannelDoctorAdapter`, `ChannelStatusIssue` |
| `error-runtime` | P1-7 | error classification |
| `runtime-env` | P1-7, P2-5, P2-6 | backoff, subsystem logger |
| `conversation-runtime` | P2-1, P2-7 | session bindings, pairing store |
| `routing` | P2-1 | agent session keys |
| `plugin-state-runtime` | P2-1, P2-4 | persistent keyed store |
| `channel-pairing` | P2-7 | pairing challenge |
| `security-runtime` | P2-7 | access-group expansion |
| `runtime-group-policy` | P2-7 | group policy resolution |
| `allow-from` | P2-7 | sender-id matching |
| `status-helpers` / `channel-feedback` | P2-2 | reaction levels/emoji |
| `gateway-runtime` | P2-6 | channel status telemetry |

**Guiding principle:** WebChannel is a new *transport* for openclaw's existing *content + policy
model*. The less we reinvent, the more we inherit parity with every other channel for free.
