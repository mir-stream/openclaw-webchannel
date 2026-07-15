# P1-6 — Doctor / Self-diagnosis Plan

> Status: DRAFT rev3 (rev1: 17 findings; rev2: 7 findings — both codex/gpt-5.6-sol
> adversarial rounds folded in; see §9 for dispositions)
> Branch: `feat/p1-6-doctor`
> Gap ref: `docs/gaps/P1_RICH_UX_GAPS.md` §P1-6 (🔴 MISSING)

## 1. Intent

When a webchannel account is misconfigured, today's failure surface is a **silent
log skip** inside `gateway run` (`packages/plugin/index-nats.ts` serving loop):
encryption misconfig → skip; missing enrolled creds → skip; missing identity key →
skip; verifier build failure → skip. The operator running `openclaw doctor` or
`openclaw status` sees **nothing** — the checks exist but are log lines in a
process the CLI never runs.

P1-6 surfaces those checks through openclaw's first-class diagnosis surfaces.

**Acceptance (from the gap doc).** `openclaw doctor` reports actionable issues
for a mis-set account (missing creds, bad auth strategy, encryption off) with a
fix hint, instead of a silent log skip.

**Delivery split (review finding 16).** The acceptance-critical part is the
`doctor` hook + shared resolution (§3.1–3.2, catalog §4) — **Phase 1**. The
status/probe surfaces (§3.3–3.4) are **Phase 2**, built on the same engine,
landed as separate commits so Phase 1 stands alone if Phase 2 hits an SDK wall.

## 2. Dist-verified SDK contract (openclaw 2026.6.10)

> Past incident (P0 round-1): a plan doc cited a fabricated runtime field.
> Everything below was grepped from `node_modules/openclaw/dist` on 2026-07-15.
> Note: openclaw ships bundled dist only — `.ts` source citations from the gap
> doc are unverifiable; all citations here are dist file:line.

**Correction to the gap doc.** The real `ChannelDoctorAdapter` is **not** a
scanner registry — it is config-repair/warning hooks. `ChannelStatusIssue` and
`BaseProbeResult` belong to the **separate** `ChannelStatusAdapter`. Two sibling
slots on `ChannelPlugin`:

- `doctor?: ChannelDoctorAdapter` — `dist/types.plugin-CTcdBrrg.d.ts:52`
- `status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>` — `:41`

There is no standalone `probe` slot — probe = `status.probeAccount`.

### 2.1 The doctor surface — TWO paths with different gating

**Path A — static config scan (works with the gateway DOWN).**
`openclaw doctor` → `collectChannelDoctorPreviewWarnings`
(`dist/channel-doctor-BII-6bFB.js:209-227`) → `listChannelDoctorEntries`
(`:105-127`), which merges the `doctor` slot from (a) read-only-resolved plugins
(`resolveReadOnlyChannelPluginsForConfig` — loads external plugins including the
**setup entry** fallback), (b) the loaded plugin registry, (c) bundled plugins.
Gating: channel key present under `cfg.channels` and not `enabled:false`,
plugins enabled (`collectConfiguredChannelIds`, `:30-41`).

Hook we implement:

```ts
collectPreviewWarnings?: (params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}) => string[] | Promise<string[]>;
```

(`dist/plugin-sdk/types.adapters-COgmKWsA.d.ts:502-506`; full adapter `:493-525`.)
NOT used in v1: `repairConfig`/`cleanStaleConfig`/`runConfigSequence`/
`legacyConfigRules` (config mutations — §6), allowlist hooks (core generics
already cover our `security.dm`).

**Path B — gateway-gated health contribution.** `doctorCommand` →
`runDoctorHealthContributions` → `dist/doctor-gateway-health-BxyJycIT.js:47`
calls the gateway RPC `channels.status { probe: true }`; gateway-side,
`dist/channels-status-issues-DMG35Dnw.js:62-71` iterates `listChannelPlugins()`
and calls each `plugin.status?.collectStatusIssues(accounts)`, rendered under
"Channel warnings". Requires a running gateway; RPC failure is silently
swallowed (try/catch).

