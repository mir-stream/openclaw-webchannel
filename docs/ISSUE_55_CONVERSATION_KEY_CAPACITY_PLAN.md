# Issue #55 — conversation-key capacity fail-closed 구현 기획서

> 상태: Final — 적대적 리뷰 R7 PASS (P0/P1/P2 0건)
> 기준 브랜치: `develop` (`11bd90b`, PR #39 병합 포함)로 rebase 완료
> 대상 이슈: https://github.com/mir-stream/openclaw-webchannel/issues/55

## 1. 배경과 문제 정의

WebChannel의 agent-side plugin은 OpenClaw Gateway 프로세스가 실행되는 머신에 계정별
conversation-key store를 둔다.

```text
~/.openclaw-webchannel/<accountId>/conversation-keys.json
```

한 entry는 한 브라우저 장치가 아니라 한 `peerId`(검증된 JWT `sub`)에 대응한다. 같은
사용자의 여러 장치는 register reply에서 각 장치 키로 감싼 동일한 conversation key `K`를
받는다. 실시간 메시지와 저장된 history 모두 이 `K`에 의존하므로, 한 번 발급한 `K`는 장치
추가·재접속·Gateway 재시작 뒤에도 바뀌면 안 된다.

현재 `ConversationKeyStore.getOrCreate()`는 store가 `maxKeys`(기본 10,000)에 도달하면
가장 오래 생성된 key를 삭제한 뒤 신규 peer의 key를 저장한다. 삭제된 peer가 다시 등록하면
새 `K`가 생성되어 다음 상태가 된다.

```text
기존 장치 / 기존 history -> K-old
재등록 장치 / agent      -> K-new
```

이는 메모리 캐시 eviction이 아니라 복호화의 영구 기준을 삭제하는 행위다. 이 PR은 용량
경계에서 기존 암호 상태를 파괴하지 않고 신규 admission만 명시적으로 거부하도록 바꾼다.

## 2. 확정된 제품 결정

1. **10,000은 계정별 고정 안전 한도다.** 정상 용량 계획이 아니라 잘못된 issuer/account
   routing 또는 비정상적인 `sub` churn이 로컬 JSON store를 무한히 키우는 일을 막는 방어선이다.
2. `maxKeys`를 OpenClaw 공개 설정이나 환경 변수로 노출하지 않는다. 기존 constructor
   override는 작은 deterministic test를 위해서만 유지한다.
3. cap 도달은 기존 key 삭제가 아니라 신규 peer admission failure다.
4. capacity failure는 재인증이나 같은 요청의 재시도로 해결되지 않는 terminal 상태다.
5. operator 진단에는 account ID와 `current/max`만 사용한다. peer ID와 key material은 capacity
   로그·오류에 넣지 않는다.
6. PR #39가 병합된 `develop@11bd90b` 위에서 구현한다.
7. 한 account store에는 한 시점에 OpenClaw Gateway writer가 하나만 존재한다는 배포 전제를
   명시한다. 중복 Gateway process에 대한 cross-process locking은 별도 문제다.
8. 한 account가 정상적으로 10,000 peer를 넘어야 하는 경우 cap을 올리거나 key를 지우지 않고,
   새 WebChannel account shard를 만들고 **cutover 뒤 처음 생성·배정되는 새 cohort만** 그 account로
   routing한다. 기존 peer는 key/history continuity를 위해 원 account에 남긴다. 이미 old account에
   배정됐지만 아직 key가 없는 user도 이번 릴리스에 안전한 membership/reassignment 도구가 없으므로
   원 account에 남긴다.

## 3. 목표와 비목표

### 3.1 목표

- store가 full이어도 기존 peer 조회는 원래 key를 byte-identical하게 반환한다.
- 신규 peer가 full store에 도달하면 typed capacity error를 받고, store의 메모리·파일 상태는
  전혀 바뀌지 않는다.
- persistence가 실패해도 아직 디스크에 commit되지 않은 key가 메모리에 남지 않는다.
- capacity failure 전에 live subscription/session을 퇴거·생성하지 않는다.
- register reply는 안전하고 기계 판독 가능한 capacity 오류를 반환하며 wrapped key/history/
  approval snapshot을 내보내지 않는다.
- client와 demo UI는 이 상태를 terminal/non-reauth 상태로 정직하게 표시한다.
- cap 접근 시 registration traffic에 의해 한 번의 저소음 operational warning을 제공한다.
- full account에서도 기존 peer만 재접속하더라도 account별 process lifetime당 한 번 operational warning을
  제공한다.
- fixed cap에 도달한 account에서 key 삭제 없이 cutover 이후 신규 cohort를 수용하는
  account-sharding runbook을 제공한다.

### 3.2 비목표

- conversation-key store를 DB/KMS/공유 저장소로 이전하지 않는다.
- 10,000 이상의 정상 tenant scale을 지원한다고 선언하지 않는다.
- 자동 또는 ad-hoc peer-key 삭제/revocation workflow를 추가하지 않는다. 이번 릴리스의 지원되는
  capacity 확장은 새 account shard이며, 기존 peer를 shard 사이에서 이동시키지 않는다.
- cutover 전에 old account에 배정된 user는 실제 register/key 이력이 없어도 이번 릴리스에서 새
  shard로 재배정하지 않는다. full old account에 처음 register하려는 이 cohort는 별도 supported
  reassignment workflow 전까지 507을 받을 수 있다. 안전한 membership 조회/재배정 도구는 follow-up
  범위다.
- corrupt store의 기존 “rename aside + fresh store” 정책을 이번 PR에서 바꾸지 않는다. 암호
  연속성 관점의 fail-closed 전환은 별도 이슈로 다룬다.
- `NatsChannel.maxPeers`의 기존 live-peer eviction 정책 자체를 바꾸지 않는다. 다만 key capacity
  failure가 그 eviction보다 먼저 판정되도록 순서를 바로잡는다.
- metrics subsystem이나 공개 capacity 설정을 추가하지 않는다.
- #57이 도입한 mandatory protocol v2에서 version을 추가로 올리지 않는다. 아래 오류 추가는
  protocol v2를 구현한 #55 이전 client에서도 기존 terminal server error로 안전하게 degrade한다.
  pre-v2 client는 capacity gate 전에 426 protocol mismatch로 거부된다.

비목표인 cross-process lock과 corrupt-store 변경 때문에 아래 불변식은 **한 account당 단일 writer,
store 파일의 외부 수동 편집 없음, 정상적으로 parse 가능한 store**라는 전제에서 성립한다. 이
전제가 깨지면 Gateway를 추가 기동하지 말고 §5.7 runbook에 따라 먼저 writer를 하나로 줄인다.

## 4. 반드시 보존할 불변식

### I0. Single writer per account

한 account의 `conversation-keys.json`은 한 시점에 하나의 OpenClaw Gateway process만 쓴다. atomic
rename은 crash-safe file replacement이지 multi-writer transaction/CAS가 아니다. 중복 Gateway가
동시에 같은 파일을 쓰면 read→rename 사이 last-writer-wins membership loss가 남는다.

이번 PR은 신규 peer create 경로에서 cache miss 뒤 디스크를 한 번 fresh-read하여 순차적으로
겹친 old/new store instance의 stale snapshot overwrite를 막지만, 동시 writer를 직렬화하지는 않는다.
중복 Gateway detection/lease 또는 cross-process lock은 별도 follow-up으로 기록한다.

### I1. Stable key

I0와 정상 store 전제에서 `store.getOrCreate(peerId)`가 한 번 성공했다면 명시적인 미래
revocation/rotation 없이는 같은 store에서 항상 동일한 32-byte key를 반환한다.

### I2. Existing-first

cap 판정보다 기존 key lookup이 먼저다. `keys.size >= maxKeys`여도 `keys.has(peerId)`이면 성공한다.
기존 조회는 Map insertion order를 변경하지 않는다.

### I3. Reject-with-zero-mutation

full store의 신규 peer는 random key 생성, candidate Map commit, tmp write, rename을 하나도
일으키지 않는다. 외부 writer/file edit가 없다는 I0 전제에서 durable file의 membership, 각 key
bytes와 파일 bytes가 호출 전후 동일해야 한다. stale in-memory cache는 이미 disk에 durable한
membership을 fresh-read로 받아들여 늘 수 있지만 줄거나 이 호출이 만든 key를 얻을 수 없다.
Map/`Uint8Array` 객체 identity는 바뀔 수 있으므로 객체 동일성은 불변식이 아니다.

### I4. Durable-before-visible

신규 key는 atomic rename이 성공한 뒤에만 store의 authoritative in-memory Map으로 공개한다.
persistence throw 뒤 `get(peerId)`는 반드시 `null`이어야 한다.

### I5. Admission atomicity at capacity

capacity error가 발생한 register attempt는 다음을 남기거나 전송하지 않는다.

- `.in` subscription
- `peerSubscriptions` entry
- `peerSessionKeys` entry
- wrapped conversation key
- history snapshot
- approval snapshot
- success reply

기존 peer의 subscription/session/key는 그대로 유지한다.

corrupt-store recovery가 기존 live peer의 persisted entry를 제거한 예외 상태는 이번 PR의 비목표다.
그 상태에서 이미 subscribed된 peer가 재등록하다 capacity error를 받아도 기존 live Map state는
변경하지 않지만, I2의 “known persisted peer는 성공” 보장은 적용되지 않는다.

### I6. No retry loop

capacity reply를 받은 새 client는 reconnect/re-auth loop에 들어가지 않는다. terminal error를 한 번
surface하고 해당 connection generation을 닫는다.

### I7. Diagnostic minimization

capacity 관련 operator log는 account ID, 현재 key 수, cap, remediation만 포함한다. 거부된
peer ID와 어떤 stored peer ID도 포함하지 않는다. wire reply에는 count나 account ID도 넣지 않는다.

## 5. 상세 설계

### 5.1 ConversationKeyStore: typed error와 transactional commit

`packages/plugin/src/conversation-key-store.ts`에 다음 exported error를 추가한다.

```ts
export class ConversationKeyCapacityError extends Error {
  readonly accountId: string;
  readonly currentKeys: number;
  readonly maxKeys: number;
}
```

- `name = "ConversationKeyCapacityError"`를 고정한다.
- message에는 account/count/cap과 “existing keys preserved; new admission rejected” 의미만 담는다.
- peer ID는 constructor 인자로 받지도, message에 넣지도 않는다.
- `maxKeys`는 positive safe integer인지 constructor에서 검증한다. production 기본값은 계속
  10,000이며 override는 test-only 문서화를 유지한다.

`getOrCreate()`의 순서는 다음과 같이 고정한다.

```text
load process Map
  -> maybeWarnCapacity() for already-durable loaded state (best-effort, once)
  -> existing lookup: 있으면 즉시 반환
  -> cached size >= maxKeys면 fresh-read 없이 즉시 typed error (reject-fast)
  -> cache miss면 disk file을 non-quarantining fresh-read + parse
  -> maybeWarnCapacity() for fresh durable state (same process one-shot)
  -> fresh Map existing lookup: 있으면 process Map을 refresh하고 반환
  -> 신규이고 fresh size >= maxKeys: process Map을 refresh하고 typed error
  -> random key 생성
  -> next = new Map(fresh), next.set(peerId, key)
  -> persist(next): tmp write + atomic rename
  -> this.keys = next
  -> maybeWarnCapacity() (best-effort, commit 결과에 영향 없음)
  -> key 반환
```

`persist()`는 암묵적으로 `this.keys`를 읽지 않고 commit 후보 Map을 명시적으로 받는다. 이로써
write/rename 실패 시 authoritative Map이 이전 객체를 계속 가리킨다. rename 뒤 Map 대입은
동기적인 commit tail이며, 그 사이 process crash가 나도 다음 process는 rename된 완전한 파일을
읽으므로 디스크/메모리의 모순이 지속되지 않는다.

reject-fast는 안전하다. 이번 변경 뒤 entry를 제거하는 code path가 없고 corrupt reset과 외부 편집은
전제 밖이므로, I0 아래 cached Map은 durable Map보다 클 수 없다. 따라서 cached size가 이미 cap이면
disk도 cap 이상이며, fresh-read를 생략해도 존재하는 durable peer를 잘못 거부하지 않는다. 이는 full
store에 대한 매 거절을 10,000-entry 동기 read/parse/allocation으로 증폭시키지 않기 위한 필수 순서다.

cached size가 cap 미만인 신규 peer commit 후보 경로에서만 fresh-read한다. 이는 먼저 commit한 다른
store instance의 membership을 stale snapshot이 되살려 덮어쓰지 않게 한다. fresh-read는 다음과 같이
lazy `load()`의 기존 corrupt recovery와 **분리된 non-quarantining operation**으로 구현한다.

- `ENOENT`: 아직 생성되지 않은 store로 보고 빈 Map을 반환한다.
- 그 밖의 read 오류나 shape/base64/JSON parse 오류: 그대로 persistence error로 throw한다. `.corrupt-*`
  rename-aside를 실행하지 않고, `this.keys`는 이전 객체를 계속 가리키며 candidate Map도 만들지 않는다.
- fresh state의 existing/cap 판정이 끝난 뒤에만 `this.keys`를 fresh Map으로 교체한다. byte equality만
  계약이며, 이미 session에 전달한 key와 이후 lookup key의 객체 identity를 비교하지 않는다.

신규 admission은 매번 whole-file fresh-read와 candidate serialization을 하므로 store를 10,000까지
채우는 총 비용은 O(n²)이다. 정상 process/account가 이 수준에 도달할 가능성이 사실상 없고 correctness를
우선하는 고정 abuse guard라는 제품 판단 아래 수용한다. 반면 full reject는 cached Map 기준 O(1)이다.
두 process가 동시에 fresh-read한 뒤 각각 rename하는 TOCTOU는 막지 못한다. I0의 single-writer
precondition이 correctness boundary이며 atomic rename을 cross-process CAS로 표현하지 않는다.

### 5.2 90% operational warning

공개 설정이나 metrics 대신 fixed cap의 90%에 처음 도달했을 때 **account별 process lifetime당 한 번**
warning을 낸다. threshold 판정은 floating-point 반올림 없이
`currentKeys * 10 >= maxKeys * 9`로 고정한다. production에서는 정확히 `9,000/10,000`이다.

- store option에는 production logger를 전달하기 위한 좁은 `onCapacityWarning(status)` callback을
  `onCapacityWarning?: (status: CapacityStatus) => void` 이름으로 추가한다. 이는 cap 자체를 조절하는
  설정이 아니다.
- zero-Node-import leaf module `packages/plugin/src/capacity-status.ts`가
  `CapacityStatus = { accountId, currentKeys, maxKeys }`와 pure formatter 세 개를 export한다.

  ```ts
  formatCapacityWarning(status): string
  formatCapacityReject(status): string
  formatCapacityRejectSummary(status, suppressedCount): string
  ```

  warning/first full-remediation/summary 문구의 각 단일 owner다. 모든 formatter input에는 peer ID나 key가
  존재하지 않는다. store module은 호환되는 내부 import surface를 위해 leaf에서 다음처럼 type/value를
  구분해 re-export한다(`verbatimModuleSyntax` 준수).

  ```ts
  export type { CapacityStatus } from "./capacity-status.js";
  export { formatCapacityWarning } from "./capacity-status.js";
  ```
- load 직후 이미 threshold 이상이면 **full/over-cap 포함** 첫 접근에서 한 번 경고한다. full이면
  “new peers are rejected” 문구를 사용한다.
- 신규 commit이 threshold를 처음 넘을 때는 rename 성공과 `this.keys = next` 뒤에 경고한다.
- one-shot flag는 durable state가 threshold 이상임을 확인한 뒤 callback 호출 전에 세운다. callback이
  throw해도 catch하여 registration/key commit 결과에 절대 영향을 주지 않고 privacy-safe
  `console.warn(formatCapacityWarning(status))` fallback만 시도한다. diagnostic failure를 register
  failure로 바꾸지 않는다.
- 문구는 정상 확장 안내가 아니라 비정상 `sub` 증가, issuer/audience/account routing을 조사하고
  key 파일을 ad-hoc 삭제하지 말며 §5.7 account-sharding runbook을 따르라는 remediation을 제공한다.

한 process가 9,000에서 approaching warning을 이미 냈다면 같은 process에서 10,000이 되어도 full
warning을 추가로 내지 않는다. 이후 첫 신규-peer capacity reject의 full-remediation error log가 full
전환 신호를 담당한다.

warning은 store construction/startup 자체가 아니라 첫 `get()`/`getOrCreate()`가 lazy load를 일으킬 때
발생하는 **registration-traffic-triggered signal**로 한정한다. 별도 startup scan/I/O나 persistent
health finding은 이번 범위에 추가하지 않는다.

신규-peer capacity reject log도 무제한 per-attempt로 남기지 않는다. side-effect-free
`packages/plugin/src/capacity-diagnostics.ts`에 다음 helper를 둔다.

```ts
type CapacityLogger = {
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

createCapacityDiagnostics({ logger?: CapacityLogger, now: Date.now })
  -> { onCapacityWarning, onCapacityReject }
```

helper는 warning formatter 전달과 reject limiter state만 소유한다. `onCapacityWarning(status)`는
`formatCapacityWarning(status)`의 반환 문자열을 변경 없이 `(logger?.warn ?? console.warn)`에
전달한다. `onCapacityReject`의 first/summary line은 각각 `formatCapacityReject`와
`formatCapacityRejectSummary`를 사용하고 `(logger?.error ?? console.error)`에 전달한다.
`capacity-diagnostics.ts`는 세 formatter와 `CapacityStatus`를 모두 zero-Node leaf
`./capacity-status.js`에서 직접 import한다.
`onCapacityReject(status)`는 capacity branch 전용 callback이며 기존 `deps.logger`를 감싸거나 대체하지
않는다. 두 callback의 logger 호출은 best-effort다. logger가 throw하면 privacy-safe console fallback을
시도하되 그 실패도 삼켜 key commit이나 507 reply를 바꾸지 않는다.

`index-nats.ts` 구현은 account serving loop의 각 iteration에서 helper를 만들고 같은 instance의 warning
callback을 `ConversationKeyStore`에, reject callback을 모든 해당 account register request에 재사용한다.
그러나 correctness는 배치 위치에 의존하지 않는다. helper 내부 limiter는
`Map<accountId, { nextSummaryAt, suppressedCount }>`로 상태를 분리하며 entry는 실제 configured store가
전달한 account에 대해서만 생기므로 production 크기는 serving account 수 이하로 bounded다. 전역 helper로
refactor해도 account window가 섞이지 않는다. limiter는 capacity branch에만 적용되고
JWT/tenant/subject/PoP 등 기존 security log는 제한하지 않는다. 규칙은 다음으로 고정한다.

- 해당 `status.accountId`의 첫 reject는 `formatCapacityReject(status)` 한 줄을 남기고 그 account의
  `nextSummaryAt = now + 60s`로 둔다.
- 이후 reject는 먼저 `suppressedCount`를 올린다. 그 reject의 `now >= nextSummaryAt`이면 trigger가 된
  현재 reject까지 포함한
  `formatCapacityRejectSummary(status, suppressedCount)` 한 줄을 남긴 뒤 해당 account count를 0,
  다음 시각을 `now + 60s`로 갱신한다. background timer는 두지
  않으므로 churn이 멈춘 마지막 window의 suppressed tail은 보고되지 않을 수 있다. 첫 full-remediation
  line은 항상 남아 있으므로 이 count loss를 수용한다.
- full warning과 reject logger state는 목적이 다른 별도 one-shot/limiter다. 둘 모두 peer ID나 key를
  받지 않는다. 첫 line과 모든 summary의 account ID는 callback이 받은 `status.accountId`를 단일
  authority로 사용하며 current/max도 같은 status에서 얻는다. process restart 뒤 초기화되는 것은
  의도한 동작이다.
- production clock은 `Date.now`다. wall clock이 뒤로 이동하면 summary가 늦고 앞으로 이동하면 한 번
  일찍 나올 수 있으나 admission/reply 상태에는 영향이 없어 수용한다. fake clock은 test에서만 쓴다.

PR #39로 병합된 doctor에 별도 persistent finding이나 metrics를 추가하지 않는다. 이 값은 공개
조정값이 아니며 정상적으로는 도달하지 않는 runtime abuse guard다. develop에 doctor가 존재하지만
이번 구현과 새로운 결합은 만들지 않는다.

### 5.3 NatsChannel: capacity 판정을 session mutation보다 앞에 둔다

현재 신규 peer 경로는 다음 순서다.

```text
live maxPeers eviction -> subscribe -> keyStore.getOrCreate -> session key install
```

key store만 fail-closed로 바꾸면 capacity error 전에 기존 live peer가 퇴거될 수 있다. 신규 peer
경로를 다음 순서로 바꾼다.

```text
keyStore.getOrCreate (durable key 확보 또는 capacity throw; channel mutation 없음)
  -> live maxPeers 정책 수행
  -> subscribe
  -> peerSubscriptions install
  -> peerSessionKeys install
```

- 이미 등록된 peer 경로도 기존 key 확보가 성공한 뒤에만 `peerSessionKeys.set`한다.
- 신규 key가 durable하게 생성된 뒤 `transport.subscribe`가 별도 이유로 실패할 수는 있다. 검증된
  peer의 durable key가 남는 것은 허용한다. 다음 register가 동일 key로 회복하며 암호 연속성을
  해치지 않는다. 한 번도 subscription에 성공하지 못한 verified peer도 한 slot을 소비하는 것은
  durable-before-visible을 택한 결과로 수용한다.
- live `maxPeers` eviction의 설계 자체는 바꾸지 않는다. persisted key가 삭제되지 않으므로 이번
  이슈의 cryptographic continuity 범위 밖이다.

### 5.4 Register handler: safe capacity reply

`packages/plugin/src/nats-register.ts`에 다음 상수를 추가한다.

```ts
export const REGISTER_CAPACITY_EXCEEDED = JSON.stringify({
  error: "capacity_exceeded",
  code: 507,
});
```

507은 이 NATS request/reply 프로토콜의 HTTP-like status vocabulary에서 “이 representation을
저장할 고정 capacity가 없다”는 영구적 storage failure를 500/503과 구분한다.

register success block의 단일 catch 안에서 capacity structural guard를 generic 500 분기보다 먼저
처리한다. `nats-register.ts`는 store class를 value-import하지 않고 `instanceof`도 사용하지 않는다.
다른 module instance에서도 동일하게 동작하도록 다음 name+shape predicate만 사용한다.

```ts
type CapacityErrorShape = {
  name: "ConversationKeyCapacityError";
  accountId: string;
  currentKeys: number;
  maxKeys: number;
};

function isConversationKeyCapacityError(err: unknown): err is CapacityErrorShape {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  return e.name === "ConversationKeyCapacityError"
    && typeof e.accountId === "string" && e.accountId.length > 0
    && Number.isSafeInteger(e.currentKeys) && (e.currentKeys as number) >= 0
    && Number.isSafeInteger(e.maxKeys) && (e.maxKeys as number) > 0;
}
```

over-cap legacy store도 있으므로 discriminator 자체는 `currentKeys >= maxKeys`를 요구하지 않는다.
name은 같지만 shape가 잘못된 오류는 capacity로 신뢰하지 않고 500을 반환한다. 이 malformed-capacity
분기는 dynamic error string이나 peer ID를 함께 기록하지 않고 고정된 내부 계약 위반 문구만 남긴 뒤
generic persistence/crypto 오류와 구분한다. 이 branch는 attacker가 store의 throw shape를 만들 수 없는
내부 bug 신호이므로 capacity limiter 밖에서 매번 기록하는 것을 수용한다.

`RegisterHandlerDeps`에는 다음 narrow optional seam 하나를 추가한다.

```ts
import {
  formatCapacityReject,
  type CapacityStatus,
} from "./capacity-status.js";

onCapacityReject?: (status: CapacityStatus) => void;
```

handler는 store module을 value-import하지 않는다. `formatCapacityReject`의 value import는 zero-Node
leaf만 가리키므로 `node:fs` 등을 handler runtime graph에 넣지 않는다.

capacity branch는 이 callback이 있으면 primary diagnostic로 사용하며 `deps.logger`로 중복 기록하지
않는다(callback throw 시 console fallback만 예외다). callback이 없으면 기존/third-party wiring의
진단을 잃지 않도록 `deps.logger.error`로 같은
`formatCapacityReject(status)`를 매번 남기는 verbose fallback을 쓴다. handler는 guarded error에서
`{ accountId: e.accountId, currentKeys: e.currentKeys, maxKeys: e.maxKeys }` 새 object를 명시적으로 만들어
`CapacityStatus`에 `name`이나 다른 field가 섞이지 않게 한다.

capacity branch의 절대 순서는 **`reply(REGISTER_CAPACITY_EXCEEDED)` 먼저, diagnostics 나중**이다.
callback이 있으면 이를 호출하고, throw하면 `deps.logger.error`로 중복 시도하지 않고 곧바로
`console.error(formatCapacityReject(status))` fallback을 시도한다. callback이 없을 때만
`deps.logger.error(formatCapacityReject(status))`를 쓰고, 이것이 없거나 throw하면 같은 console
fallback을 시도한다. 전체 diagnostic block에 outer `try/catch`를 두고 각 logger/fallback 호출도 독립
`try/catch`로 감싸 어떤 throw도 handler 밖으로 나가지 않게 한다.
diagnostic은 wire outcome의 전제 조건이 아니며 실패해도 두 번째 reply를 보내지 않는다. diagnostics
helper나 그 callback을 `deps.logger` 자리에 전달하는 구현은 금지한다. non-capacity security log call
sites는 기존 `deps.logger`를 그대로 사용한다.

- operator error log: 명시적으로 만든 status의 account ID와 `current/max`, 기존 key 보존, 신규
  admission 거부, issuer/account routing 조사 및 §5.7 runbook 안내. 첫 줄과 60초 summary는 §5.2의
  account-scoped `onCapacityReject`를 거친다. `RegisterHandlerDeps`에 account ID를 별도 field로
  추가하지 않는다.
- wire: `REGISTER_CAPACITY_EXCEEDED`
- peer ID 없는 별도 로그 문구 사용
- `return`하여 generic `REGISTER_FAILED`를 중복 reply하지 않음

capacity throw는 `registerPeer`에서 발생하므로 wrap/history/approval 호출 전 제어가 빠져나간다.
다른 persistence/crypto/history 오류는 기존 `REGISTER_FAILED`(500) 의미를 유지한다.

기존 module doc의 “reply channel is never an oracle” 설명도 고친다. 507은 JWT/tenant/subject/PoP/cnf
검증이 모두 끝난 뒤 자기 peer의 admission에서만 관찰 가능하고, account/count/peer 목록을 싣지
않는다. relay는 이미 401/500 reply forge/drop으로 동일한 DoS를 만들 수 있으므로 이 분류가 새로운
trust 결정을 만들지는 않는다.

### 5.5 Client: typed terminal classification

`packages/client/src/pop-register.ts`에 `PopCapacityError extends Error`를 추가한다. `PopServerError`의
subclass로 만들지 않아 branch-shadowing 가능성을 제거한다.

- `error === "capacity_exceeded" && code === 507`일 때 이 class를 throw한다.
- `isTerminalRegisterError()`는 `PopCapacityError`를 별도 disjunct로 terminal 분류한다.
- 503만 기존처럼 transient retry하며 507은 같은 challenge/register unit이나 reconnect에서 retry하지
  않는다.
- 알 수 없는 non-401/non-503 error는 계속 `PopServerError`다.

`WebChannelErrorCause`에 `"capacity"`를 추가하고 `nats-client.ts`의 cause chain에서
`PopCapacityError`를 `PopServerError`보다 명시적으로 먼저 검사하여 이 cause로 매핑한다.
`failConnectionEpoch`의 기존 terminal sweep을 그대로 사용하므로 queued/unacked send도
`failed{reason:"terminal", cause:"capacity", retryable:false}`로 수렴한다.

`PopCapacityError` class 자체는 package root에서 새로 export하지 않는다. 공개 `registerWithPop`의
기존 server-class error인 `PopServerError`도 root export가 아니며, embedder의 지원 계약은
`WebChannelState.errorCause === "capacity"`다. direct module test만 class identity를 사용한다.

호환성은 다음과 같다.

- 새 plugin + protocol-v2를 구현한 #55 이전 client: client는 507을 기존
  `PopServerError`/`server` terminal로 처리한다. 재시도 폭주는 없고 표현만 덜 구체적이다.
- pre-v2 client: mandatory protocol gate에서 426을 받고 capacity 판정까지 도달하지 않는다.
- protocol-v2를 구현한 #55 이전 plugin + 새 client: 새 오류를 받지 않으므로 동작 변화가 없다.
- 따라서 #55 capacity 오류를 위해 v2에서 protocol version을 추가로 올릴 필요는 없다.

### 5.6 Demo UI copy

`demo/web/src/error-copy.ts`의 exhaustive `Record<WebChannelErrorCause, ...>`에 `capacity`를 추가한다.

- heading: agent-side capacity에 도달했음을 설명
- hint: 재인증/새로고침이 해결하지 못하며 OpenClaw operator에게 문의하라고 안내
- `showReauth: false`

구 bundle이 미래 cause를 받을 때 `unknown`으로 degrade하는 기존 방어는 유지한다.

### 5.7 운영 문서

`packages/plugin/README.md`에 다음을 문서화한다.

- cap은 SaaS 전체가 아니라 한 OpenClaw 설치의 WebChannel account별 persisted peer-key 수다.
- 장치 수가 아니라 peer 수다.
- 10,000은 고정 abuse/misconfiguration guard이며 정상 scale knob가 아니다.
- 90% warning 또는 capacity error를 보면 issuer, audience, account routing과 비정상 `sub` churn을
  조사한다.
- 기존 user는 계속 같은 key/history를 사용하고 신규 peer만 거부된다.
- `conversation-keys.json`에서 임의 entry를 삭제하거나 파일 전체를 지우지 않는다.
- 정상적으로 10,000을 넘는 요구가 생기면 JSON cap을 올리는 것이 아니라 다음 account-sharding
  runbook으로 cutover 이후 생성되는 cohort를 새 account에 수용한다.
- 이번 릴리스에는 key revocation/retention workflow가 없으며 자동 deletion도 없다.

지원되는 capacity incident/expansion runbook은 다음으로 고정한다.

shard 증설의 선행 조건은 operator CLI만으로 충족되지 않는다.

- embedding application이 사용자별로 client `accountId`를 선택할 수 있어야 하고, SaaS bootstrap도
  그 사용자에게 같은 account의 `aud`를 mint해야 한다. 이는 application routing 변경이다.
- old/new shard의 audience는 각각 **scalar이며 서로 달라야 한다**. `bootstrap-claims.ts`가 지원하는
  multi-`aud` array에 old/new account를 함께 넣거나 audience를 재사용하면 같은 peer가 두 shard에서
  서로 다른 K/history namespace를 받으므로 #55의 장애를 그대로 재현한다.
- 새 traffic 전 `doctor`의 `shared-audience` error와 `verifier-unbuildable` finding이 하나도 없어야 한다.
- 기존 key file을 열어 peer별 membership을 판별하지 않는다. application DB에 immutable
  `webchannelAccountId`와 cutover timestamp D를 둔다. D 이후 생성된 account/user에는 처음부터 새
  shard를 원자적으로 배정하고 old-account bootstrap 발급을 허용하지 않아 “이전에 등록된 적 없음”을
  보장한다. timestamp만 보고 이미 old account token을 받은 사용자를 옮기지 않는다. D 이전에 old
  account로 배정된 user는 실제 key가 없어도 이번 runbook으로 재배정하지 않으며, 별도 supported
  membership/reassignment workflow 전까지 full account에서 첫 registration이 거부될 수 있다.
- doctor는 configured issuer/audience 충돌을 검사하지만 실제 발급된 bootstrap token의 multi-`aud`는
  볼 수 없다. bootstrap mint call은 immutable `webchannelAccountId`가 string인지 runtime assert한 뒤
  그 scalar 값만 `accountId`로 전달해야 한다. traffic 전 각 cohort의 sample bootstrap claim을 로그에
  남기지 않고 decode하여 `aud`가 배정값과 같은 scalar인지 확인하는 것은 별도 smoke check다.

1. 해당 account를 쓰는 Gateway writer가 하나인지 확인하고 중복 process를 먼저 종료한다.
2. Gateway를 멈추고 `conversation-keys.json`을 owner-only 권한으로 dated secure backup한다. 원본이나
   backup을 로그/티켓에 첨부하지 않는다.
3. issuer, audience, account routing과 비정상 `sub` churn을 조사하여 추가 유입 원인을 차단한다.
4. 아직 full이 아니면 원 account를 다시 기동하고 warning 추이를 관찰한다. entry를 삭제하지 않는다.
5. full이거나 실제 신규 사용자 capacity가 더 필요하면
   `openclaw channels add --channel webchannel --account <new-account>`로 새 account를 enroll하고,
   embedding application/SaaS routing이 **D 이후 새 shard로 최초 배정된 cohort만** 새 account의 단일
   audience로 보내게 한다. mint-site scalar assert와 doctor의 `shared-audience`/
   `verifier-unbuildable` gate를 통과하고, 새 account의 verifier audience와 NATS namespace가 새
   account ID와 일치하며 old/new configured audience가 disjoint인지 readiness로 확인한다. 그 뒤
   **traffic을 열기 전에** 각 cohort의 sample bootstrap claim을 로그에 남기지 않고 decode하여 `aud`가
   배정값과 같은 scalar인지 smoke check하고, 통과하면 traffic을 연다. 이 smoke check는 mint-site
   assert 누락/우회 경로를 traffic switch 전에 잡는 마지막 방어다.
6. 기존 peer와 D 이전에 old account로 배정된 user는 원 account에 남긴다. 기존 peer를 새 shard로
   이동하면 새 conversation key와 새 history namespace를 받으므로 이 runbook은 migration 수단이
   아니다. 잘못 분류한 기존 peer는 즉시 #55와 같은 continuity loss를 겪으며 자동 rollback할 수 없다.
7. 원 account의 file/entry를 삭제하지 않는다. 실제 peer revocation과 history/key-epoch 처리가
   필요하면 별도 지원 workflow가 출시될 때까지 보존한다.

즉, remediation은 “한도를 올리거나 key를 삭제”하는 것이 아니라 abnormal source 차단과 새 account
shard 증설이다. 이 절차는 per-account 10,000 고정 결정을 유지하면서 **cutover 이후 처음 배정되는
신규 cohort**의 service를 복구한다. pre-cutover 배정 user의 재수용은 이번 범위가 아니다.

## 6. 실패 원자성과 상태 전이

| 실패 지점 | 디스크 store | in-memory store | live channel | wire/outbound |
|---|---|---|---|---|
| existing lookup at full | unchanged | unchanged | 기존 등록이면 동일 key 유지 | 정상 register 가능 |
| new peer cached-full check | unchanged | unchanged | 완전 unchanged | 507만 reply |
| fresh-read에서 new peer/full 확인 | unchanged | disk에 이미 있던 membership으로만 refresh 가능 | 완전 unchanged | 507만 reply |
| commit 전 fresh-read의 non-ENOENT read/parse throw | unchanged, quarantine 없음 | 이전 Map 객체/내용 유지 | 완전 unchanged | generic 500 |
| random generation throw | unchanged | unchanged | 완전 unchanged | generic 500 |
| tmp write throw | unchanged | unchanged | 완전 unchanged | generic 500 |
| atomic rename throw | 이전 파일 유지 | 이전 Map 유지 | 완전 unchanged | generic 500 |
| rename 성공 후 process crash | 새 완전한 파일 | process 종료 | process 종료 | client retry 후 같은 key 회복 |
| capacity branch diagnostics throw | unchanged | unchanged | 완전 unchanged | diagnostics보다 먼저 보낸 507 하나; handler resolve. `reply` 자체 throw는 기존 reply path와 같은 transport failure로 범위 밖 |
| capacity reply 유실 | unchanged | unchanged | 완전 unchanged | 재시도해도 다시 507, mutation 없음 |
| I0 위반: concurrent second writer | last-writer-wins로 membership loss 가능 | process별 stale Map 가능 | 중복 responder 가능 | 지원하지 않음; writer 하나로 축소 |

표의 “unchanged/이전 파일 유지”는 I0 single-writer와 외부 file edit 없음 전제다. capacity 경로의
linearization point는 cached-full reject-fast 또는 fresh Map에서 신규 peer/cap을 확인한 시점이다.
신규 성공 경로의 durable linearization point는 atomic rename 성공이다. concurrent writer에 대한
진짜 durable fix는 process lease/advisory lock 또는 shared transactional store이며 별도 follow-up
범위다.

## 7. 테스트 계획

### 7.1 `conversation-key-store.test.ts`

1. `maxKeys:2`를 채운 뒤 p1/p2의 기존 lookup이 모두 원 key를 반환한다.
2. p3는 `ConversationKeyCapacityError`이며 `accountId/currentKeys/maxKeys`가 정확하다.
3. p3 실패 전후 raw file bytes, key membership과 각 key bytes가 동일하다. Map/`Uint8Array` 객체
   identity는 assertion으로 사용하지 않는다.
4. 새 store instance로 reload해도 p1/p2 key가 byte-identical하고 p3는 없다.
5. full 상태의 기존 lookup 반복 전후 raw bytes와 JSON key order가 동일하다.
6. deterministic persistence failure: 기존 store가 있는 상태에서 `.tmp` 경로를 directory로 만들어
   다음 write를 `EISDIR`로 실패시킨다. throw 뒤 신규 peer가 in-memory Map과 disk 모두에 없고,
   failpoint 제거 후 정상 재시도가 성공한다.
7. invalid `maxKeys`(0, 음수, fraction, NaN/Infinity)를 거부한다.
8. 두 store instance A/B를 같은 path로 만들고, **A의 commit 전에** `B.get("nobody")`로 빈 Map을
   먼저 load한다. 이후 A가 p1을 commit하고 stale B가 p2를 만들면 third fresh instance의 reload가
   정확히 p1+p2이며 p1 bytes가 보존되는지 검증한다. fresh-read를 제거하면 p1이 사라져 반드시
   실패해야 하는 mutation-killing test다. 동시 write 지원 테스트로 표현하지 않는다.
9. warning test는 `maxKeys:10`으로 고정한다. 8개에서 0회, 9번째 durable commit에서 정확히 1회,
   10번째와 이후 기존 lookup에서 추가 0회인지 검증한다. `formatCapacityWarning`의 approaching
   output과 payload에 peer ID가 없다.
10. restart 후 정확히 full인 store의 기존 peer 첫 access도 warning을 정확히 1회 내며 full/reject
    wording을 `formatCapacityWarning`에서 사용하는지 검증한다.
11. threshold-crossing persistence failpoint에서는 warning 0회이고, failpoint 제거 후 성공한 retry에서
    1회다.
12. warning callback이 throw해도 `getOrCreate`는 성공하고 key가 disk/Map에 남으며 callback은
    재호출되지 않는다.
13. brand-new account의 첫 `getOrCreate`는 fresh-read의 `ENOENT`를 empty로 처리해 정상 commit한다.
14. valid p1 store와 cached Map을 만든 뒤 disk bytes를 의도적으로 invalid JSON으로 바꾸고 p2를
    생성한다. fresh-read parse error는 capacity error가 아닌 generic persistence error이며, invalid
    bytes를 그대로 두고 `.corrupt-*` sibling을 만들지 않으며 cached p1 bytes를 유지해야 한다. 원래
    valid bytes를 복구하면 같은 p2 retry가 성공한다. 이는 lazy first `load()`의 기존 quarantine test와
    별도로 fresh-read가 quarantine policy를 재사용하지 않음을 고정한다.
15. cache를 `maxKeys:2`까지 채운 뒤 disk를 fault-injection용 invalid bytes로 바꾸어도 p3는 parse를
    시도하지 않고 즉시 capacity error여야 한다. 이 test는 reject-fast를 fresh-read 뒤로 옮기면
    generic parse error로 바뀌어 실패한다.

### 7.2 기존 `nats-channel-admission-boundary.test.ts`와 `nats-channel-keystore.test.ts` 확장

1. 기존 mock 기반 `channel()` factory와 두 테스트는 그대로 두고, tmp home의 실제
   `ConversationKeyStore`를 받는 두 번째 factory를 추가한다. 이 factory에서
   `ConversationKeyStore({ accountId, home, maxKeys:2 })`와 `maxPeers:2`로 p1/p2를 등록한 뒤 p3를
   시도한다.
2. p3 capacity throw 뒤 p1/p2 `.in` subscriptions, `peerSubscriptions`, `peerSessionKeys`가 모두
   남아 있고 p3 state는 없다. 이 테스트가 “live eviction before capacity check” 회귀를 직접 잡는다.
3. Map assertion은 `.size`/`.has()`를 사용하고, p3 전후 실제 store membership과 p1/p2 key를
   byte-wise 비교한다.
4. 기존 p1의 재등록은 full 상태에서도 성공하고 wrapped key가 원 key로부터 만들어진다.

### 7.3 `capacity-status.test.ts`, `capacity-diagnostics.test.ts`, `index-nats-wiring.test.ts`

1. leaf formatter 세 개의 approaching/full/first/summary exact output을 검증하고 어떤 output에도 peer
   ID/key input 자리가 없음을 type/fixture로 고정한다.
2. import 가능한 `createCapacityDiagnostics` 한 instance를 fake clock과 logger로 만들고 account A/B
   status를 interleave한다. warning logger는 `formatCapacityWarning(status)`, 각 account의 첫 reject는
   `formatCapacityReject(status)` exact output을 받으며 A/B 모두 독립된 first line과 60초 window를
   가진다. limiter state를 단일 object로 바꾸면 이 test가 실패해야 한다.
3. account A의 첫 capacity reject 뒤 60초 내 N건에는 추가 error가 없고, 60초 뒤 trigger reject까지
   포함한 정확한 suppressed count가 `formatCapacityRejectSummary` exact output 한 줄로 생긴다. 모든
   formatter output에 account/current/max가 있고 peer ID/key는 없다.
4. warning/reject logger throw와 console fallback throw까지 발생시켜도 callback이 throw하지 않는지
   검증한다.
5. `index-nats-wiring.test.ts`는 기존 성격대로 source shape만 고정한다. 단일
   `const capacityDiagnostics = createCapacityDiagnostics({ ... })` site와
   `onCapacityWarning: capacityDiagnostics.onCapacityWarning`,
   `onCapacityReject: capacityDiagnostics.onCapacityReject`가 **호출 결과가 아닌 function reference**로
   전달되는 모양을 각각 regex로 pin한다. regex로 callback containment/runtime behavior를 증명한다고
   표현하지 않는다.

### 7.4 `nats-register.test.ts`

1. `registerPeer`가 `ConversationKeyCapacityError`를 던지면 reply는 정확히 507 하나다.
2. wrap, history, approval snapshot은 0회다.
3. injected `onCapacityReject`는 유효 status로 정확히 한 번 호출되고 `deps.logger`에는 중복 capacity
   line이 없다. callback 미주입 시에는 `formatCapacityReject(status)`와 byte-identical한 unlimited
   fallback line과 507이 나온다.
4. 다른 module/class를 흉내 낸 plain `Error`에 normative name과 유효 account/count/cap field를
   붙여도 507로 분류하여 name+shape만 사용하는 import-free guard임을 검증한다.
5. generic persistence error는 계속 500이다. same-name error에 `accountId` 누락, `maxKeys:0`,
   fractional `currentKeys`를 각각 넣어 모두 500인지 검증하고, malformed-capacity log에 peer ID나
   dynamic error string이 없는지도 확인한다.
6. throwing `onCapacityReject`와 “호출되면 throw”하는 `deps.logger.error` spy를 함께 주입한 경우,
   그리고 callback 없이 throwing `deps.logger.error`만 둔 경우 모두 reply는 정확히 507 하나이며
   `handleRegisterRequest`는 reject하지 않고 resolve하고 partial output/state call은 없다. reply가
   diagnostic callback보다 먼저 관찰되는 call order도 고정한다. callback-present case에서는 callback이
   throw한 뒤 `deps.logger.error`가 호출되지 않고 console fallback으로 바로 가는지도 assert한다.
7. 같은 `onCapacityReject` spy를 주입한 run에서 N개의 PoP/tenant/subject rejection은 각각 기존
   `deps.logger.error`를 호출한다. capacity 전용 seam이 security log를 감싸지 않음을 call count/message로
   고정한다. limiter 자체의 동작은 §7.3에서 검증한다.

### 7.5 client tests

- `pop-register.test.ts`: 507 capacity reply가 direct-module `PopCapacityError`, terminal, 단일
  register 시도인지 검증한다.
- `nats-client-register-recovery.test.ts` 또는 register path harness: cause가 `capacity`, socket이 terminal
  close되고 reconnect하지 않는지, state/onError의 resolved cause가 generic `server`가 아닌 정확히
  `capacity`인지 검증한다.
- send-state test: pending send가 `terminal/capacity/retryable:false`로 sweep되는지 검증한다.
- `index-exports.test.ts`: 공개 union이 `capacity`를 허용함을 잠그되 `PopCapacityError` package-root
  export는 추가하지 않는다.

### 7.6 demo tests

- hand-maintained `ALL_CAUSES`에 `capacity`를 명시적으로 넣고, exhaustive `COPY` Record가 새 union
  member의 copy 누락을 compile-time에 막게 유지한다.
- capacity heading/hint가 비어 있지 않고 `showReauth:false`인지 검증한다.
- 기존 원인별 copy와 version-skew fallback은 변하지 않는다.

### 7.7 검증 명령

이 격리 worktree 자체에서 `npm ci`로 의존성을 설치한다. 다른 worktree의 `node_modules` symlink를
재사용하지 않는다. 그 뒤 다음 순서로 실행한다.

```bash
npx vitest run \
  packages/plugin/src/conversation-key-store.test.ts \
  packages/plugin/src/nats-channel-admission-boundary.test.ts \
  packages/plugin/src/nats-channel-keystore.test.ts \
  packages/plugin/src/capacity-status.test.ts \
  packages/plugin/src/capacity-diagnostics.test.ts \
  packages/plugin/src/nats-register.test.ts \
  packages/plugin/src/index-nats-wiring.test.ts \
  packages/client/src/pop-register.test.ts \
  packages/client/src/nats-client-register-recovery.test.ts \
  packages/client/src/nats-client-sendstate.test.ts \
  demo/web/src/error-copy.test.ts
npm run typecheck
npm run build
npm test
```

`index-nats.ts`는 issue #32 이후 plugin `tsconfig.include`에 포함되어 typecheck 대상이다. 그럼에도
runtime-only import/bundle 회귀를 잡기 위해 plugin esbuild를 포함한 `npm run build`도 반드시
통과시킨다.

## 8. 파일별 변경 예정표

| 파일 | 변경 |
|---|---|
| `packages/plugin/src/capacity-status.ts`, test | zero-Node `CapacityStatus`와 warning/reject/summary formatter의 단일 privacy-safe owner |
| `packages/plugin/src/conversation-key-store.ts` | typed error, reject-fast no-eviction, non-quarantining fresh-read, candidate-Map commit, named `onCapacityWarning` option과 leaf re-export |
| `packages/plugin/src/conversation-key-store.test.ts` | 기존 eviction test를 삭제가 아니라 fail-closed cases로 교체; stale reload/byte equality/fresh-read failure/reject-fast/warning tests |
| `packages/plugin/src/capacity-diagnostics.ts`, test | import 가능한 warning forwarding과 accountId-keyed reject limiter composition, interleaved-account/fake-clock tests |
| `packages/plugin/src/nats-channel.ts` | durable key acquisition을 live mutation보다 앞으로 이동하고 stale rollback/comment 정정 |
| `packages/plugin/src/nats-channel-admission-boundary.test.ts` | 기존 파일을 실제 store full-cap no-live-eviction으로 확장 |
| `packages/plugin/src/nats-channel-keystore.test.ts` | 기존 파일을 full store existing-peer/wrap continuity로 확장 |
| `packages/plugin/src/nats-register.ts` | 507 constant, literal structural guard, narrow optional `onCapacityReject` dep와 safe fallback |
| `packages/plugin/src/nats-register.test.ts` | no partial sends/state calls, exact guard boundary, callback/fallback와 security-log isolation |
| `packages/plugin/index-nats.ts`, `src/index-nats-wiring.test.ts` | per-account diagnostics helper의 두 callback을 연결하고 source shape만 고정; stale tsc-blind prose 정정 |
| `packages/client/src/pop-register.ts` | `PopCapacityError`, 507 parse/classification |
| `packages/client/src/types.ts` | `WebChannelErrorCause`에 `capacity` 추가 |
| `packages/client/src/nats-client.ts` | capacity cause terminal mapping |
| 관련 client tests | terminal/no-retry/send sweep/export 회귀 |
| `demo/web/src/error-copy.ts` 및 test | capacity copy, reauth 숨김 |
| `packages/plugin/README.md` | account-local cap과 incident response 문서화 |
| `packages/client/README.md`, `packages/client/CHANGELOG.md` | 새 public cause와 additive/source-breaking exhaustive-union 영향 문서화 |

또한 기존 계약을 주장하는 prose를 명시적으로 제거/교체한다.

- `conversation-key-store.ts`의 “evicting least-recently-created”, insertion-order eviction 설명
- `conversation-key-store.test.ts`의 `S2: evicts the oldest key...` 테스트와 “returning peer gets NEW
  key” 설명
- 순서 변경 뒤 더는 맞지 않는 `nats-channel.ts`의 getOrCreate rollback/comment
- `index-nats.ts`의 “outside tsc include” stale comment

구 eviction 문구가 남지 않았는지는 tracked file 기준 다음 명령이 match 없이 exit 1인지 확인한다.

```bash
git grep -n -E 'evicting oldest|evicts the oldest|returning evicted peer|get.*NEW key'
```

## 9. Rollout과 호환성

1. 배포 전 `conversation-keys.json`을 owner-only 권한으로 secure backup한다. key material이므로 CI
   artifact, 로그, 이슈 첨부에 넣지 않는다. 파일 형식/version migration은 없다.
2. 기존 store가 10,000 미만이면 동작 변화가 없다.
3. 기존 store가 이미 10,000 이상이어도 기존 peer lookup은 성공하고 신규 peer만 거부한다.
4. production `index-nats.ts` wiring에서 90% 이상/full warning은 account별 process lifetime당 한 번이다.
   capacity reject는 account별 첫 remediation 한 줄 뒤 request-triggered 60초 summary로 제한되므로
   지속적인 `sub` churn도 per-attempt 로그를 만들지 않는다. `onCapacityReject`를 생략한 custom wiring은
   진단 유실보다 verbosity를 택해 매번 fallback log를 내는 것이 의도다. 마지막 quiet tail count가
   유실될 수 있지만 first line은 보존된다.
5. 새 plugin의 507은 protocol-v2를 구현한 #55 이전 client에서 generic terminal server
   failure로 안전하게 처리된다. pre-v2 client는 그보다 앞선 protocol gate에서 426을 받는다.
6. rollback 시 구 plugin이 다시 eviction할 수 있으므로 cap에 근접한 배포에서 구 버전 rollback은
   암호키 삭제 위험이 있다. rollout 문서에 “near/full store에서는 #55 이전 버전으로 rollback하지
   말 것”을 명시한다.
7. `WebChannelErrorCause` union의 `capacity`는 wire-compatible additive member지만 downstream의
   exhaustive `switch`/`Record<WebChannelErrorCause, ...>`에는 source-breaking compile error가 될 수
   있다. client CHANGELOG/README에 새 member와 대응 copy 필요성을 알린다.
8. 정상 capacity 확장은 §5.7의 new-account/post-cutover-new-cohort shard 절차만 지원한다. 기존 peer나
   pre-cutover old-account 배정 user를 shard 사이에 이동하거나 store entry를 삭제하지 않는다.

## 10. 구현 순서

0. zero-Node `capacity-status.ts` leaf(`CapacityStatus` + 3 formatter)와 leaf tests
1. store error/no-eviction/transactional commit과 store tests
2. NatsChannel mutation ordering과 integration tests
3. register 507/log redaction과 handler tests
4. client typed classification, terminal cause, send-state tests
5. demo copy와 운영 문서. `index-nats.ts` comment에는 현재 source-contract가 bare `continue` 단어를
   count하므로 새 설명에 그 단어를 추가하지 않거나 guard의 의도를 함께 갱신한다.
6. targeted tests → typecheck/build → full test

각 단계는 이전 단계의 typed contract를 소비하도록 순서대로 구현한다. 구현 중 issue 범위를 넘어서는
corrupt-store, live-peer lifetime, DB migration 문제가 발견되면 코드에 섞지 않고 별도 follow-up으로
기록한다.

## 11. 적대적 리뷰 수렴 기준

매 라운드 reviewer는 이 문서 전체와 실제 호출 경로를 새로 읽고 다음을 공격한다.

- cap 경계의 off-by-one과 existing/new 구분
- disk rename과 memory publication 사이의 crash/failure 상태
- capacity throw 전에 발생할 수 있는 모든 channel mutation
- wrapped key/history/approval의 부분 전송 가능성
- client의 503 retry 정책에 507이 잘못 섞이는지
- peer ID/key material 노출과 로그 폭주
- 구 client/plugin 조합 및 rollback 위험
- deterministic하게 구현할 수 없는 테스트 약속
- issue acceptance criteria와 확정된 제품 결정의 불일치
- single-writer precondition을 넘어선 보장을 잘못 주장하는지와 sequential stale-instance 방어

새 리뷰 라운드에서 유효한 P0/P1/P2 finding이 0개일 때 수렴으로 본다. P3도 구현 계약을 더
명확하게 만드는 저비용 지적이면 반영한다. 각 라운드의 finding과 반영 여부는 아래에 기록한다.

## 12. 리뷰 로그

| Round | Verdict | Findings | 반영 |
|---|---|---|---|
| R1 | NEEDS_CHANGES | P1 3건, P2 7건, P3 11건 | v2에 P1/P2 전부와 저비용 P3 반영: account-shard remediation, I0/fresh-read/residual, full warning, client class/branch 고정, structural guard, integer threshold/callback 격리, 실제 store tests, stale prose/build 경계 정정 |
| R2 | NEEDS_CHANGES | P1 2건, P2 5건, P3 7건; R1 P1/P2 10건은 모두 해소 확인 | v3에 전부 반영: cached-full reject-fast, non-quarantining fresh-read failure policy, reject log limiter, warning formatter owner, mutation-killing stale-instance test, 실행 가능한 shard prerequisites/cutover, literal import-free guard, equality/traffic-trigger/factory/guard-command 명확화 |
| R3 | NEEDS_CHANGES | P1 1건, P2 2건, P3 9건; R2 수정은 모두 해소 확인 | v4에 전부 반영: capacity-only callback seam, import 가능한 diagnostics composition/helper tests, account-bearing summary, limiter tail/off-by-one/clock 규칙, stale-cache I3, per-account warning/full transition, malformed branch, stale wiring-test prose와 source-guard 주의 |
| R4 | NEEDS_CHANGES | P0/P1 0건, P2 2건, P3 8건; R3 수정은 모두 해소 확인 | v5에 전부 반영: 507 reply-first와 diagnostic total catch, pre-cutover 배정 user 비목표 명시, status account 단일 authority/명시 복사, store option 명명, production-only log bound, 실행 가능한 handler/source-shape tests, scalar mint-site assert, state/review log 정정 |
| R5 | NEEDS_CHANGES | P0/P1 0건, P2 2건, P3 6건; R4 수정은 모두 해소 확인 | v6에 전부 반영: zero-Node status/formatter leaf와 reject 문구 단일화, accountId-keyed bounded limiter, interleaved-account test, logger type/method, mint gate/smoke 구분, pre-cutover 잔류 이유, reply-throw 범위, review log 정정 |
| R6 | NEEDS_CHANGES | P0/P1 0건, P2 1건, P3 4건; R5 수정은 모두 해소 확인 | v7에 전부 반영: sample token smoke를 traffic switch 앞으로 이동, verbatim type/value re-export, store warning fallback formatter 고정, callback-present throw의 console-direct fallback 규칙/test, review log 정정 |
| R7 | PASS | P0/P1/P2 0건, P3 3건 | 수렴 기준 충족. 저비용 P3 전부 최종 반영: diagnostics의 leaf direct import, leaf-first 구현 순서, R7 PASS 기록 |
