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
