# Authentication

WebChannel authenticates browsers at the NATS register hop. The gateway exposes
no browser-facing connection or token route.

## Register-hop flow

1. The browser obtains a short-lived bootstrap JWT and NATS credentials from the enrollment service.
2. Browser and agent connect outbound to the NATS relay.
3. The browser sends its JWT and proof-of-possession response on the account-scoped register subject.
4. The plugin verifies signature, issuer, audience, and proof of possession before registering peer subjects.
5. The agent returns the conversation key wrapped to the SaaS-attested device key.

The subject namespace fixes tenant, account, and peer routing. Authentication
failure never downgrades to open admission.

## Configuration

Register-hop admission uses `channels.webchannel.auth.strategy: "jwt"` and:

- required `issuer` and `audience`;
- exactly one of `jwksUrl`, `jwksFile`, or inline `jwks`;
- optional `clockSkew` and `requirePoP` controls.

`assertJwtAuthConfig` validates the structure during account startup and creates
the shared JWKS cache. Startup preflight and live verification reuse that cache.
JWKS outages fail closed but are retryable; invalid tokens are terminal rejects.

The deprecated `auth.ticketParam` schema key remains accepted only so loading can
produce a targeted migration error. Remove it and rerun
`openclaw channels add --channel webchannel`.

See [`TRUST_AND_ONBOARDING.md`](TRUST_AND_ONBOARDING.md) for the complete trust model.

## Agent identity-key lifecycle

An account is the isolation axis and represents one logical agent. Agent HA replicas must share the same identity key; independently keyed replicas are unsupported and surface as replacement conflicts. Enrollment wire formats do not contain an `agentId`.

Approval correctness is independent of issuer replica count when every replica uses one conforming `EnrollmentRepository`. The repository owns the clock and atomically serializes enrollment transitions, key activation, and history. Issuers stamp `createdAt`/`expiresAt`, but never use their clock to decide expiry or lease validity. Approval claims use a 30-second default lease as a fence; a crash is recovered by lease expiry and re-claim, while a late old commit is rejected.

An ambiguous commit is retried once with the same operation id and byte-for-byte payload. A committed result is recoverable through its immutable snapshot while `now <= approvedAt + retentionMs`; after eviction recovery requires re-enrollment. Retention should be at least twice the poll interval plus expected clock skew. Denying an approving record immediately invalidates its claim. Credentials minted before that denial are unreachable orphans, not cryptographically revoked. `expires_in` remains the client approval-and-pickup deadline; retention supplies boundary grace, not a longer advertised polling window.

Revocation permanently tombstones the active identity key and only stops that slot's key from being served to future bootstrap requests. It does not disconnect browsers that already pinned the key and does not revoke the agent's existing NATS credentials.

### Offline re-key after revocation

This is intentionally an offline operation; deleting a file cannot replace credentials held by a running transport.

1. Stop the OpenClaw gateway.
2. Delete the account credential file: `rm -- "$HOME/.openclaw-webchannel/<account>/credentials.json"`. If `credentialPath` is configured, delete that exact override instead.
3. Also remove the obsolete single-file credential, if present: `rm -f -- "$HOME/.openclaw-webchannel/credentials.json"`. Readers no longer use it.
4. Run `openclaw channels add --channel webchannel` for the account and approve the new enrollment.
5. Restart the gateway only after enrollment completes.

Until the restart, an already-running transport continues using its old in-memory credentials; online hot-swap is not supported.
