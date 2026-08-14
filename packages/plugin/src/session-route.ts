/**
 * Webchannel session-key derivation — FORCED per-user isolation (Option A).
 *
 * ── Why webchannel overrides the global dmScope ─────────────────────────────
 * openclaw's `session.dmScope` defaults to `"main"`, which collapses EVERY
 * direct peer onto the SAME agent session (`agent:<id>:main`). For a single-user
 * channel that is fine, but webchannel's register-hop mode serves MANY users
 * (one peerId per authenticated user uuid) on one account. Under `"main"` all of
 * them share one transcript, so the register-time history snapshot and
 * `load_history` re-seal OTHER USERS' messages to each requester's own
 * conversation key — a cross-user transcript leak that per-peer E2E encryption
 * cannot prevent, because the leak happens BEFORE sealing, at session scoping.
 *
 * Rather than depend on the operator setting a safe global `session.dmScope`,
 * webchannel FORCES its own inbound session scope — exactly as the two blessed
 * in-tree multi-user channels do:
 *   - Telegram: `resolveTelegramConversationBaseSessionKey` rebuilds the key with
 *     a hardcoded `dmScope: "per-account-channel-peer"`
 *     (dist `bot-*.js`, buildAgentSessionKey({ …, dmScope: "per-account-channel-peer" })).
 *   - Synology chat: `buildSynologyChatInboundSessionKey` always uses
 *     `per-account-channel-peer` (dist `channel-*.js`).
 * Both pass `cfg.session?.identityLinks` through so the forced key matches what
 * `resolveAgentRoute` itself would derive under that scope; we do the same.
 *
 * We use `"per-account-channel-peer"` (not `"per-channel-peer"`) because a single
 * user uuid can span MULTIPLE webchannel accounts in the multiplex deployment —
 * `per-channel-peer` alone would let two accounts' sessions for the same peerId
 * collide. `per-account-channel-peer` keys on `channel:accountId:direct:peerId`,
 * isolating both by account AND by peer.
 *
 * ── The crux: ONE key everywhere ────────────────────────────────────────────
 * Webchannel derives a session key at several sites — the inbound turn dispatch
 * (WRITE), the register-time history snapshot (READ), and the `load_history`
 * pagination handler (READ). If any one of them derived a DIFFERENT key, history
 * would silently break (empty) or leak. Every one of those sites MUST route
 * through this ONE helper so the key is byte-identical.
 *
 * The helper keeps the binding-based AGENT routing from `resolveAgentRoute`
 * (a `binding.account` may pick a specific agentId) and ONLY overrides the
 * session key, mirroring telegram/synology (which likewise leave the route's
 * `agentId`/`mainSessionKey` alone and rebuild only the peer session key). We
 * re-derive `lastRoutePolicy` from the new key so the returned route stays
 * internally consistent (`deriveLastRoutePolicy`: sessionKey === mainSessionKey
 * ? "main" : "session") — a forced per-peer key is never the main key, so this
 * is always `"session"`. Webchannel itself only reads `sessionKey`, but keeping
 * the route non-contradictory avoids a latent trap for any future consumer.
 *
 * ── #112: TENANT is part of the key ─────────────────────────────────────────
 * `per-account-channel-peer` keys on `channel:accountId:direct:peerId`. Tenant
 * is a SEPARATELY VERIFIED authorization namespace in this system (the NATS
 * subject namespace `webchannel.{tenant}.{accountId}.…`, the scoped relay
 * credentials, the conversation-key store's storage scope, and a mandatory
 * signed `tenant` claim checked at register admission), and the protocol
 * permits the SAME account id to exist under different tenants. Without a
 * tenant component the key was therefore NOT unique per authorization scope:
 * serve `(T1, A, P)`, hot-reload the same local account as `(T2, A)` keeping the
 * agent binding and verifier, register with a valid T2 JWT for the same peer
 * string `P`, and the T2 browser resolves T1's session key — reading T1's
 * transcript through the register-time snapshot or `load_history`. Register
 * admission cannot catch this: it verifies the JWT tenant against the
 * CONFIGURED tenant, which after the reload is legitimately T2.
 *
 * So the tenant is appended as its own `:tenant:<token>` component, where the
 * token is the full lowercase SHA-256 digest of the verbatim tenant.
 * Three properties that shape buys, each of which a rejected alternative loses:
 *
 *   1. CASE STABILITY — the reason for the digest, and NOT optional. Core
 *      lowercases the WHOLE session key at the store boundary
 *      (`canonicalizeSessionKeyForAgent` → `normalizeSessionKeyPreservingOpaquePeerIds`,
 *      which is `raw.toLowerCase()` for every channel outside the
 *      `CASE_PRESERVING_PEERS` registry — webchannel is not in it, and neither
 *      read nor write escapes the fold). A plain verbatim `:tenant:Acme` would
 *      therefore be STORED as `:tenant:acme`. NATS subjects are case-sensitive,
 *      so `Acme` and `acme` are different tenants holding different credentials;
 *      folding them would merge two authorization scopes onto one stored key —
 *      #112 again, with a smaller blast radius. The digest covers the VERBATIM
 *      tenant and is already lowercase hex, so it survives the fold and keeps
 *      case-distinct tenants apart under SHA-256's collision resistance. It is
 *      deliberately NOT truncated: a 64-bit public digest admits chosen
 *      collisions in roughly 2^32 work.
 *   2. UNAMBIGUOUS COMPONENT BOUNDARY. Folding the tenant into
 *      the `accountId` argument (`"<tenant>-<account>"`) is unsafe: core's
 *      `normalizeAccountId` lowercases, collapses runs of non-`[a-z0-9_-]` into
 *      `-`, and TRUNCATES to 64 chars — so `(t="a", acct="b-c")` and
 *      `(t="a-b", acct="c")` would collide, as would any sufficiently long pair.
 *      A separate component, separated by a `:` that `assertValidSubjectToken`
 *      forbids inside a tenant, cannot be confused with its neighbours.
 *      NOTE, precisely because the point above is easy to over-read: this avoids
 *      structural tuple ambiguity; it does not make the whole key collision-free.
 *      `normalizeAccountId` still folds accounts `Acme` and `acme` onto one
 *      account component, and nothing guards against two config keys with the
 *      same canonical form. That is the same defect one axis over, it is NOT
 *      fixed here, and it is tracked separately — do not read this docstring as
 *      a claim that it is handled.
 *   3. The peer component keeps its meaning, so `session.identityLinks`
 *      resolution (which matches on the peer id) is unaffected.
 *
 * Core has no `:tenant:` marker and does not parse this suffix. Its session-key
 * parsers treat everything after `direct:` as the peer id, so a key of ours
 * reads back to core as peer `"<peerId>:tenant:<token>"` rather than as a peer
 * plus a tenant. That is inert for webchannel today — the two consumers that act
 * on a parsed peer (`hasExternalSessionDeliveryRoute`, `inferDeliveryFromSessionKey`)
 * are gated on a `webchat` provider and ordinary webchannel turns are
 * `webchannel` — but it is the thing to check first if a future core consumer
 * starts reading peer ids out of session keys. This is deliberately NOT claimed
 * to be the same mechanism as core's `:thread:<id>` suffix: core really does
 * parse that one (`parseThreadSessionSuffix`), and ours only resembles it.
 *
 * The tenant is REQUIRED from the startup serving plan. This is deliberate:
 * the NATS subject namespace and register-admission verifier already capture
 * that planned tenant, while OpenClaw may temporarily mutate `process.env` for
 * skill overrides and config objects may be replaced on reload. Re-resolving on
 * each turn/history read could therefore produce a key in a different tenant
 * while the runtime still authenticates under the original one. The per-account
 * runtime closes over `plan.tenant` and supplies that same immutable value at
 * the inbound WRITE, register-snapshot READ, and `load_history` READ sites.
 *
 * CONTINUITY (breaking, decided — do not "restore" this): the component is
 * appended UNCONDITIONALLY, so every pre-existing session key changes, including
 * those of single-tenant deployments that never configured a tenant and land on
 * `DEFAULT_WEBCHANNEL_TENANT`. At upgrade a live session loses its history
 * binding: the register-time snapshot and `load_history` come back empty. No
 * credential or conversation key changes, because those are keyed by
 * `(tenant, accountId)` + peerId and never by the session key. Core's
 * `sessions.json` contains metadata/key-to-file mappings; transcript messages
 * are in the referenced per-agent `sessions/*.jsonl` files. Preserving old
 * history therefore requires stopping/quiescing the gateway and copying the
 * complete relevant per-agent sessions directory/storage (both `sessions.json`
 * and its referenced JSONLs), not copying `sessions.json` alone.
 *
 * Eliding the component when the tenant is `DEFAULT_WEBCHANNEL_TENANT` would
 * spare exactly those deployments, and it was rejected: a deployment that HAS
 * configured a tenant — i.e. the entire population this bug can affect — breaks
 * either way, so the asterisk buys nothing security-relevant while making a
 * confidentiality boundary conditional on a magic literal. A uniform derivation
 * is worth more than a one-time empty transcript.
 */

