import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationKeyStore } from "./conversation-key-store.js";
import { createCredentialIdentityForEnrollment } from "./credential-document.js";
import { generateKeyPair } from "./e2e-crypto.js";
import {
  ROTATE_CLI_EXIT_FAILED,
  ROTATE_CLI_EXIT_OK,
  ROTATE_CLI_EXIT_USAGE,
  runRotateConversationKeyCli,
} from "./rotate-conversation-key-cli.js";
import { ROTATION_LOCK_FILE_NAME } from "./rotation-preflight.js";
import { legacyTuplePaths, tupleStoragePaths } from "./storage-paths.js";

/**
 * #158 — the offline rotation command, exercised end to end against real files
 * under a temporary storage root. Nothing here is mocked: the command is what
 * an operator runs during an incident, and a mocked store would not tell us
 * whether it actually writes the two documents.
 *
 * Two properties get the most attention because they are the ones an operator
 * cannot check for themselves in the middle of an incident:
 *
 *   NO SECRET REACHES A TERMINAL. Every assertion below scans the WHOLE
 *   captured output — stdout and stderr, dry run and apply, success and
 *   failure — for the durable key material and for the NATS seed sitting in the
 *   same directory. This is a backstop, not the mechanism: the CLI is built so
 *   that no store call it makes ever returns key material to it.
 *
 *   THE ACCOUNT-WIDE PATH IS NEVER A DEFAULT. Omitting a target is an error,
 *   and committing one requires a digest copied from the dry run. A typo can
 *   fail; it cannot quietly re-key an account.
 */

const TENANT = "tenant-A";
const ACCOUNT = "acct-a";
const SEED_SENTINEL = "SUAFAKESEEDVALUEFORTESTSONLY0000";

let storageRoot: string;

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "webchannel-rotate-cli-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(storageRoot, { recursive: true, force: true });
});

type CliRun = { code: number; out: string; err: string; all: string };

function run(...argv: string[]): CliRun {
  return runWithRuntime(argv);
}

