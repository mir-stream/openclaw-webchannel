// Driver for the #94 multi-assistant-message E2E — does a turn that produced TWO
// assistant messages settle as TWO DISTINCT bubbles on the wire?
//
// WHAT THIS GUARDS: in `streaming.mode:"partial"` the channel used to mint ONE
// draft id per TURN and accumulate every assistant message into it. The turn's
// `final` then replaced that merged bubble with the LAST message's text, so
// earlier assistant text the user had already watched stream was erased from the
// live view (the transcript kept it; the live path lost it). The fix gives each
// assistant message its own lane, its own wire id and its own terminal frame.
//
// WHY A LIVE HARNESS: both review rounds on the fix caught defects that were unit
// fixtures encoding an ordering core does not actually produce, and the fix's
// documented residual (plan §12.2(5) — a text-bearing message that streams no
// partials whose block drains after the NEXT message's partials) fires exactly as
// often as core skews a block drain relative to the delta stream. That is not a
// question a unit test can answer. Only a real gateway running a real agent loop
// over a real tool call can.
//
// HOW THE SECOND MESSAGE IS REAL: the echo provider answers phase 1 with
// assistant text A plus a `tool_calls` entry and `finish_reason:"tool_calls"`;
// core executes the tool and comes back for phase 2, which returns assistant text
// B. Both messages come out of core's own agent loop — nothing here synthesises a
// message boundary.
//
// Every inbound frame is logged with its type, id and text BEFORE any assertion
// runs. That log is a deliverable in itself: it is the first direct record of how
// core interleaves `progress`, `agent_message` and block drains for a real
// multi-message turn.
//
// Exit codes: 0 ok · 2 setup/HTTP failure · 3 timeout · 5 decrypt/mismatch ·
// 6 multi-message assertion failed. The runner adds 7 — a fixture that never
// actually ran (see the provider-log assertion in run-multi-message.sh).

import { randomBytes, webcrypto } from "node:crypto";

import { fromSeed } from "@nats-io/nkeys";

import { NatsTransport } from "../../packages/plugin/src/nats-transport.js";
import type { NatsMessage } from "../../packages/plugin/src/nats-transport.js";
import {
  unwrapConversationKey,
  sealMessage,
  openMessage,
} from "../../packages/client/src/e2e-crypto-browser.js";
import { generateDevicePopKeyPair, registerWithPop } from "../../packages/client/src/pop-register.js";

const NATS_WS = process.env.WEBCHANNEL_NATS_URL ?? "ws://127.0.0.1:18491";
const ISSUER = process.env.WEBCHANNEL_ISSUER_URL ?? "http://127.0.0.1:3991";
const TENANT = process.env.WEBCHANNEL_TENANT ?? "default-tenant";
const ACCOUNT_ID = process.env.WEBCHANNEL_ACCOUNT_ID ?? "default-agent";
const PEER_ID = process.env.WEBCHANNEL_PEER_ID ?? "multi-message-peer";

// Must match what the runner exports to echo-openai-server.mjs.
const MULTI_MARKER = process.env.ECHO_MULTI_MSG_MARKER ?? "ISSUE94_TWO_MESSAGES";
const TEXT_A = process.env.ECHO_MULTI_MSG_TEXT_A ?? "ISSUE94_MESSAGE_A checking the roster now.";
const TEXT_B = process.env.ECHO_MULTI_MSG_TEXT_B ?? "ZZZ94_SECOND_ANSWER here is what came back.";
const MULTI_MESSAGE = `list the agents ${MULTI_MARKER}`;

// Turn 2 — the TOOL-ONLY FIRST assistant message (the ordinary "call a tool,
// then answer" turn). Phase 1 emits the tool call with no assistant text at all,
// so the turn's first assistant message carries nothing and the channel's first
// draft lane can never materialize.
const TOOL_FIRST_MARKER = process.env.ECHO_TOOL_FIRST_MARKER ?? "ISSUE94_TOOL_FIRST";
const TOOL_FIRST_TEXT = process.env.ECHO_TOOL_FIRST_TEXT ?? "TOOLFIRST94_ANSWER after the tool ran.";
const TOOL_FIRST_MESSAGE = `list the agents ${TOOL_FIRST_MARKER}`;

