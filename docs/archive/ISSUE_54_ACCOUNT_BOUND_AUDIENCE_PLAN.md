# Issue #54 — account-bound JWT audience — Archived Implementation Plan (v11)

> Status: **IMPLEMENTED — historical design and review record.**
>
> PR #76 implemented this plan and merged into `develop` as
> `287b717a5ffa6f771ef4f9e54321a4a89c1197ea` on 2026-07-23 after its E2E gate
> passed. Issue #54 was closed as completed on 2026-07-24.
>
> This file preserves the final pre-implementation v11 convergence candidate
> and the decisions from its adversarial reviews. It is not an active work plan;
> future-tense implementation language below is historical. The merged code,
> current tests, `docs/AUTH.md`, and `CHANGELOG.md` are authoritative if they
> differ from this record.
>
> The plan was written against PR #39, merged into `develop` as
> `11bd90b0542cbe4201da075a1e8f791e74191a68` on 2026-07-22. Its reviewed feature
> head was `61486b042efadd5d833c6af0ddaf3456690e97e8`. The implementation subsequently
> integrated the account lifecycle changes that landed before PR #76.
>
> Product decision: WebChannel no longer supports a generic IdP audience shared
> by multiple logical accounts. Compatibility with the old configurable
> `auth.jwt.audience` surface is intentionally not preserved.

## 1. Outcome and acceptance contract

The fix makes the account authorization binding structural instead of trying to
detect every unsafe `(issuer, audience)` combination:

```text
authenticated target = (signed tenant, signed aud member)
runtime target       = (runtime tenant, runtime accountId)

admit iff:
  JWT signature verifies under the resolved issuer/JWKS
  AND issuer/time claims pass the existing checks
  AND JWT tenant === runtime tenant
  AND (JWT aud is runtime accountId
       OR JWT aud is an array containing runtime accountId)
  AND JWT sub === the subject peerId
```

That is the common token-and-subject gate, not the whole operation contract:

- `challenge` passes the common gate, then issues a single-use nonce for the
  verified peer id. It does not require `pop_jwk`, a PoP signature, or `cnf`.
- `register` passes the common gate, then applies the current resolved
  `requirePoP`/`pop_jwk` policy and nonce-signature verification. A `cnf` X25519
  device key remains mandatory for conversation-key delivery.
