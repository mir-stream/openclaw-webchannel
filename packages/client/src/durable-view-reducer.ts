/**
 * v6 delivery-render — THE SHARED DURABLE-VIEW REDUCER (issue #237, doc §15.4).
 *
 * The design's central correctness bet is `history == the live view`, guaranteed
 * BY CONSTRUCTION because both are produced by ONE pure reducer applied to the
 * same ordered event stream. The plugin journals the stream; the client already
 * computes its view from that stream live. Same input + same function ⇒
 * identical view, so the server-side projection can never INVENT an ordering /
 * tombstone / supersession rule of its own — inventing one is precisely the
 * regression class this redesign exists to kill (NOT-list N8).
 *
 * This module is the extraction of the client's live agent-side reconciliation
 * (`nats-client-wrapper.ts`) into a single PURE function. Slice 1 landed it with
 * NO runtime consumer, proven equivalent to the then-current client behavior
 * first; the client render was rewired onto it in the slice after #238, and is
 * now its FIRST runtime consumer — `nats-client-wrapper.ts`'s `applyDurable`
 * (…:2011) projects `state.messages`, applies one event here, and merges the
 * result back. Each of the four transitions has its own EQUIVALENCE ANCHOR in
 * `durable-view-reducer.test.ts`, which drives the REAL `WebChannelNATSClient`
 * with the REAL wire frames and compares against this reducer's output.
 *
 * ⚠️ THE ANCHORS' EVIDENTIAL VALUE CHANGED WHEN THE CLIENT BECAME THE CONSUMER.
 * While the client had its own hand-rolled reconciliation they were genuinely
 * non-circular: two independent implementations compared. Now the client's
 * durable half IS this file, so an anchor mostly re-derives the reducer through
 * the wrapper. They still earn their place — they cover the frame→event MAPPING,
 * the client-local overlay merge, and the dispatch edge, which are exactly where
 * a rewiring bug lands — but do not read a green anchor as independent
 * confirmation of a TRANSITION any more. The test file says the same thing at its
 * anchor section header.
 *
 * The anchors all compare the FULL durable view, text included. `placement` used
 * to be narrowed to the SLOT SKELETON (id, role, turnId, ORDER) because §15.9
 * excludes the rolling draft text from the durable view while the live client
 * showed it — the one place an anchor stopped short. That carve-out CLOSED when
 * the client became the consumer: the draft now lives behind `draftOnly`, the
 * client's own durable projection blanks it, and the two agree exactly. The
 * former divergence is still pinned by the test file's characterization block, in
 * the other direction (it asserts agreement), so a regression that lets draft
 * text back into the durable view goes red instead of passing quietly.
 *
 * Its sibling test there pins the `answerId: ""` case, which was never a
 * divergence of the same kind: that one is a CALLER-PRECONDITION VIOLATION
 * (BOUNDARY 1 — `bubble.answerId` must be non-empty), recorded next to it because
 * it is the trap the frame→event mapper walks into, not because the reducer chose
 * to differ.
 *
 * SCOPE: the DURABLE subset of the client's `state.messages` only — `id`,
 * `role`, `text`, `turnId`, and ORDERING. Per §0.1 / the north star ("the
 * client owns its own send/UI state"), the client-local overlay is DELIBERATELY
 * excluded: `working`, `draftOnly`, `sendState`/`sendFailure`, `receiptKey`,
 * `wireId`, `pending`/`retracted` (held), `isTyping`, `ts`,
 * `assistantMessageIndex`. Those are the app's half of a Telegram-style split and
 * are never journaled.
 *
 * PURITY CONTRACT: no `this`, no I/O, no clock, no randomness, deterministic,
 * and neither the input view nor the input event is ever mutated. A transition
 * that changes the durable view returns a NEW array, sharing the unchanged
 * ENTRIES by reference.
 *
 * ⚠️ ARRAY IDENTITY IS NOT A GENERAL NO-OP SIGNAL. Some transitions hand the
 * input array straight back when nothing durable changed, and some always
 * allocate. Measured. The three SAME-array rows are EXHAUSTIVE — they are every
 * path in this file that returns its input by reference. The two NEW-array rows
 * are illustrative examples, not an enumeration: allocation is the default here,
 * so any PATH not listed among the first three allocates. (Path, not
 * transition: `placement` and `seal` each have paths on BOTH sides of the
 * divide, even though only `seal` happens to have a row in each section below.)
 *   - `placement`, repeat claim whose turnId resolves unchanged  → SAME array
 *   - `seal`, early return (no valid answers and no removes)     → SAME array
 *   - `seal`, empty/blank turnId early return                    → SAME array
 *   - `bubble` with identical text and turnId                    → NEW array (e.g.)
 *   - `seal` whose answers change nothing                        → NEW array (e.g.)
 * The last two ALWAYS allocate (see `applyBubble` and `applySeal`'s tail); they
 * do not detect no-ops, and teaching them to would be a behavior change this
 * slice does not need. So do NOT build a `prev === next` memo, a
 * `useSyncExternalStore` equality check, or any render skip on array identity —
 * it is sound only as "same ref ⇒ definitely unchanged", never as
 * "different ref ⇒ changed". `durable-view-reducer.test.ts` pins all five rows
 * above, the negative cases included, so the next reader measures instead of
 * assuming.
 *
 * ⚠️ AN UNKNOWN EVENT KIND IS NOT A NO-OP — AND `return view` IS NOT THE FIX.
 * The `switch` in `applyDurableEvent` has NO `default`, so an out-of-union
 * `kind` falls off the end and returns `undefined` while the signature declares
 * `DurableView`; the NEXT event then throws — `Cannot read properties of
 * undefined (reading 'findIndex')` for a `placement`/`bubble` — pointing at the
 * WRONG event. That is unreachable today, and MEASURED rather than assumed:
 * adding a fifth kind to `DurableEvent` fails tsc at this function's signature
 * with `error TS2366: Function lacks ending return statement and return type
 * does not include 'undefined'`, so the forgotten-case path BOUNDARY 2
 * anticipates cannot ship. The client consumer only ever constructs events from
 * the four wire frames it already handles, so with no journal yet the ONE
 * surviving path is RUNTIME VERSION SKEW — an older build replaying a journal a
 * newer build wrote — which first needs #239 (the journal) and #241 (a grown
 * event set). Both obvious fixes are wrong, in the spirit of §0.2:
 *   - `default: return view;`, mirroring `handleFrame`'s ignore-unknown
 *     (nats-client-wrapper.ts:2293 — which has no `default:` either; it returns
 *     `void`, so falling off the end IS its ignore) — REJECTED. That
 *     faithfulness is about LIVE WIRE FRAMES, where ignoring a frame from a
 *     newer server is right. A JOURNAL REPLAY is the opposite: the store is the
 *     SSOT, so silently dropping rows it does not understand is the server
 *     destroying its own truth — a quietly incomplete history with no signal to
 *     anyone, the same N8 live≠history shape, arriving through this module.
 *   - `default: throw` — REJECTED. That is the app dying instead of degrading.
 * The real answer is RETAIN + RENDER AS UNSUPPORTED: keep the slot and show
 * "this message is not supported by your version — please update", exactly as
 * the Telegram app does (our plugin = the Telegram plugin + the Telegram
 * server; our client = the Telegram app). A four-member CLOSED union cannot
 * express that, so it is owned by #241 (typed event model) and #246 (protocol
 * version + runtime wire validation), NOT by this slice. Do not add a `default`
 * here to silence a reviewer: the absence is deliberate, and this is the reason.
 * (doc `docs/ISSUE_114_DELIVERY_MIRROR_PLAN.md` §0.2 — the NOT-list.)
 *
 * DEPENDENCY CONTRACT: this file is STRICTLY dependency-free and Node-free — it
 * has no imports at all, not even `node:` built-ins. Two reasons: the client
 * package publishes as a zero-dependency browser-targeted bundle (its tsconfig
 * lib set is `ES2022`/`DOM` with no `@types/node`), and the plugin consumes this
 * same file by cross-package SOURCE import (see
 * `packages/plugin/src/durable-view-reducer-contract.test.ts`), which only
 * bundles cleanly while the file drags in nothing. Keep it that way.
 *
 * The `seal` transition WAS a line-for-line port of the wrapper's private
 * `applyTurnSnapshot`; that body has since been deleted and the wrapper's method
 * (nats-client-wrapper.ts:1546-1573) is now only the frame→event mapper that
 * calls it. There is one implementation of the reconciliation, and it is here.
 */