const inboundSubj = `webchannel.${TENANT}.${ACCOUNT_ID}.${PEER_ID}.in`;
const outboundSubj = `webchannel.${TENANT}.${ACCOUNT_ID}.${PEER_ID}.out`;

function fail(code: number, msg: string): never {
  console.error(`[FAIL] ${msg}`);
  process.exit(code);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

// 1. Device X25519 key → cnf.jwk in the bootstrap JWT; the register hop wraps
//    the conversation key K to this key (Phase 6 — no handshake).
const deviceX25519 = (await webcrypto.subtle.generateKey({ name: "X25519" }, true, [
  "deriveBits",
])) as CryptoKeyPair;
const deviceKp = {
  privateKey: deviceX25519.privateKey,
  publicKeyB64url: Buffer.from(
    await webcrypto.subtle.exportKey("raw", deviceX25519.publicKey),
  ).toString("base64url"),
};

// 1b. Device Ed25519 PoP key → pop_jwk. The gateway requires PoP by default
//     (auth.requirePoP defaults true), so the bootstrap JWT MUST carry pop_jwk and
//     the register hop MUST present a signed-nonce proof.
const popKeyPair = await generateDevicePopKeyPair();

// 2. Mint a bootstrap JWT from THIS issuer's trust chain, INCLUDING pop_jwk.
const boot = await postJson(`${ISSUER}/test/bootstrap-jwt`, {
  tenant: TENANT,
  accountId: ACCOUNT_ID,
  peerId: PEER_ID,
  deviceX25519PublicKey: deviceKp.publicKeyB64url,
  devicePopPublicKey: popKeyPair.publicJwk.x,
});
if (boot.status !== 200 || !boot.json?.jwt) {
  fail(2, `bootstrap-jwt mint failed: HTTP ${boot.status} ${boot.text}`);
}
const bootstrapJwt: string = boot.json.jwt;
// F2: the SaaS delivers the enrolled agent's attested identity public key (from
// the durable registry, populated at approval) so we can authenticate the
// register-delivered K against it — never against the wire.
const agentPublicKey: string | undefined = boot.json.agentPublicKey;
if (!agentPublicKey) {
  fail(2, "bootstrap-jwt response carried no agentPublicKey (F2 register-hop pin)");
}
console.log(`[driver] minted bootstrap JWT (kid=${boot.json.kid}, pop_jwk) for peerId=${PEER_ID}`);

// 3. Fetch this driver's NATS user creds (browser role) and connect to the
//    JWT-auth nats-server via NKEY challenge-response FIRST — the register hop
//    rides NATS request/reply, so the transport must be up to drive it.
const cred = await postJson(`${ISSUER}/test/nats-user`, { tenant: TENANT, role: "browser", peerId: PEER_ID });
if (cred.status !== 200 || !cred.json?.userJwt || !cred.json?.userSeed) {
  fail(2, `nats-user mint failed: HTTP ${cred.status} ${cred.text}`);
}
const userJwt: string = cred.json.userJwt;
const userSeed: string = cred.json.userSeed;
console.log("[driver] obtained NATS user creds (browser role)");

const userKp = fromSeed(new TextEncoder().encode(userSeed));
const transport = new NatsTransport({
  url: NATS_WS,
  jwtCredential: userJwt,
  nkeySigningCallback: (nonce: string) =>
    Promise.resolve(Buffer.from(userKp.sign(new TextEncoder().encode(nonce))).toString("base64url")),
  clientName: "multi-message-driver",
});
transport.on("error", (e: Error) => console.error("[driver][nats-error]", e.message));
await transport.connect().catch((e) => fail(2, `NATS connect failed: ${(e as Error).message}`));
console.log("[driver] NKEY-authenticated to JWT-auth nats-server");

// 4. Drive the REAL register hop with PoP over NATS request/reply (challenge →
//    sign nonce → register) so the agent subscribes to this peer.
const registerSubj = `webchannel.${TENANT}.${ACCOUNT_ID}.${PEER_ID}.register`;
const replyPrefix = `webchannel.${TENANT}.${ACCOUNT_ID}.${PEER_ID}.reginbox`;
const natsRegisterRequest = (body: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const replySubject = `${replyPrefix}.${randomBytes(12).toString("hex")}`;
    const sid = transport.subscribe(replySubject);
    const onMsg = (msg: NatsMessage): void => {
      if (msg.subject !== replySubject) return;
      clearTimeout(timer);
      transport.off("message", onMsg);
      transport.unsubscribe(sid);
      resolve(JSON.parse(msg.payload.toString("utf8")));
    };
    const timer = setTimeout(() => {
      transport.off("message", onMsg);
      transport.unsubscribe(sid);
      reject(new Error("[driver] register request timeout"));
    }, 5000);
    transport.on("message", onMsg);
    transport.publishWithReply(registerSubj, replySubject, JSON.stringify(body));
  });

