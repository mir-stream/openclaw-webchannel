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
 * (decision of 2026-08-16). `rotation-preflight.ts` refuses any existing lock
 * and, by default, any atomic-write temp artifact, including artifacts whose
 * pid could belong to another host/pod. That is all it catches — an idle but
 * running gateway is invisible to it. Bringing observed replicas to zero first
 * is an operator obligation, imposed by step ① of
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

import {
  type AccountRotationSummary,
  ConversationKeyReadbackError,
  ConversationKeyTargetDigestMismatchError,
  type PeerRotationSummary,
  OfflineConversationKeyRotator,
} from "./offline-conversation-key-rotation.js";
import {
  acquireRotationLock,
  probeLiveTupleWriters,
  releaseRotationLock,
  RotationPreflightError,
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

  Without --apply this is a DRY RUN: it rotates nothing. That is the default on
  purpose — review the blast radius, then commit it. A dry run DOES complete the
  one-time pre-v2 storage migration if this tuple still needs it; that migration
  may move legacy files and publish their v2 destinations, but it does not
  replace K. What you review is therefore exactly what apply would rotate.

OPTIONS
  --tenant <tenant>       Exact tenant. Required. There is no default tenant.
  --account <accountId>   Exact account id. Required.
  --peer <peerId>         Rotate exactly this peer. Rotation is not a create
                          API: an unknown peerId is refused, never registered.
  --all-peers             Rotate EVERY peer of this account as one commit.
                          Never implied — you have to ask for it.
  --apply                 Commit K replacement. Without it, no K is rotated;
                          the one-time migration exception above still applies.
  --confirm-digest <hex>  Required with "--all-peers --apply": the tuple+target-
                          set digest printed by the matching dry run. A digest
                          from another tuple, or a changed peer set, is refused
                          before either document is written.
  --storage-root <dir>    Override the v2 storage root. Only for deployments
                          that moved it; the tuple layout underneath is fixed.
  --ignore-live-writers   Bypass the temp-artifact refusal (see below).
  --help, -h              Print this and exit.

WHAT THIS COMMAND CANNOT DO
  Rotation is supported only when this account has one local tuple store, or
  when every replica uses the SAME authoritative tuple store. Independent
  per-replica volumes are unsupported. Do not run this command once per volume:
  each run generates a different K_new and leaves the replicas divergent. Stop
  and escalate instead.

  It cannot prove that no gateway is running. Every APPLY refuses a pre-existing
  rotation lock. By default, both a dry run and an apply refuse every matching
  atomic-write temp artifact. A pid is only meaningful on its own host/pod, so
  this tool never calls a remote-looking lock or artifact stale and never removes
  a pre-existing lock automatically.
  A gateway that is up but momentarily idle looks exactly like a stopped one:
  this plugin holds no lease and no pidfile, and a library cannot know what
  process supervisor it lives under. Stopping every replica and confirming an
  observed count of zero is YOUR step, and it is load-bearing. If you rotate
  while a replica is alive, that replica keeps serving the old K it already has
  in memory to already-connected browsers while this command commits the new
  one, and nothing reports the split.

  --ignore-live-writers bypasses only the temp-artifact refusal after you have
  inspected those artifacts and verified the deployment externally. It never
  bypasses or removes a pre-existing rotation lock. Using it makes the writer
  decision your own judgement, based on the replica count and shared-store state
  you observed outside this tool. It does not make the rotation safer or prove
  liveness.

ON APPLY FAILURE
  Read the explicit APPLY OUTCOME. A pre-commit refusal, a commit whose complete
  durable readback did not verify, and a verified commit whose lock cleanup
  failed are different states. After a possible or known commit, keep replicas
  stopped and inspect/escalate; never rerun blindly.

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

type RotateCliRuntime = Readonly<{
  home?: string;
  /** @internal Test-only fault seam after document publication, before readback. */
  _beforeVerifiedReadback?: () => void;
  /** @internal Test-only fault seam immediately before lock release. */
  _beforeLockRelease?: () => void;
}>;

type ApplyFailureState =
  | "no-verified-commit"
  | "committed-unverified"
  | "committed-verified-review-mismatch"
  | "committed-verified-cleanup-failed";

class RotationApplyOutcomeError extends Error {
  readonly state: ApplyFailureState;
  readonly cleanupFailed: boolean;
  private readonly detail: string;

  constructor(
    state: ApplyFailureState,
    error: unknown,
    cleanupError?: unknown,
  ) {
    const detail = describeError(error);
    const cleanupDetail = cleanupError === undefined
      ? null
      : describeError(cleanupError);
    super(
      cleanupDetail === null
        ? detail
        : `${detail}; rotation-lock cleanup also failed (${cleanupDetail})`,
    );
    this.name = "RotationApplyOutcomeError";
    this.state = state;
    this.cleanupFailed = cleanupDetail !== null;
    this.detail = detail;
  }

  withCleanupFailure(error: unknown): RotationApplyOutcomeError {
    return new RotationApplyOutcomeError(this.state, this.detail, error);
  }
}

/**
 * Run the command. `argv` excludes the node binary and the script path.
 *
 * Returns the process exit code instead of calling `process.exit`, so the whole
 * command is exercisable from a test with real files and no child process.
 */
export function runRotateConversationKeyCli(
  argv: readonly string[],
  streams: RotateCliStreams,
  runtime: RotateCliRuntime = {},
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
    return execute(parsed, streams, runtime);
  } catch (error) {
    streams.err(`${ROTATE_CLI_COMMAND}: ${describeError(error)}`);
    reportFailureOutcome(parsed, error, streams);
    return ROTATE_CLI_EXIT_FAILED;
  }
}