export type DurableRole = "user" | "agent";

/**
 * The durable subset of one `ChatMessage`. Client-local fields are excluded.
 *
 * `readonly` is load-bearing, not decoration: every transition below returns a
 * STRUCTURALLY SHARED view — unchanged entries are the SAME object references as
 * in the input, and some transitions return the input array itself (see the
 * array-identity table in the file header; it is a partial, not a general,
 * property). The client consumer computes `merge(view, overlay)`
 * (`nats-client-wrapper.ts`'s `mergeDurable`, …:1944), and an in-place overlay
 * write on a shared entry would retroactively mutate a view some other holder
 * already observed. The type makes that a compile error instead of a heisenbug.
 * It does NOT forbid the consumer handing an UNCHANGED bubble back by reference
 * — that is structural sharing, the same discipline this file follows, and the
 * wrapper's suite pins it with `.toBe`.
 */
export interface DurableMessage {
  readonly id: string;
  readonly role: DurableRole;
  readonly text: string;
  readonly turnId?: string;
}

export type DurableView = readonly DurableMessage[];

/**
 * The ordered event stream the plugin would journal. Each event corresponds to a
 * real wire frame the client consumes today — the shapes below were read off
 * `packages/plugin/src/channel-contract.ts` (`OutboundWsMessage`) and the
 * wrapper's `handleFrame` cases (…:2293 — `handleMessage` at …:2280 is the
 * outer entry point, which brackets that switch with the live-turn latch
 * observation and the release gate), and every transition is anchored against the
 * REAL client in `durable-view-reducer.test.ts`. What that covers is the four
 * kinds below; see the two BOUNDARY notes after the type for what it does not.
 *
 *  - `user`      — the local user echo installed by `publish()`
 *                  (nats-client-wrapper.ts:847). Durable subset of the u- bubble.
 *  - `placement` — a `progress` frame for a lane (case "progress",
 *                  nats-client-wrapper.ts:2701). The FIRST one CLAIMS the lane's
 *                  slot (append at tail). The frame ALWAYS carries text —
 *                  `progress.text` is REQUIRED on the wire
 *                  (channel-contract.ts:66) and the live client renders it —
 *                  but §15.9 CLASSIFIES that rolling "Working…" draft as an
 *                  indicator rather than a message, so this event does not carry
 *                  it and the durable text is authored later by a `bubble` or
 *                  `seal`. The consumer keeps the two apart with the client-local
 *                  `ChatMessage.draftOnly` flag: the draft renders out of `text`,
 *                  while the wrapper's `durableProjection` (…:1870) contributes
 *                  `""` for that bubble. §15.9 is thus enforced at the projection,
 *                  not merely asserted here.
 *                  `turnId` is OPTIONAL because the wire says so
 *                  (channel-contract.ts:66; nats-channel.ts:469 omits it when
 *                  falsy) and the client stores it verbatim. A required one would
 *                  force a consumer to drop such a frame — losing the slot claim,
 *                  i.e. the [A,B]-vs-[B,A] ordering — or to invent a value.
 *  - `bubble`    — a durable agent frame: `agent_message`/final/independent
 *                  (case "agent_message", nats-client-wrapper.ts:2827).
 *                  Upsert-by-id: update text in place if the id is held, else
 *                  append at tail.
 *  - `seal`      — the `turn_snapshot` frame (case "turn_snapshot",
 *                  nats-client-wrapper.ts:2822 → `applyTurnSnapshot`). Carries
 *                  BOTH `answers` and `remove` in one frame, exactly like the
 *                  wire (there is no standalone `remove` wire frame — remove
 *                  exists ONLY inside turn_snapshot, so it is modeled as a `seal`
 *                  field, not a separate event).
 *
 * ── BOUNDARY 1: a viewer-minted id must never enter the SHARED event stream ──
 *
 * `bubble.answerId` is mandatory, but the wire can deliver a durable agent frame
 * with NO id. `nats-channel.ts:456` is the ONLY producer of an `agent_message`
 * frame, and its `sendText` writes `...(id ? { id } : {})` (…:458), so the
 * id-less set is exactly the `sendText` callers that pass no `id`.
 *
 * ✅ THAT SET IS NOW EMPTY. #238 landed: all FOUR call sites this note used to
 * enumerate mint at the delivery act — `inbound.ts:1571-1581` (the ordinary
 * visible reply, both branches of the one ternary), `inbound.ts:1626-1631` (the
 * thrown-turn apology), `channel.ts:311` (the generic outbound), and
 * `nats-account-runtime.ts:1177-1182` (the /stop operator-allowlist notice).
 * `message-adapter.ts:158` passes `nextMessageId()` and `nats-channel.ts:483`
 * (`finalizeDraft`) requires an `id`, as they always did. The enumeration is kept
 * in the past tense rather than deleted because "the count is four, not three"
 * was itself hard-won: an earlier revision said three and missed the /stop
 * notice, and a survivor would have been INVISIBLE to this module's anchors (an
 * id-less frame has none, by design).
 *
 * The client's id-less branch therefore survives only as a LEGACY-PLUGIN path
 * (nats-client-wrapper.ts:2834 `if (id) {…}`, else …:2869 mints
 * `id: \`a-${this.uid()}\`` from a CLIENT-LOCAL counter, behind a one-shot
 * `console.warn`). It is routed through this reducer as a `bubble`, and that is
 * ADMISSIBLE for one reason only: the minted id never leaves the client. What
 * this boundary forbids is a viewer-minted id in the SHARED EVENT STREAM — the
 * journal, the SSOT — where it would write viewer-side identity into history
 * (NOT-list N4/N5; doc §16.5: identity is assigned at the DELIVERY ACT, by the
 * plugin). Inside a purely local view it does the opposite of harm: it removes
 * the N8 divergence the old blind-append branch created, where the live view
 * held a bubble the durable view did not. The model must still not grow a
 * `kind: "idless"` case, and a journaling consumer (#239) must never persist one.
 *
 * ⚠️ THE ORDERING CONSTRAINT THIS ONCE IMPOSED IS SATISFIED, AND IS RECORDED
 * HERE AS THE REASON THE BOUNDARY EXISTS — NOT AS A LIVE BLOCKER. It read: the
 * client render must not be rewired onto this reducer until #238 lands. #238
 * landed and the rewiring happened, in that order. Had it happened in the other
 * order you would have got one of the two bugs the module exists to prevent —
 * the reducer's view silently lacking a bubble the live view shows (N8), or the
 * viewer minting identity into the SSOT (N4).
 *
 * ⚠️ AND `""` IS STILL THE WRONG ANSWER. `bubble.answerId` must be NON-EMPTY;
 * `""` is NOT the encoding for "id-less". The trap is that the client's two id
 * sites use DIFFERENT falsiness, so the natural mapper is the broken one:
 *   - `progress` keys on `id ?? ""` (nats-client-wrapper.ts:2707) — NULLISH, so
 *     `""` SURVIVES as a real id. `placement` with `answerId: ""` is therefore
 *     FAITHFUL;
 *   - `agent_message` branches on `if (id)` (…:2834) — TRUTHY, so `""` falls
 *     into the mint branch at …:2869 and gets its own fresh `a-<n>`.
 * The two sites genuinely differ, and the live mapper preserves the difference
 * verbatim. A mapper writing `answerId: frame.id ?? ""` for the DURABLE frame —
 * the natural thing to write, because it mirrors the progress site — would make
 * N id-less finals collapse into ONE durable row while live shows N bubbles: an
 * N8 live≠history divergence landing in the mapper rather than here. Measured
 * and pinned by the test file's characterization block.
 *
 * `applySeal` already refuses an empty answer id (`a.id.length > 0`, and the
 * same for the remove filter); `applyBubble` does not, which is why this is a
 * CALLER precondition and not a guard.
 *
 * ── PRECONDITION: the journal contains no duplicate `user` rows ──
 *
 * `placement` and `bubble` are upserts and `seal` is keyed by answer id, so
 * replaying any of them is harmless. `user` is the ONE non-idempotent
 * transition: it blind-appends, mirroring `publish()`, so two `user` events with
 * the same id yield two bubbles. Worse, a duplicated id then makes `applySeal`'s
 * slot refill index `answers[idx]` past the end (`slots.length > answers.length`)
 * and THROW — a pure projection that crashes instead of returning a view.
 *
 * That is a faithful port, not a defect to fix here: the live client threw
 * identically from its own copy of this loop before the rewire, and now throws
 * THROUGH this function (so the test file's "the REAL client throws on the same
 * input" case no longer proves independence — see the anchor caveat in the
 * header). The only difference is reachability — live, `u-${this.uid()}`
 * (nats-client-wrapper.ts:847, and `uid()` is `${this.seq++}` at …:2052-2054) is
 * monotonic so the precondition cannot be violated; a journal REPLAY can violate
 * it. Do not "fix" it by making
 * `applyUser` an upsert or by de-duplicating inside `applySeal`: inventing a
 * reconciliation rule the client does not have is exactly the defect class this
 * slice forbids, and it would put the divergence somewhere much harder to see.
 *
 * IDEMPOTENT APPEND IS THE JOURNAL'S JOB, not the reducer's — slice #239's
 * persist-before-publish boundary owns it. The hazard is concrete rather than
 * theoretical: doc §15.8 mandates that a failed journal append is retried
 * NON-DESTRUCTIVELY, so a retry whose first attempt actually landed writes the
 * row twice. Replay it and history shows the user's message twice while live
 * shows it once — the N8 live≠history duplicate class this redesign exists to
 * kill, reintroduced at the fold. Both behaviors are pinned by CHARACTERIZATION
 * tests in `durable-view-reducer.test.ts` (they record what happens; they do not
 * endorse it).
 *
 * ── BOUNDARY 2: four kinds is TODAY'S wire, not the settled model ──
 *
 * Doc §15.9 requires tool and reasoning messages to become DURABLE messages —
 * only pure indicators (the rolling progress draft, the typing flag) stay
 * ephemeral. So this event set will GROW. Do not read the four kinds as final
 * spec, and do not treat "it isn't in DurableEvent" as evidence that something
 * is non-durable by design (NOT-list N3/N7).
 *
 * ── BOUNDARY 3: the `history` frame is durable but deliberately OUT OF SCOPE ──
 *
 * `channel-contract.ts:102` declares `{ type: "history"; messages: … }`, and it
 * genuinely writes `state.messages` today — adoption plus ordered cursor
 * insertion, nats-client-wrapper.ts:2295-2492. It is nonetheless absent from
 * `DurableEvent`, and that absence is a DECISION, not an oversight: doc §15.9
 * places history outside the reducer ("reducer 밖(의도적) … workstream C")
 * because the current frame is reconnect / late-join RECONSTRUCTION — the client
 * guessing at a transcript it did not witness — which a plugin-side server
 * snapshot replaces outright. Modeling today's guessing as a reducer event would
 * bake the guess into the SSOT.
 *
 * Same warning as Boundary 2: absence from `DurableEvent` is not evidence that
 * a frame is non-durable (N3/N7). Here it means "durable, owned by another
 * workstream."
 */