function runWithRuntime(
  argv: readonly string[],
  runtime: Readonly<{
    home?: string;
    _beforeVerifiedReadback?: () => void;
    _beforeLockRelease?: () => void;
  }> = {},
): CliRun {
  const out: string[] = [];
  const err: string[] = [];
  const code = runRotateConversationKeyCli(
    argv,
    {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
    runtime,
  );
  const outText = out.join("\n");
  const errText = err.join("\n");
  return {
    code,
    out: outText,
    err: errText,
    all: `${outText}\n${errText}`,
  };
}

function tupleArgs(): string[] {
  return [
    "--tenant",
    TENANT,
    "--account",
    ACCOUNT,
    "--storage-root",
    storageRoot,
  ];
}

function paths() {
  return tupleStoragePaths({ tenant: TENANT, accountId: ACCOUNT, storageRoot });
}

/** Register peers the ordinary way, then drop a seed-bearing sibling file. */
function seedAccount(peerCount: number): string[] {
  const store = new ConversationKeyStore({
    tenant: TENANT,
    accountId: ACCOUNT,
    storageRoot,
  });
  const peerIds: string[] = [];
  for (let index = 0; index < peerCount; index += 1) {
    const peerId = `peer-${index}`;
    store.getOrCreate(peerId);
    peerIds.push(peerId);
  }
  writeFileSync(paths().credentialPath, credentialDocument(), { mode: 0o600 });
  return peerIds;
}

function seedTuple(
  tenant: string,
  accountId: string,
  peerCount: number,
): string[] {
  const store = new ConversationKeyStore({ tenant, accountId, storageRoot });
  const peerIds: string[] = [];
  for (let index = 0; index < peerCount; index += 1) {
    const peerId = `peer-${index}`;
    store.getOrCreate(peerId);
    peerIds.push(peerId);
  }
  return peerIds;
}

function tupleArgsFor(tenant: string, accountId: string): string[] {
  return [
    "--tenant",
    tenant,
    "--account",
    accountId,
    "--storage-root",
    storageRoot,
  ];
}

/**
 * A REAL credential document beside the key store, holding a sentinel where an
 * actual NATS user seed lives. The output scan below has to run against the
 * directory an operator really rotates in, seed included.
 */
function credentialDocument(): string {
  const pair = generateKeyPair();
  const agentPublicKey = Buffer.from(pair.publicKey).toString("base64url");
  return JSON.stringify({
    credentialIdentity: createCredentialIdentityForEnrollment({
      tenant: TENANT,
      accountId: ACCOUNT,
      saasBaseUrl: "https://saas.example",
      relayUrl: "wss://relay.example",
      agentPublicKey,
    }),
    identityKey: {
      publicKey: agentPublicKey,
      privateKey: Buffer.from(pair.privateKey).toString("base64url"),
    },
    enrollment: {
      creds: { userJwt: "JWT", userSeed: SEED_SENTINEL },
      peerId: "peer-0",
      jwksUrl: "https://saas.example/jwks",
      bootstrapUrl: "https://saas.example/bootstrap",
      natsUrl: "wss://relay.example",
    },
    tenant: TENANT,
    accountId: ACCOUNT,
    saasEnrollUrl: "https://saas.example/api/enroll",
    saasPollUrl: "https://saas.example/api/poll",
  });
}

function legacyCredentialDocument(): string {
  const document = JSON.parse(credentialDocument()) as Record<string, unknown>;
  delete document.credentialIdentity;
  return JSON.stringify(document, null, 2);
}

function seedExactOverrideLegacyState(): {
  legacy: ReturnType<typeof legacyTuplePaths>;
  destination: ReturnType<typeof tupleStoragePaths>;
  credentialPath: string;
  credentialBytes: Buffer;
  oldKey: string;
} {
  const legacy = legacyTuplePaths(ACCOUNT, storageRoot);
  mkdirSync(legacy.directory, { recursive: true, mode: 0o700 });
  const oldKey = Buffer.alloc(32, 0x45).toString("base64url");
  writeFileSync(
    legacy.conversationKeyPath,
    JSON.stringify({ version: 1, keys: { "legacy-peer": oldKey } }),
    { mode: 0o600 },
  );
  const credentialPath = join(
    storageRoot,
    "configured-exact-credentials",
    "account.json",
  );
  mkdirSync(join(storageRoot, "configured-exact-credentials"), {
    recursive: true,
    mode: 0o700,
  });
  const credentialBytes = Buffer.from(legacyCredentialDocument());
  writeFileSync(credentialPath, credentialBytes, { mode: 0o600 });
  return {
    legacy,
    destination: tupleStoragePaths({
      tenant: TENANT,
      accountId: ACCOUNT,
      home: storageRoot,
    }),
    credentialPath,
    credentialBytes,
    oldKey,
  };
}

function durableKeyMaterial(): string[] {
  const document = JSON.parse(
    readFileSync(paths().conversationKeyPath, "utf8"),
  ) as { keys: Record<string, string> };
  return Object.values(document.keys);
}

/** The backstop: no key material and no seed may appear anywhere in output. */
function expectNoSecrets(result: CliRun, material: readonly string[]): void {
  for (const secret of material) {
    expect(result.all).not.toContain(secret);
  }
  expect(result.all).not.toContain(SEED_SENTINEL);
}

function deadPid(): number {
  // A process that has already exited. Its pid is free; the kernel will not
  // hand the same number out again this quickly.
  const finished = spawnSync(process.execPath, ["-e", ""]);
  return finished.pid as number;
}

function writeLock(ownerPid: number): string {
  const path = join(paths().directory, ROTATION_LOCK_FILE_NAME);
  writeFileSync(
    path,
    JSON.stringify({ version: 1, ownerPid, token: "a".repeat(32) }),
    { mode: 0o600 },
  );
  return path;
}

describe("invocation", () => {
  it("prints usage on --help and states what it cannot prove", () => {
    const result = run("--help");
    expect(result.code, result.err).toBe(ROTATE_CLI_EXIT_OK);
    expect(result.out).toContain("WHAT THIS COMMAND CANNOT DO");
    expect(result.out).toContain("cannot prove that no gateway is running");
    expect(result.out).toContain("Every APPLY refuses a pre-existing");
    expect(result.out).toContain("both a dry run and an apply refuse");
    expect(result.out).toContain("per-replica volumes are unsupported");
    expect(result.out).toContain("Do not run this command once per volume");
    expect(result.out).toContain("--ignore-live-writers bypasses only");
    expect(result.out).toContain("a pre-existing lock automatically");
    expect(result.out).toContain(
      "never\n  bypasses or removes a pre-existing rotation lock",
    );
    expect(result.out).toContain("ON APPLY FAILURE");
    expect(result.out).toContain("never rerun blindly");
    expect(result.out).toContain("--credential-path <file>");
    expect(result.out).toContain("low-level runtime credentialPath");
    expect(result.out).toContain("never printed");
  });

  it("requires an exact tenant and account", () => {
    expect(run("--peer", "peer-0").code).toBe(ROTATE_CLI_EXIT_USAGE);
    expect(run("--tenant", TENANT, "--peer", "peer-0").code).toBe(
      ROTATE_CLI_EXIT_USAGE,
    );
  });

  it("refuses to guess a target", () => {
    const result = run(...tupleArgs());
    expect(result.code).toBe(ROTATE_CLI_EXIT_USAGE);
    expect(result.err).toContain("There is no default");
  });

  it("rejects contradictory and unknown arguments", () => {
    expect(run(...tupleArgs(), "--peer", "peer-0", "--all-peers").code).toBe(
      ROTATE_CLI_EXIT_USAGE,
    );
    expect(run(...tupleArgs(), "--all-peers", "--rotate-now").code).toBe(
      ROTATE_CLI_EXIT_USAGE,
    );
    expect(run(...tupleArgs(), "--peer", "a", "--peer", "b").code).toBe(
      ROTATE_CLI_EXIT_USAGE,
    );
  });

  it("does not swallow a following flag as a missing value", () => {
    // "--peer --apply" must not rotate a peer named "--apply" while the
    // operator reads their own command line as having applied something.
    const result = run(...tupleArgs(), "--peer", "--apply");
    expect(result.code).toBe(ROTATE_CLI_EXIT_USAGE);
    expect(result.err).toContain("is a flag");
  });

  it("accepts --flag=value form", () => {
    seedAccount(1);
    const result = run(
      `--tenant=${TENANT}`,
      `--account=${ACCOUNT}`,
      `--storage-root=${storageRoot}`,
      "--peer=peer-0",
    );
    expect(result.code).toBe(ROTATE_CLI_EXIT_OK);
  });

  it("requires a reviewed digest to commit an account-wide rotation", () => {
    const result = run(...tupleArgs(), "--all-peers", "--apply");
    expect(result.code).toBe(ROTATE_CLI_EXIT_USAGE);
    expect(result.err).toContain("--confirm-digest");
  });

  it("rejects a digest outside the account-wide apply path", () => {
    expect(
      run(...tupleArgs(), "--peer", "peer-0", "--confirm-digest", "abc").code,
    ).toBe(ROTATE_CLI_EXIT_USAGE);
    expect(
      run(...tupleArgs(), "--all-peers", "--confirm-digest", "abc").code,
    ).toBe(ROTATE_CLI_EXIT_USAGE);
  });

  it("pins load-bearing runbook ordering and cumulative floor semantics", () => {
    const runbook = readFileSync(
      new URL(
        "../../../docs/CREDENTIAL_CONTAINMENT_RUNBOOK.md",
        import.meta.url,
      ),
      "utf8",
    );
    const classA = runbook
      .split("## 3. Class A — managed NATS\n", 2)[1]
      ?.split("\n## 4. Class B", 1)[0];
    expect(classA).toBeDefined();
    const combined = classA
      ?.split("3. **Credential + K:**", 2)[1]
      ?.split("\n\nFor an agent credential replacement", 1)[0];
    expect(combined).toBeDefined();
    const stopFirst = combined?.indexOf("go to §4 ① **before provider revocation**")
      ?? -1;
    const providerRevoke = combined?.indexOf(
      "Only then revoke through the provider",
    ) ?? -1;
    expect(stopFirst).toBeGreaterThanOrEqual(0);
    expect(providerRevoke).toBeGreaterThan(stopFirst);

    const revocationSteps = runbook
      .split(
        "### ② Revoke, with a target and a floor you fixed in advance\n",
        2,
      )[1]
      ?.split("\n### ④ Rotate K", 1)[0];
    expect(revocationSteps).toBeDefined();
    expect(revocationSteps).toContain(
      "const existingTargetFloor = currentClaim.nats?.revocations?.[userPubkey]",
    );
    expect(revocationSteps).toContain(
      "const expectedFloorSec = Math.max(\n" +
        "  existingTargetFloor ?? floorSec,\n" +
        "  floorSec,\n" +
        ");",
    );
    expect(revocationSteps).toContain(
      "updatedClaim.nats?.revocations?.[userPubkey] !== expectedFloorSec",
    );
    expect(revocationSteps).toContain(
      "with exactly\n`expectedFloorSec` from step ②",
    );
    expect(revocationSteps).not.toContain(
      "with exactly the `floorSec` you fixed",
    );
    expect(runbook).toContain(
      "strictly greater than the effective accepted wildcard floor",
    );
    expect(runbook).toContain(
      "effective\n  accepted target floor (`expectedFloorSec`)",
    );
  });
});

describe("dry run", () => {
  it("is the default and writes nothing", () => {
    seedAccount(2);
    const before = readFileSync(paths().conversationKeyPath, "utf8");

    const result = run(...tupleArgs(), "--peer", "peer-0");

    expect(result.code).toBe(ROTATE_CLI_EXIT_OK);
    expect(result.out).toContain(
      "DRY RUN — no key is rotated (legacy migration may complete)",
    );
    expect(result.out).toContain("generation epoch=1");
    expect(result.out).toContain("Re-run with --apply to commit.");
    expect(readFileSync(paths().conversationKeyPath, "utf8")).toBe(before);
  });

  it("shows an account as a count and tuple+target-set digest, never a peer list", () => {
    const peerIds = seedAccount(3);
    const result = run(...tupleArgs(), "--all-peers");

    expect(result.code).toBe(ROTATE_CLI_EXIT_OK);
    expect(result.out).toContain("peers:     3");
    expect(result.out).toMatch(/digest:    [0-9a-f]{64}/);
    expect(result.out).toContain("commits to this exact tuple and target set");
    for (const peerId of peerIds) {
      expect(result.out).not.toContain(peerId);
    }
  });

  it("refuses an unknown peer instead of creating one", () => {
    seedAccount(1);
    const result = run(...tupleArgs(), "--peer", "ghost");
    expect(result.code).toBe(ROTATE_CLI_EXIT_FAILED);
    expect(result.err).toContain("not a create API");
    expect(Object.keys(JSON.parse(
      readFileSync(paths().conversationKeyPath, "utf8"),
    ).keys)).toEqual(["peer-0"]);
  });

  it("refuses a tuple that has no stored state", () => {
    const result = run(...tupleArgs(), "--peer", "peer-0");
    expect(result.code).toBe(ROTATE_CLI_EXIT_FAILED);
    expect(result.err).toContain("has no stored conversation key");
    expect(existsSync(paths().directory)).toBe(false);
  });

  it("refuses no-state apply without creating a lock directory", () => {
    const result = run(...tupleArgs(), "--peer", "peer-0", "--apply");
    expect(result.code).toBe(ROTATE_CLI_EXIT_FAILED);
    expect(result.err).toContain("has no stored conversation key");
    expect(existsSync(paths().directory)).toBe(false);
  });

  it("migrates valid legacy-only state before a dry-run preview", () => {
    const legacy = legacyTuplePaths(ACCOUNT, storageRoot);
    mkdirSync(legacy.directory, { recursive: true, mode: 0o700 });
    writeFileSync(legacy.credentialPath, credentialDocument(), { mode: 0o600 });
    const oldKey = Buffer.alloc(32, 0x31).toString("base64url");
    writeFileSync(
      legacy.conversationKeyPath,
      JSON.stringify({ version: 1, keys: { "legacy-peer": oldKey } }),
      { mode: 0o600 },
    );
    const destination = tupleStoragePaths({
      tenant: TENANT,
      accountId: ACCOUNT,
      home: storageRoot,
    });

    const result = runWithRuntime(
      [
        "--tenant",
        TENANT,
        "--account",
        ACCOUNT,
        "--peer",
        "legacy-peer",
      ],
      { home: storageRoot },
    );

    expect(result.code, result.err).toBe(ROTATE_CLI_EXIT_OK);
    expect(result.out).toContain("DRY RUN");
    expect(result.out).toContain("no generation label recorded");
    expect(existsSync(destination.conversationKeyPath)).toBe(true);
    expect(
      (JSON.parse(readFileSync(destination.conversationKeyPath, "utf8")) as {
        keys: Record<string, string>;
      }).keys["legacy-peer"],
    ).toBe(oldKey);
  });

  it("preserves legacy K when an exact credential override is omitted or wrong", () => {
    const state = seedExactOverrideLegacyState();
    const legacyKeyBytes = readFileSync(state.legacy.conversationKeyPath);

    const omitted = runWithRuntime(
      [
        "--tenant",
        TENANT,
        "--account",
        ACCOUNT,
        "--peer",
        "legacy-peer",
      ],
      { home: storageRoot },
    );
    const wrongCredentialPath = join(
      storageRoot,
      "wrong-exact-credentials",
      "account.json",
    );
    const wrong = runWithRuntime(
      [
        "--tenant",
        TENANT,
        "--account",
        ACCOUNT,
        "--credential-path",
        wrongCredentialPath,
        "--peer",
        "legacy-peer",
      ],
      { home: storageRoot },
    );

    for (const result of [omitted, wrong]) {
      expect(result.code).toBe(ROTATE_CLI_EXIT_FAILED);
      expect(result.err).toContain("--credential-path");
      expect(result.err).toContain("No legacy K was moved");
    }
    expect(readFileSync(state.legacy.conversationKeyPath)).toEqual(
      legacyKeyBytes,
    );
    expect(readFileSync(state.credentialPath)).toEqual(state.credentialBytes);
    expect(existsSync(state.destination.conversationKeyPath)).toBe(false);
    expect(
      readdirSync(state.legacy.directory).some((name) =>
        name.startsWith("conversation-keys.json.ambiguous-v2-"),
      ),
    ).toBe(false);
    expect(omitted.all).not.toContain(state.credentialPath);
    expect(wrong.all).not.toContain(state.credentialPath);
    expect(wrong.all).not.toContain(wrongCredentialPath);
    const privateKey = (
      JSON.parse(state.credentialBytes.toString("utf8")) as {
        identityKey: { privateKey: string };
      }
    ).identityKey.privateKey;
    expectNoSecrets(omitted, [state.oldKey, privateKey]);
    expectNoSecrets(wrong, [state.oldKey, privateKey]);
  });

  it("migrates and previews legacy K with the exact credential override", () => {
    const state = seedExactOverrideLegacyState();

    const result = runWithRuntime(
      [
        "--tenant",
        TENANT,
        "--account",
        ACCOUNT,
        "--credential-path",
        state.credentialPath,
        "--peer",
        "legacy-peer",
      ],
      { home: storageRoot },
    );

    expect(result.code, result.err).toBe(ROTATE_CLI_EXIT_OK);
    expect(result.out).toContain("DRY RUN");
    expect(
      (JSON.parse(
        readFileSync(state.destination.conversationKeyPath, "utf8"),
      ) as { keys: Record<string, string> }).keys["legacy-peer"],
    ).toBe(state.oldKey);
    expect(existsSync(state.legacy.conversationKeyPath)).toBe(false);
    expect(readFileSync(state.credentialPath, "utf8")).toContain(
      '"credentialIdentity"',
    );
    expect(result.all).not.toContain(state.credentialPath);
    const privateKey = (
      JSON.parse(state.credentialBytes.toString("utf8")) as {
        identityKey: { privateKey: string };
      }
    ).identityKey.privateKey;
    expectNoSecrets(result, [state.oldKey, privateKey]);
  });

  it("rejects a relative credential override before any migration mutation", () => {
    const state = seedExactOverrideLegacyState();
    const legacyKeyBytes = readFileSync(state.legacy.conversationKeyPath);
    const relativeCredentialPath =
      "configured-exact-credentials/account.json";

    const result = runWithRuntime(
      [
        "--tenant",
        TENANT,
        "--account",
        ACCOUNT,
        "--credential-path",
        relativeCredentialPath,
        "--peer",
        "legacy-peer",
      ],
      { home: storageRoot },
    );

    expect(result.code).toBe(ROTATE_CLI_EXIT_USAGE);
    expect(result.err).toContain("must be an absolute filesystem path");
    expect(readFileSync(state.legacy.conversationKeyPath)).toEqual(
      legacyKeyBytes,
    );
    expect(readFileSync(state.credentialPath)).toEqual(state.credentialBytes);
    expect(existsSync(state.destination.conversationKeyPath)).toBe(false);
    expect(
      readdirSync(state.legacy.directory).some((name) =>
        name.startsWith("conversation-keys.json.ambiguous-v2-"),
      ),
    ).toBe(false);
    expect(result.all).not.toContain(state.credentialPath);
    expect(result.all).not.toContain(relativeCredentialPath);
    const privateKey = (
      JSON.parse(state.credentialBytes.toString("utf8")) as {
        identityKey: { privateKey: string };
      }
    ).identityKey.privateKey;
    expectNoSecrets(result, [state.oldKey, privateKey]);
  });

  it("prints no key material or seed", () => {
    seedAccount(3);
    const material = durableKeyMaterial();
    expectNoSecrets(run(...tupleArgs(), "--peer", "peer-0"), material);
    expectNoSecrets(run(...tupleArgs(), "--all-peers"), material);
    expectNoSecrets(run(...tupleArgs(), "--peer", "ghost"), material);
  });
});

describe("apply", () => {
  it("rotates one peer and leaves the others alone", () => {
    seedAccount(3);
    const before = JSON.parse(
      readFileSync(paths().conversationKeyPath, "utf8"),
    ) as { keys: Record<string, string> };

    const result = run(...tupleArgs(), "--peer", "peer-1", "--apply");

    expect(result.code).toBe(ROTATE_CLI_EXIT_OK);
    expect(result.out).toContain("committed: epoch=2");
    expect(result.out).toContain("readback:  verified from disk");
    const after = JSON.parse(
      readFileSync(paths().conversationKeyPath, "utf8"),
    ) as { keys: Record<string, string> };
    expect(after.keys["peer-1"]).not.toBe(before.keys["peer-1"]);
    expect(after.keys["peer-0"]).toBe(before.keys["peer-0"]);
    expect(after.keys["peer-2"]).toBe(before.keys["peer-2"]);
    expectNoSecrets(result, Object.values(after.keys));
  });

  it("tells the operator that rotation revoked and disconnected nothing", () => {
    seedAccount(1);
    const result = run(...tupleArgs(), "--peer", "peer-0", "--apply");
    expect(result.out).toContain("revoked nothing and disconnected nobody");
    expect(result.out).toContain("CREDENTIAL_CONTAINMENT_RUNBOOK.md");
  });

  it("commits an account-wide rotation behind the reviewed digest", () => {
    seedAccount(4);
    const preview = run(...tupleArgs(), "--all-peers");
    const digest = /digest:    ([0-9a-f]{64})/.exec(preview.out)?.[1] as string;
    const before = durableKeyMaterial();

    const result = run(
      ...tupleArgs(),
      "--all-peers",
      "--apply",
      "--confirm-digest",
      digest,
    );

    expect(result.code).toBe(ROTATE_CLI_EXIT_OK);
    expect(result.out).toContain("committed: 4 peers");
    const after = durableKeyMaterial();
    expect(after).toHaveLength(4);
    for (const material of after) expect(before).not.toContain(material);
    expectNoSecrets(result, after);
  });

  it("refuses a stale digest and writes nothing", () => {
    seedAccount(2);
    const digest = /digest:    ([0-9a-f]{64})/.exec(
      run(...tupleArgs(), "--all-peers").out,
    )?.[1] as string;
    // The reviewed set changed: a new peer registered after the dry run.
    new ConversationKeyStore({
      tenant: TENANT,
      accountId: ACCOUNT,
      storageRoot,
    }).getOrCreate("peer-late");
    const before = durableKeyMaterial();

    const result = run(
      ...tupleArgs(),
      "--all-peers",
      "--apply",
      "--confirm-digest",
      digest,
    );

    expect(result.code).toBe(ROTATE_CLI_EXIT_FAILED);
    expect(result.err).toContain("does not match");
    expect(result.err).toContain("no rotation commit was attempted");
    expect(durableKeyMaterial()).toEqual(before);
  });

  it("refuses a tuple+target-set digest copied from another tuple before writes", () => {
    seedAccount(2);
    seedTuple("tenant-B", "acct-b", 2);
    const localDigest = /digest:    ([0-9a-f]{64})/.exec(
      run(...tupleArgs(), "--all-peers").out,
    )?.[1] as string;
    const foreignDigest = /digest:    ([0-9a-f]{64})/.exec(
      run(...tupleArgsFor("tenant-B", "acct-b"), "--all-peers").out,
    )?.[1] as string;
    const before = durableKeyMaterial();

    expect(foreignDigest).not.toBe(localDigest);
    const result = run(
      ...tupleArgs(),
      "--all-peers",
      "--apply",
      "--confirm-digest",
      foreignDigest,
    );

    expect(result.code).toBe(ROTATE_CLI_EXIT_FAILED);
    expect(result.err).toContain("tuple+target-set digest does not match");
    expect(result.err).toContain("no rotation commit was attempted");
    expect(durableKeyMaterial()).toEqual(before);
  });

  it("reports committed-but-unverified when complete readback fails", () => {
    seedAccount(2);
    const before = durableKeyMaterial();
    const result = runWithRuntime(
      [...tupleArgs(), "--peer", "peer-0", "--apply"],
      {
        _beforeVerifiedReadback: () => {
          const document = JSON.parse(
            readFileSync(paths().conversationKeyPath, "utf8"),
          ) as { keys: Record<string, string> };
          document.keys["peer-1"] = Buffer.alloc(32, 0x5a).toString("base64url");
          writeFileSync(
            paths().conversationKeyPath,
            JSON.stringify(document),
            { mode: 0o600 },
          );
        },
      },
    );

    expect(result.code).toBe(ROTATE_CLI_EXIT_FAILED);
    expect(result.err).toContain("rotation commit path completed");
    expect(result.err).toContain("durable readback did not verify");
    expect(result.err).toContain("Do not rerun blindly");
    expect(result.err).not.toContain("Nothing was started");
    expectNoSecrets(result, [...before, ...durableKeyMaterial()]);
  });

  it("reports committed-and-verified when lock cleanup fails", () => {
    seedAccount(1);
    const before = durableKeyMaterial();
    const result = runWithRuntime(
      [...tupleArgs(), "--peer", "peer-0", "--apply"],
      { _beforeLockRelease: () => writeLock(process.pid) },
    );

    expect(result.code).toBe(ROTATE_CLI_EXIT_FAILED);
    expect(result.err).toContain("rotation committed");
    expect(result.err).toContain("durable readback verified");
    expect(result.err).toContain("lock cleanup failed");
    expect(result.err).toContain("K is rotated");
    expect(result.err).toContain("Do not rerun");
    expect(durableKeyMaterial()[0]).not.toBe(before[0]);
    expect(existsSync(join(paths().directory, ROTATION_LOCK_FILE_NAME))).toBe(
      true,
    );
    expectNoSecrets(result, [...before, ...durableKeyMaterial()]);
  });

  it("releases the rotation lock on success and on failure", () => {
    seedAccount(1);
    const lockPath = join(paths().directory, ROTATION_LOCK_FILE_NAME);

    expect(run(...tupleArgs(), "--peer", "peer-0", "--apply").code).toBe(
      ROTATE_CLI_EXIT_OK,
    );
    expect(existsSync(lockPath)).toBe(false);

    expect(run(...tupleArgs(), "--peer", "ghost", "--apply").code).toBe(
      ROTATE_CLI_EXIT_FAILED,
    );
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("preflight", () => {
  it("refuses while another rotation holds the lock", () => {
    seedAccount(1);
    writeLock(process.pid);

    const result = run(...tupleArgs(), "--peer", "peer-0", "--apply");

    expect(result.code).toBe(ROTATE_CLI_EXIT_FAILED);
    expect(result.err).toContain("rotation lock");
    expect(result.err).toContain("alive on this host");
  });

  it("leaves a dead/local-looking lock untouched and refuses", () => {
    seedAccount(1);
    const lockPath = writeLock(deadPid());
    const before = readFileSync(lockPath, "utf8");

    const result = run(...tupleArgs(), "--peer", "peer-0", "--apply");

    expect(result.code).toBe(ROTATE_CLI_EXIT_FAILED);
    expect(result.err).toContain("not observable locally");
    expect(result.err).toContain("another host/pod");
    expect(readFileSync(lockPath, "utf8")).toBe(before);
    const archived = readdirSync(paths().directory).filter((entry) =>
      entry.includes(`${ROTATION_LOCK_FILE_NAME}.stale-`),
    );
    expect(archived).toHaveLength(0);
  });

  it("refuses when a live process is mid-write on this account", () => {
    seedAccount(1);
    // The exact artifact `atomicWritePrivateFile` leaves while it is writing.
    writeFileSync(
      `${paths().conversationKeyPath}.tmp-${process.pid}-${"ab".repeat(12)}`,
      "partial",
      { mode: 0o600 },
    );

    const result = run(...tupleArgs(), "--peer", "peer-0", "--apply");

    expect(result.code).toBe(ROTATE_CLI_EXIT_FAILED);
    expect(result.err).toContain("atomic-write temp artifact");
    expect(result.err).toContain(`locally live pid ${process.pid}`);
  });

  it("refuses a remote/stale-looking temp artifact by default", () => {
    seedAccount(1);
    const artifact =
      `${paths().conversationKeyPath}.tmp-${deadPid()}-${"cd".repeat(12)}`;
    writeFileSync(
      artifact,
      "partial",
      { mode: 0o600 },
    );
    const result = run(...tupleArgs(), "--peer", "peer-0", "--apply");
    expect(result.code).toBe(ROTATE_CLI_EXIT_FAILED);
    expect(result.err).toContain("not observable locally");
    expect(result.err).toContain("another host/pod");
    expect(readFileSync(artifact, "utf8")).toBe("partial");
  });

  it("reports every temp artifact without echoing arbitrary filenames", () => {
    seedAccount(1);
    const filenameSecrets = ["SECRET-FIRST", "SECRET-SECOND"];
    for (const [index, secret] of filenameSecrets.entries()) {
      writeFileSync(
        join(
          paths().directory,
          `${secret}.tmp-${deadPid()}-${String(index + 1).repeat(24)}`,
        ),
        "partial",
        { mode: 0o600 },
      );
    }

    const result = run(...tupleArgs(), "--peer", "peer-0", "--apply");
    expect(result.code).toBe(ROTATE_CLI_EXIT_FAILED);
    expect(result.err.match(/possible writer artifact:/g)).toHaveLength(2);
    for (const secret of filenameSecrets) expect(result.all).not.toContain(secret);
  });

  it("lets --ignore-live-writers past the writer probe", () => {
    seedAccount(1);
    writeFileSync(
      `${paths().conversationKeyPath}.tmp-${process.pid}-${"ef".repeat(12)}`,
      "partial",
      { mode: 0o600 },
    );
    expect(
      run(
        ...tupleArgs(),
        "--peer",
        "peer-0",
        "--apply",
        "--ignore-live-writers",
      ).code,
    ).toBe(ROTATE_CLI_EXIT_OK);
  });

  it("does not let --ignore-live-writers past a live rotation lock", () => {
    // The bypass covers only temp artifacts. It must not disarm mutual
    // exclusion or delete an unresolved lock from any host.
    seedAccount(1);
    writeLock(process.pid);
    const result = run(
      ...tupleArgs(),
      "--peer",
      "peer-0",
      "--apply",
      "--ignore-live-writers",
    );
    expect(result.code).toBe(ROTATE_CLI_EXIT_FAILED);
    expect(result.err).toContain("rotation lock");
    expect(result.err).toContain("alive on this host");
  });
});
