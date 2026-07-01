# WebChannel Setup Wizard — Design Plan

Status: **REVISED after sub-agent review (NEEDS_CHANGES → addressed).** Ready to implement pending user go-ahead.
Branch: `feature/webchannel-setup-wizard`
Backlog ref: [[webchannel-setup-wizard-backlog]] (user-flagged PRIORITY 2026-07-01)

## 1. Problem & goal

Onboarding a webchannel account today requires **hand-writing** the full
`channels.webchannel.accounts.<id>` block via `openclaw config patch` *before*
`openclaw channels add` (which only runs the device-flow enroll). Ground truth of
the hand-written block — `e2e/local/run-demo-synadia.sh:169-196`:

```json
{ "channels": { "webchannel": { "accounts": { "<id>": {
  "tenant": "default-tenant",
  "saas": { "baseUrl": "http://host.docker.internal:3951" },
  "auth": { "strategy": "jwt", "jwt": {
      "jwksUrl": "http://host.docker.internal:3951/.well-known/jwks.json",
      "issuer": "http://127.0.0.1:3951",
      "audience": "default-agent" } },
  "dmSecurity": "open",
  "nats": { "url": "wss://connect.ngs.global:443", "admission": "auto",
            "credentials": { "mode": "enrolled" } }
} } } } }
```

**Goal — eliminate hand-written config on BOTH entry points:**

- **Interactive** — bare `openclaw channels add` → pick webchannel → prompted for
  account id + tenant + saas.baseUrl → the wizard writes the full block.
- **Non-interactive** — `openclaw channels add --channel webchannel --account <id>
  --base-url <saas> --url <tenant>` → writes the same full block, scriptable.

> ⚠️ **Correction from review (was wrong in the first draft).** A `--flag`
> invocation does NOT run the declarative wizard: `shouldUseWizard =
> params.hasFlags === false` (`openclaw src/commands/channels/shared.ts:143-145`),
> and `--channel`/`--account` count as flags (`command-options.ts:4-9`,
> `channels-cli.ts:50-52`). So the wizard's `textInputs` fire ONLY under **bare**
> `channels add`. The `--flag` form must get the full block written by the setup
> adapter (`applyAccountConfig`), not the wizard. Hence the two-seam design in §5.

## 2. Root cause (verified in source)

- The plugin registers `setup: webchannelSetup` (**`ChannelSetupAdapter`**,
  `packages/plugin/src/channel.ts:128`, `src/setup.ts`). It drives the config
  WRITE + headless enroll — but `buildAccountPatch` writes only `tenant` +
  `saas.baseUrl` + `nats.credentials.mode` (`setup.ts:96-109`); the **auth block
  is never written**, so the operator supplies it by hand.
- There is **no `setupWizard`**, so bare `channels add` collects nothing for
  webchannel beyond the generic account-id step.

## 3. Contract (verified in openclaw source; review-corrected refs)

- **`ChannelSetupWizard`** — `openclaw src/channels/plugins/setup-wizard-types.ts:270-300`.
- **Declarative detection** requires exactly `"status" in x && "credentials" in x`
  — `openclaw src/commands/channel-setup/registry.ts:22-31` (NOT
  `channels/plugins/registry.ts` — first draft cited the wrong file). `credentials:
  []` is accepted (WhatsApp: `extensions/whatsapp/src/setup-surface.ts:65`).
- **`ChannelSetupWizardTextInput`** — `setup-wizard-types.ts:126-170`. Fields:
  `inputKey`, **`message`** (NOT `prompt`), `initialValue`, `currentValue`,
  `shouldPrompt`, `required`, `validate`, `normalizeValue`, `applySet`. So advanced
  inputs with derived defaults (issuer/audience) ARE supported.
- **Discovery is automatic** and needs **no core change**: `setupWizard` survives
  registration via spread — `normalizeRegisteredChannelPlugin` returns `{
  ...params.plugin, id, meta }` (`openclaw src/plugins/channel-validation.ts:112-120`);
  stored in `registry.channelSetups` (`registry.ts:1020-1027`); read back by
  `resolveChannelSetupWizardAdapterForPlugin(plugin)` (`commands/channel-setup/registry.ts:34-56`)
  via `listActiveChannelSetupPlugins()` (`setup-registry.ts:80-83`).

## 4. Field disposition

