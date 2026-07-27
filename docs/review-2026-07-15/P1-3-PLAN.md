# P1-3 Implementation Plan — NATS transport correctness와 liveness

> Work item: [`P1.md`](P1.md) §"P1-3" (lines 185–283).
> Branch: `feat/p1-3-nats-transport`, based on `review` @ `895b8e0` (post P0-1/P0-2/P1-1 merge).
> Status: **v5** — codex gpt-5.6-sol 적대리뷰 R1(1B+4M+3m) → R2(1B+3M+1m) → R3(0B+2M)
> → R4(0B+2M) 반영. 구조 핵심(R2~R4): handshake 상태(파서 buffer·deadline 타이머·
> settle)를 **다이얼(소켓) 소유**로 재편 + "stale이어도 자기 정리는 항상, 공유 상태만
> identity-guard" + "동기 listener(protocol/error/state) 재진입도 epoch 전진 지점,
> reconnect 스케줄은 통지보다 먼저". 상세는 §7 Review log.
> Naming note: gap-docs(P0/P1/P2 parity backlog)의 "P1-3 reasoning"과는 무관 — 이 문서는
> 0715 전체 리뷰의 P1-3다.

## 1. Goal and invariants

NATS wire 계층(플러그인 `NatsTransport`/`NatsChannel`, 브라우저 `NatsClient`)의
correctness/liveness 결함 4축을 닫는다. 완료 조건 (P1.md):

1. **Reconnect subscription leak 0** — reconnect 후에도 caller가 쥔 구독 식별자로
   unsubscribe가 실제 live 구독을 제거한다.
