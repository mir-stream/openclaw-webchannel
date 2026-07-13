import { describe, it, expect } from "vitest";

import { resolveCommandGate } from "./command-gate.js";
import type { CommandGateConfig } from "./command-gate.js";

/**
 * P1-8a follow-up — the command-gate MIRROR.
 *
 * `resolveCommandGate` is a best-effort, UX-only mirror of core's
 * `resolveCommandSenderAuthorization` (node_modules/openclaw/dist/
 * command-auth-DskH_Lgk.js). It answers ONE question for the widget: when an
 * operator has configured a commands/owner allowlist, core IGNORES our
 * `access.commands.authorized` stamp, so a non-listed peer's `/stop` silently
 * fails — and the caller should send a hedged notice. These tests pin the
 * membership + delegation semantics against the traced config paths
 * (`cfg.commands.allowFrom` map keyed by channel/"*", and `cfg.commands.ownerAllowFrom`).
 */

const ACCOUNT = "default";

describe("resolveCommandGate — not delegated (stamp path)", () => {
  it("delegated:false when no commands config at all", () => {
    const gate = resolveCommandGate({}, ACCOUNT);
    expect(gate.delegated).toBe(false);
  });

  it("delegated:false when commands.allowFrom targets a DIFFERENT channel (no webchannel / '*')", () => {
    // Core: `commandsAllowFromList` resolves null for webchannel → stamp path
    // governs (branch 3), so the stamp still works and no notice is warranted.
    const cfg: CommandGateConfig = { commands: { allowFrom: { telegram: ["123"] } } };
    const gate = resolveCommandGate(cfg, ACCOUNT);
    expect(gate.delegated).toBe(false);
  });
});

describe("resolveCommandGate — commands.allowFrom (channel-keyed)", () => {
  it("delegated:true, isListed:false for a peer absent from the webchannel list", () => {
    const cfg: CommandGateConfig = { commands: { allowFrom: { webchannel: ["alice"] } } };
    const gate = resolveCommandGate(cfg, ACCOUNT);
    expect(gate.delegated).toBe(true);
    expect(gate.isListed("bob")).toBe(false);
  });

  it("isListed:true for a peer present in the webchannel list", () => {
    const cfg: CommandGateConfig = { commands: { allowFrom: { webchannel: ["alice", "bob"] } } };
    const gate = resolveCommandGate(cfg, ACCOUNT);
    expect(gate.isListed("bob")).toBe(true);
  });

  it("honors the '*' array under the webchannel key (allow-all)", () => {
    const cfg: CommandGateConfig = { commands: { allowFrom: { webchannel: ["*"] } } };
    const gate = resolveCommandGate(cfg, ACCOUNT);
    expect(gate.delegated).toBe(true);
    expect(gate.isListed("anyone")).toBe(true);
  });

  it("falls back to the '*' provider list when webchannel has no entry", () => {
    const cfg: CommandGateConfig = { commands: { allowFrom: { "*": ["alice"] } } };
    const gate = resolveCommandGate(cfg, ACCOUNT);
    expect(gate.delegated).toBe(true);
    expect(gate.isListed("alice")).toBe(true);
    expect(gate.isListed("bob")).toBe(false);
  });

  it("prefers the webchannel-specific list over '*' (mirrors core precedence)", () => {
    const cfg: CommandGateConfig = {
      commands: { allowFrom: { webchannel: ["alice"], "*": ["bob"] } },
    };
    const gate = resolveCommandGate(cfg, ACCOUNT);
    expect(gate.isListed("alice")).toBe(true);
    // "*" list is NOT consulted once the provider-specific array is present.
    expect(gate.isListed("bob")).toBe(false);
  });

  it("an EMPTY configured list delegates but authorizes no one", () => {
    // Core: commandsAllowFromList = [] is non-null → branch (A) with no match.
    const cfg: CommandGateConfig = { commands: { allowFrom: { webchannel: [] } } };
    const gate = resolveCommandGate(cfg, ACCOUNT);
    expect(gate.delegated).toBe(true);
    expect(gate.isListed("alice")).toBe(false);
  });

  it("trims whitespace on both list entries and the queried peer", () => {
    const cfg: CommandGateConfig = { commands: { allowFrom: { webchannel: ["  alice  "] } } };
    const gate = resolveCommandGate(cfg, ACCOUNT);
    expect(gate.isListed("alice")).toBe(true);
    expect(gate.isListed("  alice  ")).toBe(true);
  });

  it("match is case-sensitive (core does not lowercase for webchannel)", () => {
    const cfg: CommandGateConfig = { commands: { allowFrom: { webchannel: ["Alice"] } } };
    const gate = resolveCommandGate(cfg, ACCOUNT);
    expect(gate.isListed("alice")).toBe(false);
    expect(gate.isListed("Alice")).toBe(true);
  });
});

describe("resolveCommandGate — commands.ownerAllowFrom (owner enforcement)", () => {
  it("delegated:true, isListed:false for a peer absent from the owner allowlist", () => {
    // Owner allowlist configured → requireOwner → core neutralizes the stamp for
    // a non-owner (branch 3, isOwnerForCommands=false).
    const cfg: CommandGateConfig = { commands: { ownerAllowFrom: ["alice"] } };
    const gate = resolveCommandGate(cfg, ACCOUNT);
    expect(gate.delegated).toBe(true);
    expect(gate.isListed("bob")).toBe(false);
  });

  it("isListed:true for a bare owner entry matching the peer", () => {
    const cfg: CommandGateConfig = { commands: { ownerAllowFrom: ["alice"] } };
    const gate = resolveCommandGate(cfg, ACCOUNT);
    expect(gate.isListed("alice")).toBe(true);
  });

  it("strips a matching 'webchannel:' channel prefix on an owner entry", () => {
    const cfg: CommandGateConfig = { commands: { ownerAllowFrom: ["webchannel:alice"] } };
    const gate = resolveCommandGate(cfg, ACCOUNT);
    expect(gate.isListed("alice")).toBe(true);
  });

  it("drops an owner entry prefixed with a DIFFERENT channel", () => {
    const cfg: CommandGateConfig = { commands: { ownerAllowFrom: ["telegram:alice"] } };
    const gate = resolveCommandGate(cfg, ACCOUNT);
    // Still delegated (owner allowlist is configured), but alice is not an
    // owner for THIS channel, so her /stop would be neutralized → notice shown.
    expect(gate.delegated).toBe(true);
    expect(gate.isListed("alice")).toBe(false);
  });

  it("honors a wildcard owner allowlist (everyone is an owner)", () => {
    const cfg: CommandGateConfig = { commands: { ownerAllowFrom: ["*"] } };
    const gate = resolveCommandGate(cfg, ACCOUNT);
    expect(gate.delegated).toBe(true);
    expect(gate.isListed("anyone")).toBe(true);
  });

  it("commands.allowFrom governs membership even when ownerAllowFrom is also set", () => {
    // Core branch (A) short-circuits before the owner path: with a commands list
    // present, the owner allowlist does not add authorization.
    const cfg: CommandGateConfig = {
      commands: { allowFrom: { webchannel: ["alice"] }, ownerAllowFrom: ["bob"] },
    };
    const gate = resolveCommandGate(cfg, ACCOUNT);
    expect(gate.isListed("alice")).toBe(true);
    expect(gate.isListed("bob")).toBe(false);
  });
});
