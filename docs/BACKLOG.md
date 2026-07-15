# Backlog

Follow-up work that is deferred, not a functional gap. The single source of truth for current
state is [`STATUS.md`](STATUS.md).

## C2 — Authenticated handshake (mutual key attestation) — **SECURITY, hard blocker for untrusted relay**

**Status: accepted-risk (option A) for now.** The E2E channel currently provides confidentiality
against a *passive* relay only. The live X25519 handshake is **unauthenticated in both
directions**, so an *active* relay can MITM every conversation and approval. This is acceptable
**only while the relay is operated by a trusted party** (own `nats-server` / own Synadia account).
**This item MUST be closed before any deployment on a third-party-operated relay** (e.g. Synadia
NGS external mode where Synadia operates the relay). Until then, docs claiming "untrusted relay"
E2E have been softened (README.md, docs/ONBOARDING_GUIDE.md, packages/plugin/README.md,
packages/client/README.md).

**Root cause (verified 2026-07-02).** The verification machinery is ~70% built but not wired:
- `parseAndVerifyHandshake` / `verifyDeviceKey` (plugin) and `verifyAgentKey` /
  `parseAndStorePinnedKeys` / `getPinnedKeys` (client) have **zero non-test callers**.
- The live agent handshake (`packages/plugin/src/nats-channel.ts` `handleHandshake`) feeds the wire
  key straight into `deriveConversationKey` with no verification.
- The live wire frame is `{type:"key_exchange", pubKey}` (`e2e-session.ts`) — no `peerId`, no
  envelope — while the verifier expects a `handshake_hello` message with `devicePublicKey` +
  `peerId`. **Wire format must be reconciled**, not just "call the function".
- `jwt.ts` still admits bootstrap JWTs with **no `cnf` at all** (backward-compat) → often no pin to
  check.
- **Net-new work:** the SaaS receives the agent's X25519 key at enrollment
  (`device-flow-enrollment.ts:264`) but **never attests it back to the browser** — the browser has
  no trusted source for the agent key, so `verifyAgentKey` has nothing to check against.

**Scope of the fix (mutual attestation — option C):**
- [ ] browser→agent: make `cnf.jwk` mandatory in `jwt.ts` (drop the no-cnf backward-compat path, or
  gate it behind an explicit insecure flag); reconcile the `key_exchange` frame with the
  `handshake_hello` shape (add `peerId` or switch the live frame); call `parseAndVerifyHandshake`
  in `handleHandshake` **before** `deriveConversationKey`.
- [ ] agent→browser: SaaS signs/attests the enrollment-captured `agentPublicKey` to the browser
  (embed in the bootstrap JWT the browser already verifies, or a signed sidecar); browser calls
  `parseAndStorePinnedKeys` then `verifyAgentKey` before deriving the key.
- [ ] wire eviction for the pinned-key stores on disconnect (ties into the plugin unbounded-map
  cleanup).
- [ ] add an integration test that a substituted key on either leg aborts with `HandshakeMitmError`.

**Do NOT ship the browser→agent leg alone as an end state** — asymmetric authentication leaves the
agent-impersonation direction open while implying MITM is handled (false sense of security). It is
acceptable only as an intermediate commit toward the full mutual fix.

## S1 — accountId-aware outbound facade (proactive/approval outbound is primary-account-only) — **cross-account disclosure risk**

**Origin:** PR #5 (multiplex / 가-2 rename) adversarial review, 2026-07-01. Deferred, previously
untracked (this entry is the first written record outside the session notes).

**Current behavior** (`packages/plugin/index-nats.ts`, "lazy transport facade"): the plugin core
is created once at module load against a single `lazyTransport` Proxy; after `account startup` builds
one `NatsChannel` per account, the Proxy is bound to **one PRIMARY channel** (`"default"`, else the
first built account). Everything the core initiates **without a per-message account context** rides
that one channel: untargeted/proactive outbound (`untargeted recipient guessing`), typing/progress fan-out, and
the **approval capability** (`sendApprovalRequest`/`Resolved`). Inbound is NOT affected — replies
route per-account via each channel's own dispatcher.