function execute(
  invocation: Extract<ParsedInvocation, { kind: "run" }>,
  streams: RotateCliStreams,
  runtime: RotateCliRuntime,
): number {
  const paths = tupleStoragePaths({
    tenant: invocation.tenant,
    accountId: invocation.accountId,
    ...(invocation.storageRoot !== null
      ? { storageRoot: invocation.storageRoot }
      : {}),
    ...(runtime.home !== undefined ? { home: runtime.home } : {}),
  });

  if (!invocation.ignoreLiveWriters) {
    const findings = probeLiveTupleWriters(paths.directory);
    if (findings.length > 0) {
      for (const finding of findings) {
        streams.err(`  possible writer artifact: ${finding}`);
      }
      throw new RotationPreflightError(
        "refusing to rotate while atomic-write temp artifacts exist; leave " +
          "them untouched, keep every replica stopped, and inspect or escalate",
        findings,
      );
    }
  }

  const rotator = new OfflineConversationKeyRotator({
    tenant: invocation.tenant,
    accountId: invocation.accountId,
    ...(invocation.storageRoot !== null
      ? { storageRoot: invocation.storageRoot }
      : {}),
    ...(runtime.home !== undefined ? { home: runtime.home } : {}),
    ...(runtime._beforeVerifiedReadback !== undefined
      ? { _beforeCachePublish: runtime._beforeVerifiedReadback }
      : {}),
  });

  // Migrate first, then refuse a missing explicit target BEFORE taking a lock.
  // The lock lives inside the v2 tuple directory, so taking it first would turn
  // a typo/no-state apply into a surprising empty directory.
  if (invocation.apply) assertApplyTargetExists(invocation, rotator);

  streams.out(`${ROTATE_CLI_COMMAND}`);
  streams.out(`  tenant:    ${invocation.tenant}`);
  streams.out(`  account:   ${invocation.accountId}`);
  streams.out(`  directory: ${paths.directory}`);

  return invocation.apply
    ? applyRotation(invocation, rotator, paths.directory, streams, runtime)
    : previewRotation(invocation, rotator, streams);
}

function assertApplyTargetExists(
  invocation: Extract<ParsedInvocation, { kind: "run" }>,
  rotator: OfflineConversationKeyRotator,
): void {
  if (invocation.target.kind === "peer") {
    if (!rotator.previewPeerRotation(invocation.target.peerId).present) {
      throw new Error(
        `peer "${invocation.target.peerId}" has no stored conversation key; ` +
          `rotation is not a create API`,
      );
    }
    return;
  }
  if (rotator.previewAccountRotation().peerCount === 0) {
    throw new Error("this account has no stored conversation key to rotate");
  }
}

