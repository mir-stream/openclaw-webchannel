# WebChannel core session identity (#372)

WebChannel JWT `sub` values remain case-sensitive strings matching
`[A-Za-z0-9_-]{1,128}`. Authentication, wire peer IDs, NATS subjects, conversation
keys, journal conversation IDs and outbound `reply.to` continue to use that exact
string. Only the peer expression in the **core session key** changes.

## Derivation

The plugin first calls the runtime's public `resolveAgentRoute` with the raw peer
and account. Configured peer/account bindings still choose the agent. It then
uses `openclaw/plugin-sdk/routing`'s `buildAgentSessionKey` with the resolved agent,
channel and account, enforcing `per-account-channel-peer` as before.

The session peer is one of:

- `p:<hex>` for an unlinked peer: two lowercase hexadecimal digits per ASCII
  byte of the verified `sub`. For example, `Alice` becomes `p:416c696365` and
  `alice` becomes `p:616c696365`.
- `l:<digest>` for an explicitly linked peer: the full lowercase SHA-256 digest
  of the selected canonical identity name after trimming and lowercasing,
  encoded as UTF-16LE. This preserves even unpaired surrogate code units in
  configured JSON strings; UTF-8 would replace them with the same U+FFFD bytes.

The complete key is:

```text
agent:<agent>:webchannel:<account>:direct:<session-peer>:tenant:<tenant-digest>:peer-v2
```

The tenant digest is still SHA-256 of the **verbatim immutable serving tenant**.
Core's account normalization and WebChannel's startup account-alias validation
are unchanged. This change does not establish continuity across an account rename
or a change of binding or tenant.

ASCII hex is injective for the complete accepted peer space and survives core's
trimming/lowercasing unchanged. The `p:`/`l:` tags separate unlinked identities
from configured canonical names; neither raw peers nor encoded payloads can inject
another component. With 64-character agent and account components and a
128-character peer, the complete key is 492 characters, within the 512-character
boundary. Linked names use a digest to keep even long or delimiter-bearing
operator names bounded. Tenant and linked-name isolation retain SHA-256's
collision-resistance assumption; unlinked peer encoding does not use a hash.

## Configured identity links

The SDK still selects the link. WebChannel substitutes unique marker names in a
local copy of `session.identityLinks`, asks the SDK key builder which marker won,
then encodes the corresponding canonical identity. Markers contain `:`, which a
valid raw peer cannot contain. The original config and binding inputs are not
changed, and links are not applied again to the encoded peer.

This preserves the SDK's raw or `webchannel:<peer>` matching, whitespace/case
normalization, first-match priority and canonical-name case equivalence. For
example, `Shared: ["webchannel:Alice", "Bob"]` intentionally shares core context
for `Alice`, `alice` and `Bob` within the same account, tenant and agent. The SDK's
case-insensitive member matching is deliberate configuration behavior here.
A peer merely named `Shared` does **not** join that context unless a link matches
it. This removes the old implicit collision between an unlinked raw ID and a
canonical name. Journal history stays per raw peer even for linked identities.

## Upgrade and existing sessions

Every peer starts a fresh core session on upgrade, including lowercase-only IDs,
numeric IDs and configured linked groups. No old core session, transcript or
per-session setting is automatically adopted or copied. Subsequent turns with the
same configuration reuse the new key deterministically.

The old unlinked key used `lowercase(sub)`. Every ID containing an ASCII letter
therefore has at least one other valid spelling that could have written to the
same core context. A lowercase spelling is not evidence of ownership.

IDs containing only `[0-9_-]` had an injective old raw derivation. Their context
could be preserved **if it were also known never to have been shared through
past identityLinks**. Current config and a stored key do not establish that
history: a prior canonical link named `123` could have routed another user into
raw peer `123`'s session. Consequently this implementation automatically preserves
**none** of the old core sessions, even when the current config has no links.
There is no history-ownership inference or fallback to a legacy key.

The final `:peer-v2` marker is after the tenant digest. Every previous
WebChannel tenant-scoped key ended in `:tenant:<64 hex>`, including keys built
from arbitrary canonical link names. Thus even an old canonical name resembling
the new encoding cannot make an old key equal a new one. Merely prefixing the
encoded peer would not provide this transition guarantee.

Deploy by draining active turns and restarting the gateway with the updated
plugin. Dispatch, last-route recording and `/stop` then use the same new key;
a new process does not attempt to stop a run under an old key. The agent starts
without previous core context and per-session settings. The client's existing
conversation remains visible through the unchanged delivery journal, and
credentials and conversation encryption keys are retained. Existing journal
content is not rewritten. Do not automatically copy legacy core transcripts into
new sessions: they may contain another user's context.

## Telegram reference and validation

The active reference is Telegram's `bot-message-context.ts`, which takes
`senderId` from numeric `msg.from.id`, and `conversation-route.ts`, whose
`resolveTelegramConversationRoute` selects the agent and whose
`resolveTelegramConversationBaseSessionKey` rebuilds scoped keys through the
public SDK. Numeric sender IDs survive ASCII lowercasing; WebChannel's allowed
JWT subjects require the additional encoding. WebChannel also retains its
existing forced account scope and tenant boundary.

The tests execute the installed OpenClaw `2026.7.1-2` SDK, including real route
selection and `parseAgentSessionKey` normalization. They cover the original
Alice/alice collision, all 64 accepted characters at every permitted length,
every two-character combination, invalid inputs, prefix/delimiter attacks,
account/tenant boundaries, bindings, intentional links and legacy separation.
Inbound tests also check dispatch/recording/stop consistency and raw reply targets.
