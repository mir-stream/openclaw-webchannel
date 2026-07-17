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
- an optional `clockSkew` control.

`assertJwtAuthConfig` validates the structure during account startup and creates
the shared JWKS cache. Startup preflight and live verification reuse that cache.
JWKS outages fail closed but are retryable; invalid tokens are terminal rejects.

Proof-of-Possession is **always required** at the register hop — a verified
bootstrap JWT that carries no `pop_jwk` is rejected before any peer is registered.
The former `auth.requirePoP` opt-out is **removed**: after register-hop became the
sole admission path, a config toggle that unlocked it was a security relaxation,
not a setting. The schema still accepts the key only so a present value produces a
targeted startup migration error — remove `auth.requirePoP` and rerun
`openclaw channels add --channel webchannel`. The deprecated `auth.ticketParam`
key is accepted for the same reason (targeted migration error, then remove).

See [`TRUST_AND_ONBOARDING.md`](TRUST_AND_ONBOARDING.md) for the complete trust model.

## BYO-NATS operator contract

A static (bring-your-own-NATS) relay is a **transport** choice — self-hosted,
Synadia/NGS, or any managed NATS. It is not an auth bypass: register-hop admission
and the SaaS-attested agent identity are unchanged (a static account with no
enrolled identity is skipped, `identity-missing`). What the operator owns is the
broker, so the operator must configure the subject grants webchannel needs.

### Required subject permissions

For a tenant `{tenant}` (rendered for your tenant by `formatPermissionTemplate`
and enforced by `mintNatsUserCreds`), configure three roles:

| Role | pub allow | pub deny | sub allow |
|------|-----------|----------|-----------|
| agent (the enrolled gateway) | `webchannel.{tenant}.>` | — | `webchannel.{tenant}.>` |
| browser (per session; `{peerId}` = the authenticated session subject) | `webchannel.{tenant}.*.{peerId}.>` | — | `webchannel.{tenant}.*.{peerId}.>` |
| observer (read-only wiretap) | — | `>` | `webchannel.{tenant}.>` |

The observer's deny-all publish MUST be the explicit `pub.deny: [">"]`. An empty
`pub.allow` is **not** deny-all in nats-server (an absent/empty allow-list means
unrestricted), so only the explicit deny actually refuses every publish. The
per-peer browser grant (`*` matching the accountId segment) is what structurally
closes register-reply forgery and unregister-DoS: a browser can only touch its own
peer subtree, so it cannot publish a forged register reply to (or subscribe) another
peer's reginbox.

### Browser credentials stay SaaS-minted

The plugin never mints browser credentials. Per-peer browser creds require a
peerId-scoped grant, and the peerId is the value the SaaS login authenticates — so
the SaaS is the only supported issuer, in one of two shapes:

- **self-hosted relay preloading SaaS account trust** (the default), or
- **external/managed account** — the operator delegates their own NATS account's
  signing key to the SaaS via `issuerAccountId`, and the SaaS mints per-peer creds
  on that account's behalf (`nats.issuer_account`-stamped, signing-key-signed —
  the Synadia/NGS shape).

An operator distributing browser creds outside the SaaS is not blocked (the
application layer is the primary boundary), but it is a **tolerated, documented
configuration only** under the permission template above — webchannel provides no
issuer or tooling for self-minted browser creds.

### Add-time preflight does not probe a static operator's broker

`channels add` runs a permission probe, but it validates the **enrolled/SaaS**
transport creds — it dials and probes with the creds the SaaS just delivered. A
static account returns from acquisition before that probe (there are no creds to
acquire), so a static operator's **own** broker grants are **not** checked at
add-time. Validate them instead against the printed permission template and by
live serving (a mis-scoped agent grant surfaces as the account failing to
subscribe/serve; a mis-scoped browser grant surfaces as register/echo failing for
that peer). The static-mode `channels add` output prints the template for exactly
this reason.

## Agent identity-key lifecycle

An account is the isolation axis and represents one logical agent. Agent HA replicas must share the same identity key; independently keyed replicas are unsupported and surface as replacement conflicts. Enrollment wire formats do not contain an `agentId`.

The approval guarantees assume one issuer process and require the enrollment store and agent-key registry to use the same durability domain (both memory for development, or both durable in the same database). Mixed durability is unsupported. Multi-issuer enrollment-transition serialization and atomic store/registry commits are deferred work; registry CAS nevertheless ensures a losing different-key approval never receives credentials.

Revocation permanently tombstones the active identity key and only stops that slot's key from being served to future bootstrap requests. It does not disconnect browsers that already pinned the key and does not revoke the agent's existing NATS credentials.

### Offline re-key after revocation

This is intentionally an offline operation; deleting a file cannot replace credentials held by a running transport.

1. Stop the OpenClaw gateway.
2. Delete the account credential file: `rm -- "$HOME/.openclaw-webchannel/<account>/credentials.json"`. If `credentialPath` is configured, delete that exact override instead.
3. Also remove the obsolete single-file credential, if present: `rm -f -- "$HOME/.openclaw-webchannel/credentials.json"`. Readers no longer use it.
4. Run `openclaw channels add --channel webchannel` for the account and approve the new enrollment.
5. Restart the gateway only after enrollment completes.

Until the restart, an already-running transport continues using its old in-memory credentials; online hot-swap is not supported.
