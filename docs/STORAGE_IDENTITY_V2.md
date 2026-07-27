# Storage Identity v2 contract

This document fixes the common identity contract that issue #63
(credential/config binding) and issue #71 (tenant-aware persisted state) will
consume. The executable contract lives in
`packages/plugin/src/storage-identity.ts`.

This foundation does **not** change runtime behavior, persistence paths, file
formats, or package versions. It does not resolve either issue by itself.

## 1. Logical storage scope

One logical account store is identified by the exact tuple:

```text
(tenant, accountId)
```

- `tenant` is the signed tenant and NATS subject token. It is case-sensitive,
  is never trimmed or canonicalized, and must satisfy the existing safe subject
  token contract.
- `accountId` is the already-resolved runtime/JWT-audience id. The persistence
  boundary validates the existing account-id contract but never silently
  lowercases or otherwise rewrites it.
- SaaS, issuer, relay, and agent key facts do not enlarge the physical
  namespace. They bind credentials inside that namespace.

Future secret-bearing documents embed this exact metadata and verify it before
returning secrets. A derived directory id is only an index; it is never proof of
ownership by itself.

## 2. Namespace id

`deriveStorageNamespaceId()` hashes:

1. a versioned domain separator;
2. the exact UTF-8 tenant;
3. the exact UTF-8 account id.

Every component is prefixed with its byte length before SHA-256. The result is a
fixed `v2_<base64url-sha256>` path component. Length framing prevents tuple
segmentation ambiguity, while the embedded exact metadata detects a
misdirected document or hypothetical digest collision.

This contract exposes only the component id. Issue #71 owns the future root
layout, migration, backup, permissions, and concurrency rules.

## 3. Credential binding

A complete v2 credential identity contains:

| Field | Meaning | Comparison |
| --- | --- | --- |
| `storage.tenant` | Signed tenant/routing boundary | Exact |
| `storage.accountId` | Runtime account/JWT audience | Exact |
| `binding.saasBaseUrl` | Enrollment SaaS base | Exact after removing trailing `/` |
| `binding.deliveredIssuer` | Issuer delivered by enrollment | Exact after removing trailing `/` |
| `binding.relayUrl` | Delivered relay/dial identity | Exact |
| `binding.agentPublicKey` | SaaS-attested agent public key | Exact |

`deliveredIssuer` and `relayUrl` may be explicitly `null` only when that
enrollment generation genuinely did not deliver the fact. A missing property is
not the same as `null`: it is incomplete legacy metadata.

The comparison never infers that SaaS, issuer, JWKS, or relay hosts should be
equal. Custom-domain and proxy deployments declare each fact independently.
Only the two already documented trailing-slash equivalences above are applied.
JWKS verifier configuration is not an enrollment-material identity field and
must be validated separately by Track A.

Diagnostics expose status/reason codes and field names only. They never copy
URLs, keys, JWTs, NKEY seeds, private keys, or a raw candidate into a result or
error message.

## 4. Inspection taxonomy

The pure inspection API returns one of:

- `match`: a complete valid identity matches the expected facts;
- `mismatch`: a complete valid identity differs, with non-secret field names;
- `unbound`: no v2 identity marker is present, as with a legacy document;
- `incomplete`: a v2 marker is present but required identity facts are absent;
- `invalid`: the shape, version, or field value violates the contract.

These are facts, not remediation decisions. In particular, `unbound` or
`incomplete` never means a legacy key belongs to the current tuple. Track B must
establish provenance separately before migrating state.

Likewise, `match` proves equality only for the facts that were present. A
consumer must still reject an unavailable (`null`) fact whenever its own
security boundary requires that fact to be proven.

## 5. Consumer responsibilities

Track A (#63) will:

- derive the expected binding from effective config plus delivered enrollment
  facts;
- inspect credentials before setup skips enrollment and again before runtime
  serves;
- fail before credential/network use on mismatch or unproven metadata;
- provide sanitized diagnostics and an explicit replacement flow.

Track B (#71) will:

- pass tenant into every store constructor/loader;
- choose the v2 root layout using the namespace id;
- embed and verify exact scope metadata in both credential and conversation-key
  documents;
- prove legacy ownership before a crash-safe migration;
- keep backups and preserve strict directory/file permissions.

Existing `credentialPath` continues to mean one exact credentials file. It must
not be silently reinterpreted as an account-state directory. A future override
that relocates both stores is a separate tuple-scoped root option.

## 6. Settled downstream rollout decisions

These constraints are recorded here for the two tracks but are not implemented
by this foundation:

- A root written in v2 is not shared with an old plugin binary. Cutover is
  stop-all, one-way migration, then restart on the new version.
- A legacy conversation-key store whose tenant ownership cannot be proven is
  archived and not adopted. The affected scope starts with a fresh key and
  devices re-register.
- Issue #72 rotation quarantines pre-rotation online history and starts fresh
  history under the new epoch. Historical recovery, if ever required, is a
  separate offline facility.
- Epoch-incapable and epoch-capable browser clients do not coexist at cutover;
  client and plugin upgrade together.

## 7. Explicit non-goals

This contract performs no filesystem or network I/O. It does not implement:

- credential or conversation-key v2 readers/writers;
- migration, locking, backup, atomic persistence, or `storageRoot`;
- setup, doctor, readiness, runtime, or re-enrollment wiring;
- issue #60 enrollment checkpoints or crash recovery;
- credential revocation, key epochs, history changes, or client protocol work.
