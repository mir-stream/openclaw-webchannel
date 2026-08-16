/**
 * `openclaw-webchannel-rotate-key` — the offline conversation-key rotation
 * command (#158).
 *
 * WHY IT IS A SEPARATE BINARY. Before this existed, the only way an operator
 * could replace a leaked conversation key K was to delete state files by hand:
 * destructive, account-wide, and unauditable. This is the supported
 * replacement. It is a `bin` of the installed package, NOT a chat command, NOT
 * an HTTP route, and NOT anything the running gateway can invoke — rotation is
 * only safe when nothing is serving the tuple, so exposing it inside a live
 * process would be exposing a footgun. A guard test pins that separation by
 * walking the import graph in both directions.
 *
 * WHAT THIS COMMAND DOES NOT GUARANTEE. It cannot prove that no gateway is
 * running. This is a library; it does not know what the deployer runs it under,
 * so the controller-attestation design in #158's original body was dropped
 * (decision of 2026-08-16). `rotation-preflight.ts` catches a concurrent
 * rotation and a writer caught mid-write, and that is all it catches — an idle
 * but running gateway is invisible to it. Bringing observed replicas to zero
 * first is an operator obligation, imposed by step ① of
 * `docs/CREDENTIAL_CONTAINMENT_RUNBOOK.md`. Violating it does not fail loudly:
 * the old process keeps serving a cached K_old to live devices while this
 * command commits K_new, and the two disagree until the old process dies.
 *
 * SECRETS. No output path of this command carries key material, seeds or JWTs,
 * and that is structural rather than careful: every store call it makes returns
 * non-secret metadata only (previews return counts, labels and a digest;
 * rotations return a summary AFTER the store has verified its own readback).
 * The CLI never holds a K to leak.
 */

import { existsSync } from "node:fs";

import {
  ConversationKeyStore,
  type AccountRotationSummary,
  type PeerRotationSummary,
} from "./conversation-key-store.js";
import {
  acquireRotationLock,
  probeLiveTupleWriters,
  releaseRotationLock,
} from "./rotation-preflight.js";
import { tupleStoragePaths } from "./storage-paths.js";

export const ROTATE_CLI_COMMAND = "openclaw-webchannel-rotate-key";

/** 0 success, 1 refused/failed, 2 the invocation itself was wrong. */
export const ROTATE_CLI_EXIT_OK = 0;
export const ROTATE_CLI_EXIT_FAILED = 1;
export const ROTATE_CLI_EXIT_USAGE = 2;

export type RotateCliStreams = {
  out: (line: string) => void;
  err: (line: string) => void;
};

export const ROTATE_CLI_USAGE = `${ROTATE_CLI_COMMAND} — replace the agent-owned conversation key K for one
peer, or for one reviewed account, while the gateway is stopped.

USAGE
  ${ROTATE_CLI_COMMAND} --tenant <tenant> --account <accountId> --peer <peerId>
  ${ROTATE_CLI_COMMAND} --tenant <tenant> --account <accountId> --all-peers

  Without --apply this is a DRY RUN: it rotates nothing and writes no key file.
  That is the default on purpose — review the blast radius, then commit it. (A
  dry run does complete the one-time pre-v2 storage migration if this tuple
  still needs it, so that what you review is what would be rotated.)

OPTIONS
  --tenant <tenant>       Exact tenant. Required. There is no default tenant.
  --account <accountId>   Exact account id. Required.
  --peer <peerId>         Rotate exactly this peer. Rotation is not a create
                          API: an unknown peerId is refused, never registered.
  --all-peers             Rotate EVERY peer of this account as one commit.
                          Never implied — you have to ask for it.
  --apply                 Commit. Without it, nothing is written.
  --confirm-digest <hex>  Required with "--all-peers --apply": the target digest
                          printed by the matching dry run. If the peer set has
                          changed since you reviewed it, the digest no longer
                          matches and the rotation is refused.
  --storage-root <dir>    Override the v2 storage root. Only for deployments
                          that moved it; the tuple layout underneath is fixed.
  --ignore-live-writers   Skip the in-flight-writer probe (see below).
  --help, -h              Print this and exit.

WHAT THIS COMMAND CANNOT DO
  It cannot prove that no gateway is running. It refuses if it can see another
  rotation in progress, or a process caught mid-write on this account's files.
  A gateway that is up but momentarily idle looks exactly like a stopped one:
  this plugin holds no lease and no pidfile, and a library cannot know what
  process supervisor it lives under. Stopping every replica and confirming an
  observed count of zero is YOUR step, and it is load-bearing. If you rotate
  while a replica is alive, that replica keeps serving the old K it already has
  in memory to already-connected browsers while this command commits the new
  one, and nothing reports the split.

  --ignore-live-writers gives up the only automatic local signal that something
  was writing to this account. It exists because a leftover temp file whose pid
  has been recycled can produce a false positive. Using it means the refusal is
  now entirely your own judgement, made from the replica count you observed
  outside this tool. It does not make the rotation safer or more proven.

AFTER A SUCCESSFUL ROTATION
  Rotating K does not disconnect anyone and does not revoke any credential. Every
  affected browser must be forced through a fresh bootstrap so it registers again
  and receives the new key. See docs/CREDENTIAL_CONTAINMENT_RUNBOOK.md.`;