**Design consequence.** Config findings (C-catalog) live in Path A — they must
be visible exactly when misconfig prevents the gateway from serving. The status
adapter carries **runtime truth only** (§3.4); it enriches doctor output only
when a gateway is up.

### 2.2 The status surfaces — command-by-command (review finding 4)

| Surface | Snapshot builder | `collectStatusIssues`? | `probeAccount`? |
|---|---|---|---|
| plain `openclaw status` scan | `dist/account-inspection-BbD3BIbX.js:14` — `enabled/configured` + safe projected fields + **`config.describeAccount` spread**; does NOT call `status.buildAccountSnapshot` | YES — `dist/status.scan.runtime-E0ZqAgVu.js:352`; non-empty result flips channel state to `warn`, `issues[0].message` is the detail (`:355-373`) | no |
| `channels status` | plugin-aware builder `dist/status-j1x1APRa.js:10-46` (prefers `status.buildAccountSnapshot`; attaches `probe` onto the snapshot when present, `:35`) | **no** (`channels-nLP6UG29.js` never calls it) | with `--probe`: `channels-nLP6UG29.js:224-238` |
| health | plugin-aware builder (`health-CZIAreXu.js:395`) | no | gated by `doProbe` (`:372-374`) |
| gateway RPC `channels.status {probe:true}` (doctor Path B) | gateway-side live accounts | YES — `channels-status-issues-DMG35Dnw.js:62-71` | yes (probe:true) |

There is **no dist-verified path** where `status.buildAccountSnapshot` output
subsequently reaches `collectStatusIssues` on the plain scan — rev1's
"embed findings in snapshots" pipeline is structurally invalid and is
**abandoned** (review findings 1–3). `ChannelAccountSnapshot`
(`types.core-BMp7ngzJ.d.ts:213`) has no index signature; no invented extension
keys.

### 2.3 Wire types + import path + SDK helper

```ts
// types.core-BMp7ngzJ.d.ts:176 — NO severity field; kind is the classifier
type ChannelStatusIssue = {
  channel: ChannelId; accountId: string;
  kind: "intent" | "permissions" | "config" | "auth" | "runtime";
  message: string; fix?: string;
};
// :816
type BaseProbeResult<TError = string | null> = { ok: boolean; error?: TError };
```

- Import the adapter/wire types from **`openclaw/plugin-sdk/channel-contract`**
  (`dist/plugin-sdk/channel-contract.d.ts:6`) — `channel-core` (what
  `src/channel.ts` imports today) does not export them.
- SDK helper `createComputedAccountStatusAdapter` is publicly exported from
  `openclaw/plugin-sdk/status-helpers` (`status-helpers.d.ts:5`, signature
  `status-helpers-Dkr4y56M.d.ts:221`) — the pattern Telegram uses
  (`dist/channel-hdL45_1j.js:1037`). Use it for the status adapter if its
  composed behavior fits; else hand-roll the two hooks.
- Telegram reference (corrected dist locations): `telegramDoctor`
  `dist/channel.setup-DCwynIzw.js:902` (attached `:1030`); `probeTelegram`
  `dist/probe-GGcI5Ri9.js:600`; `collectTelegramStatusIssues`
  `dist/channel-hdL45_1j.js:433`.

### 2.4 Attachment point

`ChatChannelPluginBase = Omit<ChannelPlugin, "security"|"pairing"|"threading"|"outbound"> & …`
(`dist/plugin-sdk/core-C3b8PKLj.d.ts:169`) — `doctor`/`status` flow through the
same `Object.assign(createChannelPluginBase({...}), {...})` mechanism
`message`/`approvalCapability`/`gateway` already use (`src/channel.ts:111-171`).
`setup-entry.ts:15` calls the same `createWebChannelPlugin(transport)`, so ONE
attach covers the doctor CLI's read-only/setup-fallback load path. Do NOT attach
on the `defineChannelPluginEntry` object.

### 2.5 Execution context — the load-bearing constraint

