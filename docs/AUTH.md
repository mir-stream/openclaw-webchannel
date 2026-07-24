# Authentication

WebChannel authenticates browsers at the NATS register hop. The gateway exposes
no browser-facing connection or token route.

## Register-hop flow

1. The browser obtains a short-lived bootstrap JWT and NATS credentials from the enrollment service.
2. Browser and agent connect outbound to the NATS relay.
3. The browser sends its JWT and proof-of-possession response on the account-scoped register subject.
4. The plugin verifies signature, issuer, audience, and proof of possession before registering peer subjects.
5. The agent returns the conversation key wrapped to the SaaS-attested device key.

The live identity contract is exact: `iss` identifies the trusted SaaS issuer
and may be shared; signed `tenant` must be non-empty and exactly match the
runtime tenant; `aud` is one account id or an array of authorized account ids in
that tenant; signed `sub` must exactly match the peer segment of the register
subject. The subject namespace fixes routing but never substitutes for these
signed checks. Authentication failure never downgrades to open admission.

Challenge, register, and unregister all pass through that common
issuer/tenant/audience/subject gate. Challenge needs no PoP or `cnf`; register
then applies the configured PoP policy and always requires a valid X25519 `cnf`
key for key delivery. Unregister remains token-only and sends no reply, including
on rejection.

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

The deprecated `auth.ticketParam` schema key remains accepted only so loading can
produce a targeted migration error. Remove it and rerun
`openclaw channels add --channel webchannel`.

See [`TRUST_AND_ONBOARDING.md`](TRUST_AND_ONBOARDING.md) for the complete trust model.

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
