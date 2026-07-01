/**
 * Browser entry for the INTERACTIVE human-facing chat demo.
 *
 * This is the long-lived sibling of `runAllReal` (browser-jwt-entry.ts): it runs
 * the SAME in-page ALL-REAL setup (X25519 + Ed25519 keygen → mint tenant-scoped
 * NATS user creds from the issuer → mint a PoP bootstrap JWT → construct the
 * PRODUCTION `WebChannelNatsClient` with BOTH `natsCredentials` (NATS-layer NKEY
 * auth) AND `registration` (HTTP PoP register hop) → connect), but instead of
 * sending one message and tearing down, it keeps the client ALIVE and hands back
 * a controller so a human can chat with the agent indefinitely.
 *
 * BROWSER-SAFE ONLY: uses crypto.subtle, fetch, btoa, TextEncoder, WebSocket —
 * no `node:` imports — so it survives the esbuild browser bundle.
 * `WebChannelNatsClient` is itself browser-safe (webcrypto + WebSocket only).
 *
 * The setup logic here is intentionally COPIED from `runAllReal` rather than
 * shared, so the proven headless harness (browser-jwt-entry.ts) is never touched.
 */

import { WebChannelNatsClient } from "./nats-client.js";

/** Options for the interactive demo (runAllReal's opts MINUS text/timeoutMs). */
export type RunDemoOptions = {
  /** JWT-auth NATS WebSocket URL (NKEY challenge-response required). */
  natsUrl: string;
  /** Unified reference issuer base URL (fallback; the same-origin location.origin
   *  is preferred at runtime so the session cookie is never dropped). */
  issuerUrl: string;
  /** Gateway base URL serving the PoP register routes. */
  gwUrl: string;
  accountId: string;
  tenant: string;
  /**
   * IGNORED — the peerId is now derived server-side from the login session
   * (user.uuid). Kept only for config back-compat; the client uses the peerId the
   * /bootstrap response returns.
   */
  peerId?: string;
};

/** Callbacks the host UI provides to receive replies / errors / status updates. */
export type RunDemoCallbacks = {
  /** Called for each decrypted `agent_message` reply text. */
  onReply: (text: string) => void;
  /** Called on any terminal error (e.g. NKEY/PoP rejection). */
  onError: (err: Error) => void;
  /** Called at meaningful transitions (generating keys, fetching creds, …). */
  onStatus: (status: string) => void;
};

/** Controller returned by `runDemo`: the live, multi-send chat handle. */
export type DemoController = {
  /** Send one user message over the persistent client (buffered/sealed per-call). */
  send: (text: string) => void;
  /** Tear down the NATS connection. */
  disconnect: () => void;
};

/** base64url-encode raw bytes (browser-safe; no Buffer). Copied from runAllReal. */
function b64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Run the interactive ALL-REAL setup and return a live chat controller.
 *
 * Reuses steps 1–5 of `runAllReal` (keygen → session-gated /nats-user →
 * /bootstrap → construct the production client) but KEEPS the client
 * alive: it never sends on its own and never disconnects on the first reply.
 *
 * @returns a `{ send, disconnect }` controller.
 * @throws on any fetch/setup failure BEFORE the client is constructed. Failures
 *         that surface asynchronously (NKEY/PoP rejection) arrive via
 *         `callbacks.onError`.
 */
