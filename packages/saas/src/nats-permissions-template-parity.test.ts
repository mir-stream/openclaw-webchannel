/**
 * SaaS half of the permission-template 3-way lock (P0-3 D3).
 *
 * DECODE the actual minted user-JWT permission claims (`nats.pub.{allow,deny}` /
 * `nats.sub.{allow,deny}`) for each role and assert they equal the shared repo-root
 * fixture `contracts/nats-permissions.v1.json` — the SAME fixture the plugin's
 * `requiredNatsPermissions` parity test checks. Transitively this pins
 * template == mint without any cross-package import.
 *
 * We compare the DECODED JWT claims (not `MintedNatsUserCreds.permissions`, which
 * is an allow-only projection that DROPS the observer's `pub.deny:[">"]`). The
 * mint omits empty allow/deny keys, so decoded claims are normalized to the full
 * `{allow, deny}` shape before comparing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { createAccount } from "@nats-io/nkeys";
import { decode, type User } from "@nats-io/jwt";

import { mintNatsUserCreds } from "./nats-user-creds.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../contracts/nats-permissions.v1.json", import.meta.url),
);

type Grant = { allow: string[]; deny: string[] };
type PermSet = { pub: Grant; sub: Grant };
type Fixture = { agent: PermSet; browser: PermSet; observer: PermSet };

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

/** The self-contained account the mint signs with. tenant/peerId match the fixture. */
function accountSeed(): string {
  return new TextDecoder().decode(createAccount().getSeed());
}

/** Decode the minted JWT and normalize its nats perms to the full {allow,deny} shape. */
function decodedPerms(userJwt: string): PermSet {
  const claims = decode<User>(userJwt);
  const norm = (g: { allow?: string[]; deny?: string[] } | undefined): Grant => ({
    allow: g?.allow ?? [],
    deny: g?.deny ?? [],
  });
  return { pub: norm(claims.nats.pub), sub: norm(claims.nats.sub) };
}

describe("minted JWT claims ↔ contracts/nats-permissions.v1.json (saas parity)", () => {
  it("agent role: decoded pub/sub claims equal the fixture", async () => {
    const creds = await mintNatsUserCreds({ accountSeed: accountSeed(), tenant: "t1", role: "agent" });
    expect(decodedPerms(creds.userJwt)).toEqual(fixture.agent);
  });

  it("browser role (peerId=p1): decoded pub/sub claims equal the fixture", async () => {
    const creds = await mintNatsUserCreds({
      accountSeed: accountSeed(),
      tenant: "t1",
      role: "browser",
      peerId: "p1",
    });
    expect(decodedPerms(creds.userJwt)).toEqual(fixture.browser);
  });

  it("observer role: decoded claims carry the EXPLICIT pub.deny [\">\"] (not an allow-only projection)", async () => {
    const creds = await mintNatsUserCreds({ accountSeed: accountSeed(), tenant: "t1", role: "observer" });
    const perms = decodedPerms(creds.userJwt);
    expect(perms).toEqual(fixture.observer);
    // The load-bearing detail the `.permissions` projection would hide:
    expect(perms.pub.deny).toEqual([">"]);
    expect(perms.pub.allow).toEqual([]);
  });
});
