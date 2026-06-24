# AC 2 Plugin Completion Report: RFC 8628 Device Flow Enrollment

## Status: ✅ COMPLETED

## Plugin-Side Implementation Summary

### Modules Implemented

#### 1. Enrollment Client (`packages/plugin/src/enrollment-client.ts`)

**Purpose**: Plugin-side enrollment orchestration

**Key Features:**
- ✅ X25519 identity key generation on first boot
- ✅ RFC 8628 device flow initiation (/enroll)
- ✅ Polling for operator approval (/poll)
- ✅ Credential persistence (0o600 permissions)
- ✅ Auto-reconnection without re-pairing

**Public API:**
```typescript
const client = new EnrollmentClient({
  saasEnrollUrl: 'https://saas.com/api/enroll',
  saasPollUrl: 'https://saas.com/api/poll',
  tenant: 'tenant-123',
});

// Perform enrollment (or load existing credentials)
const enrollment = await client.enroll();

// Get identity key
const identityKey = client.getIdentityKey();

// Get NATS credentials
const creds = client.getNatsCredentials();

// Get peer ID
const peerId = client.getPeerId();
```

#### 2. Enrolled NATS Connection (`packages/plugin/src/enrolled-nats-connection.ts`)

**Purpose**: Integrated enrollment + NATS connection

**Key Features:**
- ✅ One-call enrollment + connection
- ✅ First-boot detection and auto-enrollment
- ✅ Credential reuse on restart
- ✅ NATS connection with user JWT

**Public API:**
```typescript
const connection = await createEnrolledNatsConnection({
  saasEnrollUrl: 'https://saas.com/api/enroll',
  saasPollUrl: 'https://saas.com/api/poll',
  natsUrl: 'wss://nats.example.com',
  tenant: 'tenant-123',
});

// Use transport for NATS pub/sub
connection.transport.publish('webchannel.tenant-123.outbound.test', payload);
```

### Security Properties

#### ✅ Ingress-Free
- Plugin only makes outbound HTTPS calls
- No listening sockets or inbound connections
- All communication initiated by plugin

#### ✅ No Secret Pasting
- Operator approves via web UI
- No copy-paste of credentials
- Plugin receives credentials automatically

#### ✅ Identity Key Protection
- X25519 key pair generated locally
- Private key never transmitted
- Stored with restrictive permissions (0o600)

#### ✅ Seamless Reconnection
- Credentials persisted locally
- No re-pairing on restart
- Direct NATS authentication

### Credential Storage

**Location:** `~/.openclaw-webchannel/credentials.json`

**Format:**
```json
{
  "identityKey": {
    "publicKey": "base64url-encoded-x25519-public-key",
    "privateKey": "base64url-encoded-x25519-private-key"
  },
  "enrollment": {
    "creds": {
      "userJwt": "nats-user-jwt",
      "userSeed": "U...nkey-seed",
      "permissions": {
        "pub": ["webchannel.tenant-123.outbound.>"],
        "sub": ["webchannel.tenant-123.inbound.>"]
      }
    },
    "peerId": "uuid-v4-peer-id",
    "jwksUrl": "https://saas.com/.well-known/jwks.json",
    "bootstrapUrl": "https://saas.com/bootstrap"
  },
  "tenant": "tenant-123",
  "agentId": "optional-agent-id",
  "saasEnrollUrl": "https://saas.com/api/enroll",
  "saasPollUrl": "https://saas.com/api/poll"
}
```

**Permissions:** `0o600` (owner read/write only)

### Enrollment Flow

#### First Boot (No Credentials):
1. Generate X25519 identity key pair
2. Call POST /enroll with public key
3. Receive device_code + user_code + verification_uri_complete
4. Display user code and verification URI to operator
5. Poll POST /poll with device_code every 5 seconds
6. Operator approves enrollment at verification URI
7. Receive NATS user credentials + peer ID
8. Store credentials locally
9. Connect to NATS with user JWT

#### Restart (Existing Credentials):
1. Load credentials from `~/.openclaw-webchannel/credentials.json`
2. Skip enrollment process
3. Use stored NATS user credentials
4. Connect to NATS with user JWT

### Integration with Existing Plugin

The enrollment modules integrate seamlessly with existing plugin infrastructure:

**With NATS Transport:**
```typescript
import { createEnrolledNatsConnection } from './enrolled-nats-connection.js';

const connection = await createEnrolledNatsConnection({
  saasEnrollUrl: 'https://saas.com/api/enroll',
  saasPollUrl: 'https://saas.com/api/poll',
  natsUrl: 'wss://nats.example.com',
  tenant: 'tenant-123',
});

// Use connection.transport just like existing NatsTransport
connection.transport.subscribe('webchannel.tenant-123.inbound.>');
connection.transport.publish('webchannel.tenant-123.outbound.test', payload);
```

**With E2E Crypto:**
```typescript
// Get identity key for E2E encryption
const identityKey = connection.identityKey;

// Use existing crypto modules
import { deriveSharedSecret, hkdfSha256, encrypt } from './e2e-crypto.js';

const sharedSecret = deriveSharedSecret(identityKey.privateKey, peerPublicKey);
const sessionKey = hkdfSha256(sharedSecret, null, 'webchannel-v1', 32);
```

### Test Coverage

**Comprehensive tests in `packages/plugin/src/enrollment-client.test.ts`:**
- ✅ First-boot enrollment flow
- ✅ Identity key generation
- ✅ Polling with correct intervals
- ✅ Credential persistence
- ✅ Credential loading on restart
- ✅ NATS credential retrieval
- ✅ Peer ID retrieval
- ✅ Error handling (HTTP, denial, expiration)
- ✅ Directory creation
- ✅ File permissions (0o600)

### Usage Example

**Complete plugin startup with enrollment:**

```typescript
import { createEnrolledNatsConnection } from './enrolled-nats-connection.js';

async function startPlugin() {
  console.log('Starting WebChannel plugin...');

  // Step 1: Enroll (or load existing credentials) + connect to NATS
  const connection = await createEnrolledNatsConnection({
    saasEnrollUrl: 'https://saas.com/api/enroll',
    saasPollUrl: 'https://saas.com/api/poll',
    natsUrl: 'wss://nats.example.com',
    tenant: 'tenant-123',
    agentId: 'my-agent',
  });

  console.log('Connected to NATS');
  console.log('Peer ID:', connection.enrollment.peerId);

  // Step 2: Use transport for NATS pub/sub
  connection.transport.subscribe('webchannel.tenant-123.inbound.>');

  connection.transport.on('message', (msg) => {
    console.log('Received message:', msg);
    // Handle inbound messages
  });

  // Step 3: Publish outbound messages
  connection.transport.publish(
    'webchannel.tenant-123.outbound.test',
    Buffer.from('Hello, WebChannel!')
  );

  // Step 4: Keep connection alive
  process.on('SIGINT', () => {
    connection.transport.disconnect();
    process.exit(0);
  });
}

startPlugin().catch(console.error);
```

## Conclusion

The plugin-side implementation of AC 2 provides:

1. **Secure Onboarding**: RFC 8628 compliant, no secret pasting
2. **Identity Management**: X25519 key generation and storage
3. **Credential Persistence**: Local storage with restrictive permissions
4. **Seamless Reconnection**: No re-pairing required
5. **Easy Integration**: Drop-in replacement for existing NATS connection
6. **Type Safety**: Full TypeScript types
7. **Comprehensive Tests**: Complete test coverage

The plugin can now perform secure, ingress-free onboarding and auto-reconnect to NATS without operator intervention after first approval.

[TASK_COMPLETE]
