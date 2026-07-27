# Issue #72 — 유출된 브라우저 자격증명·conversation key 봉쇄(containment) 기획서

> 상태: v8 — convergence correction 반영. 이 문서는 구현 계획이며 사고가 발생했다는 보고가 아니다.
> 기준 브랜치: `develop` (`0d2196d`)
> 대상 이슈: https://github.com/mir-stream/openclaw-webchannel/issues/72

## 0. 확정된 자세와 범위

이 작업은 이미 유출된 평문이나, 이미 유출된 K와 함께 캡처된 ciphertext를 다시 비밀로 만들 수 없다.
목표는 이후 접근을 차단하고 K를 교체하며, 그 조작이 실제로 적용되었음을 검증하는 것이다.

세 트랙은 다음과 같다.

- **Track C**: 오늘의 수동 봉쇄 런북. self-contained MEMORY resolver의 현재 경로도 포함한다.
- **Track A**: 발급 원장, 인증된 revoke 조작, durable resolver 반영·수용 확인.
- **Track B**: offline K rotation과 client-chosen `clientNonce` 기반 wrap replay 방어. 이번 사이클에는
  연기하지만 설계는 유지한다.

다음 결정은 다시 열지 않는다.

1. Track A의 자동화 topology는 **옵션 2**, 즉 full/Dir resolver와
   `$SYS.REQ.CLAIMS.UPDATE` publish다. publish 응답, durable resolver state, 원격·컨테이너 topology를
   지원하기 위한 결정이다.
2. Track B replay 방어는 브라우저가 매 register 시도마다 선택하는 `clientNonce`다.
3. epoch는 감사 메타데이터일 뿐이며 envelope/AAD에 결박하지 않는다.
   `ENVELOPE_VERSION`은 1로 유지한다. 프로토콜 gate는 register 요청 스키마 변경에 따른
   `WEBCHANNEL_PROTOCOL_VERSION` 2→3이다.
4. 이미 별도 이슈인 #81이나 일반 multi-process 지원은 이 계획에 흡수하지 않는다.
5. runtime은 account당 단일 gateway writer를 전제로 한다. 단, Track A의 **revocation control
   plane**은 복제된 SaaS 요청자 사이에서도 안전해야 하므로 durable 직렬화/CAS를 요구한다.

### 0.1 threat boundary와 acceptance substitution

이 PR의 선택된 방어는 protocol-level old-wrap replay에는 client-chosen `clientNonce`를, rotation 뒤
새 envelope의 key separation에는 fresh random K_new를 사용한다. 이 계약은 **live key store의
integrity**와 §2.5의 forensic backup **MUST NOT restore** 규율 준수를 전제로 한다. audit epoch는
운영 가시성만 제공하며 security-authoritative counter가 아니다.

따라서 이 설계는 privileged operator나 recovery system이 금지된 K_old를 다시 설치하거나 key
document와 generation sidecar를 포함한 전체 local snapshot을 과거로 돌리는 것을 기술적으로 막지
않는다. 그것은 containment 뒤의 **새로운 privileged storage compromise**이며, 발생하면 K_old가
다시 활성화되어 과거 ciphertext가 다시 사용 가능해진다. 이 한계가 backup restore 금지를 완화하는
근거는 아니다.

