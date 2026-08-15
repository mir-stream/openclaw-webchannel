#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { prepareFullResolverNatsConfig } from "../packages/saas/src/nats-server-config.ts";

const configDir = requiredEnv("NATS_CONFIG_DIR");
const tcpPort = parsePort(requiredEnv("NATS_TCP"), "NATS_TCP");
const websocketPort = parsePort(requiredEnv("NATS_WS"), "NATS_WS");
const operatorJwtPath = join(configDir, "operator.jwt");
const resolverPath = join(configDir, "resolver.json");
const systemCredentialsPath = join(configDir, "system-account.creds");

for (const path of [operatorJwtPath, resolverPath, systemCredentialsPath]) {
  if (!existsSync(path)) throw new Error(`required NATS artifact is missing: ${path}`);
}
const credentialMode = statSync(systemCredentialsPath).mode & 0o777;
if (credentialMode !== 0o600) {
  throw new Error(
    `system-account credential at ${systemCredentialsPath} must have mode 0600 ` +
      `(found ${credentialMode.toString(8).padStart(4, "0")})`,
  );
}

const operatorJwt = readFileSync(operatorJwtPath, "utf8").trim();
const systemAccountPublicKey = operatorSystemAccount(operatorJwt, operatorJwtPath);
const resolverConfig = JSON.parse(readFileSync(resolverPath, "utf8"));

const { config } = prepareFullResolverNatsConfig({
  configDir,
  operatorJwtPath,
  systemAccountPublicKey,
  resolverConfig,
  tcpPort,
  websocketPort,
  ...(process.env.NATS_HOST ? { host: process.env.NATS_HOST } : {}),
});
writeFileSync(join(configDir, "nats.conf"), config);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || (port !== -1 && (port < 1 || port > 65535))) {
    throw new Error(`${name} must be -1 or an integer from 1 through 65535`);
  }
  return port;
}

function operatorSystemAccount(jwt, path) {
  const segments = jwt.split(".");
  if (segments.length !== 3) throw new Error(`operator JWT at ${path} is not a compact JWT`);
  let payload;
  try {
    payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    throw new Error(`operator JWT at ${path} has an invalid payload`);
  }
  const account = payload?.nats?.system_account;
  if (typeof account !== "string" || !/^A[A-Z2-7]+$/.test(account)) {
    throw new Error(`operator JWT at ${path} has no valid system account`);
  }
  return account;
}