**Failure scenario:** one gateway serves accounts A (primary) and B; the same `peerId` is
registered on both (same user granted both deployments — normal under the multiplex model, one
peerId spans a user's granted accounts). A **proactive** message or an **approval prompt**
originating from account A's agent context is emitted through the primary facade, which cannot
disambiguate by account — a browser session attached to account B for that peerId can receive
account A's content (encrypted with the peer's conversation key, so it decrypts fine and renders).
That is cross-account content disclosure to the *right user* but the *wrong deployment/tenant
boundary*, and an approval prompt surfacing in the wrong UI context invites a mis-scoped approval.

**Why deferred (REVISED 2026-07-04):** the original assessment ("requires a core seam change") was
WRONG for the approval leg. The openclaw SDK approval pipeline is already fully account-aware —
the approval request carries `turnSourceAccountId` (`plugin-approvals.d.ts`), and the SAME factory
we use (`createApproverRestrictedNativeApprovalCapability`) passes `{cfg, accountId}` to every hook
(`listAccountIds`, `hasApprovers`, `isNativeDeliveryEnabled`, `resolveOriginTarget`,
`deliverPending`). The bundled Telegram channel is the reference implementation: it enumerates real
accounts via `listAccountIds`, reads per-account `execApprovals`, and `deliverPending` resolves
`accountId → that account's client` at send time. Our plugin simply doesn't consume the seam —
"account-agnostic Phase 1" (`approvals.ts`): `listAccountIds: () => ["default"]`, hooks ignore the
`accountId` param, and delivery is closure-bound to the single primary-channel facade. The fix is
**plugin-local**; no openclaw core change needed for approvals.

**Scope of the fix (approvals leg — Telegram pattern) — ✅ DONE 2026-07-04 (3-lens adversarial review):**
- [x] `inbound.ts` `buildContext`: pass `accountId` (top-level `BuildChannelInboundEventContextParams.accountId`),
  so core stamps `turnSourceAccountId` on webchannel turns. Verified end-to-end through the dist
  bundle: `buildContext.accountId → ctx.AccountId → request.accountId → turnSourceAccountId`.
- [x] `approvals.ts` `listAccountIds`: return the real configured account ids (`listWebchannelAccountIds(cfg)`).
- [x] capability hooks account-aware: `readExecApprovals(cfg, accountId)` reads the merged
  `accounts.<id>.execApprovals` (execApprovals is a NESTED_OBJECT_KEY, so per-field account
  overrides compose with the channel-level base).
- [x] `deliverPending`/`updateEntry`: resolve `accountId → accountRuntimes.get(accountId).channel`
  via a `resolveApprovalTransport` resolver threaded `index-nats.ts → channel.ts → approvals.ts`.
- [x] widget-click authz `handleApprovalDecision` reads THIS account's approver set (index-nats
  passes the channel's accountId).
- [x] regression tests: two accounts + shared peerId → B-turn approval delivers on B's channel only;
  per-account isConfigured/approver gates; shared-base inheritance; single-account compatibility.

**Adversarial-round hardening (F1/F2 fixed same day; F3 documented + deferred):**
- [x] **F1** — id↔account binding: `handleApprovalDecision` now refuses a decision whose approvalId
  was not DELIVERED on the resolving account (the gateway RPC does no per-approval authz, so an
  approver on account B could otherwise replay A's random-UUID approvalId onto B's channel). A
  module-level `deliveredApprovalAccounts` map records the delivering account at `deliverPending`
  and is released at `updateEntry`.
- [x] **F2** — fail-closed delivery: when the resolver MISSES (an account core started a handler for
  but `account startup` skipped — creds-missing/connect-fail), the prompt is DROPPED, never routed to
  the closure/primary channel (which would re-open the misroute). Legacy WS (no resolver) keeps the
  single closure transport.
- [ ] **F3 (residual, deferred to the outbound leg)** — an approval with NEITHER `turnSourceAccountId`
  NOR a session-bound account is claimed by every account's handler (SDK matcher) → fans out to all
  LIVE accounts' channels. Only reachable via AGENT-INITIATED / cron approvals (a user turn always
  carries the account). Belongs to the proactive/untargeted outbound leg below (needs outbound-
  account semantics). F2 bounds the blast radius to live channels.

**Proactive/untargeted outbound leg (separate, still open):** core-initiated untargeted sends
(`untargeted recipient guessing` etc.) may still be account-blind at a different seam — decide semantics
(all accounts? per-account targeting? startup guard on the unsupported combination?) when
agent-initiated outbound is built. Until the approvals leg lands, the interim posture stands:
approvals on a multi-account gateway deliver via the primary channel only (misroute/drop for
non-primary turns).

