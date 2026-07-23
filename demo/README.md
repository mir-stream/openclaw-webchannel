# WebChannel Showcase Demo

One page that weaves the three packages (`saas` / `plugin` / `client`) into a
story you cannot mistake for a toy: the SaaS is the trust authority, the plugin
is an ingress-free agent fleet, and the client is a full-protocol widget — while
the relay between them needs no trust beyond availability.

**The headline claim: the agent side has ZERO inbound listeners.** Not "a firewalled
webhook" — *no listener at all*. The gateway makes only outbound connections (the
NATS relay + the SaaS), and even **admission itself rides that same outbound NATS
connection** — the browser's register/enrollment hop is a NATS request/reply, not
an HTTP call into the agent. There is no gateway URL anywhere in the rendezvous;
the only value the SaaS hands the browser is the shared relay `natsUrl`. That is
the strongest differentiator vs "just run a webhook": you can put the agent behind
NAT with no ports open and it is still fully reachable and grantable.

Everything is **production primitives**; the only stand-ins are the echo LLM
(when no provider key is set) and, by design, the demo-grade user directory.
See `docs/DEMO_PLAN.md` for the full design, decisions, and honest-demo caveats.

## Run it

```bash
./demo/run.sh                       # echo LLM (no key needed) — one-click, isolated OPENCLAW_HOME
ZAI_API_KEY=… ./demo/run.sh         # real model (z.ai); ZAI_BASE_URL / ZAI_MODEL override
ZAI_API_KEY=… ./demo/run.sh --live  # integrated live demo — REQUIRES a real model (fails fast if unset)
```

`--live` is the "real everything" run: the same isolated-home topology, but it
refuses to boot on the echo fallback so you know a real model is answering. It
composes with the rest — `DEMO_RELAY=synadia ZAI_API_KEY=… ./demo/run.sh --live`
runs the live demo over a real managed relay.

Then open **http://127.0.0.1:3961**. Logins (password `demo`):

- **alice**, **bob** — chat users
- **admin** — approves enrollments + grants/revokes agents (admin pane)

`Ctrl+C` tears everything down. Your real `~/.openclaw` is never touched — the
demo boots its own openclaw gateways under an isolated home and **echoes the real
`openclaw channels add` / `openclaw gateway` commands** so you see exactly how the
plugin attaches to an openclaw.

Ports: SaaS 3961 · NATS ws 18722 / tcp 14722 · echo 18905. The gateways still bind
local ports (19299 agent-dev / 19399 agent-ops / 19499 agent-docs added live) for
openclaw's own runtime — but **the browser never dials them**: every webchannel
byte (chat *and* admission) goes over the NATS relay, so those ports are not part
of the browser's trust path.

## The 3-pane layout

`admin` (SaaS authority, admin session only) · `chat` (the widget, on the
production `WebChannelNatsClient`) · `wiretap` (a second NATS connection on
observer creds, rendering every relay frame as hex — the routing envelope is
plaintext but every message body is ciphertext).

## Walkthrough — base layer + six scenes

**Base layer** (all on real client state): log in → typing indicator → streaming
draft → answer, `/help`, exec-approval cards, status pill incl. terminal error.

**The core flow to foreground:** the admin grants agents to a user → that user's
widget shows **one tab per granted agent** and they pick whom to talk to → grant
or revoke, and the tabs grow or shrink live in the open widget. The grant list is
UI/session metadata only: opening each lane performs its own authorized scalar
bootstrap for that `(tenant, accountId)` and receives only that account's agent
pin. Everything else below is a sharpening of this one story.

| # | Scene | How to show it | Freedom proven |
|---|-------|----------------|----------------|
| ① | One identity, an agent fleet | Log in as alice (one tab). As admin, grant/revoke `agent-ops` → alice's tabs grow/shrink live. | SaaS is the sole access authority; each selected lane receives a separate scalar JWT target and matching pin. |
| ② | Agents appear from anywhere | `./demo/add-agent.sh` in a 2nd terminal ("another machine") → a new enrollment pops in the admin pane. **Approve it, grant it — that alone makes it grantable AND dialable; there is no URL to paste, no port to open.** Its tab appears in the open widget. (`--auto-approve` for unattended.) | Zero inbound listeners: admission itself rides the agent's outbound NATS connection — the SaaS only delivers the shared relay `natsUrl`. |
| ③ | The relay may be hostile | `./demo/chaos.sh <control>` against a live chat: `restart-relay` (queued-during-outage message survives), `tamper` (bit-flip dropped, chat clean), `replay-jwt` (nonce single-use → 401), `cross-tenant` (`-ERR Permissions Violation`). | Confidentiality vs passive relay + integrity + authentication + availability. |
| ④ | Many users, one agent | Open alice and bob on the same agent. Each sees only their own turns; a real model's exec-approval card reaches only the originating peer. | Per-peer routing + HITL approver authz. |
| ⑤ | Time-bounded trust | Click **⏱ short-lived** on a lane → after ~12s the credential lapses → a terminal "Credentials expired" state (no eternal spinner) → **Re-authenticate** restores it. | Short-lived credentials + honest terminal-error UX. |
| ⑥ | E2E *and* multi-device | Log in as alice in **two tabs** (or just reload) — each tab is its own device: both lanes go live, and the backlog hydrates in each. Every tab generates its own device keys and receives its own register-delivered conversation key wrapped to that key. | E2E crypto is compatible with multi-device + history — a second device syncs live and decrypts the shared backlog without weakening the wrap. |

