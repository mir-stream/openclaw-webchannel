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
 * result back. Each transition has its own EQUIVALENCE ANCHOR in
 * `durable-view-reducer.test.ts`, which drives the REAL `WebChannelNATSClient`
 * with the REAL wire frames and compares against this reducer's output.
 *
 * ✅ `reasoning` NOW HAS AN ANCHOR — #242 half 2 CLOSED THE GAP THIS PARAGRAPH
 * USED TO DESCRIBE. Half 1 made reasoning durable on the SERVER side only: the
 * plugin journaled one row per burst (for an account that opted in —
 * `capabilities.reasoningDurable`, default OFF), this reducer folded it, and
 * `journal-history.ts` replayed it — while the CLIENT still rendered reasoning
 * out of its own `state.reasoning` array and routed no `reasoning` frame here.
 * There was no second implementation to compare against, and `applyReasoning`
 * was a documented PORT of `upsertReasoning` with one deliberate difference (the
 * live `.slice(-100)` cap). Half 2 deleted `upsertReasoning`, routed
 * `case "reasoning"` through `applyDurable`, made `state.reasoning` a DERIVED
 * view of the reasoning entries in `state.messages`, and dropped the cap — so
 * the port is now the implementation, the divergence is closed, and its anchor
 * exists in `durable-view-reducer.test.ts` alongside the rest. #242 half 4 did
 * the same for the two approval transitions, which is why the sentence above
 * no longer carves any transition out.
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
 * allocate. Measured. The FOUR SAME-array rows are EXHAUSTIVE FOR ANY STREAM
 * THAT PREDATES #241 — they are every path a `user`/`placement`/`bubble`/`seal`/
 * `reasoning`/`tool`/`approval`/`approvalResolution` stream can take that returns
 * its input by reference. The NEW-array rows below them are illustrative
 * examples, not an enumeration: allocation is the default here, so any PATH not
 * listed among the first four allocates. (Path, not transition: `placement` and
 * `seal` each have paths on BOTH sides of the divide, even though only `seal`
 * happens to have a row in each section below. `reasoning` has NO path in the
 * first section — see its row.)
 *
 * ⚠️ #241 ADDS MORE by-reference returns, and half 2 CHANGED which of them are
 * dormant. `applyMessageEdited`'s absent-id/stale/tombstone no-ops and
 * `applyMessageDeleted`'s absent-id/stale no-ops are STILL dormant — no producer
 * emits `messageEdited`/`messageDeleted` yet. But the tombstone no-resurrect
 * guards in `applyPlacement`/`applyBubble` (and `applySeal`'s answer filter) are
 * now REACHABLE, because half 2's `applySeal` produces a tombstone from
 * `seal.remove`. So a `placement`/`bubble` naming a seal-removed id returns its
 * input by reference — a same-array path the pre-#241 FOUR did not have. It is
 * unreachable LIVE (the plugin never re-sends a removed id — the lane guards in
 * `message-adapter.ts` and monotonic id minting), so no production stream takes
 * it, but a reducer-level test that constructs the sequence does. The FOUR rows
 * remain exhaustive for a stream with no `seal.remove`; add `seal.remove` and the
 * no-resurrect returns join them.
 *   - `placement`, repeat claim whose turnId resolves unchanged  → SAME array
 *   - `seal`, early return (no valid answers and no removes)     → SAME array
 *   - `seal`, empty/blank turnId early return                    → SAME array
 *   - `approvalResolution` naming an id no approval holds        → SAME array
 *   - `bubble` with identical text and turnId                    → NEW array (e.g.)
 *   - `seal` whose answers change nothing                        → NEW array (e.g.)
 *   - `reasoning` REPEATING its id, turnId and text              → NEW array (e.g.)
 *   - `approval` REPEATING an identical request payload          → NEW array (e.g.)
 * The four illustrative rows ALWAYS allocate (see `applyBubble`, `applySeal`'s
 * tail, `applyReasoning` and `applyApproval` — BOTH paths of each of the latter
 * two allocate, so neither contributes a row to the exhaustive section above);
 * they
 * do not detect no-ops, and teaching them to would be a behavior change this
 * slice does not need. So do NOT build a `prev === next` memo, a
 * `useSyncExternalStore` equality check, or any render skip on array identity —
 * it is sound only as "same ref ⇒ definitely unchanged", never as
 * "different ref ⇒ changed". `durable-view-reducer.test.ts` pins all eight rows
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
 * client consumer constructs events only from wire frames it already handles —
 * since #242 half 4 that is EVERY kind in the union, with no arm left that only
 * the plugin produces — so the ONE surviving path is RUNTIME VERSION SKEW: an
 * older build replaying a journal a newer build wrote. (Stated as a property
 * rather than a count on purpose: this sentence said "FIVE of them" and stayed
 * at five through half 3, which added a sixth. A number here is born
 * stale-able; "every kind" is re-checkable by grepping the wrapper's
 * `applyDurable`/`nextDurableMessages` call sites.)
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
 *     (the wrapper's `handleFrame` still has no `default:`; since #246 half A it
 *     returns `boolean` — "was this frame folded" — so falling off the end is an
 *     explicit `return false`, and that IS its ignore) — REJECTED. That
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
 * event model) and #253 (retain + render unsupported), NOT by this slice. (An
 * earlier revision named #246 here; #246 is the protocol version bump + runtime
 * wire validation, a different issue — `journal-history.ts` carries the same
 * correction. A version gate refuses a peer, it does not render a row.) Do not
 * add a `default` here to silence a reviewer: the absence is deliberate, and this
 * is the reason.
 * (doc `docs/ISSUE_114_DELIVERY_MIRROR_PLAN.md` §0.2 — the NOT-list.)
 *
 * ⚠️ #246's RUNTIME WIRE VALIDATION (half A) HAS LANDED AND DELIBERATELY DID NOT
 * TOUCH THIS SWITCH — so read the ownership line above as naming what is STILL
 * outstanding, not what has not started. What half A added is a second consumer
 * -side guard, in the shape this note prescribes: `inbound-wire-decode.ts`'s
 * `decodeDurableEvent` refuses an out-of-union kind (and a known kind with an
 * unusable shape) at the client's `get_difference` catch-up door, BEFORE the fold
 * — the client-side twin of `journal-history.ts`'s `isKnownJournalEvent`, and for
 * the same reason. It does not make the union expressive: a skipped row is still
 * a row nothing renders, so "retain + render as unsupported" remains unbuilt and
 * still needs #241's typed event model to say it.
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
 * externalises bare specifiers only and this is a relative path.
 *
 * ⚠️ AND IT IS IN THE SHIPPED BUNDLE NOW — THIS SENTENCE USED TO SAY "YET". It
 * read "#240 half 1 gives that module no caller, so the reducer is not in
 * `dist/index-nats.js` YET — half 2's wiring puts it there." Half 2 landed, and
 * the wiring is real: `index-nats.ts` → `nats-account-runtime.ts` →
 * `history-serve.ts` → `journal-history.ts` → this module, all production
 * source. MEASURED after `npm run build -w packages/plugin`:
 * `grep -c "applyReasoning\|projectJournalHistory" dist/index-nats.js` → 5.
 * So a `node:` import added here does not "then" break the plugin's bundle at
 * some future wiring step — it breaks the SHIPPED artifact today, not merely
 * the test suite.
 *
 * The `seal` transition WAS a line-for-line port of the wrapper's private
 * `applyTurnSnapshot`; that body has since been deleted and the wrapper's method
 * of that name is now only the frame→event mapper that
 * calls it. There is one implementation of the reconciliation, and it is here.
 */

export type DurableRole = "user" | "agent";

