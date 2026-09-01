/**
 * v6 #239 half 2 — the EGRESS persist-before-publish seam.
 *
 * `NatsChannel.sendToPeer` is the single outbound choke point, and this slice
 * gives the delivery journal its first call site there: every durable frame is
 * committed to the plugin-owned store BEFORE it is published (NOT-list N6, doc
 * §16.2-2, which deliberately reverses v5 §15.8's commit-after).
 *
 * What these pin, and why each one is here rather than "obvious":
 *
 *  - ORDER, on ONE interleaved log. The fake journal and the fake transport
 *    record into the SAME array, so "the append happened first" is a fact about
 *    a single sequence rather than an inference from two spies' call counts —
 *    which is exactly the inference that would keep passing if the hook were
 *    moved below the publish.
 *  - The journal CANNOT change a send result — and cannot THROW, which is worse
 *    still. §15.8 names the forbidden `false` (it rolls back the caller's
 *    reservation and retries the content under a DIFFERENT id); a throw is worse
 *    because `message-adapter.ts`'s delivery path moves a thrown send to `failed`
 *    and never re-sends it. Both the mapper and `append` are covered.
 *  - REFUSAL vs FAILED WRITE, which is the distinction the hook's position
 *    encodes. A send we DECLINE to attempt (transport down, no session key yet)
 *    is journaled NOT AT ALL, because all three refusal checks sit ABOVE
 *    `journalOutbound`. A wire write that THROWS after the commit IS journaled,
 *    and that is the window §16.2-2 is actually about.
 *    ⚠️ WHY the refusal side is not simply fixed — and why #304's residual is
 *    deferred rather than patched — is the GENERAL rule, and it is stated ONCE,
 *    at `message-adapter.ts`'s `lastDeliveredText` declaration. This docblock
 *    used to restate it and no longer does: the version it carried was an
 *    id-re-minting argument that reads as general but describes only
 *    `reserveProvisional`'s PLACEMENT path, and this file now also owns the #242
 *    reasoning characterization tests, where it is false.
 *    ⚠️ TWO PLACEMENT-SCOPED STATEMENTS DO REMAIN IN THIS FILE, and they are
 *    TRUE where they sit — the `placement{X₁},{X₂},{X₃}` argument on the
 *    disconnected-refusal test, and "the client never saw this text either" on
 *    the fail-closed one. Both are about a refused `sendText`, where the peer
 *    genuinely received nothing. DO NOT GENERALISE EITHER to the reasoning close
 *    frame, which carries `lastDeliveredText` — text the peer IS rendering. Four
 *    wrong generalisations of this rule have shipped; that is the failure mode.
 *  - One test against a REAL journal, because the two halves of #239 shipped
 *    separately and nothing else proves they compose.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { generateKeyPair } from "./e2e-crypto.js";
import {
  openDeliveryJournal,
  type DeliveryJournal,
  type DeliveryJournalRow,
} from "./delivery-journal.js";
import type { JournalEvent } from "./delivery-journal-event.js";
import { createReasoningDraftController } from "./message-adapter.js";
import { NatsChannel } from "./nats-channel.js";
import type { NatsTransport } from "./nats-transport.js";

// Same reason as `delivery-journal.ts`: a static `import ... from "node:sqlite"`
// makes vite-node fail to collect this file. See that module's comment.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const TENANT = "tenant";
const ACCOUNT = "acct";
const PEER = "peer-0";
const OUT = `webchannel.${TENANT}.${ACCOUNT}.${PEER}.out`;

/**
 * ONE log for both sides of the seam. `append` and `publish` land in the same
 * array in the order they actually happened — the only way to assert
 * persist-BEFORE-publish rather than persist-AND-publish.
 */
type Call =
  | { call: "append"; conversationId: string; event: JournalEvent }
  | { call: "publish"; subject: string; type: string };

/** Recording transport (plaintext mode), writing into the shared call log. */
class RecordingTransport extends EventEmitter {
  connected = true;
  /** Large enough that the ingress-result chunker never splits or refuses. */
  effectiveOutboundLimit = 1_000_000;
  /**
   * Every published frame, PARSED and whole.
   *
   * ⚠️ SEPARATE FROM `calls` ON PURPOSE. `Call`'s publish variant records only
   * `{call, subject, type}`, and ~20 `toEqual` assertions in this file are
   * written against that exact shape — widening it would churn every one of
   * them to restate a key they do not care about. This sink is additive, so a
   * test that needs to look INSIDE a frame can, and every existing assertion is
   * untouched.
   */
  readonly frames: Array<Record<string, unknown>> = [];
  private sid = 0;
  constructor(private readonly calls: Call[]) {
    super();
  }
  subscribe(): number {
    return ++this.sid;
  }
  unsubscribe(): void {
    /* no-op */
  }
  publish(subject: string, payload: string): void {
    const frame = JSON.parse(payload) as Record<string, unknown>;
    this.frames.push(frame);
    const type = (frame as { type?: string }).type ?? "<unknown>";
    this.calls.push({ call: "publish", subject, type });
  }
}

