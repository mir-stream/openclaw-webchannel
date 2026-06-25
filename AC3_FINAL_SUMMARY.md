# AC 3 Implementation Summary: SaaS-issued NATS User JWT/creds + Tenant-Scoped Permissions

## Status: ✅ FULLY COMPLETED

AC 3 has been fully implemented and verified. SaaS now issues NATS user JWT/credentials with tenant-scoped permissions that are enforced by real nats-server.

## Quick Reference

### Implementation Files
- **Core Logic**: `packages/saas/src/device-flow-enrollment.ts` (lines 401-441)
- **Unit Tests**: `packages/saas/src/nats-user-jwt.test.ts` (265 lines)
- **Integration Tests**: `packages/saas/src/nats-permissions-realserver.test.ts` (516 lines)

### Key Achievements
✅ NATS user credential generation (user NKEY + signed JWT)
✅ Tenant-scoped pub/sub permissions (`webchannel.{tenant}.*`)
✅ Real nats-server enforcement (not fake broker)
✅ Cross-tenant isolation (tenants cannot access each other's subjects)
✅ Complete test coverage (unit + integration)

## What AC 3 Does

**Problem**: Without AC 3, all plugins could potentially access all subjects, creating security and privacy risks.

**Solution**: SaaS issues NATS user credentials with tenant-scoped permissions during enrollment. Real nats-server enforces these permissions at the broker level.

**Result**: Each tenant is isolated to their own subject namespace (`webchannel.{tenant}.*`). Cross-tenant traffic is rejected by nats-server with permission errors.

## Permission Model

### Subject Namespace Pattern
```
webchannel.{tenant}.{direction}.{peerId}
```

**Examples**:
- `webchannel.tenant-a.outbound.peer-123` - agent → browser messages
- `webchannel.tenant-a.inbound.peer-123` - browser → agent messages
- `webchannel.tenant-b.outbound.peer-456` - tenant B's agent messages

### Tenant-Scoped Permissions
Each enrolled plugin receives credentials with:
- **Publish**: `webchannel.{tenant}.outbound.>` (agent → browser)
- **Subscribe**: `webchannel.{tenant}.inbound.>` (browser → agent)

**Isolation Guarantees**:
- Tenant A CANNOT publish to `webchannel.tenant-b.*`
- Tenant A CANNOT subscribe to `webchannel.tenant-b.*`
- Real nats-server enforces these permissions at the broker level

## Implementation Details

### 1. Credential Generation

**Location**: `DeviceFlowEnrollment.generateNatsUserCredentials()`

```typescript
// Step 1: Generate user NKEY (U... category)
const userSeed = await this.generateNkeyUserSeed();
const userPublicKey = this.deriveNkeyPublic(userSeed);

// Step 2: Build JWT claims with tenant-scoped permissions
const userClaims = {
  iss: accountPublicKey,  // Issuer: account public NKEY
  name: `user-${tenant}-${agentId}`,
  sub: userPublicKey,      // Subject: user public NKEY
  nats: {
    pub: { allow: [`webchannel.${tenant}.outbound.>`] },
    sub: { allow: [`webchannel.${tenant}.inbound.>`] },
  },
};

// Step 3: Sign JWT with account NKEY seed
const userJwt = await this.signNatsUserJwt(userClaims, accountSeed);

// Step 4: Return credentials with embedded permissions
return { userJwt, userSeed, permissions };
```

### 2. Trust Chain Integration

**Flow**:
```
AC 1 (setupTrustChain)
  ├─ Generates: operator JWT + account JWT + resolver + account seed
  └─ Account seed signs user JWTs

AC 2 (Device Flow Enrollment)
  ├─ Stores trust chain in enrollment service
  └─ Approves enrollment requests

AC 3 (NATS User Credentials)
  ├─ Generates user NKEY + JWT per enrollment
  ├─ Scopes permissions to tenant
  └─ Real nats-server enforces permissions
```

### 3. Permission Enforcement by NATS

**Real nats-server Process**:
1. Load operator JWT + account JWT + resolver config (from AC 1)
2. Client connects with user JWT (from AC 3)
3. NATS verifies JWT signature using account JWT
4. NATS extracts `nats.pub.allow` and `nats.sub.allow` from JWT
5. NATS allows only matching pub/sub operations
6. Cross-tenant operations return "Permissions Violation" error

## Test Coverage

### Unit Tests (265 lines)
**File**: `packages/saas/src/nats-user-jwt.test.ts`

Tests:
- ✅ Credential structure verification
- ✅ JWT claims structure validation
- ✅ Unique credentials per enrollment
- ✅ Tenant-scoped permission correctness
- ✅ User NKEY seed format validation

### Integration Tests (516 lines)
**File**: `packages/saas/src/nats-permissions-realserver.test.ts`

Tests:
- ✅ Real nats-server startup with JWT authentication
- ✅ Tenant can subscribe to own subjects
- ✅ Tenant is denied subscription to other tenant subjects
- ✅ Tenant can publish to own subjects
- ✅ Tenant is denied publish to other tenant subjects
- ✅ Cross-tenant isolation (A and B cannot interfere)

**Note**: Integration tests require real nats-server binary. Install with `brew install nats-server`.

## How to Use

### 1. Generate Trust Chain (AC 1)
```bash
cd packages/saas
npm run build
npm run setup-trust-chain
# Outputs: operator.jwt, account.jwt, resolver.conf, JWKS
```

### 2. Start SaaS Enrollment Server (AC 2)
```bash
node packages/saas/dist/reference/enrollment-server.js
# Runs on http://localhost:3000
```

### 3. Run Plugin Enrollment (AC 2)
```bash
node packages/plugin/dist/examples/enrollment-example.ts
# Displays user code and approval URL
```

### 4. Verify Permission Enforcement (AC 3)
```bash
npm test -- packages/saas/src/nats-permissions-realserver.test.ts
# Starts real nats-server and tests tenant isolation
```

## Verification Checklist

- ✅ **Trust Chain**: AC 1 setupTrustChain generates account seed for signing
- ✅ **Enrollment**: AC 2 enrollment service generates credentials upon approval
- ✅ **Credentials**: User NKEY + JWT with tenant-scoped permissions
- ✅ **Permissions**: `webchannel.{tenant}.outbound.>` and `webchannel.{tenant}.inbound.>`
- ✅ **Enforcement**: Real nats-server enforces permissions (not fake broker)
- ✅ **Isolation**: Cross-tenant pub/sub rejected with permission errors
- ✅ **Tests**: Unit tests (265 lines) + integration tests (516 lines)
- ✅ **Types**: Complete TypeScript types in `device-flow-types.ts`

## Architecture Compliance

### Single Trust Anchor ✅
- SaaS is the sole authority for credential issuance
- User JWTs signed by SaaS-controlled account NKEY seed
- No third-party trust dependencies

### Real NATS Isolation ✅
- Permissions enforced by real nats-server (not application logic)
- Tenant-scoped pub/sub permissions at broker level
- Cross-tenant traffic rejected with permission errors

### Zero Secret Pasting ✅
- Credentials generated during device flow enrollment (AC 2)
- Operator approval via web UI (no secret copying)
- Plugin retrieves credentials via polling

### Brownfield Fidelity ✅
- Phase A modules preserved (no changes to crypto/transport)
- AC 3 adds only control plane logic
- Real nats-server interop validated

## Integration with Other ACs

| AC | Integration Point |
|----|-------------------|
| AC 1 | Provides account seed for signing user JWTs |
| AC 2 | Enrollment service calls `generateNatsUserCredentials()` |
| AC 4 | Uses peerId from enrollment for bootstrap JWT subject |
| AC 5 | NATS credentials used for E2E crypto channel |
| AC 6 | Real-HTTP device-flow E2E tests use these credentials |

## Conclusion

AC 3 is **FULLY COMPLETED** and provides:

1. ✅ **SaaS-issued NATS user credentials** - User NKEY + JWT signed by account seed
2. ✅ **Tenant-scoped permissions** - Each tenant isolated to `webchannel.{tenant}.*` subjects
3. ✅ **Real nats-server enforcement** - Permissions enforced by broker, not application logic
4. ✅ **Cross-tenant isolation** - Tenants cannot access each other's subjects
5. ✅ **Complete test coverage** - Unit tests (265 lines) + integration tests (516 lines)
6. ✅ **Type safety** - Full TypeScript types and interfaces

The WebChannel system now has **real NATS-based tenant isolation** where:
- Each tenant gets scoped credentials upon enrollment
- Real nats-server enforces permissions at the broker level
- Cross-tenant traffic is rejected with permission errors
- No fake broker logic or application-level checks

**Next Steps**: AC 5 and AC 6 can now use these tenant-scoped NATS credentials for E2E crypto and testing.

**[TASK_COMPLETE]**
