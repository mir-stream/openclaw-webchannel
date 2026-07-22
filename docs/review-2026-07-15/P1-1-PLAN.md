# P1-1 구현 계획 — Agent key registry: 명시적 교체 의미론

Status: **IMPLEMENTED** — 현재 제품 계약은 [`docs/AUTH.md`의
Agent identity-key lifecycle](../AUTH.md#agent-identity-key-lifecycle)을 따른다.
아래는 CONVERGED r8 구현 계획과 검토 기록이다(codex(gpt-5.6-sol) 적대리뷰
7라운드, r7 판정 BLOCKER 0 / MAJOR 0; 잔여 MINOR 3건 본문 반영 완료).
원 리뷰: [P1.md — P1-1](./P1.md#p1-1-multi-agent-identity-key-registry-routing)

## 0. 범위 결정과 보장 범위 (확정)

### 0.1 제품 결정

리뷰 문서는 "한 account에 복수 logical agent" 모델(agentId가 subject/JWT/session을
관통)을 전제로 썼다. 제품 결정은 반대다:

> **account = 격리 축. 한 account에는 논리 agent 하나.**
> agent를 나누고 싶으면 account를 나눈다. identity는 accountId에 붙고
> (openclaw `channels add`에서 운영자가 명명), agent key는 그 identity의
> **교체 가능한 자산**이다. 재enroll = 같은 agent의 key 교체.

wire(NATS subject, JWT claims, bootstrap 응답 형태)는 변경하지 않는다. `agentId`를
도입하지 않는다.

**Agent HA 불변식(명문화 대상):** 한 account의 복수 *agent* 프로세스(replica)는
동일한 agent identity key를 공유해야 한다. 같은 pubkey 재등록은 idempotent
성공이므로 replica는 충돌을 만들지 않는다. 독립 key replica는 미지원 —
교체 시도(conflict)로 표면화되는 것이 정의된 동작이다.

### 0.2 정확성 보장 범위 (P1-1이 주장하는 것과 하지 않는 것)

P1-1의 보장은 다음 배치 전제에서 성립하며, 이 전제를 `docs/AUTH.md`와 SPI 주석에
명문화한다:

- **단일 issuer 프로세스.** `DeviceFlowEnrollment`의 per-userCode lock(#22)은
  process-local이다(오늘도 그렇다). 복수 issuer replica에서의 enrollment 상태
  전이 직렬화(lease/CAS, 중복 mint 차단)는 **P1-2의 존재 이유**이며 P1-1은
  이를 해결한다고 주장하지 않는다. P1-1의 registry CAS는 P1-2가
  `commitApproval`로 흡수·합성할 **building block**이다.
- **enrollment store와 agent key registry는 같은 durability domain에 있어야
  한다.** 둘 다 memory(단일 프로세스 dev/demo), 또는 둘 다 같은 DB의 durable
  구현. 혼합(durable store + memory registry, 또는 그 역)은 재시작 시 한쪽만
  살아남아 "approved ⇒ registered" 대응이 깨지므로 **미지원 구성**으로
  문서화한다. 구성 강제(단일 트랜잭션 SPI)는 P1-2다. P1-1의 완화 장치는
  §2.4 step 1의 "registry가 **증명 가능하게 비어 있을 때만**" 발동하는
  reconciliation뿐이다.

무조건 성립을 주장하는 것(§5): **다른 key를 가진 CAS 패자에게 사용 가능한 NATS
creds가 전달되는 경로가 없다** — approved 저장이 register 성공 뒤에만 일어나고
`poll()`은 approved가 아니면 creds를 반환하지 않으므로, registry CAS가 원자적인
한 issuer replica 수와 무관하게 성립한다. (버려진 mint 산물의 정확한 표현:
"유효하지만 어떤 명세된 코드 경로로도 전달·관측되지 않는 creds" — 암호학적으로
무효화되는 것은 아니다. 무효화는 P1-2/#7·#12 영역.)

수요가 생기면 (b) 복수-agent 모델로 확장한다. 데이터 모델은 확장을 막지 않는
선까지만 여지를 남긴다. agentId 라우팅, rotation overlap window는 명시적 비범위.

## 1. 문제 재정의 — (a) 범위에서 실재하는 결함 3개

### D1. 조용한 last-write-wins 교체

`DeviceFlowEnrollment.approveInner()`(`packages/saas/src/device-flow-enrollment.ts:693`,
registry write는 `:741` 인근)는 NATS creds mint + `status:"approved"` 저장 **후**
`agentKeyRegistry.put()`을 무조건 upsert한다. per-userCode lock(#22)은 **같은 enrollment**의 approve/deny 경합만
직렬화한다(`userCodeLocks`는 userCode로만 키잉). 같은 (tenant, account)를 노리는
**서로 다른 두 pending enrollment**는 lock을 공유하지 않으므로 둘 다 approve에
성공하고, registry는 나중 write가 이긴다.

위협 시나리오: 공격자가 피해자의 account를 지정해 enrollment를 시작하고(agent
identity key는 client가 enrollment **이전에** 생성해 요청에 실어 보낸다 —
`enrollment-client.ts`의 `identityKey` — 승인이 mint하는 것은 NATS creds뿐이다),
운영자가 정당한 재enroll로 착각해 approve하면 이후 bootstrap하는 모든 브라우저가
공격자 key를 pin한다. 승인 UI에는 "이 account에 이미 등록된 agent key가 있고 이
승인이 그것을 교체한다"는 정보가 전혀 없다. 사람이 gate인데 사람에게 판단 재료를
주지 않는 구조가 결함이다.

### D2. missing account가 literal `"default"`와 충돌

`agentKeyRegistryKey()`는 accountId 미지정을 문자열 `"default"`로 collapse한다.
`default`라는 이름의 실제 account와 같은 registry 슬롯을 공유하게 된다.
accountId-less enrollment는 가설이 아니다: plugin `EnrollmentClient`는 accountId를
default하지 않고 undefined 그대로 요청에 싣고(`enrollment-client.ts` 생성자,
`enrollRequest` 구성부), `acquire-credentials.ts`는 `DEFAULT_ACCOUNT_ID`("default")
로 자체 default한다. `channels add` 경로만 canonicalize한다.

### D3. 레코드가 문자열 하나 — 감사·revoke·교체이력 원천 불가

value가 base64url key 하나뿐이라 "언제 등록됐나", "무엇을 교체했나", "revoke됐나"를
표현할 수 없다. D1의 해법(교체를 명시적 이벤트로)과 pin-serving 중단(revoke)에
레코드 구조가 필요하다.

## 2. 설계

### 2.1 데이터 모델

```ts
/** base64url(SHA-256(publicKey)) 전체 43자 — key의 안정 식별자(표시·감사용). */
type AgentKeyId = string;

/**
 * 활성화 이벤트마다 registry가 새로 발급하는 opaque 토큰(crypto-random 128bit,
 * base64url). CAS의 expect 토큰은 keyId가 아니라 이것이다: keyId는 pubkey에서
 * 결정적으로 유도되므로 supersession 사이클(A→B→A)로 슬롯이 같은 keyId로
 * 되돌아오면 과거 확인 응답의 재사용(replay)이 가능해진다. activationId는
 * 활성화 사건 자체를 식별하므로 replay가 원천 차단된다.
 */
type ActivationId = string;

interface AgentKeyRecord {
  readonly tenant: string;
  readonly accountId: string;
  readonly publicKey: string;         // base64url X25519, 기존과 동일 형식
  readonly keyId: AgentKeyId;         // publicKey에서 유도
  readonly activationId: ActivationId; // 이 활성화 사건의 고유 토큰
  readonly status: "active" | "superseded" | "revoked";
  readonly enrolledAt: number;        // 이 활성화가 시작된 시각 (epoch ms)
  readonly endedAt?: number;          // superseded/revoked 전이 시각
  readonly supersededBy?: ActivationId;
}
```

- (tenant, accountId) 슬롯당 **active는 항상 0 또는 1개** — (a) 모델의 불변식.
- 반환 레코드는 방어적 복사본(또는 frozen). 이력은 append-only이며 반환값 변조로
  내부 상태를 바꿀 수 없다.
- 승인 UI는 keyId 앞 12자를 지문으로 **표시**하지만, 확인/CAS 토큰은 전체
  activationId다.

### 2.2 Registry 인터페이스 v2

기존 `put/get`(string)을 **대체**한다. 공개 SPI breaking — 0.x 명시적 breaking,
CHANGELOG에 마이그레이션 노트. 영향 소비자(전수): `DeviceFlowEnrollment` 내부,
reference enrollment-server(운영 lookup :806 + 테스트 라우트 :1114), demo
saas-server(:617), example app(:341), examples/minimal-consumer(§2.4에서 registry
필수화로 신규 편입), saas 패키지 단위 테스트들.

```ts
interface AgentKeyRegistry {
  /** serving 경로(bootstrap)가 읽는 유일한 메서드. */
  getActive(tenant: string, accountId: string): Promise<AgentKeyRecord | null>;

  /**
   * 등록/교체. 판정 우선순위(위에서 아래로, 첫 매치 적용):
   *  1) tombstone: 이 슬롯 이력에 status:"revoked"로 남은 keyId와 같은
   *     publicKey → {ok:false, reason:"revoked"} (영구). revoke는 compromise
   *     대응이므로 재enroll로 조용히 un-revoke되면 안 된다. un-revoke 연산은
   *     제공하지 않는다(integrator가 store 레벨에서 이력을 정리하는 것은
   *     그들의 선택).
   *  2) idempotent: publicKey가 현재 active와 동일 → expect와 **무관하게**
   *     성공({ok:true, idempotent:true}, 레코드·이력 무변화). stale expect라도
   *     최종 상태가 호출자 의도와 동일하므로 거부할 정보가 없다 — 이 우선순위
   *     (idempotency가 stale-expect 거부보다 앞선다)는 계약의 일부다.
   *     같은 key 재enroll·agent replica·"경쟁자가 같은 key를 먼저 활성화"
   *     인터리빙이 모두 여기에 해당한다.
   *  3) CAS: expect === null이면 슬롯에 active가 없을 때만, expect ===
   *     <activationId>면 그 활성화가 현재 active일 때만 전이. 불일치 →
   *     {ok:false, reason:"conflict", current}.
   * 성공 시 이전 active는 하나의 원자 전이로 superseded가 되고, 새 레코드는
   * 새 activationId를 발급받는다.
   */
  register(
    tenant: string,
    accountId: string,
    publicKey: string,
    expect: ActivationId | null,
  ): Promise<
    | { ok: true; record: AgentKeyRecord; idempotent: boolean }
    | { ok: false; reason: "conflict"; current: AgentKeyRecord | null }
    | { ok: false; reason: "revoked" }
  >;

  /** active key의 serving 중단 + 해당 keyId 슬롯 내 영구 tombstone. */
  revokeActive(tenant: string, accountId: string): Promise<boolean>;

  /** 감사용 이력 (최신순, append-only 스냅샷). §2.4 step 1의 유실 판별에도 사용. */
  listHistory(tenant: string, accountId: string): Promise<AgentKeyRecord[]>;
}
```

**동시성 계약:** 같은 슬롯에 대한 `register`/`revokeActive`는 원자적
read-modify-write이며 슬롯마다 단일 직렬화 지점을 가져야 한다("TS 시그니처만
맞는 read→await→write" 구현은 부적합). `getActive`/`listHistory`는 전이 전/후
어느 한쪽의 일관 스냅샷을 반환한다(찢긴 레코드 금지).

**이력 보존 계약(SPI 규범):** tombstone과 history는 슬롯 수명 동안
**비손실**이어야 한다 — history TTL, 손실성 compaction, archive 이동으로
tombstone이나 활성화 이력이 사라지는 구현은 부적합하다(compaction은 의미
보존형만 허용). 이 계약이 §2.4 step 1의 "history 빔 = 유실" 판정의 전제다:
같은 durability domain이라는 배치 규칙만으로는 보존이 보장되지 않으므로,
보존은 SPI 계약으로 별도 명시한다.

**Conformance 스위트** (`packages/saas/src/agent-key-registry-conformance.ts`,
export): linearizability 증명기가 아니라 **불변식 + 허용-결과 스위트**다 —
스크립트된 동시 op 묶음(동시 register 경합, stale expect, same-key 다발,
revoke↔register 경합)을 실행하고 (i) 최종 상태가 열거된 허용 결과 집합에
속하는지, (ii) 전 구간 불변식(active ≤ 1, 이력 append-only, superseded는
supersededBy 보유, revoked keyId 재등록 거부, 시간 경과/유지보수 후에도
tombstone·이력 보존)을 검증한다. Memory 구현은 단일 프로세스 + 동기 Map
전이로 이를 만족하며 **reference 거동**이다; durable 어댑터의 다중 프로세스
검증 강화는 P1-2의 store conformance와 함께 간다.

**revoke의 정확한 의미(문서 명문화):** revoke는 **미래 bootstrap의 pin serving
중단만** 한다. (i) 이미 pin을 받은 살아있는 브라우저 세션은 영향받지 않는다
(pin은 세션-로컬 — `saas-bootstrap.ts`의 저장/사용 지점; 강제 절단 없음),
(ii) agent의 NATS creds는 TTL 없이 mint되며 이 계획은 무효화하지 않는다
(#7/#12의 opt-in revocation이 별도 경로). "revoke = 그 agent 완전 차단"이
아니라는 것을 운영자 문서에 명시한다.

**revoke 후 복구 경로(지원되는 절차로 제공):** tombstone은 영구이므로 잘못
revoke하면 그 identity key로는 복귀 불가 — agent가 **새 identity key로
재enroll**해야 한다. 그런데 plugin은 identity key를 "한 번 생성, 회전 없음"으로
영속하고(`packages/plugin/src/enrollment-client.ts` — credential JSON 하나에
identity key와 enrollment/NATS creds 동봉, 인스턴스 메모리에도 보유), 저장된
enrollment가 있으면 enrollment 자체를 건너뛴다. 따라서 P1-1은 **명시적 re-key
절차를 오프라인 runbook으로 편입**한다:

> **reset은 오프라인 절차다**: gateway 정지 → account-scoped credential 파일
> 삭제 → `channels add` 재enroll(운영자 승인, tombstone된 구 key와 무충돌 —
> expect=null 경로) → gateway 재시작.

runbook은 **정확한 경로를 완료 산출물로** 담는다: 기본 경로
`~/.openclaw-webchannel/<account>/credentials.json`(`account-config.ts`의
현행 규약)과 명시적 `credentialPath` override가 설정된 경우의 처리, 그리고
정확한 삭제 명령 또는 제공 helper. "credential 파일을 지운다"는 추상 서술로
끝내지 않는다(helper CLI/스크립트 형태 자체는 구현 PR에서 확정).

**legacy 단일 파일 fallback 제거(§2.3과 연동):** `account-config.ts`는
`default` account에 한해 per-account 파일 부재 시 legacy
`~/.openclaw-webchannel/credentials.json`으로 fallback하고, `setup.ts`의
"이미 등록됨 → 획득 skip" 판정도 이를 본다. 이 fallback이 남아 있으면
per-account 파일만 지운 re-key가 **조용히 legacy creds를 재사용**해 runbook을
무력화한다. 처리: 이 fallback을 **모든 reader에서 제거**한다(#17 "암묵
default 금지"의 잔재 — accountId 전 구간 필수화와 같은 원칙). 기존 배포 호환은
CHANGELOG의 1회 마이그레이션 노트(legacy 파일을 새 경로로 이동)로 처리하고,
runbook에도 legacy 경로를 수동 정리 대상으로 명기한다.

**온라인 re-key API는 제공하지 않는다**: 파일 삭제만으로는 이미 열린
transport·reconnect 루프·`EnrollmentClient` in-memory credentials가 구
identity/creds를 계속 쓰므로(`enrolled-nats-connection.ts`의 transport 생성·
reconnect), 살아있는 연결의 원자적 교체는 transport lifecycle 작업을 수반해
P1-1 범위를 넘는다. 이는 revoke 의미론(살아있는 세션 불간섭)과도 정합한다 —
재시작 전까지 구 연결이 유지되는 것은 문서화된 동작이다. AUTH.md runbook에
명기. 문서화되지 않은 credential 파일 수술이 유일한 복구 수단인 상태로
tombstone을 도입하지 않는다.

### 2.3 accountId — 전 구간 필수화, sentinel 제거

`DEFAULT_REGISTRY_ACCOUNT_ID`를 삭제하고 **enrollment와 registry 키잉** 범위에서
accountId를 필수로 승격한다(§5의 "defaulting 표면 0"은 이 범위에 대한 주장이다).
빈 문자열 sentinel 후퇴안은 채택하지 않는다. **defaulting/optionality 표면 전수**
(구현 체크리스트):

SaaS 쪽:
- `EnrollmentRequest.accountId` 필수 (`assertValidSubjectToken` + 비어있지 않음);
  `enroll()` 시작 단계 거부. `PendingEnrollment.accountId`(device-flow-types.ts
  :121,:137)도 required로.
- HTTP 어댑터가 accountId 누락을 **의도된 400**으로 응답 (라이브러리 거부가
  500으로 새지 않게): reference `/enroll`(:835 인근 검증부), example app
  `/api/enroll`(:353), **demo `/api/enroll`(saas-server.ts:640 인근)**.
- `buildBootstrapClaims()`의 audience 검증 강화: scalar/array 멤버에
  `assertValidSubjectToken` 적용(bootstrap-claims.ts:102–110 — 현재 비어있지
  않음만 확인). claims의 accountId도 subject 세그먼트로 흘러가므로 같은 규율.
- `packages/saas/README.md`의 `accountId?` 표기(:95,:127)와 예제 갱신.

Plugin 쪽 (lockstep):
- `EnrollmentClient` options·persisted/wire 타입(:34,:153)의 accountId 필수 승격;
  legacy 단일 파일 fallback(`~/.openclaw-webchannel/credentials.json`)을
  **모든 reader에서 제거** — `EnrollmentClient.defaultCredentialPath`뿐 아니라
  `account-config.ts`의 `resolveReadCredentialPath`, `setup.ts`의 "이미
  등록됨 → skip" 판정, **`setup-wizard.ts:97–105`**까지(§2.2 runbook 항목
  참조; CHANGELOG 1회 마이그레이션 노트). `legacyCredentialPath()` 자체는
  reader가 아니므로 마이그레이션/runbook 테스트용으로 유지 가능. 기존
  legacy-긍정 테스트 2건(`account-config.test.ts:341–348`, `:492–500`)은
  "legacy 파일 무시" 회귀 테스트로 **교체**한다. 문서·예제도 tree-wide로
  구 단일 경로 표기를 일소한다(`packages/plugin/README.md:36`,
  `packages/plugin/examples/enrollment-example.ts:184–186` 포함).
- `AcquireCredentialsOptions.accountId` 필수화, `DEFAULT_ACCOUNT_ID` 삭제
  (acquire-credentials.ts + default 단언 테스트 교체; `channels add`/setup hook이
  명시 값을 넘기는지 구현에서 재확인).
- `EnrolledNatsConnectionOptions.accountId`(이미 존재, optional)를 required로;
  `createDefaultNatsConnection`(:193)이 accountId를 받아 관통시키게.
- plugin `README.md` 예제(:71,:94) 반영.
- smoke/, e2e/ fixture 전수 감사(직접 생성 경로).

비범위 명시: `PollRequest`는 device_code만 갖는 것이 맞다(코드가 account를
해석). wire에 accountId를 새로 싣는 변경은 없다.

근거: #17("phantom default account")의 "암묵 default 금지" 원칙의 잔재 제거.
enrollment 스키마 breaking이지만 SaaS↔plugin lockstep + 0.x이므로 명시적 breaking.

### 2.4 Approve 흐름

**registry 필수화**: `DeviceFlowOptions.agentKeyRegistry`의 `?` 제거
(`device-flow-enrollment.ts:442`). registry 없는 생성은 생성자 throw.
minimal-consumer(operator.ts:53)와 테스트 전수 수정.

시그니처 (discriminated union — truthy 검사 호출자가 conflict를 성공으로 오인할
수 없게 `kind` 분기를 강제):

```ts
type ApproveOutcome =
  | { kind: "approved"; result: EnrollmentResult }
  | {
      kind: "conflict";
      existing: {
        activationId: ActivationId;   // 확인 토큰 (opaque, 이 활성화 한정)
        keyIdFingerprint: string;     // 표시용 지문 (keyId 앞 12자)
        enrolledAt: number;
      } | null;                       // null = 확인 대상이던 활성화가 사라짐
      incoming: { keyIdFingerprint: string };
    }
  | { kind: "revoked_key" }           // tombstone된 key의 enrollment
  | { kind: "rejected" };             // 만료/terminal/미존재/저장 유실(아래)

approve(userCode: string, opts?: { replaceActivationId?: ActivationId }): Promise<ApproveOutcome>
```

`replaceActivationId`가 **운영자가 실제로 본 활성화에 확인을 binding**한다:
conflict 응답의 `existing.activationId`를 그대로 되돌려 보내야 하며, 그 사이
슬롯이 **다른 key로** 바뀌었으면 새 conflict를 반환한다. 예외 하나(§2.2 판정
순서와 정합): 그 사이 경쟁 승인이 **같은 incoming key를 이미 활성화**한 경우는
idempotent 성공이다 — 최종 상태가 운영자가 승인하려던 상태와 동일하므로 새
확인을 요구할 정보 차이가 없다.

`approveInner` 순서 (per-userCode lock 내부):

1. 기존 A2/#11 가드 (idempotent 재approve fast path, terminal 거부, 만료).
   **A2 reconciliation (좁게):** approved 레코드의 creds를 재반환하기 전에
   registry를 확인하되, 복구 등록은 **`getActive() === null`이고
   `listHistory()`가 비어 있을 때만** — 즉 registry가 이 슬롯을 완전히 잃은
   경우(혼합 durability 재시작, fresh memory registry)에만 —
   `register(expect=null)`을 시도한다. **이력이 하나라도 있으면 절대 쓰지
   않는다**: active 없음 + 이력 있음은 의도된 상태(revoke 직후, 교체 진행 중)
   이며, 여기서 자동 등록하면 superseded key가 운영자 확인 없이 부활한다
   (r3 review의 resurrection 시퀀스). 이 경우와 "다른 key가 active"인 경우
   모두 registry 무변경 + creds 재반환(기존 의미: creds 유효성은 pin과 독립)
   + 경고 로그. 복구 register가 `reason:"revoked"`를 돌려주는 조합은 이력이
   비어 있다는 전제와 모순이라 발생 불가지만, 방어적으로 동일하게 무변경 +
   로그로 처리한다. superseded key를 **의도적으로** 되살리는 유일한 경로는
   새 enrollment + 확인 흐름이다. (이 "history 빔 = 유실" 판정은 §2.2의 이력
   보존 계약을 만족하는 registry에 대한 것이다 — 손실성 retention 구현은 SPI
   부적합으로 그 자체가 배제된다. 추론의 근거: **새 순서로 커밋된 레코드**에
   대해서는 approved 레코드가 곧 "슬롯이 register를 통과했다"는 증거다.
   **P1-1 이전(구 순서: store-approved 후 registry write)에 생성된 legacy
   approved 레코드**는 registry write 실패로 등록 없이 approved일 수 있으나,
   그 경우에도 등록하려는 key가 "운영자가 승인했던 바로 그 key"라는 더 약한
   — 그러나 충분한 — 사실 위에서 reconciliation은 안전하다. upgrade 경계의
   이 케이스를 테스트 fixture로 포함한다.)
2. **Gate** — `registry.getActive` 조회:
   - active 없음 && `replaceActivationId` 미지정 → expect = null.
   - active 있음 && `active.publicKey === enrollment.agentPublicKey` →
     같은 key, expect = active.activationId (확인 불요).
   - active 있음 && key 다름 && `replaceActivationId === active.activationId`
     → expect = 그 값.
   - 그 외 → **mint 없이** `{kind:"conflict"}` 반환, enrollment pending 유지.
   - 슬롯 이력에 incoming key의 tombstone이 있으면 **mint 없이**
     `{kind:"revoked_key"}` (gate에서 선판정; register의 tombstone 거부는
     최종 방어선).
3. **Mint** — NATS creds + peerId 생성. 실패 시 어떤 상태도 변하지 않았다
   (registry 미접촉, enrollment pending) — 가장 흔한 async 실패 지점을 상태
   전이 앞에 두는 것이 이 순서의 요점 절반이다. mint 직후, store 쓰기 전에
   enrollment 만료를 재확인한다(§아래 poll 레이스의 축소 — 제거는 아님).
4. **Register** — `registry.register(tenant, accountId, agentPublicKey, expect)`.
   - `ok:false` → mint된 creds는 저장·반환되지 않고 버려진다(유효하나 전달·
     관측 경로 없음). conflict/revoked를 반환하고 enrollment는 pending 유지.
     **CAS 패자는 사용 가능한 creds를 얻지 못한다** — 기존 순서에서는 패자가
     approved-with-creds로 남아 `poll()`(registry 무관)이 살아있는 tenant-wide
     creds를 넘겨줬다. 순서의 요점 나머지 절반.
5. **Store + 검증** — `updateEnrollment(status:"approved", natsCreds, peerId)`
   후 **재조회로 저장을 확인**한다: MemoryStore의 `updateEnrollment`는 레코드
   부재 시 무음 no-op(성공 resolve)이므로(:331), sweep-eviction과 겹치면 검증
   없이는 **운영자에게 가짜 `approved`가 보고**된다(agent는 그 creds를 영원히
   poll할 수 없는데). 재조회에서 approved를 관측하지 못하면: 경고 로그 +
   `{kind:"rejected"}` 반환. 이때 registry에는 새 key가 남지만 이는 운영자가
   방금 승인한 정당한 key이고, agent 재enroll이 같은-key idempotent 경로로
   회복한다. **이 검증은 관측이지 보장이 아니다(TOCTOU)**: 재조회 성공 직후
   반환 전에 sweeper가 evict하는 창은 남는다 — 그 경우 결과는 아래 잔여
   "4 성공 → 5 유실"과 동일하게 회복 가능하다. sweep과 update를 하나의
   store-side 조건부 연산으로 묶는 것(그리고 update의 boolean 반환 계약화)은
   P1-2의 SPI 재설계로 보낸다.

**잔여 실패 모드 (열거, §0.2와 정합):**

- **4 성공 → 5 실패/유실**: registry에 새 active, enrollment는 pending
  (또는 evict됨). 같은 프로세스 생존 시: 재approve가 2의 같은-key 경로로 통과
  → 재mint → 회복. evict 시: agent 재enroll → 같은-key idempotent 승인.
  이 창에서 서빙되는 key는 운영자가 방금 승인한 정당한 key이므로 보안 결함이
  아니라 가용성 공백이며, step 5 검증으로 운영자에게 표면화된다.
- **poll의 unlocked expiry write와의 레이스**: `poll()`은 lock 밖에서 만료를
  무조건 write한다(:589,:595). 이 레이스는 **기존에 존재**하며(오늘도 approve의
  mint await 구간과 교차 가능) 상태 전이의 조건부화(P1-2)가 근본 해법이다.
  **정직한 기술: P1-1의 새 순서는 store 쓰기 전 구간에 getActive/register
  await를 추가하므로 취약 구간을 좁히는 게 아니라 넓힌다.** step 3의 만료
  재확인이 이를 부분 상쇄하지만 제거하지 못한다. 허용 결과는 상태쌍 열거가
  아니라 **불변식으로 정의**한다(교차하는 제3의 승인·revoke가 다른 userCode로
  같은 슬롯을 움직일 수 있어 상태쌍의 조합 공간이 닫히지 않으므로):
  enrollment 최종 상태는 approved/expired 중 하나, 해당 key의 registry 상태는
  **absent(등록 전 만료·CAS 패배로 아예 미등록)**/active/superseded/revoked
  중 하나일 수 있으나, 어떤 인터리빙에서도 (i) 미확인 교체가 일어나지 않고,
  (ii) CAS 패자에게 creds가 전달되지 않으며, (iii) 모든 결과 상태가 회복
  가능하다 — absent/superseded는 통상 재enroll/재approve로, revoked는
  오프라인 re-key runbook으로.
- **deny 교차 불가**: deny는 같은 per-userCode lock을 쓰므로 approveInner의
  2–5 사이에 끼어들 수 없다. mint 실패 후 deny(3 실패 → lock 해제 → deny)는
  상태 변화가 이미 0이므로 orphan이 없다.
- **register와 store 사이의 revokeActive**: 운영자가 그 찰나에 revoke하면
  step 5는 approved를 쓰고 revoke는 tombstone을 남긴다 → "approved creds +
  revoked pin". 이는 revoke 의미론(§2.2 — pin serving 중단, creds 불간섭)과
  정합하는 상태이며 bootstrap은 fail-closed. 테스트로 고정.

**deny는 변경 없음.**

### 2.5 소비자 변경 (reference / demo / example / harness)

- **bootstrap lookup 4곳** (`packages/saas/reference/enrollment-server.ts:806`
  운영 / 같은 파일 `:1114` 테스트 라우트 / `demo/saas-server.ts:617` /
  `examples/webchannel-app/server/index.ts:341`): `get()` → `getActive()`,
  pin은 `record.publicKey`. 응답 형태 불변.
- **reference 테스트 bootstrap 라우트의 caller-supplied `agentPublicKey`
  override 제거** (:1078–1116): 현재는 caller 제공 값이 registry보다 우선해
  E2E가 registry 경로를 안 거치고 통과할 수 있다(가짜 green). 현행 테스트
  경로들이 이미 이 필드를 안 보내는 것을 확인했으므로 제거 자체는 저위험.
- **approve 호출부 전수** (reference /approve 핸들러, demo 승인 경로, example
  app 승인 경로, minimal-consumer): `ApproveOutcome.kind` 분기 필수 — conflict는
  409 + {activationId, 지문, enrolledAt}으로 응답, UI는 "이 승인은 기존 agent
  key(지문·등록시각)를 교체합니다" 경고와 함께 확인받아 `replaceActivationId`로
  재호출. revoked_key/rejected는 구분된 오류 표시.
- **reference 승인 페이지의 reflected XSS 수정 — P1-1로 편입 (P1-4에서 선인출)**:
  서버측 `{{USER_CODE}}` 무이스케이프 치환
  (`packages/saas/reference/enrollment-server.ts:265` `replaceAll` →
  `packages/saas/reference/enrollment-ui.html:146` HTML sink + `:179` JS 문자열
  literal sink)은 P1-4에 기록된 기존 결함이지만, **P1-1이 이 페이지에 admin
  bearer 토큰을 들이는 순간 토큰 탈취 벡터가 되어 P1-1의 게이트 자체를
  무력화**한다. 수정 없이는 아래 토큰 가드가 무의미하므로 이 sink만 P1-1에서
  고친다. **수정 방식 규정: inline `<script>` 보간 자체를 제거**한다 —
  user_code는 HTML-escape된 `data-*` 속성으로만 전달하고 스크립트는 DOM에서
  읽는다(권장). 스크립트 element에 넣는 어떤 형태든 — `type="application/json"`
  비실행 element 포함, HTML 파서는 거기서도 `</script>`를 인식한다 — 삽입 전
  `<`를 `\u003c`로 인코딩하는 HTML-safe JSON 직렬화가 필수다. 단순 서버측
  `JSON.stringify`는 JS 문자열로는 안전해도 이 종료 규칙을 막지 못하므로
  단독 채택 금지. **적용 범위는 렌더링 경로와 동적 필드 전부다**:
  (i) 외부 템플릿 경로뿐 아니라 템플릿 읽기 실패 시의 **in-code
  `fallbackApprovalTemplate()`**(`enrollment-server.ts:356` 인근 — 동일한
  HTML+inline-script 보간을 독립 수행)도 같은 방식으로 고친다.
  (ii) user_code만이 아니다 — **승인 응답 필드를 `innerHTML`로 꽂는 제3의
  sink**(`enrollment-ui.html:197–203` 및 fallback의 대응부
  `enrollment-server.ts:384–387`: `/approve` 응답의 accountId·tenant·peerId를
  `statusEl.innerHTML`에 조립; accountId는 enrollment 요청 유래 = 공격자 통제
  가능)를 DOM 조립 + `textContent`(또는 문맥 정확한 HTML escape)로 교체한다.
  변수 없는 정적 마크업(스피너 등)만 innerHTML 허용. upstream의
  `assertValidSubjectToken` 검증(§2.3)에 의존하지 않는다 — 출력 인코딩은
  sink에서 독립적으로 보장한다. crafted 페이로드 회귀 테스트는 템플릿 읽기
  실패를 강제해 **두 렌더 경로 모두**에, user_code(`</script><script>`·
  `<!--` 계열)와 **`/approve` 응답의 적대적 accountId/tenant** 값 모두를
  돌린다.
- **reference 서버 state-changing endpoint 최소 인증 (P1-4 선납금)**:
  approve/deny/revoke에 env `ENROLLMENT_ADMIN_TOKEN` bearer 가드.
  **fail-closed**: env 미설정이면 해당 endpoint 503 + 명확한 로그(자동 생성-후-
  로그 출력 패턴은 채택하지 않음). **개발 프로파일 명시**: agent/browser 경로
  (enroll, poll, bootstrap, JWKS)는 zero-setup 그대로 — 토큰이 필요한 것은
  운영자 액션뿐이며, 이는 P1-4의 "zero-setup dev 허용" 원칙(허용이지 무보호
  의무가 아님)과 상충하지 않는다. CORS preflight 허용 헤더에 `Authorization`
  추가(현재 Content-Type만 — :228). 부수 마이그레이션(필수):
  - `packages/saas/reference/enrollment-ui.html`: 토큰 입력 필드 —
    **memory-only 보관**(페이지 로드당 1회 입력, JS 변수/closure에만 유지;
    sessionStorage·localStorage 영속 금지 — 알려진 sink 2개를 고쳐도
    reference origin 전체의 미발견 sink에 대해 지속 저장 bearer는 과도한
    노출이다) + Authorization 헤더 전송. 토큰이 HTML·URL·서버 로그에
    반사되지 않아야 한다(테스트 27).
  - `e2e/local/run-all-real.sh`, `run-enrolled-transport.sh`,
    `run-derived-trust.sh`: 토큰 env 주입 + curl 헤더 (이 3개가 `/approve`를
    POST하는 run-*.sh 전부임을 확인).
  - `e2e/local/ci-smoke.html` admin 패널이 reference 서버를 치는 경우 동일
    처리(demo 서버 대상이면 기존 admin-session 유지).
  - `packages/saas/README.md`(:183 인근)와 로컬 데모 문서의 curl 예시에 토큰
    반영.
  - demo는 기존 admin-session 가드 재사용.
- **admin revoke 노출**: demo(admin-session 뒤)와 reference(토큰 가드 뒤)에
  `revokeActive` 경로. 무가드 노출 없음.

### 2.6 문서화

- §0 전체(격리 축, agent HA 불변식, 정확성 보장 범위)와 §2.2의 revoke 의미론
  (미래 bootstrap 한정 / 살아있는 세션·NATS creds 불간섭) + re-key 복구
  runbook을 `docs/AUTH.md`에 명문화.
- CHANGELOG breaking 항목: registry SPI v2 / `approve()` 시그니처 / accountId
  전 구간 필수 / registry 필수화 / reference admin 토큰 / plugin reset 연산.
- P0-1 조율: 직접 파일 겹침 없음(P0-1은 plugin transport/legacy client, P1-1은
  saas registry/enrollment). 단 AUTH.md·CHANGELOG·e2e 스크립트가 양쪽에서
  움직이므로 **P0-1 merge 후 rebase하고 구현 착수**. §5의 "client 패키지
  diff 0"은 P1-1 변경분 한정.

## 3. 테스트 계획

Registry 단위 + conformance (공용 스위트, Memory 구현 구동):
1. 최초 register(expect=null) 성공; getActive 일치; activationId 발급.
2. 점유 슬롯에 register(expect=null, 다른 key) → conflict + current, pin 불변.
3. register(expect=현재 activationId) → 교체 성공; 이전 레코드
   superseded(+endedAt, supersededBy); active 정확히 1개; 새 activationId ≠ 이전.
4. stale expect: (i) 다른 key로 교체된 뒤 옛 activationId → conflict;
   (ii) **supersession 사이클 A→B→A 후 A의 첫 활성화 activationId** → conflict
   (같은 keyId로 돌아왔어도 사건이 다름 — replay 차단의 핵심 케이스).
5. 같은 publicKey 재등록: (i) expect 일치 → idempotent, 이력 무변화;
   (ii) **stale expect라도 현재 active가 같은 key면 idempotent 성공**(§2.2
   판정 순서 2의 우선 적용); (iii) 동시 same-key 다발 → 전부 성공, 이력 1개.
6. revokeActive → getActive null, 이력 revoked; 재차 → false; 같은 pubkey
   재등록 → `reason:"revoked"`(tombstone); 다른 pubkey register(expect=null) →
   성공; revoke↔register 동시 경합에서 불변식(active ≤ 1, tombstone 유지).
7. slotKey 경계 조작(길이 prefix) 충돌 없음 — 기존 테스트 승계.
8. 반환 레코드 변조가 내부 상태에 영향 없음(방어적 복사, append-only 이력).

Enrollment 통합 (단일 프로세스 기본; 25는 예외):
9. registry 없이 DeviceFlowEnrollment 생성 → throw.
10. A approve 후 B approve(확인 없음) → conflict, mint 미발생, B pending,
    A pin 불변, B poll → authorization_pending.
11. 10의 activationId로 재호출 → 교체 성공, bootstrap이 B 서빙, A superseded.
12. 인터리빙 두 갈래: conflict(활성화 X 표시) 후 제3 승인이 X→**B** 교체 →
    `replaceActivationId=X` 재호출 → 새 conflict(existing=B 요약);
    X→**A(같은 incoming key)** 교체 → idempotent 성공(§2.4 예외 규정).
13. supersession-사이클 replay: A→B→A 후, 첫 라운드 conflict가 발급했던
    A-활성화 토큰으로 B를 다시 approve 시도 → conflict(교체 미발생).
14. CAS 패자 creds 차단: 동시 approve(A,B — 다른 userCode; register 지점
    fault-injection 훅으로 순서 고정) → 하나만 approved; 패자는 conflict,
    poll로 creds 획득 불가, store에 creds 미저장.
15. mint 실패 주입(step 3) → registry·store 무변화, 재approve로 정상 회복.
16. **sweep-eviction 후 store 유실(step 5)**: (i) register 성공 → 레코드
    evict → update 무음 no-op → 재조회 검증이 잡아 `{kind:"rejected"}` 반환
    (가짜 approved 금지), 경고 로그; (ii) **검증 직후 eviction**(TOCTOU 잔여)
    → approved가 반환되지만 poll 불가 — 허용 결과로 고정, 재enroll →
    같은-key idempotent 승인으로 회복.
17. A2 fast path: (i) 정상 재approve → 동일 creds, 이력 무변화;
    (ii) reconciliation은 **이력까지 빈 경우만**: **approved enrollment가
    존재하는 상태를 먼저 구성·단언한 뒤**(§2.4 step 1의 추론 전제)
    active=null + history=[] → register(expect=null) 복구 후 creds —
    새-순서 생성 레코드와 **legacy(구 순서, 등록 실패로 approved-무등록)
    fixture 양쪽**에서; (iii) **active=null + history 있음(revoke 직후) →
    registry 무변경** + creds 반환 + 경고 로그 — superseded key 부활 금지
    (r3 resurrection 시퀀스 그대로 재현해 고정);
    (iv) 다른 key active → registry 무변경 + creds 반환.
18. tombstone된 key의 enrollment approve → `kind:"revoked_key"`, mint 미발생
    (gate 선판정); A2 경로에서 tombstone 조합 → 무변경 + 로그(방어선).
19. poll-expiry 인터리빙(결정적 주입): (i) stale expiry write가 step 5 뒤
    착지 → "registry active + enrollment expired", 재enroll로 회복;
    (ii) **absent 클래스** — mint 중 poll expiry 착지 → step 3 재확인이
    등록을 막아 "registry에 그 key 흔적 없음 + expired"; CAS 패배 후 expiry
    → 동일하게 absent + expired;
    (iii) **교차 userCode 조합** — A register 성공 후 B의 확인된 교체/revoke가
    끼어든 상태에서 poll expiry 착지, **3-userCode 시퀀스**(확인된 교체 후
    추가 교체/revoke)까지. 각 결과가 §2.4 불변식(미확인 교체 없음, CAS 패자
    creds 미전달, 클래스별 회복 경로)을 만족함을 고정.
20. register와 store 사이 revokeActive 주입 → "approved creds + revoked pin",
    bootstrap fail-closed.
21. accountId: enroll() 거부; reference·example·**demo** HTTP 어댑터 의도된
    400; plugin EnrollmentClient/acquire-credentials/enrolled-nats-connection
    필수화 반영(기존 default 단언 테스트 교체); buildBootstrapClaims aud 검증.
22. literal `default` account는 자기 자신과만 매칭 (D2 회귀).
23. replace→revoke→재등록(다른 key) 시퀀스의 이력 순서/상태 정합.
24. plugin reset 절차(오프라인 runbook): **문서화된 기본 경로**
    (`~/.openclaw-webchannel/<account>/credentials.json`), **명시적
    `credentialPath` override**, 그리고 **legacy 단일 파일 케이스**(`default`
    account에서 per-account 파일만 지웠을 때 legacy fallback이 조용히 구
    creds를 재사용하지 않음 — fallback 제거 후 회귀) 세 경우 모두에서, 제거
    후 신규 enroll이 새 identity key로 진행되고 tombstone된 구 key와
    무충돌(expect=null 경로); runbook이 "재시작 전 살아있는 transport는 구
    creds로 계속 동작"을 명시함을 고정(온라인 hot-swap을 주장하지 않음).
25. **replica-독립 주장 검증(좁게)**: 하나의 registry(원자적 Memory)를 공유하는
    두 DeviceFlowEnrollment 인스턴스의 교차 approve → CAS 패자 creds 미전달
    (P1-2의 전이 직렬화 주장 없이, §0.2의 무조건 주장만 고정).

HTTP 어댑터:
26. conflict 시 409 + activationId/지문; truthy-success 오인 없음 — **4개
    approve 호출자 전부 개별 검증**: reference enrollment-server, demo
    saas-server, example app, minimal-consumer.
27. `ENROLLMENT_ADMIN_TOKEN` 미설정 → approve/deny/revoke 503; 오토큰 → 401;
    정상 → 동작; enroll/poll/bootstrap은 토큰 없이 동작(zero-setup 유지);
    CORS preflight가 Authorization 허용; enrollment-ui가 토큰 헤더를 싣는 경로;
    **토큰이 응답 HTML·URL·서버 로그에 반사되지 않음** (memory-only 보관).
28. **XSS 회귀**: crafted `user_code`가 스크립트로 실행되지 않음 — HTML sink
    페이로드 + **`</script><script>`·`<!--` 계열 HTML-파서 페이로드** 포함
    (치환 결과에 비이스케이프 `<`가 실행 문맥으로 남지 않음을 검증);
    **템플릿 읽기 실패를 강제해 fallback 렌더 경로에도 동일 페이로드**;
    **`/approve` 응답의 적대적 accountId/tenant/peerId**가 statusEl 경로에서
    DOM element·이벤트 핸들러를 만들지 않음(외부·fallback 템플릿 모두 —
    script 실행 여부만이 아니라 **구조적 DOM 단언**으로 검증: innerHTML로
    삽입된 script는 실행되지 않아도 가짜 green을 만들 수 있다).
29. 테스트 bootstrap 라우트가 caller 제공 agentPublicKey를 무시/거부.

E2E (기존 live harness — P0-1 rebase 후, 토큰 주입 마이그레이션 포함):
30. enroll→approve→bootstrap이 **registry가 서빙한** pin으로 연결; 재enroll
    (확인 흐름 경유) 후 새 브라우저가 새 key로 연결, 구 key wrap K 거부(F2
    승계); revoke 후 새 bootstrap은 pin 미포함(기존 브라우저 세션은 유지됨을
    명시적으로 관찰 — revoke 의미론 문서와 일치).

Wire 호환:
31. bootstrap 응답·enrollment 요청/응답 shape 스냅샷 단언 — P1-1 전후 wire
    형식 무변경을 기계적으로 고정(§5의 "wire 무변경" 주장의 테스트 백업).

## 4. 비범위 (명시)

- `agentId`·wire 변경·복수 logical agent 라우팅 — 현재 미지원이며 향후 제품 결정으로 보류.
- Key rotation overlap window — (b)/후속.
- 복수 issuer replica의 enrollment 전이 직렬화(lease/CAS, 중복 mint 차단),
  enrollment 상태 전이의 조건부화(poll expiry write 포함), approval+registry
  단일 트랜잭션, store update의 boolean 계약화, durable store 구현과 다중
  프로세스 검증 — **P1-2** (P1-1의 registry CAS와 §0.2 durability domain
  규칙이 그 밑돌이다).
- mint된 뒤 전달되지 않은 고아 creds의 무효화 — P1-2/#7·#12 (기존에도 있는
  잔여; P1-1은 "보유자 없는 고아"만 남기고 "전달된 고아"는 제거).
- reference 서버 전면 보안(세션, CSRF, CORS 정책 전반, body limit 등) — P1-4.
  §2.5의 토큰 가드 + XSS sink 수정은 P1-1이 새로 여는 표면(conflict 메타데이터,
  revoke, 페이지 내 토큰)에 대한 최소선이다.
- NATS creds revocation(#7/#12) 연동 — registry revoke는 pin-serving 중단만.

## 5. 완료 조건

전제: §0.2의 보장 범위(단일 issuer 프로세스, store·registry 동일 durability
domain). 이 전제 밖 구성은 미지원으로 **문서에 명시**되는 것까지가 P1-1이다.

- (tenant, account)의 active agent key는 **운영자가 그 활성화(activationId)를
  보고 확인하지 않는 한** 다른 key로 교체되지 않는다 — last-write-wins 경로 0,
  확인 토큰은 supersession 사이클을 포함해 replay 불가. (유일한 무확인 전이는
  §2.4 step 1의 "이력까지 빈 registry" 복구 등록 — 이는 교체가 아니라 유실
  복구이며 대상 key는 과거에 운영자가 승인한 그 key다.)
- 다른 key를 가진 CAS 패자에게 사용 가능한 NATS creds가 전달되는 경로가 없다
  (approved 저장은 register 성공 뒤에만; issuer replica 수와 무관 — 테스트 25).
- registry 없이 approval이 가능한 구성이 존재하지 않는다.
- revoke된 key는 재enroll·A2·reconciliation 어느 경로로도 되살아나지 않는다
  (tombstone); revoke의 효력 범위(미래 bootstrap 한정)와 복구 runbook이 문서화
  되어 있고, 지원되는 re-key 절차가 존재한다.
- enrollment·registry 키잉에서 defaulting 표면 0 (accountId 필수; bootstrap
  claims aud는 subject-token 검증).
- 교체·revoke가 append-only 이력으로 남고, 승인 UI가 교체 대상을 사전 고지하며,
  그 UI 페이지에 알려진 reflected-XSS sink가 없다.
- 승인 성공 보고는 store write 직후 재조회에서 approved를 관측한 경우에만
  나간다(sweep 유실의 무음 가짜 approved 탐지; 관측 직후의 TOCTOU 잔여는
  문서화된 회복 가능 상태 — 완전한 원자화는 P1-2).
- wire 형식 무변경 — bootstrap 응답/enrollment 요청·응답 shape의 스냅샷/스키마
  호환 단언 테스트로 뒷받침(테스트 31); P1-1 변경분 기준 `packages/client`
  diff 0 — 테스트가 아니라 **PR 리뷰/CI diff 체크 항목**으로 명시(구현 PR
  체크리스트에 포함).
- 테스트 1–31 green, conformance 스위트 export.
