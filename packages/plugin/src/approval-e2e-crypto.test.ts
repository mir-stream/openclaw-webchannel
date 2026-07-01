/**
 * Approval E2E Crypto Unit Tests — Sub-AC 7.1
 *
 * Verify that approval request/decision/resolved payloads are:
 *   (A) Encrypted before publish — the serialized NATS wire bytes contain ZERO
 *       plaintext approval content (no title, prompt, options, decision, etc.).
 *   (B) Decryptable on receive — round-trip recovers the exact original payload.
 *   (C) AAD-bound — wrong approvalId as AAD fails authentication.
 *   (D) Key-isolated — wrong session key fails authentication.
 *
 * Zero-plaintext guarantee coverage
 * ──────────────────────────────────
 * Each test inspects the raw serialized envelope (what would be passed to
 * NatsTransport.publish()) and asserts that:
 *   - No approval-specific field value appears in the JSON wire string.
 *   - The `content` block contains only nonce / ciphertext / tag.
 *   - Routing metadata (accountId / tenant / sub / messageId / envelopeType) IS
 *     present as plaintext (allowed per the security model).
 *
 * Tests
 * ──────
 *   1.  approval_request: wire bytes contain zero plaintext approval content
 *   2.  approval_request: round-trip decryption recovers exact payload
 *   3.  approval_decision: wire bytes contain zero plaintext decision content
 *   4.  approval_decision: round-trip decryption recovers decision body
 *   5.  approval_resolved: wire bytes contain zero plaintext resolved content
 *   6.  approval_resolved: round-trip decryption recovers resolved body
 *   7.  Full approval flow: request → decision → resolved all as ciphertext
 *   8.  AAD binding: correct approvalId succeeds; wrong approvalId fails
 *   9.  Key isolation: wrong session key fails authentication
 *  10.  Key domain separation: approval key ≠ conversation key even with same ECDH secret
 *  11.  Content block structural invariants (nonce/ciphertext/tag only)
 *  12.  Routing metadata is plaintext-readable in wire bytes
 *  13.  approvalId as AAD is NOT stored in the envelope content block
 *  14.  Two encryptions of same payload produce distinct nonces (no nonce reuse)
 *  15.  serialize → deserialize round-trip preserves all envelope fields
 */

import { describe, it, expect } from "vitest";

import {
  encryptApprovalRequest,
  encryptApprovalDecision,
  encryptApprovalResolved,
  decryptApprovalRequest,
  decryptApprovalDecision,
  decryptApprovalResolved,
  serializeApprovalEnvelope,
  deserializeApprovalEnvelope,
  APPROVAL_KEY_INFO,
} from "./approval-e2e-crypto.js";
import type { ApprovalRequestBody, ApprovalDecisionBody, ApprovalResolvedBody } from "./approval-e2e-crypto.js";
import {
  generateKeyPair,
  deriveSharedSecret,
  hkdfSha256,
} from "./e2e-crypto.js";
import type { MessageEnvelope } from "./e2e-envelope.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** HKDF-derive a 32-byte key from raw ECDH shared secret + info string. */
function deriveKey(
  myPriv: Uint8Array,
  theirPub: Uint8Array,
  info: string,
): Uint8Array {
  return hkdfSha256(deriveSharedSecret(myPriv, theirPub), null, info, 32);
}

/** Fixed 32-byte test key (both sides share this in unit tests). */
const TEST_KEY = new Uint8Array(32).fill(0x77);

/** Approval-key-info constant re-exported for documentation in tests. */
const APPROVAL_INFO = APPROVAL_KEY_INFO;

/** Base routing fields shared across tests. */
const BASE_ROUTING = {
  accountId:   "agent-007",
  tenant:    "tenant-acme",
  sub:       "user-42",
  messageId: "approval-abc123",
  ts:        1_718_000_000_000,
} as const;

/** A realistic approval_request payload (matches ApprovalRequestPayload shape). */
const SAMPLE_REQUEST: ApprovalRequestBody = {
  id:          "approval-abc123",
  kind:        "exec",
  title:       "Approve confidential shell command",
  description: "The agent wants to run: rm -rf /sensitive/data",
  prompt:      "Approve confidential shell command: rm -rf /sensitive/data",
  options: [
    { decision: "allow-once",   label: "Allow Once",   style: "success" },
    { decision: "allow-always", label: "Allow Always", style: "primary" },
    { decision: "deny",         label: "Deny",         style: "danger"  },
  ],
  expiresAtMs: 1_718_000_060_000,
};

