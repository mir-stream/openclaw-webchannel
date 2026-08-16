# Issue #53 — `/stop` ACK-loss retry 멱등성

> 상태: **범위 축소 최소 수정 구현·검증 완료**
>
> branch: `fix/issue-53-stop-replay-protection`
>
> rebased base: `origin/develop` = `c002611` (2026-08-10 확인)
>
> 대상 이슈: https://github.com/mir-stream/openclaw-webchannel/issues/53

## 1. 제품 결정

원래 #53은 두 문제를 한꺼번에 다뤘다.

1. peer당 outer `messageId` LRU가 가득 차면 아직 timestamp window 안인 id도
   evict되어, relay가 캡처한 봉투를 다시 publish할 수 있다.
2. `/stop` ACK가 유실되면 클라이언트가 stable inner `message.id`를 유지한 채
   새 outer `messageId`/`ts`로 자동 재봉인한다. control lane은 일반 ingress
   dedupe를 우회하므로 같은 stop을 다시 실행할 수 있다.

이번 수정은 **2번의 정상 ACK-loss retry만 해결한다.** 1번을 막기 위한 outer
replay-cache 재설계, full-window retention, replay-pressure 메트릭, restart
durability는 구현하지 않는다.

이유는 다음과 같다.

- 악성 relay는 frame drop/delay만으로 이미 availability를 통제할 수 있다.
- outer replay cache를 완전하게 만들어도 relay가 `/stop`의 최초 전달을 다음
  턴까지 지연하면 막을 수 없다. 이 위협을 실제로 닫으려면 dedupe가 아니라
  `/stop`을 `targetTurnId`에 결박하는 wire-level 설계가 필요하다.
- 반면 ACK 유실은 악성 relay 없이도 발생한다. 클라이언트 live retry는 같은
  inner id를 1초부터 재전송하므로, non-idempotent control consumer는 실제
  전달 계약 버그다.

따라서 #53을 "hostile-relay anti-replay"가 아니라
"at-least-once control-lane retry idempotency"로 다룬다.

## 2. 유지할 아키텍처 경계

- wire protocol은 바꾸지 않는다.
- client ledger/retry 동작은 바꾸지 않는다.
- control lane은 FIFO와 debouncer를 계속 우회한다.
- 새 durable store나 장기 replay cache를 만들지 않는다.
- 이미 존재하는 stable inner id와 process-wide ingress outcome store를 재사용한다.
- 뒤따른 정상 입력이 `/stop` persistence를 추월하지 않도록 buffer drop과 abort
  dispatch는 계속 동기적으로 수행한다.

## 3. 최소 구현

`createControlLaneRetryGuard`가 사용하는 추가 상태는 outcome record가 끝나기
전까지만 존재하는 bounded in-flight key뿐이다(기본 256개). 완료된 marker는
기존 `processIngressOutcomes.peek(accountId, peerId:id)` hot cache를 사용한다.

control frame 수신 순서:

1. id가 없거나 유효 범위를 벗어나면 기존처럼 untracked frame으로 처리한다.
2. inner id가 hot/in-flight에 이미 있으면 ACK만 다시 보내고 반환한다.
   buffer cancel과 `handleInboundMessage`는 실행하지 않는다.
3. 처음 본 inner id면 bounded in-flight key를 먼저 잡고 outcome record를
   background로 시작한 뒤, 즉시 기존 buffer cancel → ACK → fast-abort dispatch를
   수행한다.
4. outcome store 실패나 in-flight cap 압박은 한 번 경고하고 해당 frame을
   untracked로 처리한다. storage 장애가 `/stop` 자체를 막지는 않는다.

중요한 불변식은 **duplicate 판정이 destructive buffer drop보다 먼저**라는 점이다.

## 4. 명시적으로 수용하는 잔여

- 악성 relay가 아직 전달되지 않은 `/stop`을 후속 턴까지 지연하는 경우
- outcome hot-cache eviction 또는 gateway restart 뒤의 첫 cold retry
- storage가 완전히 unavailable여서 marker를 만들지 못한 동안의 retry
- in-flight cap 압박으로 marker를 잡지 못한 retry
- outer LRU eviction/restart 뒤 다시 들어오는 `/stop` 이외 frame의 의미적 replay

이 잔여는 relay-availability 위협 범위다. 이를 닫기 위해 outer LRU를
영속화하거나 fast-abort를 cold storage lookup 뒤에 세우지 않는다. 향후 강한
stale-control 방지가 제품 요구가 되면 별도 protocol revision에서
`targetTurnId`를 설계한다.

## 5. 수용 기준

- 정상 hot/in-flight budget 안에서 같은 account/peer/inner id의 ACK-loss retry는 ACK된다.
- 그 retry는 abort dispatch, debounce cancel, pending-buffer clear를 반복하지 않는다.
- 서로 다른 peer의 같은 inner id는 서로 영향을 주지 않는다.
- 첫 control frame과 id-less 구형 frame은 계속 즉시 처리된다.
- outcome persistence를 기다리지 않고 fast-abort가 진행된다.
- 추가 상태는 bounded transient in-flight key로 한정한다.
- outer LRU 동작과 wire protocol은 변경하지 않는다.
- 코드 주석은 outer LRU가 best-effort임과 cold/restart residual을 정직하게 설명한다.

## 6. 검증

```sh
npx vitest run packages/plugin/src/control-lane.test.ts
npx vitest run packages/plugin/src/index-nats-wiring.test.ts
npx vitest run packages/plugin/src/ingress-dedupe.test.ts packages/plugin/src/ingress-outcome.test.ts
npm run typecheck
git diff --check
```

전체 검증 전에 `npm run build`가 필요할 수 있다. `examples/webchannel-app`은
workspace dist가 없으면 typecheck가 실패한다.

2026-08-10 최신 `develop` rebase 뒤 검증 결과:

- monorepo build와 전체 typecheck 통과
- 타깃 4 files / 101 tests 통과
- AC6 실서버 파일 제외 전체: 142 files 통과, 2 skipped;
  2,376 tests 통과, 30 skipped (exit 0)
- AC6 포함 전체에서도 143 files / 2,391 tests는 통과했으나, 로컬에
  `nats-server`가 없어 `ac6-device-flow-e2e.test.ts` child-process spawn이
  `ENOENT` unhandled error로 끝났다. 변경과 무관한 환경 제약이다.