let registerResult: Awaited<ReturnType<typeof registerWithPop>>;
try {
  registerResult = await registerWithPop({
    request: natsRegisterRequest,
    jwt: bootstrapJwt,
    peerId: PEER_ID,
    devicePrivateKey: popKeyPair.privateKey,
  });
} catch (err) {
  fail(2, `register hop (PoP) failed: ${(err as Error).message}`);
}
if (!registerResult.wrappedConversationKey) {
  fail(2, "register response carried no wrappedConversationKey (Phase 6 key delivery)");
}
// v3: the wrap AAD is bound to the freshness anchor THIS driver generated for the
// successful register attempt — never source it from the register reply.
const sessionKey = await unwrapConversationKey(
  registerResult.wrappedConversationKey,
  deviceKp.privateKey,
  agentPublicKey!,
  PEER_ID,
  registerResult.clientNonce,
).catch((e: Error) => fail(5, `conversation-key unwrap failed: ${e.message}`));
console.log(`[driver] PoP register hop (NATS) OK → agent subscribed to ${PEER_ID}, K unwrapped`);

// ---------------------------------------------------------------------------
// 5. #94 — the multi-assistant-message assertions.
// ---------------------------------------------------------------------------
type Frame = {
  type?: string;
  text?: string;
  id?: string;
  turnId?: string;
  outcome?: string;
};

const frames: Frame[] = [];
transport.on("message", (msg: NatsMessage) => {
  if (msg.subject !== outboundSubj) return;
  const decoded = openMessage(msg.payload.toString("utf8"), sessionKey) as Frame | null;
  if (decoded) frames.push(decoded);
});
transport.subscribe(outboundSubj);

// The agent's SUB for .in is sent during the register hop; give it a moment to
// flush server-side before the first publish.
await sleep(300);

// ---------------------------------------------------------------------------
// 5a. THE FRAME LOG. Printed before any assertion so a failing run still yields
//     the full record of what core+plugin actually put on the wire.
//
//     Measured shape on the pinned core (2026.6.10) for turn 1, for the record:
//       typing · progress(A) · agent_message(A) · progress(B) · agent_message(B)
//       · turn_settled(ok)
//     A settles BEFORE B's first partial, so no partial of B is ever applied to
//     A's lane. Note also which trigger rotated: `rotate()` has three call sites
//     and the two on the partial/block paths both log at `info` first, yet a
//     passing run's gateway log carries neither — the rotation came from
//     `onAssistantMessageStart`. On the pinned core that event therefore DOES
//     fire for the second assistant message of a tool-call turn, which plan §5.5
//     ("exactly once per agent run") does not predict. A second message with no
//     boundary event at all is not reachable through this provider and stays
//     covered by the unit fixtures alone.
// ---------------------------------------------------------------------------
/**
 * Bubble order AS THE WIDGET BUILDS IT: the first frame carrying an id fixes
 * that bubble's slot (`upsertMessage` appends on an unknown id), and every later
 * frame for that id edits it in place, so the LAST text wins the content.
 *
 * The gate used to compare positions inside the filtered `agent_message` array,
 * which cannot see ordering at all: `progress(B), progress(A), final(A),
 * final(B)` passed it while rendering B above A permanently. Three of the last
 * five review rounds were ordering defects and this gate was structurally unable
 * to catch any of them. Same shape as the unit fixtures' `bubbleOrder` so the
 * two agree on what "order" means.
 */
function bubbleOrder(all: Frame[]): Array<{ id: string; text: string }> {
  const order: string[] = [];
  const last = new Map<string, string>();
  for (const f of all) {
    const id = f.id;
    if (!id || (f.type !== "progress" && f.type !== "agent_message")) continue;
    if (!last.has(id)) order.push(id);
    last.set(id, f.text ?? "");
  }
  return order.map((id) => ({ id, text: last.get(id)! }));
}

