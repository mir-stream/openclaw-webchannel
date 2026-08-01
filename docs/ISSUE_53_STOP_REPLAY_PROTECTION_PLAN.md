# Issue #53 — captured `/stop` replay 차단 (Track C1-b)

> 상태: **착수 전 핸드오프**. 이 worktree에는 아직 제품 코드 변경이 없다.
>
> worktree: `/home/orca/workspace/openclaw-webchannel-issue-53-stop-replay`
>
> branch: **`fix/issue-53-stop-replay-protection`** (upstream tracking 없음 — 실수로 develop에 push 되지 않게 일부러 끊었다)
>
> base: `origin/develop` = **`0dc0636`** (`chore: sync develop with main (ClawHub gate)`)
>
> 대상 이슈: https://github.com/mir-stream/openclaw-webchannel/issues/53 (P2 / kind:security / area:plugin)
>
> 정본 실행 그래프: `rota-crew` 저장소
> `docs/2026-07-31-웹채널-v040-worktree-구현트리.md` 의 mermaid — 이 문서와 충돌하면 **그 그래프가 정본**이다.
>
> Rota 측 Track C 핸드오프: `rota-crew` `docs/2026-08-01-웹채널-0.4.x-Track-C-핸드오프.md`

## 0. 이 worktree가 그래프에서 차지하는 위치