export type DurableEvent =
  | { kind: "user"; id: string; text: string; turnId?: string }
  | { kind: "placement"; answerId: string; turnId?: string }
  | { kind: "bubble"; answerId: string; text: string; turnId?: string }
  | {
      kind: "seal";
      turnId: string;
      answers: Array<{ id: string; text: string }>;
      remove?: string[];
    };

/**
 * STEP: apply exactly ONE journaled event to a durable view.
 *
 * This is the primitive, and `reduceDurableView` below is defined in terms of
 * it — deliberately, because the two consumers need different arities of the
 * SAME code path:
 *
 *  - the client render folds INCREMENTALLY, one event at a time as frames land,
 *    and must never be forced to retain an unbounded log just to re-derive its
 *    own view;
 *  - the server-side history projection REPLAYS the full journal.
 *
 * If those were two implementations the shared-reducer guarantee would be
 * worthless, so there is exactly one `switch` in this file and the fold is a
 * literal `Array.prototype.reduce` over it. `durable-view-reducer.test.ts`
 * pins the agreement of the two entry points.
 *
 * PURE: `view` and `event` are never mutated. Usually a fresh array is
 * returned; some transitions instead hand the input back, which is safe
 * precisely because nothing here mutates in place. Do NOT read that as
 * "a durable no-op returns the same reference" — it does not (a `bubble`
 * repeating its text and turnId allocates, and the suite pins it). See the
 * array-identity table in the file header: it is a partial property, never a
 * no-op signal.
 */