type ParsedInvocation =
  | { kind: "help" }
  | { kind: "usage-error"; message: string }
  | {
      kind: "run";
      tenant: string;
      accountId: string;
      target: { kind: "peer"; peerId: string } | { kind: "account" };
      apply: boolean;
      confirmDigest: string | null;
      storageRoot: string | null;
      ignoreLiveWriters: boolean;
    };

const VALUE_FLAGS = new Set([
  "--tenant",
  "--account",
  "--peer",
  "--confirm-digest",
  "--storage-root",
]);
const BOOLEAN_FLAGS = new Set([
  "--all-peers",
  "--apply",
  "--ignore-live-writers",
]);

/**
 * Run the command. `argv` excludes the node binary and the script path.
 *
 * Returns the process exit code instead of calling `process.exit`, so the whole
 * command is exercisable from a test with real files and no child process.
 */
export function runRotateConversationKeyCli(
  argv: readonly string[],
  streams: RotateCliStreams,
): number {
  const parsed = parseInvocation(argv);
  if (parsed.kind === "help") {
    streams.out(ROTATE_CLI_USAGE);
    return ROTATE_CLI_EXIT_OK;
  }
  if (parsed.kind === "usage-error") {
    streams.err(`${ROTATE_CLI_COMMAND}: ${parsed.message}`);
    streams.err(`Run "${ROTATE_CLI_COMMAND} --help" for usage.`);
    return ROTATE_CLI_EXIT_USAGE;
  }

  try {
    return execute(parsed, streams);
  } catch (error) {
    streams.err(`${ROTATE_CLI_COMMAND}: ${describeError(error)}`);
    // Requirement: a failure ends here. This command starts nothing, has no
    // fallback path, and must not leave the operator thinking a partial result
    // is a result.
    streams.err(
      "Rotation did NOT complete. Nothing was started. Re-run after resolving " +
        "the cause, or escalate through your incident-response process.",
    );
    return ROTATE_CLI_EXIT_FAILED;
  }
}

function execute(
  invocation: Extract<ParsedInvocation, { kind: "run" }>,
  streams: RotateCliStreams,
): number {
  const paths = tupleStoragePaths({
    tenant: invocation.tenant,
    accountId: invocation.accountId,
    ...(invocation.storageRoot !== null
      ? { storageRoot: invocation.storageRoot }
      : {}),
  });

  // An explicit target that does not exist is an error, not an empty success.
  // Creating state here would turn a typo into a new account directory.
  if (!existsSync(paths.conversationKeyPath)) {
    throw new Error(
      `no conversation-key document for tenant "${invocation.tenant}" ` +
        `account "${invocation.accountId}" at ${paths.conversationKeyPath}`,
    );
  }

  if (!invocation.ignoreLiveWriters) {
    const findings = probeLiveTupleWriters(paths.directory);
    if (findings.length > 0) {
      for (const finding of findings) streams.err(`  live writer: ${finding}`);
      throw new Error(
        "refusing to rotate: a process is writing this account's state",
      );
    }
  }

  const store = new ConversationKeyStore({
    tenant: invocation.tenant,
    accountId: invocation.accountId,
    ...(invocation.storageRoot !== null
      ? { storageRoot: invocation.storageRoot }
      : {}),
  });

  streams.out(`${ROTATE_CLI_COMMAND}`);
  streams.out(`  tenant:    ${invocation.tenant}`);
  streams.out(`  account:   ${invocation.accountId}`);
  streams.out(`  directory: ${paths.directory}`);

  return invocation.apply
    ? applyRotation(invocation, store, paths.directory, streams)
    : previewRotation(invocation, store, streams);
}