/**
 * The decision a native HITL approval can carry (#242 half 4).
 *
 * ⚠️ DECLARED HERE RATHER THAN IMPORTED, and that is the DEPENDENCY CONTRACT in
 * the header doing its job, not duplication for its own sake: this file has no
 * imports at all, so it may name neither `types.ts`'s `ApprovalDecision` nor the
 * plugin's. All three are the same three string literals, so every value is
 * assignable across them and tsc checks the agreement at each boundary the two
 * meet (the wrapper's handlers, the plugin's mapper).
 *
 * ⚠️ `"unknown"` IS DELIBERATELY NOT A MEMBER. The client has a resolution
 * SENTINEL of that name (#15 — "decided or expired while this device wasn't
 * looking"), and it is a LIVE-ONLY reconciliation outcome produced by
 * `approval_snapshot`'s Leg B, never a decision anybody made. Nothing can
 * journal it: the only producer of a resolution event is the
 * `approval_resolved` wire frame, whose `decision` is a real verdict. Admitting
 * it here would let a replay serve a resolution that never happened.
 */
export type DurableApprovalDecision = "allow-once" | "allow-always" | "deny";

/** One offered approval button, exactly as the request frame carries it. */
export type DurableApprovalOption = {
  readonly decision: DurableApprovalDecision;
  readonly label: string;
  readonly style: string;
};

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
 * INVENTED — a fabricated claim inside the SSOT, which is the N8 shape.
 *
 * ✅ HALF 2 MADE THE SAME CHOICE AT BOTH OF THE OTHER TWO LAYERS, and the
 * absence turned out to be load-bearing rather than merely honest:
 * `channel-contract.ts`'s `HistoryMessage` and the client's `ChatMessage` are
 * both tagged unions whose reasoning variant carries no `role` either — and it
 * is precisely a missing `role` that makes every RELEASED client drop the new
 * history row instead of rendering it as an answer bubble. That measurement is
 * in `channel-contract.ts`; do not re-derive it here.
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
      /**
       * MONOTONIC per-message revision (#241 half 1, doc §16.2-4). ABSENT ⇒ treat
       * as 0 (the base creation): every entry the four legacy transitions
       * (`user`/`placement`/`bubble`/`seal`) produce omits it, so those streams
       * stay byte-identical and their anchors stay green. Only a `messageEdited`
       * or `messageDeleted` event writes it, and only when it DOMINATES — strictly
       * greater than the entry's current revision — which is what makes a stale
       * revision a no-op (§16.2-4 "stale revision 거부") rather than a clobber.
       */
      readonly revision?: number;
      /**
       * The "edited" marker (#241 half 1, doc §16.2-4). Set ONLY by a dominant
       * `messageEdited`; absent everywhere else. It is dormant in half 1 — no
       * producer emits `messageEdited` yet, so no live entry ever carries it — and
       * half 2 renders it. A consumer must read `=== true`, never truthiness, so
       * the absent case reads as "not edited".
       */
      readonly edited?: boolean;
      /**
       * The TOMBSTONE marker for a permanent typed delete (#241, doc §16.2-3). A
       * `messageDeleted` replaces the entry IN PLACE with a tombstone
       * (`text: ""`, `deleted: true`) that stays in the array at its slot — the
       * fold RETAINS it so a later same-id event can see it and refuse to
       * resurrect it (order-sensitive revive is gone; restore is a new id or an
       * explicit restore per §16.2-3). ⚠️ SINCE HALF 2 the tombstone also has a
       * SECOND producer: `applySeal`'s `remove` writes exactly this shape in place
       * (a `messageDeleted` is the future third one, still dormant). So a tombstone
       * DOES exist on a live stream now — but the no-resurrect GUARDS below still
       * fire only in a constructed whole-log fold, because egress emits no later
       * same-id event after a `seal.remove` (id non-reuse + terminal-drain
       * snapshot); the server's full replay is the side they protect (#329 tracks
       * making the client's no-resurrect structural). Both consumers STRIP
       * `deleted === true` at render/serve, so a tombstone never renders. Read
       * `=== true`.
       */
      readonly deleted?: boolean;
    }
  | {
      readonly kind: "reasoning";
      readonly id: string;
      readonly turnId: string;
      readonly text: string;
    }
  /**
   * ONE TOOL CALL, MERGED (#242 half 3, doc §15.9).
   *
   * ⚠️ THIS IS THE MERGE RESULT, WHILE THE `tool` EVENT IS A DELTA — the only
   * place in this union where the message shape and its event shape differ in
   * meaning rather than only in field names, so it is stated here rather than
   * left to `applyTool`.
   *
   * MEASURED, not assumed (the producer is `inbound.ts`'s
   * `createAgentToolActivitySink`; the sequence below was recorded by driving it
   * with a `start`/`update`/`end` event triple on the `tool` stream):
   *
   *   {turnId, id, name:"read_file", phase:"start", argKeys:["path","limit"]}
   *   {turnId, id, phase:"update"}
   *   {turnId, id, phase:"end", status:"completed"}
   *
   * The CLOSING frame carries neither `name` nor `argKeys` — `argKeys` is
   * emitted only on a NON-terminal frame and `status` only on a terminal one.
   * So the `final`-flag device that makes `reasoning` one row per burst CANNOT
   * be reused here: journaling only the closing frame would durably record a
   * nameless, argKey-less tool call while live rendered "read_file(path,
   * limit)". That is N8 live≠history, and it is why the durable ROW is the fold
   * of every frame rather than any one of them.
   *
   * ⚠️ NO `role`, for the same reason `reasoning` has none: the wire carries no
   * author and this type refuses to invent one.
   *
   * `argKeys` is `readonly string[]` and holds ARGUMENT KEY NAMES ONLY — never
   * arg values. That boundary is enforced at the producer (`Object.keys(args)`)
   * and again where the wire is read; it must survive to disk unchanged.
   */
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly turnId: string;
      readonly name?: string;
      readonly phase?: string;
      readonly status?: string;
      readonly summary?: string;
      readonly argKeys?: readonly string[];
    }
  /**
   * ONE NATIVE HITL APPROVAL CARD, WITH ITS STATE (#242 half 4, doc §15.9).
   *
   * ⚠️ THIS IS THE FOLD OF **TWO** EVENTS, AND THAT IS THE WHOLE SLICE. An
   * approval is the first durable message whose content changes by a USER
   * ACTION rather than by a delivery revision, which is why it was deferred out
   * of half 3 as "#241 revision territory". It is not: the request and the
   * resolution are journaled as TWO APPEND-ONLY EVENTS (`approval`,
   * `approvalResolution`) and folded into this one message, exactly the shape
   * `seal` already has against `bubble`. No row is ever edited, so there is no
   * mutation model to invent and #241 is not a prerequisite.
   *
   * ⚠️ THE DURABLE STATE IS `pending | resolved(decision)` — THERE IS NO
   * `expired`, AND THERE MUST NOT BE. `expiresAtMs` is journaled because the
   * request frame carries it (`channel-contract.ts`'s
   * `ApprovalRequestPayload`), but "is it expired" is a comparison against the
   * WALL CLOCK and this module's PURITY CONTRACT forbids a clock. Expiredness is
   * therefore computed at RENDER, from `expiresAtMs`, by whoever draws the card.
   * Do not add an `expired` event and do not read a clock here: an expiry that
   * was folded at replay time would make the same journal project differently on
   * two reads, which is the one property `history == live` cannot survive.
   *
   * Note core resolves an EXPIRED approval as a real `deny` on the wire
   * (`approvals.ts`'s `buildExpiredResult` returns
   * `{kind:"update", payload:{decision:"deny"}}`), so an approval that timed out
   * server-side arrives here as an ordinary resolution and needs none of the
   * above. The clock question is only about a card whose deadline passed with no
   * frame at all.
   *
   * ⚠️ NO `role`, for the reason the reasoning and tool arms give: the wire
   * carries no author and this type refuses to invent one.
   *
   * ⚠️ THE PAYLOAD'S OWN `kind` FIELD IS CARRIED AS `approvalKind`. The wire
   * calls it `kind` (`"exec" | "plugin"`), which is the same name this union
   * uses as its DISCRIMINANT. Renaming it here is not cosmetic — carrying it
   * verbatim would make the two meanings collide on one key and the union
   * undiscriminable. The rename is repeated identically at the wire history row
   * and the client entry so all three agree.
   */
  | {
      readonly kind: "approval";
      readonly id: string;
      readonly approvalKind: "exec" | "plugin";
      readonly title: string;
      readonly description?: string;
      readonly prompt: string;
      readonly options: readonly DurableApprovalOption[];
      readonly expiresAtMs?: number;
      /**
       * The SERVER-CONFIRMED decision, folded from an `approvalResolution`
       * event. Absent means the card is still pending AS THIS STREAM RECORDS IT
       * — which is NOT the same as "still actionable"; see the client entry's
       * `actionable` for why a replayed pending card must never be clickable.
       */
      readonly resolvedDecision?: DurableApprovalDecision;
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
 * are what keep the two id spaces from meeting IN THE VIEW.
 *
 * ⚠️ "IN THE VIEW" IS THE WHOLE SCOPE OF THAT CLAIM. The two spaces DO meet one
 * layer out, in `journal-history.ts`'s `firstSeenMs`, which is keyed by id
 * across every kind and is first-write-wins — so a reasoning burst id colliding
 * with a later user id would hand the earlier `ts` to the bubble. That is
 * bounded, not broken, and `recordFirstSeen`'s docblock is where the bound is
 * argued (`ts` is hydration metadata; nothing orders on it). Cited here so the
 * enumeration below is not read as covering the whole system.
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
 * observation and the release gate), and EVERY transition below — with no arm
 * excepted, `reasoning` since #242 half 2 gave the client a `reasoning` consumer
 * to anchor against and the two approval arms since half 4 — is anchored against
 * the REAL client in `durable-view-reducer.test.ts`. See the two BOUNDARY notes
 * after the type for what that does NOT cover.
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
 * ── BOUNDARY 2: today's wire is not, by itself, the settled model ──
 *
 * Doc §15.9 requires every MESSAGE to become durable and leaves only pure
 * INDICATORS ephemeral (the rolling progress draft, the typing flag). So this
 * event set GREW, once per #242 slice: half 1 added `reasoning` and half 2 gave
 * it a CLIENT consumer; half 3 added `tool` and moved the client's live tool
 * surface onto this reducer; half 4 added `approval` + `approvalResolution` and
 * did the same for the approval surface.
 *
 * ✅ THAT COMPLETES §15.9'S LIST, AND THE PARAGRAPH THAT USED TO SIT HERE IS
 * RETRACTED RATHER THAN DELETED, BECAUSE ITS ARGUMENT WAS WRONG AND WILL BE
 * RE-DERIVED OTHERWISE. It read: the approval frames stay out because an
 * approval is BIDIRECTIONAL, so resolution changes a durable message's content
 * by a USER ACTION rather than a delivery revision, which is **#241**'s typed
 * edit/revision territory. The premise is true and the conclusion does not
 * follow. Nothing is edited: the request and the resolution are TWO APPEND-ONLY
 * EVENTS folded into one message, the same relationship `seal` already has to
 * `bubble`. #241 was never a prerequisite.
 *
 * `notice` needed no event of its own and never did — a notice, a route apology
 * and the `/stop` notice all go out through `NatsChannel.sendText` carrying a
 * minted id, so the mapper's `agent_message` branch has journaled them as
 * `bubble`s since #239. `approval_snapshot` is `null` PERMANENTLY (see its case
 * in the mapper): it is a replay of state this store already holds, not a
 * message.
 *
 * The list being complete is NOT a licence to read this union as closed. Do not
 * treat "it isn't in `DurableEvent`" as evidence that something is non-durable
 * by design (NOT-list N3/N7) — that inference was wrong for tool, for reasoning
 * and for approvals in turn.
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
  /**
   * ⚠️ `randomId` (#337) is CARRIED, NOT REDUCED. It is the client-minted
   * `random_id` of the send this user final echoes, present only when the row was
   * journaled with one (`appendInboundUser` writes it into the payload). The
   * reducer NEVER reads it — `applyUser` folds by `id` alone, so `history == live`
   * is unaffected by its presence or absence. It exists for ONE consumer: the
   * wrapper's `get_difference` fold, which re-keys an un-adopted optimistic user
   * bubble onto this event's server `id` by matching `randomId` (the same
   * correlation the ack's `adoptCommittedIds` uses) BEFORE folding, so a
   * re-delivered user event no-ops instead of appending a second bubble. Absent on
   * an older row / an older client's send ⇒ the fold falls back to append (safe).
   */
  | { kind: "user"; id: string; text: string; turnId?: string; randomId?: string }
  | { kind: "placement"; answerId: string; turnId?: string }
  | { kind: "bubble"; answerId: string; text: string; turnId?: string }
  | {
      kind: "seal";
      turnId: string;
      answers: Array<{ id: string; text: string }>;
      remove?: string[];
    }
  | { kind: "reasoning"; id: string; turnId: string; text: string }
  /**
   * ONE `tool_activity` WIRE FRAME, VERBATIM — a DELTA, not a snapshot
   * (#242 half 3).
   *
   * ⚠️ EVERY FRAME IS JOURNALED, AND THE FOLD DOES THE MERGING. That is the one
   * design decision in this slice, and it is the OPPOSITE of `reasoning`'s. See
   * `DurableMessage`'s tool arm for the MEASURED frame sequence that forces it:
   * the closing frame carries neither `name` nor `argKeys`, so there is no
   * single self-contained frame a `final`-style flag could pick.
   *
   * ⚠️ WHY THE DELTA AND NOT A SERVER-MERGED SNAPSHOT. Merging at the journaling
   * seam would put a per-`(turnId,id)` accumulator in the plugin and make the
   * stored row a PROJECTION the seam computed — a second implementation of a
   * merge the live client also performs, free to drift from it. That is exactly
   * what N8 and this file's one-reducer bet forbid, and it is why `JournalEvent`
   * is an ALIAS of this type rather than a mirror. Journaling the frame keeps the
   * seam stateless and leaves `applyTool` the ONLY merge in the system, so
   * `history == live` holds by construction rather than by two pieces of code
   * agreeing.
   *
   * ⚠️ THE COST IS ROW COUNT, AND IT IS REAL. One tool call writes one row PER
   * FRAME (three in the measured triple) instead of one, and a chatty tool
   * emitting many `update` frames writes one row each. Each row is SMALL IN
   * PRACTICE — a tool name, a phase, a status, key names, and a count-grammar
   * summary — which is far from the O(n²) BYTES that `final` exists to prevent
   * for reasoning (there every frame carried the whole cumulative text).
   *
   * ⚠️ "SMALL IN PRACTICE", NOT "O(1) BYTES" — THIS PARAGRAPH USED TO CLAIM THE
   * LATTER AND IT WAS AN ASSUMPTION, NOT AN ENFORCED PROPERTY. Checked against
   * the producer: NOTHING caps `argKeys`'s key COUNT or key LENGTH — not
   * `inbound.ts`'s `Object.keys(args)`, not `sendToolActivity`, not the journal
   * mapper. A tool invoked with many or long argument names writes proportionally
   * larger rows (**#321**). Two neighbouring claims were wrong for the
   * same reason and are gone with it: `phase` is validated on the `tool`/`item`
   * streams only, and `status` is a producer PASS-THROUGH. What IS enforced —
   * and what carries the no-separate-opt-in decision — is that `argKeys` holds
   * argument KEY NAMES ONLY, never values.
   *
   * It still feeds the quadratic replay fold tracked by **#286**, and it adds
   * another content class to the ROW-bounded (not byte-bounded) history page
   * tracked by **#311**.
   *
   * Fields other than `id`/`turnId` are OPTIONAL and must be ABSENT KEYS when
   * the frame omitted them, never `undefined` values — `applyTool` merges by
   * spread, so a present-and-`undefined` key would ERASE a field learned at
   * `start`.
   */
  | {
      kind: "tool";
      id: string;
      turnId: string;
      name?: string;
      phase?: string;
      status?: string;
      summary?: string;
      argKeys?: readonly string[];
    }
  /**
   * ONE `approval_request` WIRE FRAME (#242 half 4) — the card's CONTENT.
   *
   * Upsert-by-id, exactly like `bubble`, with one addition `applyApproval`
   * carries: a re-delivered request NEVER clobbers a resolution already folded
   * onto the card. That is the durable twin of the client's #15 upsert-preserve,
   * and it is needed for the same reason — the register path can re-deliver a
   * prompt after it was decided.
   */
  | {
      kind: "approval";
      id: string;
      approvalKind: "exec" | "plugin";
      title: string;
      description?: string;
      prompt: string;
      options: readonly DurableApprovalOption[];
      expiresAtMs?: number;
    }
  /**
   * ONE `approval_resolved` WIRE FRAME (#242 half 4) — the card's STATE CHANGE.
   *
   * ⚠️ A SECOND APPEND-ONLY EVENT, NOT AN EDIT OF THE FIRST, AND THAT IS THE
   * DESIGN. The alternative — one `approval` row rewritten in place when the
   * user decides — is a REVISION, needs #241's typed mutation model, and breaks
   * the store's append-only property (§15.9's rejected alternative (a) for
   * reasoning makes the same argument for the same reason: a mutable payload
   * destroys "seq = the moment this content was authored"). Two events folded by
   * one transition is the shape `seal` already uses against `bubble`, so nothing
   * new had to be invented and #241 is not a prerequisite for this slice.
   *
   * ⚠️ IT CARRIES NO CONTENT OF ITS OWN. A resolution naming an id no approval
   * in the view holds is a NO-OP that returns the view by reference — see
   * `applyApprovalResolution` for why appending a contentless card instead would
   * be inventing a message.
   */
  | { kind: "approvalResolution"; id: string; decision: DurableApprovalDecision }
  /**
   * REVISION-DOMINANT TEXT EDIT of an existing text message (#241 half 1, doc
   * §15.3, §16.2-4). This is the typed replacement for the old untyped
   * last-write-wins overwrite: an edit no longer wins because it arrived later,
   * it wins because its `revision` DOMINATES (`> (msg.revision ?? 0)`). A stale
   * or equal revision is rejected. See `applyMessageEdited`.
   *
   * ⚠️ NOT A CREATE. There is deliberately no `messageCreated` event — creation
   * stays via the existing `user`/`bubble` append paths (§15.3's 4-kind model,
   * EXTENDED not replaced), so `messageEdited` naming an id no text message holds
   * is a NO-OP, never a create-or-update. A create-or-update here would resurrect
   * a tombstoned id and defeat the permanent typed delete this slice introduces.
   *
   * ⚠️ DORMANT IN HALF 1. No producer constructs this event yet: the egress
   * mapper (`journalEventForOutbound`) switches over WIRE FRAME types, and no
   * frame maps to it. The model and its transitions exist and are unit-tested;
   * the producer/consumer cutover (egress emitting typed edits, the client
   * rendering the "edited" marker) is half 2. So every existing event stream
   * projects byte-identically, which is the whole point of the split.
   */
  | { kind: "messageEdited"; id: string; text: string; revision: number; turnId?: string }
  /**
   * PERMANENT TYPED DELETE of an existing text message (#241 half 1, doc §15.3,
   * §16.2-3). This replaces the order-sensitive `seal.remove`-then-late-`bubble`
   * REVIVE with a revision-dominant tombstone that NEVER resurrects: a later
   * same-id `bubble`/`placement`/`seal.answers` is refused, and restore is a new
   * id or an explicit restore (§16.2-3), not an accidental re-append. See
   * `applyMessageDeleted` for the tombstone, and the no-resurrect guards in
   * `applyBubble`/`applyPlacement`/`applySeal`.
   *
   * Like `messageEdited`, a delete naming an absent id is a NO-OP (seq ordering
   * guarantees the create preceded), and this event is DORMANT in half 1 — no
   * producer emits it, so no tombstone can exist and the guards are unreachable
   * for every existing stream.
   */
  | { kind: "messageDeleted"; id: string; revision: number; turnId?: string };

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
    case "tool":
      return applyTool(view, event);
    case "approval":
      return applyApproval(view, event);
    case "approvalResolution":
      return applyApprovalResolution(view, event);
    case "messageEdited":
      return applyMessageEdited(view, event);
    case "messageDeleted":
      return applyMessageDeleted(view, event);
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