/** A realistic approval_decision payload. */
const SAMPLE_DECISION: ApprovalDecisionBody = {
  approvalId: "approval-abc123",
  decision:   "allow-once",
};

/** A realistic approval_resolved payload. */
const SAMPLE_RESOLVED: ApprovalResolvedBody = {
  approvalId: "approval-abc123",
  decision:   "allow-once",
};

/**
 * Strings that MUST NOT appear anywhere in the serialized NATS wire bytes.
 * These are the sensitive fields of the approval payloads.
 */
const SECRET_STRINGS = [
  "confidential shell command",    // request title + prompt
  "rm -rf /sensitive/data",        // command preview in description/prompt
  "allow-once",                    // decision value
  "allow-always",                  // option decision
  "The agent wants to run",        // description content
  "Allow Once",                    // option label
  "Allow Always",                  // option label
];

/** Assert content block is structurally opaque: only nonce/ciphertext/tag. */
function assertContentOpaque(env: MessageEnvelope | null, label: string): void {
  expect(env, `[${label}] envelope must not be null`).not.toBeNull();
  if (!env) return;

  const keys = Object.keys(env.content).sort();
  expect(keys, `[${label}] content must have exactly {ciphertext, nonce, tag}`).toEqual(
    ["ciphertext", "nonce", "tag"],
  );
  expect(typeof env.content.nonce,      `[${label}] nonce must be string`).toBe("string");
  expect(typeof env.content.ciphertext, `[${label}] ciphertext must be string`).toBe("string");
  expect(typeof env.content.tag,        `[${label}] tag must be string`).toBe("string");
  expect(env.content.nonce.length,      `[${label}] nonce non-empty`).toBeGreaterThan(0);
  expect(env.content.ciphertext.length, `[${label}] ciphertext non-empty`).toBeGreaterThan(0);
  expect(env.content.tag.length,        `[${label}] tag non-empty`).toBeGreaterThan(0);

  // No plaintext-content fields inside the content block.
  const c = env.content as Record<string, unknown>;
  for (const k of ["text", "plaintext", "body", "decision", "prompt", "title", "data", "payload", "options"]) {
    expect(c[k], `[${label}] content must not have "${k}" field`).toBeUndefined();
  }
}

/** Assert that none of the secret strings appear in a raw JSON wire string. */
function assertNoPlaintext(wireJson: string, label: string): void {
  for (const secret of SECRET_STRINGS) {
    expect(wireJson, `[${label}] "${secret.slice(0, 30)}" must not appear on wire`).not.toContain(secret);
  }
}

// ---------------------------------------------------------------------------
// 1. approval_request: wire bytes contain zero plaintext approval content
// ---------------------------------------------------------------------------

describe("encryptApprovalRequest: zero plaintext in serialized wire bytes", () => {
  it(
    "(1) serialized envelope contains no approval request content (title / prompt / options / decision)",
    () => {
      const env     = encryptApprovalRequest(BASE_ROUTING, SAMPLE_REQUEST, TEST_KEY);
      const wireJson = serializeApprovalEnvelope(env).toString("utf8");

      // Core zero-plaintext assertion: none of the sensitive strings appear.
      assertNoPlaintext(wireJson, "approval_request wire");

      // Additional specific field checks.
      expect(wireJson).not.toContain(SAMPLE_REQUEST.title);
      expect(wireJson).not.toContain(SAMPLE_REQUEST.prompt);
      expect(wireJson).not.toContain(SAMPLE_REQUEST.description);
      expect(wireJson).not.toContain(SAMPLE_REQUEST.kind);        // "exec"
      expect(wireJson).not.toContain("expiresAtMs");              // field name
      expect(wireJson).not.toContain("options");                  // options array

      // Content block is structurally opaque.
      assertContentOpaque(env, "approval_request-1");

      // The envelopeType IS plaintext (routing discriminator — not content).
      expect(wireJson).toContain("approval_request");
    },
  );
});

// ---------------------------------------------------------------------------
// 2. approval_request: round-trip decryption recovers exact payload
// ---------------------------------------------------------------------------