/** Journal stand-in: records appends, and can be told to throw. */
class FakeJournal implements DeliveryJournal {
  throwOnAppend = false;
  /** What `append` throws when `throwOnAppend` is set. */
  throwValue: unknown = new Error("journal unavailable");
  private seq = 0;
  constructor(private readonly calls: Call[]) {}
  append(
    conversationId: string,
    event: JournalEvent,
  ): { seq: number; inserted: boolean } {
    if (this.throwOnAppend) throw this.throwValue;
    this.calls.push({ call: "append", conversationId, event });
    return { seq: ++this.seq, inserted: true };
  }
  // #243 half 2a: this is the EGRESS-seam test, which never accepts inbound user
  // messages, so these two are unreached stubs kept only to satisfy the interface.
  appendInboundUser(): { seq: number; inserted: boolean; messageId: string } {
    throw new Error("appendInboundUser is not exercised by the egress seam");
  }
  lookupUserMessageIdByRandomId(): string | undefined {
    return undefined;
  }
  read(): DeliveryJournalRow[] {
    return [];
  }
  // #244 half A: the high-water is the last seq this fake allocated.
  maxSeq(): number {
    return this.seq;
  }
  close(): void {
    /* no-op */
  }
}

/**
 * `reasoningDurable` mirrors production's default: OMITTED means OFF, exactly as
 * `resolveReasoningDurable` resolves an account that never set the key. A test
 * that wants reasoning rows must say so, which is the point — the opt-in is the
 * shipped behaviour and a test that got them for free would be testing a
 * configuration nobody runs by default.
 */
function makeChannel(options?: { reasoningDurable?: boolean }): {
  calls: Call[];
  transport: RecordingTransport;
  journal: FakeJournal;
  channel: NatsChannel;
} {
  const calls: Call[] = [];
  const transport = new RecordingTransport(calls);
  const journal = new FakeJournal(calls);
  const channel = new NatsChannel(
    transport as unknown as NatsTransport,
    ACCOUNT,
    TENANT,
    undefined,
    undefined,
    {
      deliveryJournal: journal,
      ...(options?.reasoningDurable === undefined
        ? {}
        : { reasoningDurable: options.reasoningDurable }),
    },
  );
  return { calls, transport, journal, channel };
}

function appends(calls: Call[]): Call[] {
  return calls.filter((entry) => entry.call === "append");
}

