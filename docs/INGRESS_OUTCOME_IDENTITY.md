# Ingress outcome identity and upgrade

Terminal ingress outcomes use the same exact tenant/account storage identity as
the delivery journal. The SDK namespace is `tenant:` followed by
`deriveStorageNamespaceId({ tenant, accountId })`; the outcome key continues to
identify the authenticated peer and logical message ID (`random_id`, with the
existing wire-ID fallback). The prefix cannot collide with a valid legacy
account ID. Wire routing and diagnostics still receive the actual account ID.

The outcome operation gates, hot cache, cancellation fallback tombstones and
pending overflow claims all use that scope. Overflow replies also require the
original tenant and peer session token to match the currently published runtime,
so an account replacement cannot receive an old runtime's result. Reservations
and the process resource limits remain shared as before.

## Historical account-only markers

Previous builds wrote accepted, cancelled and overloaded markers under only the
account ID. Those SDK set-membership records do not contain a tenant, credential
binding, or enrollment generation. Credential and conversation-key migration
can prove ownership of those files; it cannot prove which tenant produced a
particular SDK marker. Even one currently visible credential or journal is not
proof that the account namespace never served a different tenant.

When there is no current scoped marker, the store probes legacy membership
through the public SDK `hasRecent` API. It never copies a legacy marker, calls
`checkAndRecord` to renew it, or calls `forget` to erase or resolve conflicts in
that namespace. Any matching legacy outcome without exact tuple journal proof
returns `unknown`: no ACK, rejection, or new dispatch is authorized. This also
covers old accepted markers that may have represented a cancellation before
accepted and cancelled became separate outcomes. Legacy read failures likewise
fail closed.

The rate-limited diagnostic identifies `category=legacy-ambiguous` and
`action=retry-fail-closed`, without including the peer or logical ID. The
availability consequence is limited to ambiguous historical IDs: those replays
remain unresolved while unrelated new IDs and tenant-scoped traffic work.
Existing SDK expiry and capacity behavior is unchanged (the production dedupe
TTL remains seven days); reads do not extend the original marker lifetime.
This change neither introduces a retention policy nor restores evidence already
expired or evicted by an older build.

## Journal and cancellation authority

Exact tuple journal evidence takes precedence over legacy SDK markers. A durable
stop target suppresses the original input after reopen; a committed user row
re-ACKs its original receipt without a fresh dispatch or marker migration. A row
in another tenant's journal proves nothing for the current tenant.

Protocol 6 cancellation receipts carry `ack.cancelled`, a subset of the same
frame's wire IDs. A committed user row proves acceptance but does not disprove a
later scoped cancellation. Flush and overflow lookup therefore check the current
tenant's cancellation marker before emitting that row's receipt, without reading
or adopting legacy markers for this purpose. Initial stop receipts for targets,
cold/hot replays and durable fallback recovery preserve both the cancellation
proof and any committed echo; the stop command's own ACK is receipt-only.

The stop transaction also captures the resolver's one bounded overflow-only
logical ID before retirement. Its retry cannot execute after cancellation, and
the target belongs only to that tenant's journal and peer session.

New tenant-scoped accepted markers still use ordinary orphan repair: if the
matching journal row is absent, the normal admission path journals and dispatches
once. Journaled requests remain deduplicated when the optimization marker is
absent. Cancellation write failures still withhold a receipt and recover through
the same scoped fallback; the parent `/stop` implementation retains its atomic
SQLite receipt/target transaction and replay behavior.

Tenant scoping adds no journal schema, credential format or dispatch policy
change. It is stacked on the protocol 6 stop parent, whose cancellation ACK
contract requires the matching client consumer. Downgrading to an account-only
outcome reader does not provide these identity guarantees.

## Focused evidence

`packages/plugin/src/ingress-tenant-outcomes.test.ts` uses the pinned public SDK
(`openclaw@2026.7.1-2`), real SDK SQLite persistence, tuple delivery journals and
production ingress/recovery/debounce functions. It covers tenant/account/peer
separation, warm and cold reads, journal reopen, all three ambiguous legacy
outcomes, exact tuple acceptance and cancellation proof, accepted orphan repair,
missing markers, cancellation failure/recovery, pending overflow isolation,
legacy read faults and the existing TTL boundary. Protocol 6 cases additionally
check cancellation proof with a committed row, initial target versus command
receipts, and overflow-only cancellation held at lookup/write then reopened.
The agent dispatch recipient
is controlled; these are not live gateway or browser tests. The parent's
separate stop crash tests exercise actual child-process SIGKILL and reopen.