export function applyDurableEvent(
  view: DurableView,
  event: DurableEvent,
): DurableView {
  switch (event.kind) {
    case "user":
      return applyUser(view, event);
    case "placement":
      return applyPlacement(view, event);
    case "bubble":
      return applyBubble(view, event);
    case "seal":
      return applySeal(view, event);
  }
}

/**
 * FOLD: replay an ordered event stream into the durable view. BOTH the client
 * render (durable projection of `state.messages`) and — per the v6 bet — the
 * eventual server projection compute their view through `applyDurableEvent`;
 * this is only the whole-log convenience over it, never a parallel copy of the
 * transition table.
 */
export function reduceDurableView(events: readonly DurableEvent[]): DurableView {
  // The callback is wrapped rather than passed point-free on purpose: `reduce`
  // invokes it as `(acc, cur, index, array)`, so a future third parameter on
  // `applyDurableEvent` would silently start receiving the element index.
  return events.reduce<DurableView>((view, event) => applyDurableEvent(view, event), []);
}

/** User echo — `publish()` always APPENDS a fresh u- bubble at the tail. */
function applyUser(
  view: DurableView,
  event: { id: string; text: string; turnId?: string },
): DurableView {
  return [...view, { id: event.id, role: "user", text: event.text, turnId: event.turnId }];
}