function previewRotation(
  invocation: Extract<ParsedInvocation, { kind: "run" }>,
  store: ConversationKeyStore,
  streams: RotateCliStreams,
): number {
  streams.out("  mode:      DRY RUN — no key is rotated, no key file is written");
  if (invocation.target.kind === "peer") {
    const preview = store.previewPeerRotation(invocation.target.peerId);
    streams.out(`  target:    peer ${preview.peerId}`);
    if (!preview.present) {
      throw new Error(
        `peer "${preview.peerId}" has no stored conversation key; rotation is ` +
          `not a create API`,
      );
    }
    streams.out(
      `  current:   ${
        preview.generation
          ? `generation epoch=${preview.generation.epoch} ` +
            `rotatedAtSec=${preview.generation.rotatedAtSec}`
          : "no generation label recorded (audit-only sidecar entry is missing)"
      }`,
    );
    streams.out(
      "  note:      the generation label is an audit diagnostic. It is not a " +
        "lock and not evidence about who is running.",
    );
    streams.out("");
    streams.out(`Re-run with --apply to commit.`);
    return ROTATE_CLI_EXIT_OK;
  }

  const preview = store.previewAccountRotation();
  streams.out("  target:    ALL peers in this account");
  if (preview.peerCount === 0) {
    throw new Error("this account has no stored conversation key to rotate");
  }
  streams.out(`  peers:     ${preview.peerCount}`);
  streams.out(`  digest:    ${preview.targetDigest}`);
  streams.out(
    "  note:      peer identifiers are deliberately not listed. The digest " +
      "commits to the exact target set.",
  );
  streams.out("");
  streams.out(
    `Re-run with --apply --confirm-digest ${preview.targetDigest} to commit.`,
  );
  return ROTATE_CLI_EXIT_OK;
}

function applyRotation(
  invocation: Extract<ParsedInvocation, { kind: "run" }>,
  store: ConversationKeyStore,
  directory: string,
  streams: RotateCliStreams,
): number {
  streams.out("  mode:      APPLY");

  const lock = acquireRotationLock(directory);
  let summary: PeerRotationSummary | AccountRotationSummary;
  let released = false;
  try {
    if (invocation.target.kind === "peer") {
      streams.out(`  target:    peer ${invocation.target.peerId}`);
      summary = store.rotatePeerVerified(invocation.target.peerId);
    } else {
      // Confirm the reviewed set INSIDE the lock, so the window between the
      // check and the commit contains no other rotation.
      const preview = store.previewAccountRotation();
      if (preview.targetDigest !== invocation.confirmDigest) {
        throw new Error(
          `--confirm-digest does not match this account's current target set ` +
            `(${preview.peerCount} peers, digest ${preview.targetDigest}); ` +
            `re-run the dry run and review it again`,
        );
      }
      streams.out(`  target:    ALL peers in this account`);
      const accountSummary = store.rotateAccountVerified();
      if (accountSummary.targetDigest !== invocation.confirmDigest) {
        // The set changed between the confirmed preview and the commit, i.e.
        // something else wrote to this tuple while the lock was held. The
        // rotation is durable; what it covered is not what was reviewed.
        throw new Error(
          `the target set changed during the rotation (committed digest ` +
            `${accountSummary.targetDigest}); the rotation IS committed but ` +
            `did not cover the reviewed set — treat this account as unquiesced`,
        );
      }
      summary = accountSummary;
    }
    releaseRotationLock(lock);
    released = true;
  } finally {
    // On the failure path the lock still has to go, but a release problem must
    // never replace the error that actually stopped the rotation.
    if (!released) {
      try {
        releaseRotationLock(lock);
      } catch (error) {
        streams.err(`${ROTATE_CLI_COMMAND}: ${describeError(error)}`);
      }
    }
  }

  if ("peerId" in summary) {
    streams.out(`  committed: epoch=${summary.epoch}`);
  } else {
    streams.out(`  committed: ${summary.peerCount} peers`);
    streams.out(`  digest:    ${summary.targetDigest}`);
  }
  streams.out(`  rotatedAt: ${summary.rotatedAtSec} (unix seconds)`);
  streams.out("  readback:  verified from disk");
  streams.out("");
  streams.out(
    "Rotation committed. It revoked nothing and disconnected nobody: every " +
      "affected browser must be forced through a fresh bootstrap to receive " +
      "the new key. See docs/CREDENTIAL_CONTAINMENT_RUNBOOK.md.",
  );
  return ROTATE_CLI_EXIT_OK;
}