describe("#239 — egress persist-before-publish", () => {
  it("appends the bubble BEFORE publishing the agent_message", () => {
    const { calls, channel } = makeChannel();

    expect(channel.sendText(PEER, "hello", "a-1", "turn-1")).toBe(true);

    // One interleaved sequence, asserted whole: the append is index 0.
    expect(calls).toEqual([
      {
        call: "append",
        conversationId: PEER,
        event: {
          kind: "bubble",
          answerId: "a-1",
          text: "hello",
          turnId: "turn-1",
        },
      },
      { call: "publish", subject: OUT, type: "agent_message" },
    ]);
  });

  it("maps progress to a placement and turn_snapshot to a seal, each before its publish", () => {
    const { calls, channel } = makeChannel();

    expect(channel.sendProgress(PEER, "a-1", "Working…", "turn-1")).toBe(true);
    expect(
      channel.sendTurnSnapshot(
        PEER,
        "turn-1",
        [{ id: "a-1", text: "final" }],
        ["a-2"],
      ),
    ).toBe(true);

    expect(calls).toEqual([
      {
        call: "append",
        conversationId: PEER,
        // The rolling draft TEXT is deliberately absent — the placement is the
        // lane's slot claim, not its content (doc §15.9).
        event: { kind: "placement", answerId: "a-1", turnId: "turn-1" },
      },
      { call: "publish", subject: OUT, type: "progress" },
      {
        call: "append",
        conversationId: PEER,
        event: {
          kind: "seal",
          turnId: "turn-1",
          answers: [{ id: "a-1", text: "final" }],
          remove: ["a-2"],
        },
      },
      { call: "publish", subject: OUT, type: "turn_snapshot" },
    ]);
  });

  it("journals nothing for control, indicator, and replay frames", () => {
    const { calls, channel } = makeChannel();

    // Ingress control (both ride sendIngressResult → sendToPeer).
    expect(channel.sendAck(PEER, ["u-1"])).toBe(true);
    expect(channel.sendInboundRejected(PEER, ["u-2"])).toBe(true);
    // Indicators.
    expect(channel.sendTyping(PEER)).toBe(true);
    expect(channel.sendReasoning(PEER, "r-1", "turn-1", "thinking")).toBe(true);
    // ⚠️ `sendToolActivity` IS NO LONGER DRIVEN HERE — #242 half 3 made it
    // durable, so it belongs to the case below, not to this one. It was moved
    // rather than deleted: a frame silently dropped from a "journals nothing"
    // list is indistinguishable from one that stopped being sent.
    // Turn control and server→client replay.
    expect(channel.sendTurnSettled(PEER, "turn-1", "ok")).toBe(true);
    expect(
      channel.sendHistory(PEER, [{ id: "h-1", role: "agent", text: "old" }]),
    ).toBe(true);
    expect(channel.sendCommands(PEER, [])).toBe(true);

    // Every frame reached the wire; not one produced a row.
    expect(calls.map((entry) => entry.call === "publish" && entry.type)).toEqual([
      "ack",
      "inbound_rejected",
      "typing",
      "reasoning",
      "turn_settled",
      "history",
      "commands",
    ]);
    expect(appends(calls)).toEqual([]);
  });

  it("#242 half 3 — journals EVERY tool_activity frame, persist-before-publish", () => {
    const { calls, channel } = makeChannel();

    // The measured lifecycle triple for ONE call. The closing frame carries
    // `status` and `summary` but neither `name` nor `argKeys`, which is why all
    // three are stored rather than one "final".
    //
    // ⚠️ `summary` IS HERE BECAUSE THIS IS THE ONLY TEST THAT REACHES ITS
    // FORWARDING SITE. `sendToolActivity` rebuilds the payload field by field,
    // and the shared `TOOL_TURN_FRAMES` fixture cannot pin that spread — nothing
    // drives this method from the fixture — so before this call carried one,
    // deleting `summary` from the payload literal left every plugin suite green
    // while the field silently stopped reaching both the journal and the wire.
    // The value is the producer's count grammar (`readSafePatchSummary`), which
    // is why the call is named `apply_patch`.
    expect(
      channel.sendToolActivity(PEER, {
        id: "call-1",
        turnId: "turn-1",
        name: "apply_patch",
        phase: "start",
        argKeys: ["path", "patch"],
      }),
    ).toBe(true);
    expect(
      channel.sendToolActivity(PEER, { id: "call-1", turnId: "turn-1", phase: "update" }),
    ).toBe(true);
    expect(
      channel.sendToolActivity(PEER, {
        id: "call-1",
        turnId: "turn-1",
        phase: "end",
        status: "completed",
        summary: "2 added, 1 modified",
      }),
    ).toBe(true);

    // ORDER IS THE POINT: each append precedes its own publish (NOT-list N6,
    // doc §16.2-2), and there are three of each rather than one.
    expect(
      calls.map((entry) =>
        entry.call === "append"
          ? `append:${(entry.event as { phase?: string }).phase}`
          : `publish:${entry.type}`,
      ),
    ).toEqual([
      "append:start",
      "publish:tool_activity",
      "append:update",
      "publish:tool_activity",
      "append:end",
      "publish:tool_activity",
    ]);
    expect(
      appends(calls).map((entry) => (entry.call === "append" ? entry.event : undefined)),
    ).toEqual([
      {
        kind: "tool",
        id: "call-1",
        turnId: "turn-1",
        name: "apply_patch",
        phase: "start",
        argKeys: ["path", "patch"],
      },
      { kind: "tool", id: "call-1", turnId: "turn-1", phase: "update" },
      {
        kind: "tool",
        id: "call-1",
        turnId: "turn-1",
        phase: "end",
        status: "completed",
        summary: "2 added, 1 modified",
      },
    ]);
  });

  it("publishes and returns true when append throws, warning once and suppressing the repeat", () => {
    const { calls, channel, journal } = makeChannel();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    journal.throwOnAppend = true;

    // §15.8's forbidden outcome: a `false` here would roll the caller's
    // reservation back and make it retry the same text under a new id.
    expect(channel.sendText(PEER, "hello", "a-1")).toBe(true);
    expect(channel.sendText(PEER, "hello again", "a-2")).toBe(true);

    expect(calls).toEqual([
      { call: "publish", subject: OUT, type: "agent_message" },
      { call: "publish", subject: OUT, type: "agent_message" },
    ]);
    // Rate-limited: the second failure inside the 60 s window is counted, not
    // logged. Category, peer, and the value-free SQLite status only — never the
    // message text, and never `error.message` (free-form; see
    // `journalFailureDiagnostic`'s measurement).
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain("[nats-channel] delivery journal append-failed");
    expect(line).toContain("the send result is unchanged");
    expect(line).toContain("suppressed=0");
    expect(line).not.toContain("hello");
    expect(line).not.toContain("journal unavailable");
    warn.mockRestore();
  });

  it("isolates a throw from the MAPPER, not just from append", () => {
    // The failure-isolation `try` covers the whole journal write path. Driven
    // through the real public API with a malformed `remove`, which reaches
    // `journalEventForOutbound`'s `[...frame.remove]` and throws a TypeError —
    // i.e. no stubbing, a real throw on the real path.
    //
    // Why it matters more than a `false` return: `sendToPeer`'s callers are
    // written for a boolean, and `message-adapter.ts`'s delivery comment spells
    // out that a THROWN send moves the message to `failed` and never re-sends
    // it. A shadow store must not be able to lose a message.
    const { calls, channel } = makeChannel();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() =>
      channel.sendTurnSnapshot(
        PEER,
        "turn-1",
        [{ id: "a-1", text: "final" }],
        undefined as never,
      ),
    ).not.toThrow();

    expect(appends(calls)).toEqual([]);
    expect(calls).toEqual([
      { call: "publish", subject: OUT, type: "turn_snapshot" },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain("[nats-channel] delivery journal append-failed");
    // A plain TypeError carries no SQLite status, and its free-form message
    // stays out of the log either way.
    expect(line).toContain('code="<none>"');
    expect(line).not.toContain("errcode=");
    warn.mockRestore();
  });

  it("isolates a throw from reading the DIAGNOSTIC off a hostile error value", () => {
    // The catch handler must itself be inside the mechanism it enforces:
    // `journalFailureDiagnostic` reads `code`/`errcode`/`errstr` off an
    // arbitrary caught value, so a throwing getter (or a Proxy trap) would
    // escape `journalOutbound`'s catch and then `sendToPeer` — the same
    // "permanently lost message" outcome the wide `try` exists to prevent.
    // "Nothing throws from a getter today" was rejected for the mapper; it is
    // rejected here too.
    const { calls, channel, journal } = makeChannel();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    journal.throwOnAppend = true;
    journal.throwValue = Object.defineProperty(new Error("boom"), "code", {
      get() {
        throw new Error("hostile getter");
      },
    });

    expect(() => channel.sendText(PEER, "hostile", "a-1")).not.toThrow();

    expect(calls).toEqual([
      { call: "publish", subject: OUT, type: "agent_message" },
    ]);
    expect((warn.mock.calls[0][0] as string)).toContain('code="<unreadable>"');
    warn.mockRestore();
  });

  it("reports code AND the SQLite errcode/errstr pair of a real store failure", () => {
    // ⚠️ THE POSITIVE FIXTURE FOR `errcode`/`errstr`. Without it both
    // `parts.push` lines could be deleted and the suite stayed green — every
    // other mention in this file is a `not.toContain`, and the append-after-close
    // case below is the one measured shape that carries no errcode. A Node or
    // node:sqlite change that stopped delivering `errcode` as a number would
    // then ship silently.
    //
    // Recorded, not invented: the schema is dropped from a SECOND connection on
    // the same file, which is measured row 2 of `journalFailureDiagnostic`'s
    // table.
    const calls: Call[] = [];
    const transport = new RecordingTransport(calls);
    const root = mkdtempSync(join(tmpdir(), "webchannel-egress-journal-sql-"));
    const databasePath = join(root, "tuple", "delivery-journal.sqlite");
    const journal = openDeliveryJournal({ databasePath });
    const channel = new NatsChannel(
      transport as unknown as NatsTransport,
      ACCOUNT,
      TENANT,
      undefined,
      undefined,
      { deliveryJournal: journal },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sidecar = new DatabaseSync(databasePath);
    sidecar.exec("DROP TABLE journal_event");

    expect(channel.sendText(PEER, "schema pulled out", "a-1")).toBe(true);

    expect(calls).toEqual([
      { call: "publish", subject: OUT, type: "agent_message" },
    ]);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain('code="ERR_SQLITE_ERROR"');
    expect(line).toContain("errcode=1");
    expect(line).toContain('errstr="SQL logic error"');
    // Free-form `message` and the frame's text both stay out.
    expect(line).not.toContain("no such table");
    expect(line).not.toContain("schema pulled out");
    warn.mockRestore();
    sidecar.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reports code alone when the failure carries no SQLite status", () => {
    // The complementary shape: node:sqlite's own state errors have no
    // errcode/errstr, so the diagnostic must degrade to `code` rather than print
    // `errcode=undefined`.
    const calls: Call[] = [];
    const transport = new RecordingTransport(calls);
    const root = mkdtempSync(join(tmpdir(), "webchannel-egress-journal-err-"));
    const journal = openDeliveryJournal({
      databasePath: join(root, "tuple", "delivery-journal.sqlite"),
    });
    const channel = new NatsChannel(
      transport as unknown as NatsTransport,
      ACCOUNT,
      TENANT,
      undefined,
      undefined,
      { deliveryJournal: journal },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A real, non-synthetic failure: the handle is closed under the channel.
    journal.close();

    expect(channel.sendText(PEER, "after close", "a-1")).toBe(true);

    expect(calls).toEqual([
      { call: "publish", subject: OUT, type: "agent_message" },
    ]);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain('code="ERR_INVALID_STATE"');
    // node:sqlite's own state errors carry no SQLite status pair.
    expect(line).not.toContain("errcode=");
    // Measured: the marker never reaches `message`, but `message` is excluded on
    // principle and this pins that it is not being interpolated.
    expect(line).not.toContain("database is not open");
    expect(line).not.toContain("after close");
    warn.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses to journal an id-less durable frame, logs it at ERROR, but still delivers it", () => {
    const { calls, channel } = makeChannel();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // Post-#238 every durable frame carries a plugin-minted id, so this is a
    // REGRESSION INDICATOR. Minting one here would file the row under an id the
    // client (which mints its own local one) never sees — N8.
    expect(channel.sendText(PEER, "unattributed")).toBe(true);
    expect(channel.sendText(PEER, "also unattributed")).toBe(true);

    expect(appends(calls)).toEqual([]);
    expect(calls).toEqual([
      { call: "publish", subject: OUT, type: "agent_message" },
      { call: "publish", subject: OUT, type: "agent_message" },
    ]);
    // ERROR, not warn: delivered text is missing from the store, which is a
    // defect. `delivery-journal-event.ts`'s `isIdlessDurableFrame` docblock says
    // half 2 logs it at `error`, and the two files must not disagree.
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const line = error.mock.calls[0][0] as string;
    expect(line).toContain("[nats-channel] delivery journal idless-durable-frame");
    expect(line).toContain("suppressed=0");
    // No message text, and no SQLite status (nothing failed — the frame was
    // refused before the store was touched).
    expect(line).not.toContain("unattributed");
    expect(line).not.toContain("code=");
    error.mockRestore();
    warn.mockRestore();
  });

  it("journals NOTHING when the disconnected transport refuses the send", () => {
    // ⚠️ A REFUSAL IS NOT A FAILED PUBLISH, and journaling one is actively
    // harmful — this pins the direction, which an earlier revision had backwards.
    // The caller re-mints on failure (`message-adapter.ts`'s `reserveProvisional`
    // returns a fresh `nextMessageId()` whenever the provisional preview is
    // unavailable, and `lane.id ??= reservation.id` only runs on success), so
    // journaling refusals during a blip writes `placement{X₁}`, `X₂`, `X₃`… one
    // per revision, under ids that never existed live. `journal_placement_once`
    // cannot collapse them, and at #240 replay each becomes a phantom empty
    // bubble — N8 in the GAINING direction.
    const { calls, channel, transport } = makeChannel();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    transport.connected = false;

    expect(channel.sendText(PEER, "sent into a blip", "a-1")).toBe(false);

    expect(calls).toEqual([]);
    // Assert WHICH refusal was reached, rather than inferring it from
    // "false + nothing journaled" — that pair would also be satisfied by some
    // future guard added ABOVE this one, which would make the test pass while
    // testing something else entirely.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Transport not connected"),
    );
    warn.mockRestore();
  });

  it("journals NOTHING when the fail-closed encryption guard refuses the send", () => {
    // Same direction as the disconnected refusal: the peer has no session key
    // yet (never registered), so we decline to write to the wire at all. Nothing
    // is lost by not recording it — the client never saw this text either, and a
    // row would make history show what live never showed.
    const calls: Call[] = [];
    const transport = new RecordingTransport(calls);
    const journal = new FakeJournal(calls);
    const channel = new NatsChannel(
      transport as unknown as NatsTransport,
      ACCOUNT,
      TENANT,
      {
        keyStore: { getOrCreate: () => new Uint8Array(32).fill(7) } as never,
        identityKeyPair: generateKeyPair(),
      },
      undefined,
      { deliveryJournal: journal },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(channel.sendText(PEER, "pre-registration", "a-1")).toBe(false);

    expect(calls).toEqual([]);
    // Same reason as the disconnected case: pin the specific guard, so this
    // cannot silently become a test of the transport-connected refusal above it.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no session key yet"),
    );
    warn.mockRestore();
  });

  it("DOES journal when the wire write itself throws — the window §16.2-2 describes", () => {
    // The one surviving write-then-not-delivered case, and the one that is
    // genuinely safe: the record is committed and `publish` blows up after it.
    // History has the message and the reconnect catches up, rather than the
    // client holding a message the store lacks. Distinguishing this from the two
    // refusals above is the entire point of where the hook sits.
    const { calls, channel, transport } = makeChannel();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    transport.publish = () => {
      throw new Error("relay rejected the publish");
    };

    expect(channel.sendText(PEER, "committed then lost", "a-1")).toBe(false);

    expect(calls).toEqual([
      {
        call: "append",
        conversationId: PEER,
        event: { kind: "bubble", answerId: "a-1", text: "committed then lost" },
      },
    ]);
    // The pre-existing publish-failure diagnostic, untouched by this slice.
    expect(error.mock.calls[0][0]).toContain(
      "[nats-channel] Failed to send to peer",
    );
    error.mockRestore();
  });

  it("journals nothing after dispose", () => {
    // The journal handle is closed with the account (nats-account-runtime's
    // dispose chain, AFTER channel.dispose()), and a disposed channel is not a
    // delivery act — so this is the one guard that stays ABOVE the hook.
    const { calls, channel } = makeChannel();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    channel.dispose();
    expect(channel.sendText(PEER, "too late", "a-1")).toBe(false);

    expect(calls).toEqual([]);
    warn.mockRestore();
  });

  it("scopes each peer's events under its own conversationId", () => {
    // D1 — the conversationId IS the peerId (the authenticated JWT `sub`). The
    // file is already scoped to (tenant, accountId), so the peer completes the
    // triple; no core route or agentId is consulted (doc §16.2-7).
    const { calls, channel } = makeChannel();

    channel.sendText("peer-a", "for a", "a-1");
    channel.sendText("peer-b", "for b", "b-1");

    expect(
      appends(calls).map((entry) =>
        entry.call === "append" ? entry.conversationId : undefined,
      ),
    ).toEqual(["peer-a", "peer-b"]);
  });
});

describe("#239 — egress seam against a real journal", () => {
  const tempRoots: string[] = [];
  const openJournals: DeliveryJournal[] = [];

  afterEach(() => {
    while (openJournals.length > 0) openJournals.pop()?.close();
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop() as string, { recursive: true, force: true });
    }
  });

  it("writes a realistic turn through sendToPeer and reads it back in egress order", () => {
    // The proof that half 1 and half 2 compose: nothing else in the tree drives
    // the real SQLite store from the real channel.
    const root = mkdtempSync(join(tmpdir(), "webchannel-egress-journal-"));
    tempRoots.push(root);
    const journal = openDeliveryJournal({
      databasePath: join(root, "tuple", "delivery-journal.sqlite"),
    });
    openJournals.push(journal);
    const transport = new RecordingTransport([]);
    const channel = new NatsChannel(
      transport as unknown as NatsTransport,
      ACCOUNT,
      TENANT,
      undefined,
      undefined,
      { deliveryJournal: journal },
    );

    channel.sendProgress(PEER, "a-1", "Working…", "turn-1");
    channel.sendText(PEER, "first answer", "a-1", "turn-1");
    channel.sendText(PEER, "second answer", "a-2", "turn-1");
    channel.sendTurnSnapshot(
      PEER,
      "turn-1",
      [
        { id: "a-1", text: "first answer" },
        { id: "a-2", text: "second answer" },
      ],
      [],
    );

    const rows = journal.read(PEER);
    expect(rows.map((row) => row.event)).toEqual([
      { kind: "placement", answerId: "a-1", turnId: "turn-1" },
      { kind: "bubble", answerId: "a-1", text: "first answer", turnId: "turn-1" },
      { kind: "bubble", answerId: "a-2", text: "second answer", turnId: "turn-1" },
      {
        kind: "seal",
        turnId: "turn-1",
        answers: [
          { id: "a-1", text: "first answer" },
          { id: "a-2", text: "second answer" },
        ],
        remove: [],
      },
    ]);
    // Contiguous, ascending: the stream's ORDER is the identity model, so a gap
    // or a reorder here is a correctness failure, not cosmetics.
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    // A different peer is a different conversation in the same file.
    expect(journal.read("peer-other")).toEqual([]);
  });
});

