# Phase 6 — Multi-Device E2E — Design Plan

> **Issue #54 update:** Each runtime verifier is fixed to its account id and
> `auth.jwt.audience` is removed. A signed multi-value `aud` remains supported as
> an authorization set: each concrete connection selects one authorized target
> and receives that target's matching pin. What is historical below is
> audience-based runtime routing/config override and any one-response fleet
> pin-map proposal, not multi-account authorization in a signed `aud` array.

Status: **DONE (2026-07-03, branch `feature/showcase-demo`, 7 commits
`9603f2f..56d5a84`) — all W1–W7 landed, §12 acceptance PASSED, fresh-agent
review PASSED (0 critical; all 5 findings fixed in `56d5a84`).**
Verified: `demo/verify-multidevice.mjs` 6/6 × 4 consecutive runs · K-restart +
divergence + race unit tests · all 6 live e2e harnesses · all 6 demo drivers ·
suites 736 plugin / 136 client / 115 saas green · secret scan clean.
Interview: `interview_20260703_043054` (ambiguity 0.06, Restate gate passed).
Owner decided to SKIP `ooo seed` — THIS DOCUMENT was the implementation spec.
Memory ref: [[phase6-multidevice-design]] · related: [[showcase-demo-build]], [[e2e-nats-relay-seed]]

**Follow-ups (out of Phase 6 scope):** live-gateway migration auto→register
admission (MUST include `session.dmScope: "per-channel-peer"`), K rotation.

### Post-implementation findings (durable — verified against code/live runs)

1. **Cross-user history leak via `session.dmScope: "main"` (pre-existing).**
   openclaw's default collapses ALL direct peers into ONE agent session, so the
   register history snapshot (and `load_history`) delivers the SHARED transcript
   to every user, re-sealed to each requester's own K — crypto isolation held,
   session scoping didn't. Fixed in `demo/run.sh`
   (`"session": { "dmScope": "per-channel-peer" }`) and the plugin now WARNS at
   startup for any register-hop account still on `"main"`
   (`crossUserHistoryWarning`, `nats-admission.ts`). Hard requirement for any
   multi-user deployment.
2. **Live agent frame ≠ transcript (review finding 3, was real).** openclaw
   strips metadata sections from live replies but stores the raw model output,
   AND never stores the plugin's live frame id — so neither id- nor exact-text
   matching can pair a live agent bubble with its snapshot copy. Fix: 3-tier
   snapshot matching in `nats-client-wrapper.ts` (id → exact text+role →
   POSITIONAL: an agent reply follows its matched predecessor; adopt onto the
   live-id agent bubble at anchor+1, converging to the canonical stored text).
3. **Snapshot-vs-key race (review finding 2).** The register snapshot travels
   NATS while the wrapped K travels the HTTP response — no ordering guarantee.
   The client buffers (bounded 64) undecryptable `.out` frames and drains them
   the moment the session key is set (`pendingInbound`, `nats-client.ts`).
4. **Mid-turn-join gap (accepted).** The register snapshot reflects the core
   transcript at register time; a turn still flushing lands via live frames
   only, so a device joining mid-turn misses that turn's USER bubble until its
   next re-register/reload. Inherent to snapshot-at-register; the acceptance
   scene settles ~3s after an echo before register-triggering steps.
5. The demo widget exposes `globalThis.__webchannelState()` as a driver hook
   for state-level (id-accurate) assertions in verify drivers.

**Decision summary (details in §8/§11):** option B register-only; auto-admission keeps
legacy registration untouched (F5=a); wrapped-K delivered in the register HTTP response
(§7=①); stateless register (unconditional re-wrap + bounded snapshot, client
message-id idempotency); K persisted plaintext+perms at
`~/.openclaw-webchannel/<account>/`; K rotation + live-gateway admission migration
OUT OF SCOPE. Acceptance = §12.

---

## 1. Problem & goal

**Multi-device for the SAME user is a P0 product bug today — not a future feature.**
For a SaaS widget, one user with two tabs / two browsers / laptop+phone is routine,
and it currently BREAKS.

Ground truth of why:

| Anchor | Fact |
|---|---|
| `saas-server.ts` (mint) | `peerId = user.uuid` — **per-USER**, server-derived, body peerId ignored. |
| `nats-channel.ts:150` | `peerSessionKeys = Map<peerId, Uint8Array>` — one key slot per peerId. |
| `nats-channel.ts:536` | `peerSessionKeys.set(peerId, sessionKey)` runs on **every registration**. |
| `nats-channel.ts:417/421/425` | subjects are `webchannel.{tenant}.{accountId}.{peerId}.{in\|out\|registration}` — shared across a user's devices. |

So two devices of one user carry the **same peerId**, registration into the **same key
slot**, and the second registration **overwrites** the first device's session key.
Result — not "unsynced", but **one device dies**:

- inbound → the loser can't decrypt (fail-closed) → messages silently dropped;
- outbound → the agent holds the other device's key → can't open the loser's ciphertext.

Demo drivers use a single browser context, so this never surfaced in the showcase.

**Goal:** two+ devices of the same user share **one** conversation — same live
stream, same history, all decrypting — with **no** weakening of the E2E guarantee
(the relay never sees plaintext or the raw key) and **no** change to openclaw's
account↔agent binding model.

---

## 2. What we are NOT doing (rejected option A)

**Per-device distinct peerId** (`peerId = uuid + deviceId`) un-collides the key slot
but makes `route.sessionKey` diverge → **each device becomes a separate openclaw
conversation** → history fragments. That is a different product. **Rejected by owner.**

---

## 3. Design correction — keep the granularity, change only the key's ORIGIN

> An earlier draft framed this as introducing a new **"conversation key"** granularity.
> **That was a conflation and is wrong.** The existing granularity is already correct.

The encryption key is **already scoped exactly right**, and that scoping **already is
openclaw agent binding**:

```
index-nats.ts:619   new NatsChannel(transport, accountId, tenant, ...)   ← ONE instance PER ACCOUNT
                    account = JWT `aud` = binding.account = which agent  ← this IS openclaw binding
nats-channel.ts:150 peerSessionKeys : Map<peerId, key>                   ← keyed by peerId WITHIN that instance
```

So `(account-instance, peerId)` is already "the conversation" for the 1:1 product,
and it already respects binding (multi-account is isolated by having its own channel
instance + subject namespace). **We do not invent a new key concept and we do not
change the map's key.**

**The only thing wrong is the key's ORIGIN**, and that is the whole fix:

| | Today (broken) | Phase 6 |
|---|---|---|
| Map key | `peerId` | **`peerId` (unchanged)** — preserves binding |
| Map value | derived per-device registration, **overwritten each time** | **agent-owned key, generated ONCE per peerId, stable** |
| How a device learns the key | negotiates it via `handshakeSubject` X25519 | **receives it wrapped to its own pubkey** |
| 2nd device | overwrites → kills device 1 | value untouched → just gets its own wrapped copy |

The `if (!peerSessionKeys.has(peerId))` guard already present at `nats-channel.ts:519`
is exactly the "generate once, never re-derive" hook.

---

## 4. How it works (physical view)

```
        ┌───────────────────────────────────────────────┐
        │  agent (per-account NatsChannel instance)      │
        │  peerSessionKeys[peerId] = K   (generated once,│
        │      persisted; ALL ciphertext sealed with K)  │
        └───────────────────────────────────────────────┘
              │  wrap(K, chromePub)          │  wrap(K, safariPub)
              ▼                              ▼
        ┌───────────────┐              ┌───────────────┐
        │ Chrome        │              │ Safari        │
        │ unwrap → K    │              │ unwrap → K    │
        └───────────────┘              └───────────────┘

  reply:  agent seals ONCE with K → publishes ONCE to shared .out
          → NATS fans out identical ciphertext → BOTH devices open with K  ✅
```

**Key distribution reuses crypto that already exists and is tested**
(`late-join-decryptor.ts`, unwired):

- `wrapConversationKey(K, devicePublicKey)` — fresh ephemeral X25519 per wrap →
  ECDH → HKDF-SHA256 (`KEY_WRAP_INFO = "webchannel-key-wrap-v1"`) → ChaCha20-Poly1305
  seal of K. Returns `WrappedConversationKey {ephemeralPublicKey, nonce, ciphertext, tag}`
  (`late-join-decryptor.ts:167`, type at `:102`).
- `unwrapConversationKey(wrapped, devicePrivateKey)` — symmetric ECDH → same wrap key
  → Poly1305-verified decrypt → K. Device private key never leaves the device
  (`late-join-decryptor.ts:215`).
