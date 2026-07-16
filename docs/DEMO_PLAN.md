# Showcase Demo Plan — one demo, three packages, six "power scenes"

> Status: plan v2 (2026-07-03) — v1 reviewed by two sub-agents (fact-check +
> capability sweep); corrections R1/R2/R5-R7 and three new scenes folded in.
> Replaces the deleted demo launchers (`114b03c`) with a **from-scratch** demo
> under `demo/`. Zero reuse of the retired demo assets (`ci-smoke.html`,
> `browser-demo-entry.ts` `runDemo`, `ENABLE_DEMO_UI` surface) — the demo
> composes **production primitives only** (`packages/{saas,plugin,client}`).
> CI harnesses (`e2e/local/*`) are untouched.

## Goal

One page that weaves the three packages into a story a viewer cannot mistake for a
toy: SaaS is the trust authority, the plugin is an ingress-free agent fleet, the
client is a full-protocol widget — and the relay between them needs no trust
beyond availability (passive-hostile; see Honest-demo notes on C2).

**Base layer** (table stakes, all on the production `WebChannelNatsClientWrapper`
state): login → typing indicator → streaming progress draft → real-LLM answer,
HITL exec-approval cards, `/help` slash command, page-reload → history hydration,
status/terminal-error surfacing.

**Power scenes** (the non-obvious freedoms):

| # | Scene | Freedom proven |
|---|---|---|
| ① | One identity, an agent fleet — admin grants/revokes agents per user live; widget grows/loses lanes | SaaS as sole access authority (`aud` as list) |
| ② | Agents appear from anywhere — a NEW agent enrolls live from "another machine", approved (or denied) in the admin panel, instantly reachable | Zero inbound listeners: admission rides the agent's outbound NATS connection (register is NATS request/reply) — the SaaS-delivered rendezvous is only the shared relay `natsUrl`, no gateway URL |
| ③ | The relay may be hostile — ciphertext-only wiretap; injected tamper silently dropped (AAD); **stolen-JWT replay defeated by PoP**; relay restart mid-chat self-heals **with the user's in-flight message queued and delivered**; cross-tenant subscribe → live `-ERR Permissions Violation`; encryption-off config refuses to boot | Confidentiality (vs passive relay) + integrity + authentication + availability |
| ④ | Many users, one agent — user A's exec approval card appears only in A's widget; non-approver's decision is rejected fail-closed; different users' turns run in parallel, each user's turns in order | Per-peer routing + HITL approver authz on a shared agent |
| ⑤ | Time-bounded trust — a short-TTL credential lapses: the widget flips to a terminal "credentials expired" state (no eternal spinner), one re-auth click restores the lane | Short-lived creds + honest terminal-error UX (CL2) |
| ⑥ | E2E *and* multi-device — a second tab/device syncs live ciphertext and decrypts backlog via per-device key-wrap (Phase 6 — **built + verified**; `demo/verify-multidevice.mjs`) | E2E crypto compatible with multi-device + history |

## Locked decisions (2026-07-03 review with owner)

- **Scope:** phases 1–4. Phase 5 asides picked per-audience after the demo runs;
  phase 6 (multi-device E2E) is its own milestone.
- **Gateway model — self-contained, with the connect experience surfaced.**
  webchannel is an *openclaw plugin*, not a standalone app, so the demo MUST have
  at least one openclaw gateway process to host it. `run.sh` boots that gateway
  itself under an **isolated `OPENCLAW_HOME`** (`node_modules/.bin/openclaw`,
  the devDep `2026.6.10`) — the user's real `~/.openclaw` is never touched — for
  one-click reproducibility. The "connect to openclaw" experience is preserved by
  **echoing the real `openclaw channels add webchannel` / `gateway run` commands
  to the console** as run.sh executes them, so a viewer sees exactly the two lines
  that attach the plugin to a gateway. **BYO-gateway** (a `--byo-gateway` flag
  where run.sh boots only the SaaS and the operator attaches their *own* openclaw)
  is deferred to **backlog** — documented, not built this pass.