Path A and the plain status scan run in the **CLI process** (no gateway, no
`accountRuntimes`, no live NATS). Path B runs `collectStatusIssues`/
`probeAccount` **inside the gateway process**. Every hook must be a function of
its params `(cfg, account, snapshots, filesystem, bounded on-demand network)`
only — never plugin module globals. Runtime facts (`lastError`, `connected`,
attached `probe`) arrive only via the snapshots core hands over.

## 3. Design

### 3.1 One check engine, two consumers

New module **`packages/plugin/src/doctor.ts`**:

```ts
type DoctorFinding = {
  accountId: string;
  checkId: /* §4 catalog ids */;
  kind: ChannelStatusIssue["kind"];   // config | auth | intent
  severity: "error" | "warn";         // internal; maps to message prefix
  message: string;   // WHAT is wrong, naming the EFFECTIVE values
  fix: string;       // actionable next step (command or config edit)
};

evaluateWebchannelDoctor(cfg, deps) → DoctorFinding[]  // planAccounts + per-account + cross-account
formatDoctorWarning(finding) → string                   // Path A lines
createWebchannelDoctorAdapter() → ChannelDoctorAdapter  // { collectPreviewWarnings }
```

`deps` injects the fs/env seams (`loadPersistedEnrolledCreds`, `env`) so tests
never touch the real home dir. `collectPreviewWarnings` performs **no network
I/O** (doctor stays fast and offline; live legs belong to the probe). Warning
lines are prefixed `- channels.webchannel.<account>: …` matching core's list
style (`channel-doctor-BII-6bFB.js:222`).

Config-layout warnings are NOT string-routed from `planAccounts`' warn sink
(rev2 finding 6): the doctor calls dedicated structured detectors — C10's
exported `detectOrphanedDefault` and C11's env-key predicate — so each finding
keeps its own fix text and the sink's once-only latches don't suppress repeat
scans.

### 3.2 Shared effective-auth resolution (review finding 13)

rev1 proposed moving `deriveAccountAuth` (`index-nats.ts:177-210`) verbatim.
Insufficient: the caller ALSO owns base-URL precedence
(`plan.saasBaseUrl ?? config.saas?.baseUrl`, `:358`) and persisted-issuer
loading (`loadPersistedEnrolledCreds(accountId)?.issuer`, `:365`) — extracting
only the fill function lets doctor and runtime resolve DIFFERENT inputs.

Extract instead into **`src/account-auth.ts`** — a **strictly
behavior-preserving** refactor (rev2 finding 1: this PR is a diagnosis feature;
it must not change runtime semantics):

```ts
deriveAccountAuth(raw, saasBaseUrl, accountId, deliveredIssuer?)  // moved verbatim
resolveEffectiveAccountAuth({
  accountAuthRaw,          // account.auth
  accountId,
  planSaasBaseUrl,         // plan.saasBaseUrl (acquisition precedence, from planAccounts)
  topLevelSaasBaseUrl,     // config.saas?.baseUrl
  loadCreds,               // injected loadPersistedEnrolledCreds (fs seam)
})
// = deriveAccountAuth(accountAuthRaw,
//     planSaasBaseUrl ?? topLevelSaasBaseUrl,   // EXACTLY index-nats.ts:353-358
//     accountId,
//     loadCreds(accountId)?.issuer)             // EXACTLY index-nats.ts:365
```

**Known divergence, documented not "fixed":** the AUTH derivation input is
`plan.saasBaseUrl ?? config.saas?.baseUrl` (`index-nats.ts:353-358`), while the
CREDENTIAL-SOURCE resolver separately honors
`WEBCHANNEL_SAAS_BASE_URL > nats.credentials.saasBaseUrl > input > default`
(`nats-credential-source.ts:309`). `nats.credentials.saasBaseUrl` does NOT feed
auth derivation today — the doctor mirrors that reality. (A divergence-warning
check is a possible follow-up, OUT of v1.)