/**
 * `progress` frame — upsert by id (the shape the wrapper's now-deleted
 * `upsertMessage` had; the mapper is `case "progress"`, …:2701):
 *
 *  - an ABSENT id APPENDS a placeholder bubble at the tail — the slot claim, and
 *    the ORDERING mechanism: the lane's position is fixed by WHEN its first
 *    progress arrived;
 *  - a PRESENT id keeps its slot and REFRESHES `turnId`. The `??` runs on EVERY
 *    progress, not only the first: an absent turnId keeps the previous value.
 *
 * The text/`working` churn a repeat progress also carries stays out of the
 * durable view: §15.9 classifies the rolling draft as a 표시기 (indicator), not a
 * message. That is why the claim lands with `text: ""` and the durable text is
 * authored later by a `bubble` or `seal`.
 *
 * ⚠️ UNGUARDED INVARIANT that both the text-drop AND the no-op above depend on:
 * NO `progress` frame ever follows a durable frame for the SAME id. Nothing in
 * this file enforces it, and nothing type-checks it — it holds only because the
 * plugin never emits such a frame. Two guards are why:
 *   - `attemptProgress` refuses a lane frame once the lane is done
 *     (message-adapter.ts:1332-1333, `lane.closed || lane.settled`);
 *   - the provisional-preview path invalidates its scaffold writer before
 *     finalizing (message-adapter.ts:1643), so a late preview progress is
 *     dropped by the `scaffoldWriter !== "active"` check at …:1309-1313.
 *
 * If the plugin ever violates it, the live client and a journal replay DIVERGE:
 * `agent_message A "FINAL ANSWER"` followed by `progress A "Working…"` leaves the
 * live view showing "Working…" — the consumer applies the draft text
 * unconditionally — while a replay of `[bubble A "FINAL ANSWER", placement A]`
 * still holds "FINAL ANSWER", because `placement` carries no text and finds the
 * id already present. History ≠ live (N8), in the WRONG-TEXT direction.
 *
 * ⚠️ IT STOPS THERE, AND THAT CAP IS DELIBERATE. The consumer refuses to ADD
 * `draftOnly` to a bubble that already exists without it (nats-client-wrapper.ts's
 * `case "progress"`, …:2701), so the mis-marked bubble is NOT droppable and
 * survives the turn end for a later `turn_snapshot` to repair. Without that guard
 * the same stray frame would delete a delivered answer outright — escalating a
 * display bug into content loss, against this project's own ordering that a
 * visible duplicate is recoverable where a deletion is not (M212g,
 * `message-adapter.ts:1760-1761`).
 *
 * Do not silently "harmonize" the wrong text if you meet it; it means a plugin
 * guard regressed, and the guard is the thing to fix.
 *
 * ⚠️ THE FORWARD CASE NEEDS NO REGRESSION AT ALL, so do not read the two guards
 * above as covering it. A lane that receives `progress` and then NEVER a durable
 * frame is reachable today: an aborted turn, a dropped connection, or the
 * thrown-turn apology at `inbound.ts:1626-1631` (id-BEARING since #238, so it now
 * appends its own bubble by the plugin's name rather than a client-minted one).
 * That is the §15.9 classification working as designed at the reducer level.
 *
 * ✅ WHAT SHOULD RENDER FOR SUCH A LANE IS SETTLED — #251: NOTHING. Core's
 * built-in Telegram extension DELETES an unfinalized preview at turn end
 * (`[core] extensions/telegram/src/bot-message-dispatch.ts:2971-2975` —
 * `lane.finalized ? stream.stop() : stream.clear()`, and `clear()` really deletes
 * via `draft-stream.ts:653-668` → `:634 api.deleteMessage`). So the reducer's
 * `""` is RIGHT and it was the LIVE side that was wrong: keeping the partial
 * draft forever was the bug, and the consumer's `draftOnly` drop
 * (nats-client-wrapper.ts's `isSpentDraft`, …:1899) fixes it. Both sides then
 * agree on "no bubble" and live==history holds.
 *
 * Still do not resolve it here by teaching the reducer to keep draft text — that
 * is the §15.9 reversal, and it would put the decision in the wrong layer. The
 * SLOT CLAIM this transition makes is unaffected: the bubble is emitted for as
 * long as it is live, which is when ordering matters, and a durable frame
 * arriving after the drop re-appends (`applyBubble`) or is minted next to its
 * predecessor (`applySeal` step 3).
 */
