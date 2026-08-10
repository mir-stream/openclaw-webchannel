# Issue #93 — 승인 프롬프트 exact-origin 라우팅 복구 기획서 (Phase 1)

- 이슈: [#93](https://github.com/mir-stream/openclaw-webchannel/issues/93) (P1 / kind/bug / area/plugin)
- 상류 리포트: rota-crew#284 (Rota 0.4.0 제품 리뷰)
- 브랜치: `mir-stream/issue-93` (base `develop`, 시작 커밋 `2bea2d8`)
- OpenClaw 기준 버전: `2026.6.10` (plugin/gateway minimum과 devDependency 모두 동일)
- 후속: transport-generation 격리는 이 기획서에서 분리해 [#100](https://github.com/mir-stream/openclaw-webchannel/issues/100) (Phase 2)로 넘긴다 → §7

---

## 1. 고정 의도와 범위

**plugin-kind 승인 요청을 그 agent run을 시작한 exact webchannel peer에만 전달하고, exact origin을 증명하지 못하면 `null`로 fail-closed 한다.**

현재 plugin-kind 경로에서는 `turnSource*`가 모두 `null`이어도 `resolveOriginTarget`이 `web-anon`을 선택한다. 실제 peer subject와 달라 승인이 드롭되고 write 툴이 타임아웃된다. 출처가 불명확한 요청을 webchannel이 임의 대상으로 주장한다는 보안 문제도 같은 원인이다.

이 변경이 소유하는 production 표면은 다음뿐이다.

- `packages/plugin/src/approval-origin.ts`: 작은 in-process approval-origin lease registry (신규)
- `packages/plugin/src/inbound.ts`: ordinary agent run의 lease 활성화, exact release, teardown epoch rotation
- `packages/plugin/src/approvals.ts`: origin 판정, persisted session corroboration, 진단, target 없음 처리
- 위 세 seam에 가장 가까운 테스트

`channel.ts`, `NatsChannel`, `nats-account-runtime.ts`, conversation-key persistence, account runtime 구조는 **바꾸지 않는다**. 승인 UX/approver 정책, broadcast, liveness, 일반 active-turn 기능, core의 metadata 생성, 그리고 transport-generation 격리(§7)는 범위 밖이다.

account eligibility는 기존 `shouldHandleWebChannelApprovalRequest`가 계속 소유한다. 이 설계는 그 gate를 통과한 요청의 origin만 판정하며, account binding이 없는 agent/cron/proactive 요청의 정책을 재설계하지 않는다.

---

## 2. 전제와 그 출처

이 설계가 딛고 선 전제를 **출처의 성격별로** 분류한다. hash-named 내부 번들 경로(`dist/<name>-<hash>.js`)는 매 빌드마다 바뀌므로 인용하지 않는다 — 인용하는 순간 레포가 그 빌드에 고정되고, 그것이 지금의 버전 핀이 생긴 원인이다.

**A. 계약 (`openclaw/plugin-sdk/*` export) — 설계 전제로 삼아도 된다**

| 전제 | 계약 표면 |
| --- | --- |
| `resolveApprovalRequestOriginTarget` / `resolveApprovalRequestSessionTarget`를 쓸 수 있다 | `openclaw/plugin-sdk/approval-runtime` export |
| 전자는 "live와 stored binding이 일치할 때만" origin target을 준다 | 같은 export의 선언 JSDoc |
| `resolveApprovalRequestOriginTarget`은 `{ cfg, request, channel, accountId, resolveTurnSourceTarget, resolveSessionTarget, targetsMatch }`를 받는다 | `ApprovalRequestOriginTargetResolver<TTarget>` 타입 |
| `resolveSessionTarget`에 오는 `ExecApprovalSessionTarget`은 `{ channel?, to, accountId?, threadId? }`다 | 같은 타입 surface |
| `createdAtMs`는 `ExecApprovalRequest` / `PluginApprovalRequest` 양쪽에서 required `number`다 | 두 타입의 export된 선언 |
| capability의 `resolveOriginTarget` 훅은 `{ cfg, accountId, approvalKind, request }`를 받는다 | `createApproverRestrictedNativeApprovalCapability` params 타입 |

**B. 우리 코드 — 읽어서 확인했고 우리가 소유한다**

| 전제 | 위치 |
| --- | --- |
| queue dispose는 running handler를 abort하지 않고 settle하도록 둔다 | `inbound-queue.ts:393` |
| `stopAgentLifecycleSubscription()`은 per-account가 아니라 host teardown에서만 호출된다 | `nats-account-runtime.ts:1533` (`registerFull`의 runtime-lifecycle cleanup) |
| resolver가 설치된 모드의 transport miss는 closure transport로 fallback하지 않는다 | `approvals.ts:713-717` |
| webchannel account id는 `/^[A-Za-z0-9_-]{1,64}$/`만 통과한다 | `account-id.ts:4` |
| 우리는 approval runtime context를 `accountId: ctx.accountId`로 등록한다 | `approvals.ts:1013` → `multiplex.ts:74` (pass-through) → `nats-account-runtime.ts:1421` (`accountRuntimes` 키) |
| core canonical form과 다른 자체 소문자화를 쓰면 alias가 갈린다 | `account-config.ts:118`의 `canonicalizeAccountId`가 core-호환 구현 |

**C. 관찰된 core 동작 — 설계 전제가 아니라 테스트로 고정할 대상**

아래 세 가지는 계약에 명시되어 있지 않고 내부 구현을 읽어서 알아낸 것이다. 설계는 이 값들이 **깨졌을 때 fail-closed 되도록** 짜여 있고, 실제로 유지되는지는 §6의 테스트가 pinned devDependency에 대해 확인한다. 내부 번들 경로를 근거로 남기지 않는다.

1. **훅에 오는 `accountId`는 우리가 등록한 raw 문자열 그대로다** (core가 normalize하지 않는다). §4.4의 exact raw account 필터가 여기 의존한다. 깨지면 transport lookup이 miss하고 판정은 `null`로 닫힌다 → §6.3이 raw/alias 두 handler로 고정한다.
2. **`resolveOriginTarget`은 delivery 경로에서 request당 1회 호출된다.** Phase 1은 이 값에 정확성을 걸지 않는다(멱등한 판정이다). §8의 동기 I/O 리스크 평가에만 쓰이고, 1:1 pairing에 정확성을 거는 provenance 설계는 [#100](https://github.com/mir-stream/openclaw-webchannel/issues/100)으로 넘겼다.
3. **stored target은 `request.request.sessionKey`가 가리키는 session-store entry에서 복구된다** (동기 파일 읽기). §4.4가 이 helper를 corroboration으로만 쓰고 유일 근거로 쓰지 않는 이유다 → §8.

**철회된 전제**: 기존 초안은 canonical account key를 `rawAccountId.toLowerCase()`로 잡았다. 그러나 core가 export하는 계정 정규화는 소문자화에 더해 선행/후행 `-`도 제거하며, `account-config.ts:118`이 이미 그 규칙을 복제해 두었다. webchannel은 `-abc`도 유효 id로 받으므로 `-abc`와 `abc`는 core 기준 같은 canonical(`abc`)이지만 `toLowerCase()` 기준으로는 서로 다르다. §4.2의 collision domain은 자체 소문자화 대신 `canonicalizeAccountId`를 재사용한다.

---

## 3. 근거와 설계 결정

상류 실측 요청에는 exact `sessionKey`는 있지만 source metadata가 없다.

```text
sessionKey="agent:rota:webchannel:review-agent:direct:d21d9f07-…"
turnSourceChannel=null turnSourceTo=null
turnSourceAccountId=null turnSourceThreadId=null
```

검토 과정에서 두 가지 역산 방식은 안전하지 않다고 판정했다.

- 현재 config의 binding/`identityLinks`로 peer를 다시 계산하면 설정 재할당 뒤 과거 요청을 다른 peer로 해석할 수 있다.
- 영속 key ID 목록도 지원되는 quarantine/reset/migration continuity loss 뒤 완전한 origin universe를 영구 증명하지 못한다.

반면 pinned helper는 stored session entry에서 `deliveryContext`/`lastTo`/account/channel을 복구한다. 그러나 persisted `lastTo`만으로도 부족하다. case 또는 `identityLinks` 충돌로 두 peer가 같은 session key를 공유하면 뒤의 inbound가 entry를 덮어쓸 수 있다.

또한 같은 버전의 native approval runtime은 시작할 때 pending request를 replay한다. "현재 active"만 확인하면 reload 뒤 과거 request가 같은 session의 새 run과 새 stored target에 잘못 결합될 수 있으므로, lease는 **request 생성 시점에도 active였다**는 시간 조건까지 증명해야 한다. plugin lifecycle도 곧바로 run lifetime을 끝내지 않는다(`inbound-queue.ts:393`) — reload 때 active claim을 지우면, 계속 실행되는 pre-reload run이 epoch barrier 뒤 새 approval을 만들 때 새 peer의 lease/store와 오결합할 수 있다.

그리고 pinned `2026.6.10`의 agent-tools request path는 abort 시 approval wait만 취소하고 gateway의 pending record를 즉시 cancel/resolve하지 않는다. distinct peer A/B가 요청 전에 같은 tuple에서 겹친 뒤 A가 abort/release되어도 A의 pending request는 replay될 수 있다.

따라서 이 설계는 다음 두 증거를 **모두** 요구한다.

1. request 생성 시점보다 먼저 active가 되었고 현재도 `handleInboundMessage`가 await 중인 agent run의 exact peer lease
2. pinned SDK helper가 같은 request/account의 session store에서 복구한 exact target

두 값이 byte-equal일 때만 origin이 확정된다. session key 문자열을 파싱하지 않고 현재 config route도 다시 계산하지 않는다.

---

## 4. 설계

### 4.1 판정 우선순위

`resolveOriginTarget`은 source channel과 target을 `trim()`하고 channel만 소문자로 만든다.

| 입력 | 동작 |
| --- | --- |
| 명시적 channel이 `webchannel` 아님 | `null` (진단 없음 — 정상적인 비소유) |
| 명시적 channel이 `webchannel`, target이 non-empty | `{ to: exactTrimmedTarget }` (core가 준 exact metadata, fast path) |
| channel이 없거나 공백 | 제공된 `turnSourceTo`를 무시하고 §4.4 fallback 판정 |
| channel이 `webchannel`, target이 없음 | §4.4 fallback 판정 |
| fallback에 필요한 `request.request.sessionKey`가 null/누락/공백 | 진단 한 줄 + `null` |
| outer `request.createdAtMs`가 invalid/future/current barrier 이하 | 진단 한 줄 + `null` |

channel 없이 target만 있는 값은 상호 보강되지 않았으므로 신뢰하지 않는다. `web-anon`이라는 authenticated peer ID가 실제로 있어도 특별 취급하지 않으며 위 일반 규칙만 적용한다 — anonymous 단일 세션 배포에서는 lease의 `peerId`와 stored `lastTo`가 둘 다 `web-anon`이므로 같은 규칙으로 통과한다.

`createClawApprovalNativeRuntimeSpec().transport.prepareTarget`도 `plannedTarget.target.to`가 없으면 `null`을 반환한다. `resolveOriginTarget`(`approvals.ts:938`)과 `prepareTarget`(`approvals.ts:764`) 양쪽의 `ANON_PEER_ID` fallback을 제거한다.

### 4.2 approval-origin lease registry

`approval-origin.ts`는 외부 I/O나 OpenClaw dependency가 없는 testable in-memory registry를 제공한다. 일반 active-turn/liveness registry가 아니라 **승인을 낼 수 있는 ordinary agent run이 실행 중인 짧은 구간**만 증명한다.

```ts
export type ApprovalOriginLeaseResolution =
  | { kind: "resolved"; peerId: string }
  | { kind: "no_match" }
  | { kind: "ambiguous" }
  | { kind: "invalid_request_time" };

export type ApprovalOriginLease = Readonly<{
  activate(): void;
  release(): void;
}>;

export class ApprovalOriginLeaseRegistry {
  constructor(options?: { now?: () => number; maxPoisonedKeys?: number });
  createLease(input: {
    rawAccountId: string;
    sessionKey: string;
    peerId: string;
  }): ApprovalOriginLease;
  resolve(input: {
    rawAccountId: string;
    sessionKey: string;
    requestCreatedAtMs: number;
  }): ApprovalOriginLeaseResolution;
  rotateEpoch(): void;
}
```

구현 계약:

- registry/poison key는 `(canonicalizeAccountId(rawAccountId), sessionKey)`다 — `account-config.ts:118`의 core-호환 함수를 재사용하며 자체 소문자화를 쓰지 않는다. claim은 exact raw `accountId`와 exact `peerId`를 별도로 보존하고, 현재 config route나 alias 열거로 identity를 추론하지 않는다.
- clock은 test에 주입 가능한 `now()`를 쓰고 production은 `Date.now`다. construction과 각 `rotateEpoch()`가 현재 값을 새 epoch의 `barrierMs`로 캡처한다.
- `createLease`는 immutable handle을 만들며 exact claim, 내부 고유 ID, 생성 당시 epoch를 closure에 캡처한다. 호출자가 claim field를 나중에 바꿀 수 없다.
- 같은 handle의 successful `activate()`는 `now()`를 `activatedAtMs`로 한 번만 캡처하고 반복 호출은 no-op이다.
- successful activation으로 같은 canonical tuple의 active claims에 distinct exact origin `(rawAccountId, peerId)`가 동시에 존재하게 되면 그 tuple을 current epoch의 `poisonedKeys`에 넣는다. 두 값이 모두 같은 duplicate lease는 poison하지 않는다.
- poisoned tuple은 한쪽이 release되거나 active claim이 모두 사라지거나 later same-origin run이 시작되어도 epoch 끝까지 poisoned다. 유효한 request time에 대한 `resolve`는 항상 `ambiguous`다.
- `resolve`는 `requestCreatedAtMs`가 finite이고 `barrierMs`보다 **크며** resolve 시점 `now()`보다 미래가 아닐 때만 진행한다. barrier equality도 `invalid_request_time`이다.
- resolve는 canonical tuple의 poison을 모든 raw alias에 적용한 뒤, handler가 준 exact raw account가 일치하고 `activatedAtMs < requestCreatedAtMs`인 active claim만 선택한다. 같은 millisecond equality는 순서를 증명할 수 없어 제외한다. eligible exact peer가 0개면 `no_match`, 1개면 `resolved`, 2개 이상이면 `ambiguous`이며 같은 raw account/peer의 여러 eligible lease는 계속 `resolved`다.
- `rotateEpoch()` 전 dormant handle은 영구 stale이며 이후 `activate()`가 no-op이다. 이미 active인 handle의 claim은 생성 epoch와 무관하게 유지되고, `release()`는 process-global unique claim ID로 자기 retained claim만 지운다. stale/dormant release는 새 claim을 지울 수 없다.
- active claim은 생성 epoch와 관계없이 현재 active이고 `activatedAtMs < requestCreatedAtMs`이면 eligible이다. 그래서 retained old run이 barrier 뒤 실제로 만든 새 request는 전달할 수 있고, pre-barrier pending replay는 계속 `invalid_request_time`이다.
- `rotateEpoch()`는 epoch/barrier와 clock-validity를 갱신하고 old poison을 reset하되 active claims는 지우지 않는다. 이어 retained claims를 canonical tuple별로 다시 scan해 distinct exact origin이 2개 이상이면 새 epoch poison을 즉시 재구성한다.
- 모든 clock read는 finite·non-decreasing이어야 한다. invalid clock이나 epoch 안의 regression을 감지하면 claim을 추가/선택하지 않고 `invalid_request_time`으로 닫으며, 다음 `rotateEpoch()`가 새 finite barrier를 세울 때까지 그 epoch를 신뢰하지 않는다.
- active claims는 cap/LRU로 제거하지 않는다. 정상 `finally` cleanup과 host in-flight concurrency가 수명을 소유한다.
- `maxPoisonedKeys` 기본값은 1,024이며 per-key eviction은 하지 않는다(safety evidence 손실). cap을 넘기려 하면 set을 비우고 `epochGloballyPoisoned=true`로 승격해 그 epoch의 모든 fallback resolve를 `ambiguous`로 만든다. `rotateEpoch()`만 reset한다.

production은 module-local singleton이 아니라 versioned `globalThis[Symbol.for("openclaw-webchannel.approval-origin-registry.v1")]` getter를 쓴다. cache-busted module generation도 같은 process-global registry object를 받아 old inbound handle과 new approvals resolver가 동일 claims/epoch를 본다. getter는 `contractVersion`과 required method surface를 structural하게 검사하고 `instanceof`에 의존하지 않는다. incompatible value는 교체해 split state를 만들지 않고 plugin initialization을 fail-closed 한다.

`stopAgentLifecycleSubscription()`(`inbound.ts:102`, host teardown 전용 — §2 확인)이 process-global registry의 `rotateEpoch()`를 호출한다. process restart는 registry와 gateway pending state를 함께 잃으므로 남은 origin을 추측하지 않는다.

### 4.3 inbound activation과 release

`handleInboundMessage`는 route가 정해진 뒤 ordinary turn마다 immutable lease handle을 만들되 즉시 activate하지 않는다. 기존 `replyOptions.onAgentRunStart`에서만 `handle.activate()`를 호출한다.

```text
rawAccountId = handleInboundMessage가 받은 exact account ID
sessionKey   = 이 turn에 이미 정해진 route.sessionKey
peerId       = verified transport peer ID (wsKey)
```

이 callback은 실제 agent run이 시작되어 tool approval을 낼 수 있는 시점을 나타내며 successful activation이 `activatedAtMs`를 고정한다. pre-run denial/setup failure는 claim을 만들지 않는다. `controlLane === true`인 `/stop` turn은 activate하지 않는다.

`handleInboundMessage`의 기존 outer `finally`에서 `handle.release()`를 호출한다. normal return, throw, provider error, abort 모두 같은 cleanup을 지난다. dormant stale handle의 release는 no-op이고, rotation을 건너 살아남은 active handle은 unique claim ID로 자기 claim만 release한다.

### 4.4 persisted corroboration과 최종 비교

fallback 판정은 handler의 raw account를 `rawHandlerAccountId = accountId ?? DEFAULT_WEBCHANNEL_ACCOUNT_ID`로 두고 다음 순서로 실행한다.

1. non-empty `request.request.sessionKey`와 outer `request.createdAtMs`를 읽는다.
2. registry를 `(rawHandlerAccountId, sessionKey, requestCreatedAtMs)`로 resolve한다. canonical poison을 확인한 뒤 exact raw account claim만 선택하며, `invalid_request_time`/`no_match`/`ambiguous`면 `null`.
3. pinned SDK `resolveApprovalRequestOriginTarget`을 `channel: WEBCHANNEL_ID`, `accountId: rawHandlerAccountId`로 호출한다.
4. 이 fallback에서는 `resolveTurnSourceTarget: () => null`로 두어 channel 없는 `turnSourceTo`를 의도적으로 무시한다.
5. `resolveSessionTarget` mapping boundary에서 stored channel이 normalized `webchannel`이고, SDK가 canonicalize한 stored account가 `canonicalizeAccountId(rawHandlerAccountId)`와 같고, `to`가 non-empty인지 확인한다. exact raw handler identity는 registry claim이 보강한다. 하나라도 아니면 `null`.
6. `targetsMatch`는 exact `to` equality다. SDK helper가 throw하거나 `null`이면 `null`.
7. active lease peer와 SDK 결과 `to`가 exact equality일 때만 `{ to }`를 반환한다. 다르면 `null`.

SDK helper는 실제 configured session-store path와 request의 persisted entry를 읽는다. 별도 parser, config-generation route lookup, transport membership lookup은 없다. stored target은 corroboration이고 active lease가 per-run positive proof다.

### 4.5 진단

미해결 진단의 단일 소유자는 `approvals.ts`다. fallback 판정 한 건당 warn을 최대 한 줄 남긴다.

```text
event=webchannel.approval.origin_unresolved accountId=<masked> reason=<reason> sessionKey_present=<true|false>
```

reason은 bounded enum이다: `missing_session_key`, `invalid_request_time`, `active_no_match`, `active_ambiguous`, `stored_target_unavailable`, `stored_binding_mismatch`, `active_stored_mismatch`, `sdk_error`.

account는 `formatAccountIdForLog(accountId ?? DEFAULT_WEBCHANNEL_ACCOUNT_ID)`로 만들며 session key, peer ID, stored target 원문은 기록하지 않는다. 명시적 타 채널의 정상적인 비소유 `null`은 warn하지 않는다. 어떤 예외도 SDK capability 경계 밖으로 던지지 않는다.

---

## 5. 구현 계획

1. `packages/plugin/src/approval-origin.ts` — registry class, result type, versioned process-global getter.
2. `packages/plugin/src/approval-origin.test.ts` — canonical collision tuple, exact raw claim, lease/time semantics.
3. `packages/plugin/src/inbound.ts` — ordinary `onAgentRunStart` activation, outer `finally` exact release, teardown epoch rotation.
4. `packages/plugin/src/inbound.test.ts` — run timing과 모든 cleanup path.
5. `packages/plugin/src/approvals.ts` — pinned SDK helper import, §4.1/§4.4 판정, privacy-safe catch/log. 두 `ANON_PEER_ID` fallback과 낡은 주석 제거; `prepareTarget` 대상 없음은 `null`.
6. `packages/plugin/src/approvals.test.ts` 및 focused integration test — 실제 temp session store와 실제 SDK helper를 통과하는 origin/delivery 검증.

이 밖의 production 파일은 수정하지 않는다.

---

## 6. 테스트와 게이트

### 6.1 registry

- `no_match`, unique exact origin, 같은 raw account/peer의 duplicate lease, distinct origin ambiguity
- `AcctA` 단독 claim은 raw handler `AcctA` resolve에만 eligible하고 alias handler `accta`에는 `no_match`
- `AcctA/A`와 `accta/B`가 같은 canonical tuple에서 overlap하면 poison; peer ID가 같아도 raw account가 다르면 poison
- **`-abc`와 `abc`가 같은 canonical tuple로 접히는 것을 고정** (core `normalizeAccountId` 정합 회귀)
- 같은 handle의 idempotent activate와 unique-ID exact release
- rotate 전 dormant handle은 activate 불가; active handle은 claim을 유지하고 old release가 다른/new claim을 건드리지 않음
- retained active claim은 pre-barrier request를 거부하고 post-barrier request만 exact peer로 resolve
- injected `now()`로 activation 전/후 request time filtering, non-finite/future time, barrier 이하 time 검증
- strict time: `activatedAtMs === requestCreatedAtMs` claim은 제외
- clock regression/invalid read는 그 epoch에서 `invalid_request_time`
- distinct exact-origin overlap은 한쪽 release·전체 release·later run 뒤에도 current epoch에서 계속 `ambiguous`
- rotate 시 distinct retained claims는 즉시 re-poison; overlap이 사라진 prior poison은 reset되지만 old request는 새 barrier로 `invalid_request_time`
- 작은 injected `maxPoisonedKeys`를 넘기면 per-key eviction 대신 global poison으로 승격
- 두 simulated module-generation getter가 같은 process-global registry를 공유하고 incompatible structural version은 fail-closed
- ambiguity에서 순서와 무관하게 peer를 반환하지 않음

### 6.2 inbound lifecycle

- ordinary run은 `onAgentRunStart` 전에는 lease가 없고 callback 뒤에만 보임
- paused fake run 중 approval lookup이 lease를 관찰함
- normal, throw, abort 모두 outer `finally` 뒤 lease 없음
- 반복 `onAgentRunStart`는 claim을 중복하지 않음
- control lane은 callback이 호출되어도 activate하지 않음
- lifecycle stop/reload가 registry epoch를 rotate함
- reload 전 dormant paused-run callback은 rotate 뒤 activate되지 않음
- reload 전 active paused run은 rotate 뒤에도 관찰되고 post-barrier approval만 resolve한 뒤 자기 `finally`에서 exact release됨
- dispatcher teardown fake는 running old handler가 rotation 뒤 settle을 계속함을 증명

### 6.3 approvals와 persisted store

temp directory에 실제 OpenClaw session-store document를 만들고 pinned `resolveApprovalRequestOriginTarget`을 실행한다.

- **Issue #93 all-null metadata: active lease와 stored case-preserved peer가 일치할 때 exact target을 복구한다** (핵심 회귀)
- missing/corrupt session entry, nullable/blank key, SDK throw는 `null`
- active/stored mismatch와 stored account/channel mismatch는 `null`
- 같은 canonical tuple에 distinct exact-origin lease 둘이면 `ambiguous` + `null`
- explicit other channel은 `null`; explicit webchannel + target은 fast path
- channel 없는 `turnSourceTo`는 무시
- warn 한 줄에 raw key/peer/target이 없음
- config generation의 binding/`identityLinks`를 재할당해도 current-config route를 호출하지 않고 wrong-peer publish 0건
- stored target이 B로 덮인 동안 active lease가 A면 `null`
- A request/release 뒤 같은 injected millisecond에 alias B가 activate되고 store를 B로 덮어도 strict time filter로 `null`, publish 0건
- replay된 old request 뒤 같은 key의 새 lease와 stored target B가 모두 일치해도 request time이 current barrier 이하라 `null`, publish 0건
- A/B가 request 전에 overlap한 뒤 A abort/release, live/store B 상태로 old A request를 replay해도 tuple poison으로 `null`, publish 0건
- `AcctA` 단독 active + canonical stored `accta`는 raw handler `AcctA`만 resolve하고 alias handler publish 0건

### 6.4 focused NATS capture integration

active lease + real stored target → capability `resolveOriginTarget` → native `prepareTarget`/`deliverPending`을 연결한다.

- 일치 시 exact origin subject 하나에만 approval frame publish
- lease release 뒤 publish 0건; rotate 뒤 pre-barrier replay도 publish 0건
- retained pre-rotate run의 post-barrier request는 exact lease/store 일치 시 origin subject 하나에 publish
- reload 뒤 later lease/store B와 replay된 old request를 결합해도 publish 0건
- A/B overlap 후 A release + replay에서는 B subject를 포함해 publish 0건
- poison cap overflow로 global poison이 된 epoch에서는 모든 fallback publish 0건
- 다른 peer subject에는 모든 경우 publish 0건

### 6.5 게이트

의존성이 repository 표준 절차로 준비된 뒤 다음을 통과해야 한다.

```bash
npm run build
npm run typecheck
npm test --workspace=packages/plugin
npm test
```

---

## 7. Phase 2로 분리한 것 — [#100](https://github.com/mir-stream/openclaw-webchannel/issues/100)

transport-generation 격리 — lease claim의 `transportGeneration` 토큰, resolve→prepare provenance store, captured-transport delivery, generation-scoped pending/resolved snapshot storage와 `nats-account-runtime.ts` register 배선 — 는 **이 기획서에서 제외한다.**

이유:

- 위협 모델이 아직 진술되지 않았다. peerId는 계정별 verifier로 검증된 값이므로 `(account, peerId)`가 이미 principal이고, 같은 account/peer가 새 transport에 재접속한 것을 "다른 origin"으로 볼 근거를 먼저 글로 써야 한다.
- 그 격리는 fallback 경로에만 적용되고 explicit fast path에는 적용되지 않는다. §9가 적는 대로 core가 `turnSourceChannel`+`turnSourceTo`를 채우게 되면 fast path가 지배적 경로가 되므로, 곧 죽을 경로에만 존재하는 보호가 된다.
- 구현 비용이 pending/resolved 저장소 키 재설계와 두 조회 함수 시그니처 변경까지 번져서, §1이 선언한 범위와 실제 작업량이 어긋난다.

#100에서 위협 모델부터 정리하며, 답이 "실제 위협 없음"이면 그대로 닫는다.

---

## 8. 리스크와 범위 밖

- **reload/teardown with running handlers:** queue dispose는 running handler를 abort하지 않는다(`inbound-queue.ts:393`). dormant handle은 rotation으로 막되 active claim은 그 handler의 exact release까지 유지한다. old pending replay는 barrier가 막고 retained run의 실제 post-barrier request만 허용한다.
- **session store 동기 읽기:** `resolveApprovalRequestOriginTarget`은 persisted session entry를 읽어야 하므로 판정 시점에 session store를 **동기적으로** 읽는다(§2-C-3). fallback 판정마다 event loop를 막으므로, 큰 session store에서 지연이 관측되면 별도 이슈로 캐싱을 검토한다. 호출 빈도는 §2-C-2 관찰상 request당 1회로 bounded되어 Phase 1에서는 수용하되, 이는 계약이 아니므로 지연이 문제가 되면 그때 측정한다.
- **process restart:** registry와 gateway pending state가 함께 사라진다. durable cross-restart origin을 추측하지 않고 fail-closed 한다.
- **wall-clock anomaly:** non-finite/future time 또는 epoch 내 regression은 해당 판정을 fail-closed 한다. 일시적 false negative는 허용하지만 later run을 old request에 붙이는 false positive는 허용하지 않는다.
- **same-ms ordering:** activation과 request creation이 같은 millisecond면 legitimate request도 막힐 수 있다. 순서를 증명할 수 없는 equality에서 availability보다 exact-origin safety를 택한다.
- **canonical account collision:** core canonical form을 공유하는 raw aliases는 exact raw claim으로 분리하되 overlap 시 모두 poison한다. blanket noncanonical rejection이나 current-config alias enumeration은 하지 않는다.
- **persistent epoch poison:** distinct exact-origin overlap은 epoch 안에서 모두 release된 뒤에도 canonical tuple을 막는다. rotation은 prior poison을 reset하되 retained overlap을 즉시 다시 poison한다.
- **poison capacity:** per-key poison set이 1,024개를 넘기려 하면 epoch 전체 fallback을 막는다. eviction으로 safety evidence를 잃지 않는 fail-closed escalation이다.
- **hung run:** 실제 active run이 끝나지 않으면 lease도 유지된다. active claim을 임의 eviction하지 않으며 host abort/concurrency가 수명을 소유한다.
- **stored entry overwrite:** active peer와 다르면 전달하지 않는다. availability 손실을 감수하고 wrong-peer delivery를 막는다.
- **account runtime 교체:** Phase 1은 transport 객체 identity를 보지 않는다. 같은 account/peer로의 전달은 현재 배선(`transportFor`)이 그대로 담당한다 → §7.
- agent-initiated/cron/proactive approval의 origin 정책, durable recovery, peer liveness, 일반 active-turn product registry는 범위 밖이다.
- 승인 UX, approver 설정/권한, widget 렌더링, #94는 바꾸지 않는다.

---

## 9. 완료 정의

**사용자 관점**

- [ ] #93 재현 시나리오(all-null `turnSource*`)에서 승인 프롬프트가 요청을 낸 peer에게 도착하고 write 툴이 타임아웃하지 않는다.
- [ ] origin을 증명하지 못하는 요청은 조용히 오배송되는 대신 드롭되고, 운영자가 `origin_unresolved` 진단 한 줄로 원인을 식별할 수 있다.

**메커니즘**

- [ ] explicit channel/target precedence와 두 `ANON_PEER_ID` fallback 제거가 테스트로 고정된다.
- [ ] active lease는 ordinary agent run의 `onAgentRunStart`부터 outer `finally`까지만 존재한다.
- [ ] registry의 immutable-handle, canonical-account collision(core `normalizeAccountId` 정합 포함), exact raw-account selection, duplicate/ambiguity/release/epoch-time-barrier 불변식이 green이다.
- [ ] rotate 전 dormant handle은 activate할 수 없고, active claim은 rotation을 넘어 유지되며 exact old release가 자기 claim만 지운다.
- [ ] pre-barrier request는 거부되지만 retained active run의 post-barrier request는 exact lease/store 일치 시에만 resolve된다.
- [ ] request time이 non-finite, future 또는 current barrier 이하이면 `invalid_request_time`이고, `activatedAtMs >= requestCreatedAtMs`인 lease는 집계되지 않는다.
- [ ] distinct exact-origin `(rawAccountId, peerId)` overlap은 release/all-release/later-run 뒤에도 canonical tuple을 epoch 끝까지 poison하며 같은 쌍의 duplicate는 poison하지 않는다.
- [ ] poison cap overflow는 key eviction 없이 global fail-closed로 승격되고 rotation 때 retained claims로 안전하게 재구성된다.
- [ ] 두 cache-busted module generation이 versioned process-global registry 하나를 공유한다.
- [ ] 실제 SDK helper + temp session store에서 all-null Issue #93 경로가 exact peer를 복구한다.
- [ ] lease와 stored target 중 하나라도 없거나 다르면 진단 한 줄 + `null`이고 publish는 0건이다.
- [ ] config reassignment, same-ms sequential alias, stored overwrite, canonical account collision/overlap, reload replay에서 wrong-account/peer publish가 0건이다.
- [ ] production diff는 `approval-origin.ts`, `inbound.ts`, `approvals.ts` 세 파일로 제한된다.
- [ ] build, typecheck, plugin test, full test가 모두 실패 0이다.
