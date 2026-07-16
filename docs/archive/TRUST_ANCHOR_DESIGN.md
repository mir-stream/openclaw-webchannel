# Trust Anchor Design — `channels add` derives trust, config holds only settings

> **ARCHIVED 2026-07-15.** Historical design; see `../TRUST_AND_ONBOARDING.md`.

> **Essence:** the plugin's ONLY trust input is the **SaaS URL**. Everything
> trust-related is *derived* from `{SaaS URL, accountId}` or *delivered by the
> SaaS at enrollment* — never guessed, never hand-written. Everything else is a
> genuine *setting* (operator preference) that lives in config with a good
> default and may be edited by choice.

Status: **design approved, not yet implemented** (2026-07-03). Supersedes the
heavier "SaaS trust descriptor" proposal (dropped — see §6). Reviewed by three
fresh agents (security / architecture / product); their load-bearing findings
are folded in as constraints below.

## 1. Why this exists (the bug's real cause)

A first-run manual pairing (bring-your-own openclaw against a SaaS+Web on
Synadia) failed with an opaque `Credentials expired` / `[nats-client] request
timeout`. Three misconfigs, one root: **trust facts were treated as settings** —
guessed by `channels add`, hand-editable, and able to silently mismatch:

1. `nats.admission` defaulted to `auto` → agent never subscribed `*.register` →
   browser's register-over-NATS request timed out. (Already fixed: the setup
   builder now writes `register-hop` — `packages/plugin/src/setup.ts` builder.)
2. `jwt.issuer` was guessed as the SaaS base URL, but the SaaS signed tokens with
   a *different* `iss` → JWT verify failed → register rejected.
3. `session.dmScope` / `history.enabled` were never written → user had to know to
   add them.

The fix is not "deliver more config" — it is to stop treating derivable trust
facts as configuration at all.

## 2. The two buckets

| | **A — Derived / delivered (trust facts). NEVER in config, NEVER edited to make it work.** | **B — Settings (operator preference). In config with a good default; edit by choice.** |
|---|---|---|
| Fields | `issuer`, `jwksUrl`, `audience`, relay/NATS URL + creds, `nats.admission` (= `register-hop`) | `dmSecurity` + `allowFrom`, `session.dmScope`, `history.enabled`, `execApprovals` + `approvers` |
| Source | Derived from `{saas.baseUrl, accountId}`; creds + relay URL delivered by SaaS at enrollment (already the case) | Written by the builder with sensible defaults; operator may change |
| Nature | Protocol / trust fact — no choice, cannot mismatch (derivation) | Genuine preference |
| Hand-edit? | **Never needed** | **Fine** — that's what settings are |