- `decryptBacklog(...)` — a late-joining device decrypts paginated stored history with K
  (`late-join-decryptor.ts:291`).

**The device public key is already on hand without a registration.** SaaS mints the
device's X25519 pubkey into the bootstrap JWT as `cnf.jwk`
(`bootstrap-claims.ts:127` — `cnf: { jwk: { kty:"OKP", crv:"X25519", x } }`), and the
register-hop verifies that JWT. So at register time the agent **already has** the
device pubkey to wrap K to — **no `handshakeSubject` round-trip needed**.

---

## 5. Consequence — the registration dies, and with it a whole class of races

Because the device pubkey arrives via bootstrap `cnf` (not via `handshakeSubject`), the
per-device authenticated registration is **no longer a key-negotiation step**. Dropping it
**removes the ROOT CAUSE** of the registration race we fixed in `1c81f0d`
(client republish 500ms×5): there is no one-shot key-exchange frame publish that can be
lost on a real relay, because the key is delivered by the agent, not negotiated by
the client.

Client today: `keyPair` + `sessionKey` set from the registration
(`nats-client.ts:679-680`), fail-closed buffering until `sessionKey` exists. Phase 6:
`sessionKey` = unwrapped K; the registration path (`registrationSubject`, retry timer,
`registrationSub`) is removed.

---

## 6. Wiring checklist (what actually changes)