| Field | Disposition |
|---|---|
| `tenant` | **Prompt** (required; default `default-tenant`) |
| `saas.baseUrl` | **Prompt** (required; URL-validated) |
| `auth.jwt.audience` | **Derive** = resolved `accountId` (Q2). Advanced override. |
| `auth.jwt.issuer` | **Derive** default = `saas.baseUrl` (Q1). Advanced override. |
| `auth.jwt.jwksUrl` | **Derive** = `${saas.baseUrl}/.well-known/jwks.json` |
| `auth.strategy` | **Constant** `"jwt"` |
| `nats.credentials.mode` | **Constant** `"enrolled"` |
| `nats.admission` | **Constant** `"auto"` (Q4) |
| `dmSecurity` | **Constant** `"open"` for demo happy path — write EXPLICITLY (Q5) |
| `nats.url` | **Omit** — SaaS-delivered at enroll (Q3) |
| `nats.credentials.{userJwt,userSeed}` | SaaS-delivered at enroll (device flow) — never prompted |

The wizard writes the **full block above verbatim = the proven demo config.** Note
(Q4): under `admission=auto` the register-route verifier is not built, so the
`auth.jwt.*` block is *inert on the auto happy path*; it is written anyway because
(a) it reproduces the proven-working demo block and (b) it is load-bearing if the
account is later switched to `admission=register-hop`. Documented, not accidental.

## 5. Design (two seams, one pure writer)

1. **`packages/plugin/src/setup.ts` — add a pure `buildFullAccountPatch({tenant,
   saasBaseUrl, accountId, issuer?, audience?})`** returning the complete block
   (tenant, saas.baseUrl, auth.strategy=jwt, auth.jwt.{jwksUrl derived, issuer,
   audience}, nats.{admission=auto, credentials.mode=enrolled}, dmSecurity=open).
   **Keep `buildAccountPatch` (partial) unchanged** — it preserves the existing
   merge/partial-write semantics that `setup.test.ts:63-71,102-126` assert.