/**
 * #244 half A — the per-conversation `seq` on the DURABLE outbound wire frames.
 *
 * The journal already allocated a contiguous per-conversation `seq` at egress
 * (#239); half A stops discarding it. `sendToPeer` stamps the `seq` `append`
 * returned onto the three durable frames the reducer folds — `agent_message`,
 * `progress`, `turn_snapshot` — so a future client (half B) can track a
 * last-applied seq and detect gaps (doc §16.2-6, Telegram pts/qts).
 *
 * ⚠️ THE ASSERTIONS READ `transport.frames`, the whole parsed frame — the `seq`
 * lives INSIDE the payload, which `Call`'s publish variant deliberately does not
 * carry (see `RecordingTransport`).
 */
describe("#244 half A — seq on the durable wire frames", () => {
  const tempRoots: string[] = [];
  const openJournals: DeliveryJournal[] = [];

  afterEach(() => {
    while (openJournals.length > 0) openJournals.pop()?.close();
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop() as string, { recursive: true, force: true });
    }
  });

  it("stamps the append-allocated seq on agent_message/progress/turn_snapshot, monotone within the conversation", () => {
    const { channel, transport } = makeChannel();

    expect(channel.sendProgress(PEER, "a-1", "Working…", "turn-1")).toBe(true);
    expect(channel.sendText(PEER, "first", "a-1", "turn-1")).toBe(true);
    expect(channel.sendText(PEER, "second", "a-2", "turn-1")).toBe(true);
    expect(
      channel.sendTurnSnapshot(PEER, "turn-1", [{ id: "a-1", text: "first" }], []),
    ).toBe(true);

    // The FakeJournal allocates 1,2,3,4 in append order; each durable frame
    // carries its own row's seq, contiguous and ascending.
    expect(transport.frames.map((f) => [f.type, f.seq])).toEqual([
      ["progress", 1],
      ["agent_message", 2],
      ["agent_message", 3],
      ["turn_snapshot", 4],
    ]);
  });

  it("stamps NO seq on ephemeral frames — typing, reasoning, tool_activity, ack, turn_settled, history, commands", () => {
    const { channel, transport } = makeChannel();

    expect(channel.sendTyping(PEER)).toBe(true);
    expect(channel.sendReasoning(PEER, "r-1", "turn-1", "thinking")).toBe(true);
    expect(
      channel.sendToolActivity(PEER, { id: "t-1", turnId: "turn-1", name: "grep" }),
    ).toBe(true);
    expect(channel.sendAck(PEER, ["u-1"])).toBe(true);
    expect(channel.sendTurnSettled(PEER, "turn-1", "ok")).toBe(true);
    expect(
      channel.sendHistory(PEER, [{ id: "h-1", role: "agent", text: "old" }]),
    ).toBe(true);
    expect(channel.sendCommands(PEER, [])).toBe(true);

    // `reasoning` and `tool_activity` ARE journaled (they get a seq internally),
    // but the contract does not expose `seq` on them — the seq cursor is for the
    // three folded frames only. Not one published frame carries a `seq`.
    for (const frame of transport.frames) {
      expect(frame.seq).toBeUndefined();
    }
  });

  it("ships a durable frame WITHOUT a seq when the journal append fails — §15.8 send result unchanged", () => {
    const { channel, transport, journal } = makeChannel();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    journal.throwOnAppend = true;

    // A caught journal failure must not change the send result, and it leaves the
    // frame with no seq to stamp — the client tolerates the absence.
    expect(channel.sendText(PEER, "hello", "a-1", "turn-1")).toBe(true);

    expect(transport.frames).toHaveLength(1);
    expect(transport.frames[0].type).toBe("agent_message");
    expect(transport.frames[0].seq).toBeUndefined();
    warn.mockRestore();
  });

  it("an id-less durable frame ships without a seq (never journaled)", () => {
    const { channel, transport } = makeChannel();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // No usable id ⇒ `isIdlessDurableFrame` short-circuits before `append`, so
    // there is no seq — the frame still reaches the wire.
    expect(channel.sendText(PEER, "unattributed")).toBe(true);

    expect(transport.frames).toHaveLength(1);
    expect(transport.frames[0].seq).toBeUndefined();
    error.mockRestore();
  });

  it("through the REAL store, each durable frame's wire seq equals its journal row's seq", () => {
    const root = mkdtempSync(join(tmpdir(), "webchannel-egress-seq-"));
    tempRoots.push(root);
    const journal = openDeliveryJournal({
      databasePath: join(root, "tuple", "delivery-journal.sqlite"),
    });
    openJournals.push(journal);
    const transport = new RecordingTransport([]);
    const channel = new NatsChannel(
      transport as unknown as NatsTransport,
      ACCOUNT,
      TENANT,
      undefined,
      undefined,
      { deliveryJournal: journal },
    );

    channel.sendProgress(PEER, "a-1", "Working…", "turn-1");
    channel.sendText(PEER, "first answer", "a-1", "turn-1");
    channel.sendText(PEER, "second answer", "a-2", "turn-1");
    channel.sendTurnSnapshot(
      PEER,
      "turn-1",
      [{ id: "a-1", text: "first answer" }, { id: "a-2", text: "second answer" }],
      [],
    );

    const rowSeqs = journal.read(PEER).map((row) => row.seq);
    const wireSeqs = transport.frames.map((f) => f.seq);
    // The wire seq the client sees IS the durable row's seq — same value, same
    // order — so the client's cursor and the store agree by construction.
    expect(wireSeqs).toEqual(rowSeqs);
    expect(wireSeqs).toEqual([1, 2, 3, 4]);
  });
});