/**
 * Final user materialization — APPEND a fresh u- bubble at the tail, unless the id
 * is already held, in which case NO-OP (return the input by reference).
 *
 * ⚠️ id-IDEMPOTENT, AND THAT IS A CONTRACT, NOT A NICETY (#244 half B). A `user`
 * event can be folded MORE THAN ONCE: a `get_difference` catch-up ships raw journal
 * events, and a re-delivered/overlapping `difference` (a retry double-reply, a
 * stale reply landing after a heal) would re-fold this event. Appending
 * unconditionally then duplicates the user bubble — a user final is IMMUTABLE, so
 * a second copy is pure corruption, and it is the exact "folds as a no-op by id"
 * guarantee the wrapper's ack-path docblock relies on. Every other durable fold
 * (`bubble`/`placement`/`tool`/`approval`/`seal`) already dedups by id; this one
 * did not, and that was the one non-idempotent arm.
 *
 * The whole-log `reduceDurableView` is unaffected: a journal never holds two rows
 * under one user id (the id is minted with the seq, uniquely), so "no-op when
 * present" can never wrongly drop a distinct message there. Text is deliberately
 * NOT updated on an existing id — a user final does not change, so no-op is the
 * contract (mirrors `applyPlacement`'s durable no-op return-by-reference).
 */
