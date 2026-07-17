# P1-2 구현 계획 — Atomic enrollment repository SPI

Status: **CONVERGED r4** — codex(gpt-5.6-sol) 적대리뷰 4라운드 수렴:
r1(BLOCKER 2/MAJOR 6/MINOR 2) → r2(MAJOR 5/MINOR 3) → r3(MAJOR 2/MINOR 2) →
**r4 판정 CONVERGED(BLOCKER 0/MAJOR 0/MINOR 1 — 보존 경계 연산자, 본문 반영
완료; 상태×시각 정합 매트릭스 무모순)**.
리뷰 산출: [r1](./P1-2-PLAN-REVIEW-r1.md) · [r2](./P1-2-PLAN-REVIEW-r2.md) ·
[r3](./P1-2-PLAN-REVIEW-r3.md) · [r4](./P1-2-PLAN-REVIEW-r4.md).
원 리뷰: [P1.md — P1-2](./P1.md#p1-2-atomic-enrollment-repository-spi)
브랜치: `feat/p1-2-atomic-enrollment-spi` — **PR #44(`feat/p1-3-nats-transport`) 위 스택**.
P1-3은 plugin/client transport만, P1-2는 saas만 건드려 파일 겹침 없음. PR base를
`feat/p1-3-nats-transport`로 설정해 diff를 분리한다(#44 머지 후 base 자동 전환).

## 0. 범위 결정과 보장 범위

### 0.1 P1-1이 이미 해결한 것 (원 리뷰 서술의 낡은 부분)

원 리뷰(P1.md)는 "approved enrollment를 먼저 저장한 다음 registry에 key를 쓴다"고
서술했으나, P1-1이 approve 순서를 **gate → mint → register(CAS) → store+재조회
검증**으로 뒤집어(`device-flow-enrollment.ts:761–798`) 단일 프로세스에서의
"approved인데 미등록" partial state와 CAS-패자 creds 전달은 이미 제거됐다.
P1-2의 실재 문제는 그 뒤에 남은 것들이다:

- **multi-replica issuer**: per-userCode lock(#22)은 process-local. 복수 replica가
  같은 store를 공유하면 같은 pending을 동시에 읽고 각자 mint한다.
- **register와 store가 두 개의 durable write**: P1-1 순서는 fail-closed지만
  "registry에 새 active + enrollment는 pending"(step 4 성공 → 5 실패) partial
  state가 열거된 잔여로 남아 있다.
- **무조건 CRUD 전이**: `updateEnrollment`는 조건 없는 partial-update + 부재 시
  무음 no-op(:344–349). P1-1은 재조회 검증으로 관측하지만 TOCTOU가 문서화된
  잔여로 남았다. **poll**의 expiry write(:611–620)는 lock 밖 무조건 write라
  같은 프로세스에서도 approved 레코드를 expired로 덮을 수 있다. approve/deny의
  expiry write(:733, :825)는 같은 인스턴스 안에서는 lock+재읽기로 서로 경합하지
  않지만, **replica 간(또는 lock 도메인이 갈라지는 순간) 같은 무조건-write
  계열이 된다** (r1 m1 반영 — 셋을 뭉뚱그리지 않고 구분해 서술).

### 0.2 제품/스코프 결정 (확정)

- **라이브러리는 atomic domain-transition 계약을 제공하고, integrator가 실제
  transaction/CAS를 구현한다** (리뷰 확정 결정). durable adapter 구현물은 P1-2
  산출물이 아니다 — conformance suite가 산출물이다(adapter skeleton은 P1-4).
- **poll 감속(recordPoll + RFC 8628 `slow_down`)은 비범위** (유저 결정 2026-07-16).
  근거: P1-2 완료 조건(원자성)과 무관하고, 서버가 slow_down을 내보내는 순간
  현행 plugin 폴러가 fatal 처리(`enrollment-client.ts:410–415`)라 plugin lockstep이
  따라붙는다. 백로그로 기록.
- **wire·plugin 무변경**: enrollment HTTP 요청/응답 shape, bootstrap 응답, NATS
  subject, plugin 소스 전부 불변(plugin은 **테스트 추가만** — §2.3 N1 항목).
  유일한 HTTP 표면 추가는 approve 어댑터의 `in_progress` 매핑(§2.6, 내부
  admin API — plugin/browser wire 아님).
- P1-1 제품 결정 승계: account = 격리 축, agentId 없음, tombstone 영구,
  A2 reconciliation은 "이력까지 빈 registry"에서만.
- **deny-of-approving은 제품 결정으로 수용** (r2에서 유지 판정): 진행 중 승인
  — 특히 탈취 의심 key — 을 lease 만료 대기 없이 운영자가 즉시 종결한다.

### 0.3 P1-2가 주장하는 보장 (P1-1 §0.2의 전제 해제)

P1-1은 "단일 issuer 프로세스 + store·registry 동일 durability domain" 전제
아래에서만 보장을 주장했다. P1-2 완료 후:

- **repository 계약을 만족하는 구현 하나만 있으면 issuer replica 수와 무관하게**
  (i) 같은 enrollment에 서로 다른 creds가 이중 mint-커밋되지 않고, (ii) approve와
  deny가 서로의 terminal state를 덮지 않으며, (iii) 신규 승인의 approved
  credential과 agent identity 활성화는 `commitApproval` 하나의 commit으로만 함께
  나타나고, legacy 유실 복구(A2 reconciliation)도 별도의 단일 원자 연산으로만
  registry를 쓴다(§2.5).
- **모호한 durable commit의 멱등 회수는 `approvedAt + retentionMs`까지 보장**
  된다(r2 focused-conclusion 반영 — 무기한이 아니라 명시된 지평선; §2.3).
- process-local lock(#22)은 correctness 전제에서 **최적화로 강등**된다(§2.4).
- store와 registry의 durability domain 분리는 **타입 수준에서 불가능**해진다.

## 1. 문제 재정의 — P1-1 이후에도 실재하는 결함 4개

### D1. Replica 이중 mint — 보고된 creds ≠ 전달된 creds

두 issuer replica(공유 durable store 가정)가 같은 userCode의 approve를 받으면
둘 다 `pending`을 읽고 각자 mint한다. **같은 enrollment = 같은 agentPublicKey**
이므로 registry CAS는 이중 방어가 못 된다: 첫 register가 활성화하고 두 번째는
idempotent 성공(P1-1 §2.2 판정 순서 2). 둘 다 `updateEnrollment(approved, creds)`
를 쓰고 **나중 write가 이긴다** — 운영자 A는 creds-A를 승인 결과로 보고받는데
agent가 poll로 받는 것은 creds-B다. 버려진 쪽 creds도 mint된 순간부터 유효한
tenant-wide NATS creds다(전달 안 됐을 뿐 — 고아 creds 무효화는 #7/#12 비범위).

### D2. Approve↔deny replica 경합 — terminal state 상호 덮어쓰기

\#11 status guard는 read-then-act고 #22 lock은 process-local이다. replica A가
pending을 읽고 mint하는 사이 replica B가 `denied`를 쓰면, A의 무조건
`updateEnrollment(approved)`가 deny를 소거한다. 운영자 B에게는 deny 성공이
보고됐는데 agent는 creds를 받는다 — 보안 결정의 무음 반전.

### D3. 무조건 전이 + 무음 no-op의 잔여 TOCTOU

`updateEnrollment`는 레코드 부재 시 성공 resolve하는 no-op이라 P1-1이 재조회
검증을 넣었지만 "검증 직후 sweep eviction" 창은 관측 불가로 남았다(P1-1 test
16-ii가 허용 결과로 고정). poll의 expiry write는 lock 밖 무조건 write라 단일
프로세스에서도 approved를 expired로 덮을 수 있고(승인 커밋과 폴 도착이
expiresAt 경계에서 교차하면 creds가 영영 전달되지 않는다 — silent loss 금지
원칙 위반), approve/deny의 expiry write는 replica 간에서 같은 문제를 낳는다.

### D4. Register와 store 커밋이 분리된 두 durable write

P1-1 순서에서 step 4(register) 성공 후 step 5(store) 실패/유실이면 "registry에
새 active + enrollment pending". 회복 가능(재approve가 같은-key 경로 통과)으로
열거돼 있으나, 리뷰 완료 조건은 "approved credential과 agent identity가 항상
함께 commit"이다 — 두 write를 하나의 트랜잭션 경계 안으로 넣어야 한다.

## 2. 설계

### 2.1 SPI 통합 — `EnrollmentRepository extends AgentKeyRegistry`

D4(단일 commit)는 서로 다른 두 객체(store, registry)에 걸친 원자성을 요구하는데,
분리된 SPI로는 공유 트랜잭션 컨텍스트 없이 표현 불가능하다. 따라서:

- 신설 `EnrollmentRepository`가 `AgentKeyRegistry`(P1-1 v2 — getActive/register/
  revokeActive/listHistory)를 **extends**하고 enrollment 전이 연산을 추가한다.
- `EnrollmentStore` v1(save/get/update/delete)과 `MemoryEnrollmentStore`,
  `MemoryAgentKeyRegistry` 단독 export는 **삭제**한다(0.x 명시적 breaking).
  단독 memory registry가 남아 있으면 P1-1 §0.2가 미지원으로 못박은 혼합
  durability 구성이 다시 조립 가능해진다 — 통합 repository만 남겨 구성 자체를
  타입으로 봉쇄한다.
- bootstrap serving 소비자는 `AgentKeyRegistry` 타입으로 repository를 그대로
  받는다(getActive 시그니처 불변) — serving 경로 코드 변화 없음.
- `MemoryEnrollmentRepository`가 유일한 동봉 구현(단일 프로세스 reference 거동:
  전이마다 await 없는 동기 RMW). 기존 sweeper 옵션(autoSweep/retentionMs/
  sweepIntervalMs) 승계 + **주입 가능한 clock**(생성 옵션; 기본 `Date.now`) —
  내부 sweeper·lease·expiry 판정 전부 이 clock을 쓴다.

### 2.2 상태 기계와 전이 연산

```text
pending ──claimApproval(opId, lease)──► approving ──commitApproval(opId)──► approved
   │ ▲                                     │
   │ └── release(명시적/commit 실패) ◄─────┤        lease 만료 → 재claim 가능(fencing)
   │                                       ├──tryDeny──► denied (r1 M1 / r2 n1)
   ├──tryDeny──► denied (terminal)         └──tryExpire(lease 만료시)──► expired
   └──tryExpire──► expired (terminal; approved/denied 불가)
```

`EnrollmentRecord`(구 `PendingEnrollment` 대체):
`status: "pending" | "approving" | "approved" | "denied" | "expired"` +
`claim?: { opId: string; leaseUntil: number }` (approving에서만 존재) +
`approvedAt?: number`, `committedBy?: string`, `commitDigest?: string`,
`committedRecord?: AgentKeyRecord` (approved에서만 — B1 멱등성·N2 payload
binding·M4 보존 계약·**r3 M1(정확한 결과 재현)**의 근거 필드).
`committedRecord`는 커밋 트랜잭션이 만든 활성화 레코드의 **불변 스냅샷**을 같은
트랜잭션에서 함께 영속한 것이다 — 슬롯이 이후 supersede/revoke되어도 멱등
회수는 이 스냅샷을 그대로 반환한다(getActive/이력 스캔으로는 "그때 그 레코드"를
복원할 수 없다 — 같은 key가 복수 활성화 사건을 가질 수 있으므로).
wire 타입(EnrollmentRequest/Response/Result, DeviceFlowError)은 불변.

```ts
type ClaimApprovalOutcome =
  | { kind: "claimed"; enrollment: EnrollmentRecord }        // pending→approving; lease 만료된 approving의 재claim 포함
  | { kind: "already_approved"; enrollment: EnrollmentRecord } // A2 재반환용 (creds/peerId/approvedAt/committedBy 보유 보장)
  | { kind: "in_progress"; leaseUntil: number }               // 살아있는 타인 lease
  | { kind: "denied" }
  | { kind: "expired" }                                       // expiresAt 경과 (관측 시 조건부 전이 동반)
  | { kind: "not_found" };

type CommitApprovalOutcome =
  | { kind: "committed"; record: AgentKeyRecord; idempotent: boolean }
    // ONE 트랜잭션: approved+creds+peerId+approvedAt+committedBy+commitDigest+
    // committedRecord 스냅샷 저장 && registry 활성화(supersede 포함).
    // idempotent=true: 같은 opId+같은 payload 재시도가 기존 커밋 결과를 회수(B1)
    // — record는 영속된 committedRecord 스냅샷 그대로(이후 슬롯 변화와 무관, r3 M1).
  | { kind: "claim_lost" }                                    // 펜스 실패(§펜싱 규칙) — 상태 무변경
  | { kind: "expired" }                                       // commit 시점 expiresAt 경과 — enrollment→expired, registry 무변경
  | { kind: "conflict"; current: AgentKeyRecord | null }      // registry CAS 불일치 — claim 해제(→pending), registry 무변경
  | { kind: "revoked" };                                      // tombstone — claim 해제(→pending), registry 무변경

type TryExpireOutcome = {
  transitioned: boolean;
  /** 연산 직후의 레코드 — poll은 이것만으로 응답한다(r1 m2 / r2 N3: stale 재사용
   *  금지, caller 시계 판정 금지). approved면 creds/peerId 포함 스냅샷. */
  enrollment: EnrollmentRecord | null;
};

type ReconcileOutcome =
  | { kind: "registered"; record: AgentKeyRecord }   // registry가 이 슬롯을 완전히 잃었던 경우의 복구 등록
  | { kind: "noop"; reason: "not_found" | "not_approved" | "active_present" | "history_present" };
    // 판정 우선순위 고정(r2 n2): not_found > not_approved > active_present > history_present.
    // active는 append-only 모델상 history를 함의하므로 둘 다 있으면 active_present.

interface EnrollmentRepository extends AgentKeyRegistry {
  /** 신규 삽입 전용. user_code 충돌 → UserCodeCollisionError, device_code 충돌 →
   *  DeviceCodeCollisionError (이름 기반 매칭 계약은 v1의 UserCodeCollisionError
   *  규약 승계 — enroll()은 두 오류 모두에서 양쪽 코드를 재mint하고 재시도). */
  createEnrollment(enrollment: EnrollmentRecord): Promise<void>;
  getEnrollment(deviceCode: string): Promise<EnrollmentRecord | null>;
  getEnrollmentByUserCode(userCode: string): Promise<EnrollmentRecord | null>;

  claimApproval(userCode: string, opId: string, leaseMs: number): Promise<ClaimApprovalOutcome>;
  commitApproval(opId: string, commit: {
    creds: NatsUserCredentials; peerId: string;
    agentPublicKey: string; expect: ActivationId | null;
  }): Promise<CommitApprovalOutcome>;
  /** opId 소유 claim만 pending으로 되돌림. 비소유/부재 → false (no-op). */
  releaseClaim(opId: string): Promise<boolean>;

  /** pending|approving → denied (approving이면 claim 무효화 — 이후 그 opId의
   *  commit은 펜스에 걸린다). approved/expired/denied → false.
   *  repository 시계로 expiresAt이 이미 지난 pending/approving은 deny 대신
   *  expired로 전이하고 false를 반환한다(시계 권위 일원화). */
  tryDeny(userCode: string): Promise<boolean>;
  /** repository 시계로 판정하는 조건부 만료 + 관측(N3): pending → expired;
   *  approving은 lease 만료시에만 → expired; 그 외 transitioned:false.
   *  항상 연산 직후 레코드를 반환한다 — poll의 유일한 읽기 경로. */
  tryExpire(deviceCode: string): Promise<TryExpireOutcome>;

  /** A2 유실 복구 전용 원자 연산(r1 M2): 하나의 RMW로
   *  (i) 레코드가 approved인지, (ii) 슬롯 active==null && history==[]인지 검사한 뒤
   *  통과 시에만 enrollment.agentPublicKey를 register(expect=null) 의미로 활성화.
   *  어느 검사든 실패하면 registry 무변경 + noop(reason — 우선순위 위 참조). */
  reconcileApprovedRegistration(deviceCode: string): Promise<ReconcileOutcome>;

  /** retention 경과 레코드 evict — 시각은 repository 시계만 사용(r2 n3:
   *  caller-supplied now 없음). §2.3의 보존 계약(approved 최소 보존, 살아있는
   *  lease의 approving 보호)을 지켜야 한다. */
  sweep(): Promise<number>;
}
```

**펜싱 규칙 (B2 — lease 자체가 펜스, repository 시계가 기준):**

`commitApproval(opId, commit)`은 하나의 원자 RMW 안에서 다음 순서로 판정한다:

1. **멱등 회수 (B1 + r2 N2)**: 레코드가 `approved`이고 `committedBy === opId`
   → **저장된 `commitDigest`와 이번 payload의 canonical digest를 대조**한다.
   일치 → `{kind:"committed", idempotent:true}` + 저장된 결과 그대로. 불일치 →
   `CommitPayloadMismatchError` **throw**(호출자 계약 위반 — outcome 아님).
   digest는 `agentPublicKey`·`peerId`·`creds`·`expect` 전부를 덮는 canonical
   직렬화의 SHA-256이다(**expect 포함** — 재시도는 동일 호출의 반복이어야 한다).
   반환 `record`는 영속된 `committedRecord` 스냅샷이다(r3 M1 — 이후 슬롯이
   supersede/revoke되어도 원래 커밋이 반환했던 그 레코드). 이 판정은 **lease와
   무관** — 커밋은 이미 성립했다.
2. **펜스**: 레코드가 `approving`이고 `claim.opId === opId`이고
   **repository 시계로 `now <= leaseUntil`**일 때만 통과. 셋 중 하나라도
   불충족(레코드 부재·상태 상이·타인 claim·**재claim 없이도 lease 경과**) →
   `{kind:"claim_lost"}`, **mutation 없음**. 시계는 repository가 소유한다
   (Memory: 주입 clock/`Date.now`; SQL: `now()`; 호출자 시계는 사용 금지).
3. **만료**: `now > expiresAt` → enrollment→expired, registry 무변경, `expired`.
4. **payload binding**: `commit.agentPublicKey !== enrollment.agentPublicKey` →
   throw(호출자 버그). 이어 **registry 판정** (P1-1 우선순위 그대로: tombstone >
   same-key idempotent > CAS(expect)) → 실패 시 claim 해제(→pending) +
   `conflict`/`revoked`.
5. **커밋**: enrollment(approved, creds, peerId, approvedAt=now,
   committedBy=opId, commitDigest) && registry 활성화(이전 active supersede
   포함)를 한 트랜잭션으로.

**`claimApproval` 판정표 (r3 m1 — 원자 RMW 안에서 위에서 아래로 첫 매치):**

1. 레코드 부재 → `not_found`.
2. `approved` → `already_approved` (expiresAt 경과와 무관 — 보존 창이 지배;
   evict 후에는 1의 not_found).
3. `denied` → `denied`; `expired` → `expired`.
4. `pending`이고 repository 시계로 `now > expiresAt` → **expired 전이** + `expired`.
5. `approving`이고 `now <= leaseUntil`(live lease) → `in_progress`
   (**expiresAt 경과 여부와 무관** — 만료 처리는 lease 소유자의 commit(규칙 3)
   또는 lease 소진 후 관측이 담당한다; 타 claimant가 소유자 진행 중에 레코드를
   전이시키지 않는다).
6. `approving`이고 lease 소진: `now > expiresAt`이면 **expired 전이** + `expired`,
   아니면 **재claim**(claim 교체) + `claimed`.
7. 나머지(`pending`, 유효 창 내) → **claim 기록** + `claimed`.

tryExpire·tryDeny·commitApproval의 만료 규칙과 이 표는 서로 모순 없이 정렬된다:
live lease 중 레코드를 전이시킬 수 있는 것은 소유자의 commit과 운영자의
tryDeny뿐이다.

opId(crypto-random 128bit, 발급자 = DeviceFlowEnrollment 호출 단위)는 **전역
유일·재사용 금지가 호출자 계약**이다(재사용은 계약 위반 — conformance가 이를
"조용히 지원하지 않음"으로 고정, r2 focused-conclusion 3). 소유자 식별은 opId,
**경계는 lease 시각 비교가 담당** — "만료됐지만 아직 아무도 재claim 안 한" 창의
commit은 명시적으로 `claim_lost`다. 별도의 단조 증가 generation 카운터는 두지
않는다: 판정 전체가 단일 직렬화 지점의 원자 RMW이고 opId가 전역 유일이므로
ABA가 성립하지 않는다. 재claim은 claim 필드를 원자적으로 교체한다.

시계 후퇴(rollback) 정책: repository 시계는 단조 가정. 후퇴가 일어나면 만료된
lease가 일시 부활할 수 있으나 opId 소유 판정은 불변이므로 **타인 commit 수용은
불가능**하다 — 최악은 자기 자신의 늦은 commit 수용이며 이는 재claim 전이면
의미상 무해(같은 mint 산물). 계약 문서에 명시하고, conformance는 주입 시계로
전진만 검증한다.

**시각 스탬핑 vs 판정의 분리(문서 명시)**: `createdAt`/`expiresAt`은 issuer가
enroll 시점에 스탬프하고(issuer 시계), 만료·lease **판정**은 전부 repository
시계다. 두 시계의 skew는 유효 승인 창이 그만큼 늘거나 주는 것으로 나타나며
정확성(펜싱·원자성)에는 영향이 없다 — Memory·conformance에서는 주입 clock
하나로 통일된다.

lease 기본 30s(`DeviceFlowOptions.approvalLeaseMs`로 조정). mint는 로컬 nkey
서명이라 통상 ms 단위지만, mint가 lease를 초과하면 commit이 `claim_lost`로
죽고 approve는 rejected를 반환한다 — creds는 전달 경로가 없는 고아로 남고(#7/
\#12 비범위) 재approve가 회복한다. **lease 갱신(renewal) 연산은 도입하지
않는다**: 갱신은 fencing을 복잡하게 만들고, 실패 모드가 "재시도"로 충분히
회복되므로 P1-2에서는 상한 초과 = 실패로 고정한다(문서 명시).

**원자성 계약(SPI 규범):**

- 같은 레코드/슬롯에 대한 모든 전이 연산(claim/commit/release/tryDeny/tryExpire/
  reconcile/register/revokeActive)은 원자적 read-modify-write이고 단일 직렬화
  지점을 가진다. reader는 개별 호출 기준 전이 전/후 일관 스냅샷을 반환한다 —
  **복수 reader 호출에 걸친 joint snapshot은 계약이 아니다**(r1 M6; 교차 검증은
  §2.7의 history 기반 불변식으로 한다).
- `commitApproval`의 트랜잭션 경계는 **enrollment 레코드 + (tenant, accountId)
  registry 슬롯 + 그 슬롯의 history**를 함께 덮는다. 어떤 실패 outcome도 부분
  상태를 남기지 않는다(approved-without-registered 불가; commit 경로發 신규
  activation-without-approved 불가).
- mint(비동기/CPU 작업)는 트랜잭션 콜백 밖이다(리뷰 명시): claim(lease) → mint
  → 짧은 commit.
- 이력 보존·tombstone 비손실 계약은 P1-1 §2.2에서 승계.

### 2.3 SPI 이식성 규범 (r1 M3) + 보존·픽업 계약 (r1 M4 / r2 N1)

**식별자/유일성:**

- `opId`: 호출자(DeviceFlowEnrollment)가 crypto-random 128bit base64url로 발급.
  **전역 유일·재사용 금지가 계약** — repository는 유일성을 검증할 의무가 없고,
  미지의 opId는 `claim_lost`로 답한다.
- `device_code`, `user_code`: 저장소 수준 unique 제약이 계약. 충돌은 각각
  `DeviceCodeCollisionError`/`UserCodeCollisionError`(instanceof 또는 `name`
  매칭 — v1 규약 승계)로 표면화하고, `enroll()`은 둘 다에서 양쪽 코드를
  재mint해 재시도한다(MAX_ENROLL_ATTEMPTS 유지).

**payload binding (r2 N2 통합):** 멱등 회수는 `commitDigest` 대조를 통과해야
하고(§2.2 규칙 1), 신규 커밋은 `agentPublicKey` 일치를 요구한다(규칙 4). 두
검증 모두 불일치는 **throw**(`CommitPayloadMismatchError` — DeviceFlowEnrollment
는 항상 레코드·동일 호출 인자에서 구성하므로 발생 = 버그)다. outcome으로
표현하지 않는 이유: 어댑터 간 임의 해석을 없애고 호출자 규율을 강제한다.

**멱등 결과의 보존과 지평선:** approved 레코드(creds/peerId/approvedAt/
committedBy/commitDigest/committedRecord)가 곧 operation result의 영속 표현이다.
**보존 계약 — 경계 연산자 규범 고정(r4 n1)**: `retain while now <= base +
retentionMs; evict only when now > base + retentionMs` — base는 approved면
**approvedAt(승인 커밋 시각 — expiresAt 아님)**, pending/denied/expired면
expiresAt. 등호는 **보존**이다(어댑터 간 밀리초 경계 불일치 금지). 살아있는
lease의 approving은 evict 금지. **B1 멱등 회수의 보장 지평선도 정확히 이 창이다**: eviction 후 같은
opId의 commit은 `claim_lost`가 되고(레코드 부재), 이는 이중 활성화가 아니라
회수 실패다 — 새 enrollment는 여전히 registry CAS/tombstone 규칙을 통과해야
한다(r2 focused-conclusion 2를 계약으로 명문화).

**retention은 규범적 설정값이다 (r3 M2)**: 어댑터 임의값이 아니라 구현이
**설정받은 값을 정확히 준수**해야 하는 계약 파라미터다(conformance가 설정값
기준 경계 양측을 검증 — §2.7). 제품 기본값은 300_000ms(현행
DEFAULT_RETENTION_MS 승계)이고, 0/과소 retention은 경계 grace와 멱등 회수를
실질 무력화하므로 AUTH.md 가이드에 하한 권고(≥ poll interval×2 + 예상 시계
skew)를 명시한다.

**픽업 데드라인 정책(공개 문서화 — r2 N1 반영, 재서술):**

- `expires_in`은 **클라이언트 계약상 승인+회수의 데드라인 그대로**다 — 현행
  plugin은 `expires_in`으로 로컬 데드라인을 계산해 그 안에서만 폴하고
  (`enrollment-client.ts:395–431`), P1-2는 plugin을 바꾸지 않는다. "5분 회수
  창"을 클라이언트 데드라인 연장으로 **광고하지 않는다**.
- `approvedAt + retentionMs` 보존 창의 역할은 두 가지로 한정해 문서화한다:
  (i) **경계에서 늦게 도착하는 폴의 grace** — 데드라인 직전에 발사된 폴이
  네트워크 지연/시계 skew로 서버에 늦게 닿아도 approved 레코드가 expired로
  뒤집히거나 evict되어 있지 않다(D3 수정의 실사용 수혜 경로),
  (ii) **B1 멱등 회수의 지평선**.
- 승인이 마지막 폴 이후·데드라인 직전에 커밋되면 클라이언트가 회수하지 못할
  수 있다 — 이는 RFC 8628 device flow 고유의 경계 레이스로, 회복은 재enroll
  이다(현행과 동일; `device-flow-types.ts:89–93` 문서를 "승인 데드라인 +
  경계 grace" 구분으로 갱신). 자동 재enroll은 비범위.
- 보존 창 경과 후 poll은 `invalid_device_code`(plugin fatal — 현행 거동,
  회복 = 재enroll; AUTH.md/README 명시).
- 검증(N1): **plugin 폴 루프 레벨 통합 테스트**(plugin 소스 무변경, 테스트
  추가만) — 데드라인 직전 커밋 + 마지막 폴이 서버 도착 시점에 expiresAt을
  넘긴 시나리오에서 enrollment가 성공함을 고정.

**구현 가능성 스케치(문서 포함, 규범 아님):**

- PostgreSQL: enrollments(device_code PK, user_code UNIQUE) +
  agent_key_records(tenant, account_id, activation_id PK; active 부분 유니크
  인덱스) — `commitApproval`은 단일 트랜잭션에서 enrollment 행을
  `SELECT ... FOR UPDATE`, 슬롯을 advisory lock 또는 active-행 FOR UPDATE로
  잠근 뒤 판정·갱신. serialization 실패는 재시도.
- Redis: 모든 판정·갱신을 하나의 Lua 스크립트로. **Redis Cluster는 enrollment
  키(device_code 기준)와 registry 슬롯 키(tenant/account 기준)가 자연히 같은
  hash slot에 있지 않으므로, issuer 키스페이스 전체를 단일 hash tag로 묶지
  않는 한 비적합** — README durable-구현 가이드에 명시(단일 인스턴스/논클러스터
  Redis는 문제 없음).

### 2.4 `DeviceFlowEnrollment` 재배선

`DeviceFlowOptions`: `store?: EnrollmentStore` + `agentKeyRegistry` 삭제 →
`repository: EnrollmentRepository` **필수**(부재 시 생성자 throw — P1-1 registry
필수화와 같은 원칙; memory 기본 생성 제거로 dev도 명시적으로
`new MemoryEnrollmentRepository()`를 쓴다). `approvalLeaseMs?: number` 추가
(기본 30_000).

**시각 규율(N3)**: DeviceFlowEnrollment는 만료·lease 판정에 자기 시계를 쓰지
않는다 — 모든 시간 민감 판정은 repository 연산(claim/commit/tryDeny/tryExpire)
안에서 repository 시계로 일어난다. issuer 시계는 `createdAt`/`expiresAt` 스탬프
에만 쓴다(§2.2 스탬핑 vs 판정 분리).

`approveInner` 새 순서 (per-userCode lock 내부 — lock은 이제 최적화):

1. `opId = crypto random 128bit`; `claimApproval(userCode, opId, leaseMs)`.
   - `already_approved` → **`reconcileApprovedRegistration(deviceCode)`**(원자,
     §2.5) 호출 후 creds 재반환. reconcile outcome은 로그만(기존 의미 유지:
     creds 유효성은 pin과 독립).
   - `in_progress` → 신규 `ApproveOutcome { kind: "in_progress" }` (§2.6 매핑).
   - `denied`/`expired`/`not_found` → `{kind:"rejected"}`.
2. **Gate** (P1-1과 동일한 UX 계약): `listHistory` tombstone 선판정 →
   `revoked_key` + releaseClaim; `getActive`로 expect 결정, 불일치 →
   `conflict` + releaseClaim (mint 없음, enrollment pending 복귀). gate는
   UX용 사전 판정이고 **권위는 commit의 트랜잭션-내 재평가**다.
3. **Mint** creds + peerId. 실패 → releaseClaim + rethrow (release 실패해도
   lease 만료가 회복).
4. `commitApproval(opId, {creds, peerId, agentPublicKey, expect})`.
   - `committed` → `{kind:"approved", result}` (idempotent 여부 무관 동일 응답).
   - **repository가 throw한 경우(모호한 커밋 — 연결 단절 등): 같은 opId·같은
     payload 인스턴스로 1회 재호출**한다. 커밋이 실제로 성립했다면 digest 대조
     후 멱등 회수(`idempotent:true`)로 정확히 같은 결과를 받고, 아니면
     `claim_lost`(lease 소진)나 재판정 결과를 받는다 — 이중 mint/이중 활성화는
     어느 경우에도 없다(B1). 재호출도 throw하면 rejected가 아니라 **오류
     전파**(호출자/HTTP 500 경계 — 성공도 실패도 아닌 것을 rejected로 위장하지
     않는다).
   - `conflict`/`revoked` → 해당 outcome (claim은 repository가 해제 완료 —
     운영자는 새 확인 토큰으로 재시도).
   - `expired`/`claim_lost` → `{kind:"rejected"}`.
5. ~~재조회 검증~~ **삭제**: commit이 조건부·원자이므로 P1-1 step 5의 관측 검증과
   TOCTOU 문서화(test 16-ii의 허용 결과)가 불필요해진다. 가짜 approved 보고
   경로가 원천 제거된다.

`denyInner`: `tryDeny` 한 번으로 대체(조건부 — read-then-act 제거; 만료 판정도
연산 내부의 repository 시계). boolean 공개 시그니처 유지. **deny는 pending과
approving 모두에서 성립**한다(r1 M1): approving은 creds가 아직 전달되지 않은
상태이므로 #11의 근거("approved는 살아 있는 creds를 가진 레코드")를 침해하지
않고, 운영자는 진행 중 승인을 lease 만료를 기다리지 않고 즉시 종결할 수 있다.
denied 전이는 claim을 무효화하며, 그 뒤 도착하는 claimant의 commit은 펜스
2(상태 ≠ approving)에서 `claim_lost`로 죽는다. **단, 커밋이 이미 durable하게
성립한 뒤의 deny는 false다**(레코드가 approved — #11 유지): "커밋 성립 → 응답
유실 → deny → 멱등 재시도" 시퀀스에서 재시도는 규칙 1로 approved 결과를
회수하고 deny는 false — 모순된 terminal 쌍이 생기지 않는다(r2
focused-conclusion 1을 테스트로 고정). 이미 mint된 creds는 전달 경로 없는
고아로 남는다(#7/#12 비범위 — 문서 명시).

`poll` 재배선 (N3):

- **유일한 경로: `tryExpire(deviceCode)` 호출** — 레코드 관측과 조건부 만료가
  repository 시계로 한 원자 연산에서 일어나고, poll은 **반환된 enrollment만으로**
  응답한다(별도 getEnrollment/issuer 시계 판정 없음):
  - `null` → `invalid_device_code`.
  - `pending`/`approving` → `authorization_pending`.
  - `expired` → `expired_token`; `denied` → `access_denied`.
  - `approved` → creds 응답 — **expiresAt 경과 여부와 무관**(보존 창 동안;
    D3 수정). expire-vs-commit 경합은 연산의 직렬화가 결정하고 응답은 승자
    상태를 그대로 반영한다(m2).
- issuer 시계 지연/선행이 응답을 왜곡하지 않는다 — skew 테스트로 고정.

`enroll`: `createEnrollment` 호출로 대체 — 충돌 재시도 루프(MAX_ENROLL_ATTEMPTS)
는 UserCode/DeviceCode 두 collision 오류 모두에서 재시도.

### 2.5 A2 reconciliation의 원자화 (r1 M2)

P1-1의 already_approved 경로는 `getActive` → `listHistory` → `register`를
따로따로 불렀다 — 두 read가 스냅샷이 아니고 register가 트랜잭션 밖이라
"항상 함께 commit" 주장과 모순이며, 동시 신규 enrollment/revoke와의 경합 결과가
미정의였다. P1-2는 이를 `reconcileApprovedRegistration(deviceCode)` **단일 원자
RMW**로 교체한다: 검사(approved인가, active==null && history==[]인가)와 활성화가
한 직렬화 지점 안에서 일어나므로,

- 동시 commit/register가 먼저 슬롯을 채우면 → `noop("active_present"
  | "history_present")` — superseded 부활 없음(P1-1 r3 resurrection 차단 유지).
  tombstone만 남은 슬롯(revoke 직후)도 `history_present` noop — P1-1의
  anti-resurrection 의미 그대로(r2 focused-conclusion 4).
- reconcile이 먼저면 → 신규 활성화가 등록되고, 뒤따르는 다른 key의
  register(expect=null)는 정상 `conflict`.
- 어느 쪽이든 creds 재반환은 그대로(기존 의미: creds 유효성은 pin과 독립),
  outcome은 경고 로그로 표면화.

reconcile은 legacy 유실 복구(혼합 durability 재시작, P1-1 이전 구-순서 레코드)
전용이며, 신규 커밋 경로의 원자성 주장(§0.3-iii)과 별개의 — 그러나 그 자체로
원자적인 — 연산으로 문서화한다.

### 2.6 소비자 변경

- **생성 4곳(런타임)**: `demo/saas-server.ts:272–277`, reference
  `enrollment-server.ts:210–213`, `examples/webchannel-app/server/index.ts:156–157`,
  `examples/minimal-consumer/src/operator.ts:136–144` — store+registry 2객체
  생성을 `new MemoryEnrollmentRepository()` 하나로 교체, bootstrap serving과
  admin revoke는 같은 인스턴스를 `AgentKeyRegistry`로 사용.
- **approve 디스패치 전수 — 파일명 명시 (r2 N4; "4곳" 서술 폐기)**: reference/
  demo는 `.approve()`를 직접 부르지 않고 **공유 핸들러 경유**임을 실측 확인:
  1. `packages/saas/src/enrollment-http-handler.ts:99–107` — reference·demo
     프로파일 공용. **현행 디스패치가 non-exhaustive**: conflict/revoked_key/
     rejected만 분기하고 나머지는 approved로 fall-through → `in_progress`
     추가 시 `outcome.result` 접근으로 런타임 붕괴. **exhaustive `never` 체크로
     재작성**하고 `in_progress` → 409 + 구분 error 코드("approval in progress,
     retry shortly"; conflict 409와 코드/페이로드 구분) 매핑.
  2. `examples/webchannel-app/server/index.ts:210` — 동일 규율.
  3. `examples/minimal-consumer/src/operator.ts:86, :155` — 동일 규율.
  네 파일 모두(공유 핸들러 포함) `ApproveOutcome`에 대한 exhaustive switch +
  `never` guard 필수. UI(reference/demo)는 재시도 안내.
- **barrel** (`packages/saas/src/index.ts`): `EnrollmentStore`/
  `MemoryEnrollmentStore`/`MemoryAgentKeyRegistry` export 제거,
  `EnrollmentRepository`/`MemoryEnrollmentRepository`/outcome 타입들/
  `DeviceCodeCollisionError`/`CommitPayloadMismatchError`/
  repository-conformance export 추가.
- **마이그레이션 전수 매트릭스 (r1 M5 + r2 N4 — rg 실측 기반, 구현 PR에서
  재검증):**
  - saas 소스: `device-flow-enrollment.ts`(전면), `device-flow-types.ts`(레코드
    타입), `agent-key-registry.ts`(Memory 구현 제거 또는 repository 내부로
    흡수), `index.ts`(barrel), **`enrollment-http-handler.ts`(approve 디스패치
    exhaustive 재작성)**, `agent-key-registry-conformance.ts`(repository
    인스턴스로 구동되게 시그니처 확인).
  - saas 테스트: `device-flow-enrollment.test.ts`,
    `agent-key-registry-v2-integration.test.ts`(:3–27 삭제 SPI 직수입),
    `agent-key-registry.test.ts`, `nats-user-jwt.test.ts`(:11–23 registry 직접
    생성), `external-nats-account.test.ts`, `nats-permissions-realserver.test.ts`,
    `p1-1-http-ui-contract.test.ts`.
  - plugin 테스트: `packages/plugin/src/enrollment-client.test.ts`(서버 fixture
    구성 확인 + §2.3 N1 폴-루프 경계 테스트 추가; plugin 소스 무변경).
  - 소비자: 위 생성 4곳·디스패치 3파일 + `examples/minimal-consumer/test/
    boundary.test.mjs:36`(export 명단).
  - 문서: `packages/saas/README.md`(store 예시·durable 가이드), `docs/AUTH.md`,
    CHANGELOG.
  - 게이트: **격리 worktree에서 전 워크스페이스 build + typecheck(테스트 포함
    `tsc --noEmit`)** — 삭제 export의 잔존 직수입은 typecheck가 전수 적발
    (P0-1/P1-3에서 학습한 symlink·TS 버전 함정 회피 절차 승계). e2e는
    `e2e/local/run-all-real.sh`·`run-enrolled-transport.sh`·
    `run-derived-trust.sh`·`run-two-account-isolation.sh`(existing admin-token
    주입 절차 그대로) + examples 2종 smoke.
- **registry-only conformance의 구동 대상**: `MemoryEnrollmentRepository`
  인스턴스(extends이므로 그대로 통과해야 함). 별도 내부 fixture 안 만든다.
- **문서**: AUTH.md — P1-1 §0.2의 "단일 issuer 프로세스" 전제 문단을 P1-2
  계약("repository 계약 충족 시 replica 수 무관")으로 대체; lease/펜싱/시계
  권위(스탬핑 vs 판정)/모호 커밋 재시도·멱등 지평선; deny-of-approving과 고아
  creds; 승인 데드라인 vs 경계 grace 구분(§2.3). `packages/saas/README.md` —
  durable 구현 가이드(트랜잭션 경계, PG/Redis 스케치, Redis Cluster 제약,
  conformance 돌리는 법, 실백엔드 다중 클라이언트 검증 의무).
  CHANGELOG breaking: SPI 통합/EnrollmentStore 삭제/repository 필수화/
  ApproveOutcome 확장/poll의 approved-past-expiry 거동 수정/deny-of-approving.

### 2.7 Conformance 하니스 (r1 M6 / r2 N5 재설계)

`packages/saas/src/enrollment-repository-conformance.ts` export.

**하니스 API (인스턴스 스코프 — r2 N5):**

```ts
runEnrollmentRepositoryConformance({
  /** 테스트 케이스마다 새로 호출 — reset 의미는 "새 인스턴스"로 고정.
   *  config는 규범적 요구(r3 M2): 구현은 요청된 retentionMs를 정확히 준수하고
   *  autoSweep:false에서 배경 타이머를 켜지 않아야 한다(스위트가 sweep()을
   *  명시 호출). 스위트는 이 설정값으로 보존 경계 시각을 계산한다. */
  create(config: { retentionMs: number; autoSweep: false }): Promise<{
    repo: EnrollmentRepository;
    close(): Promise<void>;
    /** 이 repo 인스턴스의 권위 시계 제어(없으면 clock 스위트 skip).
     *  advance는 비동기 — 원격 어댑터가 DB 시계를 조정할 수 있게. */
    clock?: { now(): number; advance(ms: number): Promise<void> };
  }>,
})
```

- **failpoints·barrier는 어댑터 capability가 아니라 하니스 소유의 generic
  decorator다**: `interpose(repo, hooks)`가 임의 `EnrollmentRepository`를 감싸
  연산별 before/after hook을 제공한다.
  - **모호 커밋** = after-hook `throwAfterCommit({ times = 1 })`: 내부
    `commitApproval`이 **`kind:"committed"`로 resolve된 뒤**(mutation durable)
    호출자에게 반환하기 전에 throw — 어떤 어댑터에서든 "커밋됐는데 응답 유실"을
    정확히 재현한다. `times`로 연속 발화 횟수를 지정(카운트다운, 소비 후 자동
    해제, 소비 여부 질의 가능; r3 m2 — 테스트 14의 2연속 throw는 `times:2`).
    committed가 아닌 outcome에는 발화하지 않는다(성공 응답의 유실만 모델링).
  - **barrier** = before/after-hook의 pause/resume — claim-후·commit-전 등
    인터리빙을 임의 어댑터에서 결정적으로 구성한다(r2 N5가 지적한 mint/op
    barrier 부재 해소; DeviceFlowEnrollment 통합 테스트도 같은 decorator를
    repository 자리에 꽂아 순서를 고정한다 — 프로덕션 코드에 테스트 seam
    불요).
- **core 스위트**(clock 불요): 외부 관측 거동 — outcome/최종상태 허용 집합 +
  불변식.
- **clock 스위트**(clock 필요): lease 경계(`now == leaseUntil` 포함), 만료-후-
  무재claim commit, 재claim 펜싱, 보존 창(approvedAt 기산), 시계 전진만 검증.
- **fault 스위트**(decorator 기반 — 모든 어댑터에서 구동 가능): 모호 커밋 →
  같은 opId+payload 재시도가 동일 결과 멱등 회수(이중 mint/활성화 없음);
  payload 변조 재시도 → `CommitPayloadMismatchError`.
- Memory 구현은 clock 포함 전부 제공(reference); durable adapter는 core+fault
  필수·clock 권장이고, **실제 공유 백엔드에 독립 클라이언트 여럿을 붙여
  돌리는 것이 integrator 검증 의무**임을 README에 명시한다(JS 단일 객체
  동시성 = run-to-completion 증명에 불과함을 정직하게 기술).

**불변식 검증 방식**: 복수 reader에 걸친 joint snapshot은 요구하지 않는다.
대신 **history 기반 불변식**을 쓴다 — `listHistory`는 append-only이므로,
"enrollment가 approved(committedBy=op)라면 그 commit이 만든 활성화 레코드가
history에 존재한다"는 시점 무관 단언이 가능하다(커밋 원자성의 관측 가능한
투영). 그 역(활성화 있는데 approved 아님)은 commit 경로 한정으로 단언
(reconcile/직접 register는 별도 표시). 기존 registry conformance(P1-1)도
repository 인스턴스로 전량 재실행.

## 3. 테스트 계획

Repository conformance (Memory 구현 구동, export):
1. claim 배타성: 동시 claim N개 → 정확히 1 claimed, 나머지 in_progress(동일
   leaseUntil 관측).
2. 펜싱/lease 경계(clock 스위트): (i) lease 만료 → 재claim 성공(새 opId), 구
   opId commit → claim_lost(상태 무변경), 구 opId release → false;
   (ii) **만료 후 재claim 없이** 구 opId commit → claim_lost;
   (iii) `now == leaseUntil` 경계 → 수용(<=); (iv) commit-vs-재claim 양순서
   결정적 구동(barrier) — 어느 쪽이 먼저든 승자 하나, creds 단일;
   (v) **claim 판정표 경계(r3 m1)**: live lease + expiresAt 경과 상태에서 타
   claimant → in_progress(전이 없음); lease 소진 + expiresAt 경과 → expired
   전이; lease 소진 + 유효 창 → 재claim.
3. **멱등 커밋(B1/N2)**: committed 후 같은 opId+동일 payload 재호출 →
   idempotent:true + 정확히 같은 creds/peerId/record, 재mint·재활성화 없음;
   **커밋 → 슬롯 supersede(새 enrollment 확인 교체) 또는 revoke → 원 opId+
   payload 재시도 → 원래 커밋이 반환했던 committedRecord 스냅샷 그대로**(r3
   M1); **fault 스위트**: 모호 커밋(decorator) → 같은 재시도가 동일 결과 회수;
   **payload 변조 재시도 4종(key/creds/peerId/expect 각각)** →
   CommitPayloadMismatchError throw, 상태 무변경; 다른 opId는 claim_lost;
   **opId 재사용(다른 enrollment에)** → 계약 위반으로 조용히 성공하지 않음.
4. commit 원자성: committed 후 enrollment approved && 해당 활성화가 history에
   존재(history 기반 불변식); conflict/revoked/expired/claim_lost 각각에서 부분
   상태 없음.
5. commitApproval의 registry 판정이 P1-1 우선순위(tombstone > same-key
   idempotent > CAS) 그대로: 기존 registry conformance 전 항목을 repository로
   재실행 + commit 경유 케이스 추가.
6. tryDeny: pending→denied; **approving(live lease)→denied + 이후 그 opId
   commit이 claim_lost(deny-vs-commit 펜싱, 양순서 barrier 구동)**;
   approved/expired/denied → false; deny-vs-mint(claim 후 deny, mint 완료 후
   commit) → claim_lost; **시계상 만료된 pending의 deny → expired 전이 +
   false**; **커밋 성립(모호 커밋으로 응답만 유실) → deny false → 같은 opId
   재시도 → approved 멱등 회수** — 3단 시퀀스 그대로(r2 focused-conclusion 1).
7. tryExpire: pending→expired; approving+live lease → transitioned:false;
   approving+만료 lease → expired; **approved → transitioned:false + approved
   레코드 반환(creds 보존)** — D3 회귀 고정; 반환 enrollment가 연산 직후
   상태와 일치(m2).
8. createEnrollment: user_code 충돌 → UserCodeCollisionError, device_code 충돌
   → DeviceCodeCollisionError(이름 매칭 포함), 신규 삽입 전용.
9. sweep 보존 계약(clock 스위트, **create(config)의 retentionMs 기준으로 경계
   시각 계산 — r3 M2**): approved는 `now <= approvedAt+retention`에서 보존·
   `now > approvedAt+retention`에서만 evict(**등호 = 보존** — r4 n1; 만료
   직전 승인 케이스 포함 — 기산점이 approvedAt임을 고정; **경계 등호/직후
   양측의 폴 응답·멱등 회수 대조 — 등호에서 creds 반환·멱등 회수 성공, 직후
   evict 허용**); 살아있는 lease의 approving 보호;
   pending/denied/expired는 expiresAt+retention 동일 연산자; sweep-vs-commit 경합에서
   commit은 committed 또는 claim_lost/expired 중 하나(무음 유실 없음);
   **eviction 후 구 opId commit → claim_lost(멱등 지평선 종료 — 이중 활성화
   아님)**.
10. reconcileApprovedRegistration: (i) approved + 빈 슬롯 → registered;
    (ii) noop 4종 각각 + **우선순위(not_found > not_approved > active_present >
    history_present; tombstone-only 슬롯 = history_present)**;
    (iii) reconcile-vs-register(다른 key, expect=null) 양순서 → 승자 하나 +
    패자 정상 conflict/noop, superseded 부활 없음.

DeviceFlowEnrollment 통합 (decorator barrier로 순서 고정):
11. **D1 재현/차단**: 하나의 MemoryEnrollmentRepository를 공유하는 두
    DeviceFlowEnrollment 인스턴스가 같은 userCode를 동시 approve → 한쪽
    approved, 다른 쪽 in_progress(재시도 시 already_approved로 같은 creds);
    creds 이중 mint-커밋 없음 — poll이 반환하는 creds와 승자 운영자가 보고받은
    creds 일치.
12. **D2 재현/차단**: 두 인스턴스 approve vs deny 경합 — deny가 pending에서
    이기면 commit은 claim 단계에서 죽고(denied), approve가 claim을 잡은 뒤면
    deny가 approving을 종결하고 commit이 claim_lost → 어느 인터리빙에도
    terminal 덮어쓰기 없음.
13. mint 실패 → releaseClaim → pending 복귀, 재approve 정상(P1-1 test 15 승계).
14. **모호 커밋 재시도(B1, 통합 레벨)**: commit throw(`throwAfterCommit({times:1})`)
    → approveInner가 같은 opId 재호출로 committed(idempotent) 회수, 운영자에게
    approved 보고, poll creds 일치; `times:2` → 오류 전파(500 경계), 이후
    재approve가 already_approved로 회수.
15. gate conflict/revoked_key → claim 해제 확인(mint 없음, pending 유지;
    P1-1 test 10/18 승계 + claim 상태 단언 추가).
16. A2 already_approved → reconcile 원자 연산 경유(P1-1 test 17 4분기 승계;
    split read+register 부재를 코드 수준에서 단언 — reconcile 외 register 호출
    없음), claim 미생성.
17. poll: 승인 후 expiresAt 경과 폴 → **creds 반환**(D3 수정 거동); 보존 창
    경과+sweep 후 폴 → invalid_device_code(문서화된 fatal — 재enroll 회복을
    통합 테스트로: 새 enroll이 정상 진행); pending 경과 폴 → expired_token;
    approving 중 폴 → authorization_pending; **expire-vs-commit 경합에서 폴
    응답이 tryExpire 반환 레코드 기준**(m2); **issuer 시계 skew(지연/선행)
    에서 응답이 repository 시계 판정을 따름**(N3 — poll에 issuer 시계 분기
    없음을 코드 수준에서도 단언).
18. deny: approving 중 deny → true(즉시 종결, M1 시나리오); denied 후 늦은
    commit → claim_lost; approved 후 deny → false.
19. P1-1 test 19(poll-expiry 인터리빙)의 조건부-전이 재작성: stale expiry가
    approved를 덮는 케이스가 **불가능**해졌음을 고정(허용-결과 축소).
20. P1-1 test 16(sweep 유실) 재작성: 가짜 approved 보고 경로 부재 — commit이
    claim_lost/expired로 실패하고 rejected 반환(재조회 검증 없이).
21. process-local lock 제거 실험 단언: userCodeLocks를 우회해도(직접
    approveInner 동시 호출) conformance 불변식 유지 — lock이 최적화임을 테스트로
    고정.

HTTP 어댑터 + 소비자:
22. **approve 디스패치 3파일 전수**(공유 핸들러·example app·minimal-consumer):
    in_progress → 409 + 구분 코드(conflict 409와 페이로드 구분); exhaustive
    `never` 체크 존재; truthy-success/fall-through 오인 없음 — **공유 핸들러
    직접 테스트로 in_progress가 approved fall-through로 새지 않음을 고정**
    (r2 N4; P1-1 test 26 확장).
23. barrel/boundary: 삭제된 export 부재 + 신규 export 존재
    (minimal-consumer boundary 테스트 갱신).
24. wire 스냅샷(P1-1 test 31 승계): enroll/poll/bootstrap 응답 shape 불변.
25. **plugin 폴-루프 경계(N1)**: plugin `EnrollmentClient` 실폴러로 — 데드라인
    직전 커밋 + 폴의 서버 도착이 expiresAt 이후인 시나리오에서 enrollment 성공
    (plugin 소스 무변경, 테스트 추가만).

E2E + 게이트:
26. `run-all-real.sh`·`run-enrolled-transport.sh`·`run-derived-trust.sh`·
    `run-two-account-isolation.sh` green(admin-token 주입 절차 그대로) +
    examples 2종 smoke; **격리 worktree 전 워크스페이스 build + 테스트 포함
    typecheck**(삭제 export 잔존 수입 전수 적발).

## 4. 비범위 (명시)

- recordPoll / RFC 8628 `slow_down` 발행과 plugin 폴러 감속 — 백로그
  (유저 결정; plugin lockstep 필요 사실 기록).
- durable(SQL/Redis) adapter 구현 — integrator 소유; skeleton은 P1-4
  (§2.3의 스케치·Redis Cluster 제약 문서가 P1-2 몫의 전부).
- lease 갱신(renewal) 연산 — 상한 초과 = 실패 + 재시도 회복으로 고정(§2.2).
- mint됐으나 전달되지 않은 고아 creds의 암호학적 무효화 — #7/#12
  (deny-of-approving이 만드는 고아 포함).
- reference/demo 전면 보안(세션, CSRF, body limit 등) — P1-4.
- 승인 UI용 `listPending` 조회 API — reference가 자체 추적 중
  (`enrollment-server.ts:462` 주석); multi-replica 승인 UI가 실제로 필요해질 때
  SPI 추가 검토(백로그 기록만).
- plugin 폴러의 sweep-후 자동 재enroll, `expires_in` 연장 폴링 — 데드라인
  계약은 현행 유지, 경계 grace만 서버측 보존으로 제공(§2.3).

## 5. 완료 조건

- Public SPI(`EnrollmentRepository`)만 구현하면 multi-replica-safe issuer 구성이
  가능하다: D1(이중 mint-커밋), D2(terminal 덮어쓰기), D3(approved의 expiry
  덮어쓰기·가짜 approved 보고), D4(approved/registered 분리 커밋)가 계약
  수준에서 불가능하고 conformance suite가 이를 기계 검증한다.
- **모호한 durable commit이 회복 가능하다**: 같은 opId+동일 payload 재시도가
  정확히 같은 결과 — creds/peerId와 **영속된 committedRecord 스냅샷**(이후 슬롯
  변화와 무관, r3 M1) — 를 멱등 회수하고(payload는 digest로 강제 — N2),
  지평선은 `approvedAt + retentionMs`(규범적 설정값, 기본 300s — r3 M2)로
  명시되며, 이중 mint/이중 활성화 경로가 없다(B1).
- **펜싱이 lease 시각을 포함한다**: 만료된 claim의 commit은 재claim 유무와
  무관하게 거부되고, 시계 권위는 repository다(B2) — poll을 포함한 어떤 판정도
  issuer 시계를 쓰지 않는다(N3).
- 운영자는 진행 중 승인(approving)을 deny로 즉시 종결할 수 있고, 종결 뒤
  도착하는 commit은 펜스에 걸리며, 이미 성립한 커밋과 deny는 모순 상태를
  만들지 않는다(M1 + r2 결론 1).
- approved credential과 agent identity 활성화는 commitApproval 하나의 commit
  으로만 함께 나타나며, legacy 복구(reconcile)도 단일 원자 연산이고 noop
  우선순위가 고정돼 있다(M2/n2).
- SPI가 PG/단일-Redis에 구현 가능함이 스케치로 뒷받침되고, 유일성·payload
  binding(digest)·트랜잭션 경계·오류 매핑이 규범으로 명시된다(M3/N2).
- 승인 데드라인 계약은 현행(`expires_in`) 그대로이고, 보존 창은 경계 grace와
  멱등 지평선으로 정확히 문서화되며, plugin 폴-루프 레벨 테스트가 경계
  시나리오를 고정한다(M4/N1).
- 마이그레이션 매트릭스의 전 항목(공유 approve 핸들러의 exhaustive 재작성
  포함)이 처리되고, 격리 worktree 전 워크스페이스 build+typecheck가 green이다
  (M5/N4).
- conformance 하니스가 인스턴스 스코프 clock capability + 하니스 소유 generic
  decorator(barrier/모호 커밋)로 주장된 인터리빙을 결정적으로 구동하고, JS
  단일 객체 검증의 한계와 integrator의 실백엔드 검증 의무가 문서화된다(M6/N5).
- process-local lock은 최적화다 — 우회 동시 호출에서도 불변식 유지(테스트 21).
- crash 회복이 명세된다: claim 후 crash → lease 만료 → 재claim/재mint로 회복,
  구 op의 늦은 commit은 펜싱으로 거부.
- wire·plugin 소스 무변경(스냅샷 테스트 + plugin diff는 테스트 파일 한정) +
  기존 live e2e green.
- 테스트 1–26 green, repository conformance suite export, AUTH.md/README/
  CHANGELOG 갱신.
