# Issue #93 — 승인 프롬프트 exact-origin 라우팅 복구 기획서

- 이슈: [#93](https://github.com/mir-stream/openclaw-webchannel/issues/93) (P1 / kind/bug / area/plugin)
- 상류 리포트: rota-crew#284 (Rota 0.4.0 제품 리뷰)
- 브랜치: `mir-stream/issue-93` (base `develop`, 시작 커밋 `2bea2d8`)
- OpenClaw 기준 버전: `2026.6.10` (plugin/gateway minimum과 devDependency 모두 동일)

---

## 1. 고정 의도와 범위

**plugin-kind 승인 요청을 그 agent run을 시작한 exact webchannel peer에만 전달하고, exact origin을 증명하지 못하면 `null`로 fail-closed 한다.**

현재 plugin-kind 경로에서는 `turnSource*`가 모두 `null`이어도 `resolveOriginTarget`이 `web-anon`을 선택한다. 실제 peer subject와 달라 승인이 드롭되고 write 툴이 타임아웃된다. 출처가 불명확한 요청을 webchannel이 임의 대상으로 주장한다는 보안 문제도 같은 원인이다.

이 변경이 소유하는 production 표면은 다음뿐이다.

- `packages/plugin/src/approval-origin.ts`: 작은 in-process approval-origin lease registry
- `packages/plugin/src/inbound.ts`: ordinary agent run의 lease 활성화와 exact release
- `packages/plugin/src/approvals.ts`: origin 판정, persisted session corroboration, 진단, target 없음 처리
- 위 세 seam에 가장 가까운 테스트

`channel.ts`, `nats-account-runtime.ts`, `NatsChannel`, conversation-key persistence는 바꾸지 않는다. 승인 UX/approver 정책, broadcast, liveness, 일반 active-turn 기능, core의 metadata 생성도 범위 밖이다.

account eligibility는 기존 `shouldHandleWebChannelApprovalRequest`가 계속 소유한다. 이 설계는 그 gate를 통과한 요청의 origin만 판정하며, account binding이 없는 agent/cron/proactive 요청의 정책을 재설계하지 않는다.

---

## 2. 근거와 설계 결정

상류 실측 요청에는 다음과 같이 exact `sessionKey`는 있지만 source metadata가 없다.

```text
sessionKey="agent:rota:webchannel:review-agent:direct:d21d9f07-…"
turnSourceChannel=null turnSourceTo=null
turnSourceAccountId=null turnSourceThreadId=null
```

검토 과정에서 두 가지 역산 방식은 안전하지 않다고 판정했다.

- 현재 config의 binding/`identityLinks`로 peer를 다시 계산하면 설정 재할당 뒤 과거 요청을 다른 peer로 해석할 수 있다.
- 영속 key ID 목록도 지원되는 quarantine/reset/migration continuity loss 뒤 완전한 origin universe를 영구 증명하지 못한다.

반면 pinned OpenClaw `2026.6.10`은 `resolveApprovalRequestOriginTarget`과 `resolveApprovalRequestSessionTarget`을 export한다. 전자는 `request.sessionKey`가 가리키는 실제 session-store entry에서 `deliveryContext`/`lastTo`/account/channel을 복구하고 live target과 stored target이 함께 있으면 불일치를 거부한다. 로컬 probe에서도 all-null metadata가 case-preserved `lastTo`를 복구했고 conflicting live target은 `null`이었다.

같은 버전의 native approval runtime은 시작할 때 pending request를 replay하며, SDK request type의 `createdAtMs`는 required `number`다. 따라서 “현재 active”만 확인하면 reload 뒤 과거 request가 같은 session의 새 run과 새 stored target에 잘못 결합될 수 있다. lease는 request 생성 시점에도 active였다는 시간 조건까지 증명해야 한다.

또한 pinned `2026.6.10`의 agent-tools request path는 abort 시 approval wait만 취소하고 gateway의 pending record를 즉시 cancel/resolve하지 않는다. distinct peer A/B가 요청 전에 같은 tuple에서 겹친 뒤 A가 abort/release되어도 A의 pending request는 replay될 수 있다. 그때 B가 계속 active이고 stored target도 B이면 단순 active-time filtering만으로 B를 잘못 고를 수 있다.

plugin lifecycle도 곧바로 run lifetime을 끝내지 않는다. `packages/plugin/src/inbound-queue.ts:393-394`의 `dispose()`는 running handler를 abort하지 않고 settle하도록 둔다. 따라서 reload/teardown 때 active claim을 지우면, 계속 실행되는 pre-reload run이 epoch barrier 뒤 새 approval을 만들 때 새 peer의 lease/store와 오결합할 수 있다. epoch 전환은 dormant handle을 차단하되 successfully active claim은 그 run의 `finally` release까지 보존해야 한다.

그러나 persisted `lastTo`만으로도 부족하다. case 또는 `identityLinks` 충돌로 두 peer가 같은 session key를 공유하면 뒤의 inbound가 entry를 덮어쓸 수 있다. 따라서 이 설계는 다음 두 증거를 **모두** 요구한다.

1. request 생성 시점에 이미 active였고 현재도 `handleInboundMessage`가 await 중인 agent run의 exact peer lease
2. pinned SDK helper가 같은 request/account의 session store에서 복구한 exact target

두 값이 byte-equal일 때만 origin이 확정된다. session key 문자열을 파싱하지 않고 현재 config route도 다시 계산하지 않는다.

---

## 3. 설계

### 3.1 판정 우선순위

`resolveOriginTarget`은 source channel과 target을 `trim()`하고 channel만 소문자로 만든다.

| 입력 | 동작 |
| --- | --- |
| 명시적 channel이 `webchannel` 아님 | `null` |
| 명시적 channel이 `webchannel`, target이 non-empty | `{ to: exactTrimmedTarget }` |
| channel이 없거나 공백 | 제공된 `turnSourceTo`를 무시하고 lease + persisted target 판정 |
| channel이 `webchannel`, target이 없음 | lease + persisted target 판정 |
| 위 판정에 필요한 `request.sessionKey`가 null/누락/공백 | 진단 한 줄 + `null` |
| fallback request의 `createdAtMs`가 invalid/future/current barrier 이하 | 진단 한 줄 + `null` |

명시적 webchannel + target은 core가 제공한 exact metadata이므로 fast path를 유지한다. channel 없이 target만 있는 값은 상호 보강되지 않았으므로 신뢰하지 않는다. `web-anon`이라는 authenticated peer ID가 실제로 있어도 특별 취급하지 않으며 위 일반 규칙만 적용한다.

`createClawApprovalNativeRuntimeSpec().transport.prepareTarget`도 `plannedTarget.target.to`가 없으면 `null`을 반환한다. `resolveOriginTarget`과 `prepareTarget` 양쪽의 `ANON_PEER_ID` fallback을 제거한다.

### 3.2 approval-origin lease registry

`approval-origin.ts`는 외부 I/O나 OpenClaw dependency가 없는 testable in-memory registry를 제공한다. 이는 일반 active-turn/liveness registry가 아니라 **승인을 낼 수 있는 ordinary agent run이 실행 중인 짧은 구간**만 증명한다.

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
  constructor(options?: {
    now?: () => number;
    maxPoisonedKeys?: number;
  });
  createLease(input: {
    accountId: string;
    sessionKey: string;
    peerId: string;
  }): ApprovalOriginLease;
  resolve(input: {
    accountId: string;
    sessionKey: string;
    requestCreatedAtMs: number;
  }): ApprovalOriginLeaseResolution;
  rotateEpoch(): void;
}
```

구현 계약:

- key는 exact `(accountId, sessionKey)` tuple이며 문자열 case를 정규화하지 않는다.
- clock은 test에 주입 가능한 `now()`를 사용하고 production registry는 `Date.now`를 쓴다. construction과 각 `rotateEpoch()`는 현재 값을 새 epoch의 `barrierMs`로 캡처한다.
- `createLease`는 immutable handle을 만들며 exact claim, 내부 고유 ID, 생성 당시 registry epoch를 closure에 캡처한다. 호출자가 claim field를 나중에 바꿀 수 없다.
- 같은 handle의 successful `activate()`는 `now()`를 `activatedAtMs`로 한 번만 캡처하며 반복 호출은 no-op이다. `onAgentRunStart`가 같은 turn에 반복되어도 claim과 시간이 바뀌지 않는다.
- successful activation으로 exact tuple의 active claims에 distinct peer가 동시에 존재하게 되면 그 tuple을 current epoch의 `poisonedKeys`에 넣는다. 같은 peer의 duplicate lease는 poison하지 않는다.
- poisoned tuple은 peer 하나가 release되거나 active claim이 모두 사라지거나 later same-peer run이 시작되어도 epoch 끝까지 poisoned다. 유효한 request time에 대한 `resolve`는 항상 `ambiguous`이며 peer를 반환하지 않는다.
- `resolve`는 `requestCreatedAtMs`가 finite이고 `barrierMs`보다 **크며**, resolve 시 `now()`보다 미래가 아닐 때만 진행한다. barrier equality도 `invalid_request_time`이다. millisecond 단위로 reload 전후 순서를 증명할 수 없는 동일 시각에는 가용성보다 false-positive 방지를 택한다.
- distinct peer 집계에는 `activatedAtMs <= requestCreatedAtMs`인 현재 active claim만 포함한다. request 뒤 시작한 lease는 같은 account/session/peer여도 증거가 아니다. eligible peer가 0개면 `no_match`, 1개면 `resolved`, 2개 이상이면 `ambiguous`이며 같은 peer의 여러 eligible lease는 계속 `resolved`다.
- `rotateEpoch()` 전 dormant handle은 영구 stale이며 이후 `activate()`가 no-op이다. 반면 이미 successfully active인 handle의 claim은 생성 epoch와 무관하게 유지되고, repeated `activate()`는 no-op이며, `release()`는 process-global unique claim ID로 자기 retained claim만 지운다. stale/dormant release는 새 claim을 지울 수 없다.
- active claim은 생성 epoch와 관계없이 현재 active이고 `activatedAtMs <= requestCreatedAtMs`이면 eligible이다. 그래서 retained old run이 barrier 뒤 실제로 만든 새 request는 exact stored target과 일치할 때 전달할 수 있고, pre-barrier pending replay는 계속 `invalid_request_time`이다.
- `rotateEpoch()`는 epoch/barrier와 clock-validity를 갱신하고 old per-key/global poison을 reset하지만 active claims는 지우지 않는다. 이어 retained claims를 exact tuple별로 다시 scan해 distinct peer가 2개 이상이면 새 epoch poison을 즉시 재구성한다. 이 rebuild도 `maxPoisonedKeys` overflow 시 global poison으로 승격한다.
- 모든 clock read는 finite·non-decreasing이어야 한다. invalid clock이나 epoch 안의 regression을 감지하면 claim을 추가/선택하지 않고 `invalid_request_time`으로 닫으며, 다음 `rotateEpoch()`가 새 finite barrier를 세울 때까지 그 epoch를 신뢰하지 않는다. clock anomaly와 future request는 false negative만 만들 수 있다.
- active claims는 cap/LRU 때문에 제거하지 않는다. 정상 `finally` cleanup과 host in-flight concurrency가 이 부분의 수명을 제한한다.
- `maxPoisonedKeys`는 positive safe integer이며 기본값은 1,024다. per-key poison을 cap/LRU eviction하면 false-safe가 깨지므로 eviction하지 않는다. 새 poisoned key가 cap을 넘기려 하면 set을 비우고 `epochGloballyPoisoned=true`로 승격한다. 이후 그 epoch의 모든 valid-time fallback resolve는 `ambiguous`; `rotateEpoch()`만 reset한 뒤 retained-overlap scan으로 안전한 poison 상태를 재구성한다. 따라서 poison 메모리는 최대 1,024 keys 또는 boolean 하나로 bounded되며, 용량 압박도 오배송이 아니라 availability 손실로 끝난다.
- `AcctA`와 `accta`는 session key 문자열이 같더라도 서로 다른 registry key다.

production은 module-local singleton이 아니라 versioned `globalThis[Symbol.for("openclaw-webchannel.approval-origin-registry.v1")]` getter를 사용한다. cache-busted module generation도 같은 process-global registry object를 받아 old inbound handle과 new approvals resolver가 동일 claims/epoch를 본다. getter는 `contractVersion`과 required method surface를 structural하게 검사하고 `instanceof`에 의존하지 않는다. incompatible value는 교체해 split state를 만들지 않고 plugin initialization을 fail-closed 한다. 테스트는 isolated global holder/key seam으로 두 simulated generation이 같은 object를 받는지 고정한다.

plugin reload/teardown의 기존 `stopAgentLifecycleSubscription()`는 process-global registry의 `rotateEpoch()`를 호출한다. process restart는 registry와 gateway pending state를 함께 잃으므로 남은 origin을 추측하지 않는다.

### 3.3 inbound activation과 release

`handleInboundMessage`는 route가 정해진 뒤 ordinary turn마다 immutable lease handle을 만들되 즉시 activate하지 않는다. 기존 `replyOptions.onAgentRunStart`에서만 `handle.activate()`를 호출한다. handle이 캡처하는 exact claim은 다음과 같다.

```text
accountId = handleInboundMessage가 받은 exact account ID
sessionKey = 이 turn에 이미 정해진 route.sessionKey
peerId = verified transport peer ID
```

이 callback은 실제 agent run이 시작되어 tool approval을 낼 수 있는 시점을 나타내며 successful activation이 `activatedAtMs`를 고정한다. pre-run denial/setup failure는 claim을 만들지 않는다. `controlLane === true`인 `/stop` turn은 activate하지 않는다.

`handleInboundMessage`의 기존 outer `finally`에서 `handle.release()`를 호출한다. normal return, throw, provider error, abort 모두 같은 cleanup을 지난다. dormant stale handle의 release는 no-op이고, rotation을 건너 살아남은 active handle은 unique claim ID로 자기 claim만 정확히 release한다.

### 3.4 persisted corroboration과 최종 비교

fallback 판정은 handler의 exact account를 `accountId ?? DEFAULT_WEBCHANNEL_ACCOUNT_ID`로 만들고 다음 순서로 실행한다.

1. non-empty `request.sessionKey`와 outer request의 required `createdAtMs`를 읽는다.
2. registry를 exact `(accountId, sessionKey, requestCreatedAtMs)`로 resolve한다. `invalid_request_time`, `no_match`, `ambiguous`면 `null`.
3. pinned SDK `resolveApprovalRequestOriginTarget`을 `channel: WEBCHANNEL_ID`, exact handler account로 호출한다.
4. 이 fallback에서는 `resolveTurnSourceTarget: () => null`로 두어 channel 없는 `turnSourceTo`를 의도적으로 무시한다.
5. `resolveSessionTarget` mapping boundary에서 stored channel이 normalized `webchannel`, stored account가 exact handler account, `to`가 non-empty인지 다시 확인한다. 하나라도 아니면 `null`.
6. `targetsMatch`는 exact `to` equality다. SDK helper가 throw하거나 `null`이면 `null`.
7. active lease peer와 SDK 결과 `to`가 exact equality일 때만 `{ to }`; 다르면 `null`.

SDK helper는 실제 configured session-store path와 request의 persisted entry를 읽는다. 별도 parser, config-generation route lookup, transport membership lookup은 없다. stored target은 corroboration이고 active lease가 per-run positive proof다.

### 3.5 진단

미해결 진단의 단일 소유자는 `approvals.ts`다. fallback 판정 한 건당 warn을 최대 한 줄 남긴다.

```text
event=webchannel.approval.origin_unresolved accountId=<masked> reason=<reason> sessionKey_present=<true|false>
```

reason은 `missing_session_key`, `invalid_request_time`, `active_no_match`, `active_ambiguous`, `stored_target_unavailable`, `stored_binding_mismatch`, `active_stored_mismatch`, `sdk_error`처럼 bounded enum으로 둔다. account는 `formatAccountIdForLog(accountId ?? DEFAULT_WEBCHANNEL_ACCOUNT_ID)`로 만들며 session key, peer ID, stored target 원문은 기록하지 않는다. 명시적 타 채널의 정상적인 비소유 `null`은 warn하지 않는다. 어떤 예외도 SDK capability 경계 밖으로 던지지 않는다.

---

## 4. 구현 계획

1. `packages/plugin/src/approval-origin.ts`
   - registry class, result type, versioned process-global getter 추가.
2. `packages/plugin/src/approval-origin.test.ts`
   - registry의 exact tuple/lease semantics 검증.
3. `packages/plugin/src/inbound.ts`
   - ordinary `onAgentRunStart` activation, outer `finally` exact release, lifecycle teardown epoch rotation 추가.
4. `packages/plugin/src/inbound.test.ts`
   - run timing과 모든 cleanup path 검증.
5. `packages/plugin/src/approvals.ts`
   - pinned SDK helper import, §3.1/§3.4 판정, privacy-safe catch/log 구현.
   - 두 `ANON_PEER_ID` fallback과 낡은 주석 제거; `prepareTarget` 대상 없음은 `null`.
6. `packages/plugin/src/approvals.test.ts` 및 focused integration test
   - 실제 temp session store와 실제 SDK helper를 통과하는 origin/delivery 검증.

다른 production 파일은 수정하지 않는다.

---

## 5. 테스트와 게이트

### 5.1 registry

- `no_match`, unique peer, 같은 peer의 duplicate lease, distinct peer ambiguity
- exact account-case isolation (`AcctA` 대 `accta`)
- 같은 handle의 idempotent activate와 unique-ID exact release
- rotate 전 dormant handle은 activate 불가; active handle은 claim을 유지하고 repeated activate는 no-op이며 old release가 다른/new claim을 건드리지 않음
- retained active claim은 pre-barrier request를 거부하지만 post-barrier request에는 exact peer로 resolve됨
- injected `now()`로 activation 전/후 request time filtering, non-finite time, future time, constructor/rotate barrier보다 작거나 같은 time을 검증
- clock regression/invalid read는 그 epoch에서 `invalid_request_time`이며 어떤 peer도 선택하지 않음
- A/B overlap은 tuple을 poison하고, A release·모든 release·later run 뒤에도 current epoch에서 계속 `ambiguous`
- same-peer duplicate는 poison하지 않으며 정상 unique resolution을 유지
- rotate 시 distinct retained claims는 즉시 re-poison; distinct overlap이 사라진 prior poison은 reset되지만 old request는 새 barrier로 `invalid_request_time`
- 작은 injected `maxPoisonedKeys`를 넘기면 per-key eviction 대신 global poison으로 승격되어 모든 fallback이 fail-closed
- 두 simulated module-generation getter가 같은 process-global registry를 공유하고 incompatible structural version은 fail-closed
- ambiguity에서 순서와 무관하게 peer를 반환하지 않음

### 5.2 inbound lifecycle

- ordinary run은 `onAgentRunStart` 전에는 lease가 없고 callback 뒤에만 보임
- paused fake run 중 approval lookup이 lease를 관찰함
- normal, throw, abort 모두 outer `finally` 뒤 lease 없음
- 반복 `onAgentRunStart`는 claim을 중복하지 않음
- control lane은 callback이 호출되어도 activate하지 않음
- lifecycle stop/reload가 registry epoch를 rotate함
- reload 전 dormant paused-run callback은 rotate 뒤 activate되지 않음
- reload 전 active paused run은 rotate 뒤에도 관찰되고 post-barrier approval을 resolve한 뒤 자기 `finally`에서 exact release됨
- dispatcher teardown fake는 running old handler가 rotation 뒤 settle을 계속하며, retained A + new B overlap에서는 poison되어 wrong-route하지 않음을 증명

### 5.3 approvals와 persisted store

temp directory에 실제 OpenClaw session-store document를 만들고 pinned `resolveApprovalRequestOriginTarget`을 실행한다.

- Issue #93 all-null metadata: active lease와 stored case-preserved peer가 일치할 때만 exact target
- missing/corrupt session entry, nullable/blank key, SDK throw는 `null`
- active/stored mismatch와 stored account/channel mismatch는 `null`
- 같은 key에 distinct active peer lease 둘이면 `ambiguous` + `null`
- explicit other channel은 `null`; explicit webchannel + target은 fast path
- channel 없는 `turnSourceTo`는 무시
- warn 한 줄에 raw key/peer/target이 없음
- config generation의 binding/`identityLinks`를 재할당해도 current-config route를 호출하지 않고 wrong-peer publish가 0건
- stored target이 B로 덮인 동안 active lease가 A면 `null`
- replay된 old request 뒤 같은 key의 새 lease와 stored target B가 모두 일치해도 request time이 current barrier 이하이므로 `null`이고 publish 0건
- A/B가 request 전에 overlap한 뒤 A abort/release, live/store B 상태로 old A request를 replay해도 persistent tuple poison으로 `null`이고 publish 0건
- `AcctA`/`accta`가 같은 session key/peer를 써도 exact active account handler만 resolve하고 다른 handler publish는 0건

### 5.4 focused NATS capture integration

active lease + real stored target → capability `resolveOriginTarget` → native `prepareTarget`/`deliverPending`을 연결한다.

- 일치 시 exact origin subject 하나에만 approval frame publish
- lease release 뒤 publish 0건; rotate 뒤 pre-barrier replay도 publish 0건
- retained pre-rotate run의 post-barrier request는 exact lease/store가 일치할 때 origin subject 하나에 publish
- reload 뒤 later lease/store B와 replay된 old request를 결합해도 publish 0건
- A/B overlap 후 A release + replay에서는 B subject를 포함해 publish 0건
- poison cap overflow로 global poison이 된 epoch에서는 모든 fallback publish 0건
- distinct-peer ambiguity에서 publish 0건
- 다른 peer subject에는 모든 경우 publish 0건

의존성이 repository 표준 절차로 준비된 뒤 다음을 통과해야 한다.

```bash
npm run build
npm run typecheck
npm test --workspace=packages/plugin
npm test
```

---

## 6. 리스크와 범위 밖

- **reload/teardown with running handlers:** queue dispose는 running handler를 abort하지 않는다. dormant handle은 rotation으로 막되 active claim은 그 handler의 exact release까지 process-global registry에 유지한다. old pending replay는 barrier가 막고 retained run의 실제 post-barrier request는 허용한다.
- **process restart:** registry와 gateway pending state가 함께 사라진다. durable cross-restart origin을 추측하지 않고 fail-closed 한다.
- **wall-clock anomaly:** non-finite/future time 또는 epoch 내 regression은 해당 판정을 fail-closed 한다. 일시적인 false negative는 허용하지만 later run을 old request에 붙이는 false positive는 허용하지 않는다.
- **unexpected overlap:** 같은 account/session에 distinct peer run이 겹치면 모두 막힌다. order-based 선택보다 안전한 실패다.
- **persistent epoch poison:** distinct-peer overlap은 epoch 안에서 모두 release된 뒤에도 해당 tuple을 막는다. rotation은 prior poison을 reset하되 retained active overlap을 즉시 다시 poison하고, 과거 request는 새 barrier가 막는다.
- **poison capacity:** per-key poison set이 1,024개를 넘으려 하면 epoch 전체 fallback을 막는다. eviction으로 safety evidence를 잃지 않고 bounded memory를 유지하는 fail-closed escalation이다.
- **hung run:** 실제 active run이 끝나지 않으면 lease도 유지된다. active claim을 임의 eviction하지 않으며 host abort/concurrency가 active-claim 수명을 소유한다. poison state는 별도 bounded escalation 계약을 따른다.
- **stored entry overwrite:** active peer와 다르면 전달하지 않는다. availability 손실을 감수하고 wrong-peer delivery를 막는다.
- agent-initiated/cron/proactive approval의 origin 정책, durable recovery, peer liveness, 일반 active-turn product registry는 범위 밖이다.
- core가 exact `turnSourceChannel` + `turnSourceTo`를 항상 제공하는 것이 장기 해법이며, 제공 시 fast path가 이 fallback을 우회한다.
- 승인 UX, approver 설정/권한, widget 렌더링, #94는 바꾸지 않는다.

---

## 7. 완료 정의

- [ ] explicit channel/target precedence와 두 `ANON_PEER_ID` fallback 제거가 테스트로 고정된다.
- [ ] active lease는 ordinary agent run의 `onAgentRunStart`부터 outer `finally`까지만 존재한다.
- [ ] registry의 immutable-handle, duplicate/ambiguity/exact-account/release/epoch-time-barrier 불변식이 green이다.
- [ ] rotate 전 dormant handle은 activate할 수 없고, active claim은 rotation을 넘어 유지되며 exact old release가 자기 claim만 지운다.
- [ ] pre-barrier request는 거부되지만 retained active run의 post-barrier request는 exact lease/store 일치 시 resolve된다.
- [ ] request time이 non-finite, future 또는 current barrier 이하이면 `invalid_request_time`이고, request 뒤 activation된 lease는 집계되지 않는다.
- [ ] distinct-peer overlap은 release/all-release/later-run 뒤에도 epoch 끝까지 poisoned이며 same-peer duplicate는 poison하지 않는다.
- [ ] rotation은 retained distinct claims를 re-poison하고, 남은 distinct overlap이 없는 prior poison만 reset한다.
- [ ] poison cap overflow는 key eviction 없이 global fail-closed로 승격되고 rotation 때 retained claims로 안전하게 재구성된다.
- [ ] 두 cache-busted module generation이 versioned process-global registry 하나를 공유한다.
- [ ] 실제 SDK helper + temp session store에서 all-null Issue #93 경로가 exact peer를 복구한다.
- [ ] lease와 stored target 중 하나라도 없거나 다르면 진단 한 줄 + `null`이고 publish는 0건이다.
- [ ] config reassignment, stored overwrite, account case collision, reload replay, dispatcher teardown 중 retained A/new B overlap에서 wrong-peer publish가 0건이다.
- [ ] focused integration은 일치한 exact subject 하나에만 publish함을 증명한다.
- [ ] production diff는 `approval-origin.ts`, `inbound.ts`, `approvals.ts`로 제한된다.
- [ ] build, typecheck, plugin test, full test가 모두 실패 0이다.