- **`aud` scalar (phase 2):** when `aud` becomes an array, the top-level
  `accountId` claim stays as `aud[0]` ("primary"). It is read only by
  `device-flow-enrollment.ts:354` (subject-token validation), never by routing.
- **LLM echo fallback is a config/orchestration concern, zero product change.**
  The agent talks to whatever OpenAI-completions endpoint `openclaw.json` names.
  `run.sh` points that provider at the real z.ai endpoint when `ZAI_API_KEY` is
  set, else at `e2e/local/echo-openai-server.mjs` (a fake completions server) and
  passes `DEMO_LLM_MODE=echo` → SaaS injects it into `__DEMO_CONFIG__` → the web
  UI shows an "Echo mode (no real model)" badge. No plugin/client code touched.
- **Admin surface:** a seeded `admin` login gates `/admin/*` (session-checked).
  The single-page 3-pane layout (admin · chat · wiretap) renders the admin pane
  only for an admin session, so one screen shows approve → chat → wiretap.

## Relay: self-hosted default, Synadia optional

- **Default `DEMO_RELAY=local`**: a demo-owned JWT-auth `nats-server` fed by the
  demo trust chain. (Bootstrap step runs trust-chain setup with
  `NATS_CONFIG_OUT=<dir>` — an env-driven output directory producing
  operator.jwt + resolver preload — and the runner assembles the nats-server
  config from those, as in `e2e/local/run-all-real.sh:89-127`.) Required for
  scene ③ (we must own the relay to kill/tamper it) and consistent with the C2
  accepted-risk posture (self-operated relay only until the authenticated
  registration lands).
- **Optional `DEMO_RELAY=synadia`**: external managed-account mode via the proven
  `mintNatsUserCreds({ issuerAccountId, accountSeed: <signing seed> })` path
  (`packages/saas/src/nats-user-creds.ts:46-54,109-117`,
  `external-nats-account.test.ts`). Needs `SYNADIA_ACCOUNT_ID` +
  `SYNADIA_SIGNING_SEED` + `SYNADIA_NATS_URL`. Scene ③ chaos controls are
  disabled in this mode; the wiretap pane still works (ciphertext-only is *more*
  persuasive on a real third-party relay). Call out C2 explicitly in the demo
  README when this mode is used.

## Topology constraint (load-bearing)

**One gateway per agent for the fleet scenes.** The register handler dispatches by
aud peek, FIRST match wins (`resolveAccountIdForJwt`,
`packages/plugin/src/register-dispatch.ts:21-31`) and ignores any client-supplied
accountId — so a single multi-aud JWT registers into only ONE account per
gateway. The fleet therefore runs each agent on its own gateway process
(19299/19399/…). Register is a **NATS request/reply** on the account's
`.register` subject (not an HTTP route), so the SaaS `/me`/`/bootstrap` response
delivers only the shared relay `natsUrl` per account — there is **no `registerBaseUrl`
and no gateway URL**; the widget lane derives its register subject from
`tenant/accountId/peerId`. (This also IS the scene-② story: agents are independent
processes on independent machines, reachable with zero inbound listeners.)
True single-gateway multi-agent-from-one-login would need a register-route
change — out of scope. A single gateway multiplexing several accounts
(`planAccounts`, `packages/plugin/src/multiplex.ts:50-77`) remains real and may
be shown as an aside with *different users* per account, but the fleet-from-one-
login story spans gateways.

Admission for every demo account is `register-hop` — the sole admission path and the
default for `auth.strategy="jwt"`: only the register hop populates the aud map + verifier
(`index-nats.ts:690-729`). run.sh does not need to set `admission` explicitly.

## Layout