2. **Non-interactive seam — `applyAccountConfig`:** when `saasBaseUrl` is present in
   the input (the one-shot `--flag` call), write via `buildFullAccountPatch`,
   **merging** the `auth`/`nats` subtrees so a re-run never clobbers an operator's
   manual `auth.jwt.issuer/audience`. When `saasBaseUrl` is absent (e.g. the
   wizard's per-field `applySetupInput` calls, or a partial re-run), fall back to
   the existing partial `buildAccountPatch`. This guard is REQUIRED because in the
   wizard path each textInput without its own `applySet` funnels through
   `applySetupInput` → `applyAccountConfig` **one field at a time**
   (`openclaw src/channels/plugins/setup-wizard.ts:88-109`) — an unconditional
   full-block write would fire mid-wizard before `saasBaseUrl` is collected.
3. **Interactive seam — `packages/plugin/src/setup-wizard.ts`** exporting
   `webchannelSetupWizard: ChannelSetupWizard`:
   - `channel: WEBCHANNEL_ID`; `credentials: []`.
   - `status`: `resolveConfigured` = account has `auth.jwt` (or creds present);
     `resolveStatusLines` summarizing tenant/saas/account.
   - `textInputs`: `tenant`, `saasBaseUrl` (required + validated); advanced
     `issuer` (`initialValue` = collected saasBaseUrl) and `audience`
     (`initialValue` = resolved accountId). Give each a no-op/partial `applySet`
     so the per-field funnel does not write a broken block.
   - `finalize`: read the collected values + resolved `accountId`, then write the
     full block via `buildFullAccountPatch` (atomic — this is the real write for
     the interactive path). `audience`/`issuer` derived here from the resolved
     accountId / saasBaseUrl when not overridden.
   - `completionNote`: next steps (`agents bind` + `gateway run`).
4. **Attach `setupWizard` in `channel.ts` base options** — inside
   `createChannelPluginBase({...})` next to `setup:` (line ~128). Verified path:
   `CreateChannelPluginBaseOptions.setupWizard?` (`openclaw src/plugin-sdk/core.ts:502`)
   → forwarded at `core.ts:841` → spread onto the plugin at `core.ts:817-818`.
   WhatsApp/Slack precedent: `extensions/whatsapp/src/channel.ts:90`,
   `extensions/slack/src/channel.ts:549`. Unit test asserts the constructed plugin
   exposes `setupWizard`.
5. **`afterAccountConfigWritten` (enroll) unchanged** — now fed a
   wizard/flag-populated `saas.baseUrl`+`tenant`, so the old "no saas-base-url →
   cannot enroll" path no longer trips on the happy path.

## 6. Files to touch

- `packages/plugin/src/setup.ts` — add `buildFullAccountPatch`; guard
  `applyAccountConfig` (full when `saasBaseUrl` present + merge auth/nats, else
  partial).
- `packages/plugin/src/setup-wizard.ts` — NEW: `webchannelSetupWizard`.
- `packages/plugin/src/channel.ts` — attach `setupWizard` in base options.
- `packages/plugin/src/setup-wizard.test.ts` — NEW: full-block output ==
  ground-truth demo block; derivations (jwksUrl/issuer/audience); wizard is
  declarative-detectable (`status`+`credentials`); plugin exposes `setupWizard`;
  per-field funnel does not emit a broken partial.
- `packages/plugin/src/setup.test.ts` — extend for the guarded `applyAccountConfig`
  (full vs partial; auth-merge no-clobber).
- Follow-up (own commit): `docs/ONBOARDING_GUIDE.md` (replace config-patch step
  with `channels add`; also fixes stale §6 `/test/*` refs);
  `e2e/local/run-demo-synadia.sh` (drop the printed config-patch block; guide
  bare `channels add` or the full-flag form).

## 7. Open questions — resolved (with review evidence)

- **Q1 issuer** → prompt as advanced input, default `saas.baseUrl`. Docker demo
  needs the override (`iss` = SaaS's own URL `127.0.0.1`, ≠ container-dialed
  `host.docker.internal`). RESOLVED: advanced input, default saasBaseUrl.
- **Q2 audience** → derive = resolved `accountId` (`aud==accountId`,
  `bootstrap-claims.ts:96`); advanced override. In wizard mode there is no
  `--account` flag → take it from the wizard's resolved accountId in `finalize`.
- **Q3 nats.url** → OMIT. Precedence `persisted.natsUrl ?? source.url`
  (`consume-credentials.ts:95`); enroll uses `saasBaseUrl`, never `nats.url`. Caveat
  (documented): the resolver default `ws://127.0.0.1:4222`
  (`nats-credential-source.ts:134,237-241`) is dialed only if persisted natsUrl is
  absent (legacy creds) — never on a fresh enroll. RESOLVED: omit.
- **Q4 admission** → write `auto`. Core defaults enrolled+jwt to `register-hop`
  (`nats-admission.ts:67-77`), which is 404-broken on openclaw 2026.6.10; `auto`
  overrides it. Consequence acknowledged in §4: `auto` builds no verifier / no aud
  map (`admissionServingPlan`, `nats-admission.ts:93-116`) so `auth.jwt` is inert
  on the auto path — written anyway (demo-faithful + register-hop-ready).
- **Q5 dmSecurity** → write `"open"` EXPLICITLY. Review correction: omitting it does
  NOT default-deny — the runtime inbound gate `resolveDmAdmission` treats unset as
  OPEN (`dm-allowlist.ts:72-73`, docstring `:15-17`), while core's
  `security.dm.defaultPolicy` is `"allowlist"` (`channel.ts:158`). Two gates
  disagree. Writing an explicit value removes the ambiguity; `"open"` is
  demo-grade, NOT a safe production default (warn in the completionNote). **Also
  file the two-gate disagreement as a separate bug** (see §9).
- **Q6 DRY** → the two paths are mutually-exclusive triggers, not auto-converging;
  §5 wires both to the single `buildFullAccountPatch`.
- **Q7 attachment** → base options (`core.ts:502/841/817`). RESOLVED, test-covered.

## 8. Non-goals

- No change to device-flow enroll, NATS creds scoping, or the SaaS side.
- `index.ts` (dev-only) inherits the wizard via shared `channel.ts` — no separate
  work.
- Not building RBAC / per-subject NATS ACL.

## 9. Spun-off bug (file separately, do not fix here)

**DM admission two-gate disagreement:** core `security.dm.defaultPolicy:
"allowlist"` (default-deny intent, `channel.ts:153-159`) vs the plugin's own NATS
inbound gate `resolveDmAdmission` treating unset policy as OPEN
(`dm-allowlist.ts:72-73`). On the plugin-driven NATS inbound path the plugin's gate
wins, so an unset `dmSecurity` admits all — contradicting the core default. Latent
security-relevant inconsistency; track outside this feature.