**Telegram benchmark (2026-07-04, analysis only — deferred):** Telegram has no equivalent
ambiguity: (1) its addressing is account-scoped by construction (a chatId belongs to one
bot/account; the same human on two bots = two chatIds/sessions — no shared cross-account
identity, unlike webchannel's `webchannel.{tenant}.*.{peerId}.>` where one peerId spans N
accounts); (2) it has NO broadcast — `untargeted recipient guessing`/`single-recipient guessing` exist only in the
webchannel plugin; telegram always dials a recorded chatId; (3) a proactive/cron (system-event)
send resolves BOTH `to` AND `accountId` from the session's persisted delivery context
(`effective-reply-route.ts`: `accountId: ctx.AccountId ?? deliveryContext.accountId ?? entry.lastAccountId`).
**Portable finding:** S1 already laid the data — core persists `lastAccountId`/`deliveryContext.accountId`
per turn from `ctx.AccountId`, which the S1 inbound stamp now populates for webchannel, and webchannel
already forces `per-account-channel-peer` session keys (account encoded in the key). So the leg splits:
(a) SESSION-BOUND proactive/cron sends (incl. F3's cron approval) → adopt telegram's model, resolve
accountId from the session's delivery context → send on that ONE account's channel (small scope,
closes F3); (b) TRULY untargeted `untargeted recipient guessing` → telegram has no such operation, so the
defensible default is to retire/constrain blind broadcast in multi-account (require an account /
startup-guard the ambiguous combo, never primary-only fanout). The "peerId spans N accounts → which
one?" question is webchannel-unique and stays a product decision.

## ✅ N2 — register reply-to redirect guard tightened to own-reginbox-only (DONE)

**Origin:** PR #6 review (2026-07-04). Closed same day, stricter than originally scoped: the
consumer sweep found EVERY real consumer (production client `nats-client.ts` + all e2e/demo
drivers) uses exactly `webchannel.{tenant}.{accountId}.{peerId}.reginbox.{token}`, and `_INBOX.*`
appeared only in two unit tests — so the guard became a pure ALLOWLIST of that one shape (own
reginbox, non-empty token) instead of the planned "confine in-namespace, pass through the rest".

- [x] `handleRegister` allowlist guard (own reginbox + non-empty token; everything else dropped
  with a warn — other peers' subtrees, own `.in`/`.handshake`/`.register` self-bounce, `_INBOX.*`,
  foreign namespaces)
- [x] tests rewritten to the allowlist semantics (+5 cases: self-bounce, `_INBOX` drop, empty
  token, foreign-peer/prefix-peerId reginbox)
- [x] consumer sweep (precondition): all drivers reginbox-only, nothing broken
- [x] verified live: `run-enrolled-transport.sh` full register hop + encrypted round-trip PASS
- [x] adversarial review (3 lenses + a second reviewer): core property unbreakable, no availability
  regression; both flagged the SAME residual → token after `reginbox.` was prefix+non-empty checked
  but not validated as a single subject token, so `…reginbox.>` / dotted / whitespace tokens made
  the agent publish a wildcard/malformed subject (harmless to other peers — stays in the requester's
  own subtree — but emits an invalid-publish `-ERR` the transport only logs). Fixed: guard now
  `isValidSubjectToken(token)` (`subject-token.ts` new non-throwing predicate); +1 test case set.

**Residual (defense-in-depth, NOT this change):** the guard derives its allowlist prefix from
`peerId = parts[3]` (subject-routing segment) and its soundness leans on the browser-cred scoping
(`webchannel.{tenant}.*.{peerId}.>`, enforced in `packages/saas/src/nats-user-creds.ts`, test-pinned
against a real nats-server). Pre-JWT error replies (`nats-register.ts` bad-JSON/op paths) fire before
the `subjectPeerId === verifiedPeerId` check, so they rely entirely on that cred pin to stay in the
requester's own subtree. A BYO-NATS operator who loosens creds to tenant-wide would reopen a
low-impact cross-peer error-string leak. Optional hardening: hoist the subject==verified-peerId check
ahead of every reply so the guard is self-sufficient. Bundle with the NATS-cred-scoping follow-up.

## ✅ Direct gateway transport removal — DONE 2026-07-15

The browser-facing gateway transport, client, and smoke harness were removed. The NATS relay is now the sole browser path; unresolved outbound targets are explicitly dropped.


The earlier HMAC strategy and all direct-browser transport artifacts are removed.
