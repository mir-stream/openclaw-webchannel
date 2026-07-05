/**
 * BYO auth — plug your IdP/DB here.
 *
 * This is a DELIBERATELY minimal, self-contained user store so the reference app
 * has ZERO dependency on any package-internal demo-users helper. In production
 * you would replace `login()` with your own identity provider / session layer.
 *
 * The ONLY load-bearing property the rest of the app relies on is: a successful
 * login yields a STABLE `uuid` per user. That uuid becomes the WebChannel peerId
 * (JWT `sub`) — it MUST be server-derived, never taken from client input.
 */

import { webcrypto } from "node:crypto";

export type AppUser = {
  username: string;
  /** Stable per-user identity → becomes the WebChannel peerId (JWT sub). */
  uuid: string;
  /** Accounts (deployments) this user may reach. Server-pinned authorization. */
  accounts: string[];
};

// Demo-grade seed directory. Passwords are compared in the clear here purely to
// keep the example dependency-free — DO NOT do this in production (hash + salt,
// or better, delegate to your IdP).
const SEED: Array<AppUser & { password: string }> = [
  {
    username: "alice",
    password: "password",
    uuid: "11111111-1111-4111-8111-111111111111",
    accounts: ["agent-dev"],
  },
  {
    username: "bob",
    password: "password",
    uuid: "22222222-2222-4222-8222-222222222222",
    accounts: ["agent-dev"],
  },
];

/** Verify credentials; return the AppUser (without password) or null. */
export function login(username: string, password: string): AppUser | null {
  const found = SEED.find((u) => u.username === username && u.password === password);
  if (!found) return null;
  const { password: _pw, ...user } = found;
  return user;
}

/** Server-pinned authorization: may this user reach `accountId`? */
export function canAccess(user: AppUser, accountId: string): boolean {
  return user.accounts.includes(accountId);
}

/** Mint an opaque session token (in production: signed cookie / session store). */
export function newSessionToken(): string {
  const b = new Uint8Array(24);
  webcrypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
