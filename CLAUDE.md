<!-- ooo:START -->
<!-- ooo:VERSION:0.42.0 -->
# Ouroboros — Specification-First AI Development

> Before telling AI what to build, define what should be built.
> As Socrates asked 2,500 years ago — "What do you truly know?"
> Ouroboros turns that question into an evolutionary AI workflow engine.

Most AI coding fails at the input, not the output. Ouroboros fixes this by
**exposing hidden assumptions before any code is written**.

1. **Socratic Clarity** — Question until ambiguity ≤ 0.2
2. **Ontological Precision** — Solve the root problem, not symptoms
3. **Evolutionary Loops** — Each evaluation cycle feeds back into better specs

```
Interview → Seed → Execute → Evaluate
    ↑                           ↓
    └─── Evolutionary Loop ─────┘
```

## ooo Commands

Each command loads its agent/MCP on-demand. Details in each skill file.

| Command | Loads |
|---------|-------|
| `ooo` | — |
| `ooo interview` | `ouroboros:socratic-interviewer` |
| `ooo seed` | `ouroboros:seed-architect` |
| `ooo run` | MCP required |
| `ooo evolve` | MCP: `evolve_step` |
| `ooo evaluate` | `ouroboros:evaluator` |
| `ooo unstuck` | `ouroboros:{persona}` |
| `ooo status` | MCP: `session_status` |
| `ooo setup` | — |
| `ooo help` | — |

## Agents

Loaded on-demand — not preloaded.

**Core**: socratic-interviewer, ontologist, seed-architect, evaluator,
wonder, reflect, advocate, contrarian, judge
**Support**: hacker, simplifier, researcher, architect
<!-- ooo:END -->

---

# Delivery-render redesign — READ BEFORE TOUCHING message identity / history / streaming

This repo's delivery-render / message-identity subsystem was redesigned after the
approach flipped repeatedly at the spec level. To stop the oscillation:

- **SSOT design doc:** `docs/ISSUE_114_DELIVERY_MIRROR_PLAN.md`. Read **§0** (the
  principle), **§0.2** (the anti-regression NOT-list — the discarded paths and the
  facts that kill them), **§15** (v6 design), **§16.5** (the settled identifier verdict),
  and **§16.5.1 — HOW the built-in Telegram channel keeps identity (one cursor).**
- **⭐ If the question is about FINAL IDENTITY ("which answer does this final belong
  to?"), read §16.5.1 and §16.5.3 FIRST — before §16.5, before the code.** That
  question has burned days at a time, repeatedly. Two facts dissolve it:

  1. **§16.5.1 — Telegram's `lane` is a CONTENT TYPE** (`"answer" | "reasoning"` —
     exactly two), so only one answer bubble is ever open and turn-end finals are
     consumed by a single advancing cursor. **Our** `lane` is per-assistant-message,
     so we hold N open at once. Same word, different thing. The matching question is
     created by OUR design, not by core.
  2. **§16.5.3 — "finals have no identity" is three different claims wedged into
     one, and none is a core limit.** Durable id: *we mint it* (already shipped).
     Live routing: core gives no pointer but **does give an ordered array** — order
     IS the correlation, which is exactly what Telegram's cursor uses. Retroactive
     attribution: Telegram cannot do it either, and the cursor model never needs it.
     **So it is not "unidentifiable" — there is no pointer, but there is order.** Our
     actual bug is order we threw away ourselves (`materializedAnswerLanes()`), not
     information core withheld.

  Do not port Telegram's *render* either: its `forceNewMessage` is a lane-reset
  limitation we do not share — we are the server and can edit any bubble by id.
- **Live board:** GitHub issue **#236** (v6 umbrella) + its slices. It embeds the
  NOT-list. Old design issues are CLOSED — do not reopen those approaches.
- **The principle:** *our plugin = Telegram plugin + Telegram server; our client =
  Telegram app.* The plugin owns identity (assigned at the delivery act) and its own
  durable store; the client is a pure view. Never read core's transcript for the client.
- **Before declaring anything "core-limited / structural / impossible / the spec,"**
  check the NOT-list (§0.2) and read how core's built-in Telegram extension
  (`extensions/telegram/src/` in the pinned core clone) does it on the same core.
