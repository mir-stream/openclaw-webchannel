import type { NatsResolverConfig } from "./types.js";

export type FullResolverNatsConfigOptions = {
  /** Path to the operator JWT read by nats-server. */
  operatorJwtPath: string;
  /** Fresh, run-local directory owned by the full resolver. */
  resolverDir: string;
  /** Public NKEY of the operator's system account. */
  systemAccountPublicKey: string;
  /** Account JWTs used to seed the writable resolver at startup. */
  resolverConfig: NatsResolverConfig;
  /** Plain NATS listener port. `-1` lets nats-server choose an ephemeral port. */
  tcpPort: number;
  /** WebSocket listener port. `-1` lets nats-server choose an ephemeral port. */
  websocketPort: number;
  /** Optional bind host applied to both listeners. */
  host?: string;
};

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
    "resolver_preload: {",
  );
  for (const [accountPublicKey, accountJwt] of entries) {
    if (!/^A[A-Z2-7]+$/.test(accountPublicKey)) {
      throw new Error(
        `resolverConfig contains an invalid account public key: ${accountPublicKey}`,
      );
    }
    lines.push(`  ${accountPublicKey}: ${quote(accountJwt)}`);
  }
  lines.push("}", "");
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