function dumpFrames(from: number, label: string): void {
  const all = frames.slice(from);
  console.log(`[driver] ── ${label}: inbound frame log (${all.length} frames) ─────────────`);
  all.forEach((f, i) => {
    const parts = [
      `#${String(i).padStart(2, "0")}`,
      `type=${f.type ?? "?"}`,
      `id=${f.id ?? "-"}`,
      `turnId=${f.turnId ?? "-"}`,
    ];
    if (f.outcome !== undefined) parts.push(`outcome=${f.outcome}`);
    parts.push(`text=${JSON.stringify(f.text ?? null)}`);
    console.log(`[frame] ${parts.join(" ")}`);
  });
  console.log("[driver] ── end frame log ─────────────────────────────────────────");
}

/** Publish one user message, wait for its `turn_settled`, log and return its frames. */
async function driveTurn(label: string, text: string): Promise<Frame[]> {
  const from = frames.length;
  transport.publish(
    inboundSubj,
    sealMessage({ accountId: ACCOUNT_ID, tenant: TENANT, sub: PEER_ID }, sessionKey, {
      type: "user_message",
      text,
    }),
  );
  console.log(`[driver] ${label}: sent ${JSON.stringify(text)}`);

  // Wait for `turn_settled` — the turn's terminal frame. Then drain briefly so a
  // trailing frame that arrives after settlement is in the record too (if the
  // plugin ever emitted one, the log must show it rather than hide it).
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (frames.slice(from).some((f) => f.type === "turn_settled")) break;
    if (Date.now() > deadline) {
      dumpFrames(from, label);
      fail(3, `TIMEOUT waiting for turn_settled after ${JSON.stringify(text)}`);
    }
    await sleep(100);
  }
  await sleep(1_000);
  dumpFrames(from, label);
  return frames.slice(from);
}

const turnFrames = await driveTurn("turn 1 (text A + tool → text B)", MULTI_MESSAGE);


const agentMessages = turnFrames.filter((f) => f.type === "agent_message");
const settled = turnFrames.find((f) => f.type === "turn_settled");

// (1) THE #94 ASSERTION: at least two agent_message frames with DISTINCT ids.
const ids = agentMessages.map((f) => f.id ?? "");
const distinctIds = new Set(ids.filter((x) => x.length > 0));
if (agentMessages.length < 2) {
  fail(
    6,
    `#94 REGRESSION: the turn produced ${agentMessages.length} agent_message frame(s), expected >= 2. ` +
      `Two assistant messages were flattened into one bubble; the earlier one was erased from the live view.`,
  );
}
if (distinctIds.size < 2) {
  fail(
    6,
    `#94 REGRESSION: ${agentMessages.length} agent_message frames carried ${distinctIds.size} distinct id(s) ` +
      `(${JSON.stringify(ids)}). Each completed assistant message must settle at its OWN wire id.`,
  );
}

// (2) Message A's text must be PRESENT and must not have been erased or replaced
//     by message B's text. "Erased" is the #94 failure: the id that carried A
//     ends up holding B.
// Reduce each id to its FINAL state first: taking the first terminal frame for a
// text would miss a later overwrite of that same id.
const finalStateById = new Map<string, Frame>();
for (const f of turnFrames) {
  if (f.type === "agent_message" && f.id) finalStateById.set(f.id, f);
}
const settledFinalState = [...finalStateById.values()];
const aFrames = settledFinalState.filter((f) => (f.text ?? "").includes(TEXT_A));
if (aFrames.length === 0) {
  fail(
    6,
    `#94 REGRESSION: no settled agent_message carries message A's text ${JSON.stringify(TEXT_A)}. ` +
      `The first assistant message was lost from the live view.`,
  );
}
const aFrame = aFrames[0]!;
if ((aFrame.text ?? "").includes(TEXT_B)) {
  fail(
    6,
    `#94 REGRESSION: one bubble (id=${aFrame.id}) carries BOTH assistant messages ` +
      `(${JSON.stringify(aFrame.text)}). The message boundary was flattened.`,
  );
}
const bFrames = settledFinalState.filter((f) => (f.text ?? "").includes(TEXT_B));
if (bFrames.length === 0) {
  fail(6, `no settled agent_message carries message B's text ${JSON.stringify(TEXT_B)}`);
}
const bFrame = bFrames[0]!;
if (aFrame.id === bFrame.id) {
  fail(
    6,
    `#94 REGRESSION: message A and message B settled at the SAME id (${aFrame.id}) — ` +
      `B replaced A in the one bubble the user was watching.`,
  );
}

