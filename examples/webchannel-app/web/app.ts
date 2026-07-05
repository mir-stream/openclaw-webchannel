/**
 * Reference WebChannel browser client — PUBLIC API ONLY.
 *
 * Imports come solely from the published package `@mir-stream/webchannel-client`.
 * This is the full production connect flow:
 *
 *   login → generate device keys (X25519 ECDH + Ed25519 PoP) →
 *   POST /bootstrap (RS256 bootstrap JWT) → POST /nats-user (browser NATS creds) →
 *   new WebChannelNATSClient({ natsCredentials, registration }) → connect.
 *
 * NO-AGENT END STATE: with no openclaw agent attached, the NKEY connect SUCCEEDS
 * (status "connected") but the PoP register request has no responder, so ~15s
 * later it times out and the wrapper reports a TERMINAL status "error" with
 * message "[nats-client] request timeout". This app treats that specific error as
 * a graceful "waiting for agent" state (not a red error box) with a Retry button.
 *
 * classify(state) is a PURE, exported function so a headless Node smoke test can
 * assert the state sequence without a browser.
 */

import {
  WebChannelNATSClient,
  generateDevicePopKeyPair,
  type WebChannelState,
} from "@mir-stream/webchannel-client";

// ---------------------------------------------------------------------------
// Pure classifier (exported for the headless smoke test).
// ---------------------------------------------------------------------------

export type AppUiState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "waiting-for-agent"
  | "error";

/**
 * Map a raw WebChannelState to the app's UI intent.
 *
 * NOTE (demo-grade contract): the wrapper FLATTENS the underlying error into
 * `state.error` (it surfaces `err.message`, which is derived from `err.name`), so
 * we string-match it. This is a demo-grade convention, not a stable typed API —
 * a production app should push for a typed error code upstream. The no-agent case
 * is the register request-reply timeout ("[nats-client] request timeout"); an
 * authoritative NATS auth rejection surfaces as "…unauthorized/authorization".
 */
export function classify(state: WebChannelState): AppUiState {
  switch (state.status) {
    case "connected":
      return "connected";
    case "connecting":
      return "connecting";
    case "reconnecting":
      return "reconnecting";
    case "error": {
      const msg = (state.error ?? "").toLowerCase();
      if (msg.includes("request timeout")) return "waiting-for-agent";
      return "error";
    }
    default:
      return "error";
  }
}

// ---------------------------------------------------------------------------
// Browser flow (guarded so importing this module in Node never touches the DOM).
// ---------------------------------------------------------------------------

type LoginResponse = { token: string; peerId: string; accountId: string; tenant: string };
type BootstrapResponse = { jwt: string; peerId: string; natsUrl: string };
type NatsUserResponse = { userJwt: string; userSeedRaw: string; natsUrl: string };

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function postJson<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed (HTTP ${res.status})`);
  return (await res.json()) as T;
}

/**
 * Full authentication + connect. Called on first connect AND on Retry — Retry is
 * a FULL RE-AUTH (fresh device keys + fresh /bootstrap + fresh /nats-user + new
 * client), because the bootstrap JWT lives ~300s and simply re-creating the
 * client could present an expired JWT.
 */
export async function connectLane(
  session: LoginResponse,
  onState: (state: WebChannelState) => void,
): Promise<WebChannelNATSClient> {
  // Device keys. X25519 private key is NON-EXTRACTABLE (`false`); the public key
  // is still exportable (WebCrypto always keeps public halves extractable).
  const x25519 = (await crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const deviceX25519PublicKey = b64url(await crypto.subtle.exportKey("raw", x25519.publicKey));
  const pop = await generateDevicePopKeyPair(); // Ed25519 { privateKey, publicJwk }

  const boot = await postJson<BootstrapResponse>(
    "/bootstrap",
    {
      accountId: session.accountId,
      deviceX25519PublicKey,
      devicePopPublicKey: pop.publicJwk.x,
    },
    session.token,
  );
  const creds = await postJson<NatsUserResponse>("/nats-user", {}, session.token);

  const client = new WebChannelNATSClient({
    natsUrl: boot.natsUrl ?? creds.natsUrl,
    bootstrapJwt: boot.jwt,
    accountId: session.accountId,
    tenant: session.tenant,
    peerId: boot.peerId,
    natsCredentials: { userJwt: creds.userJwt, userSeedRaw: creds.userSeedRaw },
    registration: {
      // N2: `devicePrivateKey` is the Ed25519 PoP key; `deviceX25519PrivateKey`
      // is the ECDH key whose public half is pinned in the bootstrap JWT cnf.jwk.
      devicePrivateKey: pop.privateKey,
      deviceX25519PrivateKey: x25519.privateKey,
    },
  });
  client.subscribe(onState);
  onState(client.getState());
  client.connect();
  return client;
}

// The DOM wiring only runs in a browser. In Node (smoke test) the module import
// stops here — classify + connectLane stay pure and callable.
if (typeof document !== "undefined") {
  void mountBrowserUi();
}

async function mountBrowserUi(): Promise<void> {
  const $ = (id: string) => document.getElementById(id)!;
  const loginForm = $("login") as HTMLFormElement;
  const statusEl = $("status");
  const bannerEl = $("banner");
  const chatEl = $("chat");
  const composer = $("composer") as HTMLFormElement;
  const input = $("msg") as HTMLInputElement;

  let client: WebChannelNATSClient | null = null;
  let session: LoginResponse | null = null;

  function render(state: WebChannelState): void {
    const ui = classify(state);
    statusEl.textContent = `status: ${state.status} → ${ui}`;
    bannerEl.replaceChildren();
    if (ui === "waiting-for-agent") {
      const retry = document.createElement("button");
      retry.textContent = "Retry";
      retry.onclick = () => void reconnect();
      bannerEl.append(
        Object.assign(document.createElement("span"), {
          textContent: "⏳ Waiting for an agent — attach openclaw, then ",
        }),
        retry,
      );
    } else if (ui === "error") {
      bannerEl.textContent = `⚠ ${state.error ?? "connection error"}`;
    }
    chatEl.replaceChildren(
      ...state.messages.map((m) => {
        const div = document.createElement("div");
        div.className = `msg ${m.role}`;
        div.textContent = m.text;
        return div;
      }),
    );
  }

  async function reconnect(): Promise<void> {
    if (!session) return;
    client?.close();
    client = await connectLane(session, render);
  }

  loginForm.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(loginForm);
    try {
      session = await postJson<LoginResponse>("/login", {
        username: String(fd.get("username") ?? ""),
        password: String(fd.get("password") ?? ""),
      });
      loginForm.style.display = "none";
      composer.style.display = "flex";
      await reconnect();
    } catch (err) {
      statusEl.textContent = `login failed: ${(err as Error).message}`;
    }
  };

  composer.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !client) return;
    client.send(text);
    input.value = "";
  };
}