function applyPlacement(
  view: DurableView,
  event: { answerId: string; turnId?: string },
): DurableView {
  const idx = view.findIndex((m) => m.id === event.answerId);
  if (idx === -1) {
    return [...view, { id: event.answerId, role: "agent", text: "", turnId: event.turnId }];
  }
  const prev = view[idx];
  const turnId = event.turnId ?? prev.turnId;
  // Durable no-op (the draft churn is not durable) — return the SAME reference.
  if (turnId === prev.turnId) return view;
  const next = view.slice();
  next[idx] = { ...prev, turnId };
  return next;
}

/**
 * Durable agent frame — upsert by id: update text in place if the id is held
 * (keeping its claimed slot), else APPEND at the tail. This is what makes
 * remove-then-late-readd RESURRECT (order-sensitive, not tombstone dominance): a
 * `seal` remove drops the id, and a LATER `bubble` re-appends it.
 *
 * NOTE the asymmetry in `role`, which is the client's pre-rewire behavior
 * preserved: the UPDATE branch spreads the held entry and writes only
 * text/turnId — it never touches `role` — while only the APPEND fallback sets
 * `role: "agent"`. Unreachable today (the u-/a-/lane id namespaces do not
 * collide), but this module's entire product is byte-faithfulness, so an
 * id-namespace change must break the anchor rather than silently reclassify a
 * user bubble in the durable history.
 */