// (3) Order AS RENDERED must match the order the MODEL produced them (A, then B).
//     Derived from every frame, not from the filtered terminal ones: the slot is
//     fixed by whichever frame first carried each id, usually a `progress`.
const turn1Bubbles = bubbleOrder(turnFrames);
const aBubble = turn1Bubbles.findIndex((b) => b.text.includes(TEXT_A));
const bBubble = turn1Bubbles.findIndex((b) => b.text.includes(TEXT_B));
if (aBubble === -1 || bBubble === -1 || aBubble > bBubble) {
  fail(
    6,
    `#94: the two assistant messages RENDER out of order. Derived bubble order ` +
      `${JSON.stringify(turn1Bubbles.map((b) => b.text))} — message A is at slot ${aBubble}, ` +
      `message B at slot ${bBubble}. A bubble's slot is fixed by the FIRST frame carrying ` +
      `its id, so a later message that streams first sits above an earlier one permanently.`,
  );
}

// (4) The turn must STILL settle `ok`. An unconditional-rotation fix that broke
//     settlement would otherwise pass (1)-(3).
if (!settled) {
  fail(6, "the multi-message turn produced no turn_settled frame at all");
}
if (settled.outcome !== "ok") {
  fail(
    6,
    `the multi-message turn settled ${JSON.stringify(settled.outcome)}, expected "ok" — ` +
      `giving each assistant message its own lane must not break settlement.`,
  );
}

console.log(
  `[PROOF] #94 derived bubble order: ${JSON.stringify(turn1Bubbles.map((b) => b.text))}`,
);
console.log(
  `[PROOF] #94: one turn produced ${agentMessages.length} settled assistant bubbles at ` +
    `${distinctIds.size} distinct ids (A=${aFrame.id}, B=${bFrame.id}), in model order, ` +
    `with message A intact; turn_settled outcome=ok`,
);

// ---------------------------------------------------------------------------
// 6. TURN 2 — the TOOL-ONLY FIRST assistant message.
//
// This is the ordinary shape of "call a tool, then answer", and it is the most
// common multi-assistant-message turn there is: phase 1 emits ONLY the tool
// call, so the turn's first assistant message carries no text and the channel's
// first draft lane can never materialize.
//
// WHAT IT GUARDS: the lane model resolves a closed, text-less lane only at
// TERMINAL DRAIN. Until then that lane is an unresolved ordering barrier in
// front of every later lane, so the answer that follows the tool call cannot
// emit a single `progress` frame — the whole turn streams NOTHING and the user
// watches a static "Working…" scaffold until the final lands. The turn's end
// state is correct, which is why turn 1 above cannot see this: only the LIVE
// path is broken, and only when the first message is text-less.
//
// The assertion is therefore about streaming, not about the settled text: the
// answer must have appeared in a `progress` frame BEFORE it settled, and it must
// settle exactly once, in the same bubble it streamed in.
// ---------------------------------------------------------------------------
const toolFirstFrames = await driveTurn("turn 2 (tool-only first message)", TOOL_FIRST_MESSAGE);

const toolFirstSettled = toolFirstFrames.filter((f) => f.type === "agent_message");
const toolFirstCarriers = toolFirstSettled.filter((f) => (f.text ?? "").includes(TOOL_FIRST_TEXT));
if (toolFirstCarriers.length !== 1) {
  fail(
    6,
    `#94 tool-only-first: ${toolFirstCarriers.length} settled bubble(s) carry the answer ` +
      `${JSON.stringify(TOOL_FIRST_TEXT)}, expected exactly 1 — ` +
      `${JSON.stringify(toolFirstSettled.map((f) => ({ id: f.id, text: f.text })))}`,
  );
}
const toolFirstAnswer = toolFirstCarriers[0]!;

