import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  getReplyFromConfig,
  type GetReplyOptions,
  type MsgContext,
} from "openclaw/plugin-sdk/reply-runtime";

import { resolvePeerCommandAuthorization } from "../src/command-gate.js";
import { resolveDmAdmission } from "../src/dm-allowlist.js";

const root = process.argv[2];
if (!root) throw new Error("missing isolated state root");

const peer = "peer-1";
const preparedSentinel = new Error("session prepared");
type PreparedOptions = GetReplyOptions & {
  onSessionPrepared?: (state: {
    sessionKey?: string;
    sessionId?: string;
    storePath?: string;
  }) => void;
};

type Scenario = {
  name: string;
  command: "/new" | "/reset";
  commands?: Record<string, unknown>;
  resets: boolean;
};

const scenarios: readonly Scenario[] = [
  { name: "commands allowFrom denies /new", command: "/new", commands: { allowFrom: { webchannel: ["someone-else"] } }, resets: false },
  { name: "commands allowFrom denies /reset", command: "/reset", commands: { allowFrom: { webchannel: ["someone-else"] } }, resets: false },
  { name: "owner allowFrom denies /new", command: "/new", commands: { ownerAllowFrom: ["someone-else"] }, resets: false },
  { name: "owner allowFrom denies /reset", command: "/reset", commands: { ownerAllowFrom: ["someone-else"] }, resets: false },
  { name: "open policy permits /new", command: "/new", resets: true },
  { name: "commands allowFrom permits /reset", command: "/reset", commands: { allowFrom: { webchannel: [peer] } }, resets: true },
  { name: "owner allowFrom permits /new", command: "/new", commands: { ownerAllowFrom: [peer] }, resets: true },
];

const results: Array<{
  name: string;
  authorized: boolean;
  prepared: boolean;
  before: string;
  after: string;
  resets: boolean;
}> = [];

for (const [index, scenario] of scenarios.entries()) {
  const scenarioRoot = join(root, String(index));
  const workspace = join(scenarioRoot, "workspace");
  const agentDir = join(scenarioRoot, "agent");
  const storePath = join(scenarioRoot, "sessions.json");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const sessionKey = `agent:probe:webchannel:default:direct:${peer}-${index}`;
  const before = randomUUID();
  writeFileSync(storePath, JSON.stringify({
    [sessionKey]: { sessionId: before, updatedAt: Date.now(), systemSent: true },
  }));

  const cfg = {
    session: { store: storePath, reset: { mode: "idle", idleMinutes: 1440 } },
    agents: {
      defaults: { skipBootstrap: true },
      list: [{ id: "probe", default: true, workspace, agentDir }],
    },
    ...(scenario.commands ? { commands: scenario.commands } : {}),
  } as unknown as OpenClawConfig;
  const identity: MsgContext = {
    Body: scenario.command,
    RawBody: scenario.command,
    CommandBody: scenario.command,
    BodyForCommands: scenario.command,
    SessionKey: sessionKey,
    AgentId: "probe",
    Provider: "webchannel",
    Surface: "webchannel",
    OriginatingChannel: "webchannel",
    AccountId: "default",
    SenderId: peer,
    From: peer,
    To: peer,
    ChatType: "direct",
    MessageSid: `command-auth-${index}`,
  };
  const authorized = resolvePeerCommandAuthorization({
    admission: resolveDmAdmission(peer, { allowFrom: ["*"] }),
    cfg,
    ctx: identity,
  });
  let prepared = false;
  const options: PreparedOptions = {
    onSessionPrepared: () => {
      prepared = true;
      throw preparedSentinel;
    },
  };
  try {
    await getReplyFromConfig(
      { ...identity, CommandAuthorized: authorized },
      options as GetReplyOptions,
      cfg,
    );
  } catch (error) {
    if (error !== preparedSentinel) throw error;
  }

  const store = JSON.parse(readFileSync(storePath, "utf8")) as Record<
    string,
    { sessionId: string }
  >;
  results.push({
    name: scenario.name,
    authorized,
    prepared,
    before,
    after: store[sessionKey]?.sessionId ?? "",
    resets: scenario.resets,
  });
}

process.stdout.write(JSON.stringify(results));