import { createHash } from "node:crypto";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import {
  buildAgentSessionKey,
  type ResolvedAgentRoute,
} from "openclaw/plugin-sdk/routing";

import { WEBCHANNEL_ID } from "./channel-contract.js";
import { assertValidSubjectToken } from "./subject-token.js";

/**
 * The DM scope webchannel FORCES for its own inbound session-key derivation,
 * regardless of the operator's global `session.dmScope`. Matches telegram/synology.
 */
export const WEBCHANNEL_ENFORCED_DM_SCOPE = "per-account-channel-peer" as const;

/**
 * Separator label for the #112 tenant component. `:` is core's session-key
 * separator and `assertValidSubjectToken` forbids it inside a tenant, so
 * `…:tenant:<token>` cannot be confused with the components before it.
 */
const TENANT_KEY_SEGMENT = "tenant";

/**
 * The case-STABLE token that represents `tenant` inside a session key.
 *
 * Core lowercases the whole key at the store boundary, so the token must already
 * be equal to its own lowercase form or two case-distinct tenants would land on
 * one stored key (see the module docstring, point 1 — this is the crux of the
 * fix, not a detail). The full SHA-256 digest of the verbatim tenant is lowercase
 * hex, so it distinguishes `Acme` from `acme` under standard collision-resistance
 * assumptions. With no `session.identityLinks` rewrite, the maximum validated
 * raw agent/account/peer/tenant components leave ample room under core's
 * 512-character session-key boundary. Canonical names supplied by
 * `identityLinks` are not bounded by those raw-component validators, so this is
 * not a universal length guarantee for arbitrary configuration.
 */