epoch를 K와 같은 rollbackable file/snapshot에 넣거나 그 값을 wrap/envelope AAD에 추가하는 것만으로는
fresh client가 rollback을 판별할 trusted minimum을 얻지 못한다. 진정한 privileged rollback 저항은
local snapshot 밖의 non-rollbackable trusted minimum/current generation anchor를 요구하며,
후속 [#85](https://github.com/mir-stream/openclaw-webchannel/issues/85)가 이를 추적한다.

그러므로 원래 #72의 “monotonically security-authoritative epoch”와 “epoch-bound wrap/envelope AAD”
요구는 이 PR에서 문자 그대로 충족됐다고 주장하지 않는다. 위의 nonce substitution과 fresh-key
separation을 **명시적으로 선택한 acceptance substitution**으로 기록한다. 현재 audit epoch 의미,
`clientNonce`, `ENVELOPE_VERSION = 1`, protocol v3 결정은 변경하지 않는다.

## 1. 현재 상태와 정정된 사실

### 1.1 revocation primitive

`packages/saas/src/account-revocation.ts`의 `addRevocation(accountJwt, operatorSeed, userPubkey, at)`은
계정 JWT의 `revocations`에 user public key 또는 `"*"` floor를 더해 **현재 claim `iss`와 public
key가 정확히 같은** root 또는 delegated operator seed로 재서명한다.
이 함수는 **candidate JWT만 만든다**. candidate가 resolver에 publish되고 수용되었다고 검증되기
전에는 어떤 credential도 효과적으로 revoke되었다고 말할 수 없다.

재인코딩 계약은 다음과 같다.

- `nats` 본문의 limits, signing keys, imports/exports, 기존 revocations를 보존한다.
- 표준 top-level 유효성 필드 `exp`, `nbf`, `aud`를 보존한다.
- `jti`, `iat`, `iss`는 정상적으로 재생성한다.
- 동일 revocation key의 floor는 `max(existingFloor, requestedAt)`이다. 더 오래된 요청이 기존
  floor를 낮추지 못한다.
- `at`은 양의 정수 unix seconds다. NATS의 판정은 **inclusive**여서 `floor >= credential.iat`이면
  거부된다.

### 1.2 실제 MEMORY resolver 동작

nats-server v2.14.2에서 `resolver: MEMORY` + `resolver_preload` 설정을 새 account JWT로 다시 쓰고
SIGHUP reload하면 account claim이 force-update된다. 그 결과 새 floor에 걸리는 이미 연결된
클라이언트는 끊기고, floor에 걸리지 않는 연결은 유지된다. 구 credential의 재연결도 실패한다.

따라서 Track C의 self-contained 현행 절차는 다음처럼 완결된다.

```text
resolver_preload가 참조하는 설정/claim 재작성
→ nats-server SIGHUP reload
→ 대상 live 연결만 끊겼는지 확인
→ 비대상 live 연결이 유지되는지 확인
→ 구 credential 재연결 실패 확인
```

reload 또는 적용 검증이 실패한 경우에만 relay restart를 fallback으로 사용한다. restart는 live
revocation의 필수조건이 아니며, 옵션 2를 선택한 이유도 live eviction 자체가 아니다.

### 1.3 발급 경로 inventory

브라우저용 public wrapper는 `issueBrowserCredentials`다. production browser mint 경로는 다음과
같다.

- `packages/saas/reference/enrollment-server.ts`
- `demo/saas-server.ts`
- `examples/webchannel-app/server/index.ts`

reference/demo의 admin·chaos 기본 경로도 role이 browser라면 예외 없이 계측 wrapper 또는 명시적으로
계측된 더 낮은 seam을 지나야 한다. test-only 경로만 예외다. agent/observer 직접 mint는 브라우저
원장 밖이며 wildcard dry-run이 이 한계를 반드시 경고한다. 구현 시 repo-wide caller inventory
테스트로 새 production browser 직접 호출을 막는다.

### 1.4 production history authority

`HistoryStore`는 production snapshot authority가 아니다. production register/load-history는
`packages/plugin/src/nats-account-runtime.ts`에서 `history.ts`의 `getSessionMessages`를 호출해
OpenClaw core session transcript를 읽고 현재 K로 snapshot을 다시 봉인한다.

정책은 **RETAIN + RESEAL**이다.

- rotation 뒤 core transcript는 유지한다.
- 다음 history read는 transcript를 K_new로 reseal한다.
- 새 snapshot은 K_new로 열리고 K_old로는 열리지 않아야 한다.
- gateway restart는 core transcript를 purge하지 않으며 history loss를 만들지 않는다.
- 이것은 과거에 노출된 평문/ciphertext의 retroactive secrecy를 제공하지 않는다.

test-only/dead `HistoryStore` 정리는 이 이슈의 범위 밖이다.

## 2. Track C — 지금 실행 가능한 봉쇄 런북

새 `docs/CREDENTIAL_CONTAINMENT_RUNBOOK.md`는 첫 화면에서 배포 유형을 구분하고, 이미 노출된
자료의 비밀성을 되돌릴 수 없음을 먼저 말한다.

### 2.1 revoke 가능 배포

- managed NATS는 provider의 revocation control을 사용한다.
- self-contained는 account JWT를 서명한 operator seed가 필요하다. account seed를 쓰지 않는다.
- MEMORY 현재 경로는 §1.2의 rewrite → reload → targeted disconnect/reconnect verification이다.
- full/Dir resolver가 배포된 뒤에는 Track A publish 경로를 사용한다.

### 2.2 revoke 불가능한 배포의 executable containment

helper, operator seed 또는 resolver 적용 경로가 없어 NATS revoke를 즉시 수행할 수 없다면:

1. plugin account를 `enabled:false`로 비활성화한다.
2. 영향을 받는 모든 gateway controller/replica를 suspend하고 observed zero가 안정적으로
   유지되는지 확인한다.
3. 유출 NATS credential 자체를 helper/resolver 복구 전에 반드시 거부해야 한다면 관련
   relay/account를 isolate·stop하거나 provider/network control로 접근을 차단한다.
4. 그 상태에서 helper/resolver를 복구하거나 trust chain 전체 교체를 계획한다.

`AgentKeyRegistry`의 identity-key revoke는 NATS credential revocation이 아니다. 두 조작을 같은
것처럼 안내하지 않는다.

### 2.3 정확 키와 wildcard

정확한 browser `userPubkey`를 알면 그 키를 revoke한다. 모르면 `"*"`는 account의 agent를 포함한
모든 user credential에 적용된다는 폭발 반경을 검토한다.

NATS는 `floor >= iat`을 거부한다. 따라서:

- exact/per-peer revoke 뒤 새 user public key로 mint한 credential은 기존 key-specific floor의
  대상이 아니다. 그래도 실제 JWT의 `iat`을 원장에 기록한다.
- wildcard 뒤 replacement agent/browser credential은 decode한 실제 JWT `iat`이 고정
  `floorSec`보다 **엄격히 커야** 한다. 같은 초라면 다음 초를 넘길 때까지 wait/retry한다.
- confirmation token을 재사용해 더 새로운 floor를 만들지 않는다. 검토 시 고정한 `floorSec`를
  실행에서도 그대로 사용한다.

### 2.4 agent wildcard recovery

`enrolled` source의 `openclaw channels add`는 exact tuple의 `credentials.json`이 남아 있으면
skip한다. 명령 하나가 remint를 보장한다고 쓰지 않는다.

wildcard 복구 순서는 다음과 같다.

```text
모든 gateway controller/replica의 auto-restart 중지 또는 desired replicas=0
→ observed zero/stable quiescence 확인
→ docs/AUTH.md 절차대로 exact tuple credentials.json을 복구 가능하게 이동
→ active-key replacement/revocation 완료
→ re-enrol 및 승인
→ 새 agent JWT를 decode해 iat > wildcard floorSec 확인
→ relay authentication 확인
→ gateway controller/replica 재시작
```

`static` source는 운영자가 제공한 replacement credential을 설치한다. 어느 경우든 새 agent가 relay에
인증되는 것을 확인하기 전에 gateway를 되살리지 않는다.

### 2.5 K 백업과 교체 안전성

rotation/key-reset 직전 백업은 owner-only 권한으로 live tuple namespace 밖에 두는 **forensic-only**
자료다. 성공한 containment 뒤에는 절대 restore하지 않는다. restore하면 유출된 K가 다시 활성화된다.
`clientNonce`는 현재 로드된 키를 fresh하게 wrap했다는 것만 보장하므로 K rollback을 감지하지 못한다.

rotation 뒤 protocol v3에서 v2로 rollback하는 것도 금지한다. v2는 `clientNonce` replay 보호를
제거하므로 wire 호환성만의 문제가 아니다. 장애가 나면 v3로 roll forward한다.

새 plugin을 배포했다고 이미 연결된 v2 브라우저가 즉시 거부되는 것은 아니다. protocol gate는 다음
register 때 보인다. 그러므로 강제 refresh/bootstrap은 계속 필요하다.

### 2.6 offline rotate의 zero-replica 전제

한 번의 register/pid/lock-file probe는 writer 부재를 구조적으로 보장하지 않는다. 일반
cross-process lock이나 multi-gateway runtime 지원은 이 이슈에서 추가하지 않는다.

운영자/orchestrator는 auto-restart를 suspend하거나 desired replicas를 0으로 만들고, observed
replica count가 0에서 안정적으로 유지되는 것을 확인한 뒤 offline tool을 실행한다. 이
controller-level quiescence를 만들 수 없다면 tool을 실행하지 말고 escalate한다. register/pid/lock
probe는 defense-in-depth 진단일 뿐이다. CLI가 명시적 attestation/confirmation을 요구할 수 있지만
그것도 lock은 아니다.

운영 테스트는 여러 live gateway의 지원을 주장하는 대신 **zero-replica operational
precondition**과 위반 시 fail-closed를 검증한다.

### 2.7 credential-only와 credential+K 봉쇄를 구분한다

**credential-only Track A revoke**는 gateway를 정지하거나 relay를 restart하지 않는다. MEMORY에서는
claim rewrite + SIGHUP reload, full/Dir에서는 publish + readback으로 resolver acceptance와 대상
live disconnect를 확인하면 된다. 비대상 연결은 유지되어야 한다.

이미 K도 노출되어 K rotation까지 필요한 **combined containment**는 다음 순서다.

```text
gateway controller auto-restart 중지/desired replicas=0
→ 모든 replica가 observed zero이고 ready endpoint가 하나도 없는 안정 상태 확인
→ reviewed operation의 fixed floorSec로 credential revoke
→ resolver acceptance + 대상 live disconnect + 구 credential 재연결 실패 확인
→ exact (tenant, accountId, peerId)의 K를 offline rotate
→ wildcard라면 §2.4에 따라 agent credential 교체·iat 검증·relay 인증
→ gateway 재시작
→ 영향받은 모든 브라우저를 fresh app bootstrap → 새 credential → 새 register로 강제
```

stop-first가 load-bearing인 이유는 floor가 시간 하한이기 때문이다. gateway가 살아 있으면 revoke 직후
새 public key로 발급된 credential이 아직 rotate되지 않은 K_old를 register로 받을 수 있다. 그 뒤
rotate해도 건강한 relay socket은 자동 register를 일으키지 않아 유효 credential과 K_old를 함께 가진
세션이 남는다. observed zero는 그 **post-floor credential → K_old** 창을 닫는다.

마지막 bootstrap도 선택 사항이 아니다. gateway restart나 relay disconnect만으로 모든 브라우저가
register를 다시 수행하지 않는다. 앱은 새 credential과 새 client instance로 시작해 K_new를 받아야
한다. exact peer만 rotate했다면 그 peer의 모든 device, account-wide emergency reset이었다면 그
account의 모든 browser가 대상이다.

## 3. Track A — 발급 원장

### 3.1 비밀 없는 레코드

```ts
export type BrowserCredentialRecord = {
  readonly tenant: string;
  /** 감사 라벨. NATS account identity로 사용하지 않는다. */
  readonly accountContext: string;
  /** 실제 revocation operation을 묶는 NATS account public key. */
  readonly natsAccountPublicKey: string;
  readonly peerId: string;
  readonly userPubkey: string;
  readonly issuedAtSec: number;
  readonly expiresAtSec: number | null;
  readonly status: "active" | "revoked";
  readonly revokedAtSec: number | null;
};
```

JWT, seed, K, private key는 record, log, dry-run, error에 넣지 않는다.
`pending`, `reviewed`, `executing`, publish 결과와 reconciliation 상태는 credential의 상태가 아니라
§4의 `RevocationOperation` 상태다.

### 3.2 issuance ordering

발급은 다음 순서로만 한다.

```text
메모리에서 비공개로 mint
→ 실제 user JWT decode
→ decode한 sub/iat/exp로 정확한 비밀 없는 record persist
→ persist가 성공한 경우에만 JWT와 seed를 호출자에게 반환
```

record가 실패하면 JWT와 seed를 폐기·withhold하고 요청을 실패시킨다. 이 시점까지 어떤 credential도
응답, callback, log 또는 외부 저장소로 나가면 안 된다. 존재하지 않는 JWT를 미리 기록하는
record-before-mint 방식도 쓰지 않는다.

`issuedAtSec`/`expiresAtSec`은 원장 clock으로 계산하지 않는다. 반드시 실제 JWT의 `iat`/`exp`를
decode해 쓴다. repository clock은 audit/operation timing에만 사용하며 이름은 항상 `nowSec()`이다.

모든 계측된 browser issuance는 §4의 operation과 **같은 durable repository**를 사용한다. record
persist transaction은 `(natsAccountPublicKey, peerId)` fence와 account-wide fence를 원자적으로
검사한 뒤 active record를 쓴다. active fence가 있으면 mint 전에 대기/거부하는 것이 권고지만,
이미 메모리에서 mint했더라도 persist/return하지 않고 JWT·seed를 폐기·withhold한다. fence 검사와
issuance record persist 사이에 다른 replica가 끼어들 수 없어야 한다.

이 transaction이 선형화 지점이다. issuance persist가 broader fence 획득보다 먼저 commit되면
§5의 transaction 안 final reviewed-set query/digest에 반드시 보인다. fence 획득이 먼저 commit되면
그 scope의 새 browser credential은 fence가 풀릴 때까지 외부로 escape하지 않는다.

### 3.3 SPI와 audit-only 가용성

SPI는 durable adapter conformance suite를 제공한다. 발급 record는 credential escape 전
fail-closed지만, Track B의 generation audit sidecar는 authorization source가 아니다.

repository SPI는 최소한 (a) no-active-fence 검사 + issuance persist, (b) final reviewed-set
query/digest + confirmation consume + operation transition + issuance fence 획득, (c) fenced
operation reconciliation/release를 각각 durable transaction으로 제공한다. process-local mutex나
서로 다른 ledger/operation backend를 조합해 이 계약을 대신하지 않는다.

generation sidecar는 configured key capacity보다 커질 수 없다.

- 새 peer register 시 fresh key document에 없는 stale sidecar entry를 best-effort compact한 뒤에도
  가득 차 있으면 audit-only fail-open: 항목을 생략하고 seed/K를 포함하지 않는 안전한 로그를 남긴다.
- 이미 기록된 peer의 rotate는 새 항목을 만들지 않으므로 허용한다.
- `generations`를 먼저 쓰고 key write가 실패하면 key file/material/cache는 이전 상태로 남지만
  audit sidecar는 앞선 generation으로 전진할 수 있다. 이 비대칭을 계약과 T6에 그대로 둔다.

audit 손실을 인증 장애로 바꾸지 않는다.

### 3.4 rollout/preflight 계약

`revocationCapable` preflight/reporting은 적어도 배포 유형, 실제 NATS account public key, operator
signing capability, resolver publish/reload 경로, readback/verification readiness, 전용
`ClaimPublisher`와 out-of-band `PublisherRecoveryAuthority`의 all-node offline recovery 실행
가능성, delegated signer lifecycle과 durable node-quarantine/rejoin 실행 가능성을 검사한다.

- self-contained 기존 chain은 `returnOperatorSeed: true`로 **처음 생성될 때만** operator seed를
  보관한다. 이미 저장된 chain에 옵션을 뒤늦게 켜도 seed가 생기지 않는다. Track A 활성화 전에
  inventory하고, 없으면 controlled trust-chain replacement 또는 managed path를 준비한다.
- managed deployment에는 단순 `"unsupported"`가 아니라 provider 이름/설정과 함께 사용할
  revocation control 또는 escalation 경로를 반환한다. 자동화할 API가 없으면 fail-closed하면서
  executable provider 절차를 안내한다.
- preflight 실패 중에는 admin revoke route를 성공처럼 노출하지 않는다.
- authoritative serving-node membership, API/publisher/all-NATS-node stable observed zero,
  unreachable-node quarantine, offline resolver seed와 per-instance publisher credential
  revoke/rotate를 증명할 수 없는 topology는 repository가 CAS를 제공해도 Track A를 fail-closed한다.
- ordinary rejoin에서도 해당 node process와 cluster route/network의 stop/isolation, stable observed
  zero, non-serving restart와 delayed-update purge를 증명할 수 있어야 한다.

## 4. Track A — revoke operation과 동시성

### 4.1 실제 account에 결박

모든 operation, confirmation, CAS, resolver readback은 account JWT의 `sub`, 즉 실제 NATS account
public key에 결박한다. `accountContext`는 감사 라벨일 뿐 locking/fencing/security boundary가 아니다.

### 4.2 durable operation/claim repository

복제된 SaaS 요청자가 같은 account claim을 동시에 갱신할 수 있으므로 durable repository에
operation record와 accepted-claim version/hash/JTI를 둔다. 구현은 CAS/version/hash/JTI 중 하나의
명시적 fencing token을 사용한다.

규칙:

1. replicated SaaS/API worker는 durable operation을 enqueue/observe할 뿐 JWT를 sign/publish하지 않는다.
2. 전용 `ClaimPublisher`가 account별로 operation을 직렬화하고 resolver의 **accepted JWT**를 즉시
   readback한다.
3. accepted JWT와 아래 정의의 **eligible operation revocation union**을 병합해 candidate를 새로
   만든다. 저장해 둔 old candidate를 재사용하지 않으며 ledger status도 아직 바꾸지 않는다.
4. candidate JWT를 resolver에 **한 번** publish한다.
5. publish 응답과 resolver readback/hash/JTI로 acceptance를 확인한다.
6. acceptance가 확인된 reviewed set만 ledger에서 revoked로 mark한다.

process-local mutex만으로 안전하다고 주장하지 않는다. `addRevocation` 자체는 3번의 pure candidate
builder일 뿐이다.

operation은 credential record와 별도 durable 레코드다.

```ts
export type RevocationOperation = {
  readonly operationId: string;
  readonly version: number; // repository CAS version
  /** broader-set confirmation token; exact revoke-one은 null */
  readonly tokenId: string | null;
  readonly action: "revoke-one" | "revoke-peer" | "revoke-all";
  readonly natsAccountPublicKey: string;
  readonly tenant: string | null;
  readonly peerId: string | null;
  readonly wildcard: boolean;
  readonly reviewedUserPubkeys: readonly string[]; // sorted exact set
  readonly reviewedSetDigest: string;
  readonly fixedFloorSec: number;
  readonly expiresAtSec: number;
  readonly baseAcceptedClaimId: string; // version/hash/JTI
  readonly candidateClaimId: string | null;
  /** publish-failed를 eligible union에 다시 넣는 durable 승인; 아니면 null */
  readonly retryAuthorizedAtSec: number | null;
  /** wildcard만: dry-run 전에 획득한 external issuer freeze 결박 */
  readonly externalIssuerFreeze:
    | {
        freezeId: string;
        generation: number;
        issuerSetDigest: string;
        attestationDigest: string;
        attestedHighWatermarkSec: number;
      }
    | null;
  /** revoke-one은 null; broader set은 durable issuance fence identity */
  readonly issuanceFence:
    | { scope: "peer"; peerId: string; fencingToken: string }
    | { scope: "account"; fencingToken: string }
    | null;
  readonly status:
    | "reviewed"
    | "executing"
    | "publish-failed"
    | "acceptance-unknown"
    | "reconciliation-required"
    | "aborted"
    | "complete";
};
```

repository의 최소 transaction 계약은 `(account public key, acceptedClaimId, operation.version)`을
한 CAS 경계에서 fence하고, broader-set final digest 검증·confirmation consume·
`reviewed → executing`·issuance fence 획득을 원자화하며, resolver 결과와 ledger mark progress를
idempotent하게 기록하는 것이다. per-peer는 `(natsAccountPublicKey, peerId)` fence, wildcard는
`natsAccountPublicKey` 전체 fence를 잡는다. exact `revoke-one`은 새 issuance가 그 exact
`userPubkey`를 재사용하지 않으므로 broader issuance fence가 필요 없고 `issuanceFence:null`이다.
operation에는 JWT/seed를 저장하지 않고 candidate/accepted claim의 비밀 아닌 hash/JTI만 저장한다.

**eligible operation revocation union**은 current authorized/executing operation과 durable
authorization boundary를 이미 지난 non-aborted operation만 포함한다. 구체적으로 `executing`,
명시적으로 retry 승인된 `publish-failed`, `acceptance-unknown`, `reconciliation-required`, 그리고
accepted claim healing에 필요한 `complete`가 대상이다. `reviewed`/unconfirmed, `aborted`, retry
승인 없는 `publish-failed`는 절대 candidate에 넣지 않는다. retry 승인은 durable operation
transition으로 기록한다.

operator는 raw `at`을 입력하지 않는다. 서버는 operation을 만들 때 unix seconds
`fixedFloorSec`를 **한 번만** 유도하고 positive safe integer·허용 clock bound를 검증한다. 일반
경로는 reviewed target들의 ledger에 저장된 실제 decoded JWT `iat`와 accepted claim의 기존 floor
이상으로 정한다.

wildcard는 순서가 더 엄격하다. browser durable issuance fence와 혼동하지 않는 **external
agent/observer issuer freeze** 및 모든 issuer replica attestation을 dry-run/operation 생성과
`fixedFloorSec` 산정 **전에** 획득한다. attestation은 freeze ID/generation, 획득 시각,
issuer set/generation(또는 안정 식별자), 각 issuer가 decode한 `lastIssuedAtSec` high-watermark,
clock-health evidence를 담는다. freeze 뒤 accepted floor, known ledger/agent JWT `iat`, attested
issuer high-watermark, bounded authoritative control-plane time의 최대값으로 floor를 한 번 정한다.
attestation record는 durable·immutable이며 교체할 수 없다. operation과 confirmation은 freeze
ID/generation뿐 아니라 immutable attestation digest와 attested high-watermark를 결박한다.
retry/reconciliation은 floor를 새 `nowSec()`로 올리지 않는다. 따라서 replacement는 같은 초를
피하고 decoded 새 JWT가 `iat > fixedFloorSec`일 때까지 §2.3처럼 wait/retry한다.

### 4.3 NATS side-effect single writer

nats-server v2.14.2 Dir의 `$SYS.REQ...CLAIMS.UPDATE`는 repository fencing token/CAS나 claim `iat`
monotonic guard를 enforce하지 않는다. 유효하게 서명된 stale full account JWT도 받아 resolver
state를 과거 revocation 집합으로 되돌릴 수 있다. repository token은 DB transition만 fence하며,
signer/publisher credential을 나중에 revoke해도 이미 socket/internal queue에 들어간 update를
취소하지 못한다. 기본 Dir handler에는 store 전 trust-aware CAS guard가 없고 queued stale JWT가
durable save될 수 있으므로 signer revocation만으로 downstream side effect를 fence했다고 주장하지
않는다.

정상 `ClaimPublisher`는 delegated online signing capability와 direct
`$SYS.REQ.ACCOUNT.<account>.CLAIMS.UPDATE` permission만 가진다. root operator/recovery signing
material은 아래 `PublisherRecoveryAuthority`에만 둔다. replicated SaaS/API worker에는 signing
secret과 direct publish permission을 주지 않는다. publisher credential은 instance/account별로
좁게 발급한다. `addRevocation`에는 현재 accepted account claim의 `iss`와 정확히 같은 delegated
seed만 넘긴다.

정상 상태에서는 account별 ClaimPublisher 하나가 직렬화한다. publish 뒤 response가 유실되거나
어느 serving node라도 exact claim ID/floor readback이 끝나지 않으면 같은 publisher도 다음 publish를
하지 않고 all-node reconciliation을 끝낸다. authoritative membership의 모든 serving node가 exact
readback과 대상 eviction을 보고해야 complete다. missing/mixed는
`acceptance-unknown`/`reconciliation-required`다. unreachable node는 durable quarantine record로
authoritative serving membership에서 제외되기 전에는 complete가 아니다. 다음 publish snapshot은
quarantine node를 제외하며, rejoin/membership 변화가 생기면 membership verification을 다시 한다.
quorum 판정은 금지한다.

publisher crash/partition/acceptance-unknown에서는 lease takeover와 live 새 publisher 시작을
금지한다. browser/external issuance fence와 operation 상태를 유지하고 admin revoke route를
fail-closed한다.

별도 out-of-band `PublisherRecoveryAuthority`가 offline 복구만 수행한다. online ClaimPublisher/API
worker와 분리하고 root operator/recovery signing-key custody, system-account publisher-user revoke/rotate,
resolver durable state offline repair, orchestrator/provider stop·quarantine 권한을 가진다. 이
authority와 recovery material은 정상 ClaimPublisher/API에 노출하지 않으며 preflight에서 실제
실행 가능성을 검증한다.

초기 Track A rollout은 root-only trust/account를 같은 offline barrier에서 D1 lifecycle로
bootstrap한다. authority가 fresh per-instance delegated operator signing key D1을 만들고 root-signed
operator JWT/trust config의 `signing_keys`에 D1을 추가한 뒤, current account body/floors를 보존해
D1으로 re-sign한다. 이후 recovery는 Dn을 제거하고 Dn+1을 추가하는 같은 절차를 반복한다.

기본 Dir 복구 순서는 다음과 같다.

1. authoritative serving-node membership snapshot을 고정하고 external issuer/browser issuance
   freeze를 유지하며 API와 ClaimPublisher를 stop한다.
2. old publisher process/network의 stable observed zero를 증명한다.
3. **모든 affected NATS resolver/server serving node를 stop하고 stable observed zero를 증명한다.**
   unreachable node는 service/discovery에서 quarantine하고 stale storage로 재합류하지 못하게 한다.
4. offline authority가 fresh Dn+1 delegated operator key를 만든다. root-signed operator JWT/trust
   config에 Dn+1 public key를 `signing_keys`로 추가하고 Dn은 제거한다(초기 rollout은 root-only
   trust에 D1 추가). accepted target account body/floors와 eligible union을 보존해 **Dn+1으로
   re-sign**하며 seeded target claim의 `iss`가 Dn+1 public key와 정확히 같아야 한다. old publisher
   system-user를 revoke/rotate하고 new exact-account publisher user도 provision한다. old candidate는
   재사용하지 않는다.
5. 모든 NATS node가 stop된 비서빙 상태에서 operator/target/system claim·config를 각 durable store에
   **per-store atomic replace**하고 store마다 동일한 exact hash를 검증한다. 분산 global atomic
   commit을 요구하지 않으며, 중간 partial seed가 절대 serving되지 않는 것이 안전 보장이다.
6. NATS node를 시작하되 readiness/service discovery에서 quarantine된 non-serving 상태로 유지한다.
   membership이 바뀌면 snapshot/verification을 처음부터 다시 한다. 모든 node가 exact
   operator/target/system claim ID·hash·floors와 operator trust hash의 Dn+1 포함/Dn 제외를 보고해야
   한다. 별도 non-mutating trust-validation fixture에서 Dn-signed claim이 invalid임을 확인하되 unsafe
   Dir endpoint를 signer oracle로 쓰지 않는다. old publisher system-user의 **각-node**
   reconnect/publish permission failure를 message ingress 전에 확인하고, 그 credential의 Dn update
   attempt 뒤 target store hash가 불변이어야 한다. revoked client reconnect failure와 stable
   membership도 확인하며 quorum으로 축약하지 않는다.
7. 검증 성공 뒤에만 serving을 일괄 enable한다. 그 다음에만 Dn+1 delegated seed와 new publisher
   user credential을 새 ClaimPublisher에 전달·시작하고 Dn+1 credential+signer의 정상 update 성공,
   fence/recovery state 수렴을 확인한 뒤 admin route를 재개한다. root/recovery material은 online
   process에 전달하지 않는다.

all-node stop/start는 pre-accepted route/socket/internal-queue message를 소거하는 downstream
barrier다. 이 barrier 없이 credential revocation만 하고 live takeover하지 않는다.

향후 CAS-aware custom downstream이 대체하려면 publisher token/epoch을 **store 전에** 원자 검증하고
delayed stale update를 reject하는 real-server proof가 있어야 한다. 기본 Dir endpoint는 해당하지
않는다.

ordinary quarantine node가 돌아올 때도 node-local offline barrier를 거친다.

1. durable quarantine/non-serving 상태에서 해당 NATS process와 cluster route/network를 stop/isolate하고
   stable observed zero를 증명한다.
2. process가 stopped인 동안 latest exact operator/target/system claim·config를 그 durable store에
   per-store atomic replace하고 hash를 검증한다.
3. restart하되 client ingress, cluster routes, readiness/service discovery를 모두 격리해 non-serving을
   유지한다.
4. non-mutating signer trust, exact hash/floors, old publisher/revoked-client credential의
   reconnect·publish ingress 전 거부, attempt 뒤 store hash 불변, pre-accepted delayed stale update
   소거를 node-local로 검증한다.
5. membership이 안정된 뒤에만 routes/client serving을 enable하고 authoritative membership에
   re-add한다. partial replace/검증, zero 불명, membership drift는 계속 quarantine/fail-closed한다.

### 4.4 모호한 실패와 reconciliation

- consume 전에는 `reviewed`, publish 전 실행 중에는 `executing`, 명시적 publish 거부는
  `publish-failed`이고 ledger는 revoked가 아니다.
- publish response를 잃었거나 readback이 불확실: `acceptance-unknown`. 재시도는 accepted claim을
  다시 읽어 candidate hash/JTI 또는 floor 포함 여부를 확인한다.
- resolver acceptance 뒤 ledger mark가 실패: `reconciliation-required`. credential은 실제로
  revoke되었지만 ledger row는 아직 `active`일 수 있다. 조회/API는 account+userPubkey에 걸린
  operation overlay와 `reconciliation-required`를 함께 반환해 이를 **effective active**라고
  보고하지 않는다.
- reconciler는 account public key별 claim fence와 operation의 issuance fencing token을 소유권
  확인한 뒤 resolver accepted JWT를 source of truth로 ledger를 수렴시킨다.

broader issuance fence는 resolver acceptance와 대상 ledger convergence가 모두 끝난 `complete`
뒤에만 release한다. `acceptance-unknown`과 `reconciliation-required` 동안은 유지한다. 명시적
publish rejection처럼 resolver 미적용이 readback으로 확정된 safe abort에서만 release할 수 있다.
process crash나 lease expiry만으로 무조건 풀지 않는다. recovery worker가 더 높은 repository fencing
token으로 operation ownership을 인수하고 readback/reconciliation 또는 safe abort를 완료한 뒤
release한다. 이는 DB operation ownership 인수일 뿐 publisher takeover 권한이 아니다. publisher
crash/partition이 얽히면 §4.3의 all-node offline recovery barrier가 완료되기 전에는 인수한 worker도
publish하거나 fence를 release할 수 없다. repository token은 stale worker의 DB ledger mark/release를
막지만 NATS publish 자체는 막지 못한다.

lost response를 이유로 더 새로운 floor를 만들거나, stale account JWT에서 다시 시작해 동시
revocation을 덮어쓰면 안 된다. `addRevocation`의 per-key monotonic floor는 방어층이지만 durable
accepted-claim serialization을 대체하지 않는다.

### 4.5 batch semantics

per-peer reviewed set은 candidate 하나에 모두 병합하고 publish 한 번으로 적용한다. 개별 key마다
publish하거나 publish 전에 ledger를 revoked로 표시하지 않는다. cluster 일부가 새 claim을 아직
보지 못하면 operation을 complete로 만들지 않고 reconciliation-required로 유지한다.
authoritative membership의 모든 serving node가 exact claim ID/floor와 대상 eviction을 확인해야 한다.

## 5. 확인(confirmation) flow

무상태 HMAC 방식을 사용하지 않는다. **per-peer와 wildcard broader set**은 dry-run 뒤 durable
operation repository의 one-time token ID와 atomic consume을 반드시 거친다. exact single-user
revoke는 admin auth 뒤 confirmation token 없이 실행할 수 있지만, 동일하게 durable operation을
만들고 account claim CAS/fence를 얻는다. exact 경로는 `tokenId:null`로 생성하면서 repository의
원자 transaction 안에서 곧바로 `executing` 상태가 되며, publish/readback/reconciliation 계약은
broader set과 같다.

confirmation record에는 다음 값을 모두 결박한다.

- action (`revoke-peer` 또는 `revoke-all`)
- 실제 NATS account public key
- tenant/peer filter
- wildcard flag
- exact reviewed-set canonical digest
- 검토 때 고정한 `floorSec`
- wildcard external issuer freeze ID/generation, issuer-set digest, immutable attestation digest,
  attested high-watermark
- expiry
- 고유 token ID

broader-set 실행은 같은 durable transaction에서 (1) 현재 대상 집합을 다시 query해 digest 검증,
(2) confirmation consume, (3) `reviewed → executing`, (4) per-peer/account-wide issuance fence
획득을 수행한다. 하나라도 실패하면 전부 commit하지 않는다. 동시 consume 중 하나만 실행권을 얻고,
나머지는 다시 publish하지 않으며 같은 operation status를 반환할 수 있다. token replay는 절대 새
`nowSec()`로 floor를 재계산하지 않는다. empty/sparse ledger도 digest에 명시적으로 표현해 다른
account/route의 token이 통과하지 못하게 한다.

wildcard dry-run은 ledger가 아는 active/비만료 browser credential을 tenant·peer별로 집계하고 다음
unknown을 별도 경고한다.

- 원장 도입 전에 발급된 browser credential 수와 식별자는 알 수 없음
- agent/observer 직접 mint는 browser ledger 밖이므로 수를 알 수 없음
- wildcard는 위 unknown을 포함해 같은 NATS account의 모든 user key에 적용됨

warning만으로 wildcard를 `complete`로 만들 수는 없다. browser repository fence 밖의 agent/observer
issuer는 §4.2의 선행 external freeze/attestation으로 발급을 차단한다. freeze는
review/confirmation/resolver acceptance/ledger convergence까지 유지한다. 실행 시 freeze
ID/generation, issuer membership와 clock evidence를 다시 검증한다. lapse, membership drift 또는
invalid attestation이면 operation/confirmation을 실행하지 않고, resolver에 publish되지 않았음을
durable state와 readback으로 확인한 safe abort 뒤 `aborted`로 끝내고 freeze를 release한다. 새
freeze·새 dry-run·새 floor·새 confirmation부터 다시 시작한다. review expiry/abandon도 같은 safe
abort 확인 전에는 freeze를 풀지 않는다. 모든 issuer replica의 동결을 통제·확인할 수 없으면
wildcard 실행/완료를 fail-closed한다. 복구용 replacement는 operation `complete`와 안전한
browser fence/external freeze release 뒤에만 §2.3의 `iat > fixedFloorSec` 절차로 발급한다.

per-peer dry-run도 비만료 credential과 동일 peer의 복수 credential을 빠뜨리지 않는다. 모든
dry-run/log/error/operation status는 JWT, seed, K, private key를 포함하지 않는다.

## 6. resolver topology

### 6.1 Track C: MEMORY

§1.2의 rewrite + SIGHUP reload + targeted verification이 self-contained 현재 경로다. restart는
reload/application verification 실패 시 fallback이다.

### 6.2 Track A: 선택된 옵션 2

full/Dir resolver와 `$SYS.REQ.CLAIMS.UPDATE`를 사용한다. 선택 근거는:

- protocol publish response를 받을 수 있음
- resolver state가 durable함
- SaaS와 relay가 다른 process/container/host에 있는 topology를 지원함
- acceptance/readback과 reconciliation을 자동화할 control plane을 제공함

MEMORY도 reload 시 targeted live eviction을 수행하므로, 옵션 2가 **live eviction에 필요해서**
선택된 것은 아니다.

기본 Dir claim-update endpoint는 stale full JWT를 자체 CAS로 거부하지 않는다. 따라서 모든
production publish는 §4.3의 전용 `ClaimPublisher`를 지나며, system account permission과 operator
signing material 배포도 online delegated signer와 offline recovery authority로 분리한다. live
takeover는 금지하며 recovery는 cluster-wide offline barrier를 따른다.

마이그레이션/검증 inventory는 다음 여섯 곳이다.

- `demo/run.sh`
- `e2e/local/run-all-real.sh`
- `e2e/local/run-enrolled-transport.sh`
- `e2e/local/run-derived-trust.sh`
- `e2e/local/run-two-account-isolation.sh`
- `examples/webchannel-app/server/nats.ts`

각 profile에서 system account, resolver directory ownership/persistence, publish permission,
authoritative all-node readback/health check와 offline stop/quarantine/per-store atomic-replace
capability, root→D1/Dn→Dn+1 trust transition과 quarantined-node heal-before-serve를 검증한다.

## 7. HTTP routing inventory

제안 route는 shared handler만 구현해서는 안 된다.

```text
GET  /admin/credentials
POST /admin/credentials/revoke
POST /admin/credentials/revoke-peer
POST /admin/credentials/revoke-all
```

`packages/saas/reference/enrollment-server.ts`와 `demo/saas-server.ts`의 **top-level router 둘 다**
shared handler로 위임해야 한다. 각 profile의 기존 admin auth, 401/403/404/503 status 의미와
body-before-auth 금지를 보존한다.

테스트는 shared handler unit test 외에 두 top-level server handler를 실제 경로로 호출해:

- 무인증/미설정 admin secret status
- 올바른 bearer의 delegation
- 잘못된 method/path의 기존 404
- response/log secret 부재

를 각각 고정한다.

## 8. Track B — K rotation과 replay 방어

### 8.1 per-peer store와 sidecar

선택된 rotation scope는 `(tenant, accountId, peerId)`다. tuple storage directory가 tenant/account를
결정하고, key document의 `peerId` entry 하나가 선택 대상이다. bare-account K storage의 경로·이전
정책은 #71과 조율해 같은 tuple을 두 권위 저장소가 소유하지 않게 한다.

기존 key document v2와 `get(peerId)`/`getOrCreate(peerId)` signature는 유지한다. 별도 owner-only
sidecar `conversation-key-generations.json`은 다음 v1 형태다.

```ts
type ConversationKeyGenerationsV1 = {
  version: 1;
  storageIdentity: StorageIdentityV2; // key document와 동일하게 생성·검증
  generations: Record<
    string,
    { epoch: number; rotatedAtSec: number }
  >;
};
```

`epoch`는 양의 safe integer다. sidecar가 살아 있는 동안 발급/rotation 감사 순서를 나타낼 뿐
authorization, AAD, rollback detection에 쓰지 않는다. sidecar 유실·quarantine은 label을 1로
되돌릴 수 있으며 보안 성질을 깨지 않는다. `rotatedAtSec`은 repository/tool audit clock의
`nowSec()` 값이다.

sidecar missing/corrupt/read-error는 audit-only empty state로 취급하고 secret 없는 safe error log를
남긴다. register/getOrCreate는 계속 진행할 수 있고 label이 reset될 수 있다. 다만 offline rotate는
target의 durable generation entry 없이는 성공할 수 없으므로 아래 write/rename을 fail-closed로
완료해야 한다.

API는 다음 두 개만 더한다.

```ts
rotate(peerId: string): { key: Uint8Array; epoch: number; rotatedAtSec: number };
generationOf(peerId: string): { epoch: number; rotatedAtSec: number } | null;
```

현재 `ConversationKeyStore`의 `get`/`getOrCreate`/persist 경로와 같이 synchronous API를 유지한다.
`generationOf`는 진단용이며 quiescence 증명이 아니다. 기존 key의 `get`/`getOrCreate` read는
generation을 절대 올리지 않는다. 새 peer의 최초 `getOrCreate`는 sidecar capacity가 남았을 때만
audit entry를 만든다. full 판정 전에 fresh key document에 없는 peerId의 stale sidecar entry를
best-effort compact한다. 그래도 가득 찼다면 §3.3의 audit-only fail-open을 따른다.

### 8.2 `rotate(peerId)` commit protocol

`rotate`는 다음을 순서대로 수행한다.

1. key file과 sidecar를 디스크에서 다시 읽고 storage identity/형식/capacity를 검증한다. 캐시만
   신뢰하지 않는다.
2. key file에 `peerId`가 없으면 거부한다. rotation은 create API가 아니다.
3. 기존 recorded peer의 rotate는 capacity-neutral이다. target generation entry가 없다면 fresh key
   document에 없는 stale sidecar entry를 best-effort compact한 뒤 target entry를 추가한다. slot이
   없거나 sidecar를 쓸 수 없으면 **key를 바꾸기 전에 fail-closed**한다. offline rotate 성공은
   target의 durable generation entry를 항상 보장하며 register의 audit-only omission 정책을
   적용하지 않는다.
4. fresh CSPRNG 32-byte K_new와 다음 positive safe-integer epoch의 **candidate documents**를
   메모리에서 만든다. 아직 cache/material을 publish하지 않는다.
5. generation sidecar를 atomic temp-write + rename한다.
6. key document를 atomic temp-write + rename한다.
7. key rename이 성공한 뒤에만 in-process cache를 K_new로 publish하고 결과를 반환한다.

실패·crash 계약은 명시적이다.

- candidate 전 read/validation/random 실패: 디스크와 cache 모두 불변.
- generation temp/rename 실패: key file/material/cache 불변, rotate 실패. 새 peer register의
  **sidecar capacity-full** fail-open을 rotate write failure에 복사하지 않는다.
- generation rename 성공 뒤 key temp/rename 실패 또는 그 사이 crash: sidecar epoch가 앞설 수
  있지만 key file/material/cache는 K_old다. 다음 rotate는 디스크의 최대 label에서 다시 전진한다.
- key rename 성공 뒤 cache publish 전 crash: disk에는 K_new가 있고 죽은 process의 cache는 외부로
  다시 서비스되지 않는다. 재시작 process가 K_new를 읽는다.
- key rename 성공 뒤 cache publish 성공: disk/cache 모두 K_new. K_old를 다시 publish하지 않는다.

키 파일을 먼저 쓰고 generation 실패로 K_new를 audit할 수 없게 만드는 역순은 금지한다. 반대로
sidecar advance만 남는 것은 허용된 감사 비대칭이며 authorization outage가 아니다.

선택 scope는 per-peer다. account-wide destructive file reset은 Track B 이전 emergency 런북에만
남는다. 미래의 account-wide rotate API는 전체 candidate, blast-radius dry-run, 한 번의 atomic
commit/rollback 계약을 별도로 설계해야 하며 `rotate(peerId)` partial loop로 몰래 구현하지 않는다.

### 8.3 `clientNonce` protocol

production register 요청에는 브라우저가 `crypto.getRandomValues`로 만든 32 random bytes의
base64url `clientNonce`가 필수다. PoP가 disabled여도 필수이며, agent는 padding 없는 base64url을
decode해 정확히 32 bytes인지 protocol-version gate 뒤, **PoP verification과 wrap 둘 다 전에**
검증한다.

canonical wrap AAD는 plugin/client가 byte-identical하게 구현한다.

```text
UTF-8("webchannel-wrap-v2" || 0x1F || peerId || 0x1F || clientNonce)
```

prefix는 versioned domain separator다. `peerId` 검증과 base64url alphabet은 `0x1F`를 허용하지
않으므로 encoding은 모호하지 않다. 두 구현은 서로를 import할 수 없는 build boundary를 고려해
mirror하되 shared vector가 byte identity를 고정한다.

- client는 **매 register attempt**마다 nonce를 만들고 request와 로컬 attempt state에 둔다.
- `RegisterWithPopResult`는 성공한 attempt의 **로컬 생성 nonce**를 unwrap 호출자까지 전달한다.
  register reply가 nonce를 echo한다고 신뢰하지 않으며 reply payload에 echo하지 않는다.
- agent는 매 성공 register 요청마다 nonce를 사용해 무조건 re-wrap한다. 이미 등록된 peer라는 이유로
  이전 wrap을 재사용하지 않는다.
- production wrap API는 nonce 없이 호출할 수 없게 타입/런타임 양쪽에서 막는다.
- `clientNonce`를 `popSignedMessage(peerId, serverNonce, clientNonce)`에도 결박한다. protocol v3
  public API와 plugin/client mirror를 동시에 바꾼다. 이것은 relay 변조에 대한 defense-in-depth이고,
  핵심 old-wrap replay 안전성은 여전히 **client가 선택한 값을 wrap AAD에 쓰는 것**에서 나온다.

fresh device key는 기본 wrapper/harness가 제공할 수 있는 추가 성질일 뿐 core client 계약이나 replay
방어 근거가 아니다. replay 방어의 근거는 client-chosen nonce다.

relay disconnect만으로 register가 다시 실행된다고 쓰지 않는다. revoke는 client를 terminal 상태로
만들 수 있고, gateway restart는 relay websocket을 끊지 않는다. 실제 회복은 앱의 fresh
bootstrap/forced refresh, 새 credential 발급, 새 client instance다.

필수 구현/call-site inventory:

- agent: `packages/plugin/src/nats-register.ts`, `late-join-decryptor.ts`, `nats-channel.ts`,
  `nats-account-runtime.ts`의 register handler injection
- client: `packages/client/src/pop-register.ts`, client e2e crypto mirror,
  `packages/client/src/nats-client.ts` unwrap 호출
- integration: `e2e/local/run-all-real.sh` protocol-v3 request와 all-real bootstrap
- tests/fixtures: plugin/client `popSignedMessage` mirror, wrap AAD vectors, register request/reply
  fixtures와 test helper 전부

### 8.4 암호학적 사후조건

rotation은 fresh random K_new를 생성한다. 따라서 K_old는 rotation 뒤 생성된 conversation envelope의
AEAD tag를 인증하거나 plaintext를 복호할 수 없다. epoch를 envelope AAD에 넣지 않아도 이 성질은
key separation 자체에서 온다.

과거 envelope를 그대로 replay하면 그것은 K_old 아래에서 자기정합적으로 valid할 수 있다. 그러나
정상적으로 fresh bootstrap/register를 끝낸 client는 K_new만 보유하므로 그 frame을 열지 못한다.
반대로 과거 register reply의 wrapped K_old도 새 clientNonce AAD로 열리지 않는다. 이 두 성질은
서로 다른 회귀 테스트로 고정한다.

### 8.5 history

rotation 뒤 production history 정책은 §1.4의 RETAIN + RESEAL이다. core transcript를 K_new로
새 snapshot에 봉인하고, K_old로 열리지 않는 것을 확인한다. history purge나 restart에 의한 loss를
Track B의 이점/비용으로 계산하지 않는다.

### 8.6 rollback

forensic backup restore와 protocol v2 rollback은 §2.5에 따라 금지한다. `clientNonce`는 임의로
선택된 K의 rollback detector가 아니며, v2는 fresh wrap replay 보호를 없앤다.

## 9. 검증 계획

| ID | 검증 |
|---|---|
| T1 | `addRevocation`이 account body, `exp`/`nbf`/`aud`를 보존하고 jti/iat/iss signing metadata를 정상 재생성하며(같은 초의 iat 숫자 변경은 요구하지 않음) 동일 key와 `"*"` floor를 낮추지 않음 |
| T2-a | nats-server v2.14.2 MEMORY: preload rewrite + SIGHUP reload 뒤 targeted live disconnect, unrevoked connection 유지, old-credential reconnect 실패 |
| T2-b | 선택된 full/Dir resolver: publish response, durable readback, targeted disconnect/reconnect failure |
| T3 | browser mint caller inventory: 모든 non-test reference/demo/example 경로가 instrumented seam을 지나며 agent/observer 예외가 분류됨 |
| T4 | private mint → actual JWT decode → exact record persist → return 순서; record 실패 시 JWT/seed가 어떤 외부 seam에도 escape하지 않음 |
| T5 | broader-set stateful confirmation의 cross-route/account/filter/digest 결박, empty/sparse ledger, expiry, replay와 concurrent consume 단일 승자, fixed floor 재사용; exact revoke는 token 없이 durable operation/CAS로 직접 executing. deterministic hook으로 final digest+fence transaction 직전/직후 다른 replica mint를 경주시켜 per-peer/account-wide 선형화를 검증 |
| T6 | generations-first 뒤 key write 실패 시 key file/material/cache 불변 + audit sidecar 전진 가능; stale-entry compaction 뒤에도 full인 new-peer register는 audit fail-open, missing target entry의 offline rotate는 durable slot/write 없으면 key 변경 전 fail-closed |
| T7 | 같은 account의 concurrent revoke가 accepted JWT에서 병합되어 lost update 없음; publish lost response/reject와 ledger failure 상태. partition node는 durable quarantine 뒤 나머지 authoritative membership으로 complete한다. stale return은 process/routes stable zero→stopped per-store exact heal→all-ingress 격리 restart→trust/hash/floor/old-credential rejection 검증 뒤에만 rejoin하며, pre-accepted delayed update는 release될 수 없고 store hash가 regress하지 않음; zero 불명·partial·membership drift는 quarantine 유지 |
| T8 | exact/per-peer 새 userPubkey와 wildcard replacement의 real-server boundary: same-second 거부, 다음 초 `iat > floorSec` 성공 |
| T9 | wildcard agent recovery: controller suspend/zero 확인, exact tuple credential 이동, re-enrol, decoded agent `iat > floorSec`, relay auth 뒤 restart |
| T10 | core transcript 유지, post-rotation snapshot이 K_new로 열리고 K_old로 열리지 않음; gateway restart 전후 transcript 유지 |
| T11 | reference/demo top-level route delegation과 각 profile의 기존 auth/status 의미 보존 |
| T12 | 옵션 2 migration inventory 여섯 곳의 system account/resolver persistence/publish/readback smoke test |
| T13 | offline rotate가 zero-replica attestation 없이 fail-closed하고 diagnostic probe를 lock으로 간주하지 않음; 여러 gateway process를 scale-to-zero해 observed zero/stable 및 ready endpoint 0을 단언 |
| T14 | synchronous `rotate`: missing peer 거부, existing reads epoch 불변, fresh 32-byte K, recorded-peer capacity-neutral, `StorageIdentityV2`, missing/corrupt/read-error empty+safe-log register 정책, stale compaction·target durable entry, 단계별 crash/fault 결과와 cache publish ordering |
| T15 | 32-byte base64url validation, PoP disabled에서도 nonce 필수, canonical AAD plugin/client shared vectors, 성공 attempt의 local nonce 전달, reply nonce echo 금지, 매 요청 re-wrap |
| T16 | `clientNonce`가 PoP signed message의 plugin/client mirror와 public API에 byte-identical하게 결박됨 |
| T17 | old wrapped-K reply가 새 nonce로 열리지 않음; old envelope replay가 K_new client에서 열리지 않음; K_old가 K_new envelope를 인증/복호하지 못함 |
| T18 | pre-#54 cross-account bootstrap/key acquisition을 재현한 뒤 fixed-floor revoke, resolver live eviction, offline K rotate, agent recovery, fresh browser bootstrap까지 수행해 구 credential·K_old가 모두 무효임을 증명 |
| T19 | non-expiring credential과 한 peer의 복수 credential을 exact/per-peer/wildcard dry-run·실행에서 빠짐없이 처리하고 pre-ledger/agent unknown 경고를 고정 |
| T20 | publish→live drain 확인→key persistence→core history retain/reseal→fresh bootstrap 각 경계에 fault를 주어 operation 상태와 재시작/reconciliation 결과를 검증 |
| T21 | `revocationCapable`이 operator-seed/delegated-signer lifecycle, recovery authority, resolver readiness와 quarantine/rejoin capability를 보고하고, managed provider 실패가 actionable control/escalation을 반환하며 모든 응답·로그에 secret이 없음 |
| T22 | active issuance fence 중 mint 전 대기/거부 및 mint 후 persist/return 전 폐기, wildcard 외부 issuer freeze fail-closed, crash/lease expiry·acceptance-unknown·reconciliation-required에서 fence 유지; DB operation ownership recovery는 필요 시 all-node offline barrier 뒤 수행하고 safe abort/complete release 뒤 issuance 재개 |
| T23 | wildcard external freeze를 dry-run/floor보다 먼저 획득: freeze 직전 발급 credential의 decoded issuer high-watermark가 floor에 포함되어 revoke되고 freeze 뒤 mint는 거부됨. lapse/membership drift/invalid attestation은 old ordering을 실행하지 않고 safe abort 후 새 freeze·dry-run·floor를 요구 |
| T24 | Dir negative contract: signer 제거만으로 queued stale JWT durable save를 막지 못함. A가 send 후 response 전 지연/partition되면 live B takeover를 거부한다. offline authority가 membership snapshot, API/A/all-NATS stable zero, unreachable quarantine, queued-message 소거, stop 상태 per-store atomic replace와 동일 operator/target/system hash를 확인한다. 재시작 node는 quarantine/non-serving으로 all-node exact readback·각-node old publisher/revoked-client reconnect failure·stable membership을 통과한 뒤에만 serving 일괄 enable 및 B 시작. partial seed/검증 node는 절대 serving하지 않으며 stale claim/node release·rejoin, authority 부재, membership drift는 fail-closed |
| T25 | real server에서 초기 root→D1 offline bootstrap과 recovery D1→D2를 수행한다. helper candidate는 exact-current issuer seed로 성공하고 account body/floors를 보존한다. exact operator trust hash는 D2 포함/D1 제외이고 non-mutating fixture에서 D1 claim은 invalid다. old publisher user reconnect/publish가 ingress 전 실패해 D1 attempt 뒤 store hash는 불변이며 D2 credential+signer update는 성공한다. unsafe Dir endpoint를 signer oracle로 쓰지 않고 root material은 online에 노출하지 않으며 operator/target/system missing trust·partial hash는 fail-closed |

T2-a와 T2-b는 서로 대체하지 않는다. real-server harness는 바이너리 부재 시 명시적으로 skip할 수
있지만 CI lane에는 v2.14.2 MEMORY와 선택된 Dir/full topology를 둘 다 둔다.

T18의 공격 전제는 테스트 fixture로만 허용한다. #54 이전 client가 다른 account의 K_old와 NATS
credential을 얻은 상태를 만든 뒤, **모든 gateway process가 observed zero이고 ready가 아님**을
확인하고 §2.7 전체 순서를 실행한다. 성공 기준은 구 credential reconnect 실패, 비대상 연결 유지,
구 agent credential(wildcard 시) 실패, K_old로 새 envelope 실패, old wrap/envelope replay 실패,
K_new history snapshot 성공과 fresh browser 양방향 relay 성공이다.

### 9.1 issue #72 acceptance mapping

| 수용 요구 | 규범 설계 | 증명 |
|---|---|---|
| one credential 또는 reviewed broader set revoke | §3.2 issuance linearization, §4 batch/CAS/publisher fence, §5 stateful confirmation | T5, T7, T8, T19, T22, T24, T25 |
| self-contained resolver publish/acceptance와 live 차단 | §1.2, §4.3, §6; all-node exact 판정, delegated signer lifecycle, heal-before-serve | T2-a, T2-b, T7, T24, T25 |
| 발급분 추적과 비밀 미저장 | §3 | T3, T4, T19 |
| selected peer K rotation과 새 암호 경계 | §2.7, §8.1~§8.4 | T14, T17, T18 |
| old wrap replay 방어 | §8.3 | T15, T16, T17 |
| security-authoritative monotonic epoch와 epoch-bound AAD | §0.1의 **selected substitution**; privileged storage rollback은 #85로 deferred | 이 PR에서 literal satisfaction을 주장하지 않음 |
| history 정책 명시 | §1.4, §8.5 | T10, T20 |
| 전체 사고 순서가 노출 창 없이 수렴 | §2.7 | T13, T18, T20 |
| agent/wildcard·managed·degraded 운영 가능 | §2.2~§2.4, §3.4, §5 | T5, T8, T9, T19, T22, T23 |
| 과거 노출을 치유한다고 주장하지 않음 | §0, §8.4 | old-envelope fixture와 문서 검토 |

## 10. 롤아웃과 장애 처리

1. Track C 런북과 MEMORY real-server 검증을 먼저 낸다.
2. Track A에서는 full/Dir resolver migration을 먼저 착륙시키고 여섯 topology smoke test를 통과한다.
3. 별도 `PublisherRecoveryAuthority`와 cluster-wide offline barrier로 root-only trust/account를
   D1-authorized trust + D1-signed account로 bootstrap한 뒤에만 per-account single-writer
   `ClaimPublisher`를 시작한다. Dir queued stale-JWT negative contract와 Dn→Dn+1 recovery를 확인한다.
4. issuance ledger와 durable operation/claim repository를 **같은 transactional backend**에
   배포하고 fence recovery/reconciliation을 활성화한다.
5. 모든 issuance wrapper를 private-mint + atomic fence-check/persist-before-return으로 전환하고
   repo-wide caller/race conformance test를 통과한다.
6. reference/demo top-level router를 연결한 뒤 admin revoke route를 활성화한다.
7. publish/readback, reconciliation backlog, acceptance-unknown을 관측한다.
8. Track B를 배포할 때 protocol v3 client/plugin/SaaS를 lockstep roll forward하고 forced
   refresh/bootstrap 절차를 실행한다.

publish 실패는 revoke 성공으로 보고하지 않는다. all-node exact readback 전에는 다음 publish를
하지 않는다. publish 수용 뒤 ledger failure도 active/revoked
둘 중 하나로 거짓 단순화하지 않고 reconciliation-required로 운영한다. resolver health가 나빠지면
새 revoke를 중단하고 accepted JWT를 readback해 수렴시킨다.

broader revoke route는 3~5단계가 모든 issuer replica에 배포되고 wildcard external issuer freeze
preflight가 준비되기 전에는 활성화하지 않는다.

## 11. 미결 항목

다음은 구현 전에 정해야 하지만 확정 결정을 다시 여는 질문은 아니다.

1. durable operation/claim repository의 첫 production adapter와 보존 기간.
2. CAS 식별자로 version/hash/JTI 중 무엇을 표준화할지.
3. confirmation TTL과 최대 reviewed-set 크기.
4. resolver migration의 directory backup/restore 운영 주체. 단, K forensic backup처럼 live
   leaked key를 복구하는 용도로 쓰지 않는다.

non-goal/follow-up: privileged operator/recovery system이 full local snapshot 또는 K_old를
재설치해도 fresh client가 이를 거부하게 만드는 external non-rollbackable generation anchor는 이
PR의 범위 밖이며 [#85](https://github.com/mir-stream/openclaw-webchannel/issues/85)에서 다룬다.

미결이 **아닌 것**:

- resolver 옵션 2 선택
- `clientNonce` 32-byte base64url 형식
- stateful atomic one-time confirmation
- fixed `floorSec`와 inclusive boundary
- production history RETAIN + RESEAL
- protocol v2 rollback 금지

## 12. convergence correction log

v8은 이전 리뷰 기록의 다음 결론을 명시적으로 폐기했다.

- MEMORY reload가 claim/live connection에 효과가 없고 restart가 필수라는 결론
- `HistoryStore` purge가 production history loss/rotation 계약이라는 결론
- record-before-mint 또는 ledger clock으로 `iat`/`exp`를 유도하는 설계
- process-local mutex와 key별 publish로 batch revoke를 충분히 구현할 수 있다는 설계
- 무상태 MAC confirmation 권고
- relay disconnect/restart가 자동 re-register를 만든다는 주장
- lock/pid probe가 offline writer 부재를 구조적으로 보장한다는 주장
- backup restore가 `clientNonce`로 탐지될 수 있고 rollback 문제가 wire 호환성뿐이라는 주장
- audit epoch를 security-authoritative로 보거나 같은 local snapshot의 epoch/AAD만으로 privileged
  rollback까지 막았다고 보아 원래 epoch AC를 literal satisfaction으로 표시하는 주장
- final digest 확인만으로 concurrent issuance를 닫았다고 보고, issuance persist와 broader revoke를
  같은 durable fence 아래 선형화하지 않아도 된다는 주장
- wildcard floor를 external issuer freeze/high-watermark attestation보다 먼저 정해도 된다는 주장
- repository lease/CAS token이 기본 Dir claim-update side effect까지 fence하며 stale publisher가
  유효하게 서명된 old full JWT를 publish하지 못한다는 주장
- old publisher process zero와 signer credential revoke만으로 queued Dir update가 소거되어 live
  ClaimPublisher takeover가 안전하고, ordinary acceptance를 quorum으로 판정해도 된다는 주장
- helper signer를 영구 root seed로만 설명하거나 delegated key를 trust에서 교체하면서 current
  account `iss`와 helper signer public key의 exact-match invariant를 유지하지 않아도 된다는 주장
- ordinary quarantine node가 node-local stop/route isolation으로 pre-accepted delayed update를
  소거하고 stale state를 heal·검증하기 전에 serving membership으로 재합류해도 된다는 주장

이 로그는 역사적 오답을 규범으로 남기기 위한 것이 아니라, v8의 현재 계약과 혼동하지 않게 하기
위한 correction record다.