Tests (precedence matrix): plan-resolved base URL wins over top-level; top-level
fallback; delivered issuer WITHOUT any base URL (documented early-return: fill
is skipped when `saasBaseUrl` is absent); pin-wins over delivered over derived;
all key-source combinations. (No `nats.credentials.saasBaseUrl` case — it is
not an input, per the divergence note above.)

Note (review finding 5): `index-nats.ts` is **in tsc's include set**
(`tsconfig.json` — issue #32); the extraction rationale is reuse + direct unit
testability, not type-safety.

### 3.3 Live probe (`status.probeAccount`) — Phase 2

```ts
type WebchannelProbe = BaseProbeResult & {
  accountId: string;
  admission: AdmissionMode;
  jwks?: { source: "url" | "file" | "inline"; keyCount: number } | { error: string };
  relay?: { ok: true; url: string } | { error: string };
};
```

- **Credential material — enrollment is FORBIDDEN** (rev1 finding 10; algorithm
  made exact per rev2 finding 2). New side-effect-free helper (in
  `src/consume-credentials.ts`, beside the semantics it mirrors):

  ```ts
  type DialMaterial =
    | { status: "ok"; mode: NatsCredentialSource["mode"];
        dial: { kind: "static"; url: string; userJwt: string; userSeed: string }
            | { kind: "open"; url: string } }
    | { status: "creds-missing"; accountId: string }   // enrolled, nothing persisted
    | { status: "invalid"; error: string };            // resolver threw (≙ C9)

  resolveDialMaterial({ natsConfig, legacyNats, saasBaseUrl, tenant, accountId, env, loadCreds })
  ```

  Algorithm (mirrors `consumeCredentialSource` — `consume-credentials.ts:77` —
  minus the enroll branch):
  1. `resolveNatsCredentialSource(...)` — a throw is caught → `invalid`
     (same fault C9 reports).
  2. `static` → `{ kind:"static", url: source.url, userJwt, userSeed }`
     unchanged; `open` → `{ kind:"open", url: source.url }`.
  3. `enrolled` → `loadCreds(accountId)` ONCE; absent → `creds-missing`
     (NEVER the device flow — `connectNatsCredentialSource`'s enrolled branch
     starts it, `nats-credential-source.ts:402`, so the probe never calls that
     branch); present → static-shaped material with
     **`url = persisted.natsUrl ?? source.url`** — the SaaS-delivered relay
     wins, exactly like the runtime (`consume-credentials.ts:99`).

  Tests: delivered-URL-wins over configured URL; configured fallback when the
  persisted block lacks `natsUrl`; malformed persisted creds → `invalid`, not a
  throw; enrolled-missing → `creds-missing` and the device-flow seam is never
  invoked. The dial itself then reuses Gate A's relay dial exactly as today
  (`preflight.ts:475` wraps material as static/open).
- **Relay leg** — export Gate A's relay dial from `preflight.ts` (currently
  module-private) and reuse: connect, scoped no-op subscribe under
  `webchannel.{tenant}.{accountId}._doctor`, disconnect, bounded by `timeoutMs`.
  Honest claim (review finding 12): this proves **relay authentication +
  connectivity only** — `subscribe` returns before any async permission fault
  can surface. The probe result label says exactly that.
- **JWKS leg — probe the EFFECTIVE key source** (review finding 11), not the
  Gate A derived URL: run `resolveEffectiveAccountAuth` first, then probe
  whichever single source the runtime would use — `jwksUrl` → bounded fetch via
  `JWKSCache`; `jwksFile` → read + parse locally; inline `jwks` → parse/count
  locally. Report `source` so the operator knows WHICH one was tested. Skipped
  for `auto`-admission accounts (no verifier by construction).
- Fail-soft: always **return** `{ ok:false, error }`, never throw (consumers
  catch anyway — `channels-qFKnilin.js:440-449` — but a returned shape renders
  better). `ok` = every applicable leg passed. `credentials.mode:"open"` runs a
  plain connect and must not fail for lacking creds.

### 3.4 `collectStatusIssues` — runtime truth only — Phase 2

No config-finding smuggling (review findings 1–3). The hook consumes **declared
snapshot fields plus the runtime-attached `probe`**:

1. `lastError` → `runtime` issue via the SDK helper
   `collectStatusIssuesFromLastError` (`dist/plugin-sdk/status-helpers.d.ts:5`;
   pattern: bundled iMessage, `dist/channel-CkUa8UjT.js:597`).
2. A failed attached probe (`snapshot.probe.ok === false`) → `runtime`/`auth`
   issue with the probe's per-leg error and a fix hint.
3. On the plain scan path snapshots carry neither — the hook returns `[]`
   there; config findings are Path A's job.

**The probe→issues pipeline is dist-proven end-to-end** (rev2 finding 3,
resolved by trace): the gateway `channels.status` handler
(`dist/channels-nLP6UG29.js:188`) with `probe:true` (a) runs
`plugin.status.probeAccount` (`:224-238`), (b) builds each snapshot via the
plugin-aware builder passing `probe: probeResult` (`:261-268`; the builder
attaches it — `status-j1x1APRa.js:35`), (c) **copies a failed hook's error into
`snapshot.lastError`** (`:270-271` `hookError … if (hookError &&
!snapshot.lastError) snapshot.lastError = hookError`), (d) assembles
`payload.channelAccounts` from those snapshots (`:332-336`). Doctor Path B then
feeds exactly that payload to `plugin.status.collectStatusIssues(accounts)`
(`channels-status-issues-DMG35Dnw.js:62-71`). Consequence: even with hook (2)
absent, a failed probe already surfaces via (1)'s `lastError`; hook (2) only
upgrades the message to per-leg detail (which JWKS source failed, relay URL).
Read `snapshot.probe` defensively (untyped attachment).

`config.describeAccount` (optional, tiny): report truthful DECLARED fields only
— `credentialSource` (resolved mode), `audience` (effective aud) — so the plain
status table is more informative. It is NOT a findings carrier.

## 4. Check catalog (v1)

Every check names the EFFECTIVE (post-`resolveEffectiveAccountAuth`) values and
carries a fix hint. Per-account checks run over `planAccounts(cfg)`; C5/C10 are
cross-account/config-layout.

