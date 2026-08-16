# Credential & conversation-key containment runbook

**You are here because a browser credential, an agent credential, or a
conversation key K may have leaked.** This document is the operator procedure.
Follow it top to bottom: the deployment-class question comes first because the
correct order of operations differs by class, and doing step ② before step ①
re-opens the hole you are closing.

Related: [`AUTH.md`](AUTH.md) (register hop, agent identity-key lifecycle,
offline re-key), [`ISSUE_72_CONTAINMENT_PLAN.md`](ISSUE_72_CONTAINMENT_PLAN.md)
(the design and its evidence), [`../CHANGELOG.md`](../CHANGELOG.md) (the #54
incident-response entry, which points here).

---

## 0. Before you touch anything

### 0.1 What you cannot undo

**Containment stops future use of leaked material. It does not restore secrecy
for anything already exposed.** Every message that was already delivered under a
leaked K, and every session already opened with a leaked credential, stays
exposed. Rotation and revocation do not heal the past. Treat the exposure window
as an incident to be reviewed on its own, separately from this procedure.

### 0.2 What is actually on disk

Do not go looking for encrypted peer state to invalidate — **there is none.**
Earlier guidance (CHANGELOG, #54) told operators to "invalidate the old
encrypted peer state". An operator following that instruction has nowhere to go,
because the thing it names does not exist. The correction:

- **K seals no history at rest.** The history authority is OpenClaw core's
  session transcript: plaintext JSONL at owner-only permissions, written by
  core, never by this plugin. `NatsChannel.sendHistory` seals the frame with the
  **current** K at delivery time. Replacing K therefore costs no re-encryption —
  the next read-and-deliver cycle simply reseals under the new key
  (`ISSUE_72_CONTAINMENT_PLAN.md` §1.4, RETAIN + RESEAL).
- **What this plugin writes**, per exact `(tenant, accountId)` tuple, under
  `$HOME/.openclaw-webchannel-v2/<v2_namespace>/`:
  - `credentials.json` — NATS user seed and agent identity key. Owner-only.
  - `conversation-keys.json` — the per-peer K store.
  - `conversation-key-generations.json` — the audit-only generation sidecar.
  - legacy migration artifacts under `$HOME/.openclaw-webchannel/`.

  That is the complete list. There is no separate ciphertext store to purge.
  (`packages/plugin/src/history-store.ts` exists but has no production caller.)
- **Rotating K does not disconnect anyone and does not revoke anything.** It is
  one of two independent controls. Section 2 tells you which ones you need.

### 0.3 The file-handling exception

[`packages/plugin/README.md`](../packages/plugin/README.md) forbids moving or
deleting the plugin's state files as normal operations, because doing so breaks
encrypted-history continuity and can strand live devices. **This runbook is the
exception that rule anticipates.** During a confirmed containment you will move
`credentials.json` aside (step ④-bis, per `AUTH.md`) and you will replace K in
`conversation-keys.json` (step ④). Both are done through the documented paths
below, with the gateway stopped. Outside an incident, the README rule stands:
do not hand-edit or delete these files, and in particular **never delete
`conversation-keys.json` to "rotate" K** — that destroys every peer's key at
once and is exactly the destructive, unauditable action step ④ exists to
replace.

### 0.4 Keep secrets out of your incident record

Nothing in this procedure requires you to print a key, a seed, or a JWT. The
rotation command is built so it cannot print one. Do not paste `credentials.json`,
`conversation-keys.json`, a trust-chain file, or any `.creds` content into a
ticket, a chat, or a log. Backups taken here are forensic-only — see §6.4.

---

## 1. Which deployment are you?

Answer this first. The rest of the document branches on it.

| | How to tell | Go to |
|---|---|---|
| **A — Managed NATS** | Your trust chain was built with `externalNatsAccount` (Synadia Cloud / NGS). `natsConfig.mode === "external"`; there is no operator JWT, no account JWT and no resolver config in your persisted chain. | [§3](#3-class-a--managed-nats) |
| **B — Self-contained, revocation available** | You run your own `nats-server` from this repo's generated config, **and** you hold the operator seed (`private.operatorSeed`, `SO…`) **and** you can fetch the currently accepted exact account JWT, apply its replacement, and verify acceptance. For a full/Dir resolver, the generated system-account `.creds` must allow this account's exact `CLAIMS.LOOKUP`; for MEMORY, you need write access to the live `resolver_preload` source. | [§4](#4-class-b--self-contained-stop-first-containment) |
| **C — No working revocation channel** | Self-contained but you cannot fetch, apply, and verify a replacement account JWT right now (missing/old system credential without exact lookup, resolver unreachable/unhealthy, config not writable), or managed but you cannot reach the provider's revocation control in time. | [§5](#5-class-c--degraded-containment) |
| **D — `static` / bring-your-own NATS** | You configured the plugin with NATS credentials it did not mint (`nats.credentials.mode: "static"`, `credsFile`, `WEBCHANNEL_NATS_CREDS`, …). | **This is not a running state.** Static/BYO **serving** was removed in P0-2: any static credential signal is rejected at account resolution with a targeted error, so such a deployment does not start. If you are here anyway, you are in class A or C — this package cannot revoke a credential it did not mint, so revocation belongs to whoever operates that NATS, and K rotation (§4 ①, ④–⑥) still applies unchanged. Return of the mode is tracked as P0-3 (see `packages/plugin/README.md`, "Bring-your-own NATS"). |

> **Class B needs the complete channel.** Holding the operator seed without a
> way to fetch the accepted claim and apply its replacement gets you either a
> stale candidate or no revocation. A system credential created before exact
> `CLAIMS.LOOKUP` was added is not a working verified channel: replace it through
> your trust-chain procedure or treat the deployment as class C.
> `addRevocation` **only builds a candidate**; nothing is revoked until the
> resolver has accepted it and you have read it back (step ③).

> **A self-contained trust chain created without `returnOperatorSeed` can never
> revoke.** The operator seed is the trust root that re-signs the account JWT,
> and `loadOrCreateTrustChain` only honours `returnOperatorSeed: true` on the
> **first** creation of a persisted chain — an existing chain is returned
> verbatim and never gains it. Recovery is regeneration of the whole chain,
> which invalidates every credential it ever minted. Since PR #155 this fails
> closed rather than silently: such a chain refuses to load at all, with a
> message saying it "was created without an operator seed, so it cannot sign the
> system account required for runtime account-claim updates". **When you create
> a new chain, set `returnOperatorSeed: true`** and store the seed in the same
> owner-only store as the account seed. Treat it as strictly higher value.

---

## 2. Decide the scope: credential-only, or credential + K?

These are two independent controls, and conflating them either leaves a hole or
causes an unnecessary outage.

| What leaked | Revoke credential (§4 ②–③) | Rotate K (§4 ④) |
|---|---|---|
| A browser's NATS credential only | **yes** | no |
| The agent's NATS credential only | **yes** (plus ④-bis) | no |
| A conversation key K only | no | **yes** |
| Storage/host compromise, or you cannot bound what was read | **yes** | **yes** |

- **Credential-only containment does not require stopping the gateway.** Revoke,
  confirm the resolver accepted it, confirm the target's live connection dropped
  and that non-target connections stayed up. That is the whole procedure
  (`ISSUE_72_CONTAINMENT_PLAN.md` §2.7).
- **Anything involving K requires the stop-first order in §4.** The reason is in
  §4 ① and it is not a formality.

---

## 3. Class A — managed NATS

1. Revoke the affected user credential through your provider's own console or
   API (Synadia Cloud / NGS). This package holds no operator seed for a managed
   account and cannot revoke on your behalf.
2. Confirm with the provider's tooling that the credential is refused and that
   the target's live connection is gone.
3. If K also leaked, continue at **§4 step ①** — the stop-first order and the
   rotation command apply unchanged. Steps ② and ③ are replaced by what you
   just did here.
4. If your provider-side revocation was account-wide rather than one exact
   credential, it cut the agent's credential too: **§4 step ④-bis applies**, with
   your provider's replacement credential in place of a re-mint, and with the
   provider's own floor in place of `floorSec`.

---

## 4. Class B — self-contained, stop-first containment

**If §2 put you in credential-only scope, do not run this whole sequence.** Skip
① and ④–⑥ entirely: run ② and ③, and stop. A credential-only revocation does not
stop the gateway and does not touch K; taking the service down for it is an
outage you did not need. Everything below assumes K is in scope.

The order below is load-bearing. Each step says why, so that a later reader does
not "optimize" one away.

```text
① stop every process/replica     ← closes the post-floor → K_old window
② revoke                         ← fixed floorSec, reviewed target
③ confirm resolver acceptance    ← a candidate JWT is not a revocation
④ rotate K                       ← offline command, gateway down
④-bis reissue agent credentials  ← only if you used the "*" wildcard
⑤ restart
⑥ force every peer to re-bootstrap
```

### ① Stop every process and replica, and confirm an observed zero

Suspend auto-restart or set desired replicas to 0 for **every** gateway
controller and replica serving the affected account, then confirm the observed
count is zero and stays zero. Do not proceed on a request you sent; proceed on a
count you observed.

Before rotating, also establish the storage topology. Rotation is supported only
for either one gateway instance with one local tuple store, or multiple replicas
that all use the **same authoritative tuple store** for this account. Independent
per-replica volumes are unsupported. Do not run the command separately on each
volume: every run generates a different K_new and silently leaves the replicas
divergent. If the replicas do not share the tuple store, keep them stopped and
escalate; step ④ has no supported procedure for that topology.

**Why this is first, and why it is a human discipline.** A revocation floor is a
lower bound in time, not an eviction. If a gateway is alive when you revoke,
a credential minted for a *new* public key after the floor is still valid, and
that new session can complete a register hop and be handed the K you have not
rotated yet. Rotating afterwards does not fix it: a healthy relay socket does not
re-register on its own, so you are left with a session holding a valid credential
and K_old. An observed zero is what closes that window
(`ISSUE_72_CONTAINMENT_PLAN.md` §2.7).

**Nothing in this repository can prove for you that you did this.** The rotation
command in step ④ refuses if it can see another rotation in progress or a
process caught mid-write, and it will tell you plainly that this is a safety net
and not a quiescence proof. It cannot see a gateway that is up but idle: the
plugin holds no lease and no pidfile, and this is a library — it does not know
what supervisor you run it under. The original #158 design required the
controller to attest a zero replica count; that was dropped on 2026-08-16 for
exactly this reason, and the obligation moved here, to you.

**If you rotate while a replica is alive**, that replica keeps serving the K it
already holds in memory to already-connected browsers, while the command commits
a different K to disk. The two disagree until the old process dies, and nothing
reports the split. If you cannot bring the count to zero, **stop and escalate**
— do not run step ④.

### ② Revoke, with a target and a floor you fixed in advance

Decide the target first:

- **Exact key.** If you know the leaked browser's `userPubkey` (`U…`), revoke
  that key. Blast radius: one credential. Take it from the minting path
  (`MintedNatsUserCreds.userPubkey` / `NatsUserCredentials.userPubkey` /
  `BrowserCredentials.userPubkey`).
- **Wildcard `"*"`.** If you do not know it, `"*"` revokes **every user
  credential of the account** — including **the agent's own**, because browser
  and agent credentials are minted from the same `accountSeed`
  (`device-flow-enrollment.ts` mints the agent with
  `accountSeed: saasTrustChain.natsAccountSeed`; `nats-user-creds.ts`
  `issueBrowserCredentials` mints the browser from the same account seed). That
  is what step ④-bis is for. Review this blast radius before you use it.

First obtain the exact account JWT that the resolver accepts **now**. The
persisted bootstrap value at `chain.natsConfig.accountJwt` does not advance when
a full/Dir resolver accepts an update. Starting a later incident from that value
can publish a newer-`iat` claim that omits and therefore erases earlier
revocation floors.

For a full/Dir resolver, write the generated credential to `sys.creds`, then use
its exact-account lookup permission. `--raw` and redirection are load-bearing:
the JWT goes to an owner-only file, not terminal scrollback.

```bash
umask 077
# sys.creds <- chain.private.systemAccountCredentials
nats --server "$NATS_URL" --creds ./sys.creds request --raw \
  "\$SYS.REQ.ACCOUNT.$ACCOUNT_PUBLIC_KEY.CLAIMS.LOOKUP" "" \
  > ./current-account.jwt
chmod 0600 ./current-account.jwt
```

For a MEMORY resolver, copy the exact current JWT from the source used by the
**live** `resolver_preload` entry for `$ACCOUNT_PUBLIC_KEY` into the same
owner-only `current-account.jwt` file. Do not use the persisted trust-chain
bootstrap copy, an old generated config, or a different replica's stale config.
If you cannot identify one authoritative live preload source, you do not have a
working verified revocation channel; use class C.

Now fix one `floorSec` and build the candidate from that fetched JWT. Do not
re-derive the floor later:

```js
import { readFileSync, writeFileSync } from "node:fs";
import { decode } from "@nats-io/jwt";
import { addRevocation } from "@mir-stream/webchannel-saas";

const currentAccountJwt = readFileSync("./current-account.jwt", "utf8").trim();
const currentClaim = decode(currentAccountJwt);
if (currentClaim.sub !== chain.natsConfig.accountPublicKey) {
  throw new Error("resolver returned a different account claim");
}
const floorSec = Math.floor(Date.now() / 1000);   // UNIX SECONDS. See §6.1.
const updatedAccountJwt = await addRevocation(
  currentAccountJwt,             // resolver/preload's CURRENT accepted JWT
  chain.private.operatorSeed,    // 'SO…' — the operator seed, NOT the account seed 'SA…'
  userPubkey,                    // 'U…' exact key, or '*'
  floorSec,
);
writeFileSync("./updated-account.jwt", updatedAccountJwt, { mode: 0o600 });
```

Notes that will bite you otherwise:

- `operatorSeed` must be the seed whose public key **exactly equals** the current
  account JWT's `iss`. Passing the account seed (`SA…`) is the classic footgun
  and is rejected outright; `addRevocation` also rejects a different/stale
  operator issuer.
- The floor is `max(existingFloor, requestedAt)`: an older request never lowers
  an existing floor. That preservation applies only to floors present in
  `currentAccountJwt`, which is why the accepted-claim fetch above is mandatory
  on every incident.
- NATS applies the floor **inclusively** — a credential is refused when
  `floorSec >= credential.iat`. Any replacement credential must therefore have
  an `iat` **strictly greater** than `floorSec`. If it lands in the same second,
  wait for the next second and re-mint (see ④-bis).
- `addRevocation` returns a **candidate**. Nothing has been revoked yet.

### ③ Apply the candidate and confirm the resolver accepted it

This step is now genuinely reachable — PR #155 landed the full/Dir resolver, a
dedicated system account, and the `$SYS.REQ.CLAIMS.UPDATE` path, and this repo's
real-server suite proves both acceptance and exact readback after a restart
against `nats-server` v2.14.

**Full/Dir resolver.** Publish the updated account JWT with the narrowly-scoped
system-account credentials from `chain.private.systemAccountCredentials` (that
user may publish `$SYS.REQ.CLAIMS.UPDATE`, this account's exact
`$SYS.REQ.ACCOUNT.<account>.CLAIMS.LOOKUP`, and subscribe to `_INBOX.>`):

```bash
# Write both to owner-only files first, and delete them when you are done:
#   updated-account.jwt   <- the candidate from step ②
#   sys.creds             <- chain.private.systemAccountCredentials
umask 077
nats --server "$NATS_URL" --creds ./sys.creds \
  request '$SYS.REQ.CLAIMS.UPDATE' "$(cat ./updated-account.jwt)"
```

A successful reply carries `data.account` equal to your account public key,
`data.code` `200`, and a message saying the account was **updated**. Treat
anything else — including no reply — as a failed publish, and **do not report
the revocation as done**.

Then read it back from the server into another owner-only file and check the
stored claim really contains your floor:

```bash
nats --server "$NATS_URL" --creds ./sys.creds request --raw \
  "\$SYS.REQ.ACCOUNT.$ACCOUNT_PUBLIC_KEY.CLAIMS.LOOKUP" "" \
  > ./accepted-account.jwt
chmod 0600 ./accepted-account.jwt
```

Decode the returned JWT and confirm `nats.revocations` contains your target key
(or `"*"`) with exactly the `floorSec` you fixed in step ②. Do not decode it
into a shared log. Also confirm its `sub` is `$ACCOUNT_PUBLIC_KEY`. Keep this
accepted value as the input to any immediately following revocation; do not
start again from `chain.natsConfig.accountJwt`. Remove the temporary JWT and
`.creds` files when the incident procedure is complete.

**MEMORY resolver.** Replace the same authoritative live `resolver_preload`
source from which you copied `current-account.jwt`, then reload:

```bash
nats-server --signal reload=<pid>      # or: kill -HUP <pid>
```

Then confirm, in this order:

1. the targeted live connection is gone;
2. non-target live connections are still up;
3. a reconnect attempt with the old credential fails.

Only if the reload or the verification fails should you fall back to restarting
the relay. A restart is not a precondition for live revocation.

**`--signal reload` is not a restart.** It re-reads configuration; it does not
tear down connections by itself. It is the account-claim force-update that
disconnects clients caught by the new floor. If you rely on "reload" to
disconnect a session that the floor does not catch, that session survives (§6.3).

### ④ Rotate K with the offline command

Only after ① is observed and ③ is confirmed. ClawHub installs the plugin as a
managed artifact; it does **not** put the package's npm `bin` on your shell PATH,
and there is no npm package named `openclaw-webchannel-rotate-key`. Resolve the
installed artifact through OpenClaw's inspection API and run its dedicated entry
with Node:

```bash
PLUGIN_ROOT="$(
  openclaw plugins inspect webchannel --json |
  node --input-type=module -e '
    import { isAbsolute } from "node:path";
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const root = JSON.parse(chunks.join("")).plugin?.rootDir;
    if (typeof root !== "string" || !isAbsolute(root)) process.exit(2);
    process.stdout.write(root);
  '
)"
test -f "$PLUGIN_ROOT/dist/rotate-key-entry.js"
```

The entry is deliberately a separate process: it can neither open a NATS
transport nor install a register subscription, and its offline account-wide
mutation module is absent from the running gateway's bundle. If inspection or
the file check fails, stop; do not substitute `npx` or a source-tree path.

**Dry run first — it is the default.** Nothing is rotated without `--apply`.

One peer:

```bash
node "$PLUGIN_ROOT/dist/rotate-key-entry.js" --tenant <tenant> --account <accountId> --peer <peerId>
node "$PLUGIN_ROOT/dist/rotate-key-entry.js" --tenant <tenant> --account <accountId> --peer <peerId> --apply
```

The whole account (only when you cannot bound the exposure to specific peers):

```bash
node "$PLUGIN_ROOT/dist/rotate-key-entry.js" --tenant <tenant> --account <accountId> --all-peers
# review the peer count and the target digest it prints, then:
node "$PLUGIN_ROOT/dist/rotate-key-entry.js" --tenant <tenant> --account <accountId> --all-peers \
  --apply --confirm-digest <digest-from-the-dry-run>
```

- The target is always explicit. There is no default and account-wide is never
  implied — you type the tuple by hand.
- The account-wide dry run prints a peer **count** and a **digest** of the target
  set, not a list of peer identifiers, and never any key material. `--apply`
  requires that digest back, so a set that changed since you reviewed it is
  refused instead of silently re-keyed.
- The command verifies its own write by reading both documents back from disk
  in full (all keys and all generation-sidecar entries, including cardinality)
  before it reports success. If it fails, it fails — it starts nothing and has
  no fallback path. Re-run after fixing the cause, or escalate.
- `--storage-root` only if your deployment moved the v2 storage root. The dry run
  prints the tuple directory it resolved, which is also how you find
  `<v2_namespace>` for step ④-bis.
- Read `--help`. It states, in full, what the command does not guarantee.

### ④-bis Reissue the agent's credentials — only if you revoked with `"*"`

The wildcard cut the agent's own credential too. Until you replace it, the agent
cannot authenticate to the relay and the gateway will not come back.

Follow **[`AUTH.md` → "Offline re-key after revocation"](AUTH.md#offline-re-key-after-revocation)**;
the sequence, with the additions this incident requires:

1. Gateway already stopped (step ①).
2. Move the exact tuple `credentials.json` aside to an operator-chosen backup
   path. **Move, do not delete or overwrite.** (This is the §0.3 exception.)
3. Complete the SaaS-side active-key replacement.
4. `openclaw channels add --channel webchannel --account <account>`, then approve
   the enrollment. **Note:** with an `enrolled` source, `channels add` *skips*
   when the exact tuple's `credentials.json` is still present — that is why step
   2 comes first. No single command guarantees a re-mint.
5. **Decode the new agent JWT and confirm its `iat` is strictly greater than the
   `floorSec` you fixed in step ②.** If they are equal, wait for the next second
   and re-mint. Do not "fix" this by issuing a newer floor.
6. Confirm the new agent authenticates to the relay **before** you restart the
   gateway.

If the agent's credentials come from an operator-supplied source rather than
enrollment, install the replacement credential you were given, then continue at
step 5 (`ISSUE_72_CONTAINMENT_PLAN.md` §2.4).

### ⑤ Restart

Bring the gateway controllers/replicas back only after ④ (and ④-bis, if it
applied) are complete and verified.

### ⑥ Force every affected browser through a fresh bootstrap

**This is not optional, and it is the step most often skipped.** Neither a
gateway restart nor a relay disconnect makes a browser register again — a healthy
relay websocket survives a gateway restart, and a revoked client can end up in a
terminal state rather than a retrying one. A browser only picks up K_new by
starting over: fresh app bootstrap → new credential → new register.

Scope:

- rotated one peer → every device of that peer;
- rotated `--all-peers` → every browser of that account.

Also note that deploying a new plugin does not immediately reject an
already-connected older-protocol browser; the protocol gate applies at the next
register. The forced refresh is what makes that happen.

### Done — what you can now claim

- Credentials issued at or before `floorSec` for the revoked target are refused
  by the server, and you read that back from the resolver.
- Conversation envelopes created after the rotation cannot be decrypted with
  K_old: K_new is fresh random material, so the separation comes from the keys
  themselves.
- **You cannot claim** anything about material exposed before you started (§0.1),
  and you cannot claim the gateway was quiesced at step ④ — you asserted it, the
  tooling did not prove it.

---

## 5. Class C — degraded containment

Use this when there is no working revocation channel. It is what this repository
actually did for #54. It trades availability for containment, deliberately.

1. **Disable the affected plugin account** (`enabled: false`) so it is not served.
2. **Suspend every gateway controller/replica** for that account and confirm the
   observed count is zero and stable.
3. **If the leaked NATS credential itself must be refused before you can restore
   a revocation channel**, isolate or stop the relay/account, or block access with
   provider or network controls. A disabled plugin account does not stop a leaked
   credential from connecting to a relay that is still up.
4. **Then** restore the revocation channel — recover the system-account
   credentials or resolver access — or plan a full trust-chain replacement. Only
   after that can you run §4 ②–③.
5. If K also leaked, you may rotate it now only after confirming the supported
   shared/single-store topology in §4 ①: the stop condition is already satisfied
   by 2, and step ④ does not need a relay. Keep the account disabled until
   §4 ②–③ complete.
6. Keep every affected account disabled until containment is finished. Deleting
   the old configuration, restarting only some replicas, or waiting for token
   expiry is **not** revocation.

`AgentKeyRegistry` identity-key revocation is **not** NATS credential
revocation: it tombstones the active identity key so future bootstrap requests
are not served that key. It does not disconnect a browser that already pinned
the key, and it does not revoke the agent's NATS credentials. Do not present the
two as the same control.

---

## 6. Traps

### 6.1 `at` / `floorSec` is UNIX SECONDS

Passing milliseconds is silently accepted. `addRevocation` validates only that
the value is a finite, positive integer — **it does not check an upper bound**
(`packages/saas/src/account-revocation.ts`, the `at` validation). A millisecond
value places the floor somewhere around the year 58,500, so that key — or, with
`"*"`, **every credential of the account, forever** — is refused permanently, and
the floor is monotonic so you cannot lower it back. The only recovery is
regenerating the trust chain.

Compute it as `Math.floor(Date.now() / 1000)` and check the magnitude before you
publish.

### 6.2 `"*"` cuts the agent too

Browser and agent credentials come from the same `accountSeed`. The wildcard is
an account-wide kill switch, not a browser-only one. Plan ④-bis before you use it.

### 6.3 `--signal reload` is not a restart

It re-reads configuration and does not, by itself, drop connections. A session
holding a leaked credential that the new floor does not catch survives a reload.

### 6.4 Never restore a pre-rotation backup

A backup taken before rotation is **forensic-only**: owner-only permissions,
outside the live tuple namespace, never restored after a successful containment.
Restoring it re-activates the leaked K. The register-reply freshness anchor
(`clientNonce`) proves the wrapped key was freshly wrapped by the currently
loaded key — it is **not** a K-rollback detector.

Likewise, do not roll the protocol back from v3 to v2 after a rotation: v2 has no
`clientNonce`, so it removes the wrap-replay protection. Roll forward.

### 6.5 A chain with no operator seed can never be revoked

See the note in §1. Set `returnOperatorSeed: true` at creation time; it cannot be
added to a chain afterwards.

### 6.6 "Invalidate the old encrypted peer state" — there is nothing to invalidate

See §0.2. If you are following an older instruction that says this, the
instruction is wrong, not your deployment.

---

## 7. Recovering from a fail-closed account-startup error

After a plugin rollback, an account can fail to start because the installed
build cannot safely interpret a document written by the newer build. The
sanitized error begins with either `webchannel conversation-keys
version-too-new` or `webchannel conversation-key-generations version-too-new`,
followed by this remediation:

> this file was written by a NEWER webchannel release than this build supports,
> so this is a version downgrade, not corruption. The file was left unchanged.
> Run the plugin version that wrote it (or newer), or restore this account's
> state from your own backup before downgrading

The important fact is **the file was left unchanged**. Do not treat it as
corruption and do not run a quarantine/delete procedure.

1. Preferred recovery: undo the rollback and run the version that wrote the
   document, or a newer compatible version. This preserves both K and its audit
   labels.
2. If only `conversation-key-generations.json` is too new and forward recovery
   is impossible, stop every replica for the account and move that sidecar to an
   operator-chosen owner-only backup outside the live tuple. This deliberately
   loses the generation audit labels; it does not rotate K. This is a narrow
   recovery exception, not a normal sidecar reset procedure.
3. **Never move, delete, quarantine, or recreate `conversation-keys.json` to get
   past this error.** That document is the live K authority. Removing it strands
   existing browsers and can mint unrelated fresh keys on later registration.
4. If downgrade is mandatory and the key document itself is too new, restore a
   complete, operator-owned, version-compatible snapshot of the tuple while all
   replicas are stopped. The snapshot must be from after the latest successful
   containment/K rotation; §6.4 still forbids restoring a pre-rotation forensic
   backup because that reactivates K_old. If no such compatible snapshot exists,
   keep the account stopped and escalate. There is no safe partial reconstruction
   procedure.

---

## 8. What is still not covered

- **Proof of quiescence.** Not available, by design decision of 2026-08-16: this
  is a library and cannot know your deployment topology. §4 ① is the substitute
  and it is a human obligation.
- **`static` / bring-your-own NATS serving.** Removed in P0-2 and currently
  rejected at account resolution; its return is tracked as P0-3.
- **An issuance ledger, durable revoke operations, and confirmation tokens.**
  Track A of `ISSUE_72_CONTAINMENT_PLAN.md`; not implemented.
- **An external, non-rollbackable generation anchor** that would let a fresh
  client refuse a restored K_old even from a privileged operator: issue #85.
