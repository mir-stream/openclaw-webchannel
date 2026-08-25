# Credential & conversation-key containment runbook

**You are here because a browser credential, an agent credential, or a
conversation key K may have leaked.** This document is the operator procedure.
Follow it top to bottom: the deployment-class question comes first because the
correct order of operations differs by class and scope. K containment is
stop-first; an exact credential-only revocation can happen live.

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
  core, not by this plugin (whose own at-rest store is `delivery-journal.sqlite`
  below). `NatsChannel.sendHistory` seals the frame with the
  **current** K at delivery time. Replacing K therefore costs no re-encryption —
  the next read-and-deliver cycle simply reseals under the new key
  (`ISSUE_72_CONTAINMENT_PLAN.md` §1.4, RETAIN + RESEAL).
- **What this plugin writes**, per exact `(tenant, accountId)` tuple, under
  `$HOME/.openclaw-webchannel-v2/<v2_namespace>/`:
  - `credentials.json` — NATS user seed and agent identity key. Owner-only.
  - `conversation-keys.json` — the per-peer K store.
  - `conversation-key-generations.json` — the audit-only generation sidecar.
  - `delivery-journal.sqlite`, plus its `-wal`, `-shm` and `-journal` sidecars
    (the last only on volumes where WAL is unavailable) — the v6 delivery
    journal, opened at account start unconditionally, with no config to
    disable it. It holds message **plaintext**, not ciphertext: `agent_message`
    text, `progress` placements, and the `turn_snapshot` rows written at turn
    end, all recorded on the egress path. Owner-only (0600) inside the 0700
    tuple directory, and nothing ages out of it — this slice ships no retention
    (that is #240, tracked with the operator-facing half in #290) — so it
    accumulates for the life of the account.

    **K does not seal this file, and rotating K does not touch it.**
    `sendToPeer` journals the payload *before* `sealEnvelope` runs, so K covers
    the wire and nothing else here. Two consequences. Count this file in the
    §0.1 exposure assessment: whoever could read `conversation-keys.json` could
    read this too, so the exposed set is what the list above names, not only
    what K could decrypt. And deleting it is available to you as **data
    minimization** — it removes plaintext standing on disk from here on. That
    is not containment and it does not undo past exposure (§0.1), so it is your
    call to make, not a step this procedure requires.
  - legacy migration artifacts under `$HOME/.openclaw-webchannel/`.

  That is the complete list. Nothing on it is a ciphertext store to invalidate:
  the one file holding conversation content, `delivery-journal.sqlite`, holds it
  in the clear, so the only lever over it is deletion, not invalidation.
- **Rotating K does not disconnect anyone and does not revoke anything.** It is
  one of two independent controls. Section 2 tells you which ones you need.

### 0.3 The file-handling exception

[`packages/plugin/README.md`](../packages/plugin/README.md) forbids moving or
deleting the plugin's state files as normal operations, because doing so breaks
encrypted-history continuity and can strand live devices. **This runbook is the
exception that rule anticipates.** During a confirmed containment you may move
`credentials.json` aside when the current agent credential was revoked (step
④-bis, per `AUTH.md`), you replace K in `conversation-keys.json` only when K
is in scope (step ④), and you **may** delete `delivery-journal.sqlite` together
with its `-wal`/`-shm`/`-journal` sidecars if you choose to clear the conversation
plaintext they hold (§0.2 — optional, and not containment) — unlike the other
two, that one is an outright delete, not a move-aside or an in-place
replacement. All are done with the gateway stopped; the first two use the
documented paths below. Outside an incident, the README rule stands:
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
| **B — Self-contained, revocation available** | You run your own `nats-server` from this repo's generated config, **and** you hold the operator seed (`private.operatorSeed`, `SO…`) **and** you can fetch the currently accepted exact account JWT, apply its replacement, and verify acceptance. For a full/Dir resolver, the generated system-account `.creds` must allow this account's exact `CLAIMS.LOOKUP`; for MEMORY, you need write access to the live `resolver_preload` source. | [§4](#4-class-b--self-contained-containment-routes) |
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

| What leaked | Revoke credential (Class A §3 / Class B §4 ②–③) | Rotate K (§4 ④) | Fresh browser bootstrap (§4 ⑥) |
|---|---|---|---|
| A browser's NATS credential only | **yes** | no | affected browser/device |
| The agent's NATS credential only | **yes** (plus ④-bis) | no | **every browser in the account** after ④-bis identity-key replacement |
| A conversation key K only | no | **yes** | every peer whose K changed |
| Storage/host compromise, or you cannot bound what was read | **yes** | **yes** | every affected browser; **all account browsers** if ④-bis runs |

Choose one executable route:

- **Exact browser credential only:** run the Class A §3 provider route or Class B
  §4 ②–③ live, including target disconnect, non-target continuity, and failed
  old-credential reconnect. Then force only the affected browser through a
  fresh bootstrap (§4 ⑥). Do not stop the gateway or rotate K.
- **Current agent credential only, exact agent key or wildcard:** run the Class A
  §3 provider route or Class B §4 ②–③ live. Then suspend every replica and
  confirm zero before moving
  `credentials.json`; run ④-bis and restart/continue service at ⑤. That offline
  re-enrollment replaces the active agent identity key as well as the NATS
  credential, so force **every browser in the account** through ⑥ even for an
  exact old-agent-key revocation. Do not rotate K.
- **K only:** skip revocation entirely. Run ① (including the topology check), ④,
  ⑤, and ⑥ for every peer whose K changed.
- **Credential + K:** run the combined stop-first sequence: ①; the Class A §3
  provider control or Class B §4 ②–③ for the credential; ④; ④-bis if the current
  agent credential was targeted, whether by its exact key or by `"*"`; then
  ⑤–⑥. If ④-bis runs, its identity-key replacement expands ⑥ to every browser
  in the account. Class C instead follows §5's disable/isolate → rotate K →
  restore credential control order and must not restart between those stages.

Credential-only revocation can happen live. Anything involving K requires the
stop-first order in §4; that requirement is not a formality.

---

## 3. Class A — managed NATS

Select the incident scope from §2 **before taking any action**. This determines
whether the provider revocation can happen live or must follow the stop/topology
gate:

For every managed credential revocation, retain the provider's acceptance and
enforcement evidence. If the provider exposes an effective floor for the target
that its documentation defines as positive safe-integer Unix seconds comparable
to JWT `iat`, validate and record it as `providerEffectiveFloorSec`. If it
exposes no comparable numeric floor, record that fact and use the provider's
reviewed issuance and replacement rules. Never invent or substitute Class B's
`expectedFloorSec`; that name exists only for the self-contained resolver
procedure in §4 ②–③.

1. **Credential only:** revoke the exact user key through the provider's
   console/API (Synadia Cloud / NGS), or use the provider's reviewed broader
   target when the exact key is unknown. This package has no operator seed for
   a managed account and cannot revoke on your behalf. Confirm with provider
   tooling that the target's live connection is gone, non-target connections
   remain, and the old credential cannot reconnect. An exact browser target
   then needs only its affected fresh bootstrap in §4 ⑥. If the target is the
   current agent credential (exact key or account-wide target), revoke and
   verify live first, then suspend every replica and confirm zero before §4
   ④-bis; continue through ⑤–⑥. Because ④-bis replaces the SaaS active identity
   key as well as the NATS credential, every browser in the account must
   bootstrap again.
2. **K only:** do not ask the provider to revoke anything. Go directly to §4 ①,
   including the topology check, then run ④ → ⑤ → ⑥.
3. **Credential + K:** go to §4 ① **before provider revocation** and observe
   every gateway replica at zero. Only then revoke through the provider and
   verify provider acceptance and enforcement while the gateways remain
   stopped: an old credential reconnect must fail, and for a browser target
   confirm target disconnect plus non-target continuity. Continue with ④,
   [④-bis if the current agent credential was targeted], then ⑤–⑥. This
   stop-first order closes the K_old handout window explained under ①; a live
   provider revocation followed by a later stop is not the combined route.

For an agent credential replacement, use the provider's issuance rules. If the
provider exposed a numeric account-wide `providerEffectiveFloorSec`, the
replacement `iat` must be strictly above it; otherwise follow the provider's
reviewed replacement rule without inventing a floor.

---

## 4. Class B — self-contained containment routes

Use the route selected in §2; not every incident runs every numbered step.
Stopping first is load-bearing whenever K is in scope. Credential-only
revocation itself can happen live, but an agent-credential replacement still
requires suspending every replica before moving tuple credentials.

```text
K only:                 ① stop/topology → ④ rotate K → ⑤ restart → ⑥ bootstrap
browser credential:     ② revoke → ③ readback/enforcement → ⑥ affected bootstrap
agent credential:       ② revoke → ③ readback/enforcement → suspend/zero →
                        ④-bis reissue NATS + identity key → ⑤ restart →
                        ⑥ ALL account browsers bootstrap
credential + K:         ① stop/topology → ② revoke → ③ readback → ④ rotate K →
                        [④-bis if agent targeted] → ⑤ restart → ⑥ bootstrap
```

Whenever ④-bis runs, its SaaS active identity-key replacement changes the agent
key browsers pin. Therefore ⑥ covers every browser in the account for both exact
agent-key and wildcard routes; this is not merely a NATS JWT swap.

### ① Stop every process and replica, and confirm an observed zero

Run this step before any K rotation. For agent-credential-only containment,
complete the Class A §3 provider route or Class B ②–③ live first, then return
here before moving `credentials.json` in ④-bis.

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

**Why this is first when K is in scope, and why it is a human discipline.** A
revocation floor is a lower bound in time, not an eviction. If a gateway is alive
when you revoke during combined containment,
a credential minted for a *new* public key after the floor is still valid, and
that new session can complete a register hop and be handed the K you have not
rotated yet. Rotating afterwards does not fix it: a healthy relay socket does not
re-register on its own, so you are left with a session holding a valid credential
and K_old. An observed zero is what closes that window
(`ISSUE_72_CONTAINMENT_PLAN.md` §2.7).

**Nothing in this repository can prove for you that you did this.** Every apply
invocation in step ④ refuses a pre-existing rotation lock. By default, both dry
run and apply refuse every matching atomic-write temp artifact. On a shared
store, a pid recorded by another host/pod is not meaningful locally, so the
command never declares such an artifact stale or removes it automatically.
These are conservative safety signals, not cross-host liveness or quiescence
proof. The command still cannot see a gateway that is up but idle: the plugin
holds no lease and no pidfile, and this library does not know what supervisor
you run it under. The original #158 controller attestation was dropped on
2026-08-16; the observed-zero obligation belongs to the operator.

**If you rotate while a replica is alive**, that replica keeps serving the K it
already holds in memory to already-connected browsers, while the command commits
a different K to disk. The two disagree until the old process dies, and nothing
reports the split. If you cannot bring the count to zero, **stop and escalate**
— do not run step ④.

### ② Revoke, with a target and a floor you fixed in advance

Decide the target first:

- **Exact key.** If you know the leaked browser's or current agent's
  `userPubkey` (`U…`), revoke that key. Blast radius: that user key. Identify it
  from the minting path
  (`MintedNatsUserCreds.userPubkey` / `NatsUserCredentials.userPubkey` /
  `BrowserCredentials.userPubkey`). If it is the current agent key, ④-bis is
  required before continued service.
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
import { addRevocation } from "openclaw-webchannel-saas";

const currentAccountJwt = readFileSync("./current-account.jwt", "utf8").trim();
const currentClaim = decode(currentAccountJwt);
if (currentClaim.sub !== chain.natsConfig.accountPublicKey) {
  throw new Error("resolver returned a different account claim");
}
if (!Number.isSafeInteger(currentClaim.iat) || currentClaim.iat <= 0) {
  throw new Error("accepted account claim has no valid iat");
}
const floorSec = Math.floor(Date.now() / 1000);   // UNIX SECONDS. See §6.1.
const existingTargetFloor = currentClaim.nats?.revocations?.[userPubkey];
if (
  existingTargetFloor !== undefined &&
  (!Number.isSafeInteger(existingTargetFloor) || existingTargetFloor <= 0)
) {
  throw new Error("accepted account claim has an invalid target floor");
}
// floorSec remains this incident's immutable requested time. Readback must
// expect the stronger of that request and an already accepted target floor.
const expectedFloorSec = Math.max(
  existingTargetFloor ?? floorSec,
  floorSec,
);

// Account-claim updates also need strictly increasing iat ordering. Keep the
// floor above fixed, but do not sign until a new claim can be newer than the
// resolver's currently accepted claim.
while (Math.floor(Date.now() / 1000) <= currentClaim.iat) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const updatedAccountJwt = await addRevocation(
  currentAccountJwt,             // resolver/preload's CURRENT accepted JWT
  chain.private.operatorSeed,    // 'SO…' — the operator seed, NOT the account seed 'SA…'
  userPubkey,                    // 'U…' exact key, or '*'
  floorSec,
);
const updatedClaim = decode(updatedAccountJwt);
if (
  !Number.isSafeInteger(updatedClaim.iat) ||
  updatedClaim.iat <= currentClaim.iat
) {
  throw new Error("candidate account claim is not newer than accepted claim");
}
if (updatedClaim.nats?.revocations?.[userPubkey] !== expectedFloorSec) {
  throw new Error("candidate account claim has an unexpected target floor");
}
writeFileSync("./updated-account.jwt", updatedAccountJwt, { mode: 0o600 });
```

Notes that will bite you otherwise:

- `operatorSeed` must be the seed whose public key **exactly equals** the current
  account JWT's `iss`. Passing the account seed (`SA…`) is the classic footgun
  and is rejected outright; `addRevocation` also rejects a different/stale
  operator issuer.
- `floorSec` is the immutable requested incident time. `expectedFloorSec` is
  `max(existingTargetFloor, floorSec)`: an older request never lowers an
  existing target floor. That preservation applies only to floors present in
  `currentAccountJwt`, which is why the accepted-claim fetch above is mandatory
  on every incident. Keep both non-secret values in the incident record.
- A resolver accepts account-claim updates by claim ordering. The candidate
  account JWT's `iat` must be **strictly greater** than the currently accepted
  account JWT's `iat`; the wait and decoded assertion above enforce that while
  keeping `floorSec` fixed. For sequential revocations, repeat the exact-current
  lookup, wait, and candidate-`iat` assertion every time, using the last accepted
  JWT as the next input.
- NATS applies the effective accepted target floor **inclusively** — a covered
  credential is refused when `expectedFloorSec >= credential.iat`. A
  replacement still covered by that target (notably a wildcard) must therefore
  have an `iat` **strictly greater** than `expectedFloorSec`. If it does not,
  wait until it can and re-mint (see ④-bis). This is the replacement **user
  credential** rule; it is distinct from the account-claim ordering rule in the
  previous bullet.
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

Decode both the candidate and returned JWT and confirm the accepted claim is
that candidate (same `jti`), its `sub` is `$ACCOUNT_PUBLIC_KEY`, and
`nats.revocations` contains your target key (or `"*"`) with exactly
`expectedFloorSec` from step ②. Compare against the candidate/effective floor,
**not** raw `floorSec`: a higher pre-existing same-target floor is a safe,
stronger result and must remain unchanged. Do not decode either JWT into a
shared log. Keep the accepted value as the input to any immediately following
revocation; do not start again from `chain.natsConfig.accountJwt`. Remove the
temporary JWT and `.creds` files when the incident procedure is complete.

After that Full/Dir readback, verify enforcement too, in this order:

1. the targeted live connection is gone;
2. non-target live connections are still up;
3. a reconnect attempt with the old credential fails.

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

Only after ① is observed. If a credential is also in scope, Class A must first
confirm §3 provider acceptance/enforcement and Class B must first confirm §4 ③
resolver readback/enforcement. **Class C is the deliberate exception:** it may
enter ④ only after §5 steps 1–3 have disabled the account, stopped every replica,
and isolated relay/account access. Its credential revocation remains pending;
keep the account disabled and replicas stopped, and do not restart until §5
steps 5–6 complete it. For K-only, every credential route is deliberately
skipped. ClawHub installs the plugin as a managed artifact; it does **not** put
the package's npm `bin` on your shell PATH, and there is no npm package named
`openclaw-webchannel-rotate-key`.

**The stopped gateway's service context is part of the rotation target.** Open a
shell or one-shot job as the same OS service identity/HOME and in the same
mount/container namespace as that gateway. Use the exact same OpenClaw
selection for the inspection below and for any later `channels add`: either the
same global `--profile <name>`, or the same
`OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH` values. If you cannot enter that
context or see the same mounts, stop and escalate. The rotation CLI cannot
attest any of this.

Set one command prefix in that service context and keep it for the whole
procedure:

```bash
# For an explicit state/config deployment, export the exact service values:
# export OPENCLAW_STATE_DIR=...
# export OPENCLAW_CONFIG_PATH=...

# Default profile, or after inheriting/exporting the exact service env:
OPENCLAW=(openclaw)

# For a named-profile deployment, replace the active line above with this
# global-option prefix (choose exactly one; do not run an unset placeholder):
# OPENCLAW=(openclaw --profile "<gateway-profile>")
```

Do not mix the two examples or change the selection between commands. Resolve
the installed artifact through that selected OpenClaw instance and run its
dedicated entry with Node:

```bash
PLUGIN_ROOT="$(
  "${OPENCLAW[@]}" plugins inspect webchannel --json |
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

Node derives both default v2 and legacy roots from this invocation's own OS
homedir. Running as another user, with another HOME, or outside the gateway's
mount/container namespace can select a different or empty tuple even when the
tenant/account text matches.

**Dry run first — it is the default.** Nothing is rotated without `--apply`.

One peer:

```bash
node "$PLUGIN_ROOT/dist/rotate-key-entry.js" --tenant <tenant> --account <accountId> --peer <peerId>
node "$PLUGIN_ROOT/dist/rotate-key-entry.js" --tenant <tenant> --account <accountId> --peer <peerId> --apply
```

The whole account (only when you cannot bound the exposure to specific peers):

```bash
node "$PLUGIN_ROOT/dist/rotate-key-entry.js" --tenant <tenant> --account <accountId> --all-peers
# review the peer count and tuple+target-set digest it prints, then:
node "$PLUGIN_ROOT/dist/rotate-key-entry.js" --tenant <tenant> --account <accountId> --all-peers \
  --apply --confirm-digest <digest-from-the-dry-run>
```

If this deployment configured the low-level runtime `credentialPath` override,
append `--credential-path "$ABSOLUTE_CREDENTIAL_PATH"` to **both** the dry run
and apply. It must be the exact absolute file configured for this tuple; do not
guess or point it at a copied credential. The command never prints that value.
During a legacy-only migration, an omitted or wrong override cannot prove who
owns the collocated K, so the offline command refuses before moving legacy K or
publishing an empty v2 key document. Keep replicas stopped, supply the exact
configured path, or inspect and escalate. Deployments that did not configure
the low-level override should not add this option.

If the deployment configured `storageRoot`, append its exact absolute value as
`--storage-root "$ABSOLUTE_STORAGE_ROOT"` to **every** dry-run and apply
invocation. An exact deployed v2 root can bridge a different invocation HOME
only when state is already v2; legacy discovery still uses the gateway's
homedir/context, so a legacy migration must run in that original service
context. Keep both configured overrides byte-for-byte identical between the dry
run and apply.

- The target is always explicit. There is no default and account-wide is never
  implied — you type the tuple by hand.
- The account-wide dry run prints a peer **count** and a digest bound to the
  exact `(tenant, accountId)` tuple **and** target set, not a list of peer
  identifiers, and never any key material. `--apply` requires that digest back,
  so a digest copied from another tuple or a set that changed after review is
  refused before either document is written.
- The command verifies its own write by reading both documents back from disk
  in full (all keys and all generation-sidecar entries, including cardinality)
  before it reports success. On failure, read the explicit `APPLY OUTCOME`:
  pre-commit refusal, committed-but-readback-unverified, and
  committed-and-verified-but-lock-cleanup-failed require different recovery.
  Never blindly rerun after a possible or known commit; keep replicas stopped,
  inspect the complete tuple and lock, and escalate as directed.
- Any existing rotation lock is left untouched and blocks every apply invocation,
  even when its pid looks dead locally; it may belong to another host/pod. Every
  matching atomic-write temp artifact also blocks by default. Only
  `--ignore-live-writers` bypasses the temp-artifact signal after external
  inspection; it never bypasses a lock and proves no cross-host liveness.
- Before `--apply`, compare the dry run's printed `directory:` with the stopped
  deployment's actual tuple directory. It must match exactly. This comparison is
  an operator check; the CLI cannot attest its own HOME/profile/mount context.
  The confirmed directory is also how you find `<v2_namespace>` for step ④-bis.
- Read `--help`. It states, in full, what the command does not guarantee.

### ④-bis Reissue the agent's credentials — if its exact key or `"*"` was revoked

An exact revocation of the current agent user key and an account-wide wildcard
both require replacement before the gateway can continue authenticating. An
exact browser-only revocation does not run this step. This procedure moves the
tuple's complete `credentials.json`, performs the SaaS active identity-key
replacement, and re-enrolls; it changes the agent identity key/pin as well as
the NATS credential. It is not a NATS-JWT-only swap.

Follow **[`AUTH.md` → "Offline re-key after revocation"](AUTH.md#offline-re-key-after-revocation)**;
the sequence, with the additions this incident requires:

The service-context rule in ④ is load-bearing here too. Before moving
`credentials.json` in step 2, enter the same service identity/HOME and
mount/container namespace and select the same OpenClaw profile or explicit
state/config. Reuse the `OPENCLAW` prefix from ④, or establish it now if this
credential-only route skipped K rotation.

1. Confirm every gateway replica is stopped. A K/combined route already did
   this at ①. For agent-credential-only containment, revocation and enforcement
   verification happened live through Class A §3 or Class B §4 ②–③;
   suspend/zero the replicas now, before touching the tuple credential file.
2. Move the exact tuple `credentials.json` aside to an operator-chosen backup
   path. **Move, do not delete or overwrite.** (This is the §0.3 exception.)
3. Complete the SaaS-side active-key replacement.
4. From the service identity/HOME, mount/container namespace, and OpenClaw
   profile/state/config selection established above (and used at ④ when K was
   rotated), run
   `"${OPENCLAW[@]}" channels add --channel webchannel --account <account>`, then
   approve the enrollment. **Note:** with an `enrolled` source, `channels add`
   *skips* when the exact tuple's `credentials.json` is still present — that is
   why step 2 comes first. No single command guarantees a re-mint.
5. Validate the replacement according to the revocation target:
   - **Wildcard `"*"`, Class B:** decode the new agent JWT and confirm its `iat` is
     strictly greater than the effective accepted wildcard floor
     (`expectedFloorSec` confirmed in step ③), not merely the requested
     `floorSec`. If it is not greater, wait until it can be and re-mint. Do not
     "fix" this by issuing a newer floor.
   - **Wildcard/account-wide target, Class A:** if the provider exposed a numeric
     `providerEffectiveFloorSec`, require the new JWT's `iat` to be strictly
     greater. If it exposed no numeric floor, apply the provider's reviewed
     issuance/replacement rule. Do not substitute Class B's `expectedFloorSec`.
   - **Exact old agent key:** require a newly generated NATS user key and confirm
     the replacement JWT's `sub` differs from the revoked `U…` key. The old
     exact-key floor does not bind this new key, so its `iat` need not exceed
     that exact floor (though any separate wildcard floor in the accepted claim
     still applies).
6. In either case, confirm the new agent credential authenticates to the relay
   **before** restarting or continuing gateway service.
7. Because the active agent identity key changed, force **every browser in this
   account** through fresh bootstrap at ⑥ so it receives and pins the new key.
   This applies to both exact-agent-key and wildcard revocation routes. The NATS
   replacement-credential `iat` checks in step 5 remain mandatory.

If the agent's credentials come from an operator-supplied source rather than
enrollment, install the replacement credential you were given, then continue at
step 5 (`ISSUE_72_CONTAINMENT_PLAN.md` §2.4).

### ⑤ Restart

Bring the gateway controllers/replicas back after every in-scope offline control
is complete: ④ when K was rotated, and ④-bis when the current agent credential
was revoked. Exact browser-credential-only containment never stopped them.

### ⑥ Force every affected browser through a fresh bootstrap

**This is not optional, and it is the step most often skipped.** Neither a
gateway restart nor a relay disconnect makes a browser register again — a healthy
relay websocket survives a gateway restart, and a revoked client can end up in a
terminal state rather than a retrying one. Starting over — fresh app bootstrap →
new credential → new register — gives a revoked browser its replacement
credential, gives a K-rotation target K_new, and after ④-bis replaces the pinned
agent identity key.

Scope:

- exact browser credential revoked → that browser/device;
- wildcard revoked → every affected browser in the account;
- ④-bis ran for an exact or wildcard agent credential → **every browser in the
  account**, because the SaaS active identity key/pin changed;
- rotated one peer → every device of that peer;
- rotated `--all-peers` → every browser of that account.

Also note that deploying a new plugin does not immediately reject an
already-connected older-protocol browser; the protocol gate applies at the next
register. The forced refresh is what makes that happen.

### Done — what you can now claim

- **Class A credential containment:** claim only what the provider evidence
  proves: provider acceptance and enforcement for the reviewed target, plus a
  replacement that passed the provider rule. If it exposed a numeric
  `providerEffectiveFloorSec`, you may also record that floor; otherwise do not
  invent one or claim Class B resolver readback.
- **Class B credential containment:** credentials issued at or before the
  effective accepted target floor (`expectedFloorSec`) are refused by the
  server, and you read that candidate/floor back from the resolver and verified
  enforcement. `floorSec` remains the requested incident time; it may be lower
  than the preserved accepted floor.
- **Class C credential containment:** while the revocation channel remains
  unavailable, claim only that the plugin is disabled and relay/account access
  is isolated—not that the credential was revoked. After recovery, claim the
  matching Class A provider evidence or Class B resolver/whole-chain evidence
  completed in §5 step 5.
- If K was in scope, conversation envelopes created after rotation cannot be
  decrypted with K_old: K_new is fresh random material, so the separation comes
  from the keys themselves.
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
3. **If a NATS credential is in scope**, isolate or stop the relay/account, or
   block access with provider/network controls until revocation is restored. A
   disabled plugin account does not stop a leaked credential from connecting to
   a relay that is still up. For K-only, this control is irrelevant.
4. **If K is in scope**, confirm the supported shared/single-store topology in
   §4 ① and run ④ while replicas remain at zero. Step ④ needs no relay and K-only
   does not require restoring a revocation channel.
5. **Only when a credential is in scope**, recover according to its deployment
   class while the account remains disabled and replicas remain stopped:
   - **Managed Class C:** restore provider control, then complete the matching
     §3 provider revocation, acceptance, and enforcement route. Do **not** run
     the self-contained §4 ②–③ resolver procedure.
   - **Self-contained Class C:** either restore the exact revocation/readback
     channel and run §4 ②–③, or complete a controlled whole-trust-chain
     replacement and verify old credentials are rejected.
   If that control targeted the current agent exact key or `"*"`, or whole-chain
   replacement invalidated it, run ④-bis while replicas are still stopped.
6. Re-enable/restart only after every control selected in §2 is complete and
   verified. Then run §4 ⑥ for affected browsers; if ④-bis replaced the active
   agent identity key, that means **every browser in the account**, whether the
   agent credential revocation was exact or wildcard. A K-only incident may
   finish after ④–⑥ even if the otherwise irrelevant revocation channel is
   still unavailable.
7. Deleting old configuration, restarting only some replicas, or waiting for
   token expiry is **not** revocation.

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
the floor is monotonic so you cannot lower it back. Recovery depends on the
target:

- **Exact `U…` key:** that old user key can never be made usable again, but the
  account remains usable. Issue/re-enroll a replacement with a **new NATS user
  key**. If the poisoned key was the current agent, follow ④-bis; its active
  identity-key replacement also requires every account browser to bootstrap at
  ⑥.
- **Wildcard `"*"`:** the account-wide floor cannot be lowered and applies to
  every user key whose credential `iat` is below that future value. Recover
  through a controlled account/trust-chain replacement; simply minting another
  user key under the same poisoned account does not undo the wildcard floor.

Compute it as `Math.floor(Date.now() / 1000)` and check the magnitude before you
publish.

### 6.2 `"*"` cuts the agent too

Browser and agent credentials come from the same `accountSeed`. The wildcard is
an account-wide kill switch, not a browser-only one. Plan ④-bis before you use it.
An exact revocation of the current agent `U…` key also requires ④-bis, but its
replacement must use a new user key and is not bound by the old key's floor.
Because ④-bis replaces the active agent identity key too, both routes require
every browser in the account to complete fresh bootstrap at ⑥.

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
instruction is wrong, not your deployment. Do not read it as "nothing is stored"
either: `delivery-journal.sqlite` holds conversation plaintext, so the lever
there is **deletion**, not invalidation — §0.2 has the trade-off and whether to
pull it is your call.

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