describe("decryptApprovalRequest: round-trip recovers original payload", () => {
  it("(2) decrypting the sealed envelope recovers the exact ApprovalRequestBody", () => {
    const env      = encryptApprovalRequest(BASE_ROUTING, SAMPLE_REQUEST, TEST_KEY);
    const recovered = decryptApprovalRequest(env, TEST_KEY);

    expect(recovered.id).toBe(SAMPLE_REQUEST.id);
    expect(recovered.kind).toBe("exec");
    expect(recovered.title).toBe(SAMPLE_REQUEST.title);
    expect(recovered.description).toBe(SAMPLE_REQUEST.description);
    expect(recovered.prompt).toBe(SAMPLE_REQUEST.prompt);
    expect(recovered.expiresAtMs).toBe(SAMPLE_REQUEST.expiresAtMs);
    expect(recovered.options).toHaveLength(3);
    expect(recovered.options[0]!.decision).toBe("allow-once");
    expect(recovered.options[1]!.decision).toBe("allow-always");
    expect(recovered.options[2]!.decision).toBe("deny");
    expect(recovered.options[0]!.label).toBe("Allow Once");
  });

  it("decrypts after serialize→deserialize round-trip (simulates NATS transit)", () => {
    const env       = encryptApprovalRequest(BASE_ROUTING, SAMPLE_REQUEST, TEST_KEY);
    const wireBytes = serializeApprovalEnvelope(env);
    const restored  = deserializeApprovalEnvelope(wireBytes);
    const recovered = decryptApprovalRequest(restored, TEST_KEY);

    // After simulated NATS transit, the payload is still recoverable.
    expect(recovered.title).toBe(SAMPLE_REQUEST.title);
    expect(recovered.prompt).toBe(SAMPLE_REQUEST.prompt);
    expect(recovered.options).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 3. approval_decision: wire bytes contain zero plaintext decision content
// ---------------------------------------------------------------------------

describe("encryptApprovalDecision: zero plaintext in serialized wire bytes", () => {
  it(
    "(3) serialized envelope contains no decision content (approvalId body / decision value)",
    () => {
      const env     = encryptApprovalDecision(BASE_ROUTING, SAMPLE_DECISION, TEST_KEY);
      const wireJson = serializeApprovalEnvelope(env).toString("utf8");

      // The decision value must NOT appear in the wire bytes.
      expect(wireJson).not.toContain("allow-once");
      expect(wireJson).not.toContain("allow-always");
      expect(wireJson).not.toContain("deny");

      // Content block is structurally opaque.
      assertContentOpaque(env, "approval_decision-3");

      // The envelopeType IS plaintext.
      expect(wireJson).toContain("approval_decision");

      // The approvalId appears as routing (messageId) — allowed.
      expect(wireJson).toContain(BASE_ROUTING.messageId);  // plaintext routing
    },
  );
});

// ---------------------------------------------------------------------------
// 4. approval_decision: round-trip decryption recovers decision body
// ---------------------------------------------------------------------------

describe("decryptApprovalDecision: round-trip recovers original body", () => {
  it("(4) decrypting the sealed decision envelope recovers the exact ApprovalDecisionBody", () => {
    const env       = encryptApprovalDecision(BASE_ROUTING, SAMPLE_DECISION, TEST_KEY);
    const wireBytes = serializeApprovalEnvelope(env);
    const restored  = deserializeApprovalEnvelope(wireBytes);
    const recovered = decryptApprovalDecision(restored, TEST_KEY);

    expect(recovered.approvalId).toBe(SAMPLE_DECISION.approvalId);
    expect(recovered.decision).toBe("allow-once");
  });

  it("round-trips all three decision values correctly", () => {
    const decisions = ["allow-once", "allow-always", "deny"] as const;
    for (const dec of decisions) {
      const body: ApprovalDecisionBody = { approvalId: "req-xxx", decision: dec };
      const routing = { ...BASE_ROUTING, messageId: "req-xxx" };
      const env      = encryptApprovalDecision(routing, body, TEST_KEY);
      const wireJson = serializeApprovalEnvelope(env).toString("utf8");

      // None of the decision values appear on the wire.
      expect(wireJson).not.toContain("allow-once");
      expect(wireJson).not.toContain("allow-always");
      expect(wireJson).not.toContain("deny");

      const recovered = decryptApprovalDecision(env, TEST_KEY);
      expect(recovered.decision).toBe(dec);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. approval_resolved: wire bytes contain zero plaintext resolved content
// ---------------------------------------------------------------------------

describe("encryptApprovalResolved: zero plaintext in serialized wire bytes", () => {
  it(
    "(5) serialized envelope contains no resolved content (decision value)",
    () => {
      const env     = encryptApprovalResolved(BASE_ROUTING, SAMPLE_RESOLVED, TEST_KEY);
      const wireJson = serializeApprovalEnvelope(env).toString("utf8");

      // The decision value must NOT appear.
      expect(wireJson).not.toContain("allow-once");

      // Content block is structurally opaque.
      assertContentOpaque(env, "approval_resolved-5");

      // The envelopeType IS plaintext.
      expect(wireJson).toContain("approval_resolved");
    },
  );
});

// ---------------------------------------------------------------------------
// 6. approval_resolved: round-trip decryption recovers resolved body
// ---------------------------------------------------------------------------

describe("decryptApprovalResolved: round-trip recovers original body", () => {
  it("(6) decrypting the sealed resolved envelope recovers the exact ApprovalResolvedBody", () => {
    const env       = encryptApprovalResolved(BASE_ROUTING, SAMPLE_RESOLVED, TEST_KEY);
    const wireBytes = serializeApprovalEnvelope(env);
    const restored  = deserializeApprovalEnvelope(wireBytes);
    const recovered = decryptApprovalResolved(restored, TEST_KEY);

    expect(recovered.approvalId).toBe(SAMPLE_RESOLVED.approvalId);
    expect(recovered.decision).toBe("allow-once");
  });
});

// ---------------------------------------------------------------------------
// 7. Full approval flow: request → decision → resolved all as ciphertext
// ---------------------------------------------------------------------------

describe("Full approval flow: request → decision → resolved — all ciphertext on wire", () => {
  it(
    "(7) all three messages transit as ciphertext; each can be individually decrypted",
    () => {
      const approvalId = "approval-fullflow-007";
      const routing    = { ...BASE_ROUTING, messageId: approvalId };

      const requestBody: ApprovalRequestBody = {
        id:      approvalId,
        kind:    "exec",
        title:   "Approve: confidential DB migration",
        prompt:  "Run confidential migration script?",
        options: [
          { decision: "allow-once", label: "Allow Once", style: "success" },
          { decision: "deny",       label: "Deny",       style: "danger"  },
        ],
      };
      const decisionBody: ApprovalDecisionBody = { approvalId, decision: "allow-once" };
      const resolvedBody: ApprovalResolvedBody = { approvalId, decision: "allow-once" };

      // Agent encrypts approval request.
      const reqEnv  = encryptApprovalRequest(routing, requestBody, TEST_KEY);
      // Browser encrypts approval decision.
      const decEnv  = encryptApprovalDecision(routing, decisionBody, TEST_KEY);
      // Agent encrypts approval resolved.
      const resEnv  = encryptApprovalResolved(routing, resolvedBody, TEST_KEY);

      // Simulate NATS publish: serialize each envelope.
      const reqWire = serializeApprovalEnvelope(reqEnv).toString("utf8");
      const decWire = serializeApprovalEnvelope(decEnv).toString("utf8");
      const resWire = serializeApprovalEnvelope(resEnv).toString("utf8");

      // ── (A) Zero-plaintext at the NATS layer ────────────────────────────────
      for (const [wire, label] of [[reqWire, "req"], [decWire, "dec"], [resWire, "res"]] as const) {
        // Core approval content must not appear.
        expect(wire, `[${label}] title must not appear`).not.toContain("confidential DB migration");
        expect(wire, `[${label}] prompt must not appear`).not.toContain("Run confidential migration");
        expect(wire, `[${label}] decision must not appear`).not.toContain("allow-once");
        expect(wire, `[${label}] label must not appear`).not.toContain("Allow Once");

        // Content block is opaque.
        const env = label === "req" ? reqEnv : label === "dec" ? decEnv : resEnv;
        assertContentOpaque(env, label);
      }

      // ── (B) envelopeType discriminators are plaintext (routing, not content) ─
      expect(reqWire).toContain("approval_request");
      expect(decWire).toContain("approval_decision");
      expect(resWire).toContain("approval_resolved");

      // ── (C) Round-trip decryption recovers each body ───────────────────────
      const reqOut = decryptApprovalRequest(deserializeApprovalEnvelope(reqWire), TEST_KEY, approvalId);
      expect(reqOut.title).toBe("Approve: confidential DB migration");
      expect(reqOut.options).toHaveLength(2);

      const decOut = decryptApprovalDecision(deserializeApprovalEnvelope(decWire), TEST_KEY, approvalId);
      expect(decOut.decision).toBe("allow-once");
      expect(decOut.approvalId).toBe(approvalId);

      const resOut = decryptApprovalResolved(deserializeApprovalEnvelope(resWire), TEST_KEY, approvalId);
      expect(resOut.decision).toBe("allow-once");
    },
  );
});

// ---------------------------------------------------------------------------
// 8. AAD binding: correct approvalId succeeds; wrong approvalId fails
// ---------------------------------------------------------------------------

describe("AAD binding: approvalId cryptographically binds envelope to correlation key", () => {
  it(
    "(8a) decryption succeeds when the same approvalId is used as AAD on both sides",
    () => {
      const approvalId = "approval-aad-test-1";
      const routing    = { ...BASE_ROUTING, messageId: approvalId };

      const env       = encryptApprovalRequest(routing, SAMPLE_REQUEST, TEST_KEY, approvalId);
      const recovered = decryptApprovalRequest(env, TEST_KEY, approvalId);
      expect(recovered.title).toBe(SAMPLE_REQUEST.title);
    },
  );

  it(
    "(8b) decryption fails when a different approvalId is used as AAD (wrong correlation key)",
    () => {
      const approvalId = "approval-aad-test-2";
      const routing    = { ...BASE_ROUTING, messageId: approvalId };

      const env = encryptApprovalRequest(routing, SAMPLE_REQUEST, TEST_KEY, approvalId);
      // Swapping approvalId to a different value must break the Poly1305 tag.
      expect(() => decryptApprovalRequest(env, TEST_KEY, "approval-WRONG-id")).toThrow();
    },
  );

  it(
    "(8c) approval_decision AAD binding: correct approvalId succeeds; wrong fails",
    () => {
      const approvalId = "approval-dec-aad";
      const routing    = { ...BASE_ROUTING, messageId: approvalId };
      const body: ApprovalDecisionBody = { approvalId, decision: "deny" };

      const env = encryptApprovalDecision(routing, body, TEST_KEY, approvalId);
      // Correct AAD.
      const out = decryptApprovalDecision(env, TEST_KEY, approvalId);
      expect(out.decision).toBe("deny");
      // Wrong AAD.
      expect(() => decryptApprovalDecision(env, TEST_KEY, "wrong-approval-id")).toThrow();
    },
  );

  it(
    "(8d) approval_resolved AAD binding: correct approvalId succeeds; wrong fails",
    () => {
      const approvalId = "approval-res-aad";
      const routing    = { ...BASE_ROUTING, messageId: approvalId };
      const body: ApprovalResolvedBody = { approvalId, decision: "allow-always" };

      const env = encryptApprovalResolved(routing, body, TEST_KEY, approvalId);
      const out = decryptApprovalResolved(env, TEST_KEY, approvalId);
      expect(out.decision).toBe("allow-always");
      expect(() => decryptApprovalResolved(env, TEST_KEY, "wrong-approval-id")).toThrow();
    },
  );

  it(
    "(8e) approvalId used as AAD is NOT stored inside the envelope content block",
    () => {
      const approvalId = "approval-aad-leak-check";
      const routing    = { ...BASE_ROUTING, messageId: approvalId };

      const env      = encryptApprovalRequest(routing, SAMPLE_REQUEST, TEST_KEY, approvalId);
      const wireJson = serializeApprovalEnvelope(env).toString("utf8");
      const contentJson = JSON.stringify(env.content);

      // The approvalId appears ONLY in routing (messageId), NOT inside content.
      expect(contentJson).not.toContain(approvalId);
      // But the messageId routing field does contain it (plaintext routing — allowed).
      expect(wireJson).toContain(approvalId);  // as messageId routing
    },
  );
});

// ---------------------------------------------------------------------------
// 9. Key isolation: wrong session key fails authentication
// ---------------------------------------------------------------------------

describe("Key isolation: wrong session key fails authentication", () => {
  it(
    "(9a) decryptApprovalRequest with wrong key throws on Poly1305 tag mismatch",
    () => {
      const env      = encryptApprovalRequest(BASE_ROUTING, SAMPLE_REQUEST, TEST_KEY);
      const wrongKey = new Uint8Array(32).fill(0x11);
      expect(() => decryptApprovalRequest(env, wrongKey)).toThrow();
    },
  );

  it(
    "(9b) decryptApprovalDecision with wrong key throws",
    () => {
      const env      = encryptApprovalDecision(BASE_ROUTING, SAMPLE_DECISION, TEST_KEY);
      const wrongKey = new Uint8Array(32).fill(0x22);
      expect(() => decryptApprovalDecision(env, wrongKey)).toThrow();
    },
  );

  it(
    "(9c) decryptApprovalResolved with wrong key throws",
    () => {
      const env      = encryptApprovalResolved(BASE_ROUTING, SAMPLE_RESOLVED, TEST_KEY);
      const wrongKey = new Uint8Array(32);  // all-zeros
      expect(() => decryptApprovalResolved(env, wrongKey)).toThrow();
    },
  );

  it(
    "(9d) a relay operator with their own X25519 key cannot decrypt any approval payload",
    () => {
      // Real session: agent ↔ browser via X25519 ECDH.
      const agentKP   = generateKeyPair();
      const browserKP = generateKeyPair();
      const agentKey  = deriveKey(agentKP.privateKey,   browserKP.publicKey, APPROVAL_INFO);
      // Symmetric: browser derives the same key.
      const browserKey = deriveKey(browserKP.privateKey, agentKP.publicKey, APPROVAL_INFO);
      expect(Buffer.from(agentKey).toString("hex")).toBe(Buffer.from(browserKey).toString("hex"));

      const env      = encryptApprovalRequest(BASE_ROUTING, SAMPLE_REQUEST, agentKey);
      const wireJson = serializeApprovalEnvelope(env).toString("utf8");

      // Zero plaintext on wire even with real key exchange.
      expect(wireJson).not.toContain(SAMPLE_REQUEST.title);
      expect(wireJson).not.toContain(SAMPLE_REQUEST.prompt);

      // Relay operator generates their OWN key pair.
      const relayKP  = generateKeyPair();
      const relayKey = deriveKey(relayKP.privateKey, agentKP.publicKey, APPROVAL_INFO);

      // Relay's key is genuinely different from the session key.
      expect(Buffer.from(relayKey).toString("hex")).not.toBe(Buffer.from(agentKey).toString("hex"));

      // Relay operator CANNOT decrypt.
      expect(() => decryptApprovalRequest(env, relayKey)).toThrow();

      // Legitimate browser CAN decrypt.
      const recovered = decryptApprovalRequest(env, browserKey);
      expect(recovered.title).toBe(SAMPLE_REQUEST.title);
    },
  );
});

// ---------------------------------------------------------------------------
// 10. Key domain separation: approval key ≠ conversation key
// ---------------------------------------------------------------------------

describe("Key domain separation: approval key is independent of conversation key", () => {
  it(
    "(10) approval key derived with APPROVAL_KEY_INFO differs from conversation key even with same ECDH secret",
    () => {
      const agentKP   = generateKeyPair();
      const browserKP = generateKeyPair();

      const approvalKey = deriveKey(agentKP.privateKey, browserKP.publicKey, APPROVAL_KEY_INFO);
      const convKey     = deriveKey(agentKP.privateKey, browserKP.publicKey, "webchannel-conversation-v1");

      // Keys MUST differ despite same ECDH shared secret (HKDF domain separation).
      expect(Buffer.from(approvalKey).toString("hex")).not.toBe(Buffer.from(convKey).toString("hex"));

      // An envelope encrypted with the approval key must NOT decrypt with the conv key.
      const env = encryptApprovalRequest(BASE_ROUTING, SAMPLE_REQUEST, approvalKey);
      expect(() => decryptApprovalRequest(env, convKey)).toThrow();

      // And vice-versa: conv-encrypted content won't decrypt with approval key.
      const env2 = encryptApprovalRequest(BASE_ROUTING, SAMPLE_REQUEST, convKey);
      expect(() => decryptApprovalRequest(env2, approvalKey)).toThrow();
    },
  );
});

// ---------------------------------------------------------------------------
// 11. Content block structural invariants
// ---------------------------------------------------------------------------

describe("Content block structural invariants: only nonce / ciphertext / tag", () => {
  it(
    "(11a) approval_request envelope content has exactly {nonce, ciphertext, tag} — no other fields",
    () => {
      const env = encryptApprovalRequest(BASE_ROUTING, SAMPLE_REQUEST, TEST_KEY);
      assertContentOpaque(env, "structural-request");
    },
  );

  it("(11b) approval_decision envelope content is structurally opaque", () => {
    const env = encryptApprovalDecision(BASE_ROUTING, SAMPLE_DECISION, TEST_KEY);
    assertContentOpaque(env, "structural-decision");
  });

  it("(11c) approval_resolved envelope content is structurally opaque", () => {
    const env = encryptApprovalResolved(BASE_ROUTING, SAMPLE_RESOLVED, TEST_KEY);
    assertContentOpaque(env, "structural-resolved");
  });

  it("(11d) content.nonce decodes to exactly 12 bytes", () => {
    const env = encryptApprovalRequest(BASE_ROUTING, SAMPLE_REQUEST, TEST_KEY);
    const nonce = Buffer.from(env.content.nonce, "base64url");
    expect(nonce.length).toBe(12);
  });

  it("(11e) content.tag decodes to exactly 16 bytes", () => {
    const env = encryptApprovalRequest(BASE_ROUTING, SAMPLE_REQUEST, TEST_KEY);
    const tag = Buffer.from(env.content.tag, "base64url");
    expect(tag.length).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// 12. Routing metadata is plaintext-readable in wire bytes
// ---------------------------------------------------------------------------

describe("Routing metadata: plaintext-readable for NATS relay routing decisions", () => {
  it(
    "(12) accountId / tenant / sub / messageId / envelopeType are all plaintext in the wire JSON",
    () => {
      const env     = encryptApprovalRequest(BASE_ROUTING, SAMPLE_REQUEST, TEST_KEY);
      const wireJson = serializeApprovalEnvelope(env).toString("utf8");

      expect(wireJson).toContain(BASE_ROUTING.accountId);    // "agent-007"
      expect(wireJson).toContain(BASE_ROUTING.tenant);     // "tenant-acme"
      expect(wireJson).toContain(BASE_ROUTING.sub);        // "user-42"
      expect(wireJson).toContain(BASE_ROUTING.messageId);  // "approval-abc123"
      expect(wireJson).toContain("approval_request");       // envelopeType
      expect(wireJson).toContain('"v":1');                  // schema version
    },
  );
});

// ---------------------------------------------------------------------------
// 13. approvalId as AAD is NOT stored in envelope content block
// ---------------------------------------------------------------------------

describe("AAD is NOT stored in envelope: zero AAD leak into content block", () => {
  it(
    "(13) the approvalId used as AAD does not appear anywhere inside the content block",
    () => {
      const approvalId = "unique-approval-id-xyz";
      const routing    = { ...BASE_ROUTING, messageId: approvalId };

      const env = encryptApprovalRequest(routing, SAMPLE_REQUEST, TEST_KEY, approvalId);

      // The approvalId must NOT be inside the content block.
      const contentJson = JSON.stringify(env.content);
      expect(contentJson).not.toContain(approvalId);
      expect(contentJson).not.toContain("unique-approval-id");

      // It appears ONLY in routing (messageId).
      expect(env.messageId).toBe(approvalId);
    },
  );
});

// ---------------------------------------------------------------------------
// 14. Two encryptions of same payload produce distinct nonces (no nonce reuse)
// ---------------------------------------------------------------------------

describe("Nonce uniqueness: random per encryption call", () => {
  it(
    "(14) two encryptions of the same approval payload produce distinct nonces and distinct ciphertexts",
    () => {
      const env1 = encryptApprovalRequest(BASE_ROUTING, SAMPLE_REQUEST, TEST_KEY);
      const env2 = encryptApprovalRequest(BASE_ROUTING, SAMPLE_REQUEST, TEST_KEY);

      // Random nonces → distinct nonces → distinct ciphertexts.
      expect(env1.content.nonce).not.toBe(env2.content.nonce);
      expect(env1.content.ciphertext).not.toBe(env2.content.ciphertext);
      expect(env1.content.tag).not.toBe(env2.content.tag);

      // Both still decrypt to the same plaintext.
      const r1 = decryptApprovalRequest(env1, TEST_KEY);
      const r2 = decryptApprovalRequest(env2, TEST_KEY);
      expect(r1.title).toBe(SAMPLE_REQUEST.title);
      expect(r2.title).toBe(SAMPLE_REQUEST.title);
    },
  );
});

// ---------------------------------------------------------------------------
// 15. serialize → deserialize round-trip preserves all envelope fields
// ---------------------------------------------------------------------------

describe("serialize → deserialize round-trip: all envelope fields preserved", () => {
  it(
    "(15) serializeApprovalEnvelope → deserializeApprovalEnvelope → decrypt is bit-exact",
    () => {
      const env       = encryptApprovalRequest(BASE_ROUTING, SAMPLE_REQUEST, TEST_KEY);
      const wireBytes = serializeApprovalEnvelope(env);
      const restored  = deserializeApprovalEnvelope(wireBytes);

      // All routing fields preserved.
      expect(restored.v).toBe(1);
      expect(restored.accountId).toBe(BASE_ROUTING.accountId);
      expect(restored.tenant).toBe(BASE_ROUTING.tenant);
      expect(restored.sub).toBe(BASE_ROUTING.sub);
      expect(restored.messageId).toBe(BASE_ROUTING.messageId);
      expect(restored.envelopeType).toBe("approval_request");
      expect(restored.ts).toBe(BASE_ROUTING.ts);

      // Content block preserved.
      expect(restored.content.nonce).toBe(env.content.nonce);
      expect(restored.content.ciphertext).toBe(env.content.ciphertext);
      expect(restored.content.tag).toBe(env.content.tag);

      // Decryption still works on the restored envelope.
      const recovered = decryptApprovalRequest(restored, TEST_KEY);
      expect(recovered.title).toBe(SAMPLE_REQUEST.title);
      expect(recovered.prompt).toBe(SAMPLE_REQUEST.prompt);
      expect(recovered.options).toHaveLength(3);
    },
  );

  it("string payload serializes and deserializes correctly", () => {
    const env       = encryptApprovalDecision(BASE_ROUTING, SAMPLE_DECISION, TEST_KEY);
    const wireStr   = serializeApprovalEnvelope(env).toString("utf8");
    const restored  = deserializeApprovalEnvelope(wireStr);
    const recovered = decryptApprovalDecision(restored, TEST_KEY);
    expect(recovered.decision).toBe("allow-once");
  });
});

// ---------------------------------------------------------------------------
// 16. Bonus: tampered ciphertext / tag detected (integrity protection)
// ---------------------------------------------------------------------------

describe("Integrity protection: tampered envelope is detected before decryption", () => {
  it("(16a) flipping a byte in content.ciphertext throws on decryption", () => {
    const env = encryptApprovalRequest(BASE_ROUTING, SAMPLE_REQUEST, TEST_KEY);
    const ct  = Buffer.from(env.content.ciphertext, "base64url");
    ct[0] ^= 0xff;
    const tampered: MessageEnvelope = {
      ...env,
      content: { ...env.content, ciphertext: ct.toString("base64url") },
    };
    expect(() => decryptApprovalRequest(tampered, TEST_KEY)).toThrow();
  });

  it("(16b) flipping a bit in content.tag throws on decryption", () => {
    const env = encryptApprovalDecision(BASE_ROUTING, SAMPLE_DECISION, TEST_KEY);
    const tag = Buffer.from(env.content.tag, "base64url");
    tag[0] ^= 0x01;
    const tampered: MessageEnvelope = {
      ...env,
      content: { ...env.content, tag: tag.toString("base64url") },
    };
    expect(() => decryptApprovalDecision(tampered, TEST_KEY)).toThrow();
  });

  it("(16c) flipping a byte in content.nonce throws on decryption", () => {
    const env   = encryptApprovalResolved(BASE_ROUTING, SAMPLE_RESOLVED, TEST_KEY);
    const nonce = Buffer.from(env.content.nonce, "base64url");
    nonce[0] ^= 0x01;
    const tampered: MessageEnvelope = {
      ...env,
      content: { ...env.content, nonce: nonce.toString("base64url") },
    };
    expect(() => decryptApprovalResolved(tampered, TEST_KEY)).toThrow();
  });
});
