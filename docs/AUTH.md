# Authentication

WebChannel authenticates browsers at the NATS register hop. The gateway exposes
no browser-facing connection or token route.

## Register-hop flow

1. The browser obtains a short-lived bootstrap JWT and NATS credentials from the enrollment service.
2. Browser and agent connect outbound to the NATS relay.
3. The browser generates a fresh random `clientNonce` for this register attempt and
   sends it, with its JWT and proof-of-possession response, on the account-scoped
   register subject.
4. The plugin verifies signature, issuer, audience, and tenant/subject FIRST, then
   the wire protocol version, then `clientNonce` format and proof of possession,
   before registering peer subjects. The version check deliberately sits behind
   authentication so an unauthenticated request gains no account/version oracle
   (`nats-register.ts` carries the ordering rationale).
5. The agent returns the conversation key wrapped to the SaaS-attested device key,
   with both the peer id and that `clientNonce` bound into the wrap AAD.

The unreleased wire protocol version is **7**. Client and plugin must ship
together; a mismatch is refused with a terminal `protocol_mismatch` (426) before
any key work. Version 6 adds authenticated `ack.cancelled`: exact wire IDs whose
cancellation is durable, restricted to the same frame's `ack.ids`. A client must
retire the active watch for those IDs even when no journal row was created;
otherwise it reconnects indefinitely for a cancelled pre-admission message.
An ordinary ACK, including a stop-command receipt, supplies no cancellation proof.
Version 7 adds `cancel_pending` on an explicit `/stop`: the earlier user messages
that device has no server result for. The server durably cancels each one it has
not accepted and answers it with `ack.cancelled`, so it cannot run after the stop.
`ack.unaccepted`, a subset of `cancelled` in each ID's own frame, declares the
cancelled IDs the server never accepted; only those show as cancelled input.
This uses the existing exact-match gate without negotiation; the encrypted
envelope remains version 1 and package versions are unchanged. Version 7 (#401)
adds `load_history.nonce`, echoed on the `history` page that answers it: pages
ride the peer's shared `.out`, and a device folds only a page echoing its own
nonce, so another device's page cannot leave a hole in a different window.
Version 7 (#396) marks periodic typing renewals with `keepalive: true`. Clients
must treat these as liveness only; ignoring the marker would re-arm typing and
queue ordinary followups after output or approval. These changes share the same
unreleased protocol 7 contract and ship in one paired client/plugin rollout.

### Register-reply freshness (`clientNonce`)

The wrapped conversation key is authenticated — it is sealed under the agent's
SaaS-pinned identity key, so a relay cannot substitute its own — but authentication
alone does not make it *fresh*. A hostile relay can capture a register reply and
re-serve it verbatim. That is inert only because the conversation key K never
rotates today; once rotation exists, a replayed reply becomes a session hijack.

Protocol v3 binds a per-attempt anchor into the wrap so a captured reply cannot open
on a later attempt. The anchor must be **browser-chosen**: the agent's challenge
reply is unauthenticated plaintext and the browser only checks that a nonce is
present, so a relay can answer the challenge itself and replay a *matched* (nonce,
wrap) pair without the agent participating. The single-use PoP nonce protects the
agent from replay, not the browser. The agent never echoes `clientNonce` back, and
the browser always unwraps with the value it generated locally — a value read back
off the wire would be a relay-chosen value.

The anchor is regenerated per register *attempt*, not per connection, so the retry
that follows a dropped reply does not inherit the previous attempt's anchor.

The live identity contract is exact: `iss` identifies the trusted SaaS issuer
and may be shared; signed `tenant` must be non-empty and exactly match the
runtime tenant; `aud` is one account id or an array of authorized account ids in
that tenant; signed `sub` must exactly match the peer segment of the register
subject. The subject namespace fixes routing but never substitutes for these
signed checks. Authentication failure never downgrades to open admission.

Challenge, register, and unregister all pass through that common
issuer/tenant/audience/subject gate. Challenge needs no PoP or `cnf`; register
then applies the configured PoP policy and always requires a valid X25519 `cnf`
key for key delivery.

Unregister applies **the same PoP policy as register** (it did not, before
protocol v3) and still sends no reply, including on rejection. The bootstrap JWT
crosses the untrusted relay in plaintext, so a token-only teardown was replayable:
an observer could capture `{op:"unregister", token}` and re-send it until the JWT
expired, dropping the victim's subscription and session key each time with no
signal to the victim. Requiring a single-use PoP proof makes each teardown usable
once.

The proof is bound to the **operation** it authorizes — the device signs
`webchannel-pop:{op}:{peerId}:{nonce}`. Both operations draw from the same per-peer
nonce bucket, so without that binding a proof minted for `register` would also
authorize a teardown; and a relay can obtain an unconsumed one for free by
*suppressing* the register frame, which is indistinguishable from the dropped frame
the client's retry loop exists to absorb. Replay protection alone does not cover
suppression.

Under the `requirePoP: false` operator opt-out with a JWT that carries no
`pop_jwk`, unregister stays token-only and therefore remains replayable for the
JWT's lifetime. This is deliberate and matches register exactly — the same gate
decides both — but it means disabling PoP disables it for the whole register hop,
not for registration alone.

**Embedder note (breaking).** A client that sends a token-only `unregister` against
a v3 agent gets a **silent no-op**: unregister is fire-and-forget with no reply on
any path, and the protocol-version check sits after the unregister branch, so there
is no `426` and no error of any kind. That is required by the no-oracle contract,
but it is undiagnosable from the client. Use the client package's
`unregisterWithPop()`, which performs the challenge → sign → publish sequence.

The enrollment repository conformance factory's controlled `clock` capability
is optional, but an adapter that omits it certifies strictly less: assert that
the conformance report's `skipped` list is empty to prove full clock-dependent
lease, expiry, retention, and race coverage.

## Configuration

Register-hop admission uses `channels.webchannel.auth.strategy: "jwt"` and:

- a required `issuer` (which may be derived from the SaaS enrollment anchor);
- exactly one of `jwksUrl`, `jwksFile`, or inline `jwks`;
- optional `clockSkew` and `requirePoP` controls.

JWT audience is not configurable: the runtime account id is the expected `aud`.
Any raw `auth.jwt.audience` key, including `null` or an empty value, is a removed
configuration tombstone and prevents that enabled account from serving. Delete
the key instead of trying to align two independent values.

Each enabled account independently completes pure account planning and creates
one immutable account-bound verifier before that account consumes transport
credentials or opens a relay connection. Issuer derivation may first read the
account's memoized enrollment metadata when that delivered issuer is required.
Startup preflight and live verification reuse the prepared verifier and its JWKS
cache. A removed audience key or malformed auth therefore fails the affected
account before its own transport credential/network I/O without blocking
structurally valid accounts. A generation-wide collision preflight is
unnecessary: the signed tenant claim and account-id `aud` binding distinguish
token populations even when accounts share an issuer. JWKS outages fail closed
but are retryable; invalid tokens are terminal rejects.

Unknown kids share a single in-flight refresh and a 30-second cooldown across
all kids. A failed refresh or one without the requested kid retains previously
cached keys only until their original TTL expires. A known fresh key remains
usable during that refresh; no expired key is used as an outage fallback.
Malformed JWT segments and payloads are rejected before JWKS lookup (#408).

Configured SaaS base URLs require HTTPS, except HTTP on `localhost`,
`127.0.0.0/8` or `::1`. There is no bypass flag. Enrollment,
derived JWKS URLs, preflight and doctor enforce this same configured-URL rule
(#411). Redirect-target validation is separate pre-existing behavior tracked in
[#452](https://github.com/mir-stream/openclaw-webchannel/issues/452).

The deprecated `auth.ticketParam` schema key remains accepted only so loading can
produce a targeted migration error. Remove it and rerun
`openclaw channels add --channel webchannel`.

See [`TRUST_AND_ONBOARDING.md`](TRUST_AND_ONBOARDING.md) for the complete trust model.

## DM policy

`channels.webchannel.dmPolicy` (or the account override) uses the SDK enum:

| Policy | Admission |
| --- | --- |
| `open` (default) | Explicit `allowFrom: ["*"]` admits every peer already authenticated for this account by the SaaS JWT. |
| `allowlist` | A nonempty configured sender list; `*` matches all and `webchannel:` prefixes normalize. Peer identity remains case-sensitive. |
| `pairing` | Configured senders and SDK-approved peers can send; others receive an SDK pairing challenge. |
| `disabled` | No sender, including a listed sender, may dispatch a DM turn. |

The default differs from Telegram's pairing because SaaS token issuance already
authorizes this account's peers (TD-1). It does not synthesize a wildcard when
loading old configuration. Explicitly add `allowFrom: ["*"]` if open admission
is intended. Setup writes both values for a fresh account and preserves existing
restrictions when run again.

`dmSecurity` is a deprecated alias. Legacy `all`, `any`, `anyone`, `everyone` and
`public` (case/whitespace normalized) map to `open`; unknown values are rejected.
Within one config layer `dmPolicy` wins, while an account-local legacy field can
override a shared canonical policy. Doctor reports the migration and missing
wildcard/empty allowlist; core audit points to `dmPolicy` and `allowFrom` at their
actual channel/account location.

The manifest's DM definitions specialize named-account checks by the inherited
policy and allowlist, since JSON Schema has no upward property reference. Other
named-account fields retain their existing runtime validation. The account
startup gate repeats effective DM validation before credential/network work.

## NATS credential scope and rollout

The next lockstep SaaS/plugin release narrows freshly minted credentials:

| Role | Publish | Subscribe |
| --- | --- | --- |
| Agent | `webchannel.{tenant}.{accountId}.>` | Same account subtree |
| Browser | `webchannel.{tenant}.*.{peerId}.in`, `webchannel.{tenant}.*.{peerId}.register` | `webchannel.{tenant}.*.{peerId}.>` |
| Observer (demo wiretap) | Deny all | `webchannel.{tenant}.>` |

The agent scope comes from the approved enrollment's exact account. Browser
identity comes from the authenticated SaaS session. Reply subjects require only
browser subscriptions; the browser never needs to publish agent frames.

Existing JWTs are immutable and retain their old privileges until expiry or
explicit revocation. Doctor warns when an enrolled agent grant is broader than
its account; it does not reject or revoke that grant. To narrow it, upgrade SaaS
and plugin together. For state already bound to the same trusted issuer, stop the
account, archive only its credential file, complete the existing SaaS active-key
replacement procedure, and explicitly re-enroll with
`openclaw channels add --channel webchannel --account <id>`; this retains history
and conversation keys. If doctor reports a storage-issuer failure, credential-only
reissue cannot bypass it: first follow the
[issuer-recovery procedure](STORAGE_IDENTITY_V2.md#issuer-binding-412) to restore
the original trusted issuer and matching credentials where supported, or archive
the complete tuple and initialize fresh state without reusing its history or keys.
Verify the new grant before revoking the old one. An old JWT without `exp` needs
explicit replacement/revocation; waiting does not narrow it. Browser sessions
likewise need newly issued credentials for the new publish restrictions to apply.

This changes relay permissions without changing encrypted frames or protocol 7.
Direction binding in envelope AAD is a separate defense-in-depth follow-up
[#436](https://github.com/mir-stream/openclaw-webchannel/issues/436); client replay
and freshness are tracked by #415 E4.

## Agent identity-key lifecycle

An account is the isolation axis and represents one logical agent. Agent HA replicas must share the same identity key; independently keyed replicas are unsupported and surface as replacement conflicts. Enrollment wire formats do not contain an `agentId`.

Approval correctness is independent of issuer replica count when every replica uses one conforming `EnrollmentRepository`. The repository owns the clock and atomically serializes enrollment transitions, key activation, and history. Issuers obtain `createdAt`/`expiresAt` from the repository clock and never use their own clock for expiry or lease validity. Approval claims use a 30-second default lease as a fence; a crash is recovered by lease expiry and re-claim, while a late old commit is rejected.

Durable adapters must pass the exported core and fault conformance suites against the real shared backend; controlled-clock conformance is recommended. The fault suite certifies idempotent recovery after a fully successful commit whose response is lost; it does not inject partial writes or prove transactional atomicity. The conformance factory's clock capability is optional: the convenience runner visibly reports each clock-case skip and returns those names, while direct execution of a clock case without the capability fails loudly. A skipped clock suite is not certification of lease, expiry, retention-boundary, or time-dependent race behavior.

An ambiguous commit is retried once with the same operation id and byte-for-byte payload. A committed result is recoverable through its immutable snapshot while `now <= approvedAt + retentionMs`; after eviction recovery requires re-enrollment. Retention should be at least twice the poll interval plus expected clock skew. Denying an approving record immediately invalidates its claim, so a late commit cannot reverse the operator decision. Credentials minted before that denial are unreachable orphans, not cryptographically revoked. `expires_in` remains the client approval-and-pickup deadline; retention supplies boundary grace, not a longer advertised polling window.

Revocation permanently tombstones the active identity key and only stops that slot's key from being served to future bootstrap requests. It does not disconnect browsers that already pinned the key and does not revoke the agent's existing NATS credentials.

### Offline re-key after revocation

This is intentionally an offline, operator-confirmed operation; moving a file
cannot replace credentials held by a running transport.

1. Stop the OpenClaw gateway.
2. Resolve and move the exact tuple credential file
   (`$HOME/.openclaw-webchannel-v2/<v2_namespace>/credentials.json`, under the
   configured `storageRoot`, or the exact low-level `credentialPath`) to a new
   operator-chosen backup path. Do not delete or overwrite it.
3. Keep the recoverable migration archive under
   `$HOME/.openclaw-webchannel/.legacy-v1-backups/`. If the obsolete single-file
   credential exists at
   `$HOME/.openclaw-webchannel/credentials.json`, archive it separately. Readers
   do not use it.
4. Complete the SaaS active-key replacement/revocation step required by the
   deployment.
5. Run `openclaw channels add --channel webchannel --account <account>` and
   approve the new enrollment.
6. Restart the gateway only after enrollment completes.

Until the restart, an already-running transport continues using its old in-memory credentials; online hot-swap is not supported.


## Bootstrap JWT lifetime (#447)

The plugin requires finite `iat` and `exp`, with `0 < exp - iat <= 3600` seconds.
Issued-at may not be later than the verification clock plus configured skew;
expiry retains the existing clock-skew check. Skew never increases the one-hour
lifetime cap. Tokens without `iat` or with a longer lifetime are rejected.

Before this change, the demo SaaS, both reference servers and the example app
all used `buildBootstrapClaims`' 300-second default. The public builder's optional
TTL and the direct signer had no upper bound; both now enforce the same lifetime
contract. No first-party deployed bootstrap route requests a longer lifetime.
This applies to RS256 browser bootstrap tokens. NATS operator/account/user
credentials are separate relay credentials with separate issuance policies.