| # | Where | Change |
|---|---|---|
| W1 | agent `nats-channel.ts` | Generate + **persist** K once per peerId (random 32B); seal live replies **and** stored history with K. Delete per-registration key derivation (the `set()` at :536 becomes "generate-if-absent"). |
| W2 | agent register route | On device register (peerId + `cnf.jwk` in hand): `wrapConversationKey(K, identity.devicePublicKey)` **in the register handler**, return the `WrappedConversationKey` **in the register HTTP response** (§7 — decided). Never via later pin-store lookup (§7.5 F2). |
| W3 | client `nats-client.ts` | Take the wrapped key from the register response → `unwrapConversationKey(..., devicePriv)` → use K to seal `.in` and open `.out` + backlog. Remove the `handshakeSubject` negotiation + retry machinery (subject to F5's auto-mode decision). |
| W4 | agent | Persist K so a gateway restart keeps history decryptable (K must survive process death — history at-rest is sealed with it). |
| W5 | client entry → crypto client | Plumb the **cnf device private key** from `browser-jwt-entry.ts` into `NatsCryptoClient` (constructor option) — today's per-epoch throwaway keypair (`nats-client.ts:833`) is NOT the cnf key (§7.5 F4). |
| W6 | client hydration | Make history hydration **idempotent by message id** — under shared K, another device's register-triggered snapshot on the shared `.out` is decryptable by all devices (§7.5 F7). |
| W7 | plugin `auth.ts` / verifier | Retire or repurpose `handshake-verifier.ts` + the peerId-keyed pin store — both belong to the negotiation model B replaces; the verifier was never wired anyway (§7.5 F3 / C2). |

Already done and reusable: wrap/unwrap/decryptBacklog (`late-join-decryptor.ts`),
broadcast fan-out model (`multidevice-broadcast.test.ts` — exactly-once per device,
identical ciphertext, cross-user isolation).

> **Status update (#153):** the at-rest store (`history-store.ts`) listed here was
> IMPLEMENTED AND THEN REMOVED. It never acquired a production caller and its
> backing was a plain in-memory `Map`, so it was never durable; the production
> history authority is OpenClaw core's session transcript, read through
> `history.ts` (`pageBefore` cursor pagination). Late-join hydration is served by
> `sendHistory` + `late-join-decryptor.ts`. The design below is retained as the
> record of the decision, not as a description of the current tree.

---

## 7. Delivery channel — decided by the pre-implementation audit: ① register response

> An earlier draft recommended ② (NATS frame) fearing a register-scope problem.
> The audit (§7.5) killed both premises. **① register HTTP response is correct.**

**Option ① — register HTTP response.** The register route wraps K to the JWT's
`cnf` pubkey and returns the `WrappedConversationKey` in its reply.
- ✅ The feared scope problem **does not exist**: wrapping needs only the channel
  object (K owner) + `identity.devicePublicKey` — the register handler already
  holds BOTH (`index-nats.ts:387-454`; cnf is extracted at `auth.ts:426-427`).
  The history-hydration `AsyncResource` issue (`81d61c4`) was about calling the
  openclaw **gateway API**; wrap calls nothing outside the plugin.
- ✅ Delivery is on an authenticated HTTPS request/response — **no pub/sub timing
  at all**. Device holds K before it even connects to NATS.
- ✅ Per-request wrap also sidesteps the pin-store collision (§7.5 F2).

**Option ② — NATS `conversation_key` frame** (rejected). Publishing the wrapped
key to a just-registered device **reintroduces the exact SUB-not-yet-active
delivery race we fixed in `1c81f0d`** — the one class of bug this design exists
to eliminate. No offsetting benefit once ①'s scope fear is disproven.

### 7.5 Pre-implementation audit findings (verified against code, 2026-07-03)

- **F1 (assumption confirmed)** — the device cnf pubkey is available at register:
  `auth.ts:426-427` extracts `identity.devicePublicKey` from the verified JWT.
- **F2 (new)** — the pinned-device-key store is **keyed by peerId** with
  delete-then-set overwrite (`auth.ts:63-64`) → the SAME last-writer-wins
  collision exists at the pin layer. Consequence: wrap must happen **per register
  request from the JWT in hand**, never by later store lookup. The pin store
  itself needs rework-or-retirement in W-items (see F3).
- **F3 (major)** — `handshake-verifier.ts` (pin check during registration = MITM
  prevention) is **UNWIRED** — zero references from `nats-channel.ts` /
  `index-nats.ts`. Today's registration is unauthenticated even on the registered
  path. **This is review finding C2 (relay MITM, accepted-risk).** Phase 6 B
  resolves C2 structurally: K is wrapped to the JWT-attested cnf key, so the
  relay can never inject its own key. C2 closure is part of Phase 6's value.
- **F4 (new wiring item)** — the client's registration keypair is **NOT the cnf
  keypair**: `browser-jwt-entry.ts:54` makes the device key for bootstrap, while
  `nats-client.ts:833` makes a **separate fresh keypair per connection epoch**.
  B requires plumbing the cnf device **private** key from the entry into
  `NatsCryptoClient` (constructor option) for unwrap. → new W5.
- **F5 (open — interview question)** — `admission:register-hop` (wildcard) accounts
  have **no register hop** → no JWT, no cnf → wrap impossible. Removing the
  registration globally leaves auto mode with NO key path — and **the live gateway
  runs auto mode today**. Options: (a) keep the registration ONLY for auto accounts
  (its posture is already "any tenant-creds holder"), (b) drop E2E on auto,
  (c) migrate the live gateway to register admission. → §8, must be decided.
- **F6 (non-blocker)** — the channel has no envelope replay/nonce guard (only
  approvalId dedup), so devices sharing K create no counter conflicts; replay
  exposure is unchanged from today's posture.
- **F7 (new constraint)** — shared K + shared `.out` means a snapshot triggered
  by device B's register is **decryptable by device A too** (today A silently
  drops it — wrong key; under B it opens) → duplicate history on A. Fix:
  client-side hydration must be **idempotent by message id**. The wrapped-key
  payload is harmless to other devices (unwrap fails, ignored) — and under ① it
  isn't on NATS at all. → new W6.

---

## 8. Other decisions — ALL CLOSED (interview `interview_20260703_043054`)

- **F5 — auto-admission fate** → **DECIDED (owner): (a) auto keeps the legacy
  per-device registration, untouched.** Option B applies ONLY to register-admission
  accounts. Rationale: the product/SaaS path is entirely register admission; auto's
  E2E is already opportunistic-only (unauthenticated registration, F3/C2) so nothing
  new is lost; plaintext fallback rejected as a security regression. **Live-gateway
  migration to register admission = separate follow-up, NOT Phase 6.** Consequence:
  the registration code path is NOT deleted — it becomes auto-mode-only; the register
  path must never emit/answer registration frames (guarded by the §12 divergence test).
- **W4 — K persistence** → **DECIDED (engineering, precedent-based):** K lives at
  `~/.openclaw-webchannel/<account>/` (per-account secret dir), per-peerId, plaintext
  JSON + owner-only file perms — the SAME posture as `credentials.json` (which holds
  the strictly-more-powerful NATS user seed; `account-config.ts:304-312`). K-at-rest
  encryption DEFERRED (co-located master key = theater). NOT the openclaw config
  store (dump/patch leakage), NOT a new storage seam (none exists in the plugin).
  Note: `HistoryStore` was in-memory only, which is part of why #153 removed it — so
  K persistence's Phase-6 purpose is keeping live devices' unwrapped K valid across
  gateway restarts (+ future-proofing for when history persistence lands).
- **Reconnect/rehydrate semantics** → **DECIDED (engineering): STATELESS register.**
  Every register (first join, page reload, socket reconnect — client already
  re-registers per connection epoch) unconditionally re-wraps K to the presented cnf
  pubkey and returns the full limit-bounded snapshot; client message-id idempotency
  (W6) absorbs duplicates. REJECTED: any client-supplied "I already have K" signal
  (client-controlled input to a security path → stale-K wedge = the bug class this
  design eliminates). Deltas remain the client's pull via existing `load_history`
  pagination. Property gained: SELF-HEALING — any wedged device state is fixed by
  one re-register.
- **K lifetime — fixed vs rotation?** → **Fixed key first.** Rotation/rekey+re-wrap is
  explicitly DEFERRED per the `late-join-decryptor.ts` docstring. A fixed K per peerId
  ships multi-device; rotation is a later, additive change (re-wrap to all devices).
- **Fleet / multi-account.** A single `/bootstrap` carries ONE agent pubkey; multi-
  account fleets need `accountId → agentPublicKey` + per-account K. Out of scope for
  the first cut (each account instance already owns its own K by construction).

---

## 9. Non-goals / invariants to preserve

- Relay stays **zero-knowledge**: plaintext and raw K never cross NATS; K only ever
  wrapped to a device pubkey.
- **openclaw binding unchanged**: key stays scoped to `(account-instance, peerId)`;
  no new cross-cutting grouping; `binding.account` routing untouched.
- **Fail-closed preserved**: a device with no K decrypts nothing (same posture as today).
- Device private keys never leave the device.

---

## 10. Implementation plan (seed skipped — this doc IS the spec)

Suggested order (each step keeps the suite green; W-items from §6):

1. **W1+W4 — agent K store** (`nats-channel.ts` + new `conversation-key-store.ts`):
   generate-once-per-peerId, persist to `~/.openclaw-webchannel/<account>/`
   (see §8 W4). On the REGISTER path, `peerSessionKeys[peerId]` is loaded/created
   from this store; the registration `set()` at `nats-channel.ts:536` remains ONLY for
   auto-admission accounts. Unit-testable without any client change.
2. **W2 — wrap in register route** (`index-nats.ts:387-454` region + `auth.ts`):
   after successful verify, `wrapConversationKey(K, identity.devicePublicKey)`
   (raw 32B from the cnf b64url `x`) and add it to the register response JSON, e.g.
   `{ ok: true, wrappedConversationKey: WrappedConversationKey }` (type from
   `late-join-decryptor.ts:102`: `{ephemeralPublicKey, nonce, ciphertext, tag}`,
   all b64url). Trigger the history snapshot from register (registered path no
   longer has a register-complete moment) — reuse the `81d61c4` detached-scope
   read; drop the `onHandshakeComplete` snapshot trigger on the register path.
3. **W5 — client keypair plumbing** (`browser-jwt-entry.ts` → `nats-client.ts`):
   pass the cnf device X25519 PRIVATE key into `NatsCryptoClient` (new constructor
   option). The per-epoch throwaway keypair (`nats-client.ts:833`) is removed on
   the register path.
4. **W3 — client unwrap** (`nats-client.ts` + browser unwrap impl): take
   `wrappedConversationKey` from the register response → unwrap with device privkey
   → `this.sessionKey = K`. Remove registration publish/retry/subscription machinery
   on the register path (keep for auto/legacy config). NOTE: client crypto is
   browser-side — port `unwrapConversationKey` (ECDH + HKDF-SHA256
   `"webchannel-key-wrap-v1"` + ChaCha20-Poly1305 open) into the client package's
   existing crypto module (`e2e-crypto-browser.ts` has the primitives).
5. **W6 — idempotent hydration** (client): dedup rendered messages by `id`
   (history frames already carry `id: string`, `nats-channel.ts:59`); ensure live
   message frames carry/align the same id so live-vs-snapshot overlap dedups.
6. **W7 — retire on register path**: `handshake-verifier.ts` (was never wired) and
   the peerId-keyed pin store become auto-mode-only or deleted; keep whatever auto
   still needs.
7. **Tests/acceptance** — §12. Then fresh-agent review (established workflow).

## 11. Interview decision record (for post-compact continuity)

| Q | Decision | Decided by |
|---|---|---|
| F5 auto-mode | (a) keep legacy registration on auto; B register-only; live migration = follow-up | Owner |
| W4 K persistence | `~/.openclaw-webchannel/<account>/`, per-peerId, plaintext+perms (= credentials.json posture); at-rest wrap deferred | Engineering (precedent) |
| Reconnect | Stateless register: always re-wrap + full bounded snapshot; no client "have-K" signal; self-heal via re-register | Engineering |
| 4a acceptance | Full set + negative controls, ONE Playwright scene (§12) | Recommended, confirmed at Restate |
| 4b divergence test | In scope, unit/integration level (§12) | Recommended, confirmed at Restate |

One-line goal (Restate-approved): *register-admission accounts drop registration key
negotiation; the agent generates+persists a per-peerId key K and wrap-delivers it to
each device's JWT-cnf X25519 key in the register HTTP response (stateless
re-wrap+snapshot, client message-id-idempotent hydration) so one user's multiple
devices decrypt one conversation concurrently; auto-admission keeps the legacy
registration; K rotation & live-gateway migration out of scope.*

