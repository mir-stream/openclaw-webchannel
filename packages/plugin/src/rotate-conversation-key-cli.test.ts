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
  runtime: Readonly<{ home?: string }> = {},
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
    expect(result.out).toContain("per-replica volumes are unsupported");
    expect(result.out).toContain("Do not run this command once per volume");
    expect(result.out).toContain("--ignore-live-writers gives up");
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

  it("shows an account as a count and a digest, never a peer list", () => {
    const peerIds = seedAccount(3);
    const result = run(...tupleArgs(), "--all-peers");

    expect(result.code).toBe(ROTATE_CLI_EXIT_OK);
    expect(result.out).toContain("peers:     3");
    expect(result.out).toMatch(/digest:    [0-9a-f]{64}/);
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
    expect(result.err).toContain("Rotation did NOT complete");
    expect(durableKeyMaterial()).toEqual(before);
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
    expect(result.err).toContain("another rotation is in progress");
  });

  it("takes over a lock whose owner is gone", () => {
    seedAccount(1);
    const lockPath = writeLock(deadPid());

    const result = run(...tupleArgs(), "--peer", "peer-0", "--apply");

    expect(result.code).toBe(ROTATE_CLI_EXIT_OK);
    expect(existsSync(lockPath)).toBe(false);
    const archived = readdirSync(paths().directory).filter((entry) =>
      entry.includes(`${ROTATION_LOCK_FILE_NAME}.stale-`),
    );
    expect(archived).toHaveLength(1);
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
    expect(result.err).toContain("a process is writing this account's state");
    expect(result.err).toContain(`live pid ${process.pid}`);
  });

  it("ignores a temp artifact whose owner is gone", () => {
    seedAccount(1);
    writeFileSync(
      `${paths().conversationKeyPath}.tmp-${deadPid()}-${"cd".repeat(12)}`,
      "partial",
      { mode: 0o600 },
    );
    expect(run(...tupleArgs(), "--peer", "peer-0", "--apply").code).toBe(
      ROTATE_CLI_EXIT_OK,
    );
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
    // The bypass covers a probe that can produce false positives. It must not
    // also disarm mutual exclusion, where a bypass loses one of two K sets.
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
    expect(result.err).toContain("another rotation is in progress");
  });
});