- 그래프 노드: **C1-b · 병렬 worktree · Issue #53**.
- **시작 blocker 없음.** 형제 노드 C1-a(#81)와 병렬로 지금 착수한다.
- **릴리스 관계가 비대칭이다.** #81은 release critical이라 C2-a를 단독으로 잘라도 된다.
  #53은 *준비되면* 같은 patch에 실리고, 늦으면 **#81 릴리스를 막지 않고** 후속 patch(C2-b)로 간다.
  즉 이 브랜치는 **일정 압박 없이 제대로** 고치는 쪽이 그래프가 의도한 자세다.
- 다만 C2-b(=#53이 실린 release)는 **최종 안정성 E2E(E2E-2)의 필수 선행**이다. 결국은 들어가야 한다.

## 1. 절대 어기지 말 하드 제약

1. **wire protocol을 바꾸지 않는다.** `WEBCHANNEL_PROTOCOL_VERSION`은 **3** 고정. 0.4.0이 이미
   v2→v3 하드 브레이크를 소비했고, C3의 전제("protocol 3 유지 시 강제 re-enrollment 없음")가
   여기에 걸려 있다.
2. **0.4.x patch 범위.** `client`/`plugin`/`saas` 세 패키지는 항상 같은 버전으로 함께 올린다.
3. **공유 체크아웃에 손대지 않는다.**
   - `/home/orca/workspace/openclaw-webchannel` — main worktree(`main`). 건드리지 않는다.
   - `/home/orca/workspace/openclaw-webchannel-deploy` — **Rota가 `file:` 의존으로 물고 있는 벤더
     체크아웃**, `WC_REF 7164006`에 detached. 브랜치 전환이나 dist 교체는 Rota의 4개 worktree를
     동시에 깨뜨린다. **읽기만 한다.**
4. **머지·릴리스는 사용자 승인 후에만.** `develop` 머지, 버전 bump, publish는 전부 승인 사항이다.
5. **#81(restart liveness)은 이 브랜치의 범위가 아니다.** 형제 worktree
   `/home/orca/workspace/openclaw-webchannel-issue-81-restart-liveness`가 소유한다.

## 2. 결함의 사실관계 (base `0dc0636` 기준 실측 앵커)

이 이슈는 **서로 다른 두 개의 트리거**가 같은 P2 약점(control lane의 재실행)을 연다.
둘 다 고쳐야 수용 기준을 만족한다.

### 2.1 트리거 A — cap eviction으로 열리는 봉투 replay

`acceptFreshInbound()`(`packages/plugin/src/nats-channel.ts:915-945`)는
±10분 timestamp window와 peer당 2,000개 `messageId` 캐시를 조합한다
(`DEFAULT_REPLAY_WINDOW_MS = 10 * 60 * 1_000` `:118`,
`DEFAULT_MAX_SEEN_MESSAGE_IDS_PER_PEER = 2_000` `:119`, 저장소 `seenMessageIds` `:173`).

한 peer가 그 window 안에서 2,000개를 넘는 서로 다른 유효 프레임을 보내면 가장 오래된 id가
evict된다. 그런데 그 id의 원래 timestamp는 **여전히 window 안**이다. 캡처한 바이트 동일 프레임을
다시 publish하면 다시 admit된다.

**코드 안의 주석이 지금 거짓말을 하고 있다.** `:940-942`:

> "dropping it is safe because the ts window (which only admits frames within ±replayWindowMs of now)
> re-catches any replay of an evicted old messageId."

조건은 정반대다 — window **안에** 있는 timestamp는 전부 accept된다. 주석/설정 문서 정정도
수용 기준에 포함된다.

### 2.2 트리거 B — ACK 유실 + 재봉인 (캐시 압박도 재시작도 필요 없음)

이슈 코멘트(수렴 리뷰 addendum)가 추가한 경로이고, **이쪽이 실제로 더 잘 일어난다.**

1. 클라이언트가 안정적 inner `message.id = X`로 명시적 `/stop`을 보낸다.
2. plugin이 control lane을 실행하지만 ingress ACK가 유실된다.
3. 클라이언트 unacked 원장에 X가 남는다 (`packages/client/src/nats-client.ts`의 `unackedLedger`,
   `MAX_UNACKED = 100`).
4. 재연결 후 원장 replay가 `sealMessage()`를 다시 부른다. inner id는 X 그대로지만
   **바깥 봉투의 `messageId`/`ts`는 새로 발급**된다 (`packages/client/src/e2e-crypto-browser.ts`).
5. `acceptFreshInbound()`는 새 봉투이므로 accept한다. 그리고 `/stop` 분기는 영속 dedupe
   `${peerId}:${id}`를 **우회**하고 바로 dispatch한다.
6. 그 사이 **다음 턴이 시작됐다면**, 이 중복 stop이 그 턴을 중단시키고 버퍼된 입력을 지운다.

현재 코드에 박혀 있는 주장 — `packages/plugin/src/nats-account-runtime.ts:1094-1097`:

> "A replayed /stop that lands before this ack is a harmless no-op abort (accepted)."

이 주장은 **후속 턴이 시작되지 않았을 때만 참**이다.

### 2.3 관련 앵커 지도

| 대상 | 위치 |
| --- | --- |
| replay 판정 | `packages/plugin/src/nats-channel.ts:915-945` (`acceptFreshInbound`) |
| window/cap 기본값과 거짓 주석 | `packages/plugin/src/nats-channel.ts:118-119`, `:905-914`, `:938-942` |
| control lane 라우팅·ACK·dispatch | `packages/plugin/src/nats-account-runtime.ts:1034-1113` |
| 명시적 `/stop` 판정과 버퍼 파기 게이트 | `packages/plugin/src/control-lane.ts` (`isControlLaneMessage`, `isExplicitAbortCommand`, `shouldDropBufferedInputOnStop`) |
| 정상 ingress의 **올바른** 중복 처리 (ack는 하되 dispatch 안 함) | `packages/plugin/src/ingress-dedupe.ts` (`createIngressOnFlush`, `:280-`) |
| 그 dedupe의 배선 | `packages/plugin/src/nats-account-runtime.ts:935-1005` |

## 3. 설계 방향

이슈가 요구하는 것은 두 층이다.

**층 1 — control lane의 멱등성을 안정적 inner id에 건다.**
바깥 봉투 id나 LRU 캐시만으로는 트리거 B를 못 막는다. `/stop`도 정상 ingress와 같은
`${peerId}:${message.id}` 영속 dedupe **판정**을 받아야 한다. 단, 동작은 다르다:

- 중복 `/stop`은 **여전히 ACK 한다** — 안 그러면 클라이언트 원장이 안 빠지고 영원히 replay한다.
- 그러나 **dispatch 하지 않는다.**
- 이건 `createIngressOnFlush`가 정상 lane에서 이미 하는 행동과 정확히 같다. **그 함수의 판정
  로직을 재사용하는 쪽이, control lane에 두 번째 dedupe를 새로 짜는 것보다 낫다.**
  (control lane은 FIFO를 우회해야 하므로 debouncer/queue는 재사용하지 않는다. 우회해야 하는 것은
  **순서**지 **중복 판정**이 아니다 — 이 구분이 이 수정의 핵심이다.)

**층 2 — evict된 id가 window 안에서 되살아나지 않게 한다.**
"messageId는 그 timestamp가 accept될 수 있는 전 기간 동안 replay-거부 상태여야 한다"가 요구사항이다.
선택지:

- cap을 window 기반 만료로 바꾸고(ts 기준 정리), **메모리 상한은 peer당 프레임 레이트로 유도되는
  명시적 값**으로 다시 잡는다. 상한에 닿으면 **조용히 fail-open 하지 말고** 거부 + 경고/메트릭.
- 또는 window를 좁혀 cap이 실질적으로 도달 불가능해지게 만들고, 그 잔여를 문서에 명시한다.

어느 쪽이든 **"메모리 상한이 있고, peer 간 격리가 유지되며, 그 보증이 문서와 일치한다"**를 만족해야 한다.
peer B의 트래픽이 peer A의 보호를 evict할 수 없다는 성질은 지금도 참이고, 유지해야 한다.

**재시작 내구성은 명시적 결정 사항이다.** 캐시는 의도적으로 in-memory다. 층 1이 영속 dedupe에
기대면 재시작 후에도 `/stop` 중복이 막히므로 대부분 해결된다. 층 2의 in-memory 잔여를
"의도된 범위 밖"으로 남기려면 **accept되는 timestamp 의미를 좁혀 잔여를 명시·유계로 만들어야 한다.**
이건 설계 판단이므로 구현 전에 결론을 문서에 적고 진행한다.

## 4. 수용 기준 (이슈 본문 + 코멘트 통합)

- `messageId`는 그 authenticated timestamp가 accept될 수 있는 **전 기간 동안** replay-거부다.
  지속적 peer 트래픽에서도, 낮은 cap을 설정한 테스트에서도.
- 문서화·강제 가능한 메모리 상한과 peer별 격리를 유지한다.
- `/stop`은 캐시 압박 후에도, 프로세스 재시작 후에도 (accept되는 timestamp window 안에서)
  replay 거부를 우회하지 못한다. 재시작 내구성을 범위 밖으로 두려면 **잔여를 명시하고 유계로** 만든다.
- control lane 멱등성은 **안정적 authenticated inner message id**(또는 동등한 durable identity)에
  걸린다. 바깥 봉투 id/캐시만으로는 안 된다.
- 중복 `/stop`은 **ACK 되지만 dispatch 되지 않는다.**
- 진짜로 신선한 유일 프레임의 accept와 clock-skew 동작은 그대로 보존한다.
- 거짓 주석·설정 문서를 실제 보증과 일치하게 고친다.
- replay-state 압박 / over-cap 거부에 대한 경고나 메트릭을 노출한다. **조용한 fail-open 금지.**
- fail-closed per-account/per-peer scoping을 깨지 않는다.

## 5. 테스트 계획

기존 스타일: `packages/plugin/src/*.test.ts`, 주입 clock, 작은 cap 설정.

- **결정적 단위 회귀 (트리거 A)**: 작은 cap으로 — 프레임 A accept → cap 초과하도록 서로 다른 id
  다수 accept → A의 `ts`가 아직 window 안일 때 A replay → **드롭**되어야 한다.
- **경계**: timestamp window 만료 지점, 미래 방향 clock skew.
- **peer 격리**: peer B의 churn이 peer A의 replay 보호를 evict하지 못한다.
- **control lane 통합 회귀 (트리거 B, 핵심)**: stop X 처리 → ACK 유실 → 재연결/재봉인(바깥 id는
  새 값, inner id는 X) → **후속 턴 시작** → replay 도착. 단언:
  1. replay는 **ACK 된다**,
  2. 영속 dedupe가 "이미 admit됨"으로 식별한다,
  3. **후속 턴도 그 버퍼도 중단되지 않는다.**
  즉시 중복과 teardown/재등록 후 중복 **둘 다** 커버한다.
- **재시작/내구성 테스트**, 또는 설계가 replay state를 영속화하지 않기로 했다면 **명시된 잔여 문서**.
- **비자명성 probe**: 각 회귀에 대해 수정을 되돌리면 정확히 그 테스트가 red가 되는지 확인한다.
  트리거 A와 B는 **서로 다른 수정**이 막는다 — 한쪽 수정만으로 양쪽 테스트가 green이면
  테스트가 결함을 잘못 겨냥한 것이다.
- 기존 참고 파일: `packages/plugin/src/control-lane.test.ts`(라우팅 분기를 이미 미러링한다),
  `packages/plugin/src/ingress-dedupe.test.ts`, `packages/plugin/src/channel.test.ts`.

## 6. 검증 벨트

이 worktree는 `npm ci` + `npm run build` + `npm run typecheck`가 끝나 있고 green이다.
**`npm run build`를 먼저 돌리지 않으면 `examples/webchannel-app` typecheck가 dist 부재로 실패한다** —
회귀로 오해하지 않는다.

    cd /home/orca/workspace/openclaw-webchannel-issue-53-stop-replay
    npm run build
    npm run typecheck
    npx vitest run                                              # 전체
    npx vitest run packages/plugin/src/control-lane.test.ts     # 타깃
    git diff --check

**base 기준 baseline (형제 worktree에서 같은 커밋으로 실측):**
`Test Files 139 passed | 2 skipped (141)`, `Tests 2223 passed | 30 skipped (2253)`.
skip 2건은 `nats-server` 바이너리 부재로 자동 skip되는 realserver 스위트
(`packages/plugin/src/nats-transport-realserver.test.ts`,
`packages/saas/src/nats-permissions-realserver.test.ts`)다. **CI는 부재 시 hard-fail** 하므로
`nats-transport-realserver`에 닿는 변경을 했다면 로컬에 `nats-server`를 설치해 직접 돌리거나
PR CI를 기다린다. 이 브랜치는 plugin transport에 가까우므로 해당될 가능성이 있다.

## 7. 형제 worktree와의 충돌 규약

`fix/issue-81-gateway-restart-liveness`는 원칙적으로 **client만** 만진다(권고안이 client-side
ack-stall watchdog이다). 그래도:

- 이 브랜치가 `packages/plugin/src/nats-channel.ts`와 `nats-account-runtime.ts`의 control-lane 분기를
  **소유**한다. 형제 브랜치가 여기 닿으면 착수 전에 조율한다.
- 두 브랜치는 같은 base(`0dc0636`)를 공유한다. 합류 순서는 릴리스 노드(C2-a/C2-b)에서 정한다.
- 이 수정이 클라이언트 쪽 재봉인 동작에 의존한다는 점을 유의한다: 고치는 쪽은 **plugin**이고,
  클라이언트의 "inner id 유지 + 바깥 id 새로 발급"은 **정상 동작으로 보존**한다. 클라이언트를
  바꿔서 이 문제를 우회하지 않는다 — 그러면 구버전 클라이언트가 여전히 공격면이 된다.

## 8. 다음 에이전트 재개 절차

1. 이 문서와 정본 mermaid를 먼저 읽는다. 요구사항 재탐색을 반복하지 않는다.
2. `gh api repos/mir-stream/openclaw-webchannel/issues/53` 로 본문 + **코멘트**를 읽는다
   (코멘트의 addendum이 트리거 B의 근거다. `gh issue view`는 projects-classic 오류로 실패하니 `gh api`).
3. §3의 두 층 중 **층 1(control lane 멱등성)을 먼저** 한다. 실제 도달 가능성이 높고, 층 2의
   재시작 내구성 결정을 단순하게 만들어 준다.
4. 층 2 착수 전에 §3 말미의 "재시작 내구성 = 범위 안/밖" 결정을 문서에 적는다.
5. 실패하는 회귀 테스트 → 구현 → probe → 검증 벨트 → 커밋. 코드와 테스트는 같은 커밋에.
6. 커밋 메시지는 한국어. CHANGELOG `## Unreleased`에 항목 추가, **버전 bump는 하지 않는다**
   (C2-a/C2-b 릴리스 노드의 일).