/**
 * #242 half 1 — ONE ROW PER REASONING BURST, THROUGH THE REAL CHANNEL.
 *
 * ⚠️ THIS IS THE TEST THAT WOULD HAVE CAUGHT THE O(n²) DESIGN. The unit tests on
 * either side of this seam can both pass while the composition is quadratic: the
 * controller's suite counts frames, the mapper's suite maps ONE frame at a time,
 * and neither can see that `createReasoningDraftController` calls
 * `sendReasoning` on EVERY cumulative token update — unthrottled, each frame
 * carrying the whole text so far. Driving the REAL controller into the REAL
 * channel is what turns "how many rows does a burst cost" into an observable.
 */
/**
 * #242 half 1 — THE DEFAULT: the live lane runs, the journal stays empty.
 *
 * ⚠️ THIS IS THE TEST THAT PROVES THE GATE IS AT THE JOURNAL AND NOT ON THE
 * LANE. Two switches, two decisions: `capabilities.reasoning` keeps its #113
 * default-ON because it is about rendering a volatile live stream, and
 * `capabilities.reasoningDurable` defaults OFF because it is about permanently
 * recording plaintext to disk. Gating by closing the lane would have satisfied
 * "no rows" while silently regressing #113, and nothing else in the suite would
 * have noticed — so the assertion is deliberately BOTH halves: every live frame
 * still on the wire, INCLUDING the `final: true` close frame, and zero rows.
 */