## Chaos controls (scene ③)

```bash
./demo/chaos.sh restart-relay   # availability
./demo/chaos.sh cross-tenant    # tenant isolation
./demo/chaos.sh tamper          # integrity (open the widget + send a message first)
./demo/chaos.sh replay-jwt      # authentication (register nonce single-use)
```

## Operator asides (Phase 5)

- **Signing-key rotation (JWKS).** In the admin pane, **Rotate key** mints a fresh
  RS256 kid (old kept → zero downtime: a new-kid JWT verifies after the gateway's
  one live JWKS refetch). **Rotate + evict old** drops the old kid so a JWT under
  it is rejected (clean 401). Only the RS256 key rotates — NATS creds are untouched,
  so live sessions keep running. Drivers: `node demo/verify-rotate.mjs`,
  `node demo/verify-evict.mjs`.

- **One gateway, many accounts.** `./demo/multiplex.sh --auto-approve` (in a 2nd
  terminal, while `run.sh` is up) boots ONE gateway that serves two accounts —
  team-sales + team-support. Log in as alice → team-sales, bob → team-support:
  both tabs are the SAME openclaw process (process-level tenancy). Since no gateway
  URL is delivered anymore, there is no same-URL check to make — the driver
  (`node demo/verify-multiplex.mjs`) proves the single-process claim by driving
  **two live chats** on the one gateway and asserting both answer.

- **Real managed relay (Synadia).** `DEMO_RELAY=synadia ./demo/run.sh` runs the
  entire demo over Synadia Cloud / NGS instead of the local nats-server — the SaaS
  mints creds signed by your account signing seed and browser + agents connect to
  `wss://connect.ngs.global`. The wiretap over a real third-party relay is the most
  persuasive proof of ciphertext-only. Needs `synadia.env` (account signing seed +
  id + wss URL) outside the repo; see `SYNADIA_ENV`. Scene ③ chaos is disabled (we
  don't own the relay).

## Honest-demo notes (short)

- **No active-MITM claim (C2):** scene ③ proves confidentiality vs a *passive*
  wiretap + integrity + authentication + availability, not an active relay that
  substitutes its own registration key.
- **The admission exchange is visible on the relay — on purpose.** Now that register
  rides NATS, the wiretap sees the `.register` / `.reginbox` frames (tagged ✦admission
  in the pane). Two honest facts: (1) **message bodies are still ciphertext** — that
  claim is unchanged. (2) The **bootstrap JWT travels in plaintext** through the relay
  (it did over TLS before; now the relay operator can see it too). That is safe by
  design: the register hop requires **PoP** — a device-key signature over a single-use
  server nonce — plus a **short TTL**, so a captured JWT alone cannot register; and the
  conversation key the agent delivers back is **wrapped to the device key**, so an
  observer who copies the frame cannot use it. You can *watch* the whole admission
  happen on the relay and still not break in.
- **Echo LLM** lets the demo boot creds-free; the UI shows an "Echo mode" badge.
  Approvals + slash commands need a real model.
- **Reload history hydration** works: reload a chat and the prior turns come back.
  The snapshot is sent from the E2E register-complete handler (the earliest point
  the per-peer session key exists) and the core session read runs in a detached
  async-context so `sessions.get` authorizes against a synthetic operator client
  instead of the request-scoped plugin client. No openclaw core change. See
  `docs/DEMO_PLAN.md` for the root cause.

## Verifying (headless drivers)

Committed smoke drivers drive the real page in headless Chromium:

```bash
node demo/verify-e2e.mjs          # base layer: login → chat → echo + wiretap ciphertext
node demo/verify-fleet.mjs        # scene ①: live grant/revoke grows/shrinks a tab, agent-ops lane echoes
node demo/verify-multidevice.mjs  # scene ⑥: same user in two contexts — both lanes live, backlog hydrates in each
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