| # | checkId | Condition (source) | kind / severity | Fix hint |
|---|---------|--------------------|-----------------|----------|
| C1 | `encryption-disabled` | `resolveEncryptionPolicy` throws (`encryption.mode:"disabled"`) — `index-nats.ts:391-400` | config / error | Remove the `encryption.mode` override — the NATS channel is encrypt-by-construction |
| C2 | `creds-missing` | credential source resolves to `enrolled` AND `loadPersistedEnrolledCreds(accountId)` is undefined — mirrors `consumeCredentialSource` `creds-missing` (`index-nats.ts:419-429`) | auth / error | `openclaw channels add --channel webchannel --account <id>` |
| C3a | `register-hop-static-unsupported` | admission=register-hop AND credentialMode=`static` — the runtime ALWAYS fail-closes here (static consume never yields an identity key: `nats-credential-source.ts:390`, guard `index-nats.ts:537-560`) | config / error | Remediation must actually clear the finding (rev2 finding 4 — ANY static signal keeps resolving `static` before `enrolled`, `nats-credential-source.ts:253`): EITHER remove ALL static credential signals (`nats.credentials.{mode,credsFile,userJwt,userSeed}` + `WEBCHANNEL_NATS_{CREDS,USER_JWT,USER_SEED}` env) and enroll, OR set `nats.admission:"auto"` deliberately. Test: applying the suggested fix yields zero findings |
| C3b | `identity-key-missing` | admission=register-hop AND credentialMode=`enrolled` AND persisted creds lack the identity key (pre-F2 creds) — `index-nats.ts:548-559` | auth / error | Re-enroll to mint an attested identity key (same command as C2) |
| C4 | `verifier-unbuildable` | admission=register-hop AND the verifier config fails the REAL validation rules. Mechanism (rev2 finding 5 — calling `resolveVerifier` directly would mutate the module-level JWKS-cache `WeakMap`, `auth.ts:193`, from an offline scan): extract/export a side-effect-free **`validateJwtVerifierConfig(auth)`** in `auth.ts` that owns the exact non-empty issuer/audience + exactly-one-key-source rules (`auth.ts:243,260`); `makeJwtVerifier` calls it first (single validation source — semantics cannot drift) and the doctor calls it alone (no cache construction). Surface the thrown/returned error verbatim | config / error | From the validation error + effective issuer/aud state; live URL reachability stays in the probe |
| C5 | `shared-audience` | two register-hop jwt accounts share slash-normalized (issuer, audience) — `index-nats.ts:491-518` | config / error | Give each register-hop account a distinct audience (= its accountId); names BOTH accounts |
| C6 | `open-admission` | admission=auto AND `isDmPostureOpen(dmSecurity)` (`dm-allowlist.ts:55`) — `index-nats.ts:841-846` | intent / warn | Set `dmSecurity:"allowlist"` and populate `allowFrom`, or rely on NATS subject permissions deliberately |
| C7 | `obsolete-cors` | `auth.cors` present — `index-nats.ts:375-383` | config / warn | Delete the `auth.cors` block (register hop moved to NATS; origin allowlisting is inert) |
| C8 | `auth-strategy-invalid` | non-jwt `auth.strategy`, classified CONTEXTUALLY (review finding 9): (a) explicit `nats.admission:"register-hop"` override + non-jwt → **error** (verifier construction will fail; account skipped); (b) `strategy:"anonymous"`/unknown with NO explicit admission → **warn**: "auth is ignored; admission silently became `auto`" (`resolveAdmissionMode` defaults non-jwt→auto, `nats-admission.ts:68`; `resolveVerifier` would throw, `auth.ts:309`, but is never called for auto); (c) intentional auto/static BYO-NATS with no auth block at all → **no finding** | config / error-or-warn | (a) use `strategy:"jwt"`; (b) remove the inert auth block or switch to jwt; (c) — |
| C9 | `credential-source-invalid` | `resolveNatsCredentialSource` throws (unreadable creds file `nats-credential-source.ts:280`; incomplete static jwt/seed `:293`) — the serving loop catch-skips the whole block (`index-nats.ts:458-464`) (review finding 8) | config / error | From the thrown message (file path / missing field named) |
| C10 | `orphaned-default` | the orphaned-default shape ONLY (rev2 finding 6 — do not string-route arbitrary sink warnings): refactor `warnOnOrphanedDefault` (`multiplex.ts:96-111`) into an exported pure predicate `detectOrphanedDefault(cfg): boolean` + a warn wrapper, so serving loop and doctor share ONE detector. Condition: channel-level auth/nats beside named accounts, no `accounts.default` | config / warn | Move the intended default's fields under `accounts.default` |
| C11 | `deprecated-acquisition-env` | deprecated acquisition env vars set while `channels.webchannel` config exists — they are IGNORED (`acquisition-env.ts:74-84`; detect via the same `ACQUISITION_IDENTITY_ENV_KEYS` + has-config predicate, not the once-only warn sink whose `deprecationWarned` latch would suppress repeat scans) | config / warn | Unset the deprecated env vars (named in the message); config is authoritative — use `openclaw channels add` |

Semantics rule: the doctor **mirrors** the serving loop; it never introduces new
semantics. C3a documents (not changes) the current static-register-hop
fail-close — if that behavior is ever revisited, serving loop and doctor change
together through the shared resolver.

## 5. Files touched

