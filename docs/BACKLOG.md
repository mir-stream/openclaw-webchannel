# Backlog

Follow-up work that is deferred, not a functional gap. The single source of truth for current
state is [`STATUS.md`](STATUS.md).

## Remove the legacy Gateway-WS transport (`hmac-ticket` strategy: DONE)

**Rationale.** The NATS E2E path (`index-nats.ts`) is now the production default and is
live-proven end-to-end (see STATUS.md). The Gateway-WS entry (`index.ts`) and the (now-removed)
`hmac-ticket` auth strategy have **zero production role**: they only power a zero-infra WS dev
round-trip, and on the NATS path admission resolves to `auto` (no verifier built) or `register-hop`
(JWT-only) — `hmac-ticket` never admitted any NATS peer, and `anonymous` throws at load. Removing
them shrinks the auth surface and deletes a whole parallel transport.

### ✅ Done — the `hmac-ticket` auth strategy is fully removed

- [x] `packages/plugin/src/ticket.ts` deleted (HS256 issue/verify)
- [x] `packages/plugin/src/auth.ts` — `HmacTicketAuthConfig`, `makeHmacTicketVerifier`,
  `resolveSecret`, and the `hmac-ticket` switch case removed (kept `jwt`; `anonymous` still
  throws at load)
- [x] `openclaw.plugin.json` schema — `hmac-ticket` dropped from the strategy enum and the
  `ticketSecret` property removed
- [x] hmac smoke scripts deleted (`smoke/e2e.mjs`, `smoke/history.mjs`, `smoke/typing.mjs`,
  `smoke/burst.mjs`)
- [x] hmac test files deleted (`ticket.test.ts`, `devticket-webcrypto.test.ts`); the `hmac` cases
  stripped from `nats-admission.test.ts`, `auth-admission.test.ts`, `register-dispatch.test.ts`
- [x] docs updated (`docs/AUTH.md`, `docs/STATUS.md`, `docs/README.md`, this file)

### ⏳ Still deferred — remove the Gateway-WS transport itself

**Deferred pending:** confirmation that no consumer depends on the zero-infra WS dev round-trip
(the remaining `smoke/*.mjs`). Once confirmed, remove in one sweep.

Note: the `jwt` strategy still runs over the Gateway-WS transport (jwt-over-WS via the `?ticket=`
carrier), so this removal must retire or re-home the jwt WS path as part of the sweep.

Plugin transport / entry:
- `packages/plugin/index.ts` (the Gateway-WS entry, if present)
- `packages/plugin/src/transport.ts` (the WS transport + `handleUpgrade` verifier seam)

Client:
- `WebChannelClient` + `getTicket` / `?ticket=` carrier in `packages/client/src/client.ts` and
  `packages/client/src/types.ts`
- `packages/client/README.md` (drop the Gateway-WS usage section)

Smoke / harness:
- remaining WS smokes `smoke/*.mjs` (the hmac smokes + `packages/client/smoke-client.mjs` are
  already gone with the `hmac-ticket` strategy)

Config / build:
- `tsconfig.json` `include` (drop the removed files)

Docs:
- `docs/PLAN.md`, `docs/PACKAGING.md` (the index.ts/transport historical references — already
  noted as superseded)

### Verification after removal

- `npm run typecheck` (all workspaces) clean
- `npm test` green (with the WS/transport tests removed)
- the NATS live harnesses (`e2e/local/run-*.sh`) still GREEN in CI