Derivations (the whole of bucket A's trust params):
- `issuer`   = `saas.baseUrl`  (invariant: the SaaS identifies itself by the URL it is reached at)
- `jwksUrl`  = `saas.baseUrl` + `/.well-known/jwks.json`
- `audience` = `accountId`     (already `aud == accountId`, `packages/saas/src/bootstrap-claims.ts:96`)
- relay URL + NATS creds = SaaS-delivered at device-flow approval, persisted, consumed at runtime (existing mechanism — `consume-credentials.ts:95`, `account-config.ts:411-417`)
- `admission` = `register-hop` (jwt + enrolled → register-hop; the ONE protocol default)

## 3. Refined "never hand-edit openclaw.json" principle

- Bucket **A** (make-it-work trust facts): must be **100% automatic**. Needing to
  edit A is a bug.
- Bucket **B** (settings): living in config with defaults is correct; editing B
  to change a preference is the normal, intended act — not a violation.

So the principle is precisely: *you never edit config to make it work; you only
ever edit config to change a preference.*

## 4. Code changes (small)

1. **Plugin — derive JWT-verify params when not explicitly configured.**
   `resolveVerifier(accountAuth)` (`packages/plugin/index-nats.ts:472-474` →
   `makeJwtVerifier`, `packages/plugin/src/auth.ts:200-241`; per-request verify
   `auth.ts:306`) reads `issuer/jwksUrl/audience` from the account `auth` block
   today. Change: when absent, derive from `saas.baseUrl` + `accountId`.
   **Config-present-wins** — an explicit `auth.jwt.issuer/jwksUrl/audience` in
   config overrides derivation (operator pin escape hatch for proxy / custom-
   domain / logical-issuer deployments). The consume step runs first
   (`index-nats.ts:282`) so `saas.baseUrl`/accountId are available at the derive
   site with no openclaw core change (verified: core never reads these fields).

2. **Builder (`channels add`) — stop writing guesses.**
   `buildFullAccountPatch` (`packages/plugin/src/setup.ts:~188-211`) currently
   writes `issuer ?? saasBaseUrl`, `audience ?? accountId`, derived `jwksUrl`.
   Change: **omit** `auth.jwt.issuer/jwksUrl/audience` entirely (they derive at
   runtime). Keep writing: the anchor `saas.baseUrl`, `auth.strategy:"jwt"`, the
   account key `accounts.<id>` (= wire subject segment), `nats.credentials.mode:
   "enrolled"`, **`nats.admission:"register-hop"` (PINNED — see §5 fail-closed)**,
   and bucket-B defaults (`dmSecurity`, `session.dmScope:"per-channel-peer"`,
   `history.enabled:true`). Merge already preserves an operator's explicit
   overrides across re-runs (`setup.ts:~138-159, ~300-308`).

3. **SaaS — issuer == its own base URL.**
   Drop the demo's fake `SAAS_ISSUER=https://saas.local/demo-issuer`; the SaaS
   signs `iss` = its base URL (already done at runtime by booting the SaaS-only
   launcher with `SAAS_ISSUER=$SAAS_BASE_URL`; make it the code default so no
   boot can reintroduce the mismatch). This is the invariant derivation #1 relies
   on.

4. **Preflight (safety net — keep, make it PRIMARY not optional).**
   The product review's load-bearing point: removing the 3 known causes does
   nothing for the *invisibility* that was the actual pain. Add a register
   self-check that runs in two places and prints per-gate PASS/FAIL (or the exact
   failure), so any residual misconfig is self-explaining at the moment it fires:
   - at `channels add` (post-enroll, before declaring success): a real register
     dry-run round-trip.
   - at gateway start (before serving): "issuer=X resolved · JWKS N keys · aud=Y ·
     admission=register-hop, subscribed `*.register` · dmScope=per-channel-peer"
     or the precise failure.
   There is NO preflight/dry-run in the code today (confirmed).

## 5. Constraints the implementation MUST honor (from the reviews)

- **Fail-closed admission (security, non-negotiable).** Keep `auth.strategy:"jwt"`
  + `nats.admission:"register-hop"` PINNED in config. Do NOT make `admission`
  derivable-when-absent in a way that falls back to `auto`: `auto` + the
  `dmSecurity:"open"` default = serve any browser with NO JWT/PoP (the hole AC4
  closed — `auth.ts:131-145`, `dm-allowlist.ts:14`, `nats-admission.ts:80-121`).
  An enrolled/jwt account with missing verify params must **skip serving with a
  loud log** (buildVerifier throws → account skipped, `nats-admission.ts:98-104`),
  never downgrade.
- **Config-present-wins precedence** → zero breakage: existing deployments, the
  ~6 e2e harnesses, `run.sh`, `multiplex.sh` all write explicit full blocks and
  keep working; no re-enrollment. New pointer-style accounts get derivation.
- **Operator pin escape hatch:** explicit `issuer`/`jwksUrl`/`audience`/`admission`
  in config always override derivation (the one legitimate reason to pin: force a
  malicious SaaS to inject keys into its public auditable JWKS rather than
  covertly repoint one agent).
- **Re-validate SaaS-delivered subject tokens** (tenant, anything reaching a NATS
  subject) at the plugin boundary (`assertValidSubjectToken`) — tenant feeds
  `webchannel.{tenant}.>` grants (`device-flow-enrollment.ts:584`,
  `index-nats.ts:383`).
- **`dmScope` is a core session key** openclaw reads for routing
  (`index-nats.ts:352` reads top-level `api.config.session`). The builder may set
  its default, but the derivation/preflight can only *assert/warn* on it (warn if
  `"main"` = cross-user leak), not silently reconfigure core.
- **Diagnostics that read config today must read the effective (derived) values**
  for accounts that omit them: the shared-audience guard
  (`index-nats.ts:356-378`) and the cross-user history warning
  (`index-nats.ts:349-353`).

## 6. What is DROPPED vs the earlier proposal

The heavier "signed SaaS trust descriptor delivered at enrollment + persisted +
runtime-consumed" is **dropped**. Once trust params are *derived* from the
anchor, there is nothing to deliver: no descriptor payload, no signed blob, no
version/rollback store, no runtime re-fetch. The security review's descriptor
hazards (enrollment-MITM broadening browser admission, descriptor rollback,
fail-open on a missing field) all vanish because the mechanism vanishes.
`admission` stays a pinned config default (fail-closed), not a delivered field.

## 7. Decisions settled

- **CLI:** keep `--base-url` (the anchor) + `--account`. Keep `--url`/tenant for
  now (tenant is load-bearing in the enrollment request + subject perms; "SaaS
  states tenant" is a separate SaaS-side tenancy change). The approval step should
  echo `joining tenant=<T>, agent=<account>` so the human confirms at the click.
- **No `.well-known/webchannel-config` discovery endpoint** (would add a boot-time
  SaaS round-trip + an unauth account-existence oracle). Derivation needs no SaaS
  endpoint beyond the JWKS the agent already fetches.

## 8. Sequencing

1. Changes **1–3** (derive + stop guessing + SaaS issuer = base URL) — these are
   what actually create the A/B split and kill the three traps at the source.
2. **Preflight (4)** — the safety net on top, catches whatever's left (SaaS
   unreachable, empty JWKS, a bucket-B mistake) with a visible, actionable message.
3. Verify: full suite + typecheck; the SaaS-only Synadia launcher + a fresh manual
   pairing that needs **zero** openclaw.json edits to reach a working chat; the ~6
   e2e harnesses stay green (config-present-wins).

## 9. Also open (separate, user's other intent)

Legacy `packages/plugin/index.ts` (Gateway-WS / HMAC, DEV-ONLY, not the default,
never loaded by the demo or live gateway) still sits in the tree. Harmless to the
no-inbound premise but present. Delete it (+ its `src/transport.ts` WS half) if
the intent is zero legacy in the tree — separate small task.