function applyBubble(
  view: DurableView,
  event: { answerId: string; text: string; turnId?: string },
): DurableView {
  const idx = view.findIndex((m) => m.id === event.answerId);
  if (idx === -1) {
    return [...view, { id: event.answerId, role: "agent", text: event.text, turnId: event.turnId }];
  }
  const next = view.slice();
  next[idx] = { ...next[idx], text: event.text, turnId: event.turnId ?? next[idx].turnId };
  return next;
}

/**
 * `turn_snapshot` reconciliation — the ONE implementation. The wrapper's
 * `applyTurnSnapshot` (nats-client-wrapper.ts:1546-1573) is now only the
 * frame→event mapper that feeds this. The contract is EXPLICIT (never a blanket
 * drop):
 *  - `remove` ids are dropped;
 *  - `answers` are upserted by id (existing bubble reused, absent id MINTED —
 *    #215 failed-frame recovery) then reordered into snapshot order among the
 *    slots answer bubbles already occupy — every non-answer bubble keeps its
 *    exact slot;
 *  - everything else is untouched.
 */
function applySeal(
  view: DurableView,
  event: { turnId: string; answers: Array<{ id: string; text: string }>; remove?: string[] },
): DurableView {
  const turnId = event.turnId;
  if (typeof turnId !== "string" || turnId.length === 0) return view;

  const rawAnswers = (Array.isArray(event.answers) ? event.answers : []).filter(
    (a): a is { id: string; text: string } =>
      !!a && typeof a.id === "string" && a.id.length > 0 && typeof a.text === "string",
  );
  // Defense-in-depth: keep the FIRST occurrence of a duplicated answer id, so
  // the slot-refill's `slots.length === answers.length` assumption holds.
  const answerSeen = new Set<string>();
  const answers = rawAnswers.filter((a) =>
    answerSeen.has(a.id) ? false : (answerSeen.add(a.id), true),
  );
  const removeSet = new Set(
    (Array.isArray(event.remove) ? event.remove : []).filter(
      (r): r is string => typeof r === "string" && r.length > 0,
    ),
  );
  if (answers.length === 0 && removeSet.size === 0) return view;

  // 1. Drop the plugin-named superseded (mis-routed) answer bubbles.
  //    Both branches produce a fresh MUTABLE working copy (`filter`/`slice` off a
  //    readonly array widen to `DurableMessage[]`), so steps 3-4 below may splice
  //    and assign freely without ever touching the caller's `view`.
  const msgs: DurableMessage[] =
    removeSet.size > 0 ? view.filter((m) => !removeSet.has(m.id)) : view.slice();

  // 2. Desired answer objects, in authoritative order, reusing any existing
  //    bubble (so a live bubble's fields survive).
  const existingById = new Map(msgs.map((m) => [m.id, m] as const));
  const desiredById = new Map<string, DurableMessage>();
  for (const a of answers) {
    const prev = existingById.get(a.id);
    desiredById.set(
      a.id,
      prev
        ? { ...prev, role: "agent", text: a.text, turnId }
        : { id: a.id, role: "agent", text: a.text, turnId },
    );
  }
  const answerIds = new Set(answers.map((a) => a.id));

  // 3. Give every MINTED (not-yet-present) answer a slot next to its predecessor
  //    answer, so the reorder below is a pure permutation.
  for (let k = 0; k < answers.length; k++) {
    if (existingById.has(answers[k].id)) continue;
    let insertAt = msgs.length;
    if (k > 0) {
      const predIdx = msgs.findIndex((m) => m.id === answers[k - 1].id);
      insertAt = predIdx === -1 ? msgs.length : predIdx + 1;
    } else {
      const firstAnswer = msgs.findIndex((m) => answerIds.has(m.id));
      if (firstAnswer !== -1) insertAt = firstAnswer;
    }
    msgs.splice(insertAt, 0, desiredById.get(answers[k].id)!);
  }

  // 4. Refill the answer slots in authoritative order — answer bubbles reorder
  //    among themselves; every non-answer bubble keeps its exact slot.
  const slots: number[] = [];
  msgs.forEach((m, i) => {
    if (answerIds.has(m.id)) slots.push(i);
  });
  slots.forEach((pos, idx) => {
    msgs[pos] = desiredById.get(answers[idx].id)!;
  });

  return msgs;
}