```
demo/
  README.md            demo script (the 6-scene walkthrough) + run instructions
  run.sh               boots everything; Ctrl+C tears down; DEMO_RELAY switch
  add-agent.sh         scene ②: boot another gateway ("another machine") that device-flow enrolls
  chaos.sh             scene ③: kill-relay | restart-relay | tamper | replay-jwt | cross-tenant
  saas-server.ts       fresh demo SaaS: trust chain + enrollment + users/grants + bootstrap + static web
  web/
    index.html         one page: admin panel | chat widget | attacker/wiretap pane
    src/app.ts         UI shell: login, agent switcher, panel wiring
    src/widget.ts      chat widget rendering WebChannelNatsClientWrapper state
    src/admin.ts       enrollment approve/deny + user↔agent grant/revoke chips
    src/wiretap.ts     raw NATS subscription pane (ciphertext hex) + attacker buttons
```

Build: esbuild IIFE bundle (same toolchain the repo already uses), no framework,
served by `saas-server.ts`. `demo/` joins the root `npm run typecheck`.

Ports (fresh block, no harness collisions): gateway₁ 19299, gateway₂ 19399,
gateway₃ 19499, NATS ws 18722 / tcp 14722, demo SaaS 3961, echo fallback 18905.

## Phase 1 — skeleton (base layer + wiretap)

Everything here is demo-side; **zero product-code changes.**