2. **Parser가 byte-correct하고 memory-bounded** — multibyte(한글/emoji)/binary
   payload에서 frame 경계가 정확하고, control line/payload/**총 누적 buffer** 각각에
   명시적 상한이 있다. payload 내용이 프로토콜 라인으로 오파싱되는 desync(프로토콜
   주입)가 불가능.
3. **Silent peer가 startup/reconnect를 무기한 막지 못함** — handshake **각 단계**
   (WS open / INFO / CONNECT-서명 / 첫 PONG)에 deadline이 있고, timeout은 소켓을
   닫고 backoff로 넘긴다.
4. **Old async continuation이 새 connection state를 변경하지 못함** — 명시적
   `disconnect()`의 epoch 편입 + **transport의 NKEY 서명 연속이 교체된 소켓에
   쓰지 못함**(R1-B1).

**Wire/암호/공개 API 무변경**: NATS 프로토콜 출력 바이트, envelope/AAD, register
계약, `packages/client` barrel 시그니처 전부 그대로. 이 작업은 순수하게 "이미
말하기로 한 프로토콜을 정확하게 말하고 듣게" 만드는 것이다.

## 2. Scope

IN: `packages/plugin/src/nats-transport.ts`, `packages/plugin/src/nats-channel.ts`
(A의 소비자 검증), `packages/client/src/nats-client.ts`, 각 테스트, CHANGELOG,
CI baseline 상향.

OUT (명시 제외):
- P1-3-D의 legacy handshake post-await guard(D-2) — **P0-2가 경로째 삭제해 이미 해소**
  (`handleRaw`는 현재 await 없는 `.out` 단일 분기임을 소스로 확인).
- Established-link half-open 감지의 **agent 쪽** heartbeat — C는 connect-phase
  liveness만 다룬다. (client 쪽은 CL3로 기존재; agent 쪽은 별도 backlog.)
- 재전송/durability (P2-4), send-result 계약 (P0-4).
- `subscribeRegister()`가 sid를 버리는 것 — 채널 수명 = 계정 수명이라 unsubscribe
  대상이 아님. A의 sid-안정화로 reconnect replay도 자동 보존.

## 3. Verified current-code findings (TechLead 직접 소스 대조, `895b8e0`; codex R1 재검증 통과)

### A. Reconnect 후 unsubscribe SID 불일치 — CONFIRMED

- `nats-transport.ts:551-589` `reconnectOnce()`: `desiredSubjects`를 **subject 단위로
  dedupe**한 뒤 `subs.clear()` + `this.subscribe(subject)`로 **새 sid**를 발급한다.
- `nats-channel.ts:290-292` `registerPeer()`가 저장한 `peerId → sid`는 갱신되지 않음
  → reconnect 이후 `unregisterPeer()`(`nats-channel.ts:340-344`)는 죽은 sid로
  `UNSUB` → live 구독 잔존. 잔존 subject는 `subs`에 남아 **이후 모든 reconnect마다
  좀비로 replay**된다(누수가 자가 증식).
- 추가 결함(동일 근원): dedupe가 같은 subject의 복수 sid를 1개로 붕괴시켜, 두
  caller가 각자 sid를 쥔 경우 한쪽이 조용히 죽는다.
- 대조: client `nats-client.ts:660-666` `resubscribeAll()`은 **같은 sid를 재전송**
  하므로 이 버그가 없다.

### B. NATS byte length를 JS 문자 길이로 처리 — CONFIRMED (양쪽)

- transport `nats-transport.ts:259-264`: chunk를 `toString("utf8")`로 string 누적 →
  `:374` `this.buffer.length < byteCount + 2`, `:380` `slice(0, byteCount)` — UTF-16
  code unit 수와 UTF-8 byte 수를 혼용. 추가로 chunk 경계가 multibyte 문자를 가르면
  `toString`이 replacement char를 만들어 데이터 자체가 오염된다.
- client `nats-client.ts:468-473`: chunk별 `new TextDecoder().decode(...)` (stream
  옵션 없음 — 같은 mid-character 오염) → `:646,651` string length/slice 혼용.
- MSG 헤더 파싱도 느슨함(R1-M4): `parseInt`가 `1junk` 같은 malformed 토큰을 1로
  수용(`nats-transport.ts:369`, `nats-client.ts:642`), 토큰 수 검증 없음(4/5 이외를
  no-reply 형태로 오해석) — 잘못된 길이로 소비한 뒤에는 리셋 로직이 인지하기 전에
  스트림이 이미 desync된다.
- 결과: multibyte payload에서 경계 오프셋이 밀려 **payload 잔여 바이트가 프로토콜
  라인으로 파싱**될 수 있다. 소비자 영향: 현 wire payload는 대부분 ASCII(base64url
  envelope)라 잠복 중이지만, (i) plaintext 모드 JSON(한글) 즉시 발화, (ii) `.in`
  publish 권한을 가진 악성 peer가 multibyte+`\r\n-ERR/\r\nMSG` 조합으로 agent
  parser를 desync시켜 가짜 프로토콜 라인 주입 가능(클라이언트 쪽이면 가짜
  `-ERR authorization violation` → CL2 terminal 오작동 = 원격 DoS).
- 상한 부재: control line/payload/총 누적 buffer 모두 무한 — 거대 frame이 메모리를
  무한 점유 가능. 누적이 chunk 수신 즉시 일어나므로 상한 검사는 **concat 이전**에
  해야 한다(R1-M2).

### C. Connect/INFO/PONG timeout 없음 — CONFIRMED (양쪽)

- transport `connect()` (`nats-transport.ts:196-306`): `settle`은 PONG/-ERR/close
  에서만 호출 — WS는 열리되 아무것도 안 보내는 서버면 promise **영구 pending**.
  `reconnectOnce():559`의 `await this.connect()`가 안 풀리면 catch의
  `scheduleReconnect()`도 실행되지 않아 **reconnect 체인 전체가 무기한 정지**
  (`reconnectTimer`는 undefined로 클리어된 상태라 아무도 재시동 못 함).
- client `connectInternal()` (`nats-client.ts:437-486`): PONG이 안 오면
  `connected=false` 유지, heartbeat는 `startHeartbeat()`가 PONG 이후에만 시작
  (`:578`) → 초기/재연결 handshake 단계는 감시 공백. onclose가 안 오는 half-open
  dial이면 영구 stuck.

### C-2. Transport NKEY 서명 연속의 소켓 오염 — CONFIRMED (R1-B1; timeout 도입으로 발화 가능성 상승)

- `nats-transport.ts:604-647` `sendConnectWithJwt()`: `nkeySigningCallback` await
  이후 **mutable `this.ws`**로 send. timeout/재연결이 서명 중 소켓을 교체하면 옛
  nonce로 서명된 CONNECT가 **새 소켓**으로 나간다 → 불변식 4 위반, 인증 재연결
  파손 가능. client 쪽 `sendSignedConnect()`(`nats-client.ts:517-519`)는 pre-await
  캡처로 이미 방어됨 — transport만 구멍.

### D-1. 명시적 disconnect가 epoch를 안 올림 — CONFIRMED (피해는 잠재)

- `nats-client.ts:919,1090` `connectionEpoch`는 `onConnected()`에서만 증가.
  `disconnect()`(`:955-963`)는 불변 → disconnect 중 in-flight register 연속이
  epoch 검사를 통과해 `sessionKey` 설치 + `flushQueue()` 실행. 현재는 publish가
  not-connected no-op이라 실피해 없음(P1.md 판단 유지)이나, 방어를 epoch 규약으로
  일원화한다.

## 4. Design

### 4.1 A — sid 안정화 (API 무변경; client의 기존 규약을 transport에 이식)

- `reconnectOnce()`를 "clear + 재subscribe"에서 **entry별 verbatim replay**로 변경:
  `subs`의 각 `(sid, subject)`에 대해 새 소켓에 `SUB {subject} {sid}\r\n`를 그대로
  재전송. `subs.clear()` 삭제, dedupe 삭제(복수 sid 각자 보존 = reconnect 전
  전달 semantics와 동일), `sidCounter`는 인스턴스 수명 동안 단조 유지(기존대로).
- 계약 문서화: **sid는 transport 인스턴스 수명 동안 안정한 논리 구독 id**다
  (reconnect를 넘어 유효). P1.md의 "stable logical subscription handle"을 별도
  handle 타입 없이 달성 — `NatsChannel`/index-nats/e2e driver 등 모든 caller가
  숫자 sid를 이미 쥐고 있으므로 시그니처 churn 0.
- NATS 프로토콜 정합(codex R1 확인): sid는 client-chosen, per-connection 스코프 —
  새 소켓에 같은 sid 재사용은 적법(본 repo client가 이미 수행).
- `NatsChannel`은 무수정 — 저장된 sid가 계속 유효해지는 것으로 leak이 닫힌다.
  (검증은 채널 레벨 테스트로 — broker 쪽 상태까지 단언, §5-A.)

### 4.2 B — byte-accurate·bounded 파서 (양쪽)

공통 원칙: **누적은 bytes, 경계 탐색은 bytes, 텍스트 해석은 "완성된 단위"에만.
상한 검사는 할당(concat) 이전에. 누적 buffer는 인스턴스 공유가 아닌 다이얼(소켓)
소유** — §4.3의 소유권 원칙과 한 몸(stale 소켓 handler의 오염 차단).

- transport: `buffer: string` → `Buffer` 누적(`Buffer.concat`). chunk 정규화
  `Buffer.isBuffer(data) ? data : Buffer.from(data)`. CRLF는 `buffer.indexOf("\r\n")`
  (Buffer의 byte 탐색). control line은 `subarray(0, pos).toString("utf8")`로 해석
  (control line은 ASCII). payload는 `Buffer.from(subarray(0, byteCount))` — raw
  bytes 그대로 `NatsMessage.payload`에 전달(타입 기존과 동일 `Buffer`, 이제부터
  byte-정확·binary-safe).
- client(브라우저, Buffer 없음): `buffer: Uint8Array` 누적 + byte단위 CRLF 스캔
  헬퍼. string chunk(텍스트 frame을 보내는 서버 대비)는 `TextEncoder`로 bytes화.
  control line과 **완성된 payload byte-slice**만 `TextDecoder`로 해석 —
  `RawMessageListener(subject, payload: string)` 계약 유지(클라이언트 payload는
  envelope JSON 텍스트; 완성 단위 디코드는 multibyte-정확).
- **엄격 MSG 문법** (R1-M4): 단일 space 분리 토큰이 **정확히 4개 또는 5개**,
  subject/sid/reply 토큰 비어있지 않음, 길이 토큰은 `/^\d+$/` **전체 일치** +
  `Number.isSafeInteger` + `≤ MAX_PAYLOAD`. 하나라도 어긋나면 프로토콜 위반(아래)
  — "관대한 파싱 후 계속"은 desync를 방치하므로 전면 폐기.
- payload 뒤 2바이트가 실제 `\r\n`인지 검증 — 아니면 프로토콜 위반.
- 상한 3종 (모듈 상수, 필요시 옵션화는 리뷰에서 판단):
  - `MAX_CONTROL_LINE` 64KiB — CRLF 없이 이 이상 누적 시 위반. 근거: nats-server의
    `max_control_line` 기본 4096B, INFO(서버 메타+nonce)는 실측 ~1KiB — 16×기본의
    여유. (실서버 near-max INFO 강제 테스트는 비실용 판정 — §7.)
  - `MAX_PAYLOAD` 8MiB — MSG 헤더의 길이 토큰이 이를 넘으면 **버퍼가 차기 전에
    헤더 단계에서 선판정**. 근거: nats-server 기본 max_payload 1MiB의 8배.
  - `MAX_BUFFERED_BYTES` = MAX_CONTROL_LINE + MAX_PAYLOAD + **4** — **명시 상수**,
    chunk 수신 시 `retained + chunk.length > MAX_BUFFERED_BYTES`를 **concat 이전**에
    검사(R1-M2; 거대 단일 WS frame이 누적 buffer로 승격되기 전에 차단).
  - 경계 산술의 정밀 정의(R2-M2): `MAX_CONTROL_LINE`은 **CRLF 제외**한 라인 길이;
    CRLF 없는 누적이 이를 **초과(>)할 때만** 위반(정확히 경계값인 라인은 통과).
    최대 적법 frame = line + CRLF + payload + CRLF = MAX_CONTROL_LINE +
    MAX_PAYLOAD + 4 — 불완전-payload 대기 경로가 헤더+CRLF를 재삽입해 보관하는
    현행 방식(`nats-transport.ts:374`, `nats-client.ts:646` 상당)을 유지해도 +4
    상한 안에 정확히 들어간다(최대 적법 frame이 pre-concat 검사에서 거부되지 않음을
    경계 테스트로 못박는다).
- 프로토콜 위반의 처리 = **연결 리셋**: transport는 `emitError` + 소켓 close(기존
  close 경로가 reconnect 처리), client는 `forceReconnect()`. 위반 이후의 스트림은
  신뢰 불가이므로 리셋만이 안전.

### 4.3 C — handshake per-phase deadline + **다이얼-소유 handshake 상태** (R2 재설계)

R1-M1 수용: P1.md가 요구하는 "단계별 deadline"을 **inactivity-deadline 방식**으로
구현한다 — 타이머는 1개지만 phase 전이(WS open → INFO 수신 → CONNECT 송신 → 첫
PONG)마다 **re-arm**되므로 각 phase가 독립 예산을 갖는다. 진행 중인 handshake는
죽이지 않고, **멈춘 phase만** 죽인다. 총 상한은 자연히 ~4×budget으로 유계.

**소유권 원칙 (R2-B1·R2-M1의 구조적 해결)**: handshake 가변 상태 일체 — 파서
누적 buffer, deadline 타이머 `{timer, phase}`, `settle` — 를 **그 다이얼의 소켓이
소유**한다(`connect()` 클로저 스코프, 인스턴스 공유 필드 아님).

- **파서 buffer의 다이얼 소유化**: 현행 `this.buffer` 인스턴스 공유가 R2-B1의
  근원 — stale 소켓의 message handler가 교체 이후에도 공유 buffer에 append 가능.
  message handler 진입에서 `this.ws !== ws`면 **buffer를 건드리기 전에** drop하고,
  누적 buffer 자체를 다이얼 스코프로 옮겨 stale handler가 현행 스트림을 물리적으로
  오염할 수 없게 한다. (`NatsMessage` 전달 등 인스턴스 레벨 dispatch는 현행 소켓
  확인 후에만.)
- **타이머 소유권 규율 (R2-M1, R3-M1로 정정)**: 타이머는 arm한 다이얼만 clear할
  수 있다. 늦게 도착한 옛 소켓의 close/settle은 **자기 promise만 settle**하고 다른
  다이얼의 타이머를 절대 clear하지 않는다(공유 `this.reconnectTimer`류 필드로
  만들지 말 것). **stale 발화 ≠ no-op(R3-M1)**: 소유 deadline은 자기 소켓이 stale
  (`this.ws !== ws`)이어도 **자기 promise settle + 자기 캡처 소켓 close는 항상
  수행**한다 — 겹침 다이얼(현행 `connect()`는 이전 소켓을 닫지 않고 `this.ws`만
  교체, `nats-transport.ts:208`)에서 밀려난 다이얼의 소켓이 half-open이면 close도
  timeout도 promise를 settle해줄 주체가 없어 영구 pending이 되기 때문. identity
  guard의 대상은 **공유 인스턴스 상태 변경**(`this.ws`/`_connected` 갱신, disconnect
  emit, `scheduleReconnect`)만이다.
- transport: 옵션 `handshakeTimeoutMs`(기본 10_000, 0=비활성 — 비활성 시 타이머
  미생성 경로도 테스트) = per-phase 예산. `connect()` 진입 시 arm;
  `open`/`INFO`(JWT 모드)/`CONNECT 송신`/`PONG(settle)` 전이마다 re-arm/clear.
  발화 시 `settle(new Error("...timeout in phase <이름>..."))` + 해당 소켓 close —
  에러 메시지에 **멈춘 phase 이름**을 넣어 진단 가능하게. 초기 connect는 caller가
  reject를 받고(기존 계약), reconnect 경로는 `reconnectOnce()`의 catch →
  `scheduleReconnect()`로 **liveness 복원**(§3-C의 정지 버그가 이것으로 닫힘).
- client: 옵션 `connectTimeoutMs`(기본 10_000, 0=비활성), 동일한 re-arm 방식과
  동일한 소유권 규율(open → INFO[NKEY 모드] → CONNECT 송신 → 첫 PONG). 발화 시
  `forceReconnect()`(backoff 재스케줄 포함, terminal이면 no-op). CL3 heartbeat가
  established 이후를 덮고, 이 deadline이 handshake 공백을 덮어 전 구간 감시 완성.
- **R1-B1 수정(§3-C-2), R2-B1로 강화**: transport `sendConnectWithJwt()`에 **발신
  소켓 규율** 적용 — INFO를 낳은 소켓 `ws`를 message-handler 클로저의 **lexical
  참조**로 `drainBuffer`→`sendConnectWithJwt`까지 스레딩("진입 시 `this.ws` 캡처"
  대안은 **금지** — stale handler가 흘린 INFO에 대해 새 소켓을 캡처해 옛 nonce
  서명을 새 소켓에 보내는 R2-B1 시나리오가 남는다). `nkeySigningCallback` await
  **이후** `this.ws === ws && ws.readyState === OPEN`일 때만 send; 아니면 조용히
  bail(그 소켓의 settle은 timeout/close가 처리). client `sendSignedConnect`도
  lexical 캡처(기존재)에 post-await 현행성 검사를 추가해 대칭화.

### 4.4 D-1 — disconnect의 epoch 편입 (+ unwrap 거부 연속의 epoch 검사, R2-M3)

- `WebChannelNatsClient.disconnect()` 첫 줄에 `this.connectionEpoch++`. in-flight
  `onConnected` 연속은 다음 epoch 검사에서 bail.
- **R2-M3**: `unwrapConversationKey` await의 **거부(catch) 경로**(`nats-client.ts:1245`
  부근)는 현재 epoch 검사 없이 `notifyErrorListeners` + `this.client.disconnect()`를
  실행 — disconnect 후 재연결이 이미 새 flow를 세운 상태에서 옛 unwrap이 늦게
  reject되면 **새 연결을 끌어내린다**. catch 진입 직후(로그/notify/disconnect 전)
  `this.connectionEpoch !== epoch → return` 추가. (성공 경로 `:1253`의 기존 검사와
  대칭; register catch `:1138`엔 기존재.) resolve/reject 양 연속 모두 테스트.
- **R3-M2 — 동기 listener 재진입**: `notifyProtocolListeners`(`nats-client.ts:1197`)
  는 리스너를 **동기** 호출(`:1379-1386`) — 리스너가 `disconnect()`/`connect()`를
  부르면 그 자리에서 epoch가 전진하는데, 옛 flow는 그대로 진행해 missing-wrapped-key
  (`:1207`)/missing-pin(`:1224`) 분기의 `this.client.disconnect()`로 **새 연결을
  teardown**할 수 있다. 수정: `notifyProtocolListeners` 직후 epoch 재검사 + 이후의
  모든 terminal 분기(notify+disconnect)를 epoch-guard된 공통 fail 헬퍼로 통일
  (await뿐 아니라 **동기 재진입도 epoch 전진 지점**이라는 규약 명문화).
- **R4-M1 — error listener도 같은 재진입 지점**: `notifyErrorListeners`도 동기
  (`:1369-1376`) — 공통 fail 헬퍼는 **notify 이전과 직후 양쪽**에서 epoch를 검사
  한다(이전 검사 = stale flow의 notify 자체를 차단, 직후 검사 = listener 재진입으로
  epoch가 전진했으면 후속 `disconnect()`를 중단). `onConnected`의 모든 terminal
  분기(`:1152,:1193,:1215,:1233,:1249`)가 이 헬퍼를 경유한다.
- **R4-M2 — 저수준 `NatsClient`의 state listener 재진입 (reconnect 스케줄 순서)**:
  `onclose`(`:480-485`)와 `forceReconnect()`(`:775-788`)는
  `notifyStateListeners()` **후에** `scheduleReconnect()`를 호출 — state 리스너가
  동기적으로 `disconnect()`(`:955` — reconnect 타이머 clear)를 불러도 옛 프레임이
  복귀하며 reconnect를 **다시 arm**해 explicit disconnect 뒤 좀비 redial이 산다.
  신설 connect-deadline이 `forceReconnect` 경로를 상시화하므로 함께 수정. 방향:
  **스케줄을 notify 이전으로 이동**(재진입 disconnect의 `clearReconnectTimer`가
  방금 arm된 타이머를 자연 취소) — 구현에서 곤란하면 disconnect가 전진시키는
  세대(generation) 카운터로 scheduleReconnect를 guard하는 대안 허용. close·
  timeout-경유 양 경로의 state-listener disconnect 테스트 필수.

## 5. Test plan (신규/보강; 기존 스위트 삭제·축소 없음)

테스트 seam (R1-m2 정정): transport는 `_wsFactory` 주입(`nats-transport.ts:94`),
client는 **`globalThis.WebSocket` 교체**(기존 패턴 —
`nats-client-liveness.test.ts:72-82`의 FakeWS 스왑). "양쪽 대칭" 케이스는 각자의
seam으로 같은 시나리오를 구현한다.

- **A**: (transport) 같은 subject 2 sid + 다른 subject 1 sid 구독 → drop→reconnect
  → 새 소켓에 기록된 SUB가 **원본 sid 3개 전부**인지; `unsubscribe(원본 sid)` →
  새 소켓에 그 sid의 UNSUB 기록 + `subs`에서 소멸; 이후 reconnect에 미replay.
  (channel, R1-M5 강화) `registerPeer`→transport reconnect→`unregisterPeer`에서
  **fake broker의 live-SID 테이블에 해당 구독이 없음을 단언**(정확한
  `UNSUB <replayed-sid>` frame 수신 확인), 이어서 그 subject로 publish해도 broker가
  라우팅하지 않음(전달 0회)까지 증명 — 로컬 맵 소거만으로 green이 되는 약한 단언
  금지.
- **B**: (양쪽 대칭으로) 한글/emoji payload 정확 전달; **multibyte 문자가 chunk
  경계에서 갈라지는 케이스**(payload 중간/control line 중간); 한 chunk에 MSG 2개;
  MSG 헤더 자체가 chunk에 걸침; payload 안에 `\r\n-ERR ...`/`\r\nMSG ...` 포함 —
  프로토콜 주입 불가(payload로만 전달) 검증; byteCount 과대(>MAX_PAYLOAD)/음수/NaN
  → 연결 리셋; **malformed 헤더 강화(R1-M4): `1junk` 숫자접미, 토큰 3개/6개, 빈
  subject 토큰 → 전부 리셋**; payload 후행 CRLF 불일치 → 리셋; **경계(R1-M2):
  단일 거대 WS frame(> MAX_BUFFERED_BYTES) → concat 없이 리셋; 유효 MSG 다수가 한
  chunk에 꽉 찬 케이스는 정상 처리(상한 미발화)**; CRLF 없는 64KiB 초과 control
  line → 리셋; **정확히 경계값 통과 3종(R2-M2): MAX_CONTROL_LINE 길이의 CRLF-완결
  라인, MAX_PAYLOAD 크기 payload, 그리고 둘을 합친 최대 적법 frame(= MAX_BUFFERED_
  BYTES와 정확히 일치)이 거부되지 않음** — 불완전-payload 재삽입 대기 상태를
  경유해도 마찬가지; 불완전 payload는 다음 chunk 대기(기존 semantics 보존);
  (transport) binary payload byte-동일성.
- **C**: (transport) open 후 무응답 fake 서버 → `connect()`가 phase 예산 내 reject
  + 에러에 phase 이름; **phase별 각각** — open만 하고 INFO 안 줌(JWT 모드), INFO 후
  침묵(PONG 없음) — 개별 발화 확인; 진행이 있으면 re-arm되어 총 예산이 phase 합으로
  늘어나는 것 확인; established→drop→무응답 재다이얼→실패→backoff 지속→응답
  서버로 복구 시 구독 replay까지(§3-C 정지 버그의 회귀 테스트); **타이머 소유권
  (R2-M1): 옛 소켓의 지연된 close가 새 다이얼이 arm한 deadline을 clear하지 못함
  (old-close-after-new-arm race — 새 다이얼이 여전히 timeout으로 죽을 수 있어야 함)
  + `handshakeTimeoutMs: 0` 비활성 lifecycle(타이머 미생성, 기존 hang semantics
  유지) + **겹침 다이얼(R3-M1): 다이얼 A 진행 중 두 번째 `connect()`가 `this.ws`를
  교체, A의 소켓은 half-open 유지 → A의 deadline이 stale 상태에서도 A의 promise를
  reject하고 A의 소켓을 close하되, 새 다이얼의 공유 상태·타이머는 불가침**.
  (client) PONG 없는 서버 → deadline 내 forceReconnect, terminal 미진입
  + 동일한 소유권/0 테스트. fake timer로 시간 제어.
- **C-2 (R1-B1·R2-B1 회귀)**: (transport) NKEY 서명 콜백을 인위적으로 지연 → 서명 중
  timeout/재연결로 소켓 교체 → **옛 연속이 새 소켓에 CONNECT를 보내지 않음**을
  새 소켓의 송신 기록으로 단언; **stale-INFO 오더링(R2-B1): 소켓 교체 이후 옛
  소켓의 message handler로 INFO가 도착하는 케이스 — 옛 INFO가 현행 buffer를
  오염시키지 않고, 그 nonce로 서명된 CONNECT가 어느 소켓으로도 나가지 않음**;
  (client) 동일 시나리오에서 캡처된 소켓 밖으로 아무것도 안 나감.
- **D-1**: register round-trip 중 `disconnect()` → 연속 재개 후 `sessionKey` 미설치
  ·flush 미발생; **unwrap 연속 양쪽(R2-M3): resolve 지연 케이스와 reject 지연
  케이스 각각 — disconnect→재연결로 새 flow가 선 뒤 옛 unwrap이 늦게
  resolve/reject해도 새 연결이 끊기거나 error가 notify되지 않음**; **protocol
  listener 재진입(R3-M2): onProtocol 리스너가 동기적으로 disconnect→connect를
  수행 + register 응답에 wrappedConversationKey 부재 → 옛 flow가 새 연결을
  disconnect하지 않고 error도 새 flow 몫으로 오염되지 않음**; **error listener
  재진입(R4-M1): onError 리스너가 동기 disconnect→connect → 옛 terminal 분기가
  새 연결을 disconnect하지 않음**; **state listener 재진입(R4-M2): onState
  리스너의 동기 `disconnect()`가 (i) onclose 경유, (ii) connect-deadline의
  forceReconnect 경유 각각에서 이후 reconnect가 arm되지 않음(좀비 redial 부재)을
  타이머 관측으로 단언**.

게이트: 루트 vitest 전 스위트(**요약의 "Test Files" 줄까지 확인** — P0-2 교훈),
typecheck×3, build, guard, pack-smoke, examples 2종, **live ALL-REAL 하네스
(`e2e/local/run-all-real.sh`)는 TechLead가 격리 worktree에서 직접 실행**. CI
baseline은 branch point의 PASSED 실측으로 재확인 후 신규 테스트만큼 상향.

## 6. Compat / risk notes

- `NatsMessage.payload`는 이미 `Buffer` — 소비자 무영향(오히려 지금까지가
  mangled-bytes였음). client raw listener는 string 유지.
- 신규 옵션 **2개**(`handshakeTimeoutMs`/`connectTimeoutMs`, R1-m3 정정)는 additive
  + 기본값 — config/문서 마이그레이션 없음. 단 **기본 10s per-phase deadline은 신규
  실패 모드**: 진짜로 느린 relay/CI에서 기존엔 hang이던 것이 reject가 된다(이게
  목적). 기존 테스트 중 "응답 없는 서버로 pending 유지"에 기대는 것이 있으면
  timeout 0으로 국소 비활성.
- B의 "위반=연결 리셋"은 기존 "skip 후 계속"보다 엄격. 상한/문법은 nats-server
  기본 한계(max_control_line 4096B, max_payload 1MiB) 대비 큰 여유로 잡았고, 실서버
  대면 검증은 live ALL-REAL 하네스(실 nats-server의 INFO/MSG 전 구간)가 담당한다.
  **64KiB INFO의 지원되는 도달 경로는 존재한다**(R2-m1이 제시한 대규모 클러스터
  `websocket.advertise` → `ws_connect_urls` 팽창 — R1 반박 철회): 다만 수백 노드
  ×장문 호스트명 클러스터를 CI에 세우는 비용 대비, 본 배포 토폴로지(단일 relay,
  SaaS-민팅 URL)는 그 근처에 가지 않고, 초과 시 동작도 조용한 오염이 아닌
  fail-loud 리셋+재연결이며, 상한은 모듈 상수라 상향이 즉시 가능 — **비용 근거로
  실서버 near-max 테스트는 생략**(불가능 근거 아님). 엄격 MSG 문법의 실서버
  호환성은 codex R2가 확인(headers 미협상 CONNECT → 서버는 항상 MSG, HMSG 없음).
- reconnect replay가 dedupe를 버리므로 같은 subject 복수 sid는 reconnect 후 복수
  전달로 "복원"된다 — 이것이 drop 이전과 동일한 semantics(회귀 아님)임을 리뷰에서
  재확인.

## 7. Review log

- **R1** (codex gpt-5.6-sol, NEEDS_CHANGES — 1B+4M+3m):
  - B1 서명 연속의 소켓 오염 → 수용, §4.3 발신 소켓 규율 + §5 C-2 테스트.
  - M1 단계별 deadline 요구 누락 → 수정 수용: 단일 타이머 phase-전이 re-arm
    방식으로 per-phase 예산 충족(§4.3). 개별 타이머 4개 방식은 소켓 교체 race
    표면만 넓혀 기각.
  - M2 총 buffer 상한 부재 → 수용, `MAX_BUFFERED_BYTES` + concat 전 검사.
  - M3(M4로 표기) 엄격 MSG 문법 → 수용(§4.2).
  - M5 채널 A 테스트 약함 → 수용, broker-side 단언으로 강화(§5-A).
  - m1 64KiB 근거+실서버 경계 테스트 → 부분 수용: 근거 문서화 + 단위 경계 테스트
    + live 하네스 위임. **실서버 near-max INFO 강제는 반박** — nats-server INFO
    크기는 운영자가 직접 지정할 수 없고(서버 메타 파생), 64KiB급 INFO를 만들
    지원되는 설정 경로가 없다. 반박이 틀렸다면 구체적 설정 경로를 제시할 것.
  - m2 client seam 부정확 → 수용, `globalThis.WebSocket` 스왑 명시(§5).
  - m3 옵션 3개→2개 → 수용(§6).
- **R2** (codex gpt-5.6-sol, NEEDS_CHANGES — 1B+3M+1m):
  - B1 "진입 시 캡처" 대안이 R1-B1을 미해결(stale handler가 공유 buffer에 옛 INFO를
    흘리면 새 소켓을 캡처) → 수용: 대안 금지, lexical 스레딩 의무화 + **파서
    buffer를 다이얼 소유로 이동**(stale 오염의 물리적 차단, §4.3) + stale-INFO
    오더링 테스트(§5 C-2).
  - M1 타이머 소유권/clear 미정의(옛 close가 새 deadline을 clear 가능) → 수용:
    다이얼-소유 `{ws,timer,phase}` + "자기 타이머만 clear" 규율 + race/0 테스트.
  - M2 MAX_BUFFERED_BYTES가 최대 적법 frame보다 2B 작음 + 경계 부등호 모순 →
    수용: CRLF-제외 정의 + `>` 위반 + `+4` 산술 + 경계 3종 테스트(§4.2, §5-B).
  - M3 unwrap **거부** 연속이 epoch 미검사로 새 연결을 teardown 가능 → 수용:
    catch 진입 직후 epoch 검사(§4.4) + resolve/reject 양측 테스트. (기존 코드에도
    잠재하던 버그 — D-1 범위에 편입.)
  - m1 near-max INFO "불가능" 반박이 과함(클러스터 `ws_connect_urls` 경로 실재) →
    수용: 불가능 주장 철회, 생략 근거를 비용/가치로 교체(§6).
  - R1 해소 감사: A(sid 안정화+broker 단언)·엄격 문법의 실서버 호환은 genuine 판정.
- **R3** (codex gpt-5.6-sol, NEEDS_CHANGES — 0B+2M):
  - R2 반영 전건 genuine 판정; buffer 다이얼화·+4 산술·INFO 생략 근거는 무결 확인.
  - M1 stale deadline no-op 규정이 겹침 다이얼(half-open으로 밀려난 소켓)의 promise
    영구 pending을 유발 → 수용: stale이어도 자기 promise settle + 자기 소켓 close는
    항상, identity guard는 공유 상태 변경에만(§4.3) + 겹침 다이얼 테스트(§5-C).
  - M2 `notifyProtocolListeners` 동기 재진입 후 epoch 미재검사 → 옛 flow가 새 연결
    teardown 가능 → 수용: listener 직후 재검사 + terminal 분기 공통 epoch-guard
    헬퍼(§4.4) + 재진입 테스트(§5 D-1).
- **R4** (codex gpt-5.6-sol, NEEDS_CHANGES — 0B+2M): R3 두 건 해소 확인 후 같은
  재진입 계열의 잔여 2건.
  - M1 error listener 재진입 미커버 → 수용: 공통 fail 헬퍼가 notify **전후 양쪽**
    epoch 검사 + 전 terminal 분기 경유 + onError 재진입 테스트(§4.4, §5 D-1).
  - M2 저수준 NatsClient가 state 통지 **후** reconnect 스케줄 → 재진입 disconnect
    뒤 좀비 redial(신설 connect-deadline이 노출 상시화) → 수용: 스케줄-먼저 순서
    (대안: disconnect-전진 세대 guard) + close/timeout 양 경로 테스트(§4.4, §5 D-1).
