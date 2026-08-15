import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { NatsResolverConfig } from "./types.js";

export type FullResolverNatsConfigOptions = {
  /** Path to the operator JWT read by nats-server. */
  operatorJwtPath: string;
  /** Stable, caller-owned directory used by the full resolver. */
  resolverDir: string;
  /** Public NKEY of the operator's system account. */
  systemAccountPublicKey: string;
  /** Account JWTs used to seed the writable resolver at startup. */
  resolverConfig: NatsResolverConfig;
  /**
   * Optional subset of `resolverConfig` to seed on this startup. Omit to seed
   * every configured account; pass an empty object to preserve an initialized
   * resolver without replaying stale bootstrap claims.
   */
  resolverPreload?: NatsResolverConfig;
  /** Plain NATS listener port. `-1` lets nats-server choose an ephemeral port. */
  tcpPort: number;
  /** WebSocket listener port. `-1` lets nats-server choose an ephemeral port. */
  websocketPort: number;
  /** Optional bind host applied to both listeners. */
  host?: string;
};

export type PrepareFullResolverNatsConfigOptions = Omit<
  FullResolverNatsConfigOptions,
  "resolverDir" | "resolverPreload"
> & {
  /** Caller-owned run/deployment root that persists across server restarts. */
  configDir: string;
};

export type PreparedFullResolverNatsConfig = {
  config: string;
  resolverDir: string;
};

const RESOLVER_DIRECTORY_NAME = "resolver-jwt";

/**
 * Prepare a restart-safe full-resolver configuration beneath `configDir`.
 *
 * The fixed directory name makes runtime claim updates survive regenerated
 * `nats.conf` files. Existing account JWT files are deliberately excluded from
 * `resolver_preload`: replaying the caller's bootstrap JWT on every boot could
 * otherwise replace a newer accepted claim (including a revocation).
 *
 * Callers retain isolation by providing a distinct run/deployment root.
 */
export function prepareFullResolverNatsConfig(
  options: PrepareFullResolverNatsConfigOptions,
): PreparedFullResolverNatsConfig {
  const { configDir, ...renderOptions } = options;
  assertNonEmpty(configDir, "configDir");
  const resolverDir = join(configDir, RESOLVER_DIRECTORY_NAME);
  mkdirSync(resolverDir, { recursive: true, mode: 0o700 });
  chmodSync(resolverDir, 0o700);

  const resolverPreload = Object.fromEntries(
    Object.entries(options.resolverConfig).filter(
      ([accountPublicKey]) =>
        !existsSync(join(resolverDir, `${accountPublicKey}.jwt`)),
    ),
  );

  return {
    resolverDir,
    config: renderFullResolverNatsConfig({
      ...renderOptions,
      resolverDir,
      resolverPreload,
    }),
  };
}

/**
 * Render the single full/Dir resolver configuration used by every
 * self-contained nats-server harness in this repository.
 *
 * `resolver_preload` is supported by the writable full resolver: nats-server
 * stores these initial JWTs in `resolverDir`, after which runtime
 * `$SYS.REQ.CLAIMS.UPDATE` requests can replace them.
 */
export function renderFullResolverNatsConfig(
  options: FullResolverNatsConfigOptions,
): string {
  assertPort(options.tcpPort, "tcpPort");
  assertPort(options.websocketPort, "websocketPort");
  assertNonEmpty(options.operatorJwtPath, "operatorJwtPath");
  assertNonEmpty(options.resolverDir, "resolverDir");
  assertNonEmpty(options.systemAccountPublicKey, "systemAccountPublicKey");

  const entries = Object.entries(options.resolverConfig).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) {
    throw new Error("resolverConfig must contain at least one account JWT");
  }
  if (!options.resolverConfig[options.systemAccountPublicKey]) {
    throw new Error("resolverConfig does not contain the configured system account");
  }

  const preloadEntries = Object.entries(
    options.resolverPreload ?? options.resolverConfig,
  ).sort(([a], [b]) => a.localeCompare(b));

  const lines: string[] = [];
  if (options.host) lines.push(`host: ${quote(options.host)}`);
  lines.push(`port: ${options.tcpPort}`, "websocket {");
  if (options.host) lines.push(`  host: ${quote(options.host)}`);
  lines.push(
    `  port: ${options.websocketPort}`,
    "  no_tls: true",
    "}",
    `operator: ${quote(options.operatorJwtPath)}`,
    `system_account: ${quote(options.systemAccountPublicKey)}`,
    "resolver: {",
    "  type: full",
    `  dir: ${quote(options.resolverDir)}`,
    "  allow_delete: false",
    '  interval: "2m"',
    "}",
  );
  for (const [accountPublicKey] of entries) {
    if (!/^A[A-Z2-7]+$/.test(accountPublicKey)) {
      throw new Error(
        `resolverConfig contains an invalid account public key: ${accountPublicKey}`,
      );
    }
  }
  if (preloadEntries.length > 0) {
    lines.push("resolver_preload: {");
    for (const [accountPublicKey, accountJwt] of preloadEntries) {
      if (!options.resolverConfig[accountPublicKey]) {
        throw new Error(
          `resolverPreload contains an account absent from resolverConfig: ${accountPublicKey}`,
        );
      }
      lines.push(`  ${accountPublicKey}: ${quote(accountJwt)}`);
    }
    lines.push("}");
  }
  lines.push("");
  return lines.join("\n");
}

function assertPort(port: number, name: string): void {
  if (!Number.isInteger(port) || (port !== -1 && (port < 1 || port > 65535))) {
    throw new Error(`${name} must be -1 or an integer from 1 through 65535`);
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}
