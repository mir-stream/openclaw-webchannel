# Backlog

Follow-up work that is deferred, not a functional gap. The single source of truth for current
state is [`STATUS.md`](STATUS.md).

## Remove the legacy Gateway-WS transport + `hmac-ticket` entirely

**Rationale.** The NATS E2E path (`index-nats.ts`) is now the production default and is
live-proven end-to-end (see STATUS.md). The Gateway-WS entry (`index.ts`) and the `hmac-ticket`
auth strategy have **zero production role**: they only power a zero-infra WS dev round-trip, and
on the NATS path admission resolves to `auto` (no verifier built) or `register-hop` (JWT-only) —
`hmac-ticket` cannot admit any NATS peer, and `anonymous` throws at load. Removing them shrinks
the auth surface and deletes a whole parallel transport.

**Deferred pending:** confirmation that no consumer depends on the zero-infra WS dev round-trip
(`smoke/*.mjs`, `smoke-client.mjs`). Once confirmed, remove in one sweep.

### Removal scope

Plugin transport / entry:
- `packages/plugin/index.ts` (the Gateway-WS entry)
- `packages/plugin/src/transport.ts` (the WS transport)
- hmac in `packages/plugin/src/auth.ts` — `HmacTicketAuthConfig`, `makeHmacTicketVerifier`, and
  the `hmac-ticket` switch case (keep `jwt`; decide `anonymous`/`trusted-header` fate)
- `packages/plugin/src/ticket.ts` (HS256 issue/verify)

Client:
- `WebChannelClient` + `getTicket` in `packages/client/src/client.ts` and
  `packages/client/src/types.ts`
- `packages/client/README.md` (drop the Gateway-WS usage section)

Smoke / harness:
- `smoke/*.mjs`
- `packages/client/smoke-client.mjs`

Tests (delete hmac-only files; strip hmac cases from shared ones):
- delete `packages/plugin/src/auth.test.ts`, `ticket.test.ts`, `devticket-webcrypto.test.ts`
- strip the `hmac` cases from `nats-admission.test.ts`, `auth-admission.test.ts`,
  `register-dispatch.test.ts`

Config / build:
- `tsconfig.json` `include` (drop the removed files)

Docs:
- `docs/AUTH.md` (remove/relabel the hmac-ticket sections)
- `docs/PLAN.md`, `docs/PACKAGING.md` (the index.ts/hmac historical references — already noted as
  superseded)

### Verification after removal

- `npm run typecheck` (all workspaces) clean
- `npm test` green (with the hmac tests removed)
- the NATS live harnesses (`e2e/local/run-*.sh`) still GREEN in CI