/**
 * Project a full `ChatMessage[]` (the client's live `state.messages`) down to
 * the durable view. Keeps only the durable fields.
 *
 * ⚠️ THIS IS THE RAW FIELD PROJECTION. It reads `text` verbatim, so calling it on
 * LIVE `state.messages` reads a rolling draft's partial text back as durable
 * content. Use `projectDurableFromClient` below for anything holding a live
 * client bubble; this one is for views that are already durable.
 */
export function projectDurable(
  messages: Array<{ id: string; role: DurableRole; text: string; turnId?: string }>,
): DurableView {
  return messages.map((m) => ({ id: m.id, role: m.role, text: m.text, turnId: m.turnId }));
}

/**
 * Project a LIVE client transcript down to the durable view: `projectDurable`
 * with the §15.9 rule applied first — a bubble that has received only a rolling
 * `progress` draft (`draftOnly`) contributes `text: ""`, whatever the UI is
 * currently rendering for it.
 *
 * This lives HERE rather than in the wrapper because it is not a client
 * preference, it is the durability boundary itself: "the rolling draft is a
 * 표시기 (indicator), not a message." Two copies of it — one in the render path,
 * one in the eventual server projection — would be an N8 live≠history divergence
 * with nothing to make it go red, which is the failure class this module exists
 * to close. One rule, one module, both consumers import it.
 *
 * It is also what makes the #251 drop expressible at all: without it the draft
 * text lands in `text` for rendering and the durable `""` becomes unrecoverable,
 * so an unfinalized lane freezes at its last partial forever instead of
 * disappearing at turn end.
 *
 * The parameter is STRUCTURAL, not `ChatMessage`: this file is strictly
 * dependency-free (see the DEPENDENCY CONTRACT in the header) and the plugin
 * imports it by cross-package source path.
 */
export function projectDurableFromClient(
  messages: Array<{
    id: string;
    role: DurableRole;
    text: string;
    turnId?: string;
    draftOnly?: boolean;
  }>,
): DurableView {
  return projectDurable(
    messages.map((m) => (m.draftOnly === true ? { ...m, text: "" } : m)),
  );
}