describe("#242 — reasoningDurable OFF (default): lane intact, journal empty", () => {
  it("publishes the whole burst, close frame included, and journals nothing", () => {
    const { calls, transport, channel } = makeChannel();
    const controller = createReasoningDraftController({
      transport: channel,
      sessionKey: PEER,
      turnId: "turn-1",
    });

    controller.push({ text: "Let" });
    controller.push({ text: "Let me" });
    controller.push({ text: "Let me think" });
    controller.endBurst();

    // The LANE is untouched: three live drafts plus the burst close.
    expect(calls.filter((entry) => entry.call === "publish")).toEqual([
      { call: "publish", subject: OUT, type: "reasoning" },
      { call: "publish", subject: OUT, type: "reasoning" },
      { call: "publish", subject: OUT, type: "reasoning" },
      { call: "publish", subject: OUT, type: "reasoning" },
    ]);
    // ⚠️ AND THE FOURTH ONE REALLY IS THE `final` FRAME — read off the PUBLISHED
    // PAYLOAD, not inferred from the count. Without this the docblock above
    // claims a `final: true` the assertion cannot see: `Call`'s publish variant
    // carries only `type`, so gating the LANE down to three frames and gating
    // the FLAG off both stay green on the count alone.
    //
    // The three drafts assert `undefined`, not `false`, which pins the other
    // half of `nats-channel.ts`'s `sendReasoning` contract: the key is OMITTED
    // rather than emitted false, so a live draft frame is byte-identical to what
    // it was before this slice existed.
    expect(transport.frames.map((frame) => frame.final)).toEqual([
      undefined,
      undefined,
      undefined,
      true,
    ]);
    // And the JOURNAL is empty.
    expect(appends(calls)).toEqual([]);
  });

  it("still journals every OTHER durable frame of the same turn", () => {
    // Non-vacuity, and the exact failure a lane-side gate would NOT produce:
    // the flag must silence reasoning ONLY. A turn whose answers stopped being
    // journaled would be catastrophic and must not hide behind "no rows".
    const { calls, channel } = makeChannel();
    const controller = createReasoningDraftController({
      transport: channel,
      sessionKey: PEER,
      turnId: "turn-1",
    });

    controller.push({ text: "thinking" });
    controller.endBurst();
    channel.sendProgress(PEER, "a-1", "Working…", "turn-1");
    channel.sendText(PEER, "the answer", "a-1", "turn-1");

    expect(
      appends(calls).map((entry) => (entry.call === "append" ? entry.event : undefined)),
    ).toEqual([
      { kind: "placement", answerId: "a-1", turnId: "turn-1" },
      { kind: "bubble", answerId: "a-1", text: "the answer", turnId: "turn-1" },
    ]);
  });

  it("a non-boolean reasoningDurable fails CLOSED at the channel boundary", () => {
    // `resolveReasoningDurable` already refuses a present malformed value, but
    // the channel takes a plain object and a future caller could hand it one
    // that never went through the resolver. `=== true` is what makes that safe.
    const { calls, channel } = makeChannel({
      reasoningDurable: "true" as unknown as boolean,
    });
    const controller = createReasoningDraftController({
      transport: channel,
      sessionKey: PEER,
      turnId: "turn-1",
    });
    controller.push({ text: "thinking" });
    controller.endBurst();
    expect(appends(calls)).toEqual([]);
  });
});