function applyUser(
  view: DurableView,
  event: { id: string; text: string; turnId?: string },
): DurableView {
  if (findTextIndex(view, event.id) !== -1) return view;
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
  // ⚠️ NO-RESURRECT (#241, doc §16.2-3). A placement claiming a slot for a
  // TOMBSTONED id must not revive it — the delete is permanent, so this is a
  // no-op returning the input by reference. Half 2's `applySeal` produces the
  // tombstone this guards against, but the guard itself FIRES only in a
  // constructed whole-log fold — never in production nor on the incremental
  // client, because egress emits no `progress`/`bubble` for a `seal.remove`d id
  // after its snapshot (see the file header at the array-identity table: id
  // non-reuse + terminal-drain snapshot). It is stated as `deleted === true`
  // (not truthiness) so only an actual tombstone trips it.
  if (prev !== undefined && prev.kind === "text" && prev.deleted === true) return view;
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
 * (keeping its claimed slot), else APPEND at the tail. Before #241 this was what
 * made remove-then-late-readd RESURRECT (order-sensitive): a `seal` remove
 * dropped the id and a LATER `bubble` re-appended it. #241 replaced that with
 * permanent tombstone dominance — `seal.remove` now TOMBSTONES in place and the
 * no-resurrect guard below refuses to overwrite or re-append a tombstoned id, so
 * `[bubble X, seal(remove X), bubble X]` leaves X a tombstone, not resurrected
 * (doc §16.2-3; restore is a new id or an explicit restore).
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
  // ⚠️ NO-RESURRECT (#241, doc §16.2-3). This is the transition the old
  // order-sensitive revive lived on: a `seal.remove` dropped an id and a LATER
  // `bubble` re-appended it. A tombstone replaces that — a `bubble` whose id
  // resolves to a tombstone must neither overwrite the tombstone (update branch)
  // nor append a duplicate (append branch), so it is a no-op here, BEFORE either.
  // This is what makes `[bubble X, seal(remove X), bubble X]` leave X tombstoned
  // — but that sequence is reachable only in a constructed whole-log fold: in
  // production and on the incremental client, egress emits no `bubble` for a
  // `seal.remove`d id after its snapshot, so this guard never fires there (the
  // server's full replay is the side the tombstone actually protects). #329
  // tracks making the client's no-resurrect structural rather than egress-reliant.
  if (prev !== undefined && prev.kind === "text" && prev.deleted === true) return view;
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
 * BURST WAS DELIVERED. Live, this transition appends on the burst's FIRST
 * delivered frame and the slot never moves afterwards; in a REPLAY the burst has
 * exactly one row, written when it CLOSED. So:
 *
 *   live and replay agree for a burst IFF no `placement` or `bubble` row is
 *   journaled BETWEEN that burst's first delivered frame and its closing frame.
 *
 * ⚠️ DO NOT RE-DERIVE THAT AS "safe if closed by `endBurst`, broken if closed at
 * turn end". Two revisions of this docblock said exactly that and it is a false
 * universal in both directions — `endBurst` establishes nothing about
 * interleaving, and both `pushDurableBlock` branches are burst-closing points it
 * omits. `journal-history.ts`'s conversion loop (GAP 2b) is the CANONICAL
 * statement and carries the frame-level counterexample; this line points there
 * on purpose rather than keeping another copy that can drift. (It said "a FOURTH
 * copy" while `journal-history.ts` said "the other THREE sites" — two counts
 * that already disagreed, over a term that appears in ten files. Neither number
 * was load-bearing; both are gone.)
 *
 * ⚠️ AND THE FIX THIS BLOCK USED TO PROMISE — "the ORDER of two calls in
 * `inbound.ts`'s turn teardown, which is half 2's to make" — DOES NOT WORK.
 * Half 2 checked it and did not make the change: hoisting `reasoning?.stop()`
 * above `await draft?.drain()` moves the row before the `seal`, but the lane's
 * `placement`/`bubble` rows were journaled while it was STREAMING, long before
 * either call, so the block still replays after the turn's answers — and
 * `applySeal` deliberately leaves every non-answer slot where it is. The old
 * sentence was true about the seal and read as if it covered the answers.
 * `journal-history.ts`'s conversion loop (GAP 2b) now owns the statement of this
 * divergence; it is recorded there because that is where a reader meets it.
 *
 * ✅ FORMERLY A PORT, NOW THE IMPLEMENTATION. Through #242 half 1 this was a
 * documented port of the client's live `upsertReasoning`, which did the same
 * find-by-id / append-or-replace over a separate `state.reasoning` array. Half 2
 * DELETED that method: `case "reasoning"` builds a `DurableEvent` and routes it
 * through `applyDurable` like every other durable frame, and `state.reasoning`
 * is a derived view of the reasoning entries in `state.messages`. The wholesale
 * replacement below (a new object from the event's three fields rather than a
 * merge onto the previous entry) is retained from that port and is now simply
 * what the client does.
 *
 * ✅ THE `.slice(-100)` CAP IS GONE FROM THE CLIENT, so the ONE deliberate
 * difference this block used to record no longer exists. It said: the live list
 * kept the most recent 100 reasoning items while the durable view kept all of
 * them, leaving a bounded live≠history divergence for half 2 to close "either by
 * REMOVING the client cap, or by bounding BOTH sides at the store". Half 2 took
 * the first option. The three reasons a cap must not be added HERE are unchanged
 * and still binding:
 *  - a per-kind cap inside the DURABLE projection silently drops content that
 *    was delivered (N10). A memory bound on a live UI surface and a bound on the
 *    system of record are not the same decision;
 *  - this view is already unbounded for text bubbles, so a cap on one kind only
 *    would be a second, inconsistent bounding opinion about the same array;
 *  - retention/pruning of the journal is #299's job, at the store, where it can
 *    be one policy over everything rather than a number hidden in a transition.
 * Do not "fix" the now-unbounded live list by capping — not here, and not in the
 * wrapper's derivation either; that would re-open the divergence in the exact
 * shape half 2 closed.
 *
 * ⚠️ AND STATE THE TRADE HONESTLY, BECAUSE THE JUSTIFICATION ABOVE IS CONDITIONAL
 * AND THE COST IS NOT. Removing the cap closes a live≠history divergence ONLY
 * where a durable view exists to disagree with — and `capabilities.reasoningDurable`
 * DEFAULTS OFF, so on a default deployment nothing is journaled, there is no
 * replay to differ from, and the removal closes nothing at all. What it does
 * unconditionally is make `state.messages` accumulate every reasoning burst of
 * the session, where a 100-item cap previously bounded them — and every durable
 * frame pays an O(messages) projection and merge over that array, so the cost is
 * super-linear in session length, not merely a memory number.
 *
 * That is accepted rather than hidden, for one reason: a cap that exists only
 * when durability is OFF is TWO behaviours for one view, selected by a server-
 * side setting the client cannot see — the same divergence class, reintroduced
 * from the other side and harder to observe. A client-side retention policy that
 * applies uniformly is the real answer, it is the twin of #299 (which owns the
 * server side), and it is not this slice's.
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
 * MERGE one tool-activity frame onto the call it refines (#242 half 3).
 *
 * ⚠️ THE KEY IS THE COMPOSITE `(turnId, id)`, NOT `id` ALONE. `inbound.ts`'s
 * `correlatedId` derives the id from core's `itemId`/`toolCallId`/`name` within
 * ONE RUN, so it is unique per turn but carries no cross-turn guarantee; the
 * live client has always keyed this surface the same way (the
 * `upsertToolActivity` this slice DELETED from `nats-client-wrapper.ts` matched
 * on `entry.turnId === item.turnId && entry.id === item.id`), and this fold —
 * now the only one — must key it identically or live and history disagree the
 * first time a run reuses an id.
 *
 * ⚠️ AND THE `kind` TEST KEEPS TOOL IDS OUT OF THE OTHER TWO ID SPACES, exactly
 * as `findTextIndex` and `applyReasoning` do for theirs. A tool id colliding
 * with a bubble or a reasoning id therefore costs a duplicated id in the view —
 * visible and recoverable — rather than one message overwriting the other
 * (N10). See `findTextIndex`'s docblock for why the spaces cannot be ASSUMED
 * disjoint; the argument there does not depend on id shapes and neither does
 * this one.
 *
 * ⚠️ THE SPREAD IS THE WHOLE TRANSITION, AND IT IS DIRECTIONAL. `{...prev,
 * ...event}` lets a later frame REFINE the call — adding `status` at the end —
 * while keeping the `name` and `argKeys` only the `start` frame carried. Written
 * the other way round a `start` frame arriving late would erase the outcome. The
 * `kind` key is re-stated after the spread because `event.kind` is `"tool"`
 * either way but `event` also carries no `ts`-style client fields; restating it
 * keeps the result a well-formed `DurableMessage` rather than relying on the
 * event's own tag surviving the spread.
 *
 * ⚠️ `event` MUST NOT CARRY `undefined` VALUES — see the event type. A
 * present-and-`undefined` `name` would spread over a learned one and blank it.
 * The two producers both build with `...(x !== undefined ? {x} : {})`.
 *
 * ⚠️ THE MERGE KEY `(turnId, id)` INHERITS `turnId`'s PEER-CONTROLLED PROVENANCE.
 * `turnId` is the inbound `message.id` off the wire (`inbound.ts` fallback only
 * mints one when absent), validated as shape only. A peer that reuses one
 * `message.id` outside the accept seam's windowed dedupe (#275) produces two
 * genuinely distinct tool calls sharing a `(turnId, id)`, and this upsert then
 * MERGES them into one row (last-write-wins across the spread) — silent content
 * loss confined to that peer's own conversation. This is a KNOWN, ACCEPTED
 * limitation tracked in #323; the real fix is server-minted turn ids (#243).
 * Do not treat this pair as globally unique — it is unique in the projection
 * only, because the projection achieved uniqueness by destroying a distinction.
 */
function applyTool(
  view: DurableView,
  event: {
    id: string;
    turnId: string;
    name?: string;
    phase?: string;
    status?: string;
    summary?: string;
    argKeys?: readonly string[];
  },
): DurableView {
  const idx = view.findIndex(
    (m) => m.kind === "tool" && m.id === event.id && m.turnId === event.turnId,
  );
  if (idx === -1) {
    return [...view, { ...event, kind: "tool" }];
  }
  const next = view.slice();
  next[idx] = { ...next[idx], ...event, kind: "tool" };
  return next;
}

/**
 * The index of the APPROVAL entry holding `id`, or -1.
 *
 * ⚠️ THE `kind` TEST IS WHAT KEEPS THE APPROVAL ID SPACE SEPARATE, exactly as
 * `findTextIndex` does for bubbles and `applyReasoning`/`applyTool` do for
 * theirs. An approval id is core's `approvalId` (`approvals.ts`'s
 * `buildApprovalRequestPayload` copies `view.approvalId` verbatim), so it is
 * minted by a DIFFERENT producer from every other id in this view — which is
 * exactly why the disjointness must not be assumed. See `findTextIndex`'s
 * docblock: the id-shape argument was tried for the other kinds and retracted,
 * and the guards are the whole argument for all of them.
 *
 * Keyed by `id` ALONE, not by a pair. Unlike `tool`, whose producer id is unique
 * only within a run, an approval id is the gateway's own approval identifier and
 * is what the client sends back on `approval_decision`; keying it by anything
 * else would make the durable card unaddressable by the id the reverse leg uses.
 */
function findApprovalIndex(view: DurableView, id: string): number {
  return view.findIndex((m) => m.kind === "approval" && m.id === id);
}

/**
 * `approval_request` — upsert by id: replace the payload in place if the id is
 * held (keeping its slot), else APPEND at the tail. The append is the SLOT
 * CLAIM, and it is why an approval belongs in the transcript at all: the card
 * gets a POSITION between the messages it interrupted, rather than living in a
 * side list beside them.
 *
 * ⚠️ A RE-DELIVERED REQUEST MUST NOT RESURRECT A DECIDED CARD. `resolvedDecision`
 * is carried over from the entry being replaced, and the reason is not
 * hypothetical: the client has had this exact rule since #15 (its
 * `case "approval_request"` calls it "upsert-preserve", because a stateless
 * register re-delivers a prompt and a fresh entry built from the frame would
 * CLOBBER the resolution and re-enable the buttons). The durable fold needs the
 * same rule or a replay disagrees with what live showed — N8 — in the worst
 * possible direction, since the disagreement is about whether an action is still
 * offered.
 *
 * ⚠️ CARRIED FROM `prev`, NOT MERGED FROM THE EVENT. The event has no
 * `resolvedDecision` field at all (see `DurableEvent`'s approval arm), so there
 * is nothing on it to lose; writing it as a spread would invite someone to add
 * the field to the event later and reintroduce the clobber through the back
 * door.
 *
 * BOTH PATHS ALLOCATE, like `applyBubble` and `applyReasoning`: a repeated
 * identical request still returns a new array. That keeps the header's
 * SAME-array list exhaustive without this transition contributing a row.
 */
function applyApproval(
  view: DurableView,
  event: {
    id: string;
    approvalKind: "exec" | "plugin";
    title: string;
    description?: string;
    prompt: string;
    options: readonly DurableApprovalOption[];
    expiresAtMs?: number;
  },
): DurableView {
  const idx = findApprovalIndex(view, event.id);
  const prev = idx === -1 ? undefined : view[idx];
  const carriedDecision =
    prev !== undefined && prev.kind === "approval" && prev.resolvedDecision !== undefined
      ? { resolvedDecision: prev.resolvedDecision }
      : {};
  const entry: DurableMessage = {
    kind: "approval",
    id: event.id,
    approvalKind: event.approvalKind,
    title: event.title,
    // Each optional field is an ABSENT KEY when the frame omitted it, never an
    // explicit `undefined` — the same rule the tool arm follows, and for the
    // same reason: `JSON.stringify` drops an `undefined` value, so an
    // always-present key makes the in-memory event and the one read back out of
    // the journal structurally different objects.
    ...(event.description !== undefined ? { description: event.description } : {}),
    prompt: event.prompt,
    options: event.options,
    ...(event.expiresAtMs !== undefined ? { expiresAtMs: event.expiresAtMs } : {}),
    ...carriedDecision,
  };
  if (idx === -1) return [...view, entry];
  const next = view.slice();
  next[idx] = entry;
  return next;
}

/**
 * `approval_resolved` — record the decision on the card it names.
 *
 * ⚠️ AN UNMATCHED RESOLUTION IS A NO-OP, AND IT RETURNS THE INPUT ARRAY BY
 * REFERENCE (a fourth row for the header's exhaustive SAME-array list). The
 * alternative — appending a card built from the resolution alone — would be
 * INVENTING a message: the resolution frame carries an id and a decision and no
 * content at all, so the "card" would have no title, no prompt and no options.
 * That is the server-side invention N8 forbids.
 *
 * ⚠️ AND IT IS UNREACHABLE IN A FULL REPLAY — BUT NOT FOR THE REASON THIS BLOCK
 * GAVE FOR THREE SLICES, WHICH WAS FALSE. It read "the resolution is only ever
 * published for an approval this plugin already delivered — `updateEntry` fires
 * off the entry that `deliverPending` returned". `deliverPending` returns an
 * entry on its REFUSED branches too, so a card the transport dropped, re-armed
 * live by the register-time `approval_snapshot` and then decided by the user
 * produced exactly the orphan this function no-ops on: live showed the card and
 * the verdict, history showed neither (#341, N8/N3).
 *
 * What makes the no-op safe now is a rule the PRODUCER enforces, stated exactly:
 * a resolution row is journaled only once its request row exists. `approvals.ts`
 * writes the request row at delivery when the account had a live channel — above
 * the transport's refusals, so a refused push still stores the card — and
 * otherwise hands the card's payload to the resolution leg, which stores it
 * immediately before the verdict; if that write fails too, NEITHER row is
 * written. So a resolution row implies a request row earlier in the same ordered
 * stream. `projectJournalHistory` folds the WHOLE journal before it pages (see
 * `historyTail`/`pageBefore`, which slice the projected MESSAGES), so a page
 * boundary cannot separate them either.
 *
 * ⚠️ ROUND 1 OF #341 CLAIMED THIS FROM THE WRONG PREMISE — "both rows are written
 * above the refusals, so the request row always exists". The account→channel map
 * is TRANSIENT (`nats-account-runtime.ts` deletes and re-adds it across a
 * restart), so an approval delivered with no channel and resolved with one wrote
 * the resolution alone: the same orphan, on a path the fix had not considered.
 * The invariant is a producer rule, not a consequence of where a hook sits.
 *
 * The reachable case is a client applying a live `approval_resolved` for a card
 * it never received — which is exactly today's behaviour (`patchApproval` maps
 * over the array and matches nothing).
 */
function applyApprovalResolution(
  view: DurableView,
  event: { id: string; decision: DurableApprovalDecision },
): DurableView {
  const idx = findApprovalIndex(view, event.id);
  if (idx === -1) return view;
  const prev = view[idx];
  // `prev.kind !== "approval"` CANNOT fire — `findApprovalIndex`'s predicate
  // already decided it, and TS cannot carry a `findIndex` callback's narrowing
  // to the element. Same shape and same reason as `applyPlacement`'s.
  if (prev.kind !== "approval") return view;
  const next = view.slice();
  next[idx] = { ...prev, resolvedDecision: event.decision };
  return next;
}

/**
 * REVISION-DOMINANT TEXT EDIT (#241 half 1, doc §16.2-4). The typed replacement
 * for untyped last-write-wins: an edit applies because its `revision` DOMINATES,
 * not because it arrived later.
 *
 *  - ABSENT id → NO-OP (return the input by reference). Documented rather than a
 *    create-or-update on purpose: seq ordering guarantees the create precedes the
 *    edit, so an id that is not here is one that was DELETED — a create-or-update
 *    would resurrect a tombstone and defeat the permanent typed delete. §15.3
 *    keeps creation on the `user`/`bubble` paths; there is no `messageCreated`.
 *  - TOMBSTONED entry (`deleted: true`) → NO-OP. A deleted message is not
 *    editable; restore is a new id or an explicit restore (§16.2-3).
 *  - STALE/EQUAL revision (`event.revision <= (prev.revision ?? 0)`) → NO-OP
 *    (§16.2-4 "stale revision 거부").
 *  - DOMINANT revision → replace the entry IN PLACE (slot preserved), taking the
 *    new text, carrying `turnId` forward when the event omits it, stamping the
 *    new `revision`, and setting the "edited" marker.
 *
 * ⚠️ EVERY EARLY RETURN IS UNREACHABLE FOR A STREAM WITH NO `messageEdited`
 * EVENT — this transition simply never runs. It is additive and dormant in half
 * 1; the producer/consumer cutover is half 2.
 */
function applyMessageEdited(
  view: DurableView,
  event: { id: string; text: string; revision: number; turnId?: string },
): DurableView {
  const idx = findTextIndex(view, event.id);
  if (idx === -1) return view;
  const prev = view[idx];
  // `prev.kind !== "text"` CANNOT fire — `findTextIndex` already decided it. Same
  // shape and reason as `applyApprovalResolution`'s narrowing return.
  if (prev.kind !== "text") return view;
  if (prev.deleted === true) return view;
  if (!(event.revision > (prev.revision ?? 0))) return view;
  const next = view.slice();
  next[idx] = {
    ...prev,
    text: event.text,
    turnId: event.turnId ?? prev.turnId,
    revision: event.revision,
    edited: true,
  };
  return next;
}

/**
 * PERMANENT TYPED DELETE with NO RESURRECT (#241 half 1, doc §16.2-3). Replaces
 * the order-sensitive `remove`-then-revive with a revision-dominant tombstone.
 *
 *  - ABSENT id → NO-OP (double-delete of an already-gone id, or a delete before
 *    its create — seq ordering rules the latter out). Returns the input by
 *    reference.
 *  - STALE/EQUAL revision → NO-OP (§16.2-4's rejection rule, applied to delete
 *    too). A second delete at the same-or-lower revision is therefore a clean
 *    by-reference no-op — the message stays deleted either way.
 *  - DOMINANT revision → replace the entry IN PLACE with a TOMBSTONE
 *    (`text: ""`, `deleted: true`, the new `revision`). The tombstone is KEPT in
 *    the array at its slot — NOT filtered out — because retention is what makes
 *    no-resurrect work at the fold level: a later same-id `bubble`/`placement`/
 *    `seal.answers` finds the tombstone (via `findTextIndex`) and refuses to
 *    overwrite or re-append it. Restore is a new id or an explicit restore.
 *
 * ⚠️ DORMANT IN HALF 1 — no producer emits `messageDeleted`, so no tombstone is
 * ever created and the no-resurrect guards in the other transitions never fire.
 */
function applyMessageDeleted(
  view: DurableView,
  event: { id: string; revision: number; turnId?: string },
): DurableView {
  const idx = findTextIndex(view, event.id);
  if (idx === -1) return view;
  const prev = view[idx];
  // `prev.kind !== "text"` CANNOT fire — `findTextIndex` already decided it.
  if (prev.kind !== "text") return view;
  if (!(event.revision > (prev.revision ?? 0))) return view;
  const next = view.slice();
  next[idx] = {
    kind: "text",
    id: prev.id,
    role: prev.role,
    text: "",
    turnId: prev.turnId,
    revision: event.revision,
    deleted: true,
  };
  return next;
}

/**
 * `turn_snapshot` reconciliation — the ONE implementation. The wrapper's
 * `applyTurnSnapshot` is now only the
 * frame→event mapper that feeds this. The contract is EXPLICIT (never a blanket
 * drop):
 *  - `remove` ids are TOMBSTONED IN PLACE (#241 half 2) — replaced by a retained
 *    `{ text: "", deleted: true }` tombstone at their slot, NOT filtered out, so
 *    the delete is permanent and no later same-id event resurrects them. Both
 *    consumers strip tombstones at render/serve, so removed = invisible exactly
 *    as before. ANSWER BUBBLES only — a seal never touches a reasoning block; see
 *    step 1's note;
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
  const dedupedAnswers = rawAnswers.filter((a) =>
    answerSeen.has(a.id) ? false : (answerSeen.add(a.id), true),
  );
  // ⚠️ NO-RESURRECT (#241, doc §16.2-3). An `answers` entry naming a TOMBSTONED
  // id must not revive it — `seal.answers`'s create-or-update (#215 failed-frame
  // recovery) is exactly the revive path the permanent delete replaces, and
  // letting a tombstone through step 2 below would build a `{ ...tombstone, text }`
  // half-state that is `deleted: true` yet non-empty. Skip those ids so the
  // tombstone stays put as a non-answer slot. This set covers PRE-EXISTING
  // tombstones (a prior `messageDeleted`, dormant until its producer lands); the
  // same-frame `remove` case is handled the other way, by `removeSet` excluding
  // answer ids just below, so a same-seal answer WINS over a same-seal remove
  // (which keeps the #215-recovery-vs-remove characterization intact). Both are
  // one rule — a tombstone is never revived by an answer — and `answers ∩ remove
  // = ∅` in production makes the distinction unobservable there.
  const tombstonedIds = new Set<string>();
  for (const m of view) if (m.kind === "text" && m.deleted === true) tombstonedIds.add(m.id);
  const answers =
    tombstonedIds.size === 0
      ? dedupedAnswers
      : dedupedAnswers.filter((a) => !tombstonedIds.has(a.id));
  // Hoisted here (was rebuilt after step 2) so `remove` can exclude answer ids.
  const answerIds = new Set(answers.map((a) => a.id));
  // ⚠️ #241 half 2: `remove` excludes ids this seal ALSO names in `answers`. An id
  // in both would otherwise be tombstoned by step 1 AND re-authored by step 2,
  // producing the `deleted: true` yet non-empty half-state above. Excluding it
  // lets the authoritative answer win cleanly. Disjoint in production
  // (`remove` = `supersededAnswerBubbleIds`, `message-adapter.ts`), so this only
  // bites the contrived overlap the characterization tests drive.
  const removeSet = new Set(
    (Array.isArray(event.remove) ? event.remove : []).filter(
      (r): r is string =>
        typeof r === "string" && r.length > 0 && !answerIds.has(r),
    ),
  );
  if (answers.length === 0 && removeSet.size === 0) return view;

  // 1. TOMBSTONE the plugin-named superseded (mis-routed) answer bubbles IN
  //    PLACE — #241 half 2, doc §16.2-3. This REPLACES the old physical `filter`
  //    drop: the entry keeps its slot as a retained tombstone (`text: ""`,
  //    `deleted: true`, the same shape `applyMessageDeleted` writes, minus the
  //    revision `seal.remove` has none of) so a later same-id
  //    `bubble`/`placement`/`seal.answers` finds it via `findTextIndex` and its
  //    no-resurrect guard refuses to revive it — killing the order-sensitive
  //    revive `[bubble X, seal(remove X), bubble X]` used to have. The tombstone
  //    is a NON-ANSWER slot (`remove` excludes answer ids above, so a removed id
  //    is never in `answerIds`); the reorder in steps 2-4 leaves it exactly where
  //    it is, and both consumers STRIP `deleted === true` at render/serve, so the
  //    VISIBLE order matches the old filter for every disjoint (production)
  //    topology. `removeSet` of an already-tombstoned id re-writes the same
  //    tombstone (a value no-op that stays tombstoned). Both branches produce a
  //    fresh MUTABLE working copy so steps 3-4 may splice/assign without ever
  //    touching the caller's `view`.
  //
  //    ⚠️ EVERY id TEST IN THIS FUNCTION IS GUARDED BY `kind === "text"`. A
  //    `turn_snapshot` reconciles the turn's ANSWER BUBBLES; it says nothing
  //    about reasoning blocks, so neither `remove` nor `answers` may reach one.
  //    Unreachable in practice (the id spaces do not collide — see
  //    `findTextIndex`), and decided in the direction that cannot DELETE
  //    delivered content if it ever were.
  const msgs: DurableMessage[] =
    removeSet.size > 0
      ? view.map((m) =>
          m.kind === "text" && removeSet.has(m.id)
            ? { kind: "text", id: m.id, role: m.role, text: "", turnId: m.turnId, deleted: true }
            : m,
        )
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
  // `answerIds` is hoisted above (so `remove` could exclude answer ids).
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
 * The structural shape of ONE client transcript entry, as this module sees it.
 *
 * ⚠️ STRUCTURAL, NOT `ChatMessage`. This file is strictly dependency-free (see
 * the DEPENDENCY CONTRACT in the header) and the plugin imports it by
 * cross-package source path, so it may not name the client's type. It MIRRORS
 * `packages/client/src/types.ts`'s `ChatMessage` union, and the mirror is
 * checked at the only call site that matters: `nats-client-wrapper.ts` passes a
 * real `ChatMessage[]` into `projectDurableFromClient`, so a divergence in the
 * durable fields is a compile error there.
 */
type ClientTranscriptEntry =
  | { kind?: undefined; id: string; role: DurableRole; text: string; turnId?: string; draftOnly?: boolean }
  | { kind: "reasoning"; id: string; turnId: string; text: string }
  | {
      kind: "tool";
      id: string;
      turnId: string;
      name?: string;
      phase?: string;
      status?: string;
      summary?: string;
      argKeys?: readonly string[];
    }
  | {
      kind: "approval";
      id: string;
      approvalKind: "exec" | "plugin";
      title: string;
      description?: string;
      prompt: string;
      options: readonly DurableApprovalOption[];
      expiresAtMs?: number;
      resolvedDecision?: DurableApprovalDecision;
    };

/**
 * Project a full `ChatMessage[]` (the client's live `state.messages`) down to
 * the durable view. Keeps only the durable fields.
 *
 * ⚠️ THIS IS THE RAW FIELD PROJECTION. It reads `text` verbatim, so calling it on
 * LIVE `state.messages` reads a rolling draft's partial text back as durable
 * content. Use `projectDurableFromClient` below for anything holding a live
 * client bubble; this one is for views that are already durable.
 *
 * ⚠️ IT IS KIND-PRESERVING, AND IT MUST BE. This used to produce only
 * `kind: "text"` entries, correctly, because in half 1 the client kept reasoning
 * in a separate `state.reasoning` array and `state.messages` held no reasoning
 * blocks. Half 2 moved reasoning INTO `state.messages`, and this function is one
 * half of a ROUND TRIP: the wrapper computes
 * `mergeDurable(projectDurableFromClient(state.messages) + one event)` on every
 * durable frame, so a projection that flattened reasoning back to `kind: "text"`
 * — or dropped it — would delete every reasoning block from the view on the next
 * unrelated frame. The tag is carried, never inferred; there is still no
 * guesswork here.
 */
export function projectDurable(messages: ClientTranscriptEntry[]): DurableView {
  return messages.map((m) => {
    if (m.kind === "reasoning") {
      return { kind: "reasoning", id: m.id, turnId: m.turnId, text: m.text };
    }
    // ⚠️ #242 half 3: TOOL IS CARRIED FIELD BY FIELD, and each optional field is
    // omitted rather than written as `undefined`. This is the ROUND TRIP the
    // docblock above warns about — the wrapper recomputes
    // `mergeDurable(projectDurableFromClient(state.messages) + one event)` on
    // every durable frame, so a spread that introduced own `name: undefined`
    // keys here would feed them back through `applyTool`'s spread and BLANK the
    // very fields the `start` frame carried, on the next unrelated frame.
    if (m.kind === "tool") {
      return {
        kind: "tool",
        id: m.id,
        turnId: m.turnId,
        ...(m.name !== undefined ? { name: m.name } : {}),
        ...(m.phase !== undefined ? { phase: m.phase } : {}),
        ...(m.status !== undefined ? { status: m.status } : {}),
        ...(m.summary !== undefined ? { summary: m.summary } : {}),
        ...(m.argKeys !== undefined ? { argKeys: m.argKeys } : {}),
      };
    }
    // ⚠️ #242 half 4: THE APPROVAL'S `resolvedDecision` IS CARRIED, AND IT IS THE
    // ONE FIELD THAT MAKES THIS A ROUND TRIP RATHER THAN A COPY. The wrapper
    // recomputes `mergeDurable(projectDurableFromClient(state.messages) + one
    // event)` on every durable frame, so a projection that dropped the decision
    // would UN-RESOLVE every decided card on the next unrelated frame — the
    // exact resurrect-the-buttons failure `applyApproval`'s upsert-preserve
    // exists to prevent, arriving through the back door.
    //
    // ⚠️ AND `decide()`'s OPTIMISTIC DECISION RIDES THIS SAME FIELD, ON PURPOSE.
    // The client writes its local guess into the entry's `resolvedDecision`, so
    // this projection reads it back as durable — which is correct HERE, because
    // this view is local and is never journaled (the plugin builds its own
    // events from wire frames at `journalEventForOutbound`). What separates the
    // guess from the server's answer is `resolutionConfirmed`, which is
    // client-local and deliberately not projected.
    if (m.kind === "approval") {
      return {
        kind: "approval",
        id: m.id,
        approvalKind: m.approvalKind,
        title: m.title,
        ...(m.description !== undefined ? { description: m.description } : {}),
        prompt: m.prompt,
        options: m.options,
        ...(m.expiresAtMs !== undefined ? { expiresAtMs: m.expiresAtMs } : {}),
        ...(m.resolvedDecision !== undefined
          ? { resolvedDecision: m.resolvedDecision }
          : {}),
      };
    }
    return {
      kind: "text",
      id: m.id,
      role: m.role,
      text: m.text,
      turnId: m.turnId,
    };
  });
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
 *
 * ⚠️ THE `draftOnly` RULE IS BUBBLE-ONLY, AND THE NARROWING SAYS SO RATHER THAN
 * ASSUMING IT. §15.9's indicator/message line is drawn between a lane's rolling
 * `progress` draft and its authored text; a reasoning block has no draft state
 * on the client at all (the wire streams cumulative FULL text and
 * `applyReasoning` upserts it), so there is nothing here to blank.
 */
export function projectDurableFromClient(
  messages: ClientTranscriptEntry[],
): DurableView {
  return projectDurable(
    messages.map((m) => {
      // ⚠️ THE DRAFT CARVE-OUT IS BUBBLE-ONLY, AND THE `kind` TESTS ARE WHAT SAY
      // SO. `draftOnly` lives on the bubble arm alone — a reasoning block streams
      // cumulative full text through an upsert and a tool call is a lifecycle
      // fold, so neither has a rolling draft to suppress. Adding `tool` in half 3
      // made this a COMPILE ERROR rather than a silent one: `m.draftOnly` does
      // not exist on the tool arm, so the narrowing had to be made explicit here
      // instead of leaning on "everything that is not reasoning is a bubble".
      // Half 4's approval arm joins them for the same reason: an approval card
      // is authored once and never streams a draft, so it has no `draftOnly`
      // field and nothing here to blank.
      if (m.kind === "reasoning" || m.kind === "tool" || m.kind === "approval") return m;
      return m.draftOnly === true ? { ...m, text: "" } : m;
    }),
  );
}
