import { useMemo, useState } from "react";
import { Chat } from "../lib/index.js";
import { makeDevGetTicket } from "./devTicket.js";
import type { UseClawChannelOptions } from "../lib/index.js";

/**
 * Example shell demonstrating the `hmac-ticket` auth flow end-to-end.
 *
 * Instead of baking a secret into the build, the secret is entered AT RUNTIME in
 * the page: type the shared secret + a user id, and the widget mints a
 * short-lived ticket in the browser (devTicket.ts) and connects. This means the
 * example can be built once and deployed as static assets — anyone can open it,
 * paste the gateway's `channels.clawchannel.auth.ticketSecret`, and try the
 * hmac-ticket path with no rebuild.
 *
 * ⚠️ DEMO ONLY. Minting tickets in the browser exposes the secret to whoever
 * uses the page. In production the host's backend issues tickets server-side and
 * hands them to the widget via `getTicket` (see AUTH.md §5); the secret never
 * reaches the browser. This shell stands in for that backend.
 */
export function App() {
  const [secret, setSecret] = useState("");
  const [userId, setUserId] = useState("alice");
  // `session` is null until the user connects; setting it mounts <Chat>, which
  // opens the socket. Clearing it unmounts <Chat>, closing the socket.
  const [session, setSession] = useState<{ secret: string; sub: string } | null>(
    null,
  );

  const options = useMemo<UseClawChannelOptions | undefined>(
    () =>
      session
        ? { getTicket: makeDevGetTicket(session.secret, session.sub) }
        : undefined,
    [session],
  );

  if (session && options) {
    return (
      <div style={{ maxWidth: 480, margin: "1.5rem auto", fontFamily: "system-ui" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 13,
            color: "#666",
            marginBottom: 4,
          }}
        >
          <span>
            hmac-ticket · connected as <strong>{session.sub}</strong>
          </span>
          <button
            type="button"
            onClick={() => setSession(null)}
            style={{ fontSize: 12, padding: "2px 8px" }}
          >
            Disconnect
          </button>
        </div>
        <Chat options={options} />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 420, margin: "3rem auto", fontFamily: "system-ui" }}>
      <h2>ClawChannel — hmac-ticket demo</h2>
      <p style={{ color: "#555", fontSize: 14, lineHeight: 1.5 }}>
        Enter the shared secret configured on the gateway (
        <code>channels.clawchannel.auth.ticketSecret</code>) and a user id. The
        browser mints a short-lived ticket and connects.
      </p>
      <p style={{ color: "#a15", fontSize: 13, lineHeight: 1.5 }}>
        ⚠️ Demo only — the secret is used in the browser. In production your
        backend issues tickets server-side; the secret never reaches the browser.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!secret.trim() || !userId.trim()) return;
          setSession({ secret: secret.trim(), sub: userId.trim() });
        }}
        style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Shared secret
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="same as gateway ticketSecret"
            autoComplete="off"
            style={{ padding: 8, borderRadius: 8, border: "1px solid #ccc" }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          User id (ticket sub)
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="alice"
            style={{ padding: 8, borderRadius: 8, border: "1px solid #ccc" }}
          />
        </label>
        <button
          type="submit"
          disabled={!secret.trim() || !userId.trim()}
          style={{ padding: "8px 16px", borderRadius: 8 }}
        >
          Connect
        </button>
      </form>
    </div>
  );
}