export async function runDemo(
  opts: RunDemoOptions,
  callbacks: RunDemoCallbacks,
): Promise<DemoController> {
  // 1. Device X25519 key → cnf.jwk (b64url raw 32B). Extractable to export raw pub.
  callbacks.onStatus("generating keys");
  const x25519 = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const x25519Raw = await crypto.subtle.exportKey("raw", x25519.publicKey);
  const deviceX25519PublicKey = b64url(x25519Raw);

  // 2. Device Ed25519 PoP key → pop_jwk (jwk.x). NON-extractable: the private
  //    CryptoKey signs the register nonce in-page and NEVER leaves the page.
  const ed25519 = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const edPubJwk = (await crypto.subtle.exportKey("jwk", ed25519.publicKey)) as { x?: string };
  if (!edPubJwk.x) throw new Error("Ed25519 public JWK missing 'x'");
  const devicePopPublicKey = edPubJwk.x;

  // Derive the issuer base from the page origin so /nats-user + /bootstrap are
  // truly same-origin: the login `sid` cookie is bound to location.origin, and a
  // localhost/127.0.0.1 mismatch with opts.issuerUrl would silently drop it.
  // Fall back to opts.issuerUrl only when window is unavailable (non-browser).
  const issuerBase =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : opts.issuerUrl;

  // 3. Tenant-scoped NATS user creds (for NATS-layer NKEY auth). userSeedRaw is
  //    base64url of the raw 32-byte Ed25519 seed — browser signs with it directly.
  //    Session-gated (/nats-user relies on the same-origin login cookie).
  callbacks.onStatus("fetching creds");
  const credsRes = await fetch(`${issuerBase}/nats-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenant: opts.tenant, role: "browser" }),
  });
  if (!credsRes.ok) {
    throw new Error(`nats-user failed: HTTP ${credsRes.status} ${await credsRes.text()}`);
  }
  const { userJwt, userSeedRaw, natsUrl: deliveredNatsUrl } = (await credsRes.json()) as {
    userJwt?: string;
    userSeedRaw?: string;
    natsUrl?: string;
  };
  if (!userJwt || !userSeedRaw) throw new Error("nats-user response missing userJwt/userSeedRaw");

  // The SaaS is the rendezvous authority: it returns the relay URL alongside the
  // minted creds, so the browser dials where the SaaS says rather than a
  // page-configured `opts.natsUrl` (now only a back-compat fallback). This is the
  // web mirror of the enrolled plugin consuming `EnrollmentResult.natsUrl`.
  const natsUrl = deliveredNatsUrl ?? opts.natsUrl;

  // 4. PoP bootstrap JWT (RS256, this issuer's trust chain) for the register hop.
  //    Session-gated: the peerId is derived server-side from the login session
  //    (user.uuid), so we send NO peerId — only the account/tenant/device keys.
  const bootRes = await fetch(`${issuerBase}/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenant: opts.tenant,
      accountId: opts.accountId,
      deviceX25519PublicKey,
      devicePopPublicKey,
    }),
  });
  if (!bootRes.ok) {
    throw new Error(`bootstrap failed: HTTP ${bootRes.status} ${await bootRes.text()}`);
  }
  const { jwt, peerId } = (await bootRes.json()) as { jwt?: string; peerId?: string };
  if (!jwt || !peerId) throw new Error("bootstrap-jwt response missing jwt/peerId");

  // 5. Production client with NATS-layer NKEY auth, and — only when a gateway
  //    register URL is supplied — the PoP register hop. With `admission: "auto"`
  //    on the agent there is no register hop: omit `gwUrl` (empty string) and the
  //    client connects with `natsCredentials` only, relying on the X25519
  //    handshake + dmSecurity allowlist for admission. When `gwUrl` is present the
  //    original register-hop path is used verbatim (backward compatible).
  //    Unlike runAllReal, we keep this client alive for the whole chat session.
  const clientOpts = {
    url: natsUrl,
    jwt,
    accountId: opts.accountId,
    tenant: opts.tenant,
    peerId,
    natsCredentials: { userJwt, userSeedRaw },
    ...(opts.gwUrl
      ? {
          registration: {
            registerBaseUrl: opts.gwUrl,
            devicePrivateKey: ed25519.privateKey,
          },
        }
      : {}),
  };
  const client = new WebChannelNatsClient(clientOpts);

  // Wire inbound replies → onReply. Only surface high-level agent_message text;
  // other inbound types (progress/typing/approval/history) are ignored by the demo.
  client.onMessage((m) => {
    if (m.type === "agent_message") callbacks.onReply(m.text ?? "");
  });

  // Wire terminal errors (e.g. PoP/NKEY rejection) straight through.
  client.onError((e) => callbacks.onError(e));

  // Surface connection state. The handshake (and PoP register) happen after the
  // socket connects; we report "connecting" now and "connected" once the NATS
  // PONG flips the client to connected. The UI treats "connected" as ready —
  // outbound sends are buffered by the client until the handshake completes, so
  // a human typing immediately after "connected" is safe (fail-closed buffering).
  client.onState((connected) => {
    callbacks.onStatus(connected ? "connected" : "connecting");
  });

  // Connect ONLY — do NOT send anything yet, and do NOT disconnect on first reply.
  callbacks.onStatus("connecting");
  client.connect();

  return {
    send: (text: string) => client.sendUserMessage(text),
    disconnect: () => client.disconnect(),
  };
}
