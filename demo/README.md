# WebChannel Showcase Demo

One page that weaves the three packages (`saas` / `plugin` / `client`) into a
story you cannot mistake for a toy: the SaaS is the trust authority, the plugin
is an ingress-free agent fleet, and the client is a full-protocol widget — while
the relay between them needs no trust beyond availability.

Everything is **production primitives**; the only stand-ins are the echo LLM
(when no provider key is set) and, by design, the demo-grade user directory.
See `docs/DEMO_PLAN.md` for the full design, decisions, and honest-demo caveats.

## Run it

```bash
./demo/run.sh            # echo LLM (no key needed) — one-click, isolated OPENCLAW_HOME
ZAI_API_KEY=… ./demo/run.sh   # real model (z.ai); ZAI_BASE_URL / ZAI_MODEL override
```

Then open **http://127.0.0.1:3961**. Logins (password `demo`):

- **alice**, **bob** — chat users
- **admin** — approves enrollments + grants/revokes agents (admin pane)

`Ctrl+C` tears everything down. Your real `~/.openclaw` is never touched — the
demo boots its own openclaw gateways under an isolated home and **echoes the real
`openclaw channels add` / `openclaw gateway` commands** so you see exactly how the
plugin attaches to an openclaw.

Ports: SaaS 3961 · gateways 19299 (agent-dev) / 19399 (agent-ops) / 19499
(agent-docs, added live) · NATS ws 18722 / tcp 14722 · echo 18905.

## The 3-pane layout

`admin` (SaaS authority, admin session only) · `chat` (the widget, on the
production `WebChannelNatsClient`) · `wiretap` (a second NATS connection on
observer creds, rendering every relay frame as hex — the routing envelope is
plaintext but every message body is ciphertext).

## Walkthrough — base layer + six scenes

**Base layer** (all on real client state): log in → typing indicator → streaming
draft → answer, `/help`, exec-approval cards, status pill incl. terminal error.

| # | Scene | How to show it | Freedom proven |
|---|-------|----------------|----------------|
| ① | One identity, an agent fleet | Log in as alice (one tab). As admin, grant/revoke `agent-ops` → alice's tabs grow/shrink live. | SaaS is the sole access authority (`aud` as a list). |
| ② | Agents appear from anywhere | `./demo/add-agent.sh` in a 2nd terminal → a new enrollment pops in the admin pane. Approve it, grant it → its tab appears in the open widget. (`--auto-approve` for unattended.) | Ingress-free dial-out + SaaS-delivered rendezvous. |
| ③ | The relay may be hostile | `./demo/chaos.sh <control>` against a live chat: `restart-relay` (queued-during-outage message survives), `tamper` (bit-flip dropped, chat clean), `replay-jwt` (nonce single-use → 401), `cross-tenant` (`-ERR Permissions Violation`). | Confidentiality vs passive relay + integrity + authentication + availability. |
| ④ | Many users, one agent | Open alice and bob on the same agent. Each sees only their own turns; a real model's exec-approval card reaches only the originating peer. | Per-peer routing + HITL approver authz. |
| ⑤ | Time-bounded trust | Click **⏱ short-lived** on a lane → after ~12s the credential lapses → a terminal "Credentials expired" state (no eternal spinner) → **Re-authenticate** restores it. | Short-lived credentials + honest terminal-error UX. |
| ⑥ | E2E *and* multi-device | (deferred — Phase 6 milestone; crypto exists, not wired) | E2E crypto compatible with multi-device + history. |

## Chaos controls (scene ③)

```bash
./demo/chaos.sh restart-relay   # availability
./demo/chaos.sh cross-tenant    # tenant isolation
./demo/chaos.sh tamper          # integrity (open the widget + send a message first)
./demo/chaos.sh replay-jwt      # authentication (register nonce single-use)
```

## Honest-demo notes (short)

- **No active-MITM claim (C2):** scene ③ proves confidentiality vs a *passive*
  wiretap + integrity + authentication + availability, not an active relay that
  substitutes its own handshake key.
- **Echo LLM** lets the demo boot creds-free; the UI shows an "Echo mode" badge.
  Approvals + slash commands need a real model.
- **Reload history hydration** works: reload a chat and the prior turns come back.
  The snapshot is sent from the E2E handshake-complete handler (the earliest point
  the per-peer session key exists) and the core session read runs in a detached
  async-context so `sessions.get` authorizes against a synthetic operator client
  instead of the request-scoped plugin client. No openclaw core change. See
  `docs/DEMO_PLAN.md` for the root cause.

## Verifying (headless drivers)

Two committed smoke drivers drive the real page in headless Chromium:

```bash
node demo/verify-e2e.mjs    # base layer: login → chat → echo + wiretap ciphertext
node demo/verify-fleet.mjs  # scene ①: live grant/revoke grows/shrinks a tab, agent-ops lane echoes
```

The remaining scenes were verified during development with the same Playwright
pattern (login → drive the pane → assert) and are recorded in
`docs/DEMO_PLAN.md`:

- **scene ②** — `add-agent.sh --auto-approve` → the agent-docs tab appears for a
  granted user and its lane echoes.
- **scene ④** — two browser contexts (alice/bob) on `agent-dev`: each gets only
  its own echo, no cross-peer leak.
- **scene ⑤** — click **⏱ short-lived** → `-ERR 'User Authentication Expired'` →
  terminal "Credentials expired" → **Re-authenticate** restores the lane.
- **scene ③** — `chaos.sh restart-relay` delivers a message typed during the
  outage on reconnect; `cross-tenant` / `tamper` / `replay-jwt` self-report their
  pass/fail on the command line.