function previewRotation(
  invocation: Extract<ParsedInvocation, { kind: "run" }>,
  rotator: OfflineConversationKeyRotator,
  streams: RotateCliStreams,
): number {
  streams.out(
    "  mode:      DRY RUN — no key is rotated (legacy migration may complete)",
  );
  if (invocation.target.kind === "peer") {
    const preview = rotator.previewPeerRotation(invocation.target.peerId);
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

  const preview = rotator.previewAccountRotation();
  streams.out("  target:    ALL peers in this account");
  if (preview.peerCount === 0) {
    throw new Error("this account has no stored conversation key to rotate");
  }
  streams.out(`  peers:     ${preview.peerCount}`);
  streams.out(`  digest:    ${preview.targetDigest}`);
  streams.out(
    "  note:      peer identifiers are deliberately not listed. The digest " +
      "commits to this exact tuple and target set.",
  );
  streams.out("");
  streams.out(
    `Re-run with --apply --confirm-digest ${preview.targetDigest} to commit.`,
  );
  return ROTATE_CLI_EXIT_OK;
}

function applyRotation(
  invocation: Extract<ParsedInvocation, { kind: "run" }>,
  rotator: OfflineConversationKeyRotator,
  directory: string,
  streams: RotateCliStreams,
  runtime: RotateCliRuntime,
): number {
  streams.out("  mode:      APPLY");

  const lock = acquireRotationLock(directory);
  let summary: PeerRotationSummary | AccountRotationSummary | null = null;
  let failure: unknown = null;
  try {
    if (invocation.target.kind === "peer") {
      streams.out(`  target:    peer ${invocation.target.peerId}`);
      summary = rotator.rotatePeerVerified(invocation.target.peerId);
    } else {
      // Confirm the reviewed set INSIDE the lock, so the window between the
      // check and the commit contains no other rotation.
      const preview = rotator.previewAccountRotation();
      if (preview.targetDigest !== invocation.confirmDigest) {
        throw new ConversationKeyTargetDigestMismatchError(
          preview.peerCount,
          preview.targetDigest,
        );
      }
      streams.out(`  target:    ALL peers in this account`);
      const accountSummary = rotator.rotateAccountVerified(
        invocation.confirmDigest as string,
      );
      summary = accountSummary;
      if (accountSummary.targetDigest !== invocation.confirmDigest) {
        // The batch method rechecks the same digest before either write. This
        // remains a defense against a broken/future implementation returning a
        // different verified summary after it committed.
        throw new RotationApplyOutcomeError(
          "committed-verified-review-mismatch",
          `committed tuple+target-set digest ${accountSummary.targetDigest} ` +
            `did not match the reviewed digest`,
        );
      }
    }
  } catch (error) {
    failure = error instanceof ConversationKeyReadbackError
      ? new RotationApplyOutcomeError("committed-unverified", error)
      : error;
  }

  try {
    runtime._beforeLockRelease?.();
    releaseRotationLock(lock);
  } catch (cleanupError) {
    if (failure instanceof RotationApplyOutcomeError) {
      failure = failure.withCleanupFailure(cleanupError);
    } else if (failure !== null) {
      failure = new RotationApplyOutcomeError(
        "no-verified-commit",
        failure,
        cleanupError,
      );
    } else {
      failure = new RotationApplyOutcomeError(
        "committed-verified-cleanup-failed",
        cleanupError,
      );
    }
  }
  if (failure !== null) throw failure;
  if (summary === null) {
    throw new RotationApplyOutcomeError(
      "no-verified-commit",
      "rotation returned no verified summary",
    );
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

function reportFailureOutcome(
  invocation: Extract<ParsedInvocation, { kind: "run" }>,
  error: unknown,
  streams: RotateCliStreams,
): void {
  if (!invocation.apply) {
    streams.err(
      "DRY-RUN OUTCOME: no K was rotated; the one-time legacy migration may " +
        "have completed. Resolve the reported cause before another dry run.",
    );
    return;
  }

  if (error instanceof RotationApplyOutcomeError) {
    switch (error.state) {
      case "committed-unverified":
        streams.err(
          "APPLY OUTCOME: the rotation commit path completed, but complete " +
            "durable readback did not verify. Treat tuple state as changed and " +
            "unverified; keep every replica stopped, inspect both documents, " +
            "and escalate. Do not rerun blindly.",
        );
        break;
      case "committed-verified-review-mismatch":
        streams.err(
          "APPLY OUTCOME: rotation committed and complete durable readback " +
            "verified, but the committed tuple+target set did not match the " +
            "reviewed digest. K is rotated; keep every replica stopped and " +
            "treat the tuple as unquiesced. Do not rerun blindly.",
        );
        break;
      case "committed-verified-cleanup-failed":
        streams.err(
          "APPLY OUTCOME: K rotation committed; complete durable readback " +
            "verified, but rotation-lock cleanup failed. K is rotated; leave " +
            "the lock untouched, keep every replica stopped, and inspect or " +
            "escalate. Do not rerun.",
        );
        break;
      case "no-verified-commit":
        streams.err(
          "APPLY OUTCOME: no verified commit was established and durable tuple " +
            "state may have changed. Keep every replica stopped, inspect both " +
            "documents and the lock, and escalate. Do not rerun blindly.",
        );
        break;
    }
    if (error.cleanupFailed) {
      streams.err(
        "Rotation-lock cleanup also failed. Leave the lock untouched until its " +
          "ownership and the durable tuple state have been inspected.",
      );
    }
    return;
  }

  if (
    error instanceof RotationPreflightError ||
    error instanceof ConversationKeyTargetDigestMismatchError
  ) {
    streams.err(
      "APPLY OUTCOME: no rotation commit was attempted. K was not changed by " +
        "this invocation; legacy migration may have completed. Keep every " +
        "replica stopped and inspect the reported lock, artifact, or target " +
        "before deciding whether a new dry run is safe.",
    );
    return;
  }

  streams.err(
    "APPLY OUTCOME: no verified commit was established and durable tuple state " +
      "may have changed. Keep every replica stopped, inspect both documents " +
      "and the lock, and escalate. Do not rerun blindly.",
  );
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
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    return error.message.startsWith("webchannel: ")
      ? error.message.slice("webchannel: ".length)
      : error.message;
  }
  return "rotation failed";
}
