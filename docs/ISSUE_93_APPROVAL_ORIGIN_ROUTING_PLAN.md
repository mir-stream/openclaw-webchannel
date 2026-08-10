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
  constructor(options?: { now?: () => number });
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
  clear(): void;
}
```

구현 계약:

- key는 exact `(accountId, sessionKey)` tuple이며 문자열 case를 정규화하지 않는다.
- clock은 test에 주입 가능한 `now()`를 사용하고 production singleton은 `Date.now`를 쓴다. construction과 각 `clear()`는 현재 값을 그 epoch의 `barrierMs`로 캡처한다.
- `createLease`는 immutable handle을 만들며 exact claim, 내부 고유 ID, 생성 당시 registry epoch를 closure에 캡처한다. 호출자가 claim field를 나중에 바꿀 수 없다.
- 같은 handle의 successful `activate()`는 `now()`를 `activatedAtMs`로 한 번만 캡처하며 반복 호출은 no-op이다. `onAgentRunStart`가 같은 turn에 반복되어도 claim과 시간이 바뀌지 않는다.
- `resolve`는 `requestCreatedAtMs`가 finite이고 `barrierMs`보다 **크며**, resolve 시 `now()`보다 미래가 아닐 때만 진행한다. barrier equality도 `invalid_request_time`이다. millisecond 단위로 reload 전후 순서를 증명할 수 없는 동일 시각에는 가용성보다 false-positive 방지를 택한다.
- distinct peer 집계에는 `activatedAtMs <= requestCreatedAtMs`인 현재 epoch의 active claim만 포함한다. request 뒤 시작한 lease는 같은 account/session/peer여도 증거가 아니다. eligible peer가 0개면 `no_match`, 1개면 `resolved`, 2개 이상이면 `ambiguous`이며 같은 peer의 여러 eligible lease는 계속 `resolved`다.
- `release()`는 그 handle의 claim만 지운다. 다른 overlapping run의 claim을 지우지 않는다.
- `clear()`는 claim을 모두 지우고 epoch를 증가시킨다. clear 전에 만든 handle은 영구 invalid이며 이후 `activate()`/`release()`가 모두 no-op이다. 따라서 reload 전에 캡처된 callback이 나중에 실행되어도 증거를 부활시키거나 새 claim을 지울 수 없다. clear 뒤 만든 새 handle만 정상 동작한다.
- 모든 clock read는 finite·non-decreasing이어야 한다. invalid clock이나 epoch 안의 regression을 감지하면 claim을 추가/선택하지 않고 `invalid_request_time`으로 닫으며, 다음 `clear()`가 새 finite barrier를 세울 때까지 그 epoch를 신뢰하지 않는다. clock anomaly와 future request는 false negative만 만들 수 있다.
- active claim을 cap/LRU 때문에 제거하지 않는다. 축소가 false uniqueness를 만들기 때문이다. 정상 `finally` cleanup과 host의 in-flight run concurrency가 메모리 상한을 소유한다.
- `AcctA`와 `accta`는 session key 문자열이 같더라도 서로 다른 registry key다.

module singleton을 production에서 공유한다. plugin reload/teardown의 기존 `stopAgentLifecycleSubscription()`가 `clear()`도 호출하게 하며, process restart는 메모리 증거를 자연히 잃는다. 이 경우 복구를 추측하지 않고 fail-closed 한다.

### 3.3 inbound activation과 release

`handleInboundMessage`는 route가 정해진 뒤 ordinary turn마다 immutable lease handle을 만들되 즉시 activate하지 않는다. 기존 `replyOptions.onAgentRunStart`에서만 `handle.activate()`를 호출한다. handle이 캡처하는 exact claim은 다음과 같다.

```text
accountId = handleInboundMessage가 받은 exact account ID
sessionKey = 이 turn에 이미 정해진 route.sessionKey
peerId = verified transport peer ID
```

이 callback은 실제 agent run이 시작되어 tool approval을 낼 수 있는 시점을 나타내며 successful activation이 `activatedAtMs`를 고정한다. pre-run denial/setup failure는 claim을 만들지 않는다. `controlLane === true`인 `/stop` turn은 activate하지 않는다.

`handleInboundMessage`의 기존 outer `finally`에서 `handle.release()`를 호출한다. normal return, throw, provider error, abort 모두 같은 cleanup을 지난다. `onAgentRunStart`가 호출되지 않았거나 lifecycle clear로 handle epoch가 stale인 경우 release는 no-op이다.

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
   - registry class, result type, production singleton 추가.
2. `packages/plugin/src/approval-origin.test.ts`
   - registry의 exact tuple/lease semantics 검증.
3. `packages/plugin/src/inbound.ts`
   - ordinary `onAgentRunStart` activation, outer `finally` exact release, lifecycle teardown clear 추가.
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
- 같은 handle의 idempotent activate, exact release가 다른 lease를 보존, `clear()`
- clear 전 handle의 뒤늦은 activate는 no-op이고, stale release는 clear 뒤 새 handle의 claim을 건드리지 않으며, 새 handle은 정상 resolve됨
- injected `now()`로 activation 전/후 request time filtering, non-finite time, future time, constructor/clear barrier보다 작거나 같은 time을 검증
- clock regression/invalid read는 그 epoch에서 `invalid_request_time`이며 어떤 peer도 선택하지 않음
- ambiguity에서 순서와 무관하게 peer를 반환하지 않음

### 5.2 inbound lifecycle

- ordinary run은 `onAgentRunStart` 전에는 lease가 없고 callback 뒤에만 보임
- paused fake run 중 approval lookup이 lease를 관찰함
- normal, throw, abort 모두 outer `finally` 뒤 lease 없음
- 반복 `onAgentRunStart`는 claim을 중복하지 않음
- control lane은 callback이 호출되어도 activate하지 않음
- lifecycle stop/reload가 registry를 clear함
- reload 전에 캡처된 paused-run callback이 clear 뒤 실행되어도 stale handle은 activate되지 않고, reload 뒤 새 ordinary run의 handle만 관찰됨

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
- `AcctA`/`accta`가 같은 session key/peer를 써도 exact active account handler만 resolve하고 다른 handler publish는 0건

### 5.4 focused NATS capture integration

active lease + real stored target → capability `resolveOriginTarget` → native `prepareTarget`/`deliverPending`을 연결한다.

- 일치 시 exact origin subject 하나에만 approval frame publish
- lease release 또는 simulated reload 뒤 publish 0건
- reload 뒤 later lease/store B와 replay된 old request를 결합해도 publish 0건
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

- **reload/restart availability:** pending approval replay에는 pre-reload handle 무효화와 current epoch time barrier를 모두 적용한다. 같은 key의 새 lease/store가 생겨도 old `createdAtMs <= barrierMs`이면 전달하지 않는다. barrier와 같은 millisecond의 실제 새 request도 순서를 증명할 수 없어 막히며, durable cross-restart origin 증명은 별도 설계가 필요하다.
- **wall-clock anomaly:** non-finite/future time 또는 epoch 내 regression은 해당 판정을 fail-closed 한다. 일시적인 false negative는 허용하지만 later run을 old request에 붙이는 false positive는 허용하지 않는다.
- **unexpected overlap:** 같은 account/session에 distinct peer run이 겹치면 모두 막힌다. order-based 선택보다 안전한 실패다.
- **hung run:** 실제 active run이 끝나지 않으면 lease도 유지된다. active claim을 임의 eviction하지 않으며 host abort/concurrency가 수명을 소유한다.
- **stored entry overwrite:** active peer와 다르면 전달하지 않는다. availability 손실을 감수하고 wrong-peer delivery를 막는다.
- agent-initiated/cron/proactive approval의 origin 정책, durable recovery, peer liveness, 일반 active-turn product registry는 범위 밖이다.
- core가 exact `turnSourceChannel` + `turnSourceTo`를 항상 제공하는 것이 장기 해법이며, 제공 시 fast path가 이 fallback을 우회한다.
- 승인 UX, approver 설정/권한, widget 렌더링, #94는 바꾸지 않는다.

---

## 7. 완료 정의

- [ ] explicit channel/target precedence와 두 `ANON_PEER_ID` fallback 제거가 테스트로 고정된다.
- [ ] active lease는 ordinary agent run의 `onAgentRunStart`부터 outer `finally`까지만 존재한다.
- [ ] registry의 immutable-handle, duplicate/ambiguity/exact-account/release/epoch-time-barrier 불변식이 green이다.
- [ ] clear 전 handle의 stale activate/release는 no-op이고 clear 뒤 새 handle만 증거를 만들 수 있다.
- [ ] request time이 non-finite, future 또는 current barrier 이하이면 `invalid_request_time`이고, request 뒤 activation된 lease는 집계되지 않는다.
- [ ] 실제 SDK helper + temp session store에서 all-null Issue #93 경로가 exact peer를 복구한다.
- [ ] lease와 stored target 중 하나라도 없거나 다르면 진단 한 줄 + `null`이고 publish는 0건이다.
- [ ] config reassignment, stored overwrite, account case collision, reload replay + later lease/store 결합에서 wrong-peer publish가 0건이다.
- [ ] focused integration은 일치한 exact subject 하나에만 publish함을 증명한다.
- [ ] production diff는 `approval-origin.ts`, `inbound.ts`, `approvals.ts`로 제한된다.
- [ ] build, typecheck, plugin test, full test가 모두 실패 0이다.
