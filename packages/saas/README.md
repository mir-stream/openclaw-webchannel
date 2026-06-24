# @openclaw/webchannel-saas

Headless SaaS trust chain core + reference harness for WebChannel NATS relay.

## Overview

This package provides the one-time offline initialization for the SaaS trust chain that serves as the single source of truth for the WebChannel control plane.

## Core Functionality

### `setupTrustChain`

Generates the complete SaaS trust chain artifacts:

**PRIVATE** (SaaS-only infrastructure):
- RS256 private key (PEM) — signs bootstrap JWTs
- NATS account signing seed (NKEY) — signs NATS operator/account JWTs

**PUBLIC** (nats-server + JWKS endpoint):
- NATS operator JWT (signed by operator NKEY)
- NATS account JWT (signed by operator NKEY)  
- Resolver config (maps account public NKEY to account JWT)
- JWKS document (RSA public key for bootstrap JWT verification)

## Usage

```typescript
import { setupTrustChain } from '@openclaw/webchannel-saas';

const trustChain = await setupTrustChain({
  operatorName: 'my-saas-operator',
  accountName: 'tenant-123',
  rsaKeySize: 2048, // optional, default 2048
});

// Store trustChain.private securely (SaaS-only)
// Load trustChain.natsConfig into nats-server
// Publish trustChain.jwks at JWKS endpoint
```

## Reference CLI

A reference CLI harness is provided at `reference/setup-trust-chain.ts` that demonstrates how to:

1. Generate the trust chain artifacts
2. Persist private keys securely (`saas-private.json`)
3. Persist NATS configuration (`nats-config.json`)
4. Persist JWKS document (`jwks.json`)

## Architecture

### Single Trust Anchor

The SaaS is the single source of truth for the control plane:
- RSA keypair signs bootstrap JWTs (browsers → agents)
- NKEY seed signs NATS JWTs (operator → accounts → users)
- No runtime SaaS↔NATS dependency (all config is static)

### Account Keypair Split

The NATS account keypair is generated once and split:
- **Private** (seed) → SaaS infrastructure (signs NATS JWTs)
- **Public** → nats-server configuration (verifies user JWTs)

This eliminates SaaS↔NATS runtime dependency.

### Trust Chain Flow

```
setupTrustChain (offline, once)
  ↓
  ├─ RSA keypair generation (RS256)
  │   ├─ Private → SaaS infrastructure
  │   └─ Public → JWKS endpoint
  │
  ├─ NKEY seed generation (Ed25519/X25519)
  │   ├─ Private seed → SaaS infrastructure
  │   └─ Public NKEY → nats-server resolver config
  │
  └─ NATS JWT issuance
      ├─ Operator JWT (signed by operator NKEY)
      └─ Account JWT (signed by operator NKEY)
```

## Installation Notes

Due to npm registry permission issues in some environments, you may need to:

1. Use an alternative registry: `npm install --registry=https://registry.yarnpkg.com`
2. Or install dependencies manually: `npm install typescript @types/node vitest`

## Testing

Run the test suite:

```bash
npm test
```

The tests verify:
- RSA keypair generation with valid PEM format
- NKEY seed generation with correct format
- Operator/account JWT emission with required claims
- Resolver config mapping account NKEY to account JWT
- JWKS document with RSA public key
- Separation of private vs. public artifacts

## Security Considerations

1. **Private Material**: `saas-private.json` contains sensitive keys. Store using:
   - Environment variables (for development)
   - Secret manager (e.g., AWS Secrets Manager, HashiCorp Vault)
   - Hardware security module (HSM) for production

2. **Public Configuration**: `nats-config.json` and `jwks.json` contain only public keys and can be:
   - Committed to infrastructure repos
   - Published openly at JWKS endpoints
   - Shared with ops teams for nats-server configuration

3. **Key Rotation**: Deferred per seed specification. Re-run `setupTrustChain` and:
   - Update SaaS infrastructure with new private keys
   - Update nats-server with new public config
   - Update JWKS endpoint with new public keys
   - Re-enroll agents with new credentials

## Next Steps

After running `setupTrustChain`:

1. Store `saas-private.json` securely
2. Load `nats-config.json` into nats-server
3. Publish `jwks.json` at `https://your-saas.com/.well-known/jwks.json`
4. Implement RFC 8628 device flow enrollment (AC 2)
5. Implement bootstrap JWT issuance (AC 4)
6. Test plugin enrollment and E2E connectivity (AC 6)

## AC 1 Status

✅ **COMPLETED**: SaaS setupTrustChain generates RS256 keypair + NATS account signing seed and emits operator/account JWT + resolver config + JWKS.

This implementation fulfills AC 1 of the Phase B control plane seed specification.
