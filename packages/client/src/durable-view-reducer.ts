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
 * projects `state.messages`, applies one event here, and merges the
 * result back. Four of the five transitions have their own EQUIVALENCE ANCHOR in
 * `durable-view-reducer.test.ts`, which drives the REAL `WebChannelNATSClient`
 * with the REAL wire frames and compares against this reducer's output.
 *
 * ⚠️ `reasoning` HAS NO ANCHOR, AND CANNOT HAVE ONE YET. #242 half 1 makes
 * reasoning durable on the SERVER side only: the plugin journals one row per
 * burst (for an account that opted in — `capabilities.reasoningDurable`,
 * default OFF), this reducer folds it, and `journal-history.ts` replays it.
 * The CLIENT
 * still renders reasoning out of its own `state.reasoning` array
 * (`upsertReasoning`) and routes no `reasoning` frame through this file, so
 * there is no second implementation to compare against — an "anchor" would only
 * drive the wrapper's unrelated array. `applyReasoning` is instead a documented
 * port of that method, and the ONE deliberate difference (the live `.slice(-100)`
 * cap) is recorded at the transition. Half 2 moves the client onto this reducer;
 * that is when the anchor becomes possible and when the divergence closes.
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
 * path in this file that returns its input by reference. The three NEW-array rows
 * are illustrative examples, not an enumeration: allocation is the default here,
 * so any PATH not listed among the first three allocates. (Path, not
 * transition: `placement` and `seal` each have paths on BOTH sides of the
 * divide, even though only `seal` happens to have a row in each section below.
 * `reasoning` has NO path in the first section — see its row.)
 *   - `placement`, repeat claim whose turnId resolves unchanged  → SAME array
 *   - `seal`, early return (no valid answers and no removes)     → SAME array
 *   - `seal`, empty/blank turnId early return                    → SAME array
 *   - `bubble` with identical text and turnId                    → NEW array (e.g.)
 *   - `seal` whose answers change nothing                        → NEW array (e.g.)
 *   - `reasoning` REPEATING its id, turnId and text              → NEW array (e.g.)
 * The last three ALWAYS allocate (see `applyBubble`, `applySeal`'s tail, and
 * `applyReasoning` — BOTH of the latter's paths allocate, so it contributes no
 * row to the exhaustive section above); they
 * do not detect no-ops, and teaching them to would be a behavior change this
 * slice does not need. So do NOT build a `prev === next` memo, a
 * `useSyncExternalStore` equality check, or any render skip on array identity —
 * it is sound only as "same ref ⇒ definitely unchanged", never as
 * "different ref ⇒ changed". `durable-view-reducer.test.ts` pins all six rows
 * above, the negative cases included, so the next reader measures instead of
 * assuming.
 *
 * ⚠️ AN UNKNOWN EVENT KIND IS NOT A NO-OP — AND `return view` IS NOT THE FIX.
 * The `switch` in `applyDurableEvent` has NO `default`, so an out-of-union
 * `kind` falls off the end and returns `undefined` while the signature declares
 * `DurableView`; the NEXT event then throws — `Cannot read properties of
 * undefined (reading 'findIndex')` for a `placement`/`bubble` — pointing at the
 * WRONG event. That is unreachable today, and the claim is no longer a
 * measurement someone once took — #242 half 1 RAN the experiment by actually
 * adding a kind, and it behaved as written: `reasoning` failed tsc at this
 * function's signature with `error TS2366: Function lacks ending return
 * statement and return type does not include 'undefined'` until its `case` was
 * added, so the forgotten-case path BOUNDARY 2 anticipates cannot ship. The
 * client consumer still only ever constructs events from the four wire frames it
 * already handles (`reasoning` is journaled and folded SERVER-side in half 1;
 * the client does not route it here), so the ONE surviving path is RUNTIME
 * VERSION SKEW — an older build replaying a journal a newer build wrote.
 *
 * ⚠️ THAT PATH IS NO LONGER HYPOTHETICAL, AND SOMETHING NOW STANDS IN FRONT OF
 * IT. This used to say the skew case "first needs #239 (the journal) and #241 (a
 * grown event set)". #239 LANDED, and #240 added the consumer that reads those
 * rows back: `packages/plugin/src/journal-history.ts` replays a journal through
 * `applyDurableEvent`, and `delivery-journal.ts` RETAINS rows whose kind this
 * build does not know (#253) rather than dropping them — so an out-of-union kind
 * genuinely reaches that consumer's hands. What keeps it out of THIS function is
 * `isKnownJournalEvent` there: a `Record<DurableEvent["kind"], true>`-derived
 * filter that counts such rows into `unsupportedEvents` and never folds them.
 *
 * ⚠️ AND THE LAST PRECONDITION IS NOW MET — BY THIS SLICE, NOT BY #241. This used
 * to end "the remaining precondition is only #241 (a kind outside the four)".
 * #242 half 1 added `reasoning`, so a journal written by a build that has it and
 * replayed by a build that does not is a REAL five-versus-four skew, not a
 * prediction about a slice nobody has started. `isKnownJournalEvent` is
 * therefore load-bearing for an event kind that exists TODAY. What #241 still
 * owns is the answer (retain + render as unsupported); what it no longer owns is
 * the arrival of the first skewable kind.
 *
 * So the next journal consumer must not re-derive this hazard from scratch: the
 * `default`-less switch is still deliberate HERE, and the guard belongs at the
 * consumer, exactly as `journal-history.ts` does it. Both obvious fixes are still
 * wrong, in the spirit of §0.2:
 *   - `default: return view;`, mirroring `handleFrame`'s ignore-unknown
 *     (the wrapper's `handleFrame` — which has no `default:` either; it returns
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
 * server; our client = the Telegram app). A CLOSED union cannot
 * express that — five members no more than four — so it is owned by #241 (typed
 * event model) and #246 (protocol
 * version + runtime wire validation), NOT by this slice. Do not add a `default`
 * here to silence a reviewer: the absence is deliberate, and this is the reason.
 * (doc `docs/ISSUE_114_DELIVERY_MIRROR_PLAN.md` §0.2 — the NOT-list.)
 *
 * DEPENDENCY CONTRACT: this file is STRICTLY dependency-free and Node-free — it
 * has no imports at all, not even `node:` built-ins. Two reasons: the client
 * package publishes as a zero-dependency browser-targeted bundle (its tsconfig
 * lib set is `ES2022`/`DOM` with no `@types/node`), and the plugin consumes this
 * same file by cross-package SOURCE import, which only bundles cleanly while the
 * file drags in nothing. Keep it that way.
 *
 * ⚠️ "KEEP IT THAT WAY" IS NOW LOAD-BEARING FOR A SHIPPED ARTIFACT, NOT JUST FOR
 * A TEST. This used to cite `durable-view-reducer-contract.test.ts` as the
 * plugin-side importer, and a broken contract would only have turned a test red.
 * PRODUCTION plugin source imports it now: `packages/plugin/src/journal-history.ts`
 * (value import — it calls `applyDurableEvent`) and
 * `packages/plugin/src/delivery-journal-event.ts` (type-only — `JournalEvent` is
 * a plain alias of `DurableEvent`, so the two are ONE type). Measured: bundling
 * `journal-history.ts` with the plugin build's own flags
 * (`esbuild --bundle --platform=node --format=esm --packages=external`) INLINES
 * this module and leaves no unresolved import, because `--packages=external`
 * externalises bare specifiers only and this is a relative path. #240 half 1
 * gives that module no caller, so the reducer is not in `dist/index-nats.js`
 * YET — half 2's wiring puts it there. A `node:` import added here would then
 * break the plugin's BUNDLE, not merely its test suite.
 *
 * The `seal` transition WAS a line-for-line port of the wrapper's private
 * `applyTurnSnapshot`; that body has since been deleted and the wrapper's method
 * of that name is now only the frame→event mapper that
 * calls it. There is one implementation of the reconciliation, and it is here.
 */

export type DurableRole = "user" | "agent";

/**
 * The durable subset of one delivered message. Client-local fields are excluded.
 *
 * ⚠️ A DISCRIMINATED UNION ON `kind`, NOT ONE RECORD — #242, doc §16.2-5. §15.9's
 * durable set is not one shape: an answer/user bubble has an author (`role`), a
 * reasoning block does not. Widening the single record with an optional `role`
 * was the alternative and is the worse one: every consumer would then have to
 * decide what an absent `role` means at the point it renders, which is exactly
 * the "infer identity from a missing field" habit the v6 redesign exists to
 * remove. A tag makes the two cases impossible to confuse and makes a consumer
 * that forgot one a COMPILE error.
 *
 * ⚠️ THE REASONING VARIANT HAS NO `role`, AND THAT IS NOT AN OVERSIGHT TO FIX.
 * The wire frame carries none (`channel-contract.ts`'s `reasoning` member is
 * `{ id, turnId, text }` plus #242's `final` flag), so any value here would be
 * INVENTED — a fabricated claim inside the SSOT, which is the N8 shape. How a
 * reasoning message renders is half 2's decision, made where the render is.
 *
 * `turnId` is REQUIRED on the reasoning variant and optional on the text one,
 * again following the wire: the `reasoning` frame types `turnId: string`, and
 * the client's `case "reasoning"` DROPS a frame that lacks it, so a reasoning
 * message without a turnId is not a state either side can be in.
 *
 * `readonly` is load-bearing, not decoration: every transition below returns a
 * STRUCTURALLY SHARED view — unchanged entries are the SAME object references as
 * in the input, and some transitions return the input array itself (see the
 * array-identity table in the file header; it is a partial, not a general,
 * property). The client consumer computes `merge(view, overlay)`
 * (`nats-client-wrapper.ts`'s `mergeDurable`), and an in-place overlay
 * write on a shared entry would retroactively mutate a view some other holder
 * already observed. The type makes that a compile error instead of a heisenbug.
 * It does NOT forbid the consumer handing an UNCHANGED bubble back by reference
 * — that is structural sharing, the same discipline this file follows, and the
 * wrapper's suite pins it with `.toBe`.
 */
export type DurableMessage =
  | {
      readonly kind: "text";
      readonly id: string;
      readonly role: DurableRole;
      readonly text: string;
      readonly turnId?: string;
    }
  | {
      readonly kind: "reasoning";
      readonly id: string;
      readonly turnId: string;
      readonly text: string;
    };

/** The `text` variant, named so the transitions that only handle it can say so. */
export type DurableTextMessage = Extract<DurableMessage, { kind: "text" }>;

export type DurableView = readonly DurableMessage[];

/**
 * The index of the TEXT entry holding `id`, or -1.
 *
 * ⚠️ THE `kind` TEST IS WHAT KEEPS A `seal`/`bubble`/`placement` OFF A REASONING
 * BLOCK. `user`, `placement`, `bubble` and `seal` all address ANSWER/USER
 * bubbles by id; `reasoning` addresses reasoning blocks by id, and these guards
 * are what keep the two id spaces from ever meeting.
 *
 * ⚠️ DO NOT ARGUE THIS FROM ID SHAPES — THAT ARGUMENT WAS TRIED AND IS FALSE.
 * An earlier revision said a collision is unarrangeable because reasoning ids
 * come from `nextMessageId()`. Both halves fail: AGENT ANSWER ids come from the
 * SAME `nextMessageId()` (`delivery-journal-event.ts`'s `isUsableMessageId`
 * docblock says so), so the shapes are identical rather than disjoint; and USER
 * ids are CLIENT-SUPPLIED, validated only as a non-empty string within
 * `MAX_INBOUND_USER_ID_LENGTH`, so a peer can send `webchannel-…` verbatim. The
 * conclusion survives, but only because it never depended on the ids.
 *
 * The guards are the whole argument, and they hold whatever an id looks like: a
 * `seal.remove` naming a reasoning id does not delete it, a `bubble` sharing an
 * id does not overwrite it, and `applySeal`'s permutation leaves the reasoning
 * block in its exact slot. Without them a collision would let an answer frame
 * overwrite, or a `seal.remove` DELETE, a delivered reasoning block (N10,
 * content loss); with them the worst case is a duplicated id in the view, which
 * is visible and recoverable. This project's own ordering says a visible
 * duplicate beats a deletion (`message-adapter.ts`'s M212g note). The reducer
 * test file drives both collisions and pins the outcome.
 */
function findTextIndex(view: DurableView, id: string): number {
  return view.findIndex((m) => m.kind === "text" && m.id === id);
}

/**
 * The ordered event stream the plugin would journal. Each event corresponds to a
 * real wire frame the client consumes today — the shapes below were read off
 * `packages/plugin/src/channel-contract.ts` (`OutboundWsMessage`) and the
 * wrapper's `handleFrame` cases (`handleMessage` is the
 * outer entry point, which brackets that switch with the live-turn latch
 * observation and the release gate), and every transition EXCEPT `reasoning` is
 * anchored against the REAL client in `durable-view-reducer.test.ts` (the
 * exception, and why it cannot be anchored in half 1, is in the file header).
 * What that covers is four of the five kinds below; see the two BOUNDARY notes
 * after the type for what it does not.
 *
 *  - `user`      — a local user echo materialized once publication reserves its
 *                  wire id (`nextPublishedUserMessages` in the wrapper). This is
 *                  the durable subset of the u- bubble; an earlier held/deferred
 *                  row is client-local staging and is excluded from the input.
 *  - `placement` — a `progress` frame for a lane (the wrapper's
 *                  `case "progress"`). The FIRST one CLAIMS the lane's
 *                  slot (append at tail). The frame ALWAYS carries text —
 *                  `progress.text` is REQUIRED on the wire
 *                  (channel-contract.ts:66) and the live client renders it —
 *                  but §15.9 CLASSIFIES that rolling "Working…" draft as an
 *                  indicator rather than a message, so this event does not carry
 *                  it and the durable text is authored later by a `bubble` or
 *                  `seal`. The consumer keeps the two apart with the client-local
 *                  `ChatMessage.draftOnly` flag: the draft renders out of `text`,
 *                  while the wrapper's `durableProjection` contributes
 *                  `""` for that bubble. §15.9 is thus enforced at the projection,
 *                  not merely asserted here.
 *                  `turnId` is OPTIONAL because the wire says so
 *                  (channel-contract.ts:66; `NatsChannel.sendProgress` omits it
 *                  when falsy) and the client stores it verbatim. A required one would
 *                  force a consumer to drop such a frame — losing the slot claim,
 *                  i.e. the [A,B]-vs-[B,A] ordering — or to invent a value.
 *  - `bubble`    — a durable agent frame: `agent_message`/final/independent
 *                  (the wrapper's `case "agent_message"`).
 *                  Upsert-by-id: update text in place if the id is held, else
 *                  append at tail.
 *  - `seal`      — the `turn_snapshot` frame (the wrapper's
 *                  `case "turn_snapshot"` → `applyTurnSnapshot`). Carries
 *                  BOTH `answers` and `remove` in one frame, exactly like the
 *                  wire (there is no standalone `remove` wire frame — remove
 *                  exists ONLY inside turn_snapshot, so it is modeled as a `seal`
 *                  field, not a separate event).
 *  - `reasoning` — ONE COMPLETED reasoning burst (#242 half 1, doc §15.9). It
 *                  mirrors the `reasoning` wire frame minus the `final` flag:
 *                  by the time an event exists, `final` is what MADE it an
 *                  event. Upsert-by-id, exactly like `bubble`.
 *
 *                  ⚠️ AN EVENT OF THIS KIND ONLY EXISTS FOR AN ACCOUNT THAT
 *                  OPTED IN (`capabilities.reasoningDurable`, default OFF), so
 *                  a journal with NO reasoning rows is the ordinary case, not
 *                  evidence of a lost write. The gate is at the journaling
 *                  seam, so the live lane is unaffected either way — do not
 *                  infer anything about what the user SAW from what this
 *                  stream contains.
 *
 *                  ⚠️ IT IS NOT ONE FRAME PER EVENT, AND THAT IS THE WHOLE
 *                  DESIGN. `message-adapter.ts`'s `createReasoningDraftController`
 *                  sends a `reasoning` frame for every cumulative update that
 *                  changes the text — an exact repeat is its only no-op, and
 *                  there is no throttle — each carrying the full text so far. One
 *                  event per frame would be O(n²) bytes per burst and would
 *                  multiply journal rows by orders of magnitude into an already
 *                  quadratic replay (#286). So the controller emits ONE extra
 *                  frame at burst close carrying `final: true`, and
 *                  `journalEventForOutbound` records only that one — the same
 *                  draft-versus-durable line §15.9 already draws between
 *                  `progress` and `agent_message`, which reasoning simply had no
 *                  equivalent of.
 *
 * ── BOUNDARY 1: a viewer-minted id must never enter the SHARED event stream ──
 *
 * `bubble.answerId` is mandatory, but the wire can deliver a durable agent frame
 * with NO id. `NatsChannel.sendText` is the ONLY producer of an `agent_message`
 * frame, and it writes `...(id ? { id } : {})`, so the
 * id-less set is exactly the `sendText` callers that pass no `id`.
 *
 * ✅ THAT SET IS NOW EMPTY. #238 landed: all FOUR call sites this note used to
 * enumerate mint at the delivery act — `inbound.ts:1571-1581` (the ordinary
 * visible reply, both branches of the one ternary), `inbound.ts:1626-1631` (the
 * thrown-turn apology), `channel.ts:311` (the generic outbound), and
 * `nats-account-runtime.ts`'s /stop operator-allowlist notice.
 * `message-adapter.ts`'s `message.send.text` handler passes `nextMessageId()` and
 * `NatsChannel.finalizeDraft` requires an `id`, as they always did. The enumeration is kept
 * in the past tense rather than deleted because "the count is four, not three"
 * was itself hard-won: an earlier revision said three and missed the /stop
 * notice, and a survivor would have been INVISIBLE to this module's anchors (an
 * id-less frame has none, by design).
 *
 * The client's id-less branch therefore survives only as a LEGACY-PLUGIN path
 * (`handleFrame`'s `if (id) {…}` branch, whose legacy `else` calls
 * `mintLocalBubbleId("a")` behind a one-shot `console.warn`). It is routed
 * through this reducer as a `bubble`, and that is
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
 *   - `progress` keys on `id ?? ""` (the wrapper's `case "progress"`) — NULLISH, so
 *     `""` SURVIVES as a real id. `placement` with `answerId: ""` is therefore
 *     FAITHFUL;
 *   - `agent_message` branches on `if (id)` — TRUTHY, so `""` falls
 *     into that case's `mintLocalBubbleId("a")` branch and gets a fresh `a-<n>`.
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
 * transition: it blind-appends, mirroring final user materialization, so two
 * `user` events with the same id yield two bubbles. Worse, a duplicated id then
 * makes `applySeal`'s
 * slot refill index `answers[idx]` past the end (`slots.length > answers.length`)
 * and THROW — a pure projection that crashes instead of returning a view.
 *
 * That is a faithful port, not a defect to fix here: the live client threw
 * identically from its own copy of this loop before the rewire, and now throws
 * THROUGH this function (so the test file's "the REAL client throws on the same
 * input" case no longer proves independence — see the anchor caveat in the
 * header). The only difference is reachability — the live client mints every
 * local u-/a- id through `mintLocalBubbleId`, whose monotonic sequence skips ids
 * already present in the transcript, so the precondition cannot be violated by
 * local minting; a journal REPLAY can violate it. Do not "fix" it by making
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
 * ── BOUNDARY 2: five kinds is TODAY'S wire, not the settled model ──
 *
 * Doc §15.9 requires tool and reasoning messages to become DURABLE messages —
 * only pure indicators (the rolling progress draft, the typing flag) stay
 * ephemeral. So this event set will GROW; it already did once, and the rest of
 * the growth is scheduled. #242 half 1 added `reasoning`; TOOL ACTIVITY and the
 * APPROVAL frames are still `null` in `journalEventForOutbound`, marked "#242
 * half 2" there, and are absent here for that reason and no other. Do not read
 * the five kinds as final spec, and do not treat "it isn't in DurableEvent" as
 * evidence that something is non-durable by design (NOT-list N3/N7).
 *
 * ── BOUNDARY 3: the `history` frame is durable but deliberately OUT OF SCOPE ──
 *
 * `channel-contract.ts`'s `OutboundWsMessage` declares
 * `{ type: "history"; messages: … }`, and it
 * genuinely writes `state.messages` today — adoption plus ordered cursor
 * insertion, in the wrapper's `case "history"`. It is nonetheless absent from
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
    }
  | { kind: "reasoning"; id: string; turnId: string; text: string };

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
    case "reasoning":
      return applyReasoning(view, event);
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

/** Final user materialization always APPENDS a fresh u- bubble at the tail. */
function applyUser(
  view: DurableView,
  event: { id: string; text: string; turnId?: string },
): DurableView {
  return [
    ...view,
    { kind: "text", id: event.id, role: "user", text: event.text, turnId: event.turnId },
  ];
}

/**
 * `progress` frame — upsert by id (the shape the wrapper's now-deleted
 * `upsertMessage` had; the mapper is the wrapper's `case "progress"`):
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
 *     (message-adapter.ts:1447-1455, `lane.closed || lane.settled`);
 *   - the provisional-preview path sets `scaffoldWriter = "invalidated"` before
 *     finalizing, so a late preview progress is dropped by `attemptProgress`'s
 *     `preview.scaffoldWriter !== "active"` check.
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
 * `case "progress"`), so the mis-marked bubble is NOT droppable and
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
 * (nats-client-wrapper.ts's `isSpentDraft`) fixes it. Both sides then
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
  const idx = findTextIndex(view, event.answerId);
  const prev = idx === -1 ? undefined : view[idx];
  // `prev.kind !== "text"` CANNOT fire — `findTextIndex`'s predicate already
  // decided it, and TS simply cannot carry a `findIndex` callback's narrowing to
  // the element. It shares this branch rather than standing as its own assertion
  // because both disjuncts say the same thing to this transition: no text entry
  // holds this id, so the placement CLAIMS a fresh slot.
  if (prev === undefined || prev.kind !== "text") {
    return [
      ...view,
      { kind: "text", id: event.answerId, role: "agent", text: "", turnId: event.turnId },
    ];
  }
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
  const idx = findTextIndex(view, event.answerId);
  const prev = idx === -1 ? undefined : view[idx];
  // Same shape and same reason as `applyPlacement`'s: the second disjunct is
  // unreachable and is how TS is told what `findTextIndex` already guaranteed.
  if (prev === undefined || prev.kind !== "text") {
    return [
      ...view,
      { kind: "text", id: event.answerId, role: "agent", text: event.text, turnId: event.turnId },
    ];
  }
  const next = view.slice();
  next[idx] = { ...prev, text: event.text, turnId: event.turnId ?? prev.turnId };
  return next;
}

/**
 * ONE COMPLETED reasoning burst — upsert by id: replace in place if the id is
 * held (keeping its slot), else APPEND at the tail. The append is the SLOT
 * CLAIM, and it is the entire point of routing reasoning through the reducer at
 * all: a reasoning block gets a POSITION in the transcript rather than living in
 * a side list with none.
 *
 * ⚠️ THE POSITION IS WHERE THE EVENT WAS APPENDED, WHICH IS NOT ALWAYS WHERE THE
 * BURST WAS DELIVERED. An earlier revision said "where it was DELIVERED" flatly;
 * that is true for a burst closed by `onReasoningEnd` (the controller's
 * `endBurst`, which runs mid-turn) and FALSE for one still open at turn end.
 * `inbound.ts` drains the answer draft — which emits the `turn_snapshot`, i.e.
 * the `seal` row — and only then calls `reasoning?.stop()` from its `finally`,
 * so a burst that streamed BEFORE the answer but never got a reasoning-end
 * boundary is journaled AFTER the seal and replays at the TAIL, past the turn's
 * answers.
 *
 * Not observable in #242 half 1 (`journal-history.ts` drops reasoning before the
 * wire), and not fixable here — the repair is the ORDER of two calls in
 * `inbound.ts`'s turn teardown, which is half 2's to make. Recorded so the next
 * reader meets it as a known divergence rather than as a reducer bug.
 *
 * A PORT of the client's live `upsertReasoning` (`nats-client-wrapper.ts`),
 * which does the same find-by-id / append-or-replace over `state.reasoning`.
 * The replacement is WHOLESALE (a new object from the event's three fields),
 * not a merge onto the previous entry, because that is what the live method
 * does — `current.map((entry, i) => (i === idx ? item : entry))`.
 *
 * ⚠️ ONE DELIBERATE DIFFERENCE: THE LIVE `.slice(-100)` CAP IS NOT HERE. The
 * client keeps the most recent 100 reasoning items and discards the rest; the
 * durable view keeps all of them. Three reasons, and none of them is an
 * oversight:
 *  - a per-kind cap inside the DURABLE projection silently drops content that
 *    was delivered (N10). A memory bound on a live UI surface and a bound on the
 *    system of record are not the same decision;
 *  - this view is already unbounded for text bubbles, so a cap on one kind only
 *    would be a second, inconsistent bounding opinion about the same array;
 *  - retention/pruning of the journal is #299's job, at the store, where it can
 *    be one policy over everything rather than a number hidden in a transition.
 *
 * ⚠️ SO HALF 1 KNOWINGLY LEAVES A live≠history DIVERGENCE OPEN, AND IT IS
 * BOUNDED. Past 100 reasoning blocks in one conversation the client's live list
 * has dropped the oldest and a replay still has them. It is not reachable
 * through this file today — the client does not feed `reasoning` here at all in
 * half 1, it renders `state.reasoning` directly — so nothing in the client can
 * observe the disagreement yet. Half 2 moves the client onto this reducer, which
 * is what closes it, and it must close it by REMOVING the cap rather than by
 * adding one here. Do not "fix" this by capping.
 *
 * BOTH PATHS ALLOCATE. Like `applyBubble`, this does not detect a no-op: a
 * `reasoning` event repeating its id, turnId and text still returns a new array.
 * That is faithful to the live method (which always allocates) and keeps the
 * header's SAME-array list exhaustive at three rows.
 */
function applyReasoning(
  view: DurableView,
  event: { id: string; turnId: string; text: string },
): DurableView {
  const entry: DurableMessage = {
    kind: "reasoning",
    id: event.id,
    turnId: event.turnId,
    text: event.text,
  };
  // Reasoning blocks are addressed among THEMSELVES — see `findTextIndex`'s
  // docblock for why the two id spaces do not cross-match.
  const idx = view.findIndex((m) => m.kind === "reasoning" && m.id === event.id);
  if (idx === -1) return [...view, entry];
  const next = view.slice();
  next[idx] = entry;
  return next;
}

/**
 * `turn_snapshot` reconciliation — the ONE implementation. The wrapper's
 * `applyTurnSnapshot` is now only the
 * frame→event mapper that feeds this. The contract is EXPLICIT (never a blanket
 * drop):
 *  - `remove` ids are dropped (ANSWER BUBBLES only — a seal never touches a
 *    reasoning block; see step 1's note);
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
  //
  //    ⚠️ EVERY id TEST IN THIS FUNCTION IS GUARDED BY `kind === "text"`. A
  //    `turn_snapshot` reconciles the turn's ANSWER BUBBLES; it says nothing
  //    about reasoning blocks, so neither `remove` nor `answers` may reach one.
  //    Unreachable in practice (the id spaces do not collide — see
  //    `findTextIndex`), and decided in the direction that cannot DELETE
  //    delivered content if it ever were.
  const msgs: DurableMessage[] =
    removeSet.size > 0
      ? view.filter((m) => !(m.kind === "text" && removeSet.has(m.id)))
      : view.slice();

  // 2. Desired answer objects, in authoritative order, reusing any existing
  //    bubble (so a live bubble's fields survive).
  const existingById = new Map<string, DurableTextMessage>();
  for (const m of msgs) if (m.kind === "text") existingById.set(m.id, m);
  const desiredById = new Map<string, DurableMessage>();
  for (const a of answers) {
    const prev = existingById.get(a.id);
    desiredById.set(
      a.id,
      prev
        ? { ...prev, role: "agent", text: a.text, turnId }
        : { kind: "text", id: a.id, role: "agent", text: a.text, turnId },
    );
  }
  const answerIds = new Set(answers.map((a) => a.id));
  const isAnswerSlot = (m: DurableMessage): boolean =>
    m.kind === "text" && answerIds.has(m.id);

  // 3. Give every MINTED (not-yet-present) answer a slot next to its predecessor
  //    answer, so the reorder below is a pure permutation.
  for (let k = 0; k < answers.length; k++) {
    if (existingById.has(answers[k].id)) continue;
    let insertAt = msgs.length;
    if (k > 0) {
      const predIdx = findTextIndex(msgs, answers[k - 1].id);
      insertAt = predIdx === -1 ? msgs.length : predIdx + 1;
    } else {
      const firstAnswer = msgs.findIndex(isAnswerSlot);
      if (firstAnswer !== -1) insertAt = firstAnswer;
    }
    msgs.splice(insertAt, 0, desiredById.get(answers[k].id)!);
  }

  // 4. Refill the answer slots in authoritative order — answer bubbles reorder
  //    among themselves; every non-answer bubble keeps its exact slot.
  const slots: number[] = [];
  msgs.forEach((m, i) => {
    if (isAnswerSlot(m)) slots.push(i);
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
 *
 * ⚠️ IT PRODUCES ONLY `kind: "text"` ENTRIES, AND THAT IS RIGHT FOR HALF 1. Its
 * input is the client's `state.messages` — the CHAT BUBBLE list, which holds no
 * reasoning blocks: the client keeps those in a separate `state.reasoning` array
 * and renders them from there (#242 half 2 is what changes that). So there is
 * nothing here to tag as reasoning, and tagging by guesswork would be the
 * fabrication `DurableMessage`'s docblock refuses.
 */
export function projectDurable(
  messages: Array<{ id: string; role: DurableRole; text: string; turnId?: string }>,
): DurableView {
  return messages.map((m) => ({
    kind: "text",
    id: m.id,
    role: m.role,
    text: m.text,
    turnId: m.turnId,
  }));
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
