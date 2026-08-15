import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type WebchannelAppStatePaths = {
  trustChainPath: string;
  natsConfigDir: string;
  /** Present only for an ephemeral zero-configuration run. */
  ephemeralRoot?: string;
};

/**
 * Resolve trust-chain and NATS resolver storage as one lifetime unit.
 *
 * An explicit trust-chain path gets a deterministic sibling NATS directory so
 * full application restarts keep runtime resolver updates. Without an explicit
 * trust path, both artifacts live under one unpredictable owner-only run root.
 * An explicit NATS directory always remains caller-owned.
 */
export function resolveWebchannelAppStatePaths(
  env: Partial<Pick<NodeJS.ProcessEnv, "TRUST_CHAIN_PATH" | "NATS_CONFIG_OUT">> =
    process.env,
  temporaryDirectory = tmpdir(),
): WebchannelAppStatePaths {
  const explicitTrustChainPath = env.TRUST_CHAIN_PATH || undefined;
  const explicitNatsConfigDir = env.NATS_CONFIG_OUT || undefined;

  if (explicitTrustChainPath) {
    return {
      trustChainPath: explicitTrustChainPath,
      natsConfigDir: explicitNatsConfigDir || `${explicitTrustChainPath}.nats`,
    };
  }

  const ephemeralRoot = mkdtempSync(join(temporaryDirectory, "webchannel-app-"));
  chmodSync(ephemeralRoot, 0o700);
  return {
    trustChainPath: join(ephemeralRoot, "trust-chain.json"),
    natsConfigDir: explicitNatsConfigDir || join(ephemeralRoot, "nats"),
    ephemeralRoot,
  };
}