// The live half. A `progress` frame whose text is a PREFIX of the answer is the
// answer streaming; the tool scaffold ("Working…") is not a prefix of it, so a
// turn that only ever showed the scaffold fails here.
//
// POSITION IS THE ASSERTION, not mere presence. "Streamed" means the user saw
// the text BEFORE the bubble settled, so a qualifying progress frame has to
// appear EARLIER IN THE FRAME SEQUENCE than the terminal frame. Filtering alone
// would also accept a progress frame that arrived after `agent_message`, or even
// after `turn_settled` — which is not streaming, it is a late scaffold write.
const answerPosition = toolFirstFrames.indexOf(toolFirstAnswer);
const toolFirstProgress = toolFirstFrames.filter((f) => f.type === "progress");
const streamedAnswer = toolFirstFrames.filter(
  (f, i) =>
    f.type === "progress" &&
    i < answerPosition &&
    (f.text ?? "").length > 0 &&
    TOOL_FIRST_TEXT.startsWith(f.text!),
);
if (streamedAnswer.length === 0) {
  const late = toolFirstFrames
    .map((f, i) => ({ f, i }))
    .filter(
      ({ f, i }) =>
        f.type === "progress" &&
        i > answerPosition &&
        (f.text ?? "").length > 0 &&
        TOOL_FIRST_TEXT.startsWith(f.text!),
    );
  fail(
    6,
    `#94 REGRESSION (tool-only first message): the answer never streamed BEFORE it settled. ` +
      `The answer settled at frame #${answerPosition}; ${toolFirstProgress.length} progress ` +
      `frame(s) were sent (${JSON.stringify(toolFirstProgress.map((f) => f.text))}) and none ` +
      `before that position carried any prefix of ${JSON.stringify(TOOL_FIRST_TEXT)}` +
      (late.length > 0
        ? ` — though ${late.length} did AFTER it, at frame(s) ${JSON.stringify(
            late.map(({ i }) => i),
          )}, which is a late scaffold write, not streaming.`
        : ` — the text-less first lane held the answer lane behind an ordering barrier until ` +
          `terminal drain, so the user saw a static scaffold for the whole turn and the answer ` +
          `appeared only as a finished bubble.`),
  );
}

// …and it must settle in the SAME bubble it streamed in, not beside it.
if (!streamedAnswer.some((f) => f.id === toolFirstAnswer.id)) {
  fail(
    6,
    `#94 tool-only-first: the answer streamed at ${JSON.stringify(
      streamedAnswer.map((f) => f.id),
    )} but settled at a different id (${toolFirstAnswer.id}) — the streamed bubble was abandoned.`,
  );
}

// …and it must be the ONLY bubble the turn leaves behind. Counting
// answer-carrying terminal frames cannot see a leftover scaffold: the sequence
// `progress("Working…", P) → progress(answer, Q) → agent_message(answer, Q)`
// satisfies every assertion above, while the client finalizes BOTH drafts on
// settlement and the user is left with a dead "Working…" bubble beside the
// answer. The protocol has no bubble deletion (§6.2-3), so a scaffold the answer
// never claimed is permanent.
const toolFirstBubbles = bubbleOrder(toolFirstFrames);
if (toolFirstBubbles.length !== 1 || toolFirstBubbles[0]!.id !== toolFirstAnswer.id) {
  fail(
    6,
    `#94 tool-only-first: the turn left ${toolFirstBubbles.length} bubble(s) — ` +
      `${JSON.stringify(toolFirstBubbles)} — expected exactly one, the answer's ` +
      `(${toolFirstAnswer.id}). A scaffold the answer never claimed is a ghost bubble the ` +
      `protocol cannot remove.`,
  );
}

const toolFirstTurnSettled = toolFirstFrames.find((f) => f.type === "turn_settled");
if (toolFirstTurnSettled?.outcome !== "ok") {
  fail(
    6,
    `#94 tool-only-first: turn settled ${JSON.stringify(toolFirstTurnSettled?.outcome)}, ` +
      `expected "ok".`,
  );
}

console.log(
  `[PROOF] #94 tool-only first message: the answer streamed in ${streamedAnswer.length} ` +
    `progress frame(s) and settled once, in the same bubble (id=${toolFirstAnswer.id}); ` +
    `turn_settled outcome=ok`,
);
transport.disconnect();
process.exit(0);
