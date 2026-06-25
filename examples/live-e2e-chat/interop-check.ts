/**
 * Interop check: the browser @noble crypto (web/e2e-crypto.ts) MUST be
 * byte-compatible with the plugin's node:crypto crypto (packages/plugin/src/
 * e2e-crypto.ts). If this passes, a browser can E2E-talk to a node agent.
 *
 * Run: npm run interop  (from examples/live-e2e-chat)
 */

import * as node from "../../packages/plugin/src/e2e-crypto.js";
import * as web from "./web/e2e-crypto.js";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failures++;
}
const eq = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const td = new TextDecoder();
const te = new TextEncoder();

// 1. X25519 ECDH agreement across implementations.
const agent = node.generateKeyPair(); // agent uses node crypto
const browser = web.generateKeyPair(); // browser uses @noble

const secretAgentSide = node.deriveSharedSecret(agent.privateKey, browser.publicKey);
const secretBrowserSide = web.deriveSharedSecret(browser.privateKey, agent.publicKey);
check("X25519 ECDH agrees (node priv×noble pub == noble priv×node pub)", eq(secretAgentSide, secretBrowserSide));

// 2. HKDF-SHA256 agreement (salt=null path).
const INFO = "webchannel-conversation-v1";
const keyNode = node.hkdfSha256(secretAgentSide, null, INFO, 32);
const keyWeb = web.hkdfSha256(secretBrowserSide, null, INFO, 32);
check("HKDF-SHA256 agrees (salt=null → 32 zero bytes)", eq(keyNode, keyWeb));

// 3. node encrypt → browser decrypt (no AAD).
{
  const pt = te.encode("hello from the agent");
  const { ciphertext, nonce, tag } = node.encrypt(keyNode, pt);
  const back = web.decrypt(keyWeb, nonce, ciphertext, tag);
  check("node encrypt → @noble decrypt (no AAD)", td.decode(back) === "hello from the agent");
}

// 4. browser encrypt → node decrypt (no AAD).
{
  const pt = te.encode("hello from the browser");
  const { ciphertext, nonce, tag } = web.encrypt(keyWeb, pt);
  const back = node.decrypt(keyNode, nonce, ciphertext, tag);
  check("@noble encrypt → node decrypt (no AAD)", td.decode(back) === "hello from the browser");
}

// 5. node encrypt → browser decrypt (with AAD — e.g. the NATS subject).
{
  const aad = te.encode("webchannel.demo.agent-1.user-42.out");
  const pt = te.encode("AAD-bound message");
  const { ciphertext, nonce, tag } = node.encrypt(keyNode, pt, aad);
  const back = web.decrypt(keyWeb, nonce, ciphertext, tag, aad);
  check("node encrypt → @noble decrypt (with AAD)", td.decode(back) === "AAD-bound message");
}

// 6. browser encrypt → node decrypt (with AAD).
{
  const aad = te.encode("webchannel.demo.agent-1.user-42.in");
  const pt = te.encode("AAD round-trip");
  const { ciphertext, nonce, tag } = web.encrypt(keyWeb, pt, aad);
  const back = node.decrypt(keyNode, nonce, ciphertext, tag, aad);
  check("@noble encrypt → node decrypt (with AAD)", td.decode(back) === "AAD round-trip");
}

// 7. AAD mismatch MUST fail authentication (tamper detection).
{
  const pt = te.encode("tamper test");
  const { ciphertext, nonce, tag } = web.encrypt(keyWeb, pt, te.encode("subject-A"));
  let threw = false;
  try {
    node.decrypt(keyNode, nonce, ciphertext, tag, te.encode("subject-B"));
  } catch {
    threw = true;
  }
  check("AAD mismatch is rejected (Poly1305 tag fails)", threw);
}

console.log(failures === 0 ? "\nALL INTEROP CHECKS PASSED ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
