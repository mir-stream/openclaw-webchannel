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
 * (`nats-client-wrapper.ts`) into a single PURE function. As of slice 1 NOTHING
 * consumes it at runtime: it is proven equivalent to today's client behavior
 * first, and the consumers are rewired in a later slice. That ordering is
 * deliberate — the anchors characterize current behavior BEFORE any refactor
 * touches it. Each of the four transitions has its own EQUIVALENCE ANCHOR in
 * `durable-view-reducer.test.ts`, which drives the REAL `WebChannelNATSClient`
 * with the REAL wire frames and compares against this reducer's output. A red
 * anchor always means the REDUCER is wrong; never adjust the expectation.
 *
 * The anchors are not all equally wide, and the narrowing is a CARVE-OUT, not an
 * oversight: `user`, `bubble` and `seal` compare the FULL projected view (text
 * included), while `placement` compares only the SLOT SKELETON — id, role,
 * turnId and ORDER. §15.9 excludes the rolling draft text from the durable view,
 * so `applyPlacement` stores `text: ""` where the live client shows the draft.
 * That text drop is the only place an anchor stops short of the live view, and
 * it is itself pinned — the test file's "the deliberate divergence, and the
 * precondition trap beside it" characterization block records it, so a change in
 * either direction goes red instead of passing quietly. Its sibling test there
 * pins the `answerId: ""` case, which is NOT a divergence of the same kind: that
 * one is a CALLER-PRECONDITION VIOLATION (BOUNDARY 1 — `bubble.answerId` must be
 * non-empty), recorded next to it because it is the trap a slice-2 mapper walks
 * into, not because the reducer chose to differ.
 *
 * SCOPE: the DURABLE subset of the client's `state.messages` only — `id`,
 * `role`, `text`, `turnId`, and ORDERING. Per §0.1 / the north star ("the
 * client owns its own send/UI state"), the client-local overlay is DELIBERATELY
 * excluded: `working`, `sendState`/`sendFailure`, `receiptKey`, `wireId`,
 * `pending`/`retracted` (held), `isTyping`, `ts`, `assistantMessageIndex`.
 * Those are the app's half of a Telegram-style split and are never journaled.
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
 * so any transition not listed among the first three allocates.
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
 * anticipates cannot ship. With zero runtime consumers and no journal yet, the
 * ONE surviving path is RUNTIME VERSION SKEW — an older build replaying a
 * journal a newer build wrote — which first needs #239 (the journal) and #241
 * (a grown event set). Both obvious fixes are wrong, in the spirit of §0.2:
 *   - `default: return view;`, mirroring `handleFrame`'s ignore-unknown
 *     (nats-client-wrapper.ts:2061 — which has no `default:` either; it returns
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
 * The `seal` transition is a line-for-line port of the wrapper's private
 * `applyTurnSnapshot` (nats-client-wrapper.ts:1486-1557) operating on the
 * durable projection instead of the full `ChatMessage[]`.
 */

export type DurableRole = "user" | "agent";

/**
 * The durable subset of one `ChatMessage`. Client-local fields are excluded.
 *
 * `readonly` is load-bearing, not decoration: every transition below returns a
 * STRUCTURALLY SHARED view — unchanged entries are the SAME object references as
 * in the input, and some transitions return the input array itself (see the
 * array-identity table in the file header; it is a partial, not a general,
 * property). Slice 2 computes `merge(reduce(log), overlay)`, and an in-place
 * overlay write on a shared entry would retroactively mutate a view some other
 * holder already observed. The type makes that a compile error instead of a
 * heisenbug.
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
 * wrapper's `handleMessage` cases, and every transition is anchored against the
 * REAL client in `durable-view-reducer.test.ts`. What that covers is the four
 * kinds below; see the two BOUNDARY notes after the type for what it does not.
 *
 *  - `user`      — the local user echo installed by `publish()`
 *                  (nats-client-wrapper.ts:804). Durable subset of the u- bubble.
 *  - `placement` — a `progress` frame for a lane (case "progress",
 *                  nats-client-wrapper.ts:2467). The FIRST one CLAIMS the lane's
 *                  slot (append at tail via `upsertMessage`). The frame ALWAYS
 *                  carries text — `progress.text` is REQUIRED on the wire
 *                  (channel-contract.ts:66) and the live client writes it
 *                  (…:2472-2473) — but §15.9 CLASSIFIES that rolling "Working…"
 *                  draft as an indicator rather than a message, so this event
 *                  does not carry it and the durable text is authored later by a
 *                  `bubble` or `seal`. That is a classification, not a wire fact;
 *                  it is the deliberate divergence pinned by the test file's
 *                  characterization block.
 *                  `turnId` is OPTIONAL because the wire says so
 *                  (channel-contract.ts:66; nats-channel.ts:469 omits it when
 *                  falsy) and the client stores it verbatim (…:2473). A required
 *                  one would force a consumer to drop such a frame — losing the
 *                  slot claim, i.e. the [A,B]-vs-[B,A] ordering — or to invent a
 *                  value.
 *  - `bubble`    — a durable agent frame: `agent_message`/final/independent
 *                  (case "agent_message", nats-client-wrapper.ts:2562).
 *                  Upsert-by-id: update text in place if the id is held, else
 *                  append at tail.
 *  - `seal`      — the `turn_snapshot` frame (case "turn_snapshot",
 *                  nats-client-wrapper.ts:2557 → `applyTurnSnapshot`). Carries
 *                  BOTH `answers` and `remove` in one frame, exactly like the
 *                  wire (there is no standalone `remove` wire frame — remove
 *                  exists ONLY inside turn_snapshot, so it is modeled as a `seal`
 *                  field, not a separate event).
 *
 * ── BOUNDARY 1: the id-LESS `agent_message` branch is deliberately NOT modeled ──
 *
 * `bubble.answerId` is mandatory, but the wire today can deliver a durable agent
 * frame with NO id: `nats-channel.ts:458` writes `...(id ? { id } : {})`, and
 * three call sites pass none — `inbound.ts:1549`, `inbound.ts:1599` (the
 * thrown-turn apology) and `channel.ts:303`. The client branches on
 * `nats-client-wrapper.ts:2569` `if (id) {…}`, and the else at …:2593-2599 mints
 * `id: \`a-${this.uid()}\`` from a CLIENT-LOCAL counter.
 *
 * That branch is excluded ON PURPOSE and the model must not grow a case for it.
 * Admitting a client-minted id into the shared event stream would write
 * viewer-side identity into the SSOT — exactly the failure this redesign exists
 * to kill (NOT-list N4/N5; doc §16.5: identity is assigned at the DELIVERY ACT,
 * by the plugin). The real resolution is that these frames stop being id-less
 * once the plugin assigns identity at delivery (board slice #238), which is why
 * those three call sites become id-bearing.
 *
 * ⚠️ ORDERING CONSTRAINT THIS IMPOSES — the client render must NOT be rewired
 * onto this reducer until #238 lands, and slice 2 must NEVER synthesize an
 * `a-<n>`-style client-local id to feed it. Do either and you get one of the two
 * bugs the module exists to prevent: the reducer's view silently lacks a bubble
 * the live view shows (history ≠ live, N8), or the viewer mints identity (N4).
 *
 * ⚠️ AND `""` IS THE OTHER WRONG ANSWER. `bubble.answerId` must be NON-EMPTY;
 * `""` is NOT the encoding for "id-less". The trap is that the client's two id
 * sites use DIFFERENT falsiness, so the natural mapper is the broken one:
 *   - `progress` upserts on `id ?? ""` (nats-client-wrapper.ts:2471) — NULLISH,
 *     so `""` SURVIVES as a real id. `placement` with `answerId: ""` is
 *     therefore FAITHFUL;
 *   - `agent_message` branches on `if (id)` (…:2569) — TRUTHY, so `""` falls
 *     into the id-less mint branch at …:2593 and gets its own fresh `a-<n>`.
 * The two sites genuinely differ. A slice-2 mapper writing
 * `answerId: frame.id ?? ""` for the durable frame — the natural thing to write,
 * because it mirrors the progress site verbatim — makes N id-less finals
 * collapse into ONE durable row while live shows N bubbles: an N8 live≠history
 * divergence landing in the mapper rather than here. Measured and pinned by the
 * test file's characterization block. Until #238, an id-less `agent_message` has
 * NO `bubble` event at all.
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
 * That is a faithful port, not a defect to fix here: the live client throws
 * identically at nats-client-wrapper.ts:1552-1554. The only difference is
 * reachability — live, `u-${this.seq++}` is monotonic so the precondition cannot
 * be violated; a journal REPLAY can violate it. Do not "fix" it by making
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
 * insertion, nats-client-wrapper.ts:2063-2258. It is nonetheless absent from
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
 * PURE: `view` and `event` are never mutated; a fresh array is returned (or the
 * same reference when the event is a durable no-op, which is safe precisely
 * because nothing here mutates in place).
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
 * `progress` frame. Mirrors `upsertMessage` (nats-client-wrapper.ts:1799):
 *
 *  - an ABSENT id APPENDS a placeholder bubble at the tail — the slot claim, and
 *    the ORDERING mechanism: the lane's position is fixed by WHEN its first
 *    progress arrived;
 *  - a PRESENT id keeps its slot and REFRESHES `turnId`. The client applies
 *    `turnId: msg.turnId ?? prev.turnId` (…:2472) on EVERY progress, not only the
 *    first, so the `??` is exact: an absent turnId keeps the previous value.
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
 * If the plugin ever violates it, the live client and this reducer DIVERGE, and
 * not subtly: the client applies the draft text unconditionally
 * (nats-client-wrapper.ts:2472), so `agent_message A "FINAL ANSWER"` followed by
 * `progress A "Working…"` leaves the live view showing "Working…" while the
 * reducer still holds "FINAL ANSWER" — history ≠ live (N8). Do not silently
 * "harmonize" that if you meet it; it means a plugin guard regressed, and the
 * guard is the thing to fix.
 *
 * ⚠️ THE FORWARD CASE NEEDS NO REGRESSION AT ALL, so do not read the two guards
 * above as covering it. A lane that receives `progress` and then NEVER a durable
 * frame is reachable today: an aborted turn, a dropped connection, or the
 * thrown-turn apology at `inbound.ts:1599`, which is id-LESS and therefore
 * APPENDS a new bubble (BOUNDARY 1) while leaving the draft bubble in place. In
 * every one of those the live view shows the lane's partial text where this
 * reducer holds `""` — the same N8 shape, arrived at without any guard failing.
 * That is the §15.9 classification working as designed at the reducer level;
 * whether history should then render an empty bubble at all (drop it? show a
 * placeholder? keep the slot?) is a slice-2 RENDER question, tracked separately.
 * Do not resolve it here by teaching the reducer to keep draft text — that is
 * the §15.9 reversal, and it would put the decision in the wrong layer.
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
 * Durable agent frame — mirrors `upsertMessage`: update text in place if the id
 * is held (keeping its claimed slot), else APPEND at the tail. This is what
 * makes remove-then-late-readd RESURRECT (order-sensitive, not tombstone
 * dominance): a `seal` remove drops the id, and a LATER `bubble` re-appends it.
 *
 * NOTE the asymmetry in `role`, which mirrors the client exactly: the UPDATE
 * branch (nats-client-wrapper.ts:2571-2578) spreads `prev` and writes only
 * text/working/turnId — it never touches `role` — while only the APPEND fallback
 * (…:2579-2586) sets `role: "agent"`. Unreachable today (the u-/a-/lane id
 * namespaces do not collide), but this module's entire product is
 * byte-faithfulness, so an id-namespace change must break the anchor rather than
 * silently reclassify a user bubble in the durable history.
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
 * `turn_snapshot` reconciliation — a line-for-line port of the wrapper's private
 * `applyTurnSnapshot` (nats-client-wrapper.ts:1486-1557), operating on the
 * durable projection. The contract is EXPLICIT (never a blanket drop):
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
 * the durable view — used by the equivalence anchor to compare the reducer's
 * output against the REAL `applyTurnSnapshot`. Keeps only the durable fields.
 */
export function projectDurable(
  messages: Array<{ id: string; role: DurableRole; text: string; turnId?: string }>,
): DurableView {
  return messages.map((m) => ({ id: m.id, role: m.role, text: m.text, turnId: m.turnId }));
}
