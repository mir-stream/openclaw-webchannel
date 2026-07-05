/**
 * Reference user-domain the SaaS owns — the login identities behind the demo.
 *
 * In production the SaaS already has a user store (accounts, passwords, the
 * user↔deployment ownership graph). The demo needs a stand-in for THAT domain so
 * a browser visitor can log in (id/pw) and have the SaaS derive a STABLE identity
 * from the authenticated session — never from the request body. This module is
 * that stand-in:
 *
 *   - `peerId = user.uuid = the bootstrap JWT `sub``. The uuid is the SaaS's own
 *     stored, stable identifier for the user; the bootstrap flow uses it verbatim
 *     as the peer identity so a given login always maps to the same peer (no
 *     client-supplied peerId, so nothing to spoof).
 *   - `canAccess(user, accountId)` is the user↔aud (account = deployment) ownership
 *     gate. The SaaS enforces it at JWT-mint: a login only yields a bootstrap JWT
 *     for an account the user actually owns. This is the authorization boundary.
 *
 * Passwords here are DEMO-GRADE: a bare sha256 of the password, no salt, no KDF.
 * That is fine for two hardcoded demo users; do NOT copy this to production, which
 * must use a salted memory-hard KDF (argon2/scrypt/bcrypt).
 */

import { createHash } from "node:crypto";

/** A demo login identity. `uuid` is the stable peerId = bootstrap `sub`. */
export type DemoUser = {
  username: string;
  /** Stable SaaS-owned identifier; used verbatim as peerId / bootstrap `sub`. */
  uuid: string;
  /** sha256hex of the demo password (demo-grade — no salt/KDF). */
  passwordSha256: string;
  /** Accounts (deployments) this user is authorized for — the canAccess set. */
  allowedAccounts: string[];
};

/** Lowercase hex sha256 of a UTF-8 string. */
export function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * In-memory directory over the demo users. Authentication is constant-shape
 * (unknown user and wrong password are indistinguishable — no user enumeration).
 */
export class DemoUserDirectory {
  private readonly byUsername = new Map<string, DemoUser>();

  constructor(users: readonly DemoUser[]) {
    for (const u of users) this.byUsername.set(u.username, u);
  }

  get(username: string): DemoUser | undefined {
    return this.byUsername.get(username);
  }

  /**
   * Return the user iff the password matches; null for an unknown user OR a wrong
   * password (same result either way — no enumeration difference).
   */
  authenticate(username: string, password: string): DemoUser | null {
    const user = this.byUsername.get(username);
    if (!user) return null;
    return sha256hex(password) === user.passwordSha256 ? user : null;
  }

  /** The user↔account ownership gate enforced at JWT-mint. */
  canAccess(user: DemoUser, accountId: string): boolean {
    return user.allowedAccounts.includes(accountId);
  }

  /**
   * A non-secret view of the directory for the demo admin panel: username +
   * allowedAccounts only. Deliberately omits `passwordSha256` and `uuid` so the
   * unauthenticated demo route can't leak the password hash or the stable peerId.
   */
  list(): { username: string; allowedAccounts: string[] }[] {
    return Array.from(this.byUsername.values()).map((u) => ({
      username: u.username,
      allowedAccounts: [...u.allowedAccounts],
    }));
  }

  /**
   * Replace a user's allowedAccounts (the canAccess set), live. Dedupes and keeps
   * only strings. Returns false for an unknown user, true on success. Mutates the
   * stored DemoUser in place so subsequent canAccess()/mint checks see the change.
   */
  setAllowedAccounts(username: string, accounts: string[]): boolean {
    const user = this.byUsername.get(username);
    if (!user) return false;
    user.allowedAccounts = Array.from(new Set(accounts.filter((a) => typeof a === "string")));
    return true;
  }
}

/**
 * Seed the two demo users (alice, bob) — both authorized for `accountId`, both
 * with password "demo". UUIDs are hardcoded and stable so a login always maps to
 * the same peerId across restarts.
 */
export function seedDemoUsers(accountId: string): DemoUser[] {
  const passwordSha256 = sha256hex("demo");
  return [
    {
      username: "alice",
      uuid: "11111111-1111-4111-8111-111111111111",
      passwordSha256,
      allowedAccounts: [accountId],
    },
    {
      username: "bob",
      uuid: "22222222-2222-4222-8222-222222222222",
      passwordSha256,
      allowedAccounts: [accountId],
    },
  ];
}