- `unregister` passes the common gate, then keeps today's token-only, no-reply
  teardown semantics until
  [#51](https://github.com/mir-stream/openclaw-webchannel/issues/51) is addressed.
  It does not gain nonce/PoP or `cnf` checks in issue #54.

The implementation is complete only when all of the following hold:

- **A1 — account-bound verification.** The common verifier used by challenge,
  register, and unregister is constructed with one immutable runtime
  `accountId`; no operator config can supply or replace its expected audience.
  Operation-specific gates then run exactly as described above.
- **A2 — tenant-bound verification.** A bootstrap JWT must carry a non-empty
  signed `tenant` claim exactly equal to the runtime tenant. Missing tenant is no
  longer accepted as a legacy fallback.
- **A3 — no configurable audience.** `auth.jwt.audience` is a removed setting.
  Its presence is deterministic and actionable even when its value happens to
  equal the account id: an enabled account gets a migration error, while a
  disabled account gets the non-serving Doctor warning defined by A13.
- **A4 — pre-I/O failure.** All account auth plans are prepared before any NATS
  connect, subscription, channel creation, key/history access, or readiness-report
  emission. An account with a removed audience key never performs those
  operations. If a prepared account later fails while starting, every resource
  acquired by that attempt is rolled back, no runtime entry remains, and no
  success/Gate-B readiness report is emitted for that failed attempt.
- **A5 — failure isolation.** Invalid accounts are skipped; accounts whose auth
  plans are valid continue to start. A channel-level audience inherited by N
  enabled named accounts invalidates all N deterministically; disabled accounts
  remain runtime-dormant and are reported only by Doctor. One account's start or
  cleanup failure cannot leave it partially serving or prevent a healthy sibling
  from starting.
- **A6 — same issuer is normal.** Any number of accounts may use the same SaaS
  issuer/JWKS. Their verifier bindings differ by runtime account id.
- **A7 — authentication is topology-independent.** Accounts A and B remain
  isolated by the bound common verifier when hosted in one process or different
  processes. No process-global collision registry or cross-process coordination
  is required for authentication. This does not claim that today's bare-account
  local storage is safe for every cross-tenant topology; see #71 and §10.
- **A8 — multi-audience remains supported without ambiguous targeting.** A token
  with `aud: [A, B]` authorizes A and B in the one signed tenant, but each
  concrete client connection still selects exactly one runtime target and uses
  that target account's separately authenticated agent key pin. A token with
  `aud: A` may register only against A. First-party deployable/session issuance
  stays scalar in issue #54.
- **A9 — no key/history leakage.** A token for A sent to B's register subject is
  rejected before peer registration, key wrapping, history snapshot, or approval
  snapshot side effects.
- **A10 — one JWT account source.** New bootstrap JWTs contain `aud` as the sole
  account-authorization claim. The unused duplicate top-level JWT `accountId`
  claim is removed.
- **A11 — diagnosable rollout.** Startup, doctor, setup preflight, manifest help,
  onboarding docs, demo config, and release notes all describe the same contract:
  remove `auth.jwt.audience`; the expected audience is the account id.
- **A12 — register PoP behavior preserved.** Account-bound preparation resolves
  `requirePoP` once and passes it immutably to the handler. The default remains
  `true`; an explicit `false` retains the existing legacy optional-PoP register
  behavior. Challenge remains nonce issuance after the common gate, and
  unregister remains token-only/no-reply pending #51.
- **A13 — lifecycle semantics preserved.** For the new audience tombstone,
  disabled accounts do no acquisition, migration, credential, verifier, network,
  channel, history, or readiness work at runtime. Status also excludes them. An
  explicit Doctor audit reports the tombstone as a non-serving migration warning
  so it can be fixed before re-enable, without claiming the account is currently
  exposed. Existing removed-setting checks remain intact, and the coordinator's
  account-scoped failure isolation is generalized to cover them.
- **A14 — once-only runtime composition preserved.** Concurrent or repeated
  `registerFull` calls share one build result and never acquire account resources
  twice. After that build settles successfully, if any runtime committed the lazy
  core transport binds exactly once to committed `default`, otherwise the first
  committed runtime in deterministic account order; failed/uncommitted
  candidates can neither become primary nor disturb an existing primary.
- **A15 — one releasable breaking version.** The plugin, client, and SaaS package
  manifests and their workspace entries in `package-lock.json` move together to
  one unpublished minor version, and the release tag is exactly `v<version>`.
  On the reviewed `0.2.0` baseline this means `0.3.0`; if the required rebase has
  already consumed that version, use the next unpublished minor instead. No
  partial manifest bump, stale lockfile, patch release, or tag/package mismatch
  is an acceptable issue #54 release state.

This satisfies issue #54 through its accepted alternative: require and verify a
cryptographically authenticated account authorization. The former
collision-group skip was the correct fallback while audience remained
configurable. Once a valid runtime cannot express `audience != accountId`, a
shared-audience group cannot exist among distinct valid account ids and the
collision map is unnecessary.

## 2. Background and current failure

The register request is routed by the NATS subject:

```text
webchannel.<tenant>.<accountId>.<peerId>.register
```

Browser credentials intentionally permit the authenticated peer to use an
account wildcard inside its tenant:

```text
webchannel.<tenant>.*.<peerId>.>
```

Today each account verifier reads its expected audience from
`auth.jwt.audience`. If two accounts share issuer and audience, the same signed
token verifies on either subject. The second account can then wrap its own
conversation key and send its own history to a peer authenticated for the first
account. `packages/plugin/index-nats.ts` detects this after connecting the
account but only warns and serves both.

The configurable audience predates the SaaS/register-hop protocol. It came from
the original generic Auth0/Clerk/Keycloak model, in which `aud` named an API or
client shared by many resources. The current SaaS protocol already has a
different contract:

- `buildBootstrapClaims({ accountId })` writes that id, or its account-id array,
  into signed `aud`;
- runtime derivation defaults expected audience to the account id;
- `channels add` preflight treats a different configured audience as an error;
- `(tenant, accountId)` is the wire/logical agent identity.

Keeping the generic override therefore preserves an invalid state rather than a
supported deployment mode.

## 3. Fixed product decisions

These are inputs to implementation and are not open questions for review:

1. The bootstrap JWT issuer is a trusted WebChannel SaaS issuer. One issuer and
   one JWKS may serve many tenants and accounts.
2. `accountId` is WebChannel's account wire identity, not a freely renamed local
   alias like a Telegram account label.
3. JWT `aud` is the signed set of WebChannel account ids that the browser may
   reach. It is not a generic `webchannel-api` service audience.
4. Every member of a multi-aud token is an explicit signed account authorization
   inside one signed tenant. The array is an authorization set, not a route,
   target selection, or set of interchangeable agent-key pins, and it does not
   authorize the same account ids in another tenant. Each connection selects one
   target account, verifies that target is an `aud` member, and authenticates K
   with that target account's single pin.
5. Generic/shared-audience IdP compatibility may break. There is no deprecation
   period requiring continued service.
6. A removed audience key must fail loudly; it must never be silently ignored or
   rewritten.
7. Valid unrelated accounts continue serving when another account is invalid.
8. The low-level JWT verifier remains RFC-compatible with scalar and array `aud`.
   Only the operator-facing source of the expected value is removed.

An issuer/JWKS operator pin, if retained for a proxy or custom issuer, does not
restore generic-audience semantics: that issuer must still mint account-scoped
`aud` and the plugin always verifies against the runtime account id.

## 4. Identity and topology semantics

| Configuration | Result after this change |
|---|---|
| Same tenant, A and B, one process | Each token is checked against A or B respectively; cross-subject use fails. |
| Same tenant, A and B, different processes | Same result; each process closes over its own runtime id. |
| Same `(tenant, accountId)` on multiple processes | Same logical account/HA identity; accepting the same token population is intentional. Existing HA key/state rules are unchanged. |
| Different tenants, same account id | The authentication protocol allows it only when signed tenant matches. Until #71 lands, processes sharing one storage root must instead use globally unique account ids or separate storage roots. |
| `aud: [A, B]`, signed tenant T | Separate T/A and T/B connections may be accepted; each uses its own target-specific agent pin. Rejected by every other account or tenant. |
| Any explicit `auth.jwt.audience` | Every enabled account in that raw setting's scope is rejected before NATS/provider I/O. |
| Channel-level audience beside named accounts | Every enabled named account is rejected even if its own `auth.jwt` object would shadow the base during the current shallow merge. |
| Disabled account with a removed audience | Runtime and status ignore it with zero migration/I/O work; an explicit Doctor audit emits a disabled-account migration warning for future re-enable. |

The SaaS authorization decision that precedes minting must use the same resource
identity: a user is authorized for `(tenant, accountId)`, not for a bare account
string while accepting a client-selected tenant.

## 5. Design

### 5.1 Remove audience from the operator auth model

`packages/plugin/src/auth.ts` separates three layers that are currently conflated:

- **JWT trust config:** issuer, exactly one JWKS source, and clock skew. These
  describe how to authenticate the trusted SaaS signature.
- **Admission policy:** the resolved `requirePoP` boolean.
- **Account authorization target:** the runtime `accountId`. This is supplied by
  the account plan and is never read from config.

Make the boundary visible in types rather than relying on comments:

```ts
type RawJwtAuthConfig = {
  strategy?: unknown;
  requirePoP?: unknown;
  jwt?: unknown; // runtime parser narrows supported fields; no active audience type
};

type ResolvedJwksSource =
  | { kind: "url"; jwksUrl: string; jwksFile?: never; jwks?: never }
  | { kind: "file"; jwksFile: string; jwksUrl?: never; jwks?: never }
  | { kind: "inline"; jwks: JsonWebKeySet; jwksUrl?: never; jwksFile?: never };

type ResolvedJwtVerifierConfig = {
  strategy: "jwt";
  jwt: {
    issuer: string;
    clockSkew: number;
    // still no audience or test dependency field
  } & ResolvedJwksSource;
};
```

Exact exported names may follow project conventions, but raw operator input and
resolved verifier input must be distinct. `JwtAuthConfig.jwt.audience` is removed
from both contracts. A TypeScript cast is not validation: flat input and
unvalidated named-account leaves both enter the same cache-free runtime parser as
`unknown`. Before cache construction, that parser must:

- require `strategy === "jwt"` and a non-empty string issuer;
- require exactly one JWKS source using the discriminated union above: URL and
  file values are non-empty strings, while inline JWKS is a non-null plain object
  (not an array) with a `keys` array;
- resolve absent `clockSkew` to the existing 60 seconds and otherwise accept only
  a finite, non-negative integer;
- resolve absent `requirePoP` to `true`, accept only literal booleans, and reject
  `null`, strings, numbers (including `0`), arrays, and objects.

It returns `ResolvedJwtVerifierConfig` plus the resolved boolean PoP policy. No
cast may reintroduce audience, a second key source, or an unvalidated policy.
Structurally valid `jwks: { keys: [] }` is deliberately not rejected here: the
existing Gate B reports an unusable zero-key source and keeps registration
fail-closed. Likewise URL fetching and file reading/content parsing remain Gate B
I/O after all account plans are prepared. The preparation promise is limited to
construction-time structure; it does not claim network or file contents are
usable.

The manifest keeps `auth.jwt.audience` only as a **removed-key tombstone**, using
the existing `auth.ticketParam` migration pattern but deliberately broadening the
tombstone's schema shape. Its JSON Schema property is an unconstrained `{}` with
description/UI text only: it has no `type`, `enum`, or default. That allows every
legacy or malformed JSON value to pass host schema parsing and reach one targeted
migration diagnostic. This is different from the current named-account leaf
behavior: named leaves are already structurally unvalidated, while the flat/default
leaf is strictly validated by the manifest. A `type: "string"` tombstone would
therefore make `null`, numbers, objects, and arrays fail opaquely only in the flat
shape and is not acceptable.

The `auth.jwt.required` issuer+audience pair is removed, resolving #65 in favor
of this new contract: issuer may remain an independent optional pin; audience may
not be pinned. The schema description and UI hint say that audience is removed,
must be deleted, and is never a verifier value.

Detection is intentionally performed on **raw locations before effective auth
merge**. The current account merge shallow-merges `auth`, so a named account's
own `auth.jwt` object can replace the channel-base `auth.jwt` object and hide a
base audience from a merged-value-only check. Add one cache-free helper that
returns exact raw paths using `Object.prototype.hasOwnProperty.call(jwt,
"audience")`, plus a shared assertion that throws a typed
`RemovedAudienceConfigError` carrying the account id and path list:

- `channels.webchannel.auth.jwt.audience` scopes to every configured account; a
  channel-base occurrence invalidates every enabled account, including a named
  account whose own `auth.jwt` shadows it;
- `channels.webchannel.accounts.<id>.auth.jwt.audience` scopes only to that named
  account;
- in the flat/no-accounts shape, the channel-level path scopes to the implicit
  `default` account.

`planWebchannelAccount` is the central enabled-entrypoint: immediately after its
existing enabled check returns false/continues, it calls this helper **before**
acquisition identity resolution or effective config merge. Consequently startup,
bulk `planAccounts`, enabled Doctor evaluation, and status probe all receive the
same targeted failure without each remembering a separate precheck. Effective
merge is computed separately for supported fields only after the scan succeeds.
Callers recognize the typed error rather than parsing its text: startup logs its
actionable message, Doctor maps it to `audience-override-removed`, and probe
returns the same targeted message in `ok: false`.

There are two intentional direct callers. Doctor calls the helper directly only
for disabled account ids to emit the non-serving warning, then performs no other
resolution for those ids. Setup/add-time preflight calls it directly because it
operates before a serving plan exists. No other runtime/status path scans outside
`planWebchannelAccount`.

Do not add this tombstone to the existing unconditional
`assertNoRemovedConfig(resolved)` path: `channel.resolveAccount` may resolve a
disabled account for lifecycle display, which would turn the chosen Doctor-only
warning into a status/runtime throw. The scoped raw scanner owns audience
migration policy; the existing assertion keeps ownership of its existing removed
settings.
String, empty string, `null`, number, boolean, object, array, and a value equal to
`accountId` all produce the same removed-key diagnostic, which names the raw
path. Programmatic setup input carrying the legacy property is rejected; it is
never silently ignored or stripped.

### 5.2 Account-bound verifier factory

Keep `verifyJwt` in `packages/plugin/src/jwt.ts` generic. Its internal option for
the expected audience remains, as do the constant-time scalar/array membership
checks.

Add an account-bound factory in `packages/plugin/src/auth.ts`, conceptually:

```ts
type VerifyAccountToken = (token: string) => Promise<JwtIdentity | null>;
type VerifierFactoryDeps = {
  fetchImpl?: typeof fetch;
  readFileImpl?: (path: string) => Promise<Uint8Array>;
}; // runtime adapter/tests, never operator config

createAccountJwtVerifier({
  auth,             // ResolvedJwtVerifierConfig; issuer/JWKS/clock-skew only
  accountId,        // immutable expected aud member
  logger,
}, deps?: VerifierFactoryDeps): VerifyAccountToken
```

The factory accepts only a cache-free-validated `ResolvedJwtVerifierConfig`; raw
config cannot cross this boundary. The returned closure invokes the low-level
verifier with `audience: accountId`. Only after validation does construction
initialize the existing per-resolved-auth JWKS cache, without a network request.
Move the current `_fetchImpl` test escape hatch out of production auth config and
into `VerifierFactoryDeps`; neither raw nor resolved operator state may carry a
fetch function.

Preserve error classification through the new closure:

```text
JWKS unavailable -> JwksUnavailableError -> TransientVerifyError
ordinary bad token/claim/signature -> null
```

Challenge/register keep mapping the transient class to opaque retryable 503 and
ordinary invalidity to opaque 401. Unregister keeps swallowing either outcome as
a logged, no-reply no-op. Tests cover the mapping so the factory refactor cannot
collapse infrastructure failure into terminal authentication failure or vice
versa.

The low-level audience parser remains compatible with either a string or an
array of strings. It fails closed if `aud` is missing, is any other scalar/object,
or is an array containing any non-string element; it must not filter malformed
members and accept the remaining strings. A valid all-string array succeeds only
when it contains the bound account id.

`verifyJwtAndExtractIdentity` either becomes the factory's private worker or
requires `expectedAccountId` as a mandatory argument. No exported production
entry point may infer the expected audience from `AuthConfig`.

This mirrors the official channel pattern: Telegram/Discord create a provider
client from one credential and close over one local account context. A caller
cannot later pair the credential with a different account selector.

### 5.3 Deterministic per-account preparation before serving I/O

Retain PR #39's `planWebchannelAccount` as the one-account structural planning
seam and its shared `isWebchannelAccountEnabled` predicate. Add an importable,
dependency-injected startup module at `packages/plugin/src/account-startup.ts`;
do not bury the phase machine inside the side-effectful, tsc-blind
`registerFull`. Do **not** call bulk `planAccounts` from this coordinator: one
malformed effective config currently throws from account resolution and can abort
planning before valid siblings are seen.

The first layer, `coordinateAccountStartup`, performs these phases in sorted
account-id order:

1. Enumerate with `listWebchannelAccountIds` and run the existing orphaned-default
   warning once.
2. Call `planWebchannelAccount` for every sorted id inside its own `try/catch`.
   Its first branch omits disabled accounts; its next action is the audience
   tombstone scan; only then does it perform acquisition/effective resolution and
   all existing removed-setting validation (`auth.ticketParam`, anonymous auth,
   `nats.devOpen`, auto admission, and open credentials). Store throws as
   structured `{ accountId, phase: "account-plan", error }` entries rather than
   aborting the sibling loop.
3. For each surviving structural plan, call an account-auth preparation seam in
   its own `try/catch`; store `{ accountId, phase: "auth-plan", error }` on
   failure and retain valid prepared entries.
4. After the entire planning/preparation pass, emit all preparation failures once
   in the same deterministic account order. Only then pass valid prepared
   entries, in sorted order, to the injected serving function.

Bulk `planAccounts`, Doctor, and status probe keep calling
`planWebchannelAccount`, so they inherit the same enabled/tombstone ordering even
though the startup module owns the surrounding per-id failure accumulator.

The module exposes a conceptual contract like this (exact names may follow local
conventions):

```ts
type AccountStartupPhase = "account-plan" | "auth-plan" | "start";

type AccountStartupFailure = {
  readonly accountId: string;
  readonly phase: AccountStartupPhase;
  readonly error: unknown;
};

type PreparedAccountStartup = {
  readonly accountId: string;
  readonly plan: AccountServePlan;
  readonly auth: PreparedAccountAuth;
  readonly getPersisted: MemoizedPersistedAccessor;
};

coordinateAccountStartup({
  listAccountIds,
  planAccount,
  prepareAuth,
  createPersistedAccessor,
  emitFailure,
  startPreparedAccount,
  servingDeps,
}): Promise<void>;

startPreparedAccount(
  prepared: PreparedAccountStartup,
  servingDeps: AccountServingDeps,
): Promise<void>;
```

`coordinateAccountStartup` alone may enumerate, plan, cache-free prepare auth,
create/reuse the lazy persisted-record accessor, collect structured failures, and
emit them. Before the complete preparation/failure-emission barrier, its only
allowed non-pure action is a memoized local persisted-enrollment metadata read
when issuer derivation requires it. A `PreparedAccountStartup` is constructed only
after both planning phases succeed, so an invalid account cannot reach
`startPreparedAccount` by type or control flow.

The second layer is the injected, importable
`startPreparedAccount(prepared, servingDeps)` implemented in
`packages/plugin/src/account-serving.ts`. It owns **every** serving action:
credential consumption, dial-material resolution, NATS transport/connect,
JWKS Gate B warm/read/fetch, `NatsChannel` plus conversation-key/history/approval
store construction, register-subscription installation, runtime publication, and
readiness-report emission. Keeping the production transaction in `src/` makes its
rollback and activation behavior type-checked and directly testable;
`registerFull` remains only the adapter composition root.

Starting one account is a transaction, not a sequence of `continue` sites. Until
commit, the transport, channel, stores, handlers, subscriptions, and computed
readiness exist only in an account-local attempt. Immediately after each
resource is acquired, the attempt records an idempotent disposer. A connected
transport always records `disconnect()` as the final fallback; that call must
clear every active subscription and cancel reconnect backoff. If a channel owns
resources that transport disconnect does not cover, expose a narrow idempotent
channel disposer or the subscription ids needed to release them rather than
leaving an untracked listener/subscription. In particular, the current
"connected but missing attested identity key" path is a start failure that runs
the transport cleanup; it may not skip while leaving auto-reconnect alive.
Any dependency that throws before returning its resource/disposer owns cleanup
of its own partial acquisition; the real static and enrolled NATS connectors,
not only fake factories, satisfy that contract under §6/§7.1.

The order is security-relevant. After transport connection and attested identity
validation, perform JWKS Gate B warm/read/fetch and classify its report **before**
installing any externally reachable register subscription. Only then construct
the remaining channel/store/handler state needed for activation. A structurally
valid but unreachable/empty JWKS keeps PR #39's existing fail-closed retryable
serving semantics and yields a `FAIL` report; it is a classified Gate B result,
not an unexpected thrown start failure.

The final activation is one synchronous, no-`await` critical section:

1. Configure the register handler with an account-local `armed === false` guard.
   Before arming it sends no reply and performs no nonce, peer, key, history,
   approval, or readiness effect.
2. Install the register subscription and retain its idempotent unsubscribe
   handle. `NatsChannel.subscribeRegister` (or a narrow replacement) must return
   that handle instead of discarding the subscription id.
3. Invoke a synchronous `commitRuntime(accountId, candidateRuntime)` adapter that
   publishes the one complete `AccountRuntime` map entry. It refuses to overwrite
   a pre-existing non-identical runtime.
4. Set `armed = true`. Only from this point may the subscription dispatch a
   challenge/register/unregister operation.
5. Emit the already-computed readiness report through a caught, non-throwing sink.

Production WebSocket events cannot interleave between these synchronous steps,
but the `armed` guard is still mandatory and is tested with a transport that
delivers re-entrantly from `subscribe`. The cleanup stack registers idempotent
`unpublishRuntime(accountId, candidateRuntime)` **before** invoking the commit
adapter. That rollback performs compare-and-delete only when the current map
value is the exact candidate object; it cannot remove or replace a healthy runtime
owned by an earlier attempt. Thus even an injected commit that mutates and then
throws cannot leave its partial map entry or make the failed candidate eligible
as the primary channel. There is deliberately no new readiness map in issue #54:
PR #39's readiness is an immutable `AccountReadinessReport` plus an operator log
line. A failed activation emits its structured `phase: "start"` diagnostic
instead; a successful activation emits the precomputed Gate B report exactly
once. Logger failure is contained and does not roll back a committed runtime.

On any unexpected error before or during commit,
`startPreparedAccount` first disarms dispatch and removes any partial runtime
publication, then executes every registered disposer in reverse acquisition
order, including subscription/channel cleanup and transport disconnect. It
attempts all cleanup steps even when one fails, retains the original start error
as primary, attaches or logs cleanup errors with the same account id, and only
then rejects. The coordinator reports that as one structured `phase: "start"`
failure and proceeds to the next prepared sibling. A failed account therefore
has no runtime-map entry, primary binding, emitted success/Gate-B report, live
subscription, connected/reconnecting transport, or retained serving resource.

`registerFull` supplies production implementations for the coordinator,
transactional serving dependencies, runtime commit/unpublish adapters,
non-throwing readiness sink, and cleanup diagnostics, then delegates. It does not
re-plan an account, re-resolve auth, or perform serving actions above the complete
preparation and deterministic failure-emission barrier.

An importable outer lifecycle in `packages/plugin/src/account-lifecycle.ts` owns
the entrypoint's once-only behavior. Its first `ensureAccountsStarted()` call
creates and stores one build promise around the full coordinator plus post-build
composition; concurrent and later calls return/await that exact promise rather
than enumerating, planning, connecting, subscribing, installing keep-alive, or
logging a second summary. The first call's production dependencies are the only
ones captured. If an unexpected coordinator-level error rejects the promise, the
rejection remains memoized and later calls do not start a second resource graph;
ordinary account-scoped failures are already contained by the coordinator.

Only after the coordinator has finished does the lifecycle read the committed
runtime map and choose the lazy core transport's primary: committed `default`
wins; otherwise choose the lowest account id in deterministic sorted order; if
none committed, leave `boundChannel` null and emit the existing “0 serving”
summary. It calls the synchronous, non-throwing injected
`bindPrimary(channel)` at most once, never for a failed/unarmed candidate. The
successful build then installs keep-alive and emits the serving-count summary
once; host keep-alive/logging errors are contained and do not reject or rebuild
committed runtimes. Repeated/concurrent registration cannot rebind an existing
primary. The per-account approval resolver continues reading the committed
runtime map directly, while core-initiated untargeted sends continue through this
preserved lazy primary facade.

The auth seam lives most naturally in `packages/plugin/src/account-auth.ts`:

```ts
type PreparedAccountAuth = {
  auth: ResolvedJwtVerifierConfig;
  verifyIdentity: VerifyAccountToken;
  requirePoP: boolean;
};

prepareAccountAuth({ plan, getPersisted }, verifierDeps?)
  -> PreparedAccountAuth // caller catches and records account-scoped errors
```

Here `plan` is the `AccountServePlan` returned by
`planWebchannelAccount`; preparation reads `account.auth`, `saasBaseUrl`, and
`accountId` from that object rather than accepting a parallel raw-config path.
`getPersisted` is a caller-owned memoized accessor shared with later credential/
dial resolution. Preparation calls it only when a delivered issuer is actually
needed; an explicit issuer therefore performs zero persisted loads, while a
derived path loads at most once.

Its contract is required:

1. Accept only an `AccountServePlan` produced by the centralized planning seam;
   no manual/no-`saas.baseUrl` path can bypass the scanner by passing raw config
   directly.
2. Derive/deliver issuer and JWKS exactly as today; produce a resolved auth value
   with no audience field.
3. Runtime-validate the raw unknown values and construct the exact-one
   `ResolvedJwksSource`; resolve `clockSkew` (`undefined -> 60`) and `requirePoP`
   (`undefined -> true`) under §5.1's strict type rules.
4. Bind the verifier to `accountId` only after that cache-free validation and
   return immutable prepared values.

Do not describe the coordinator's preparation stage as pure: issuer resolution
may synchronously read already-persisted enrollment metadata through the shared
lazy accessor. It is nevertheless a strict
**pre-serving-I/O** barrier: no NATS/HTTP/JWKS network request, credential
consumption or transport creation, `NatsChannel`/subscription construction,
conversation-key or history access, approval snapshot, runtime publication, or
readiness-report emission occurs until every enabled account has been attempted
and every failure logged. The existing `planWebchannelAccount` portion remains
pure.

This moves construction-time auth structure validation ahead of credential
consumption and the NATS connection. For example, an inline `jwks: {}` is not a
valid `ResolvedJwksSource`: that account never becomes a
`PreparedAccountStartup` and is skipped before cache creation, credential
consumption, NATS/channel/store/subscription/runtime work, or readiness-report
emission, while a valid sibling continues. By contrast `{ keys: [] }`, URL
reachability, and file contents retain the Gate B behavior owned by
`startPreparedAccount` as defined in §5.1 rather than being mislabeled as pure
preparation.

### 5.4 Register handler consumes a bound verifier

`RegisterHandlerDeps` in `packages/plugin/src/nats-register.ts` no longer accepts
both a mutable `auth` object and a two-argument `verifyIdentity(jwt, auth)` seam.
It receives a token-only account-bound verifier and the already-resolved PoP
policy:

```ts
verifyIdentity(token): Promise<JwtIdentity | null>
requirePoP: boolean
```

The production startup adapter wired by `index-nats.ts` passes both immutable
values from `PreparedAccountStartup.auth`.
`nats-register.ts` uses `deps.requirePoP`; it must not infer a default after the
auth object is removed. This preserves both the secure default and an explicit
legacy opt-out.

Challenge, register, and unregister use the same immutable issuer, JWKS cache,
account id, and common tenant/sub rules, then deliberately diverge:

| Operation | Post-common-gate behavior | Failure/reply behavior |
|---|---|---|
| `challenge` | Issue a single-use nonce for verified `sub`; do not require `pop_jwk`/signature/`cnf`. | Invalid token/scope is opaque 401; transient JWKS failure is 503. |
| `register` | If resolved `requirePoP` is true, require `pop_jwk`; whenever `pop_jwk` is present, require and verify its single-use nonce signature. Always require valid X25519 `cnf` for K delivery before peer/key/history/approval effects. | Invalid token, PoP, or `cnf` is opaque 401; transient JWKS failure is 503. |
| `unregister` | Call `unregisterPeer` only after the common JWT/tenant/subject-`sub` gate. Do not require nonce, PoP, or `cnf`. | Preserve the current no-reply success and silent/logged no-op on every failure. |

The unregister replay weakness is pre-existing and tracked by
[#51](https://github.com/mir-stream/openclaw-webchannel/issues/51). Adding a
nonce/MAC here would be a separate wire-protocol and client change, so issue #54
must neither silently implement it nor claim that register's PoP protects
unregister.

`AccountRuntime.auth` is removed if it remains write-only after this refactor.
The runtime may retain the prepared verifier/JWKS config only where an actual
consumer needs it; no duplicate auth object is kept as misleading state.

### 5.5 Require the signed tenant

Replace the current “missing legacy tenant is accepted” rule with exact matching:

```ts
identity.tenant === runtimeTenant
```

Missing, empty, or different tenant fails challenge/register with the same opaque
unauthorized reply and makes unregister a no-op, preserving the no-oracle
contract. Diagnostic logs may distinguish missing from mismatch locally.

This is necessary because account ids may repeat across tenants and the NATS
relay is explicitly untrusted. NATS credential scoping remains defense in depth;
it is not a substitute for signed `(tenant, accountId)` authorization.

### 5.6 SaaS minting contract and duplicate claim removal

`packages/saas/src/bootstrap-claims.ts` continues accepting one account id or an
array of authorized account ids and writes them to `aud`. It additionally:

- validates `tenant` as a non-empty NATS subject token;
- documents that every `aud` element belongs to that one tenant;
- stops emitting the duplicate top-level `accountId` claim;
- removes that property from the exported `BootstrapClaims` type.

The old top-level claim is not read anywhere in routing or verification. Old
tokens carrying the extra property remain accepted because JWT verifiers ignore
unknown claims; old plugins likewise ignore its absence. The API/output type
change is intentionally breaking and is called out in release notes.

**Primitive versus authorization boundary**

`buildBootstrapClaims` and `createBootstrapIssuer` remain policy-free claim and
signing primitives. They validate/construct claims and sign bytes; they do not
authenticate an HTTP principal, authorize a tenant/account tuple, select a
connection target, or choose an agent key pin. Every HTTP caller owns those
decisions before invoking either primitive. A unit test of either helper is
therefore never evidence that a route has performed authentication or
authorization, and generic JWT signing helpers are not treated as auth gates.

**One target and one authenticated pin per connection**

An `aud` array is the signed authorization set for one tenant. It is not a
target-account field and is not an agent-key-pin set. Every concrete client
connection has exactly one runtime target `(tenant, targetAccountId)`, requires
`targetAccountId` to be a member of the JWT audience, and receives/authenticates
exactly the active `agentPublicKey` registered for that target tuple. The client
must never reuse A's pin to authenticate B's wrapped K.

All first-party deployable/session routes issue a scalar `aud` in issue #54 and
return the one pin for that same scalar target, so their bootstrap response is
unambiguous. A custom issuer that deliberately exposes multi-aud issuance must
authorize every `(tenant, audMember)` and, under a separately authenticated
single-target request context, retrieve only that target's registry pin. It may
not infer the target from array order, return a caller-chosen unrelated pin, or
return one response that purports to connect to multiple accounts. Low-level
direct-signer tests may mint one `aud: [A, B]` token, but they construct separate
A and B client fixtures with independently registered pins. Because one JWT
carries one `cnf` and one optional `pop_jwk`, those fixtures reuse the same
token-bound X25519/Ed25519 device keys; only the target account and its
authenticated agent pin differ.

Inventory and classify every first-party/reference issuance surface and every
consumer whose request/response contract changes here, instead of treating a
helper or test forgery endpoint as an authorization example.

**Deployable/session-authorized paths**

- `demo/saas-server.ts` is the deployable demo issuer. Its session `/bootstrap`
  pins `DEMO_TENANT`, derives `peerId` from the authenticated session, accepts
  one scalar account, checks the principal's authorization for that account in
  the server tenant, and loads the pin from
  `(DEMO_TENANT, accountId)` before returning it.
- `packages/saas/reference/enrollment-server.ts` keeps its session-gated
  `/bootstrap` route and separately gated test route. The session route derives
  `peerId` from the authenticated session, rejects `tenant !== DEMO_TENANT`,
  accepts only a scalar account, authorizes
  `(DEMO_TENANT, accountId)`, and returns that tuple's registry pin.
- `examples/webchannel-app/server/index.ts` is a canonical deployable example.
  Its session `/bootstrap` pins `TENANT`, derives the principal/peer from the
  session, allows only its scalar `ACCOUNT_ID` after `canAccess`, and returns the
  active pin from `(TENANT, ACCOUNT_ID)`. Its tests and prose must demonstrate
  that contract rather than caller-directed issuance.
- Integrator documentation requires a multi-tenant `canAccess` implementation to
  evaluate `(user, tenant, accountId)`. For array input it must authorize every
  pair and reject the request rather than filter unauthorized members; custom
  multi-aud support must still use the single-target pin contract above.

No deployable route may combine authentication for a bare account with a
caller-selected tenant. Tests decode their tokens and assert the signed tuple came
from server authorization/config, not request data, and that the returned pin
came from the same tuple.

The corresponding deployable consumers remain single-target callers:
`demo/web/src/widget.ts`, `packages/client/src/browser-demo-entry.ts`, and
`examples/webchannel-app/web/app.ts` send one session/config-selected account and
construct the client with that same target and returned pin. The standalone
`packages/client/src/browser-jwt-entry.ts` contract changes as described below.
`demo/chaos-nats.ts`, `demo/verify-evict.mjs`, `e2e/local/*`, and example smoke
drivers are classified as harness consumers; they may exercise negative/test
routes only under the gates defined here and are not authorization evidence.

`demo/README.md` is an active runbook for that deployable demo and must describe
the same scalar contract. Its fleet UI may obtain a list of grants from `/me`,
but selecting/connecting each tab performs a separate authorized scalar
bootstrap request and receives only that target's pin. Remove the current claims
that the complete grant list becomes one JWT `aud` array or that one bootstrap
response supplies a multi-account rendezvous/pin map.

`docs/DEMO_PLAN.md` is linked from that runbook as the full design, so leaving its
Phase 2 multi-aud bootstrap/rendezvous-map proposal unqualified would make it
look current. Add a prominent superseding implementation note that points to
this issue #54 contract and marks the grant-list-as-`aud`, multi-account response,
and future `accountId -> agentPublicKey` map passages obsolete. Preserve the rest
as historical planning context rather than silently rewriting its chronology.

Two other top-level plans need the same explicit boundary because their status
labels make them look authoritative rather than archived:

- `docs/SETUP_WIZARD_PLAN.md` receives a prominent issue #54 note stating that
  every audience prompt, advanced override, writer parameter, preservation rule,
  and emitted `auth.jwt.audience` block is superseded and must be removed. The
  wizard may still derive/display the runtime account id, but it cannot write an
  expected-audience setting.
- `docs/PHASE6_MULTIDEVICE_PLAN.md` keeps its completed multi-device key-delivery
  history, but its fleet follow-up is superseded: first-party bootstrap does not
  return an `accountId -> agentPublicKey` map. Each selected account performs its
  own scalar authorized bootstrap and receives that target's one pin.

These notes preserve historical reasoning while preventing a “Ready to
implement” or “DONE” banner from overriding the current security contract.

**Context-free shared handlers are not issuers**

- Remove `/bootstrap` and the `bootstrap` option from
  `packages/saas/src/enrollment-http-handler.ts`. The shared handler has no
  authenticated end-user principal or target-tuple context, so it cannot safely
  own bootstrap issuance. The profile-specific session routes above own it.
  `p1-1-http-ui-contract.test.ts` and `enrollment-http-handler.test.ts` assert
  that `/bootstrap` is 404 and no callback exists or runs.
- Remove the duplicate open `/bootstrap` route and `bootstrap` option from
  `examples/minimal-consumer/src/operator.ts`; its handler likewise lacks an
  authenticated application principal. Keep `buildClaims` only as an explicitly
  low-level example to call *after* an integrating app authenticates and
  authorizes the tuple. `operator-handler.test.ts` asserts `/bootstrap` is 404.

**Hermetic harness exception**

`packages/saas/reference/enrollment-server.ts` also exposes
`POST /test/bootstrap-jwt`. Preserve it for negative, cross-account, and
multi-account E2E fixtures under this explicit contract:

- it exists only when `ENABLE_TEST_ROUTES=1 && !ENABLE_DEMO_UI`; define and use
  that effective gate consistently;
- without the test flag, and whenever demo mode is active (even if both raw flags
  are set), the route returns 404;
- when enabled, startup prints a prominent unauthenticated-test-issuer warning;
  when the test flag is requested alongside demo mode, startup instead warns
  that the route is suppressed;
- it may accept caller-selected tenant/account/peer specifically to mint attack
  and multi-account fixtures, but subject-token/bootstrap-claim validation still
  runs before signing;
- E2E harnesses opt in explicitly and no production/demo authorization test may
  cite this route as evidence.

**Standalone test issuer**

`packages/saas/reference/bootstrap-server.ts` is explicitly test-only, not a
deployment reference. It refuses to start unless `ENABLE_TEST_ROUTES=1` and
valid, non-empty `REFERENCE_TENANT` and `REFERENCE_ACCOUNT_ID` values are all set
in server-owned environment. It signs only that fixed tuple. The request does not
control tenant/account; any temporarily accepted legacy mismatch is rejected
before signing. Its header and startup banner state that the unauthenticated
endpoint must never be exposed as SaaS. Its response supplies that fixed tuple
together with its target-specific pin.

`packages/client/src/browser-jwt-entry.ts` is the standalone server's browser
caller, not an authorization authority. For its normal `/bootstrap` flow it no
longer advertises caller-selected tenant/account as signing inputs: it consumes
the server-returned fixed tuple and builds the client for that exact target. An
optional harness-side expected tuple may only assert equality and must fail
before NATS/client construction on mismatch. The explicitly gated
`/test/bootstrap-jwt` flow may continue taking fixture inputs under the harness
exception above.

`examples/webchannel-app/GETTING_STARTED.md` and
`examples/webchannel-app/README.md` remove audience prompt/config language and
describe the server-authorized scalar target account plus target-specific pin.
The same wording is propagated to the package/reference docs named in §6.

**Public API migration contract**

- `BootstrapClaims.accountId` is removed from the publicly exported TypeScript
  type and new signed output. Downstream TypeScript code must use `aud`; runtime
  consumers that inspected the duplicate output claim must read the scalar or
  array `aud` value instead. Previously signed tokens containing an extra
  top-level `accountId` remain accepted when their signed tenant and audience are
  otherwise valid.
- Integrators using the `bootstrap` callback option on
  `enrollment-http-handler` or the minimal-consumer operator must move issuance
  to an application-owned route that authenticates the principal, authorizes the
  full `(tenant, accountId)` tuple, and returns only that target's pin. The old
  callback option and context-free `/bootstrap` route are removed, not aliased.
- Scripts invoking the standalone bootstrap server must explicitly set
  `ENABLE_TEST_ROUTES=1`, `REFERENCE_TENANT`, and `REFERENCE_ACCOUNT_ID`, stop
  sending tenant/account as issuer-controlled request inputs, and consume the
  fixed tuple returned by the server. This is a test-harness migration, not a
  supported production issuer pattern.

Add an inventory guard that scans first-party source (`.ts` and `.mjs`) for
bootstrap route dispatch/calls, `/test/bootstrap-jwt`, `buildBootstrapClaims`,
and `createBootstrapIssuer`. Its explicit allowlist classifies each security-
relevant occurrence as a deployable/session route or consumer, gated harness,
test-only fixed-tuple server/caller, or policy-free helper use. Incidental
`bootstrapUrl` data fields and isolated unit-test fixtures are classified
separately rather than counted as issuers. Adding a new route or direct
build/sign call without a classification fails the test, preventing an
unreviewed issuer from bypassing this boundary.

### 5.7 Setup, preflight, doctor, and readiness

All operator surfaces use one vocabulary.

**Setup/wizard**

- Remove the audience advanced prompt and its credential key.
- Remove the `audience` parameter from `WebchannelSetupInput` and
  `buildFullAccountPatch`.
- Stop preserving or writing an existing audience as if it were a supported pin.
- Do not silently delete an existing key during an unrelated config write. The
  setup hook reports the same targeted migration failure and instructs the
  operator to remove it explicitly.

**Add-time preflight**

- Remove `pinnedAudience` from facts/options and delete the old “pin differs from
  account id” branch.
- `effectiveAudience` is always the canonical account id and is no longer a
  choice in test fixtures.
- If the raw account-scoped or channel-base config contains the tombstoned key,
  fail before the network portions of add preflight with the shared migration
  diagnostic; do not rely on effective auth merge to reveal it.

**Doctor/status**

- Replace `shared-audience` with `audience-override-removed` (exact final id may
  match project naming style).
- Preserve PR #39's per-account `planWebchannelAccount` `try/catch` isolation for
  enabled-account checks: one malformed account cannot suppress healthy sibling
  diagnostics. The plan itself owns the enabled-audience scan.
- Runtime status preserves its `enabled !== false && configured !== false`
  filtering and probes only enabled planned accounts.
- Doctor is intentionally broader only for this migration tombstone. It performs
  a direct cache-free/raw scan only for disabled accounts and emits a warning
  whose message says the account is not serving but must be fixed before
  re-enable. It does not resolve acquisition identity, load credentials, or probe
  relay/JWKS for that disabled account. Enabled affected accounts receive an
  error through their normal `planWebchannelAccount` call.
- A scoped raw hit is emitted exactly once per account (with the most specific
  raw path list) and that account is not re-run through verifier diagnostics, so
  Doctor/startup cannot duplicate or downgrade the migration finding.
- Remove the `(issuer, audience) -> first account` claims map. Same issuer with
  account-derived audiences is healthy and produces no finding.
- `verifier-unbuildable` no longer lists audience as a configurable missing
  field.
- Probes/readiness report `aud=<accountId>` directly from the plan, never from
  `auth.jwt`; rejected accounts cause no runtime publication or readiness-report
  emission at all.

`probeWebchannelAccount` follows a strict order: call
`planWebchannelAccount`; prepare/cache-free-validate resolved auth; only then
resolve dial material, probe the relay, and run the existing URL/file/inline JWKS
Gate B. A tombstone therefore returns targeted `ok: false` before `loadCreds`,
`readFile`, `resolveDialMaterial`, relay dial, or fetch. Auth preparation may read
persisted enrollment metadata once when a delivered issuer is actually needed;
that value is shared with later dial-material resolution rather than loaded
twice. If construction-time auth structure then fails, no credential
consumption, relay/JWKS I/O, runtime publication, or readiness-report emission
follows. This does not move URL fetches, JWKS-file parsing, or the structurally
valid empty-inline-JWKS check out of PR #39's Gate B.

Keep PR #39's `hasWebchannelConfig` structural-key detection intact. An empty
`accounts` map, `defaultAccount`, and lifecycle-only `enabled` field do not become
a configured account merely because the migration scanner exists.

### 5.8 Remove the warning-only collision guard

Delete `registerHopAudClaims` and the late warning branch from
`packages/plugin/index-nats.ts`.

It is not converted into a process-local fail-closed map. Such a map would remain
blind across processes and would preserve the false idea that a shared audience
is sometimes a valid account configuration. The prepared, account-bound
verifier is the security control; the removed-key precheck is the migration
control.

### 5.9 Documentation contract

Current and user-facing docs are updated; archived historical plans remain
historical unless a live index incorrectly points to them as current behavior.

Required wording:

```text
iss identifies the trusted SaaS issuer and may be shared.
tenant identifies the signed tenant and must match exactly.
aud is one accountId or an array of authorized accountIds in that tenant.
auth.jwt.audience is removed; the plugin always expects its runtime accountId.
```

The plan and implementation PR explicitly state that #65 is superseded by this
contract rather than independently relaxing partial audience pins.

## 6. File-level implementation map

### Plugin runtime and types

- `packages/plugin/src/auth.ts`
  - split raw and resolved auth types and remove audience from both;
  - cache-free validate issuer, exact-one discriminated JWKS source, and
    defaulted/non-negative-integer clock skew;
  - add the account-bound verifier factory/mandatory expected-account argument;
  - inject cache I/O test dependencies separately from config and preserve the
    shared JWKS cache;
  - preserve `JwksUnavailableError -> TransientVerifyError` classification.
- `packages/plugin/src/jwt.ts`
  - preserve string/all-string-array audience support;
  - reject malformed and mixed-type audience arrays as a whole.
- `packages/plugin/src/account-auth.ts`
  - derive issuer/JWKS only;
  - strictly validate/default raw-unknown `requirePoP` and expose the shared
    prepared-auth contract;
  - consume a memoized persisted-record accessor only when delivered issuer is
    needed;
  - accept/return only audience-free raw/resolved auth types.
- `packages/plugin/src/account-startup.ts`
  - export the dependency-injected sorted plan/auth/failure/start coordinator and
    the `PreparedAccountStartup`/structured failure contracts;
  - enforce a complete preparation and deterministic failure-emission barrier;
  - pass only successfully prepared entries to an injected
    `startPreparedAccount`, which owns every serving action.
- `packages/plugin/src/account-serving.ts`
  - implement the importable, dependency-injected per-account serving
    transaction and typed resource/activation adapters;
  - complete Gate B before any register subscription, then keep that subscription
    inert behind an unarmed guard until the final synchronous runtime commit;
  - register idempotent reverse-order disposal as resources are acquired, and on
    failure compare-and-delete only the candidate's partial global state before
    subscription/channel/transport teardown;
  - preserve PR #39's classified Gate B retry/readiness behavior while treating
    unexpected throws as rollback-required start failures; emit the immutable
    readiness report once only after successful activation.
- `packages/plugin/src/account-lifecycle.ts`
  - memoize one full coordinator/post-build promise for concurrent and repeated
    `registerFull` calls;
  - export the lazy primary transport/bind pair currently buried in the entry so
    its false-before-bind and delegate-after-bind behavior is directly tested;
  - select committed `default`, otherwise the lowest sorted committed account,
    and bind that channel exactly once through a non-throwing adapter;
  - leave the lazy primary null when nothing committed, preserve direct
    per-account approval lookup, and install keep-alive/summary only once without
    allowing host logging errors to trigger a rebuild.
- `packages/plugin/src/account-config.ts`
  - define the exact raw-path audience tombstone scanner/assertion and typed
    error shared by startup, Doctor, probe, and setup;
  - keep every existing removed-setting check and structural-config predicate;
  - provide Doctor with a cache-free disabled-account inspection seam.
- `packages/plugin/src/multiplex.ts`
  - invoke the scanner inside `planWebchannelAccount`, immediately after common
    enabled filtering and before acquisition/effective merge;
  - keep `planAccounts` for callers that want its current bulk behavior, but do
    not use it for the failure-isolated startup coordinator that `registerFull`
    invokes;
  - cover raw-base shadowing and structural-plan isolation in multiplex tests.
- `packages/plugin/index-nats.ts`
  - instantiate one module-lifetime account lifecycle, register production
    planner/preparer/failure/serving/primary/keep-alive adapters, and make every
    `registerFull` invocation delegate to its shared `ensureAccountsStarted()`
    promise;
  - compose the importable `startPreparedAccount` with production credential,
    NATS, JWKS Gate B, channel/store, guarded subscription, runtime
    identity-safe commit/compare-and-unpublish, non-throwing readiness-log, and
    cleanup-diagnostic adapters;
  - share the prepared entry's one lazy persisted-record accessor between auth
    preparation and later credential consumption per account;
  - preserve disabled-account early filtering and every PR #39 skip behavior;
  - continue with valid plans only;
  - wire token-only bound verifiers plus immutable `requirePoP`;
  - delete the collision map/late warning and write-only runtime auth field;
  - report readiness audience from `accountId`; rejected accounts emit only their
    scoped failure diagnostic, never a Gate B/success readiness report.
- `packages/plugin/src/nats-register.ts`
  - consume a token-only verifier and explicit resolved `requirePoP`;
  - require exact signed tenant/account/sub common binding for every operation;
  - preserve the distinct challenge, register PoP/`cnf`, and token-only
    unregister semantics in §5.4, including #51's deferral.
- `packages/plugin/src/nats-channel.ts` and `packages/plugin/src/nats-transport.ts`
  - expose/use only the narrow idempotent cleanup surface the serving transaction
    needs; transport disconnect must clear subscriptions and cancel reconnect;
  - make register-subscription activation return an unsubscribe handle and honor
    the pre-commit dispatch guard even under re-entrant fake delivery;
  - ensure a failed pre-commit channel attempt retains no subscription or message
    listener that can continue serving after its runtime is unpublished.
- `packages/plugin/src/nats-credential-source.ts` and
  `packages/plugin/src/enrolled-nats-connection.ts`
  - wrap every locally constructed transport's awaited `connect()` in a rejection
    path that calls idempotent `disconnect()` before rethrowing, including NKEY
    signer, protocol, timeout, and socket failures;
  - leave `consumeCredentialSource` responsible only for a successfully returned
    connection; it cannot clean a handle its connector failed to return.
- `packages/plugin/src/register-pop-gate.ts`
  - retire handler-time truthiness/default inference or replace it with the
    strict raw-unknown resolver used during account preparation;
  - keep handler inputs resolved to an actual boolean.
- `packages/plugin/src/preflight.ts`
  - remove pinned-audience inputs/branches;
  - call the raw scanner directly before add-time network work;
  - make reported audience equal accountId by construction.
- `packages/plugin/src/doctor.ts`
  - replace shared-audience detection with the removed-key diagnostic;
  - preserve per-account planning failure isolation and enabled status/probe
    filtering;
  - let enabled Doctor/probes inherit the scanner through planning and directly
    raw-audit only disabled tombstones without credentials or probes;
  - cache-free prepare resolved auth before dial material/relay/JWKS probing;
  - report/probe account-derived audience while preserving PR #39's URL/file/
    inline JWKS probe semantics.
- `packages/plugin/src/channel.ts`
  - preserve PR #39's configured/enabled lifecycle contract; add regression
    coverage if helper signatures change.

### Operator configuration

- `packages/plugin/openclaw.plugin.json`
  - turn `auth.jwt.audience` into an unconstrained `{}` removed-key tombstone;
  - remove the issuer+audience required pair;
  - update UI help so it cannot be mistaken for an active override.
- `packages/plugin/src/setup.ts`
  - remove audience setup input, builder parameter, preservation, and preflight
    threading.
- `packages/plugin/src/setup-wizard.ts`
  - remove the audience prompt/input key/finalize value.

### SaaS/reference surface

- `packages/saas/src/bootstrap-claims.ts`
  - require valid tenant;
  - keep scalar/array `aud`;
  - remove output `accountId` claim/type member.
- `packages/saas/src/bootstrap-issuer.ts`
  - document/test it as a policy-free signer, not an HTTP authorization gate.
- `packages/client/src/saas-bootstrap.ts`
  - correct claim documentation; it must not advertise the removed duplicate.
- `demo/saas-server.ts`
  - keep the deployable session route on the fixed `DEMO_TENANT`;
  - authorize one scalar account and return only that tuple's registry pin.
- `packages/saas/reference/enrollment-server.ts`
  - server-pin/authorize the scalar session `/bootstrap` tuple and its pin;
  - preserve `/test/bootstrap-jwt` only under the harness gate in §5.6, with
    explicit startup warnings and demo-mode suppression.
- `examples/webchannel-app/server/index.ts`
  - keep the canonical session route fixed to `TENANT` and scalar `ACCOUNT_ID`;
  - test principal authorization and same-tuple registry-pin selection.
- `demo/web/src/widget.ts`, `packages/client/src/browser-demo-entry.ts`, and
  `examples/webchannel-app/web/app.ts`
  - preserve one scalar session/config target per connection;
  - construct the client with that same target and its returned pin.
- `packages/saas/src/enrollment-http-handler.ts`
  - remove its context-free `/bootstrap` route and `bootstrap` callback option;
  - leave issuance to profile-specific authenticated routes.
- `examples/minimal-consumer/src/operator.ts`
  - remove its duplicate open `/bootstrap` route and option;
  - retain `buildClaims` only as a documented low-level builder called after
    application authentication/authorization.
- `packages/saas/reference/bootstrap-server.ts`
  - classify and gate it as test-only;
  - require `ENABLE_TEST_ROUTES=1` plus valid `REFERENCE_TENANT` and
    `REFERENCE_ACCOUNT_ID`, bind the signed tuple and returned pin to that
    server-owned fixed config, and reject any caller-selected mismatch.
- `packages/client/src/browser-jwt-entry.ts`
  - make the normal standalone `/bootstrap` caller consume and server-match the
    fixed returned tuple rather than choose signing inputs;
  - fail an expected-tuple mismatch before constructing a client or dialing.
- `packages/saas/src/demo-users.ts`, `packages/saas/README.md`, and
  example/reference documentation
  - describe authorization as a tenant/account pair for multi-tenant adopters.

### Tests, demos, and live docs

- Plugin auth/account-auth/account-config/multiplex/register/preflight/doctor/
  setup/wizard/channel tests listed in §7.
- Add `packages/plugin/src/account-startup.test.ts`: import the coordinator and
  use injected planner, auth, failure, persisted-accessor, start, and serving
  spies to prove the preparation barrier and valid-only start contract.
- Add `packages/plugin/src/account-serving.test.ts`: import the production
  transactional serving function and inject failures after transport connect,
  Gate B classification, channel/store construction, guarded register
  subscription, and partial runtime publication. Hold Gate B pending and prove no
  subscription exists; then re-entrantly deliver a register request during
  subscription and prove the unarmed handler produces no reply or protected-state
  effect. Prove reverse cleanup, unpublish-before-disconnect,
  zero residual subscriptions/reconnect/runtime/primary binding, no committed
  readiness report, and healthy-sibling continuation even when one disposer also
  throws.
- Add `packages/plugin/src/account-lifecycle.test.ts`: call the real lifecycle
  twice concurrently while its coordinator promise is deferred and once again
  after settlement; account enumeration/planning/connect/start, primary bind,
  keep-alive, and summary each occur only once and every caller observes the same
  result. Cover committed default preference, deterministic first committed
  fallback, all-failed/null primary, a rolled-back candidate excluded from
  selection, and an unexpected memoized rejection with no retry. Drive the
  exported lazy facade: it returns `false` before/no bind and delegates a real
  core-initiated send to the selected fake channel after bind; later invocations
  cannot rebind it.
- Extend `packages/plugin/src/nats-credential-source.test.ts` and add/extend
  `packages/plugin/src/enrolled-nats-connection.test.ts` with the real production
  factories: NKEY signer rejection, protocol/handshake rejection, and timeout
  close the created fake WebSocket/transport, cancel timers/reconnect, and rethrow
  the original error. A successful connector remains live and is not
  disconnected by the factory.
- Rewrite `packages/plugin/src/index-nats-wiring.test.ts`. Its PR #39 baseline
  pins `resolveEffectiveAccountAuth` imports/calls and a literal `continue` count;
  remove/update those stale source-text assertions deliberately. The replacement
  guard pins production registration of the startup coordinator and serving
  transaction/lifecycle/lazy-primary adapters, token-only
  `PreparedAccountAuth.verifyIdentity` plus resolved `requirePoP` wiring, and
  placement of all credential/NATS/channel/
  store/JWKS/guarded-subscription/runtime-commit/readiness-log actions below
  successful preparation and failure emission. Behavioral preparation,
  activation, rollback, and once-only primary behavior belongs in
  `account-startup.test.ts`/`account-serving.test.ts`/
  `account-lifecycle.test.ts`; keep only load-bearing entrypoint wiring assertions
  in the source-contract guard.
- Extend `packages/plugin/src/manifest-schema.test.ts`; validate against the real
  OpenClaw-built runtime schema rather than a hand-rolled approximation.
- `packages/saas/src/bootstrap-claims.test.ts` and
  `packages/saas/src/bootstrap-issuer.test.ts`: primitive claim/signing behavior,
  including scalar/all-string-array audiences, without treating helpers as auth.
- `packages/saas/src/p1-1-http-ui-contract.test.ts` and
  `packages/saas/src/enrollment-http-handler.test.ts`: shared-handler bootstrap is
  404 and the removed callback cannot be invoked.
- `examples/minimal-consumer/test/operator-handler.test.ts`: duplicate bootstrap
  is 404; low-level builder coverage remains separate.
- `examples/webchannel-app/test/enroll-validation.test.ts` plus a route-level
  server test: fixed tenant, scalar authorized account, and matching pin.
- `packages/saas/src/ac6-device-flow-e2e.test.ts`,
  `e2e/local/all-real.mjs`, and standalone issuer/browser-entry fixtures: fixed
  tuple delivery/consumption and pre-client mismatch failure.
- Add the first-party issuer/caller inventory guard from §5.6 with an exact
  allowlist of route/build/sign occurrences.
- Explicit config writers in `demo/*.sh` and `e2e/local/*.sh`: remove
  `auth.jwt.audience` instead of replacing it with a new setting.
- `docs/AUTH.md`, `docs/ONBOARDING_GUIDE.md`, `packages/saas/README.md`,
  `demo/README.md`,
  `examples/webchannel-app/GETTING_STARTED.md`,
  `examples/webchannel-app/README.md`, E2E README/comments, and release
  notes/changelog: remove audience prompt/config wording and document the scalar
  target plus target-specific pin. The demo grant list remains UI/session
  metadata; each selected lane obtains its own scalar bootstrap response.
- `CHANGELOG.md`, `packages/plugin/CHANGELOG.md`, and
  `packages/client/CHANGELOG.md`: record the public
  `BootstrapClaims.accountId`/output removal, the removed context-free bootstrap
  callbacks/routes, and the standalone server's explicit test/fixed-tuple env
  migration as the breaking API and harness changes specified in §8.
- `packages/plugin/package.json`, `packages/client/package.json`,
  `packages/saas/package.json`, and `package-lock.json`: make one coordinated
  release-version change after rebasing. The reviewed baseline is `0.2.0`, so the
  planned breaking pre-1.0 release is `0.3.0`; if that version is already used on
  the implementation baseline, select the next unpublished minor. Regenerate the
  lockfile with the repository's package manager so all three workspace entries
  match the manifests; the root monorepo's private `0.0.0` version is unrelated
  and stays unchanged.
- `docs/PUBLISHING.md` and `.github/workflows/publish.yml`: no policy change is
  planned. Treat their existing three-way lockstep check and lightweight `v*`
  tag procedure as release acceptance criteria, and update them only if the
  implementation discovers that the documented/enforced rule itself changed.
- Update `docs/P1_DOCTOR_PLAN.md` with an implementation note or superseding
  pointer so its C5/current backlog text is not presented as the live contract.
  Update the active `docs/gaps/P1_RICH_UX_GAPS.md` P1-6 inventory in the same
  change: replace its built `shared-audience` catalog entry with the removed-key
  diagnostic/startup transaction contract rather than leaving the shipped-state
  summary stale.
- Update `docs/DEMO_PLAN.md` with the superseding note from §5.6 so its historical
  grant-list `aud`, multi-account rendezvous response, and pin-map proposal cannot
  be mistaken for the implemented demo/security contract.
- Update `docs/SETUP_WIZARD_PLAN.md` and
  `docs/PHASE6_MULTIDEVICE_PLAN.md` with the scoped superseding notes from §5.6:
  the former's configurable audience design is removed, while the latter's
  completed per-device crypto remains valid but its one-response fleet pin map
  does not.

Low-level JWT tests and `scripts/jwt-smoke-bootstrap.mjs` still use an expected
audience because that is part of JWT verification, not operator configuration.
The unrelated package-publishing OIDC audience is untouched.

## 7. Verification plan

### 7.1 Config and preparation matrix

| Case | Expected result |
|---|---|
| No `auth.jwt.audience`; issuer/JWKS derived | prepared successfully; expected aud is accountId |
| No audience; explicit issuer or JWKS pin | prepared successfully; expected aud is still accountId |
| Flat/default audience equals or differs from accountId | same targeted removed-config failure before I/O |
| Named-account audience equals or differs from accountId | that named account gets the same targeted failure |
| Raw channel-base audience plus named `auth.jwt` override | every enabled named account is named and skipped; shadowing cannot hide the base key |
| Channel-base audience plus disabled named account | runtime is silent/zero-I/O for the disabled account; Doctor warns it will fail on re-enable |
| Named audience on one disabled account | same disabled Doctor-only warning; enabled siblings remain valid |
| Same issuer, distinct account ids, no pins | both prepare and start |
| `requirePoP` absent / `true` / `false` | resolves to `true` / `true` / `false` respectively |
| `requirePoP` is `null`, string, number including `0`, array, or object | construction-time account error before serving I/O |
| `clockSkew` absent / non-negative integer | resolves to 60 / preserves the integer |
| `clockSkew` is negative, fractional, non-finite, string, `null`, array, or object | construction-time account error before serving I/O |
| zero or multiple JWKS fields; empty URL/file; inline `jwks: {}` | construction-time account error before cache/serving I/O |
| inline `jwks: { keys: [] }` | preparation succeeds structurally; existing Gate B reports zero usable keys/fail-closed readiness |
| structurally valid URL/file source | preparation succeeds; fetch/read/content validation remains Gate B I/O |

Run the `requirePoP`, `clockSkew`, and JWKS-structure rows through both the
strict flat/default manifest shape and an unvalidated named-account leaf. Where
the host schema already rejects a flat value, also unit-test the runtime parser
directly as defense in depth; the named leaf reaches that parser naturally.
Neither path may accept invalid input through a cast or JavaScript truthiness,
and valid values resolve identically.

Import `coordinateAccountStartup` directly in
`packages/plugin/src/account-startup.test.ts` and run a three-sibling regression:
sorted account A fails an existing pre-planning rule (for example
`auth.ticketParam`), B carries the audience tombstone, and C is valid. Inject
planner, auth-preparer, failure-emitter, persisted-accessor,
`startPreparedAccount`, and granular serving-dependency spies. Assert A and B
each get exactly one stable `{ accountId, phase, error }` diagnostic, all
preparation failures are emitted in sorted order before the first start call,
and **only C** reaches `startPreparedAccount`. The serving spies must prove zero
A/B credential consumption, dial-material resolution, NATS connect, channel/
conversation-key/history/approval-store construction, register subscription,
JWKS warm/read/fetch, runtime publication, or readiness-report emission. Repeat
with malformed accounts ordered before and after C so failure isolation is not an
ordering accident.
Existing removed-setting cases remain covered; audience handling must not
special-case away their isolation.

Add a construction-time auth sibling coordinator regression with explicit
issuer: A has inline `jwks: {}`, B is invalid by an independent planning rule,
and C is valid. Assert only C reaches the injected `startPreparedAccount`; the
same serving-dependency spies prove zero A/B credential, relay, JWKS, channel,
store, subscription, and readiness calls. A also fails before `loadCreds` and
cache creation. In a separate fixture where A's issuer must come from persisted
enrollment metadata, allow and assert exactly one shared local metadata load,
but still zero A relay/JWKS/serving I/O after structural failure. The lazy
accessor retained in a valid `PreparedAccountStartup` is reused by C's serving
adapter rather than loading the record twice.

Import the real transactional `startPreparedAccount` from
`packages/plugin/src/account-serving.ts` and drive it with granular dependency
spies. Inject a throw (or the real missing-identity result) immediately after:

1. credential consumption has returned a connected transport;
2. Gate B classification;
3. channel/store construction;
4. guarded register-subscription installation; and
5. a commit adapter has inserted the runtime-map entry but throws before
   returning.

For every pre/during-commit failure, assert the failed account is absent from the
runtime map and primary-channel selection; no success/Gate-B readiness report was
emitted; all active subscription ids/listeners are retired; `disconnect()` runs
exactly once and cancels the reconnect timer; and no failed-account handler
responds after the attempt rejects. Assert the trace order is disarm, partial
runtime unpublish, reverse channel/subscription/store cleanup, then transport
disconnect. Make one intermediate disposer throw and prove the remaining cleanup
still runs, its diagnostic is account-scoped, the original start error remains
primary, and the coordinator starts the next valid sibling. The successful
control publishes one fully wired runtime, arms once, emits one readiness report,
and runs no rollback.

Pre-populate the map with a different healthy runtime object for the same account
id and force the candidate commit to fail. Assert the adapter neither overwrites
nor compare-deletes that existing object; only the rejected candidate's resources
are torn down. Separately inject “map set candidate, then throw” and assert exact-
identity rollback removes that candidate.

Use a re-entrant fake transport that invokes the installed register handler
synchronously from `subscribe`. Before runtime commit/arming, a syntactically
valid request receives no reply and causes zero nonce, peer registration, key
wrap/delivery, history, approval, runtime-commit/readiness-log, or primary-binding
effect. Repeat after an injected partial-commit failure and then run the positive
after successful arming, so the test proves both the race closure and live path.
In a separate deferred-Gate-B fixture, hold the JWKS promise open and assert the
register-subscription spy remains at zero for the whole wait; an attempted broker
request has no route/reply. Only Gate B settlement may enter the synchronous
guarded activation.

Separately exercise the real production connector factories rather than only a
generic fake resource factory. Make the NKEY signer and handshake reject after a
fake WebSocket/transport exists; assert `nats-credential-source.ts` and
`enrolled-nats-connection.ts` close it, cancel timers/reconnect, and preserve the
original rejection before the outer ledger could receive a disposer.

Also cover the non-throwing Gate B policy explicitly. A structurally valid
empty/unreachable source produces PR #39's fail-closed readiness classification
before subscription, then commits/arms the retry-capable runtime and emits that
`FAIL` report rather than entering rollback; an ordinary JWT still cannot pass
while no usable key exists. This keeps transactional cleanup from silently
changing the accepted Gate B availability behavior.

Import the production account lifecycle and lazy-primary binding. Hold its first
coordinator call pending, invoke `ensureAccountsStarted()` concurrently, release
it, and invoke it again after completion. Assert one coordinator/resource graph,
one post-build selection, one bind, one keep-alive installation, and one summary;
all callers settle from the memoized build and no second dependency set is
captured. Repeat with an unexpected rejected coordinator and prove later calls
observe that rejection without acquiring again.

Populate the committed-runtime view with: (a) `default` plus a lower-sorted named
account, (b) named accounts only, (c) a candidate that was inserted then rolled
back plus one valid sibling, and (d) no runtime. Assert the selected primary is
respectively `default`, the lowest sorted committed id, the valid sibling, and
null. Before/null bind, an actual method call through the exported lazy facade
returns `false`; after bind, a core-style outbound call reaches exactly the
selected channel. A concurrent/second lifecycle invocation cannot change that
binding. These are positive composition assertions, not merely checks that a
failed candidate was absent.

Exercise the centralized entrypoint directly: disabled
`planWebchannelAccount` returns before scanning; enabled direct planning and bulk
`planAccounts` produce the same targeted tombstone error; the importable startup
coordinator catches it per id and the importable once-only lifecycle invokes that
coordinator; `registerFull` delegates only to the lifecycle. Enabled Doctor and
probe surface the error through planning rather than a copied check.

Issuer-metadata reads used to resolve auth are separately instrumented and are
allowed in preparation: the existing persisted enrollment record may be read to
extract its delivered issuer. `consumeCredentialSource`, transport construction,
and every network call remain forbidden until after the complete failure log
pass.

Rewrite `index-nats-wiring.test.ts` in the same change. Its source-contract
assertions must prove the module creates one production account lifecycle/lazy
primary binding, supplies its coordinator/transaction/commit/keep-alive adapters,
and makes `registerFull` call only `ensureAccountsStarted()`. They also pin the
token-only bound verifier and resolved `requirePoP` from `PreparedAccountAuth`
and keep every serving action/commit adapter behind `startPreparedAccount`.
Delete the obsolete PR #39 assertions for direct `resolveEffectiveAccountAuth`
wiring and any literal `continue` count; those would reward preserving the old
buried coordinator instead of testing the new entrypoint boundary.

### 7.2 Cryptographic account-binding matrix

Use one real test RSA/JWKS issuer, not a mocked `verifyIdentity` verdict. This
first table isolates the signed tenant/audience portion of the common gate
(matching `sub`/subject is held constant); subject and operation-specific
expectations follow it:

| Token | Runtime | Expected |
|---|---|---|
| `tenant=T, aud=A` | T/A | accept |
| `tenant=T, aud=A` | T/B | reject |
| `tenant=T, aud=[A,B]` | T/A and T/B | accept both |
| `tenant=T, aud=generic-service` | T/A and T/B | reject both |
| `tenant=T1, aud=A` | T2/A | reject |
| missing tenant, `aud=A` | T/A | reject |
| missing/malformed aud | T/A | reject |
| `aud=[A, 7]` or `[A, null]` | T/A | reject whole token |

Run each operation through `handleRegisterRequest`, not just the verifier:

| Operation | Own-account positive | Required negative matrix |
|---|---|---|
| `challenge` | Correct tenant/aud/subject-`sub` token without PoP/`cnf` receives a nonce. | Cross-account aud, tenant mismatch/missing, and subject-`sub` mismatch each return opaque 401 and issue no nonce. |
| `register` | Correct common binding plus the current PoP/nonce signature and X25519 `cnf` registers, wraps K, and sends snapshots. | Cross-account aud, tenant mismatch/missing, and subject-`sub` mismatch each return opaque 401 before peer/key/history/approval state. |
| `unregister` | Correct common binding without nonce, PoP, or `cnf` calls `unregisterPeer` exactly once and sends no reply. | Cross-account aud, tenant mismatch/missing, and subject-`sub` mismatch are no-op and no-reply. |

Repeat the positive for each authorized member of a valid multi-aud token and a
negative for a non-member so a test cannot “prove” isolation by making every
operation fail. For challenge/register, inject
`JwksUnavailableError` through the factory and assert it becomes
`TransientVerifyError`/503; ordinary invalid tokens remain null/401. For
unregister, both transient and ordinary verifier failure remain logged/silent
no-reply no-ops.

Add a hermetic direct-signer pinning fixture with distinct active agent keypairs
for T/A and T/B. It may reuse one valid `aud: [A, B]` JWT, but it creates two
separate client connections: A with A's authenticated registry pin and B with
B's. Both connections reuse the single JWT's token-bound `cnf`/PoP device keys;
they do not mint a second keypair that the JWT never attested. Each correct
target/pin pair unwraps and authenticates its own delivered K;
A's pin cannot authenticate B's wrapped K, and a non-member target is rejected
before key delivery. This proves that multi-aud authorization did not silently
turn one response pin into a cross-account pin.

Exercise register PoP independently of audience. With `requirePoP`
omitted/defaulted or explicitly `true`, a correctly bound token missing
`pop_jwk` is rejected. With explicit `false`, a token without `pop_jwk` follows
the existing legacy path, but it still needs valid `cnf` for K delivery. Whenever
a token does carry `pop_jwk`, nonce/signature verification remains mandatory even
under explicit `false`. Missing/malformed `cnf`, replayed/invalid nonce signature,
and missing required `pop_jwk` are all 401 before side effects. These tests pass
the resolved boolean through `PreparedAccountAuth -> RegisterHandlerDeps`; they
do not reconstruct policy from raw auth.

Keep an explicit regression that unregister succeeds without nonce/PoP/`cnf`;
do not turn those into requirements. Its captured-token replay behavior is the
unchanged baseline tracked by #51.

### 7.3 SaaS claim and issuance tests

- Scalar input produces `aud: "A"` and no top-level `accountId`.
- Array input produces `aud: ["A", "B"]` and no top-level `accountId`.
- Empty array, invalid account element, missing/invalid tenant fail before
  signing.
- Helper tests state their boundary: `buildBootstrapClaims` and
  `createBootstrapIssuer` are policy-free primitives and are never counted as
  route authorization evidence.
- The deployable session routes in `demo/saas-server.ts`,
  `packages/saas/reference/enrollment-server.ts`, and
  `examples/webchannel-app/server/index.ts` derive the peer/principal from the
  session, reject a client-selected foreign tenant even when the user may access
  the same bare account id, issue only one authorized scalar account, and return
  the registry pin for that exact tuple. Route tests decode the JWT and compare
  both claims and pin lookup to server-owned/session-authorized values.
- The shared `packages/saas/src/enrollment-http-handler.ts` and minimal-consumer
  handler return 404 for `/bootstrap`; their public option types contain no
  bootstrap callback and tests prove no such callback can run.
- `/test/bootstrap-jwt` returns 404 without `ENABLE_TEST_ROUTES=1` and whenever
  `ENABLE_DEMO_UI=1`, including when both raw flags are set. A subprocess/startup
  test checks the prominent enabled warning and the demo-suppressed warning.
- A hermetic E2E explicitly opts into `/test/bootstrap-jwt`, uses its
  caller-selected tuple to mint negative/multi-account fixtures, and proves
  subject-token/claim validation still rejects malformed values. No
  session/production authorization test uses this route.
- The standalone `reference/bootstrap-server.ts` refuses to start without its
  `ENABLE_TEST_ROUTES=1` gate and valid `REFERENCE_TENANT`/
  `REFERENCE_ACCOUNT_ID` fixed tuple, signs and returns that server-owned tuple
  with its matching pin, and rejects every caller attempt to choose a different
  tenant/account.
- The normal `browser-jwt-entry.ts` flow does not submit a caller-selected
  tenant/account. It consumes the standalone response's fixed tuple; an optional
  expected tuple mismatch fails before `WebChannelNatsClient` construction,
  NATS dial, or subscription. Its gated `/test/bootstrap-jwt` flow remains
  covered only as a harness path.
- A custom multi-aud contract test authorizes every member and requests one
  authenticated target/pin at a time while reusing the one JWT-attested device
  keypair; unauthorized members, target-not-in-aud, and A-pin-for-B all fail.
  First-party deployable route tests remain scalar.
- Authorization examples/tests express `(tenant, accountId)` ownership.
- Old token with an extra top-level `accountId` still verifies when signed tenant
  and aud are correct.
- The inventory guard finds exactly the classified first-party route/build/sign
  sites in §5.6 and fails when an unclassified occurrence is added. Generic
  signing-helper coverage is not promoted to an authentication assertion.
- Demo documentation verification confirms that `demo/README.md` describes the
  grant list only as UI/session metadata and a separate scalar bootstrap plus
  matching pin for each selected lane. `docs/DEMO_PLAN.md` carries a prominent
  superseding note over its obsolete multi-aud/rendezvous-map passages; neither
  file remains usable as evidence for a first-party multi-account response.
- Documentation-contract verification also checks that
  `docs/SETUP_WIZARD_PLAN.md` visibly supersedes every configurable-audience
  prompt/write/preservation passage, and that
  `docs/PHASE6_MULTIDEVICE_PLAN.md` preserves its finished device-key work while
  superseding only the fleet pin-map claim in favor of separate scalar
  bootstrap/pin responses. A repository-wide Markdown search for
  `auth.jwt.audience`, grant-list `aud`, and multi-account `agentPublicKey` map
  language must leave no unqualified current guidance; historical occurrences
  need an adjacent/top-level superseding classification.
- `docs/P1_DOCTOR_PLAN.md` and the active
  `docs/gaps/P1_RICH_UX_GAPS.md` no longer present `shared-audience` as the live
  Doctor/runtime contract; both point to the removed-key diagnostic and
  rollback-safe issue #54 startup behavior. Files already under `docs/archive/`
  or dated `docs/review-*` remain explicitly historical and need no rewrite.

### 7.4 Diagnostics/schema/setup tests

- Real supported OpenClaw schema validation accepts generated flat and named
  configs with no audience and with issuer-only pins.
- Extend the existing manifest-schema drift suite against
  `buildJsonChannelConfigSchema`. For both flat/default and named-account shapes,
  test audience values: non-empty string, empty string, `null`, number, boolean,
  object, and array. Host schema validation accepts each tombstone shape; runtime
  planning/Doctor then emits the same targeted removed-key diagnostic with the
  exact raw path. It is never surfaced as an active default.
- Test a channel-base tombstone plus a named `auth.jwt` override to prove the raw
  scanner reports every account in scope despite the shallow merge.
- Wizard has no audience prompt and never writes the key.
- Non-interactive setup never writes or preserves audience as an active pin.
- Programmatic setup input containing a legacy audience is rejected with the
  targeted diagnostic rather than silently dropped.
- Gate A and Gate B print `aud=<canonical accountId>` from runtime identity.
- Doctor emits the removed-key finding for flat, named, and inherited shapes and
  emits no shared-audience finding for healthy same-issuer accounts. Enabled
  findings are errors; disabled findings are explicitly non-serving warnings.
- Status/probe tests preserve PR #39 filtering: disabled/unconfigured snapshots
  do not produce runtime issues or perform probes, and one malformed enabled
  account does not suppress a sibling finding.
- An enabled tombstoned probe returns targeted `ok: false` from
  `planWebchannelAccount`; injected `loadCreds`, `readFile`,
  `resolveDialMaterial`, `dial`, and `fetch` spies all remain at zero.
- With an explicit issuer and inline `jwks: {}`, probe fails cache-free auth
  preparation before those same dial/JWKS seams. A delivered-issuer fixture may
  call `loadCreds` once and reuses its result, but still performs no
  `resolveDialMaterial`, relay dial, file read, fetch, runtime publication, or
  readiness-report emission after structural failure.
- PR #39 Gate B regressions remain explicit: structurally valid inline
  `{ keys: [] }` produces its existing zero-key failed readiness result, while
  URL fetch and file read/parse occur only in Gate B and retain their existing
  error classification.

### 7.5 Regression commands

At minimum, on the final implementation head:

```bash
npm test --workspace openclaw-webchannel
npm test --workspace @mir-stream/webchannel-saas
npm run typecheck
npm run build
npm test
```

Before the issue #54 tag is cut, add a release-metadata gate to the final
verification:

- read `version` from all three package manifests and assert they are identical;
- read the `packages/plugin`, `packages/client`, and `packages/saas` workspace
  versions from `package-lock.json` and assert each equals that manifest version;
- assert the chosen version is the next unpublished minor (`0.3.0` on this
  reviewed baseline) and the proposed lightweight tag is exactly
  `v<that-version>`;
- run `npm ci` from the regenerated lockfile, then run the same local equality
  logic as the `Enforce 3-way version lockstep` steps in
  `.github/workflows/publish.yml`; the tag-push workflow must pass that guard
  before any artifact is considered released.

Do not use a manual `workflow_dispatch` as the issue #54 release: that path
publishes nothing, from any ref, and therefore cannot prove the required
three-artifact release. A partial publish retry remains governed by the
idempotency/recovery procedure in `docs/PUBLISHING.md`.

Run the targeted two-account isolation and derived-trust E2E harnesses in the
environment used by CI. Add or extend one live two-process harness with A and B
in separate gateway processes, the same signed tenant, one real shared issuer/
JWKS, and the same relay. The harness must use `registerFull` delegating through
the importable coordinator and its production `startPreparedAccount`/
`NatsChannel` adapters rather than calling a verifier or handler directly, and
prove the route is live before attempting the negative:

1. Complete the real challenge and register flow A-token -> A and B-token -> B.
   Each browser/client authenticates and unwraps the K delivered under its own
   target pin and receives the expected history and approval snapshots.
2. Send a syntactically valid A token/peer request to B's actual live challenge
   and register subjects. Observe the ordinary opaque invalid-auth 401 response,
   not a timeout, malformed-subject/body failure, transient-JWKS 503, or absence
   of a B subscription. Snapshot B's counters/state after the positive, then
   assert zero **additional** peer registration, key wrapping/delivery, history
   snapshot, approval snapshot, runtime-map change, or primary-binding change for
   the attack; no state
   for A's peer appears in B and B's established peer state is unchanged.
3. Complete B-token -> B again after the attack and authenticate/unwrap B's K and
   snapshots, proving the negative did not pass merely because B stopped serving.

Keep the same-tuple HA positive regression as a separate complement: two
independently constructed runtimes/verifiers for the same
`(tenant, accountId)` accept the same valid token population and consult no
process-global first-owner/collision state. Existing shared-key/subscription HA
integration behavior remains outside this issue. The two-process negative is a
required production-wiring/topology regression, while the local bound verifier
and exact signed tenant remain the authorization mechanism; no cross-process
discovery or collision coordination is introduced.

## 8. Rollout and migration

This is an intentional breaking configuration change.

It is released as one coordinated pre-1.0 minor across all three artifacts.
After rebasing onto the required PR #39 baseline, determine the next unpublished
minor; with the currently reviewed `plugin = client = saas = 0.2.0` state, set
all three manifests and their lockfile workspace entries to `0.3.0`. Commit that
coherent state before creating the lightweight `v0.3.0` tag. If the baseline has
advanced, substitute the next unpublished minor everywhere. Never tag a partial
bump or use a patch version to hide these intentional configuration and public
API breaks.

Before upgrade, remove every occurrence of:

```text
channels.webchannel.auth.jwt.audience
channels.webchannel.accounts.<id>.auth.jwt.audience
```

A shared-base occurrence must be removed at the channel level; adding an account
override does not make the inherited removed key safe. No re-enrollment is
required when issuer/JWKS, tenant, account id, and persisted credentials are
otherwise unchanged.

Runtime behavior during migration:

- have the importable startup coordinator call the centralized per-account
  planner for every sorted id (disabled return, then raw tombstone scan), then
  prepare every surviving auth plan;
- emit one actionable, structured preparation error per affected account in
  deterministic order before starting any prepared entry;
- never construct a `PreparedAccountStartup` or invoke the serving adapter for an
  affected account, so it performs no credential/provider/NATS/channel/store/
  subscription/JWKS/readiness work;
- continue serving unaffected prepared accounts through the injected production
  adapter;
- have concurrent/repeated `registerFull` calls share the one lifecycle promise;
  after it completes, bind the lazy primary once to committed `default`, otherwise
  the lowest sorted committed account, and never reacquire or rebind on later
  calls;
- classify Gate B before installing a register subscription, then install,
  runtime-commit, and arm that subscription in one synchronous guarded
  activation so no pre-commit request can receive a reply or protected data;
- if a prepared account fails after acquiring transport or channel resources,
  disarm it, remove any partial runtime publication, suppress its successful/Gate
  B readiness report, and tear its resources down in reverse order before
  reporting the start failure; do not leave a subscription or reconnect loop
  running while later siblings start;
- never silently use, ignore, or rewrite the removed value.

Disabled accounts remain dormant and quiet at runtime; `openclaw doctor` reports
their stale tombstone as a non-serving warning so operators can clean it before
re-enable.

For public API consumers, replace references to exported
`BootstrapClaims.accountId` with `aud` and handle its scalar-or-array shape. New
tokens no longer emit the duplicate top-level property. This is a breaking
TypeScript/output-contract change even though JWT verification remains tolerant
of previously signed tokens carrying the unknown extra property. The overall
token contract is also intentionally not fully backward-compatible: requiring
tenant rejects pre-tenant legacy tokens; current deployable and harness builders
already emit tenant.

Integrators that supplied a `bootstrap` callback to
`enrollment-http-handler` or the minimal-consumer operator must move that logic
to an application-owned, authenticated route that authorizes the complete
`(tenant, accountId)` tuple and selects the matching pin. The context-free
callback options and `/bootstrap` routes are removed without an alias. Standalone
test scripts must set `ENABLE_TEST_ROUTES=1`, `REFERENCE_TENANT`, and
`REFERENCE_ACCOUNT_ID`, stop sending a caller-selected issuer tuple, and consume
the fixed tuple in the response; the server refuses to start when that explicit
test/fixed-tuple gate is incomplete.

Release notes must call out:

1. generic/shared IdP audience support is removed;
2. `aud` must be the account id or authorized account-id array;
3. tenant is mandatory and exact;
4. remove the config key before upgrade;
5. #65 is superseded by the new no-audience-pin contract;
6. prior shared-audience service is a possible security incident and requires
   the containment assessment in §8.1, not merely a config edit;
7. the public `BootstrapClaims.accountId` member and emitted duplicate claim are
   removed; downstream TypeScript/runtime consumers must use `aud`, while old
   signed tokens containing the extra property remain accepted when otherwise
   valid;
8. the context-free `bootstrap` callback options and `/bootstrap` routes in
   `enrollment-http-handler` and the minimal-consumer operator are removed;
   integrators must relocate issuance behind application authentication and
   full-tuple authorization;
9. the standalone bootstrap server is test-only and now requires
   `ENABLE_TEST_ROUTES=1` plus fixed `REFERENCE_TENANT` and
   `REFERENCE_ACCOUNT_ID`; harnesses must set them and consume the server-owned
   returned tuple rather than choose signing inputs.
10. the plugin, client, and SaaS ship together at the next minor version
    (`0.3.0` on the reviewed baseline), with matching lockfile entries and the
    exact `v<version>` release tag.

### 8.1 Previously exposed accounts are an incident, not just a migration

The upgrade prevents **new** cross-account registration, but it cannot make a
previous recipient forget a conversation key or history already returned under
the warning-only behavior. If an account ever served while sharing an effective
issuer/audience with another account, operators must treat its peer access,
conversation key, and any returned history as potentially exposed.

The release runbook must use only verified controls that actually exist in the
SaaS/plugin version to:

1. drain and stop every vulnerable gateway process, then keep the affected
   accounts disabled while remediation is performed;
2. revoke affected bootstrap/NATS peer authorization or sessions at the issuer/
   relay control plane;
3. rotate the affected account's conversation key and invalidate old encrypted
   peer state before serving resumes;
4. review the exposure window and history returned during it.

Removing `auth.jwt.audience`, restarting only some replicas, or letting a
bootstrap JWT expire is not represented as key revocation. This issue does not
invent automatic rotation or claim that deleting an undocumented file is safe.
The missing integrated
credential-revocation and key-epoch workflow is tracked by
[#72](https://github.com/mir-stream/openclaw-webchannel/issues/72). Until a
verified rotation path exists, the documented conservative response is to keep
a suspected affected account disabled and escalate through the service's
incident process. Previously returned plaintext/history, or captured ciphertext
plus the old K, cannot be made secret again.

## 9. Implementation sequence

Keep coherent changes reviewable in this order:

0. **Integrate the lifecycle baseline** — PR #39 is merged; rebase the
   implementation branch onto the latest `origin/develop` and verify that it
   contains merge commit `11bd90b0542cbe4201da075a1e8f791e74191a68` (reviewed
   feature head `61486b042efadd5d833c6af0ddaf3456690e97e8`). Run its
   doctor/channel/multiplex/manifest tests unchanged before issue #54 edits.
1. **Account-bound verifier core** — unknown-to-resolved auth parser,
   discriminated exact-one JWKS source, clock-skew/PoP validation, strict
   string-array JWT audience validation, separately injected cache I/O
   dependencies,
   account-bound factory/error classification, exact tenant check, and the
   challenge/register/unregister operation matrix.
2. **Failure-isolated pre-serving preparation** — raw-path tombstone scanner
   invoked inside `planWebchannelAccount` after enabled filtering; importable
   dependency-injected `account-startup.ts` coordinator; sorted per-account
   plan/auth `try/catch`; deterministic bulk failure emission; valid-only
   `PreparedAccountStartup` handoff to the importable transactional
   `account-serving.ts`; Gate-B-before-subscribe plus guarded synchronous runtime
   activation/readiness logging and reverse cleanup on every start failure;
   disconnect-on-rejection in both real transport-producing connectors; rewrite
   once-only `account-lifecycle.ts` composition and deterministic committed
   default/first primary binding; rewrite the tsc-blind index wiring guard and add
   coordinator/serving/connector/lifecycle fault-injection and positive outbound
   tests. Delete the collision map only after the bound verifier and rollback-safe
   serving path are wired.
3. **Lifecycle and operator diagnostics** — Doctor's enabled-error/
   disabled-warning behavior, status/probe filtering, no runtime publication or
   readiness report for rejected accounts, unconstrained schema tombstone,
   setup/wizard/preflight cleanup, and real host-schema tests; resolve #65
   contract.
4. **SaaS claim, issuer, and caller cleanup** — tenant validation, duplicate
   claim removal, policy-free helper boundary, scalar deployable full-pair
   authorization and target-specific pins, removal of both context-free shared
   bootstrap routes/options, enrollment-server harness gate/warnings, standalone
   fixed-tuple server/browser-caller contract, inventory guard, and route tests.
5. **Demos/docs/rollout and production-wiring proof** — remove explicit audience
   from runnable configs and webchannel-app prompts/guides; rewrite
   `demo/README.md` around one scalar bootstrap/pin per selected lane and add the
   superseding issue #54 notes to `docs/DEMO_PLAN.md`,
   `docs/SETUP_WIZARD_PLAN.md`, and `docs/PHASE6_MULTIDEVICE_PLAN.md`; update the
   remaining live documentation and release/incident notes; link storage issue
   #71 and containment issue #72; then run the full regression, the live
   two-process positive-negative-positive E2E, and the same-tuple HA positive.
6. **Coordinated release metadata** — after the implementation and migration
   suite is green, select the next unpublished minor (`0.3.0` on the reviewed
   baseline), change `version` in the plugin/client/SaaS manifests together,
   regenerate `package-lock.json`, and re-run the complete suite plus the local
   manifest/lockfile/tag equality gate. Commit the coherent release state before
   creating and pushing the lightweight `v<version>` tag; the publish workflow's
   existing three-way guard must pass before any artifact ships.

These numbers describe implementation order, not necessarily separate commits.
Steps 1 and 2 form one atomic landing unit: the old configured-audience consumer
is not removed from a green revision until the account-bound verifier is wired
through the failure-isolated coordinator. Run tests/typecheck at step 0, after
the combined 1+2 unit, and after every later step. Never land a state in which
the plugin stops reading configured audience before the verifier has been bound
to runtime account id.

## 10. Non-goals and follow-ups

- No change to the NATS browser wildcard account permission. Account/tenant JWT
  binding is the authorization fix; wildcard routing remains needed for the
  browser's account selection flow.
- No process-global account registry, distributed collision service, or
  first-wins account owner.
- No semantic change for valid configurations to issuer trailing-slash
  normalization, signature algorithms, JWKS caching/rotation, JWT expiry,
  register PoP/`cnf` device binding, or subject-peer checks. Construction now
  rejects invalid raw types rather than allowing JavaScript truthiness to alter
  policy; the existing resolved register default/explicit-false behavior is then
  threaded explicitly.
- Challenge remains common-gate nonce issuance without PoP/`cnf`. Unregister
  remains common-gate token-only/no-reply and therefore retains the captured-JWT
  replay risk tracked by
  [#51](https://github.com/mir-stream/openclaw-webchannel/issues/51). Fixing that
  risk is not smuggled into #54.
- No removal of low-level scalar/all-string-array JWT `aud` support. Issue #54
  does not add a deployable multi-account connection response, configurable
  expected audience, or interchangeable multi-account agent pin; first-party
  deployable/session issuance remains scalar.
- No rename of OpenClaw's local/wire `accountId` config key or NATS subject
  segment.
- No attempt to infer whether a third-party token issuer *intended* a string as a
  generic service audience. The supported issuer contract is account-scoped;
  an issuer that violates it is unsupported.
- Persisted credential and conversation-key storage are currently keyed by bare
  account id rather than `(tenant, accountId)`. Cross-tenant processes sharing
  one storage root must not reuse an account id until
  [#71](https://github.com/mir-stream/openclaw-webchannel/issues/71) is addressed;
  this PR does not migrate on-disk paths. A credential-path override alone does
  not isolate `ConversationKeyStore`. Issue #63 overlaps persisted-credential
  identity drift but does not cover tenant-aware coexistence or the key-store
  namespace.
- Automatic revocation/rotation for an account that may already have leaked a
  conversation key is not implemented here. The end-to-end containment tooling,
  epoch protocol, tests, and rollout are tracked by
  [#72](https://github.com/mir-stream/openclaw-webchannel/issues/72); §8.1's
  prevention-versus-recovery release contract remains required in #54.
- Existing HA requirements for shared identity keys/state are unchanged.

## 11. Issue #54 acceptance mapping

| Original acceptance item | Planned evidence |
|---|---|
| No indistinguishable colliding account serves | Valid accounts have distinct verifier expectations by construction; every enabled account in a legacy audience pin's raw scope is rejected before I/O. |
| Preflight before per-account I/O | The importable startup coordinator completes its sorted `planWebchannelAccount` pass (enabled check then embedded raw scan), auth-plan pass, and deterministic preparation-failure emission before any valid `PreparedAccountStartup` reaches the injected serving adapter. |
| Start failure is isolated, not partially live | The importable serving transaction fault-injects every acquisition/activation stage and proves the unarmed subscription cannot reply, while unpublish plus reverse teardown leaves no runtime/primary binding, readiness report, subscription, listener, or reconnecting transport and a healthy sibling starts. |
| Existing entrypoint lifecycle remains usable | Concurrent/repeated `registerFull` calls share one tested build; only committed runtimes participate in `default`-else-lowest primary selection, and a positive call through the real lazy facade reaches that channel exactly once. |
| Entire collision group, not later account only | Superseded by the accepted account-bound-claim alternative. A channel-base removed key rejects every enabled account in scope, including shadowing overrides; valid configs have no collision group. |
| Authenticated account authorization | The common gate verifies signature/issuer/time, signed `tenant`, bound account audience, and subject-`sub`; operation-specific behavior stays explicit in §5.4. |
| Preserve issuer normalization | Issuer verification and normalization are unchanged. |
| Preserve distinct-audience multi-account startup | Same issuer with A/B runtime bindings starts normally. |
| Cross-subject negative and own-subject positive tests | Real-JWT handler matrix in §7.2 plus §7.5's live `registerFull` -> startup coordinator -> production `startPreparedAccount`/`NatsChannel` two-process A->A, B->B, A->B opaque-401/zero-mutation, B->B-again sequence. |
| Multi-aud stays account- and pin-bound | One direct-signer token authorizes separate A/B connections, each with its distinct registry pin; A's pin cannot authenticate B's K and non-members fail (§7.2/§7.3). |
| Operator-visible failure | Startup, doctor, setup preflight, schema help, and release note contract in §5.7/§8. |
| Breaking change is publishable coherently | Plugin/client/SaaS manifests and lockfile workspace entries share the next minor, `npm ci` and the local lockstep check pass, and the lightweight `v<version>` tag matches all three before publish (§7.5/§8/§9). |

## 12. Resolved questions

- **Should `aud` and `accountId` remain independently configurable?** No.
- **Should an explicit equal value remain accepted for compatibility?** No. A
  redundant active knob can drift later and recreates the invalid state.
- **Should the plugin silently overwrite a legacy audience with accountId?** No.
  Silent reinterpretation hides an unsafe issuer contract; fail with remediation.
- **Should collision detection become cross-process coordination?** No. Bind each
  verifier locally to its runtime account id.
- **Does process separation isolate accounts?** It is not a security boundary.
  Signed tenant/account authorization is.
- **Does this make unregister PoP-protected?** No. It gains the same bound
  account and exact-tenant common gate, but its existing token-only/no-reply
  operation contract remains until #51.
- **Can account ids repeat across tenants?** Yes at the protocol level, because
  tenant is signed and exact. Bare-account storage collisions remain a separate
  operational constraint (§10).
- **Does removing the duplicate JWT `accountId` remove routing identity?** No.
  The OpenClaw/NATS account id remains unchanged; only the unused duplicate claim
  disappears.
- **Does multi-aud mean one connection or pin may float between accounts?** No.
  It is only a signed authorization set. Each connection has one target and one
  target-specific authenticated registry pin; first-party deployable issuance is
  scalar in this issue.
- **May the standalone browser caller choose the test issuer's tuple?** No. The
  server owns and returns its fixed tuple; caller-side expected values are only
  equality assertions and a mismatch fails before client/network construction.
- **What happens to issue #65?** The implementation supersedes it: issuer/JWKS
  pins may remain independently optional, while audience is no longer a pin.