1. `demo/saas-server.ts` — compose `packages/saas` primitives directly:
   - `loadOrCreateTrustChain()` (`persistent-trust-chain.ts:49`) under the demo
     home → operator/account JWTs, JWKS at `/.well-known/jwks.json`. A bootstrap
     step runs it with `NATS_CONFIG_OUT=<dir>` so the runner can assemble the
     nats-server config (operator.jwt + resolver preload), per
     `e2e/local/run-all-real.sh:89-127`.
   - `DeviceFlowEnrollment` + `POST /admin/enrollments/:code/{approve,deny}`;
     approved enrollments mint tenant-scoped NATS user creds. Deny + the 10-min
     code expiry (`device-flow-enrollment.ts:402-405,509-515`) are surfaced too
     (scene ②'s "authority can say no").
   - User directory (id/pw, session cookie, server-derived stable `peerId` =
     user uuid) + `GET /bootstrap` minting the RS256 bootstrap JWT
     (`cnf.jwk` X25519 + `pop_jwk` Ed25519). Phase 1 mints a single-account `aud`;
     phase 2 makes it a list. The response also carries the per-account
     rendezvous map `accountId → { natsUrl }` (see Topology constraint) — only the
     shared relay URL, no gateway URL — so the browser never learns the relay from
     local config and never dials the agent directly.
   - `/admin/users` grant/revoke API (in-memory, seeded).
   - Serves `demo/web` + the demo config.
2. `demo/run.sh` — isolated `OPENCLAW_HOME`; boot order: saas-server → nats-server
   (from the assembled config) → LLM (real model when a provider env key is
   present — `ZAI_API_KEY` env beats agent-stamped sqlite provider auth — else the
   e2e echo fallback) → `openclaw channels add` for `agent-dev` (device-flow
   enroll, auto-approved on first boot only) → `gateway run` (consume-only).
   Gateway config: `auth.strategy="jwt"` (⇒ `register-hop` admission — do NOT set
   `admission:register-hop`), `execApprovals.enabled` + `execApprovals.approvers` = the
   demo peer ids, history on.
3. `demo/web/` — widget on `WebChannelNatsClientWrapper` (full protocol already
   reduced to state, `nats-client-wrapper.ts:207-311`): message list with
   working-draft bubbles, isTyping row, approval cards
   (allow-once/always/deny), history hydration on reload, status pill incl.
   terminal `error` + reason. Wiretap pane: a second NATS connection on
   demo-minted observer creds (pub+sub on `webchannel.{tenant}.>`,
   `nats-user-creds.ts:100-101`) subscribes the conversation subject and renders
   raw frames as hex — visibly ciphertext while the chat pane shows plaintext.
   A fail-closed aside: flipping `encryption.mode="disabled"`
   (`encryption-policy.ts:43-68`) makes the gateway refuse to boot.

**Exit criteria:** `./demo/run.sh` → login → full-UX chat with a real model;
reload restores history; wiretap shows ciphertext only.

## Phase 2 — fleet + shared agent (scenes ①, ②, ④)

The only product-code change before phase 6:

1. `packages/saas/src/bootstrap-claims.ts` — `aud: string` (`:62`, set at `:96`)
   → mint `aud` as an array; keep a single-string overload for back-compat. The
   plugin verifier is already array-aware (`jwt.ts:259-274`) and the multi-aud
   router exists (`peekUnverifiedJwtAudiences` `jwt.ts:368` →
   `resolveAccountIdForJwt` `register-dispatch.ts:21`). Decide whether the
   dangling top-level `accountId` claim (`bootstrap-claims.ts:65,99`, read only by
   `device-flow-enrollment.ts:354`, NOT by routing) stays as "primary" or drops.
   Unit tests beside `bootstrap-claims.test.ts`.
2. Demo server: grants become a list; `/bootstrap` mints the full granted `aud`
   list + the per-account rendezvous map; `/me` exposes it for the switcher;
   grant/revoke mutate it.
3. Widget: agent switcher — one lazily-connected wrapper client per granted
   account, each pointed at its account's gateway via the rendezvous map. Revoke →
   that lane goes terminal on its next register/bootstrap (proven revoke→403);
   grant → a new lane appears on the next `/me` poll.
4. **Pre-boot BOTH agent gateways at phase start** (R7 sequencing): `agent-dev`
   (19299) and `agent-ops` (19399), disjoint aud maps. Scene ① grants/revokes
   across this 2-lane fleet.
5. `demo/add-agent.sh` (scene ②): boots a THIRD gateway under its own
   `OPENCLAW_HOME` (the "laptop/container" narrative) running `channels add` for
   `agent-docs` (19499) — its device-flow request pops in the admin panel;
   approving it makes the agent selectable in the already-open widget; denying it
   shows the authority refusing. No ports, no browser config touched.
6. **Scene ④ (many users → one agent), works-today wiring:** open two browsers on
   the SAME agent. User A triggers an exec approval — the card is delivered only
   to A's originating peer (`approvals.ts:464-479`, `prepareTarget:361-370`), not
   B. A non-approver's decision is rejected fail-closed before any gateway RPC
   (`handleApprovalDecision:602-622`). Different users' turns run in parallel,
   each user's in order (`inbound-queue.ts:60-119`).

**Exit criteria:** one login reaches two agents; live grant/revoke adds/kills
lanes; a new agent enrolled mid-demo becomes reachable without touching the
browser; a shared agent isolates per-user approvals.

## Phase 3 — chaos + authentication (scene ③)

Demo-side scripting only; all primitives ship today.

- `chaos.sh restart-relay` — kill + restart `nats-server` mid-conversation. The
  widget shows `reconnecting → connected` (CL3 keepalive `nats-client.ts:539-560`
  + client backoff), the gateway self-heals (S1), and — the strong beat — a
  message TYPED while the relay is down is queued and delivered in order on
  reconnect, only ever as ciphertext, never lost (`nats-client.ts:845-869`
  buffered-seal + `connectionEpoch` guard).
- `chaos.sh tamper` — publish a bit-flipped copy of a captured ciphertext frame to
  the peer's `.out` using observer creds; wiretap highlights the injected frame;
  chat pane stays clean (AEAD-open returns null → dropped, `nats-client.ts:837-842`).
- `chaos.sh replay-jwt` — **authentication leg**: replay a captured
  `/webchannel/nats/register` POST (or the same signed nonce twice). Server
  returns 401 — the nonce is single-use and burned even on a bad signature
  (`pop-challenge.ts:106-154`) — while the real browser registered fine. A stolen
  bootstrap JWT off the wiretap can't register a peer without the device key.
- `chaos.sh cross-tenant` — mint tenant-b creds, attempt to subscribe
  `webchannel.tenant-a.>`, surface the live `-ERR Permissions Violation`
  (`nats-permissions-realserver.test.ts` enforces this).

**Exit criteria:** all four run against a live conversation without breaking it.

## Phase 4 — time-bounded trust (scene ⑤)

Demo-side wiring; client logic done.

- Mint a short-TTL credential; on lapse the client classifies NATS
  `Authentication Expired` / `Authorization Violation` as TERMINAL
  (`nats-client.ts:425-441` → `failTerminally:512-532`), stops reconnecting, and
  the wrapper promotes it to a sticky `status:"error"` with reason
  (`nats-client-wrapper.ts:103-106`). The widget shows a distinct "credentials
  expired — re-authenticate" state (NOT the reconnect spinner). One re-bootstrap
  click restores the lane.

**Exit criteria:** an expiring credential yields an honest terminal state, not an
eternal spinner; re-auth recovers.

## Phase 5 — optional operator asides (pick per audience)

Low-cost extras that deepen the "SaaS is the authority" story; none block the
narrative:

- **JWKS rotation + eviction — BUILT (`c3d320c`, `d64d291`).** Admin pane has a
  "Signing key" control: **Rotate key** (grace — new `kid` prepended, old kept →
  a fresh JWT verifies after the gateway's one live JWKS refetch, ZERO downtime)
  and **Rotate + evict old** (JWKS reduced to the new kid → a JWT under the evicted
  kid is rejected with a clean 401). Only the RS256 key rotates; NATS creds are
  untouched, so live sessions are unaffected. Product touch: export
  `generateRsaKeypair` (additive) + `auth.ts` maps a verify-time throw (unknown
  kid) to a 401 not a 500. Drivers: `demo/verify-rotate.mjs` (zero-downtime),
  `demo/verify-evict.mjs` (evicted-kid rejected). Both verified live.
- **One gateway, many accounts — BUILT (`demo/multiplex.sh`).** ONE gateway
  (:19599) enrolls team-sales + team-support under a single OPENCLAW_HOME;
  `planAccounts` builds one NatsChannel per account and the single register
  handler (on each account's `.register` NATS subject) dispatches each browser by
  JWT `aud`. alice → team-sales, bob → team-support, both served by the SAME
  process. There is no gateway URL to compare anymore (rendezvous is only
  `natsUrl`), so the driver proves the single-process claim by driving both live
  chats. Process-level tenancy, distinct from scene ②'s per-machine story. No
  product change — pure orchestration. Driver `demo/verify-multiplex.mjs` (verified
  live: one-gateway-two-accounts=OK, both users chat).
- **Real managed relay — BUILT (`DEMO_RELAY=synadia`, `9db3a42`).** The whole demo
  runs over Synadia Cloud / NGS instead of the demo-owned nats-server: the SaaS
  still owns the RSA/JWKS bootstrap chain but mints NATS user creds signed by an
  operator's account signing seed (external mode), so browser + agents connect to
  `wss://connect.ngs.global`. The wiretap over a real third-party relay is the star
  — ciphertext only. Secrets live in `synadia.env` (outside the repo, never
  committed). Verified live: reply/wiretap/history all OK. **Surfaced + fixed a
  latent product race:** the one-shot authenticated registration could be dropped on a real
  (higher-latency) relay because core NATS has no retention and the agent's per-peer
  SUB may not be server-active when the browser publishes; the client now
  republishes the registration (500ms × 5) until answered. Local sub-ms latency always
  hid it. `openclaw.plugin.json:216-249` BYO-NATS (fully SaaS-issuer-less static
  creds) is the further end of this spectrum, not yet built.
- **Agent-initiated outbound** (`index-nats.ts:732-744`, primary account) —
  **DESCOPED (owner decision, 2026-07-03).** The plugin's core-initiated outbound
  seam (`channel.ts:175`) is already wired; what stayed unverified is whether an
  openclaw cron `agentTurn`/`CronDelivery announce` (or a tool-send) populates
  `ctx.to` for a specific browser peer and binds the session. Left as a documented
  future scene rather than built. **Phase 5 is closed at 3 of 4 asides built.**

## Phase 6 — multi-device / late-join E2E (scene ⑥; real product work)

Separate milestone with its own design pass. The crypto components are done and
tested (`late-join-decryptor.ts` key-wrap; `multidevice-broadcast.test.ts:40-52`)
but **not wired into `index-nats`/`nats-channel` or the client wrapper**.

**Correction (both halves are ONE milestone):** live-sync is NOT cheaper than
backlog. A second tab derives its own X25519 session key, so it cannot decrypt a
live broadcast without the wrapped conversation key either — the shared key must
be distributed to it exactly as for backlog (`multidevice-broadcast.test.ts:40-52`).
Scope live-sync + backlog together.

Needs: a key-wrap delivery wire frame, agent-side wrapped-key issuance on
second-device register, wrapper-side conversation-key unwrap + backlog decryption.
When C2 pinning also lands, note that a single `/bootstrap` currently carries ONE
agentPublicKey (`saas-bootstrap.ts:121,222`) — a fleet will then need an
`accountId → agentPublicKey` map. Land as product commits first; the demo then
adds the two-device scene consuming it. Not blocking phases 1–5.

## Phase 1 status (2026-07-03) — built + verified

`demo/{saas-server.ts, run.sh, tsconfig.json, verify-e2e.mjs}` + `demo/web/{index.html,
src/{config,app,widget,admin,wiretap}.ts}` all land; `demo/` joins root
`npm run typecheck`. `./demo/run.sh` boots the full stack (saas → nats-server →
echo → `channels add` → admin-approved → gateway registered) and a headless
Playwright driver (`verify-e2e.mjs`) confirms the working exit criteria: **login →
chat → echo reply ✓, wiretap ciphertext ✓**. One criterion is a known openclaw
gap (below).

- **History hydration on reload — RESOLVED (2026-07-03), plugin-only, no openclaw
  core change.** Two independent causes were stacked; fixing the first exposed the
  second. (This trace predates the register-over-NATS migration — the register hop
  named below was an HTTP plugin route at the time; it is now a NATS request/reply,
  but the detached-async-context read and register-complete snapshot carried
  forward unchanged, and Phase 6 later added the register-delivered snapshot on top.)

  **Cause 1 — scope (`missing scope: operator.read`).** `historyRecent` runs inside
  webchannel's `auth:"plugin"` register route. openclaw wraps every plugin-route
  handler in an async-local (ALS) gateway scope whose operator client scopes are `[]`
  whenever `route.auth !== "gateway"` (`plugins-http-CM1BGr1B.js:37`); the in-process
  `sessions.get` dispatch (`getSessionMessages`) inherits that empty-scope client,
  which shadows the fallback synthetic `operator.write` client
  (`server-plugins-CLZE4NgR.js:221,233`), so `operator.read` is denied. No
  openclaw.json key or gateway flag changes it — `getSessionMessages` (unlike
  `deleteSession`, `server-plugins:363-372`) exposes no `forceSyntheticClient`.
  **Fix:** run the read inside a `node:async_hooks` `AsyncResource` constructed at
  module-evaluation time — before any request scope exists — so `runInAsyncScope`
  re-establishes that clean, client-less context. With no ambient scoped client the
  dispatcher falls through to the synthetic `operator.write` client (which implies
  `operator.read`) and the read succeeds. This is option (2) from the original
  trace; the "openclaw doesn't expose the ALS seam" caveat was wrong — `AsyncResource`
  IS the seam. See `runDetachedHistoryRead` in `index-nats.ts`.

  **Cause 2 — timing (fail-closed `no session key yet`).** With the read fixed, the
  snapshot was still dropped: it was sent from the register hop, which completes
  BEFORE the E2E authenticated registration, so `sendHistory` had no per-peer session key and
  fail-closed (correctly — never plaintext). **Fix:** send the initial snapshot from
  a new `NatsChannel.setHandshakeCompleteHandler` (fires at the end of the
  handshake handler, once `peerSessionKeys` is set) instead of the register hop. That
  handler also runs outside the HTTP request scope, so it composes cleanly with the
  detached read.

  Verified end-to-end (`demo/verify-e2e.mjs`, now a HARD criterion): reload restores
  the prior turn. Not the plugin-side `HistoryStore` (that serves late-join/multi-device,
  Phase 6). No upstream dependency; the openclaw `getSessionMessages`/`deleteSession`
  asymmetry remains worth filing but is no longer blocking.

## Phase 2 status (2026-07-03) — fleet built + verified

`bootstrap-claims.ts` aud→`string|string[]` landed (9 tests). run.sh boots a
2-gateway fleet (agent-dev + agent-ops) via `boot_agent()`; app.ts is an agent
switcher (tab per granted account, `/me`-poll for live grant/revoke); add-agent.sh
enrolls a 3rd (agent-docs) that registers its rendezvous via the new admin-gated
`POST /admin/accounts`. Verified live with headless drivers: **scene ① grant grows
a tab / revoke shrinks it + the new lane echoes ✓; scene ② add-agent → approve →
rendezvous-register → grant → selectable + echoes ✓; scene ④ two browsers on one
agent get their own echo with NO cross-peer leak ✓.** scene ④'s exec-approval
isolation leg needs a real tool-calling model (echo issues no exec) — the wiring
exists (`approvals.ts` prepareTarget + handleApprovalDecision, widget renders
cards); demo it on a real model.

## Phase 3–4 status (2026-07-03) — chaos + short-TTL built + verified

**Phase 3 (scene ③) — chaos 4/4 verified.** chaos.sh + chaos-nats.ts (raw
NATS-over-WS + register-hop replay). All verified live: **restart-relay**
(availability — queued-during-outage message delivered on reconnect);
**cross-tenant** (isolation — `-ERR Permissions Violation` for tenant-b on
tenant-a); **tamper** (integrity — bit-flipped .out frame AEAD-dropped, chat
clean); **replay-jwt** (authentication — register nonce single-use, first 200 +
replay 401). Active-MITM still out of scope (C2).

**Phase 4 (scene ⑤) — short-TTL verified.** Product: `mintNatsUserCreds`
gains opt-in `ttlSeconds` → user JWT `exp` (non-expiring by default, 15 tests
unchanged). Demo: `/nats-user` accepts a bounded ttl; widget.ts `connectLane()`
+ a "⏱ short-lived" control reconnect with a 12s credential. Verified live: the
credential lapses → `-ERR 'User Authentication Expired'` → terminal "Credentials
expired" box (no eternal spinner) → one-click Re-authenticate restores the lane.

**Scene coverage: base layer + ①②③④⑤ all built + verified** (④'s exec-approval
isolation leg needs a real tool-calling model; ⑥ multi-device is Phase 6, out of
this scope).

## Honest-demo notes

- **Active-MITM is NOT claimed (C2).** The E2E session key is derived from
  whatever pubkey arrives on the `.handshake` subject; the client does not yet pin it against
  the SaaS-attested `agentPublicKey` that `saas-bootstrap.ts:222` already extracts
  (`nats-client.ts:828-834`). So scene ③ proves confidentiality vs a **passive**
  wiretap + integrity vs **blind** tamper (AAD drop) + authentication (PoP) +
  availability — but an **active** relay substituting its own registration key could
  decrypt. That is the deferred C2 hardening; the demo must not claim active-MITM
  resistance. `DEMO_RELAY=synadia` inherits this caveat (call it out in README).
- **Revoke is enforced at the rendezvous** (bootstrap/register), not by killing an
  established E2E session mid-flight — browser NATS creds are tenant-wide today.
  Per-account NATS creds + live session kill is a known follow-up; the demo
  narrates what is actually enforced.
- **The echo LLM fallback** exists so the demo boots creds-free, but the scripted
  walkthrough assumes a real model (approvals + slash commands need one).
- **Scene ③'s tamper proves *drop*, not *detection UX*** — a dropped-frames
  counter in the client is optional polish, not claimed.
- **`capabilities.typing:"off"` is silently ignored on the NATS path**
  (`nats-channel.ts:293` sends unconditionally) — irrelevant to the demo (wants
  typing ON), noted only so the off-knob isn't advertised as working. Pre-existing
  latent bug, outside this effort.