| File | Change |
|------|--------|
| `src/doctor.ts` (NEW) | Finding engine, C1–C10, formatter, doctor adapter factory; Phase 2: probe + status adapter factory + `resolveDialMaterial` |
| `src/doctor.test.ts` (NEW) | Per-check fire/pass; formatter carries fix hints; contextual C8 cases (a/b/c); probe fail-soft + never-enrolls (injected seams) |
| `src/account-auth.ts` (NEW) | `deriveAccountAuth` (moved verbatim) + `resolveEffectiveAccountAuth` (input resolution, §3.2) |
| `src/account-auth.test.ts` (NEW) | Precedence matrix (§3.2) |
| `src/preflight.ts` | Export the relay-dial primitive |
| `src/auth.ts` | Extract/export side-effect-free `validateJwtVerifierConfig`; `makeJwtVerifier` calls it first (C4) |
| `src/multiplex.ts` | Refactor `warnOnOrphanedDefault` → exported `detectOrphanedDefault` predicate + warn wrapper (C10) |
| `src/consume-credentials.ts` | Add `resolveDialMaterial` (§3.3, Phase 2) |
| `src/channel.ts` | Attach `doctor` + `status` adapters (+ optional thin `config.describeAccount`); import types from `openclaw/plugin-sdk/channel-contract` |
| `packages/plugin/index-nats.ts` | Replace local `deriveAccountAuth` + inline precedence with `resolveEffectiveAccountAuth` (behavior-preserving) |
| `src/index-nats-wiring.test.ts` | Guard the refactored import edge |
| `docs/gaps/P1_RICH_UX_GAPS.md` | Flip P1-6 to ✅ BUILT with a summary |

## 6. Scope decisions

- **IN (Phase 1)**: `doctor.collectPreviewWarnings`, C1–C10,
  `resolveEffectiveAccountAuth` extraction.
- **IN (Phase 2)**: `status.probeAccount` (effective-source JWKS + relay dial),
  runtime-only `collectStatusIssues`, optional thin `describeAccount`.
- **OUT — demo admin panel surface.** SaaS-side surface; doctor output is
  agent-side; bridging needs a new reporting path. Acceptance met via
  `openclaw doctor`.
- **OUT — auto-repair (`repairConfig`/`cleanStaleConfig`).** Warn-only v1; C7
  is the only safe mutation candidate — defer until the warn-only doctor soaks.
- **OUT — `inspectAccount` honesty fix** (`channel.ts:127-131` hardcodes
  `configured:true`). Blast radius beyond this feature; BACKLOG note.
- **OUT — live register round-trip probe.** Same honest-scope reasoning as
  Gate A (`preflight.ts:205-233`): no browser bootstrap JWT exists at probe
  time.

## 7. Testing

1. **Unit (vitest)**: every check's fire AND pass branches (incl. dev-open
   exemptions, C8 a/b/c, C3a vs C3b); formatter/`toStatusIssue` mapping; probe
   returns `{ok:false}` on timeout/dial failure and NEVER triggers enrollment
   (assert the device-flow seam is not called); `resolveEffectiveAccountAuth`
   precedence matrix; `resolveDialMaterial` matrix (§3.3).
   **Zero-finding fixtures — healthy compatibility shapes MUST stay quiet**
   (rev2 finding 7): (i) legacy flat single-default-account config
   (`account-config.ts:184` fallback); (ii) static BYO-NATS with implicit
   `auto` and NO auth block (locks C8(c), `nats-admission.ts:68`); (iii)
   dev-open register-hop (well-known dev identity fallback — no C3 finding,
   `index-nats.ts:539-546`); (iv) healthy enrolled register-hop (persisted
   creds + identity key + valid jwt block).
   **Remediation test** (rev2 finding 4): applying C3a's suggested fix to the
   fixture clears the finding.
