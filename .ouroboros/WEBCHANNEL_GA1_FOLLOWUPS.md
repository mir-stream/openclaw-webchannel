# WebChannel 가-1 — Follow-up Backlog

가-1 (device-flow 획득을 `channels add`로 이동 + 다중 account 멀티플렉스 + accountId 라우팅)
의 seed 완료 게이트(AC1~AC7)는 모두 닫힘. seed: `.ouroboros/seeds/seed_a9a3526c0d63.yaml`.
구현: `ebccb32` (Cycle 1 획득 재배치) → `892ed36` (Cycle 2 멀티플렉스+라우팅) → `3e078ea` (Cycle 3 e2e 게이트).

아래는 **seed 범위 밖** 후속. 우선순위 순.

## A. 기능 갭

### A1. boundChannel — per-account proactive-outbound + approvals (권장: 다음 사이클)
- **현상**: 플러그인은 단일 `lazyTransport → boundChannel` facade로 core-initiated(미요청) 발신과
  승인 capability를 처리하는데, `boundChannel`이 **primary 계정("default" else first)에만** 바인딩됨
  (`packages/plugin/index-nats.ts:180-188, 705-706`).
- **영향**: 브라우저 turn에 대한 **답신**은 계정별 dispatcher로 정상(→ AC6 무관). 그러나 agent가
  먼저 거는 푸시 메시지와 **exec 승인 버튼**(`[Allow once] [Deny]`)이 capability 경로로 가면
  **non-primary 계정 사용자는 못 받음**. 엣지: 같은 peerId가 primary+non-primary 양쪽 등록 시 primary로 누수.
- **해결**: accountId-aware outbound facade — core 발신 시 어느 계정 채널로 보낼지 선택하게.
  multi-account 실운영 전제 조건.

## B. 폴리시 / 사소 (묶어서 한 번에)

### B1. CLI 플래그 오버로딩
- installed(non-bundled) 플러그인이라 openclaw `channels add`가 커스텀
  `--saas-base-url/--tenant/--agent-id`를 commander에 등록 못 함 → 제네릭
  `--base-url`→saasBaseUrl / `--url`→tenant / `--token`→agentId 매핑(`packages/plugin/src/setup.ts`).
  현재 완화: 획득 시 resolved identity echo 로그 + `docs/ONBOARDING_GUIDE.md` 문서화 + env 대안.
- **근본 해결(택1)**: openclaw 본체가 installed 플러그인 cliAddOptions를 등록하게 하거나,
  전용 `openclaw webchannel enroll` 서브커맨드.

### B2. 로그 라벨 가독성
- gateway.log `credential source: enrolled`의 "enrolled"는 creds **모드**(소비)이지 enroll 행위가
  아님 → `grep enroll` 시 false hit. "consuming enrolled creds" 류로 다듬기.

### B3. `/challenge` non-jwt account → 500
- `/register`는 401로 수정됨(Cycle 2). `/challenge`는 pre-existing 500 잔존. 보안 영향 없음, cosmetic.

### B4. popChallenges 스토어 process-wide
- per-account 아님. 악용 불가(per-account full verify가 게이트). 주석만 존재. 정리 시 per-account화 고려.

### B5. (옵션) zero-serving hard-fail
- 모든 account가 skip되면(예: encryption 오설정) 현재 503 + error 로그로 프로세스 유지(seed의
  무크래시 제약). 운영 정책상 "어떤 account든 unencrypted면 즉시 crash"를 원하면 opt-in 추가.

### B6. 무인증 cross-tenant unregister DoS (PR #4 리뷰)
- `/webchannel/nats/unregister`는 teardown 경로라 JWT 없음(pre-existing). 이 델타에서 단일 채널 →
  **모든 account 런타임 루프**(`packages/plugin/index-nats.ts:471-475`)로 확대됨. peerId(=JWT `sub`,
  비밀 아님)를 아는 무인증 호출자가 해당 peer를 *모든 테넌트*에서 강제 연결해제 가능(연결해제 DoS,
  데이터 노출 아님).
- **완화 방향**: teardown에 토큰이 없어 깔끔한 account 해석이 안 됨 → (택1) peer→account 역인덱스로
  소속 account만 unregister, 또는 unregister에도 경량 auth(자기 peer만 teardown) 요구.

### B7. 동일 audience accounts cross-register (PR #4 리뷰)
- 두 account가 같은 `jwt.audience`(같은 IdP)를 쓰면 first-wins aud→account 매핑
  (`index-nats.ts:~705` + `register-dispatch.ts:60-79`)으로 두 번째 account 유저가 첫 account
  채널에 등록됨. `planAccounts`는 agentId 중복은 막지만 **audience 중복은 미차단**.
- 현재 완화: 충돌 시 경고 로그 + 문서. **근본 해결**: `planAccounts`에서 served account 간 distinct
  `jwt.audience` 강제(중복이면 skip + error).

## C. 큰 옵션 (요구 발생 시)

### C1. 가-2 — subject 중간 세그먼트 agentId → accountId 개명 ✅ DONE (`6e6280e`, 브랜치 `feature/webchannel-ga2-accountid-wire`)
- account ≠ agent 유연성(한 전송 엔드포인트 뒤 여러 agent, 또는 agent 공유)이 필요해질 때.
  subject `webchannel.{tenant}.{agentId}.{peerId}` → `…{accountId}…`. SaaS + client + plugin
  **동시 배포** 필요한 breaking 와이어 변경. 현재 account=agent 1:1이라 불필요. → **구현됨**:
  단일 와이어 신원(subject 중간/JWT aud/enroll 식별자/envelope plaintext routing+history triple)을
  기존 `--account` 키로 대체, `channels add`에서 agentId 제거 → 처리 agent는 `agents bind` 전용
  (telegram 동형). 클린 브레이크(라이브 배포 없음, 와이어 back-compat 없음). audToAccount 기본
  항등 매핑(설정 jwt.audience 매핑+first-wins 충돌가드 유지), multiplex의 missing/duplicate-agentId
  skip 제거(accountId는 config map 키라 구조적으로 유일), creds-missing/connection/encryption graceful
  skip 불변. 2라운드 리뷰 PASS(와이어 대칭+auth+grep 완전성). typecheck clean, tests 968(plugin 724/
  client 155/saas 89). **미push/PR.**
- 가-1은 가-2의 strict subset(버릴 작업 없음); 개명만 추가하면 됨.

### C2. (가-2 후속, 사소) 테스트 픽스처 `const AGENT_ID = "agent1"` 잔존
- 여러 plugin 테스트에 stale 변수명 `AGENT_ID`가 남음 — 값은 `accountId:` 필드에 할당(와이어 read 아님,
  버그 아님). `account-config.test.ts`의 `agentId` merge-passthrough 키도 임의 key일 뿐. 정리 시 ACCOUNT_ID로 개명.

## D. 프로세스
- 브랜치 `feature/webchannel-channels-add-onboarding` push 완료, PR 생성.
- (별건, 기존 백로그) AC4 npm publish는 creds 문제로 보류 — push 금지.
