/**
 * Reference WebChannel browser client — PUBLIC API ONLY.
 *
 * Imports come solely from the published package `openclaw-webchannel-client`.
 * This is the full production connect flow:
 *
 *   login → generate device keys (X25519 ECDH + Ed25519 PoP) →
 *   POST /bootstrap (RS256 bootstrap JWT) → POST /nats-user (browser NATS creds) →
 *   new WebChannelNATSClient({ natsCredentials, registration }) → connect.
 *
 * NO-AGENT STATE: with no openclaw agent attached, the NKEY connect succeeds but
 * the PoP register request has no responder. The timeout is transient: the client
 * redials and keeps retrying until an agent appears, so the UI shows reconnecting
 * rather than retiring credentials that may still be valid.
 *
 * classify(state) is a PURE, exported function so a headless Node smoke test can
 * assert the state sequence without a browser.
 */

import {
  WebChannelNATSClient,
  generateDevicePopKeyPair,
  type WebChannelState,
} from "openclaw-webchannel-client";

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
type BootstrapResponse = { jwt: string; peerId: string; natsUrl: string; agentPublicKey?: string };
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
  // F2: the register hop unwraps the delivered K against this SaaS-pinned key.
  if (!boot.agentPublicKey) {
    throw new Error("bootstrap response missing agentPublicKey (register-hop requires it)");
  }

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
      // F2: pin the SaaS-attested agent identity key for K authentication.
      pinnedAgentPublicKey: boot.agentPublicKey,
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
      // ⚠️ NARROW ON `kind` — DO NOT MAP OVER `state.messages` AND READ
      // `role`/`text` DIRECTLY. `ChatMessage` is a TAGGED UNION: a chat bubble
      // (no `kind`), a reasoning block (`kind: "reasoning"`), a tool call
      // (`kind: "tool"`) or an approval card (`kind: "approval"`). Only the
      // bubble arm has `role`, and only the bubble and reasoning arms have
      // `text` — a tool call's content is its name/phase/status/argKeys surface,
      // and an approval's is its title/prompt/options.
      //
      // This example previously did map straight over the array, and that is
      // precisely what broke when the union grew a third arm: `m.text` became
      // `string | undefined` and `m.role` `undefined`. It broke again, in the
      // same place, when half 4 added the fourth — which is the argument for the
      // narrowing, not against it. The pattern below is the one a real client
      // should copy, and the reason it is spelled out here rather than collapsed
      // into a one-liner — this file is the worked example of consuming the API,
      // so the habit it demonstrates matters more than its length.
      ...state.messages.map((m) => {
        const div = document.createElement("div");

        if (m.kind === "reasoning") {
          // A completed reasoning burst. It has NO `role` — the wire carries no
          // author and the client refuses to invent one — so it is rendered as
          // its own kind rather than as an agent bubble.
          div.className = "msg reasoning";
          div.textContent = m.text;
          return div;
        }

        if (m.kind === "tool") {
          // One tool call, merged from its lifecycle frames. `argKeys` carries
          // argument KEY NAMES ONLY — never argument values — so it is safe to
          // display; do not present it as the call's arguments.
          div.className = "msg tool";
          const label = m.name ?? "tool";
          // ⚠️ NOT `state` — that name SHADOWS the outer `state: WebChannelState`
          // whose `.messages` this very `.map` is walking. It was correct only
          // because nothing in the arm reads the outer one, and the gate would
          // not have caught it becoming wrong: CI typechecks the three published
          // packages only and lints nothing at all (**#318**), so this workspace's
          // own `typecheck` script runs only when someone runs it locally. This
          // file is the worked example of consuming the API — the habits it
          // demonstrates are its product, so it does not get to lean on that.
          const phaseLabel = m.status ?? m.phase;
          const args = m.argKeys && m.argKeys.length > 0 ? ` (${m.argKeys.join(", ")})` : "";
          div.textContent =
            `🔧 ${label}${phaseLabel !== undefined ? ` — ${phaseLabel}` : ""}${args}` +
            (m.summary !== undefined ? ` · ${m.summary}` : "");
          return div;
        }

        if (m.kind === "approval") {
          // A native HITL approval card. It has NO `role` and NO `text`, and it
          // is a DURABLE message — a reload replays it, so this arm draws both
          // the live card and the historical record of one.
          //
          // ⚠️ THIS EXAMPLE IS READ-ONLY AND DRAWS NO BUTTONS, which is the safe
          // default rather than a shortcut. A real client that offers decision
          // buttons must gate them on `state.approvals`' `actionable`, NEVER on
          // `resolvedDecision === undefined`: a card replayed from history is
          // unresolved as far as the stored stream records, and may still have
          // expired or been decided elsewhere. `decide()` refuses such a card
          // too, so the worst case is a dead button rather than a stale
          // decision — but do not rely on that.
          div.className = "msg approval";
          div.textContent =
            `🔐 ${m.title}` +
            (m.prompt ? ` — ${m.prompt}` : "") +
            (m.resolvedDecision !== undefined ? ` · ${m.resolvedDecision}` : " · pending");
          return div;
        }

        // The chat bubble arm. `m` is narrowed to `ChatBubble` here, so `role`
        // and `text` are both present.
        div.className = `msg ${m.role}`;
        div.textContent = m.text;
        // P0-4: minimal send-status affordance on the user's own bubbles. The
        // agent got the message once it reaches `accepted` (or `completed`); a
        // `failed` bubble shows a ⚠ whose title carries the reason so the send
        // never silently vanishes.
        if (m.role === "user" && m.sendState) {
          const badge = document.createElement("span");
          badge.className = `send-status ${m.sendState}`;
          if (m.sendState === "accepted" || m.sendState === "completed") {
            badge.textContent = " ✓";
          } else if (m.sendState === "failed") {
            badge.textContent = " ⚠";
            badge.title = `send failed: ${m.sendFailure?.reason ?? "unknown"}`;
          }
          if (badge.textContent) div.append(badge);
        }
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