## 12. Acceptance criteria (final)

**A. ONE Playwright two-browser-context scene** (extend the `verify-e2e.mjs` /
demo-driver style), sequential assertions:
1. Device A connects+chats; device B joins SECOND → **A still decrypts new
   inbound** (the original kill scenario, asserted against the original failure);
2. agent outbound decrypts on **both** devices (identical-ciphertext fanout);
3. **no duplicate message bubbles** on either device after B's register-triggered
   snapshot (W6 / audit F7);
4. device B **reloads mid-session** → recovers full history + live decrypt, zero
   manual steps (stateless self-heal).
Negative controls:
5. wiretap observer holding tenant NATS creds sees **only ciphertext** (reuse the
   existing verify-e2e wiretap pattern);
6. a **different user's** device cannot decrypt (K is per-peerId).

**B. Plugin integration test:** K survives gateway restart — restart, device
re-registers, OLD history still decrypts (same K re-wrapped).

**C. Unit divergence test (F5 guard):** register account → wrapped-K in register
response AND no registration frame emitted; auto account → registration fires AND no wrap
attempted.

**D. Existing suites stay green** (168 client / 748 plugin / 115 saas at time of
writing) + full typecheck.

---

## 13. Removed in #153 — design records retained

Two Phase 6 modules were implemented, never wired to production, and deleted in
#153. Their code is recoverable from git history; the reason they existed is
recorded here so the next person re-derives neither the design nor the decision.

