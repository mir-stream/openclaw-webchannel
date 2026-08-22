/**
 * NATS relay boot — assemble a JWT-auth nats-server from the PUBLIC natsConfig.
 *
 * `loadOrCreateTrustChain(...).natsConfig` is the public
 * `NatsSelfContainedAccountConfig` (operatorJwt + resolverConfig + system
 * account). Standard operations: write the trust artifacts, assemble a
 * nats.conf with a writable full/Dir resolver, spawn `nats-server`.
 *
 * This file imports only the published SaaS package API — no repository-relative
 * or deep internal package paths — so the example stays public-API-clean.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWritePrivateFile,
  prepareFullResolverNatsConfig,
  type NatsSelfContainedAccountConfig,
} from "openclaw-webchannel-saas";

export type NatsBootOptions = {
  /** Public self-contained NATS config from the trust chain. */
  natsConfig: NatsSelfContainedAccountConfig;
  /** Private system-account `.creds` contents; written owner-readable only. */
  systemAccountCredentials: string;
  /** Directory to write operator.jwt / resolver.json / nats.conf into. */
  configDir: string;
  /** WebSocket port the browser dials. */
  wsPort: number;
  /** Plain TCP client port (nats-server requires one). */
  tcpPort: number;
};

export type NatsHandle = {
  proc: ChildProcess;
  natsUrl: string;
  /** Resolves once the server logs readiness (or rejects on early exit). */
  ready: Promise<void>;
};

/**
 * Write the nats-server config from `natsConfig` and spawn `nats-server`.
 * Requires the `nats-server` binary on PATH.
 */
export function bootNatsServer(opts: NatsBootOptions): NatsHandle {
  mkdirSync(opts.configDir, { recursive: true, mode: 0o700 });
  const operatorJwtPath = join(opts.configDir, "operator.jwt");
  writeFileSync(operatorJwtPath, opts.natsConfig.operatorJwt);
  writeFileSync(
    join(opts.configDir, "resolver.json"),
    JSON.stringify(opts.natsConfig.resolverConfig, null, 2),
  );
  const systemCredentialsPath = join(opts.configDir, "system-account.creds");
  atomicWritePrivateFile(systemCredentialsPath, opts.systemAccountCredentials);

  const { config: conf } = prepareFullResolverNatsConfig({
    configDir: opts.configDir,
    operatorJwtPath,
    systemAccountPublicKey: opts.natsConfig.systemAccountPublicKey,
    resolverConfig: opts.natsConfig.resolverConfig,
    tcpPort: opts.tcpPort,
    websocketPort: opts.wsPort,
  });
  const confPath = join(opts.configDir, "nats.conf");
  writeFileSync(confPath, conf);

  const proc = spawn("nats-server", ["-c", confPath], { stdio: ["ignore", "pipe", "pipe"] });
  const natsUrl = `ws://127.0.0.1:${opts.wsPort}`;

  const ready = new Promise<void>((resolve, reject) => {
    let done = false;
    const onData = (buf: Buffer) => {
      // nats-server logs readiness to stderr by default.
      if (!done && buf.toString().includes("Server is ready")) {
        done = true;
        resolve();
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => {
      if (!done) reject(new Error(`nats-server exited early (code ${code})`));
    });
    proc.on("error", (err) => {
      if (!done) reject(err);
    });
  });

  return { proc, natsUrl, ready };
}