describe("#242 — with reasoningDurable ON, a live stream costs ONE row per burst", () => {
  it("writes one row per burst, not one per cumulative update", () => {
    const { calls, channel } = makeChannel({ reasoningDurable: true });
    const controller = createReasoningDraftController({
      transport: channel,
      sessionKey: PEER,
      turnId: "turn-1",
    });

    // A realistic burst: ten cumulative updates, each the full text so far.
    let text = "";
    for (const token of ["Le", "t m", "e t", "hi", "nk ", "abo", "ut ", "th", "is", "."]) {
      text += token;
      controller.push({ text });
    }
    controller.endBurst();

    // ELEVEN wire frames — ten live drafts plus the close — and exactly ONE row.
    expect(calls.filter((entry) => entry.call === "publish")).toHaveLength(11);
    expect(appends(calls)).toHaveLength(1);
    const [row] = appends(calls);
    expect(row).toEqual({
      call: "append",
      conversationId: PEER,
      event: {
        kind: "reasoning",
        id: expect.any(String),
        turnId: "turn-1",
        text: "Let me think about this.",
      },
    });
  });

  it("gives each burst of a turn its own row, and an aborted turn still gets one", () => {
    const { calls, channel } = makeChannel({ reasoningDurable: true });
    const controller = createReasoningDraftController({
      transport: channel,
      sessionKey: PEER,
      turnId: "turn-1",
    });

    controller.push({ text: "first thought" });
    controller.endBurst();
    controller.push({ text: "second thought" });
    // The turn is aborted here — `inbound.ts` calls `stop()` on the way out.
    controller.stop();

    expect(
      appends(calls).map((entry) => (entry.call === "append" ? entry.event : undefined)),
    ).toEqual([
      { kind: "reasoning", id: expect.any(String), turnId: "turn-1", text: "first thought" },
      { kind: "reasoning", id: expect.any(String), turnId: "turn-1", text: "second thought" },
    ]);
    // Distinct ids: two bursts must replay as two blocks, not one overwriting
    // the other through the reducer's upsert.
    const ids = appends(calls).map((entry) =>
      entry.call === "append" ? (entry.event as { id: string }).id : "",
    );
    expect(new Set(ids).size).toBe(2);
  });

  it("a blip the transport RECOVERED from still gets its row, carrying the delivered text", () => {
    // ⚠️ #304 END TO END, THROUGH THE REAL CHANNEL — and note WHICH half of it.
    // The transport comes back UP before `endBurst()`, so the close frame is
    // published and journaled. This is precisely the case `lastDeliveredText`
    // fixed; a "did the LAST send land" gate wrote no row here.
    //
    // ⚠️ THE `connected = true` LINE IS LOAD-BEARING, NOT SETUP TIDINESS. It is
    // the ONLY arrangement in which a row appears at all, and an earlier
    // revision of this test carried it while claiming the general "a burst
    // interrupted by a blip still gets its row" — which is false. The sibling
    // below is that general case, and it records the opposite outcome.
    const { calls, transport, channel } = makeChannel({ reasoningDurable: true });
    const controller = createReasoningDraftController({
      transport: channel,
      sessionKey: PEER,
      turnId: "turn-1",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    controller.push({ text: "Let me" });
    transport.connected = false;
    controller.push({ text: "Let me think" });
    transport.connected = true; // ⭐ recovered BEFORE the close
    controller.endBurst();
    warn.mockRestore();

    expect(
      appends(calls).map((entry) => (entry.call === "append" ? entry.event : undefined)),
    ).toEqual([
      { kind: "reasoning", id: expect.any(String), turnId: "turn-1", text: "Let me" },
    ]);
  });

  it("CHARACTERIZATION — a transport STILL down at close loses the burst entirely (#304)", () => {
    // ⚠️ RECORDS THE RESIDUAL, DOES NOT ENDORSE IT. Identical to the test above
    // except the transport never recovers, which is the ORDINARY shape of a
    // reconnect or a fail-closed no-session-key window: the condition that
    // refused the last `push` is still in effect when the burst closes, so
    // `sendToPeer` refuses the close frame too — above `journalOutbound`, by
    // design — and the peer keeps rendering text that has no durable record.
    //
    // Two publishes reached the wire and ZERO rows were written. Not fixable at
    // this seam; WHY is stated ONCE, at `message-adapter.ts`'s
    // `lastDeliveredText` declaration, and deliberately not restated here — two
    // earlier restatements of it shipped false. #304 owns the residual.
    const { calls, transport, channel } = makeChannel({ reasoningDurable: true });
    const controller = createReasoningDraftController({
      transport: channel,
      sessionKey: PEER,
      turnId: "turn-1",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    controller.push({ text: "Let me" });
    controller.push({ text: "Let me think" });
    transport.connected = false; // and it stays down
    controller.push({ text: "Let me think about this" });
    controller.endBurst();
    warn.mockRestore();

    // The peer received two frames and is still rendering "Let me think"…
    expect(calls.filter((entry) => entry.call === "publish")).toHaveLength(2);
    // …and the journal holds nothing for the burst.
    expect(appends(calls)).toEqual([]);
  });

  it("CHARACTERIZATION — the same residual on the stop() teardown path (#304)", () => {
    // The likelier trigger in production: the dropped connection is what ends
    // the turn, so `inbound.ts`'s `reasoning?.stop()` runs while the transport
    // is still refusing.
    const { calls, transport, channel } = makeChannel({ reasoningDurable: true });
    const controller = createReasoningDraftController({
      transport: channel,
      sessionKey: PEER,
      turnId: "turn-1",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    controller.push({ text: "Let me" });
    transport.connected = false;
    controller.push({ text: "Let me think" });
    controller.stop();
    warn.mockRestore();

    expect(calls.filter((entry) => entry.call === "publish")).toHaveLength(1);
    expect(appends(calls)).toEqual([]);
  });

  it("an open burst with no delivered snapshot writes nothing", () => {
    // The transport refuses every send (no session key on an encrypted channel
    // is the real shape; here the transport is simply disconnected), so the
    // journal — which sits BELOW `sendToPeer`'s refusals — sees nothing at all.
    const { calls, transport, channel } = makeChannel({ reasoningDurable: true });
    transport.connected = false;
    const controller = createReasoningDraftController({
      transport: channel,
      sessionKey: PEER,
      turnId: "turn-1",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    controller.push({ text: "never delivered" });
    controller.endBurst();
    warn.mockRestore();
    expect(appends(calls)).toEqual([]);
  });
});
