# P0-4 Implementation Plan — 전송 결과 계약과 false-success 제거

> Work item: [`P0.md`](P0.md) §"P0-4" (lines 224–309).
> Branch: `feat/p0-4-send-result-contract`, stacked on
> `feat/p0-3-byo-nats-authenticated-registration` (PR #45).
> Status: **CONVERGED v8** — codex gpt-5.6-sol adversarial 7 rounds
> (R1 3B+10M+1m → R2 1B+4M+1m → R2b 1B+2M → R3 1B+4M+2m → R4 0B+3M+2m →
> R5 0B+1M → R6 0B+1M → **R7 CONVERGED, 0B+0M**). Folding log: §10.
> 이 문서가 구현 스펙이다.

## 1. Goal and invariants

모든 사용자 메시지(및 agent outbound reply)가 **관찰 가능한 terminal 상태**로 귀결되게
한다. 살아 있는 process가 실패를 알고도 성공을 반환하거나, console warning만 남기고
pending 메시지를 버리는 경로를 전부 제거한다.

End-state invariants (P0.md 완료 조건):

1. `false` send 결과를 무시하고 success ID/receipt를 반환하는 caller **0개**.
2. Queue/ledger/hold에서 console-only eviction **0개** — 모든 제거는 해당 메시지의
   관찰 가능한 `failed` 전이를 동반한다 (wrapper `held[]` 포함 — R1-F3).
3. 모든 pending message가 `accepted`/`completed`/`failed` 중 하나로 귀결되거나,
   귀결되지 못하는 잔여 창이 **문서화된 복구 레인**으로 닫힌다 (§5 레인 표).
4. UI가 `sent`와 `accepted`를 혼동하지 않는다 (`delivered` 명칭 제거).

### 상태 모델 (P0.md 목표 상태)

```text
queued -> sent -> accepted -> completed
   |        |         |
   └────────┴─────────┴──> failed(reason, retryable)   # accepted 이후는 turn-failed만
```

- `queued`: 로컬 보관, 아직 socket 기록 실패/미도달 (pre-key outboundQueue, P1-9 hold,
  publish 실패 후 재시도 대기).
- `sent`: NATS publish를 socket에 기록함. plugin 수락 아님.
- `accepted`: plugin ingress가 admission함 (P0-7b `ack`).
- `completed`: turn이 **오류 없이** settle됨 — **명시적 `outcome === "ok"`에서만**
  (부재 = legacy plugin → `accepted` 잔류; §1 wire 절의 규범이 유일한 정의).
- `failed`: 자동 진행 없음; `reason`(+cause) / `retryable` / `lastAttemptAt` 보유.

**단조 전이(월권 금지)**: `queued < sent < accepted < completed`. `failed`는
`completed` 이전 어느 상태에서든 진입 가능한 terminal; `failed`/`completed` 이후
어떤 전이도 금지. 가드는 **저수준 tracker가 권위적으로** 수행한다 (R1-F5 — wrapper가
수선하는 게 아니라 tracker가 유효 전이만 발화).

### Wire 변경 — additive 1건 (R1-F1)

현재 `turn_settled`는 `inbound.ts:441-448`의 **finally에서 무조건** 발화된다 — 턴이
throw해도 발화되므로 "settle됨 = 성공"이 아니다. v1의 "wire 변경 없음" 주장은 이래서
성립 불가. 개정:

- `turn_settled` frame에 **optional `outcome?: "ok" | "error"`** 추가 (additive —
  구 클라이언트는 무시). protocol version bump 없음 (11/4 frame 수 불변, 필드
  추가만). 봉인 영향 없음 — frame 전체가 암호화되고 AAD는 라우팅 전용
  (`e2e-crypto-browser.ts:210-223/274-288`; R2 검증) — 단 §7 T-sl로 핀.
- plugin(신판): **항상 명시적으로 stamp** — catch 경로 통과 시 `outcome:"error"`,
  정상 resolve는 `outcome:"ok"` (생략 금지). clean-resolve-무final 케이스(abort vs
  silent completion 구분 불가 — `inbound.ts:388-401`의 기존 판정)는 오늘의 의미대로
  `"ok"`.
- client: `completed` 승격은 **명시적 `outcome:"ok"`에서만** (R2-1 BLOCKER fold —
  v2의 "부재 = ok" 규칙은 구 플러그인이 실패 턴에도 finally에서 무조건 보내는
  outcome-부재 frame을 `completed`로 오인시켰다). `outcome:"error"` → anchor 메시지
  `failed{reason:"turn-failed", retryable:true}`. **outcome 부재 = legacy plugin**:
  typing/working 등 UI settle은 기존대로 수행하되 메시지 상태는 `accepted` 잔류
  (구 플러그인 상대로는 `completed`가 아예 나타나지 않는 정직한 성능 저하 — JSDoc
  명시). 혼용 페어링 테스트 §7 T-mv.

**Coalesce anchor 계약 (명시)**: P1-8b coalesce는 배치를 ONE turn으로 합치고 turn
anchor는 **마지막 frame의 id**다. 따라서 `completed`/`turn-failed`는 anchor 메시지
(wireId == turnId)에만 적용되고, 같은 턴에 합쳐진 선행 메시지는 `accepted`에
종착한다 — admission까지는 보장, 그 이후는 턴 단위 관찰이라는 정직한 계약. JSDoc +
README에 명시하고 테스트로 고정 (§7 T-co).

## 2. Scope

IN: plugin outbound facade/message-adapter/draft-finalize 정직화, `turn_settled`
outcome, ack/터미널 프레임 송신 실패의 계약 명시, client 저수준 publish 실패
표면화 + liveness, client 송신 상태 tracker(권위적 단조 가드) + `onSendState`,
wrapper receipt 핸들 + `ChatMessage.sendState` + `delivered` 제거 + held/terminal
처리, 테스트(§7 매트릭스), 문서/CHANGELOG, CI baseline.

OUT (명시적 제외):

- Disk-backed durable queue — §6 내구성 경계 문서화로 갈음 (P0.md가 명시 허용).
- Inbound 방향 손실(pre-key `pendingInbound` drop 등) — 송신 계약 밖; register-시
  snapshot 재수화가 복구 레인 (기존 설계 유지).
- Approval **delivery**(agent→browser) — 이미 정직 + #15 snapshot 복구 레인
  (`approvals.ts:788-810`).
- `approval_decision`(browser→agent) 실패의 새 UI — #15 Leg C reconciler가 복구.
  §5 레인 표에 매핑만 기록.
- P1-9 `retracted` **버블 표현** — 이미 관찰 가능한 terminal (사용자 의도적 취소 ≠
  실패); terminal fail-all은 retracted 버블을 **보존**한다 (R1-F3). 단 **receipt**
  차원에서는 취소도 terminal 귀결이 필요하므로(R3-4) `/stop` hold-회수와
  `retract()`는 해당 receipt를 `failed{reason:"cancelled", retryable:false}`로
  종결한다 — 버블 렌더(`retracted`/삭제)와 receipt 수명은 분리 (D5).
- Proactive/outbound 라우팅 개선(P2-2).

## 3. False-success / silent-loss 인벤토리 (이 브랜치 file:line 검증; R1 확장)

### Plugin (packages/plugin)

| # | 위치 | 현재 동작 | 처리 |
|---|---|---|---|
| A1 | `src/channel.ts:198-201` (`outbound.attachedResults.sendText`) | boolean 무시, 합성 `messageId` 반환 | Stage 4: 실패 시 throw (D1) |
| A2 | `src/message-adapter.ts:104-115` (`message.send.text`) | 동일 — fabricated receipt | Stage 4: throw (D1) |
| A3 | `src/message-adapter.ts:370-397` (`finalize`) → `inbound.ts:373-376` | `finalizeDraft` boolean 무시; `visibleReplySent:true` 보고 | Stage 4: boolean 전파 (D2) |
| A4 | `index-nats.ts:774-780` (allowlist hedge) | boolean 무시 (주석에 best-effort 명시) | 존치 — feedback-only, 성공 조작 없음 |
| A5 | **ack 송신 실패 3개소** (R1-F6): `src/ingress-dedupe.ts:224` (admit), `:288` (cancelled), `index-nats.ts:747` (control-lane) | `sendAck` false 무시 | warn 추가 + **at-least-once 레인 계약** (§5 L2) — plugin 재시도 없음, client 재등록 replay→dedupe→재ack가 닫음. **control-lane(:747)도 boolean 검사+warn 의무** (R4-3) — `/stop` frame ack의 replay 레인은 통상과 동일(재진입 /stop은 무해한 no-op abort + 재ack), fallback set 비관여. 테스트 §7 T-a5s. **cancel 경로는 이중 실패 창 별도 처리** (A5c) |
| A5c | **cancel 경로 이중 실패** (R2-2): `ingress-dedupe.ts:274-276` (tombstone 기록 실패 swallow) + `:288` (ack도 실패) 동시 발생 | replay가 fresh로 오인되어 `/stop`이 죽인 텍스트가 실행될 수 있음 | **fallback tombstone 알고리즘 (R3-2/R3-3 구체화)**: ① `sendAck` 의존성 시그니처를 `boolean` 반환으로 변경 (`IngressOnFlushDeps.sendAck`·`recordCancelledInboundItems`의 콜백 — 현재 `void`라 재ack 성공 판정 불가); ② fallback set은 **per-account 수명 객체**(채널 클로저 안 — 계정 간 충돌 불가), 키는 `${peerId}:${id}`, 기존 128자/non-empty-string 정규화(`:38-48`) 재사용, cap(예: 256) + 초과 시 최고령 evict+warn; 수명은 **per-account 채널 클로저 스코프 그 자체** (R4-4 정정 — 현행 런타임(`index-nats.ts:1039-1055`)에 명시적 channel-dispose 훅이 없으므로 별도 clear 훅을 발명하지 않는다; 세트가 persistent-dedupe 인스턴스와 같은 클로저에 살면 계정 teardown과 함께 GC되는 것이 정확한 수명이다. 테스트는 dispose 대신 두-계정 격리로 검증); ③ 기록 실패 시에만 세트에 등록; ④ `createIngressOnFlush`는 **기존 ack/dedupe보다 먼저** 세트를 조회 — 적중 항목은 드롭 + 기록 재시도 + 재ack, **둘 다 성공했을 때만** 세트에서 제거. 프로세스 생존 중 창 폐쇄; 재시작 유실은 기존 at-most-once tradeoff 문서(:21-35)에 합류. 테스트 §7 T-a5c |
| A6 | **turn-terminal 프레임 실패** (R1-F7): `inbound.ts:433-439` (error-fallback sendText), `:447` (`sendTurnSettled`) | boolean 무시 | warn 추가 + 계약 명시: 실패해도 성공 조작 없음 — client는 `accepted`에 정직하게 잔류, 복구는 §5 L3 |

`nats-channel.ts:605-639` `sendToPeer` 자체는 정직 (not-connected/no-key/throw 전부
false). `inbound.ts:378-380` plain-send deliver도 정직.

### Client (packages/client)

| # | 위치 | 현재 동작 | 처리 |
|---|---|---|---|
| B1 | `src/nats-client.ts:329-333` (`NatsClient.publish`) | not-connected → warn+무음; `ws.send` throw는 caller로 누출(아무도 안 잡음) | Stage 1: `boolean` 반환 + send-throw 시 `forceReconnect()` (D3) |
| B2 | `src/nats-client.ts:978-986` (`disconnect()`) | `unackedLedger.clear()`만; `outboundQueue`는 dead instance 잔류 | Stage 2: fail-all 후 양쪽 clear (D4) |
| B3 | `src/nats-client.ts:1364-1380` (eviction, MAX_UNACKED=100) | console-only | Stage 2: `failed{evicted}` 전이 (D4) |
| B4 | terminal error 시 `outboundQueue`/`unackedLedger` + **wrapper `held[]`** (`nats-client-wrapper.ts:82,:257` — wire id 없는 로컬 보관, R1-F3) | 반영구 잔류 | Stage 2 (queue/ledger) + Stage 3 (held — wrapper 소관, D5) |
| B5 | 공개 API: `sendUserMessage → string`(`:993`), wrapper `send(): void`(`:224`), `ChatMessage.delivered?`(`types.ts:37`) | 상태 핸들 없음 | Stage 2–3: `onSendState` + receipt 핸들 (D4, D5) |

## 4. Design decisions

### D1. Plugin outbound 정직화 — throw (A1, A2) [Stage 0 게이트]

`sendText` 실패(`!ctx.to` 포함)는 `Error`를 throw한다. `OutboundDeliveryResult`/
`ChannelMessageSendResult`에 실패 표현 필드가 없으므로 반환값 조작 제거의 유일한
형태. 에러 메시지는 **absent `ctx.to` vs targeted-send false를 구분**해 담는다.

**STAGE 0 (선행 게이트, R1-F13)**: pinned `openclaw` dist에서 core가 outbound
`sendText`/`message.send.text`의 reject를 어떻게 처리하는지(턴 실패 기록? 재시도로
인한 중복 전달? crash?) 실증한 뒤에만 Stage 4 착수. **검증 결과는 이 절에 추기하고
그 결과가 throw를 기각하면 계획을 리뷰로 회귀시킨다** — Stage 4는 결과 확정 전
placeholder가 아니라 미승인 상태다.

> **Stage 0 결과 (검증 완료 — throw 승인)**: pinned dist 추적 결과, throw는 SDK의
> 관용 계약이다. 근거(경로는 `node_modules/openclaw/dist/` 하위):
> - 두 seam 모두 공유 송신 루프 `deliverOutboundPayloadsCore`(`deliver-BPqL55uX.js:964`)
>   로 수렴; per-payload try/catch가 실패를 기록하고 non-bestEffort면
>   `OutboundDeliveryError` throw(`deliver-BPqL55uX.js:1378`) → 상위 `ctx.send`가
>   catch(`send-CvCeIf4E.js:107`)해 `{status:"failed"|"partial_failed"}` 결과로 변환.
>   re-throw 없음, gateway 크래시 없음.
> - **재시도/백오프/재큐 0건** (delivery 번들 전수 grep — `retry|backoff|maxAttempts|
>   requeue|redeliver` 무매치) + `message.send.text` 실패 시 `outbound.sendText`로
>   가는 fallback 체인 **부재** → throw로 인한 위젯 중복 전달 불가능.
> - 내장 채널(Signal `channel-Bk1NrcjC.js`, Google Chat)의 `sendText`가 이미 네트워크
>   실패에 throw — 프로덕션에서 검증된 계약.
> - turn-reply 경로(`delivery.deliver`)의 throw는 core dispatch catch가
>   `markIdle("message_error")`로 busy 게이트를 해제한 뒤 plugin의 `inbound.ts:412`
>   catch로 전파 — 세션 웨지 없음. `visibleReplySent:false`도 fence 미전진으로
>   무해(D2의 boolean 전파 설계 그대로 유효; `dispatch-B2e1grFo.js:2135`).
> - **인코딩할 캐빗 2건**: ① turn reply는 D2대로 deliver-경로 boolean 유지, throw는
>   A1/A2(core-initiated) seam에만; ② `bestEffort:true` 경로에선 throw가 `onError`로
>   삼켜진다 — webchannel 경로에 bestEffort 부재를 Stage 4에서 어써션(테스트 또는
>   dist-grep 게이트)으로 고정해야 실패가 core에 관찰 가능함이 보장된다.

### D2. Draft finalize 전파 (A3) + 터미널 프레임 계약 (A6)

- `ProgressDraftController.finalize(text): Promise<boolean>` — **첫 시도의 결과를
  캐시하고 이후 호출은 캐시를 반환** (R1-F8). false 후 재시도 없음 — 실패는 소켓/키
  붕괴를 뜻하고, 복구는 reconnect + register snapshot 재수화(§5 L3)다. 두 번째
  호출이 `undefined`를 반환하는 계약 위반 금지. 동시 이중 호출/false/flush-throw
  테스트 고정 (§7 T-fz).
- `inbound.ts` deliver: draft+`kind:"final"` 경로의 `visibleReplySent`를 finalize
  boolean으로 보고; `finalReplyDelivered`도 동일.
- A6: error-fallback sendText와 sendTurnSettled에 실패 warn 추가. 이들은 성공을
  조작하지 않는 부가 통지 — client 측 관찰은 §5 L3이 정직하게 처리.

### D3. Client 저수준 publish 표면화 + liveness (B1) [R1-F2]

`NatsClient.publish(): boolean`:
- not-connected → `false` (기존 warn 유지).
- `ws.send` throw → catch, `false`, **그리고 `forceReconnect()` 호출** — 동기
  send-throw는 onclose를 보장하지 않으므로(half-open) 강제 teardown이 없으면 살아
  있는 프로세스에서 영구 `queued`가 된다. `forceReconnect` → 재연결 → `onConnected`
  → 재등록 → `flushQueue()` replay가 liveness를 닫는다. (heartbeat `startHeartbeat`
  의 PING-throw가 이미 같은 수법을 쓴다 — `:755-759`; 같은 seam이 P1-3 브랜치에도
  존재.)
- **재연결 스케줄 세대 가드 (R2b-2 fold)**: `forceReconnect`는 teardown → 상태
  리스너 통지(`:786`) → `scheduleReconnect()`(`:787`) 순서라, 통지 중 리스너가
  동기적으로 `disconnect()`를 부르면(타이머 clear, `:312-326`) 제어가 돌아온 뒤
  reconnect가 **그래도 스케줄되어 명시적으로 닫은 연결을 되살린다**. D3가
  `publish()`에서 forceReconnect를 부르게 되면서 이 표면이 실제로 도달 가능해짐.
  픽스: 라이프사이클 세대 카운터 — `disconnect()`가 세대를 올리고, forceReconnect는
  통지 전 세대를 캡처해 통지 후 세대 불변 + 미폐쇄일 때만 스케줄. 테스트: 상태
  리스너가 동기 `disconnect()` ⇒ 재연결 타이머 0개.

`seal()` 소비:
- `user_message`: ledger 선기록(기존) → publish 실패 시 ledger 잔류 + 상태 `queued`
  유지(재시도 예정 — false-success 아님). forceReconnect가 replay를 견인.
- 비복제 프레임(`approval_decision`/`load_*`): 실패 시 warn; 복구는 §5 레인.

### D4. 권위적 송신 상태 tracker — `WebChannelNatsClient` (B2–B5)

wire id → 상태 + `lastAttemptAt`(publish 시도마다 갱신, R1-F10)의 단일 tracker.
**tracker가 단조 가드의 권위** (R1-F5): 유효 전이만 리스너에 발화하고, 무효
입력(중복 ack, eviction 후 ack, failed 후 후행 이벤트)은 no-op.

```ts
export type SendState = "queued" | "sent" | "accepted" | "failed";
export type SendFailure = {
  reason: "closed" | "evicted" | "terminal" | "turn-failed" | "cancelled";
  /** reason === "terminal"일 때 기존 분류 재사용 (R1-F9 — 붕괴 금지) */
  cause?: WebChannelErrorCause;
  retryable: boolean;
  lastAttemptAt?: number;
};
// "cancelled" (R4-1): 사용자 의도적 취소(/stop hold-회수, retract()) — wrapper
// 레이어에서만 발생, retryable: false. 단조 가드 테스트(T-mg)와 T-rc(b)에 포함.
onSendState(listener: (id: string, state: SendState, failure?: SendFailure) => void): () => void
```

전이 지점 (전부 기존 choke point):
- `sendUserMessage` → tracker 기록+큐 삽입을 **먼저 커밋한 뒤** `queued` 발화
  (R1-F4 — mutate-before-notify; 아래 공통 규칙).
- `seal()` publish 성공 → `sent` (+`lastAttemptAt`). 실패 → `queued` 유지(무발화).
- `drainAcked` → **tracker에 pending으로 존재하는 id만** `accepted` 발화; unknown/
  중복/evicted id는 no-op (R1-F5).
- eviction → `failed{evicted, retryable:true}`.
- `disconnect()` → queue+ledger의 user_message 전원
  `failed{closed, retryable:false}` → **양쪽 모두 clear** (B2).
- CL2 terminal (`onError` 경유) → 전원 `failed{terminal, cause, retryable: false}`
  — cause는 기존 `WebChannelErrorCause` 그대로 전달 (`auth-expired`/`auth-rejected`/
  `protocol-mismatch`/`secure-channel-failed`/`config`/`server`/`unknown`).
  receipt `retryable`은 "이 terminal outcome 뒤 caller/embedder가 새 send 시도를
  시작해도 되는가"로 정의(JSDoc 명시). failed receipt 자체는 다시 진행되지 않고
  자동 재시도되지 않는다. `evicted`/`turn-failed`만 true이고 `closed`/`terminal`/
  `cancelled`는 false다. 실제 재시도 전 현재 인스턴스 readiness를 별도로 확인해야
  하며 terminal 회복은 fresh credential의 새 client instance가 필요하다.

**Terminal 시퀀스 계약 (R2b-1 BLOCKER fold)**: 에러 리스너는 동기이고 리스너 체인
안에서 `send()`가 다시 불릴 수 있다 (wrapper 자신의 fail-all 리스너 뒤에 다른
리스너가 send — `nats-client-wrapper.ts:295-303` 경로). 현재 순서(통지 후 정리,
P1-3판은 `notifyErrorListeners`가 disconnect보다 먼저 — P1-3판 `:1331-1337`)로는
통지 중 진입한 신규 메시지가 terminal sweep을 **탈출**해 dead instance에 영구
잔류한다. 의무 순서:
  ① tracker/client에 terminal 마킹 — 이후 도착하는 모든 신규 send는 큐/ledger에
     넣지 않고 **즉시 `failed{terminal, cause}` receipt**로 귀결 (reject-throw가
     아니라 관찰 가능한 failed — 계약 일관);
  ② 게이트 하에서 pending fail-all (queue+ledger sweep);
  ③ 리스너 통지 (wrapper는 자신의 onError에서 같은 순서로 자체 terminal 마킹 →
     held fail-all → 상태 발화);
  ④ socket teardown.
  테스트 §7 T-re 확장: 통지 중 재진입 send ⇒ 즉시 failed, sweep 탈출 0.

**Wrapper 커밋 순서 (R4-2 fold)**: 현행 wrapper는 직접 publish와 held release 모두
`sendUserMessage()`를 **버블 생성/patch보다 먼저** 부른다
(`nats-client-wrapper.ts:295-303`, `:353-362`) — post-terminal send의 즉시-failed
동기 발화가 receipt 레코드/alias 등록 이전에 일어나 wrapper가 실패를 놓친다.
개정 (R5-1 재설계 — 임의 id 수용 금지): ① **one-shot 예약 seam, 패키지 내부**:
`WebChannelNatsClient.reserveWireId(): string` — `randomInboxToken`으로 mint
(non-empty·≤128자 **구성상 보장**, 임의 문자열 유입 경로 없음), **유일성 보장
(R6-1)**: 후보가 `reservedWireIds`·tracker·queue·ledger 어디에도 없을 때까지
재생성, 유계 시도(8회) 소진 시 **wrapper 레코드 생성 이전에** throw (RNG 결함
스텁 환경에서 고아 receipt가 만들어질 수 없음). 성공 시 `reservedWireIds` set에
등록. `WebChannelNatsClient`는 barrel(`index.ts`) 비노출
(검증: export 없음)이므로 공개 API가 아니다 — `@internal` JSDoc 명시. ②
`sendUserMessage(text, reservedId?)`: `reservedId`는 **예약 set에 존재하고
tracker/queue/ledger 어디에도 없는 경우에만** 소비(set에서 제거) — 위반은
**throw** (프로그래머 오류; receipt 조작이 아님). 미예약 임의 id는 어떤 경로로도
수용 불가 → ledger `Map` 덮어쓰기(`:1364-1369`)·>128자 dedupe 우회
(`ingress-dedupe.ts:101-118`)·replay 오분류가 표현 불가능해진다. ③ wrapper 커밋
순서: `reserveWireId()` → (버블+receipt 레코드 생성, alias 등록) →
`sendUserMessage(text, id)` — 동기 발화되는 `queued`/즉시-`failed` 전이가 항상
등록된 alias에 안착; 직접 send와 held release 양쪽 동일. T-re에 두 경로의 반환
receipt snapshot·콜백 열 명시 (§7); 적대 테스트 §7 T-id.

**공통 규칙 (R1-F4)**: 모든 전이는 내부 자료구조(큐/ledger/tracker) 변이를 완료한
후에만 리스너를 호출한다. 재진입(리스너가 `disconnect()`/`send()`/`retract()` 호출)
테스트로 고정 (§7 T-re).

`completed`/`turn-failed`는 wrapper 소관 (turn 상관은 상위 개념, D5). 비-user_message
프레임은 receipt 비대상 (§5 레인).

### D5. Wrapper: receipt 핸들 + 공개 상태 (B5, R1-F3/F10/F14)

- **`send(text): SendReceipt | undefined`** (기존 caller와 소스 호환 — 반환 무시
  가능). **빈 입력 계약 (R2b-3)**: trim 후 빈 문자열은 현행
  early-return(`nats-client-wrapper.ts:224-226` 인접)을 유지하며 `undefined` 반환 —
  tracker/스토어 무변이 (fabricated receipt 금지 원칙과 일관). `/stop` 등
  control-lane 텍스트는 실제 발행되는 사용자 메시지이므로 정상 receipt 반환.
  테스트 핀: `send("  ")` ⇒ `undefined` + 상태 무변이. Receipt 형태:
  ```ts
  export type SendReceipt = {
    /** 불변 receipt key — history adoption/release를 가로질러 유효 */
    readonly id: string;
    snapshot(): { state: ChatMessage["sendState"]; failure?: SendFailure };
    subscribe(cb: (s: ReturnType<SendReceipt["snapshot"]>) => void): () => void;
  };
  ```
  store 위에 구현(상태 이중화 없음 — snapshot/subscribe는 스토어 조회의 얇은 뷰).
  P0.md 공개 API 권고(stable id + state handle + reason/retryable/lastAttemptAt)를
  이걸로 충족 (R1-F10). **식별 설계 (R2-3)**: v2의 "매핑이 따라간다"는 서술만으론
  구현 불가 — adoption이 버블의 공개 `id`를 제자리 덮어쓰고(`nats-client-wrapper.ts:688,:691`)
  옛 id의 alias를 남기지 않으며(:693), held 버블은 release 시점에야 wireId를 얻는
  2단 전이(:258→:353-362)가 있다. 따라서 버블에 **불변 내부 `receiptKey`**(비렌더
  필드)를 부여하고 adoption/release는 이 키를 절대 덮어쓰지 않는다; receipt와
  tracker 연동은 이 키로만 조회하고 wireId/서버 id는 가변 alias다.
  **receipt 레코드는 렌더 버블과 독립 (R3-4)**: `retract()`가 버블을 스토어에서
  제거해도 receipt 레코드는 남아 `failed{cancelled}` terminal을 보고한다 —
  snapshot이 영원히 `queued`로 남거나 backing을 잃는 경우는 존재하지 않는다.
  `/stop` hold-회수(§2 OUT 참조)도 동일하게 receipt를 `failed{cancelled}`로 종결.
- `ChatMessage`: `delivered?: boolean` **삭제**, 대체
  `sendState?: "queued"|"sent"|"accepted"|"completed"|"failed"` +
  `sendFailure?: SendFailure`. user-role 전용. P1-9 `pending:true`는 유지
  (`sendState:"queued"`의 부분집합).
  - **소비자 인벤토리 (R1-F14 정정)**: `.delivered` 소비자는
    `nats-client-wrapper.ts:801`(reducer), `nats-client-wrapper.test.ts:951` 등
    테스트, `types.ts:37` 선언뿐. **example 위젯은 delivered를 렌더하지 않는다**
    (`examples/webchannel-app/web/app.ts:184` — text만). 따라서 위젯 작업은
    "개명"이 아니라 **신규 최소 상태 UI**: `failed` 버블에 ⚠+reason title,
    `accepted|completed`에 ✓. BREAKING 처리: 외부 소비자는 이 repo에서 관측
    불가하므로 CHANGELOG breaking note + 마이그레이션 표(`delivered === true` ↔
    `sendState === "accepted"|"completed"`) + lockstep 버전. 호환 getter는 두지
    않는다 — 근거: `ChatMessage`는 plain object라 getter 유지가 어색하고, 이중
    필드는 §1 invariant 4의 명칭 제거 취지를 흐린다. (R1-F14의 getter 제안은
    검토 후 기각 — 완화 가치 < 이중 표현 비용. 리뷰 재반박 환영.)
- 전이 소스: `onSendState`(D4) → wireId 매칭 버블 patch; `turn_settled` reducer에서
  **명시적 `outcome === "ok"`만** → anchor 버블(turnId==wireId)
  `accepted→completed` 승격 (부재 = legacy → 승격 없음, UI settle만 — §1 규범),
  `"error"` → `failed{turn-failed, retryable:true}`. ack 유실 후 `turn_settled`가
  먼저 오면 바로 `completed`(단조 상향은 허용 — 상위 상태 우선; 후행 ack no-op).
- **held/terminal (R1-F3)**: wrapper가 로컬 보관분의 terminal 처리를 소유한다.
  `close()`와 terminal error(status `"error"` 진입) 시: `held[]` 전 항목 →
  `sendState:"failed"` + `sendFailure{reason: closed|terminal, cause}` patch,
  `held[]` clear (더 이상 release 불가); `retracted` 버블은 불변 보존. pending
  큐/ledger 분과 held 분을 각각 어서션 (§7 T-tm).
- demo/example 위젯: 위 신규 최소 상태 UI만.

### D6. `accepted`의 의미와 잔여 창 (R1-F6 재반영)

`accepted`는 **admission** ack이다 — 중복 frame도 ack되고(원본 admitted),
`/stop`으로 debounce 창에서 살해된 메시지도 ack된다(`recordCancelledInboundItems`).
후자는 turn이 없으므로 `accepted` 종착이 **정확한 관찰**이다. ack frame 자체의
송신 실패(A5)는 client를 `sent`에 정직하게 잔류시키며, 다음 세션 재수립 시 ledger
replay → 서버 dedupe → **재ack**로 닫힌다 (at-least-once; §5 L2). "연결은 살아
있는데 plugin 쪽 ack만 실패"한 창은 client의 다음 재연결까지 `sent`로 남는다 —
이 잔여 창과 복구 레인을 JSDoc에 명시하고 테스트로 고정 (§7 T-a5).

## 5. 복구 레인 표 (귀결 불가 창의 문서화 — invariant 3)

| # | 창 | 레인 | 관찰 |
|---|---|---|---|
| L1 | `user_message` publish 실패/유실 | ledger replay (P0-7b) + D3 forceReconnect | `queued`→재시도→`sent`→… |
| L2 | plugin ack 송신 실패 (A5) | client 재등록 replay → dedupe → 재ack | `sent` 잔류 → 재연결 후 `accepted` |
| L2c | cancel 경로 이중 실패 (A5c) | in-memory fallback tombstone set → 재기록+재ack | killed text 미실행 (프로세스 생존 중) |
| L3 | `turn_settled`/final frame 송신 실패 (A6) | client는 `accepted` 정직 잔류; 재등록 시 history snapshot이 실제 답변/전사 재수화 | false-completed 없음 |
| L4 | `approval_decision` 유실 | #15 Leg C reconciler 재송신 | 기존 |
| L5 | `load_history`/`load_commands` 유실 | 재조회 가능 + register 재수화 | 손실 무의미 |
| L6 | inbound frame 유실 | register snapshot 재수화 | 기존 |

## 6. 내구성 경계

디스크 큐 없음. 페이지/프로세스 종료 시 `queued`/`sent`(un-acked) 상태는 소멸한다.
`types.ts` JSDoc(`sendState`)과 패키지 README에 명시. 살아 있는 동안의 계약(§1)과
문구 분리.

## 7. Tests (P0.md §필요한 테스트 → 시퀀스/금지 전이/횟수 명시, R1-F11)

표기: `[입력 시퀀스] ⇒ 관찰 전이열 (terminal)`. 모든 테스트는 금지 전이
(`completed→*`, `failed→*`, 중복 발화) 부재와 전이 **횟수**까지 어써션한다.

| ID | 시나리오 | 시퀀스 ⇒ 전이열 |
|---|---|---|
| T-hp | happy path `completed` | connect+register → send → ack → turn_settled(ok) ⇒ `queued,sent,accepted,completed` (각 1회) |
| T-d1 | pre-connect send | send → connect+register → ack ⇒ `queued,sent,accepted` — terminal은 후속 turn_settled로 `completed` |
| T-d2 | publish 창 disconnect (R1-F2) | sessionKey 有 + `ws.send` throw 주입, **close 이벤트 없음** → forceReconnect 자동 → 재register → replay → ack ⇒ `queued`(잔류),`sent`,`accepted`; 금지: throw 시점 `sent` 발화. **변형 (R2-5)**: 3건 flush 중 2번째 send가 throw ⇒ 1번째 `sent`, 2·3번째 `queued` 잔류 + FIFO 순서 보존 재전송 (flushQueue 잔여 재큐 `:1338-1347` 검증) |
| T-rp | ACK 전 reconnect + duplicate retry | send → sent → drop(pre-ack) → reconnect → replay(같은 id) → ack ⇒ `accepted` 정확히 1회 (중복 전이 0) |
| T-ev | unacked cap | 101개 send ⇒ 최고령 id `failed{evicted,retryable:true}` 1회 + 기존 warn 1회 |
| T-cl | explicit close | pending(큐 1 + un-acked 1 + held 1) 상태에서 wrapper `close()` ⇒ 세 분류 모두 `failed{closed}`; 큐/ledger/held 비워짐; retracted 버블 불변 (R1-F3) |
| T-tm | terminal 전원(全源) | CL2 각 진입점(auth-expired/auth-rejected/protocol-mismatch/secure-channel-failed/server) 주입 ⇒ pending 전원 `failed{terminal, cause=각각}` (R1-F9) — cause별 5케이스 |
| T-re | 재진입 안전 (R1-F4) | `queued`/`failed` 리스너 안에서 `disconnect()`/`send()`/`retract()` 호출 ⇒ 상태 정합(유실/이중 발화 없음); **terminal held-드레인 중 재진입**(리스너가 held fail-all 도중 `send()`) 포함 (R2-5) |
| T-mg | 단조 가드 (R1-F5) | (a) ack 후 중복 ack, (b) eviction 후 ack, (c) failed 후 turn_settled, (d) completed 후 fail-all ⇒ 전부 no-op |
| T-a5 | ack 송신 실패 (A5) | plugin `sendAck` false(연결 유지) ⇒ client `sent` 잔류; 이후 재연결 → replay → dedupe drop + 재ack ⇒ `accepted` (§5 L2 실증) |
| T-tf | turn 실패 | send → ack → turn throw → `turn_settled{outcome:"error"}` ⇒ `accepted` 후 `failed{turn-failed,retryable:true}` (R1-F1; §6 v1의 "no turn_settled" 가정 폐기) |
| T-st | /stop-killed | send(debounce 창) → /stop → cancelled-ack ⇒ `accepted` 종착 (turn_settled 없음; completed 금지) |
| T-co | coalesce anchor | 버스트 3건 → 1 turn ⇒ anchor만 `completed`, 선행 2건 `accepted` 종착 (§1 계약) |
| T-ts | turn_settled 송신 실패 (A6) | plugin sendTurnSettled false ⇒ client `accepted` 잔류 (false-completed 없음) + plugin warn |
| T-fz | finalize 계약 (R1-F8) | (a) 이중 호출 → 두 번째가 첫 결과 캐시 반환, (b) false 첫 시도 → 재시도 없음+false 캐시, (c) flush-throw → finalizeDraft는 진행 |
| T-p4 | plugin throw (A1/A2) | `ctx.to` 부재/미등록 peer ⇒ **throw** (fabricated receipt 부재); 에러 메시지가 두 원인 구분; webchannel 송신 경로에 `bestEffort:true` 부재 어써션 (D1 캐빗 ②) |
| T-dv | deliver 전파 (A3) | finalizeDraft false ⇒ `visibleReplySent:false` |
| T-rc | receipt 핸들 (R3-5/R4-5 falsifiable화) | (a) `queued(receiptKey 발급)` → release(`wire alias 부여`) → `sent` → `accepted` → adoption(서버 id alias 교체): receipt `id` 불변; send 직후 subscribe 기준 초기 snapshot=`queued`, 콜백 열 정확히 `[sent, accepted]` (**2회**), adoption 콜백 **0회**, alias 교체 중복 콜백 0; (b) held(초기 `queued`) → `/stop` ⇒ 콜백 열 `[failed{cancelled,retryable:false}]` (**1회**), 이후 `retract()`(버블 삭제)에도 snapshot/subscribe 유효 + 추가 콜백 **0회** (R3-4); (c) 반복 snapshot 호출 무부작용; (d) adoption이 콜백 실행 중 동기 발생해도 정합 |
| T-wd | delivered 제거 | wrapper 기존 ack 테스트(:928-978) `sendState` 기준 재작성; `delivered` 참조 0 — **grep 게이트 (R2-6 + R3-6 + R4-5 결정론화)**: 식별자 사용만 잡는 정확 명령 `git grep -nE '\.delivered\b|\bdelivered\??[[:space:]]*:' -- packages examples \| grep -v 'not delivered:'` ⇒ **기대 매치 0** ("register-delivered" 등 하이픈 산문은 패턴상 비매치; 유일 allowlist = plugin warn 문자열의 `not delivered:` — `approvals.ts:793,:806` 산문); 문서는 Stage 5 마이그레이션 목록으로 별도(`docs/gaps/P0_CORE_CHAT_GAPS.md:61,:490,:498` 포함) |
| T-mv | 혼용 버전 (R2-1) | (a) 구 plugin(outcome 부재 frame) + 신 client: 실패 턴 ⇒ `accepted` 잔류(completed 금지), 성공 턴 ⇒ `accepted` 잔류 + UI settle 정상; (b) 신 plugin + 구 client: outcome 필드 무시, 기존 동작 불변 |
| T-sl | outcome 봉인 통과 핀 (R2-5) | sealed envelope 왕복 후 `turn_settled.outcome` 보존 (AAD 라우팅-전용 계약 핀) |
| T-a5c | cancel 이중 실패 (R2-2, R3-7 분리) | (a) **ack만 실패**(기록 성공): fallback set 비관여 — 통상 레인(T-a5: replay→dedupe drop→재ack)으로 폐쇄, set 멤버십 0 어써션; (b) **기록만 실패**(ack 성공): set 등록 → 다음 flush에서 선차단 드롭+재기록, 재기록·재ack 모두 성공 시에만 제거; (c) **동시 실패**: (b)와 동일 + 재ack 성공까지 잔류; +(R3-3) 두 계정 동일 peer/id 비충돌(per-account 클로저 격리 — R4-4), 128자 초과 적대 id 미등록, cap 초과 evict+warn |
| T-a5s | control-lane ack 실패 (R4-3) | `/stop` frame ack false(연결 유지) ⇒ warn 1회 + client `sent` 잔류; 재연결 → replay가 control lane 재진입(무해 no-op abort) → ack 성공 ⇒ `accepted` 정확히 1회, fallback set 멤버십 0 |
| T-id | 예약 seam 적대 (R5-1, R6-1) | (a) 미예약 id로 `sendUserMessage` ⇒ throw + 무발행·무기록; (b) 같은 예약 id 2회 소비 ⇒ 2회째 throw; (c) seal/ack 후 재사용 시도 ⇒ throw (ledger 덮어쓰기 0); (d) 예약만 하고 미사용 ⇒ 상태 무변이; (e) mint 산출물 전수 non-empty·≤128 (구성 검증); (f) **결정론 RNG 충돌**: 동일값 반복 RNG 스텁에서 예약 2건 ⇒ 서로 다른 id 반환(재생성) 또는 유계 소진 throw — 두 경우 모두 고아 receipt 0; 과거 tracker/ledger id와의 충돌 후보도 재생성됨 |

## 8. Stages

| Stage | 내용 | 패키지 | 선행 |
|---|---|---|---|
| 0 | ~~SDK 실패 계약 dist-grep 검증~~ **완료** — throw 승인 (D1 추기) | — | ✅ |
| 1 | B1: `publish → boolean` + send-throw `forceReconnect` + `seal()` 소비 (D3) | client | — |
| 2 | B2–B4(큐/ledger): 권위적 tracker + `onSendState` + fail-all/eviction (D4) | client | 1 |
| 3 | B4(held)+B5: receipt 핸들, `sendState`, `delivered` 제거, held/terminal, turn_settled outcome 소비, 위젯 상태 UI (D5) | client | 2 |
| 4 | A1–A3, A5–A6: plugin throw + finalize 전파 + outcome 발신 + warn들 (D1, D2) | plugin | 0 |
| 5 | §7 매트릭스 완주, 문서/CHANGELOG(§5, §6), CI baseline 재측정 | 전체 | 1–4 |

Stage 1–3(client)과 Stage 4(plugin)는 패키지 분리로 병렬 구현 가능. 단 T-a5/T-tf/
T-st/T-co는 양측 필요 → Stage 5.

## 9. Risks

- **P1-3 (#44) 충돌 표면 — 정직 재산정 (R1-F12)**: v1의 "publish 1건" 주장 폐기.
  실측: 두 브랜치의 `nats-client.ts` diff는 저수준(dial/parser/reconnect,
  :447-880)과 **`WebChannelNatsClient` 상부(:1140-1336 — epoch 가드
  `failConnectionEpoch`, flushQueue/seal 인접)** 에 걸친다. P0-4의 D4가 만지는
  disconnect/에러 전파/ledger 인접 영역과 겹친다. 다만 `publish` 몸통(:329-343)은
  P1-3 비접촉이고, D3의 `forceReconnect` seam은 양 브랜치 공존. 대응:
  (a) merge-order 전제 명시 — #44가 review에 먼저 머지되는 것이 기정 사실
  (P1-2가 그 위에 스택 중); P0-4는 P0-3 스택 유지(유저 결정)하되 **PR 전 review
  기준 rebase + 재조정 체크리스트**를 Stage 5 게이트로: ① epoch 가드와 tracker
  전이의 상호작용 재검토(stale continuation이 tracker에 발화하지 않게 epoch 검사
  동승), ② flushQueue replay와 P1-3의 sid-stable 재구독 순서 확인, ③ vitest 요약
  전체줄 검증(P0-2 무음 미실행 전례), ④ **P1-3 `failConnectionEpoch` 동기
  리스너-재진입 홀 (R2-4)**: P1-3판은 epoch 검사 → 리스너 통지 → 재검사 → teardown
  순서라(P1-3판 `nats-client.ts:1332-1336`), 에러 리스너가 동기적으로 `connect()`를
  부르면 아직 epoch가 안 올라간 새 연결(:1159)을 옛 continuation의 2차 검사가
  찢는다. 우리 fail-all 리스너가 정확히 그 소비자가 되므로 rebase 시 **통지 전
  epoch retire**(또는 소켓 세대 바인딩)로 고치고 composed 테스트(리스너 동기
  reconnect → 새 세대 생존) 추가. 이 버그는 P0-4와 무관하게 P1-3(#44)에 존재 —
  업스트림 보고 대상. (b) D3/D4 설계는 지금부터 P1-3판 코드도 옆에 놓고 양립형으로
  작성 (구현 브리프에 양 브랜치 발췌 동봉).
- **SDK throw 계약** — Stage 0 검증 완료(D1 추기), Stage 4 승인. 잔여 리스크는
  bestEffort-경로 어써션(D1 캐빗 ②)이 커버.
- **BREAKING `delivered` 제거** — D5의 소비자 인벤토리/마이그레이션 표 참조.
- **`accepted` 과신** — D6 + T-st/T-a5가 고정.

## 10. R1 folding log

| R1 | 심각도 | 처리 |
|---|---|---|
| F1 turn_settled≠성공 | B | §1 outcome 필드 + T-tf/T-st (수용) |
| F2 send-throw 영구 queued | B | D3 forceReconnect + T-d2 (수용) |
| F3 held[] 미커버 | B | D5 held/terminal + T-cl (수용) |
| F4 재진입 | M | D4 mutate-before-notify + T-re (수용) |
| F5 가드 위치 | M | D4 tracker 권위 + T-mg (수용) |
| F6 ack 실패 | M | A5 + D6 + §5 L2 + T-a5 (수용) |
| F7 터미널 프레임 | M | A6 + §5 L3 + T-ts (수용) |
| F8 finalize 계약 | M | D2 캐시 계약 + T-fz (수용) |
| F9 reason 붕괴 | M | D4 cause 전달 + T-tm (수용) |
| F10 receipt 핸들 | M | D5 SendReceipt + lastAttemptAt + T-rc (수용) |
| F11 테스트 매트릭스 | M | §7 전면 재작성 (수용) |
| F12 P1-3 과소평가 | M | §9 재산정 + rebase 체크리스트 (수용) |
| F13 D1 미결 | M | Stage 0 게이트 강화, 결과 추기 예정 (수용) |
| F14 delivered 인벤토리 | m | D5 정정; 호환 getter는 근거 명시 후 기각 (부분 수용) |

### R2 folding log

| R2 | 심각도 | 처리 |
|---|---|---|
| 1 outcome 부재=ok가 혼용에서 false completed 재생산 | B | §1 개정: 신 plugin 명시 stamp + client는 명시적 `"ok"`에서만 승격, 부재=legacy→`accepted` 잔류 + T-mv (수용) |
| 2 cancel 경로 이중 실패 | M | A5c + §5 L2c: in-memory fallback tombstone set + T-a5c (수용) |
| 3 receipt 식별 구현 불가 서술 | M | D5: 불변 `receiptKey` 도입, wireId/서버 id는 alias + T-rc 시퀀스 확장 (수용) |
| 4 P1-3 epoch 동기 재진입 홀 | M | §9 체크리스트 ④: 통지 전 epoch retire/세대 바인딩 + composed 테스트; #44 업스트림 보고 (수용) |
| 5 매트릭스 미핀 | M | T-mv/T-sl/T-a5c 신설, T-re/T-d2 확장 (수용) |
| 6 docs delivered 참조 + grep 범위 | m | T-wd에 범위 정의, Stage 5 마이그레이션에 `P0_CORE_CHAT_GAPS.md:61,:490,:498` (수용) |

### R2b folding log (독립 재실행; R2-1/R2-2 fold는 해소 확인됨)

| R2b | 심각도 | 처리 |
|---|---|---|
| 1 terminal fail-all 순서 — 통지 중 재진입 send가 sweep 탈출 | B | D4 Terminal 시퀀스 계약(마킹→sweep→통지→teardown; post-terminal send는 즉시 failed receipt) + T-re 확장 (수용) |
| 2 forceReconnect가 리스너의 동기 disconnect()를 무시하고 재연결 부활 | M | D3 세대 가드 (수용) |
| 3 `send("")`의 receipt 계약 공백 | M | D5 `SendReceipt \| undefined` + 무변이 핀 (수용) |

### R3 folding log

| R3 | 심각도 | 처리 |
|---|---|---|
| 1 "부재=ok" 잔존 모순 (§1 불릿·D5) | B | 두 곳 모두 명시적 `outcome === "ok"` 규범으로 통일 (수용) |
| 2 A5c 구현 불가(sendAck void·순서) | M | A5c 알고리즘 명세: `sendAck → boolean`, 세트 선조회 → 드롭 → 재기록 → 재ack → 양쪽 성공 시 제거 (수용) |
| 3 fallback set 소유권/경계/캡 | M | per-account 객체, `${peerId}:${id}` 키, 128자 정규화 재사용, cap+evict warn, dispose 시 clear (수용) |
| 4 receiptKey vs retract | M | receipt 레코드를 렌더 버블과 분리; `/stop`·`retract()` → `failed{cancelled,retryable:false}` terminal; §2 OUT 문구 정정 (수용) |
| 5 T-rc 비반증성 | M | T-rc를 상태열·콜백 횟수·alias 무중복까지 명시 (수용) |
| 6 grep word-boundary | m | `\bdelivered\b` + allowlist (수용) |
| 7 T-a5c 케이스 오배정 | m | (a) ack-only는 통상 레인/set 비관여로 분리 (수용) |

### R4 folding log

| R4 | 심각도 | 처리 |
|---|---|---|
| 1 `SendFailure.reason`에 `"cancelled"` 부재 | M | union에 추가 + 의미 주석 + T-mg/T-rc 포함 (수용) |
| 2 wrapper 커밋 순서 — publish가 버블/alias 등록보다 먼저 | M | D4에 Wrapper 커밋 순서 절: wire id 선발급(`sendUserMessage(text,{id})`) → 레코드/alias 등록 → publish; 직접 send·held release 동일 (수용) |
| 3 control-lane ack boolean 방치 가능 | M | A5에 :747 검사+warn 의무 명시 + T-a5s 신설 (수용) |
| 4 "channel dispose" 훅 부재 | m | per-account 클로저 스코프 = 수명으로 정정; 두-계정 격리 테스트로 대체 (수용) |
| 5 T-rc 콜백 수·T-wd allowlist 비결정 | m | T-rc 정확 횟수(2/1/0회) 명시; T-wd 결정론 명령+유일 allowlist(`not delivered:`) (수용) |

### R5 folding log

| R5 | 심각도 | 처리 |
|---|---|---|
| 1 임의 id 공개 수용 → ledger 덮어쓰기·dedupe 우회·replay 오분류 | M | D4 재설계: `reserveWireId()` one-shot 예약 seam(패키지 내부, barrel 비노출 검증), 미예약/재사용/기존재 id는 throw + T-id 적대 테스트 (수용) |

### 구현 라운드 노트 (impl-review R1 결정 2건)

- **T-mv(b) 대체 수용**: "신 plugin + 구 client" 시나리오는 in-repo에 구 클라이언트
  아티팩트가 없어 문자 그대로는 구성 불가. additive 필드 + zero-dep 재선언 구조가
  "구 클라이언트는 outcome을 무시"를 구조적으로 보증하고(T-sl이 봉인 통과를 핀),
  구현은 unknown-turn no-op 관용 테스트로 대체 — **미검증 호환 가정임을 여기
  명시**하고 T-mv(b) 충족을 주장하지 않는다.
- **finalize-false + turn_settled{ok} → completed 유지**: 최종 frame 전달이
  실패해도 턴이 오류 없이 settle했으면 anchor는 `completed`가 맞다 — receipt는
  사용자 메시지의 처리 운명을 추적하고, 답변 텍스트 유실의 복구는 §5 L3/L6
  (register-시 history 재수화) 레인 소관. deliver seam 주석 + client 문서에 명시.

### R6 folding log

| R6 | 심각도 | 처리 |
|---|---|---|
| 1 예약 mint 유일성 미보장 (RNG 충돌 → 고아 receipt) | M | `reserveWireId()` 재생성-until-unique(예약·tracker·queue·ledger 대조) + 유계 8회 소진 시 wrapper 레코드 생성 前 throw + T-id(f) (수용) |