function parseInvocation(argv: readonly string[]): ParsedInvocation {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--help" || argument === "-h") return { kind: "help" };

    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);

    if (BOOLEAN_FLAGS.has(name)) {
      if (equals !== -1) {
        return { kind: "usage-error", message: `${name} takes no value` };
      }
      flags.add(name);
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      if (values.has(name)) {
        return { kind: "usage-error", message: `${name} was given twice` };
      }
      let value: string | undefined;
      if (equals === -1) {
        index += 1;
        value = argv[index];
      } else {
        value = argument.slice(equals + 1);
      }
      if (value === undefined || value.length === 0) {
        return { kind: "usage-error", message: `${name} requires a value` };
      }
      // A missing value must not silently swallow the next flag: "--peer
      // --apply" would otherwise rotate a peer literally named "--apply", and
      // the operator would read the accompanying "--apply" as committed.
      if (equals === -1 && value.startsWith("-")) {
        return {
          kind: "usage-error",
          message: `${name} requires a value, but "${value}" is a flag`,
        };
      }
      values.set(name, value);
      continue;
    }
    return { kind: "usage-error", message: `unknown argument "${argument}"` };
  }

  const tenant = values.get("--tenant");
  const accountId = values.get("--account");
  if (tenant === undefined || accountId === undefined) {
    return {
      kind: "usage-error",
      message: "--tenant and --account are both required",
    };
  }

  const peerId = values.get("--peer");
  const allPeers = flags.has("--all-peers");
  if (peerId === undefined && !allPeers) {
    return {
      kind: "usage-error",
      message:
        "name the target explicitly: --peer <peerId>, or --all-peers for the " +
        "whole account. There is no default.",
    };
  }
  if (peerId !== undefined && allPeers) {
    return {
      kind: "usage-error",
      message: "--peer and --all-peers are mutually exclusive",
    };
  }

  const apply = flags.has("--apply");
  const confirmDigest = values.get("--confirm-digest");
  if (allPeers && apply && confirmDigest === undefined) {
    return {
      kind: "usage-error",
      message:
        "--all-peers --apply requires --confirm-digest <hex> from the matching " +
        "dry run",
    };
  }
  if (confirmDigest !== undefined && !(allPeers && apply)) {
    return {
      kind: "usage-error",
      message: "--confirm-digest only applies to --all-peers --apply",
    };
  }

  return {
    kind: "run",
    tenant,
    accountId,
    target:
      peerId !== undefined
        ? { kind: "peer", peerId }
        : ({ kind: "account" } as const),
    apply,
    confirmDigest: confirmDigest ?? null,
    storageRoot: values.get("--storage-root") ?? null,
    ignoreLiveWriters: flags.has("--ignore-live-writers"),
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.startsWith("webchannel: ")
      ? error.message.slice("webchannel: ".length)
      : error.message;
  }
  return "rotation failed";
}