2. **Wiring**: assert the built plugin exposes `doctor.collectPreviewWarnings`
   + `status.probeAccount`; `collectPreviewWarnings` on a config with
   `encryption.mode:"disabled"` yields a warning naming the account. Where
   feasible, drive core's real `listChannelDoctorEntries` merge semantics with
   the built plugin object (integration-ish; review finding 1's ask).
3. **Type gate**: `pnpm build && pnpm test` (tsc + vitest) green; new logic in
   `src/` for direct testability.
4. **Manual acceptance**: `openclaw doctor` against (a) missing-creds account,
   (b) `encryption.mode:"disabled"`, (c) anonymous strategy → three actionable
   warnings; healthy config → no webchannel warnings; `openclaw status` stays
   quiet on config-only issues (by design — Path A owns them) and shows runtime
   issues when a gateway reports `lastError`.

## 8. Risks / gotchas

- **Fabricated-field trap** (project history): every hook signature above is
  dist-cited — re-grep on any doubt; no snapshot extension keys.
- **CLI-vs-gateway process** (§2.5): hooks read only their params.
- **Probe must never enroll** (§3.3) — the enrolled branch of
  `connectNatsCredentialSource` starts a device flow; the probe never calls it.
- **Setup-entry parity**: attach inside `createWebChannelPlugin` only.
- **Legacy WS entry** (`index.ts`) shares `createWebChannelPlugin` and will
  expose the NATS-centric doctor; accepted — the NATS entry is the shipped one
  and checks key off NATS-mode config.
- **`loadPersistedEnrolledCreds` fs reads** stay inside the checks that need
  them (C2/C3b), never at module load.
- **Probe cost**: fires only under `--probe`/health `doProbe`/Path B
  `probe:true` gates (verified §2.2).

## 9b. rev2 → rev3 disposition (codex adversarial round 2, 7 findings)

| # | Sev | Disposition |
|---|-----|-------------|
| 1 | MAJOR | §3.2 declared strictly behavior-preserving; exact inputs specified; impossible `nats.credentials.saasBaseUrl` test claim removed; auth-vs-credential base-URL divergence documented as fact (follow-up warn OUT) |
| 2 | MAJOR | `resolveDialMaterial` fully specified: discriminated union, 3-step algorithm, `persisted.natsUrl ?? source.url` precedence, test matrix |
| 3 | MAJOR | Gateway probe pipeline traced definitively (`channels-nLP6UG29.js:188-336`): probe attaches to snapshots AND failed-hook error copies into `lastError`; §3.4 rewritten with no conditional "verify later" |
| 4 | MAJOR | C3a fix text: remove ALL static signals (config + env) then enroll, or admission:"auto"; remediation-clears-finding test added |
| 5 | MAJOR | C4 via new exported side-effect-free `validateJwtVerifierConfig` shared with `makeJwtVerifier` — no JWKS-cache mutation from offline scans |
| 6 | MINOR | C10 narrowed to structured `detectOrphanedDefault`; env-deprecation split into new C11 with its own fix text (and no once-only-latch suppression) |
| 7 | MINOR | Four explicit zero-finding fixtures enumerated in §7 |

## 9. rev1 → rev2 disposition (codex adversarial review, 17 findings)

| # | Sev | Disposition |
|---|-----|-------------|
| 1–3 | BLOCKER/MAJOR | Snapshot-carrier design ABANDONED; §3.4 rewritten runtime-only; §2.2 command matrix added |
| 4 | MAJOR | §2.2 per-command matrix replaces the conflated claim |
| 5 | MAJOR | tsc-blind rationale removed (§3.2, §7); extraction re-justified as reuse/testability |
| 6 | MAJOR | C3 split → C3a (static register-hop unsupported, mirrors runtime) + C3b (enrolled, key missing) |
| 7 | MAJOR | C4 now calls the real `resolveVerifier` construction path in try/catch |
| 8 | MAJOR | New C9 `credential-source-invalid` |
| 9 | MAJOR | C8 contextual classification (a/b/c) |
| 10 | MAJOR | `resolveDialMaterial`, enrollment forbidden; probe never calls enrolled-branch connect |
| 11 | MAJOR | JWKS leg probes the EFFECTIVE source (url/file/inline) and reports which |
| 12 | MINOR | Probe claim reworded: relay authentication/connectivity only |
| 13 | MAJOR | `resolveEffectiveAccountAuth` (input resolution + fill), precedence test matrix |
| 14 | MINOR | New C10 `orphaned-default` (warn-sink routed into findings) |
| 15 | MINOR | C6 fix text corrected (`dmSecurity:"allowlist"` + `allowFrom`) |
| 16 | MINOR | Phase 1/Phase 2 delivery split (§1, §6) |
| 17 | NIT | Citations retained; call-path claims now per-surface |