### 13.1 `history-store.ts` — genuinely redundant

An in-memory ciphertext store with `loadHistory` cursor pagination (Sub-AC 2a).
Backed by a plain `Map`, so it was never durable, and it had no production
caller: `history.ts` reads OpenClaw core's session transcript (on disk, 0600)
and paginates with `pageBefore`, while late-joining devices are served by
`NatsChannel.sendHistory` + `late-join-decryptor.ts`. Nothing was lost.

### 13.2 `typing-indicator.ts` — a feature we chose not to build

NOT redundant — unbuilt. It was the browser → *the same user's other devices*
typing signal. The production `NatsChannel.sendTyping` / `setTypingEnabled` pair
runs the opposite direction (agent → browser), so the two never overlapped.
**Decision: not building it now.** The design, should it come back:

- Typing rides the existing `MessageEnvelope` wire format with
  `envelopeType === "typing"`, over the same E2E-encrypted NATS bus as
  conversation messages. The relay operator sees ciphertext plus routing
  metadata only; `{ typing: true }` is not observable without the session key.
- One choke point decides persistence: ephemeral envelopes are forwarded to live
  listeners and skipped on append; everything else is forwarded AND appended.
- Invariants: a typing signal fired while a peer is connected IS delivered live;
  it is NEVER present in history output; it is NEVER replayed to a late-joining
  device.
- Rate-limiting/debouncing is a UI concern for the client integration layer, not
  a transport primitive.

Reintroducing it costs one new frame type, which is explicitly NOT a protocol
version bump — see the bump rules in both `protocol.ts` files (#160) and the
measured evidence that both directions ignore frame types they do not know.