function tenantScopeToken(tenant: string): string {
  return createHash("sha256").update(tenant, "utf8").digest("hex");
}

/**
 * Append the authorization-namespace (tenant) component to a base session key.
 *
 * Deliberately module-private: the ONE place that decides how a tenant enters a
 * session key, with no second entry point a caller could reach for. The tests
 * assert the resulting key as a literal string rather than by calling this, so
 * they cannot co-vary with a change to the format.
 */
function withTenantScope(baseSessionKey: string, tenant: string): string {
  // Hard gate. The tenant is trusted operator config and the serving path has
  // already validated it, but this is the function that splices it into a
  // security-relevant identifier: a tenant carrying a `:` could otherwise forge
  // another tenant's key outright. Assert at the splice, not only upstream.
  assertValidSubjectToken(tenant, "tenant");
  return `${baseSessionKey}:${TENANT_KEY_SEGMENT}:${tenantScopeToken(tenant)}`;
}

/**
 * Resolve the webchannel agent route for `accountId`/`peerId`, then FORCE the
 * session key to the per-account-channel-peer scope, SCOPED TO THE ACCOUNT'S
 * TENANT (see the module docstring). The returned route is the SAME shape as
 * `resolveAgentRoute`'s, with only `sessionKey` (and the derived
 * `lastRoutePolicy`) overridden — binding-based agent selection, `agentId`,
 * `channel`, `accountId`, and `mainSessionKey` are preserved verbatim.
 *
 * ALL webchannel session-key sites (inbound dispatch, history snapshot,
 * load_history) call THIS so the key is identical everywhere.
 */
export function resolveWebchannelSessionRoute(
  api: OpenClawPluginApi,
  accountId: string,
  peerId: string,
  servingTenant: string,
): ResolvedAgentRoute {
  const route = api.runtime.channel.routing.resolveAgentRoute({
    cfg: api.config,
    channel: WEBCHANNEL_ID,
    accountId,
    peer: { kind: "direct", id: peerId },
  });

  // Rebuild ONLY the session key with the forced scope. Preserve the resolved
  // agentId/channel/accountId (a binding may have picked a specific agent) and
  // pass identityLinks through exactly as telegram/synology do, so the forced
  // key matches what resolveAgentRoute would derive under this scope.
  const baseSessionKey = buildAgentSessionKey({
    agentId: route.agentId,
    channel: route.channel,
    accountId: route.accountId,
    peer: { kind: "direct", id: peerId },
    dmScope: WEBCHANNEL_ENFORCED_DM_SCOPE,
    identityLinks: api.config.session?.identityLinks,
  });

  // #112: bind the key to the immutable authorization namespace captured by the
  // account serving plan. Never re-read config or process.env here: OpenClaw can
  // temporarily mutate ambient env while a skill runs, but the live NATS channel
  // and register admission remain bound to this startup-planned tenant.
  const sessionKey = withTenantScope(baseSessionKey, servingTenant);

  return {
    ...route,
    sessionKey,
    // deriveLastRoutePolicy(sessionKey, mainSessionKey): a forced per-peer key is
    // never the agent's main key, so this is "session" — keep the route truthful
    // rather than half-overriding and leaving a "main" policy behind.
    lastRoutePolicy: sessionKey === route.mainSessionKey ? "main" : "session",
  };
}
