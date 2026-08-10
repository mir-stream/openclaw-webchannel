# Issue #93 — 승인 프롬프트 origin 라우팅 복구 기획서

- 이슈: [#93](https://github.com/mir-stream/openclaw-webchannel/issues/93) (P1 / kind/bug / area/plugin)
- 상류 리포트: rota-crew#284 (Rota 0.4.0 제품 리뷰)
- 브랜치: `mir-stream/issue-93` (base `develop`, 시작 커밋 `2bea2d8`)
- 리포트 기준 커밋 `7164006` 이후의 변경은 #87/#89 턴-아웃컴 계열과 CI이며, #93이 지목한 `resolveOriginTarget`은 HEAD에서도 동일하다 (2026-08-10 코드 확인).

---

## 1. 고정 의도와 범위

**plugin-kind 승인 요청을 그 턴의 정확한 webchannel peer에만 전달하고, 정확한 peer를 증명할 수 없으면 webchannel이 요청을 소유하지 않는다.**

현재 plugin-kind 경로에서는 `turnSource*`가 모두 `null`이어도 `resolveOriginTarget`이 대상을 `web-anon`으로 정한다. 등록되지 않은 대상으로 프레임이 드롭되어 write 툴이 승인 타임아웃으로 실패하며, 동시에 출처가 불명확한 승인을 webchannel이 자기 요청으로 주장하는 문제가 있다.

이 변경이 소유하는 표면:

- `packages/plugin/src/approvals.ts`의 origin 판정, fail-closed 진단, `prepareTarget`의 대상 없음 처리
- session key 재도출 결과를 유일성까지 판정하는 작은 helper
- `ConversationKeyStore`와 `NatsChannel`의 non-shrinking admitted-peer proof snapshot 접근자
- `channel.ts`에서 `nats-account-runtime.ts`까지의 resolver 주입 배선
- 위 동작을 고정하는 단위·배선·집중 통합 테스트

이 변경은 승인 UX, approver 정책, 승인 카드 렌더링, active-turn registry, peer liveness 추적, 브로드캐스트, core의 `turnSource*` 생성 로직을 바꾸지 않는다. 이후 리뷰도 이 고정 의도를 넓히지 않는다.

---

## 2. 현상과 코드 증거

상류 리포트의 실측:

```text
[PROBE origin-target] {
  "pluginId":"rota-approval-gate",
  "toolName":"rota__manage_leave",
  "sessionKey":"agent:rota:webchannel:review-agent:direct:d21d9f07-4fcb-48c8-8acb-8fee081c8038",
  "turnSourceChannel":null, "turnSourceTo":null,
  "turnSourceAccountId":null, "turnSourceThreadId":null
}
[webchannel] approval plugin:111e1824-… not delivered:
             no matching open socket for "web-anon" (account "review-agent")
[ws] ⇄ res ✓ plugin.approval.waitDecision 119969ms
```

현행 `packages/plugin/src/approvals.ts`의 핵심은 다음과 같다.

```ts
const channel = src.turnSourceChannel?.toLowerCase();
if (channel && channel !== WEBCHANNEL_ID) return null;
const to =
  typeof src.turnSourceTo === "string" && src.turnSourceTo.length > 0
    ? src.turnSourceTo
    : ANON_PEER_ID;
return { to };
```

결함은 두 가지다.

1. `turnSourceTo`가 없으면 요청의 `sessionKey`를 사용하지 않고 고정 peer를 선택한다.
2. `turnSourceChannel`이 없으면 채널 가드가 통과하므로, 검증되지 않은 `turnSourceTo` 또는 고정 peer로 출처를 주장할 수 있다.

현재 제품은 NATS register-hop의 JWT admission만 지원한다. `account-config.ts`는 `auth.strategy="anonymous"`, `nats.devOpen`, `nats.credentials.mode="open"`을 migration error로 거부한다. 따라서 승인 라우팅에서 `web-anon`을 특별 취급할 제품 계약은 없다. JWT의 `sub`가 문자 그대로 `web-anon`인 peer가 있다면 다른 peer와 똑같이 유일한 session-key 일치로만 선택한다.

---

## 3. 보안·정확성 불변식

1. 명시된 source channel이 webchannel이 아니면 즉시 `null`이다.
2. `turnSourceTo`를 직접 신뢰하려면 정규화된 source channel이 명시적으로 `webchannel`이어야 한다.
3. source channel이 없거나 공백이면 `turnSourceTo`만으로 대상을 정하지 않는다. non-empty `sessionKey`와 admitted-peer proof 집합의 재도출 결과가 정확히 하나 일치해야 한다.
4. 일치가 0개이거나 2개 이상이면 `null`이다. 후보 순서에 따른 선택은 금지한다.
5. proof store 미제공, resolver 미주입, runtime/install 부재, 예외, session key 부재도 모두 `null`이다. SDK 경계 밖으로 예외를 던지지 않는다.
6. 대상 미확정은 자동 승인이나 다른 peer 전달로 바뀌지 않는다.
7. session key와 peer ID 원문은 진단 로그에 남기지 않는다.

`sessionKey`는 exact peer ID에 대해 injective하지 않다. `subject-token.ts`는 `Alice`와 `alice`를 서로 다른 등록 ID로 허용하지만 OpenClaw의 key 생성은 case normalization을 수행한다. 또한 `identityLinks`의 여러 alias가 같은 canonical identity로 합쳐질 수 있다. 따라서 distinct 후보가 같은 key를 만들 수 있고, 이때 exact origin은 복구할 수 없다. ambiguity를 fail-closed 하는 것이 이 변경의 명시적 정책이다.

---

## 4. 설계

### 4.1 origin 판정 우선순위

`resolveOriginTarget`은 source channel과 target을 `trim()`하고, channel만 소문자로 정규화한다. `request.sessionKey`도 문자열 여부와 `trim()` 후 non-empty 여부를 확인한다.

| 정규화된 입력 | 동작 | resolver 호출 |
| --- | --- | --- |
| channel이 non-empty이고 `webchannel` 아님 | `null` | 안 함 |
| channel이 `webchannel`, `turnSourceTo`가 non-empty | `{ to: turnSourceTo }` | 안 함 |
| channel이 `webchannel`, target 없음, session key 있음 | 유일 일치 판정 | 함 |
| channel이 없거나 공백, session key 있음 | `turnSourceTo`를 무시하고 유일 일치 판정 | 함 |
| 유일 일치가 필요한데 session key가 null/누락/공백 | 진단 후 `null` | 안 함 |
| resolver가 없음 | 진단 후 `null` | 불가 |
| resolver 결과가 `resolved` | `{ to: peerId }` | 완료 |
| 결과가 `no_match`, `ambiguous`, unavailable 또는 error | 진단 후 `null` | 완료 |

명시적 `webchannel` + target 경로는 core가 제공한 exact origin metadata를 사용한다. channel이 없는 경우에는 target이 있더라도 상호 보강되지 않은 metadata이므로 사용하지 않고 session key 증명을 요구한다. resolver가 같은 target을 되찾을 수도 있고 다른 exact peer를 유일하게 되찾을 수도 있다.

account eligibility는 기존 `shouldHandleWebChannelApprovalRequest` gate가 계속 소유한다. 이 설계는 그 gate를 통과한 요청의 origin만 판정하며, explicit/persisted account binding이 없는 agent/cron/proactive 요청의 account 정책은 범위 밖이다.

`createClawApprovalNativeRuntimeSpec().transport.prepareTarget`에서도 `plannedTarget.target.to`가 없으면 `null`을 반환한다. `ANON_PEER_ID` 기본값은 제거한다. 이는 origin resolver 이후의 방어선이며, 승인 origin 경로의 어떤 층도 대상 부재를 임의 peer로 바꾸지 않게 한다.

### 4.2 파싱이 아닌 재도출과 유일성 판정

`session-route.ts`의 `resolveWebchannelSessionRoute(api, accountId, peerId)`가 inbound와 history에서 사용하는 동일한 route/key 생성 경로다. origin 복구도 admitted-peer proof ID별로 이 함수를 호출해 byte-equal key를 비교한다. session key 문자열 형식을 역파싱하지 않는다.

판정 알고리즘은 `packages/plugin/src/approval-origin.ts`에 작고 동기적인 helper로 둔다.

```ts
export type ApprovalOriginMatch =
  | { kind: "resolved"; peerId: string }
  | { kind: "no_match" }
  | { kind: "ambiguous" };

export function resolveApprovalOriginCandidate(params: {
  requestedSessionKey: string;
  admittedPeerIds: readonly string[];
  deriveSessionKey: (peerId: string) => string;
}): ApprovalOriginMatch;
```

helper는 일치하는 exact candidate ID를 전부 수집한 뒤 0개면 `no_match`, 1개면 `resolved`, 2개 이상이면 `ambiguous`를 반환한다. `peerId`는 `resolved`에만 노출한다. derivation 중 하나라도 예외가 나면 부분 집합을 근거로 선택하지 않고 호출자가 전체 판정을 `resolver_error`로 바꾼다.

helper 자체는 외부 상태를 소유하지 않고 주입된 derivation을 적용한다. production과 핵심 테스트에서는 mock key 함수가 아니라 다음 실제 closure를 넘긴다.

```ts
(peerId) =>
  resolveWebchannelSessionRoute(api, runtime.accountId, peerId).sessionKey
```

이 방식은 `resolveAgentRoute`, forced `per-account-channel-peer` scope, `buildAgentSessionKey`, `identityLinks`를 inbound와 동일하게 통과시킨다. 다만 동일 key가 exact peer 하나를 뜻한다고 가정하지 않고 유일성을 별도로 증명한다.

### 4.3 non-shrinking admitted-peer proof 집합

유일성 판정의 universe로 `peerSubscriptions`를 사용하면 안 된다. 그 Map은 unregister, cap eviction, dispose 때 줄어든다. 같은 key를 만드는 exact ID가 둘인데 실제 origin이 판정 전에 제거되면, 남은 충돌 peer가 겉보기에는 유일해져 승인 프레임을 받을 수 있다.

기존 per-account `ConversationKeyStore`를 proof universe로 사용한다. register admission이 성공할 때 exact JWT peer ID에 대한 conversation key가 `getOrCreate`로 먼저 영속화되고, store에는 삭제 API가 없으며 정상 운용에서 entry가 제거되지 않는다. 다음 읽기 전용 snapshot을 추가한다.

```ts
// conversation-key-store.ts
listPeerIds(): string[];

// nats-channel.ts
listAdmittedPeerIds(): string[] | null;
```

`ConversationKeyStore.listPeerIds()`는 lazy-load된 persistent Map key의 복사본을 반환한다. `NatsChannel.listAdmittedPeerIds()`는 key store가 있으면 이 API에 위임하고, 없으면 `null`을 반환한다. production resolver는 `null`을 `admission_store_unavailable`로 fail-closed 하며 `peerSubscriptions`로 대체하지 않는다. 빈 store는 정상적인 빈 proof 집합이므로 helper 결과가 `no_match`다.

unregister, cap eviction, channel dispose 또는 gateway 재시작 뒤에도 admitted ID가 proof 집합에 남으므로 collision은 계속 `ambiguous`다. 현재 registration은 origin 증명의 조건이 아니다. 유일하게 증명된 origin이 현재 offline이어도 그 exact ID를 반환할 수 있고, 즉시 publish 실패 시 기존 pending-approval/reconnect snapshot 경로가 같은 ID에 나중에 전달할 수 있다. 반대로 ambiguity에서는 `null`이며 현재 남아 있는 충돌 peer를 포함해 어떤 subject에도 publish하지 않는다.

proof와 delivery liveness는 분리한다. `sendApprovalRequest()`가 `true`여도 publish 수행만 뜻하며 widget receipt를 증명하지 않는다. 이번 변경은 heartbeat/disconnect protocol을 추가하지 않는다.

### 4.4 주입 계약과 runtime 구현

`approvals.ts`에 동기 callback과 구조화 결과를 정의한다.

```ts
export type ApprovalOriginUnresolvedReason =
  | "runtime_unavailable"
  | "install_unavailable"
  | "admission_store_unavailable"
  | "no_match"
  | "ambiguous"
  | "resolver_error";

export type ApprovalOriginResolution =
  | { kind: "resolved"; peerId: string }
  | { kind: "unresolved"; reason: ApprovalOriginUnresolvedReason };

export type ResolveApprovalOriginPeer = (params: {
  cfg: OpenClawConfig;
  accountId: string | null | undefined;
  sessionKey: string;
}) => ApprovalOriginResolution;
```

`createClawApprovalCapability`의 세 번째 인자와 `createWebChannelPlugin`의 option으로 이 callback을 optional하게 추가한다. optional인 이유는 기존 단일 생성 호출부의 source compatibility뿐이다. callback이 없을 때의 의미는 `resolver_unavailable` + `null`이며 이전 고정 대상 동작을 보존하지 않는다.

`nats-account-runtime.ts`의 callback은 다음 순서로 동작한다.

1. `accountId ?? "default"`로 `accountRuntimes`를 조회한다. 없으면 `runtime_unavailable`.
2. `accountCoordinator.currentInstall()`을 조회한다. 없으면 `install_unavailable`.
3. `createAccountExecutionApi(install, cfg)`로 현재 config를 포함한 API를 만든다.
4. `runtime.channel.listAdmittedPeerIds()`를 읽는다. `null`이면 `admission_store_unavailable`; 빈 배열은 그대로 helper에 전달한다.
5. non-shrinking admitted-ID snapshot과 실제 `resolveWebchannelSessionRoute` closure를 helper에 전달한다.
6. helper의 세 결과를 callback 결과로 매핑한다.
7. snapshot load, route, key derivation을 포함한 예외는 catch해서 `resolver_error`로 반환한다.

`resolveOriginTarget`도 callback 전체를 `try/catch`로 감싸므로 잘못된 외부 구현이 throw해도 SDK 경계를 넘지 않는다.

### 4.5 진단 소유권과 성능

미해결 진단의 단일 소유자는 `approvals.ts`의 `resolveOriginTarget`이다. runtime callback과 helper는 로그를 쓰지 않고 reason만 반환한다. resolver가 필요한 호출 하나당 다음 형식의 warn을 최대 한 줄 남긴다.

```text
event=webchannel.approval.origin_unresolved accountId=<masked> reason=<reason> sessionKey_present=<true|false>
```

outer layer가 자체적으로 만드는 reason은 `missing_session_key`, `resolver_unavailable`, callback throw의 `resolver_error`다. callback이 반환하는 reason은 그대로 쓴다. account 필드는 `formatAccountIdForLog(accountId ?? DEFAULT_WEBCHANNEL_ACCOUNT_ID)`로 만들고 session key, peer ID, candidate ID는 기록하지 않는다. 명시적 타 채널의 `null`은 정상적인 비소유 판정이므로 warn 대상이 아니다. ambiguity 로그에도 raw ID를 넣지 않는다.

비용은 승인 한 건마다 admitted ID 수만큼 `resolveAgentRoute`를 호출하는 O(n)이다. 각 ID에 대해 한 번씩 호출하며 store의 기존 `maxKeys`가 상한을 둔다. `identityLinks`나 binding 변경 뒤 stale 결과가 오배송을 만들 수 있으므로 캐시는 두지 않는다.

---

## 5. 구현 계획

1. `packages/plugin/src/approval-origin.ts`
   - `ApprovalOriginMatch`와 `resolveApprovalOriginCandidate` 추가.
2. `packages/plugin/src/approval-origin.test.ts`
   - 실제 `resolveWebchannelSessionRoute`/`buildAgentSessionKey` 경로를 이용한 unique, none/foreign, `identityLinks` ambiguity, `Alice`/`alice` ambiguity 검증.
3. `packages/plugin/src/conversation-key-store.ts`
   - persistent key ID를 복사하는 `listPeerIds()` 추가. 저장 형식이나 삭제 정책은 바꾸지 않는다.
4. `packages/plugin/src/nats-channel.ts`
   - key store에 위임하는 `listAdmittedPeerIds()` 추가. key store가 없으면 `null`; `peerSubscriptions` fallback은 금지한다. `WebChannelPeerChannel` 전송 인터페이스는 확장하지 않는다.
5. `packages/plugin/src/approvals.ts`
   - callback/result 타입과 세 번째 optional 인자 추가.
   - §4.1 우선순위, callback catch, privacy-safe 단일 진단 구현.
   - `prepareTarget`의 고정 대상 기본값 제거; 대상이 없으면 `null`.
   - 승인 origin 경로에서 불필요해진 `ANON_PEER_ID` import와 낡은 주석 제거.
6. `packages/plugin/src/channel.ts`
   - `opts.resolveApprovalOriginPeer`를 capability에 그대로 전달.
7. `packages/plugin/src/nats-account-runtime.ts`
   - §4.4 callback 구현 후 plugin 생성 option으로 전달.
8. 관련 테스트 파일
   - capability, proof-store persistence, fail-closed, production wiring을 각각 가장 가까운 seam에서 고정.

---

## 6. 테스트 계획과 게이트

### 6.1 순수 판정·실제 key 생성

`approval-origin.test.ts`는 test API의 `runtime.channel.routing.resolveAgentRoute`를 통해 실제 `resolveWebchannelSessionRoute`를 실행한다. derivation 자체를 문자열 fixture로 대체하지 않는다.

| 케이스 | 기대 |
| --- | --- |
| peer A의 실제 key, 후보 A/B | `resolved(A)` |
| webchannel 후보로 만들 수 없는 key 또는 타 채널 key | `no_match` |
| `identityLinks`의 두 alias가 같은 canonical identity | `ambiguous` |
| distinct 후보 `Alice`/`alice`가 같은 normalized key 생성 | `ambiguous` |
| 유일 후보의 exact ID가 `web-anon`이고 key도 일치 | 일반 `resolved(web-anon)` |
| colliding origin이 unregister/cap-evict된 뒤에도 admitted snapshot에 둘 다 존재 | 계속 `ambiguous` |

### 6.2 capability와 실패 경로

`approvals.test.ts`에서 다음을 고정한다.

- `" WebChannel "` + non-empty target은 trim된 exact target을 직접 사용한다.
- 명시적 타 채널은 `null`이며 resolver를 호출하지 않는다.
- channel null/공백 + uncorroborated `turnSourceTo`는 target을 직접 쓰지 않고 session-key resolver 결과를 쓴다.
- resolver 경로에서 session key가 누락/null/공백이면 resolver를 호출하지 않고 `null`이다.
- resolver 미주입은 `null`이다.
- `no_match`, `ambiguous`, admission store/runtime/install unavailable, callback throw는 모두 `null`이다.
- 각 미해결 경로의 warn은 한 줄이고 raw session key/peer ID를 포함하지 않는다.
- `prepareTarget`은 planned target 부재 시 `null`이며 임의 peer를 만들지 않는다.

### 6.3 proof persistence, 배선, 집중 통합

- `conversation-key-store.test.ts`: 여러 admitted ID의 `listPeerIds()` snapshot을 검증하고 새 store instance로 reopen한 뒤에도 동일 ID가 남으며 public API 동작으로 줄지 않음을 고정한다.
- `nats-channel` 테스트: unregister와 cap eviction은 live subscription을 제거하지만 `listAdmittedPeerIds()`에서는 ID를 제거하지 않는다. key store 없는 channel은 `null`을 반환한다.
- `channel.test.ts`와 `index-nats-wiring.test.ts`: option이 capability까지 전달되고 NATS runtime이 실제 callback을 제공하는지 고정한다.
- 새 focused routing/delivery integration test: 두 peer를 admit한 `NatsChannel`, capture transport, 실제 session route derivation, 주입 resolver, capability origin 판정, native `prepareTarget`/`deliverPending`을 한 경로로 실행한다. unique peer A의 key는 A의 exact outbound subject에만 publish되고 B subject에는 publish되지 않음을 검증한다. collision 케이스에서는 origin ID를 unregister 또는 cap-evict한 뒤에도 `ambiguous`이고 남은 peer subject를 포함해 publish가 0건임을 검증한다. unique but offline origin은 그대로 resolve되며 기존 pending/reconnect snapshot이 그 exact ID를 보존하는지도 고정한다.
- focused two-account test: 두 account에 같은 peer ID를 admit하고 all-null `turnSource*` + account A의 session key를 입력한다. account A resolver만 match/publish하고 account B resolver는 `no_match`로 어떤 frame도 publish하지 않음을 검증한다. 기존 account eligibility 정책 자체는 재설계하지 않는다.

선택적 운영 smoke는 merge gate와 분리한다. 실제 gateway/NATS/browser 형상에서 peer A의 write 툴을 실행해 A widget에만 카드가 보이고 peer B에는 보이지 않는지 확인할 수 있지만, 자동화 게이트의 publish 증명을 대체하지 않는다.

의존성이 repository 표준 절차로 준비된 뒤 다음을 실행한다. 현재 worktree의 dependency 설치 상태를 전제하지 않는다.

```bash
npm run build
npm run typecheck
npm test --workspace=packages/plugin
npm test
```

모든 명령은 실패 0이어야 한다.

---

## 7. 리스크와 기각한 대안

| 항목 | 판단 |
| --- | --- |
| admitted proof 집합의 단조 증가 | offline/evicted ID도 남아 collision이 영구 ambiguity가 될 수 있다. 오배송보다 fail-closed를 택하며 기존 `maxKeys`가 공간 상한을 둔다. |
| key store 부재/읽기 실패 | production resolver는 live subscription으로 대체하지 않고 `admission_store_unavailable`/`resolver_error`로 닫는다. |
| offline unique origin | exact origin은 증명되지만 즉시 receipt는 보장하지 못한다. 기존 pending/reconnect 경로가 동일 ID를 보존한다. |
| 같은 key의 여러 exact 후보 | 선택하면 오배송 가능성이 있으므로 `ambiguous`로 fail-closed 한다. upstream exact metadata가 장기 해법이다. |
| config reload 중 derivation 실패 | 일부 후보만으로 선택하지 않고 전체를 `resolver_error`로 닫는다. 캐시도 두지 않는다. |
| session key 역파싱 | key 형식에 결합되고 case normalization/`identityLinks`의 비단사성을 해결하지 못해 기각한다. |
| 후보 순서에 따른 반환 | Map 삽입 순서가 승인 권한이 될 수 있어 기각한다. |
| `web-anon` 특례 | 현재 admission 계약과 맞지 않고 존재하지 않는 대상 드롭을 재현하므로 기각한다. literal ID는 일반 unique-match 후보로 충분하다. |
| 모든 후보로 브로드캐스트 | 승인 정보와 권한을 다른 peer에 노출하므로 금지한다. |
| active-turn registry 추가 | 정확한 상관관계를 만들 수 있지만 상태 수명·동시성·복구 설계가 필요해 #93의 최소 복구 범위를 넘는다. |
| core에서 `turnSourceTo` 보장 | exact origin을 전달하는 올바른 장기 해법이다. upstream 구현은 범위 밖이며, 나중에 제공되면 명시적 channel + target 우선 경로가 자동으로 사용한다. |

---

## 8. 범위 밖

- `execApprovals.approvers` 설정 UX 및 approver 정책 변경
- core의 `turnSourceChannel`/`turnSourceTo` population 구현
- peer heartbeat/disconnect protocol과 liveness 기반 후보 제거
- approval widget 문구·렌더링 변경
- agent-initiated/cron approval의 별도 origin 정책
- #94(final이 draft를 덮어써 앞 메시지 소실)

---

## 9. 완료 정의

- [ ] 정규화/우선순위 표의 모든 분기가 capability 테스트로 고정된다.
- [ ] 실제 route/key 생성 기반 unique, no-match, case-fold ambiguity, `identityLinks` ambiguity 테스트가 green이다.
- [ ] `ConversationKeyStore.listPeerIds()`가 reopen을 넘어 admitted ID를 보존하고, unregister/cap eviction이 proof 집합을 줄이지 않는다.
- [ ] colliding origin이 live subscription에서 사라진 뒤에도 ambiguity가 유지되며 survivor subject publish는 0건이다.
- [ ] 0개/복수 일치, missing key, proof store/resolver/runtime/install 부재, 예외가 모두 privacy-safe 진단 한 줄과 `null`로 끝난다.
- [ ] `web-anon`은 unique-match가 증명한 literal peer 외에는 선택되지 않으며 승인 origin 경로에 고정 대상 fallback이 없다.
- [ ] production callback 배선과 two-account all-null-metadata/sessionKey 격리 테스트가 green이다.
- [ ] 집중 통합 테스트가 unique approval publish를 exact peer subject 하나로 제한하고 ambiguity publish를 막음을 증명한다.
- [ ] build, typecheck, plugin suite, 전체 test가 실패 0이다.
- [ ] active-turn registry, liveness, broadcast, UX, approver policy, upstream core 구현이 diff에 들어오지 않는다.
