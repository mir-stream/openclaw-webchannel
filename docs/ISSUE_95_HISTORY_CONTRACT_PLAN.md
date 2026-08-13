# Issue #95 — history 계약이 보존하는 범위

- 이슈: [#95](https://github.com/mir-stream/openclaw-webchannel/issues/95)
- OpenClaw 기준 버전: `2026.6.10`
- 관련: [#114](https://github.com/mir-stream/openclaw-webchannel/issues/114) (delivery mirror), [#111](https://github.com/mir-stream/openclaw-webchannel/issues/111) (live bubble 대응), [#109](https://github.com/mir-stream/openclaw-webchannel/pull/109) (tool-calling fixture)

## 1. 결정

Issue #95는 다음 둘 중 하나를 요구한다.

1. history wire를 확장하여 reload 시 live turn grouping과 terminal failure를 충실히 복원한다.
2. 현재 저장 자료로 보존할 수 없는 항목을 계약에서 명시한다.

이 PR은 **두 항목 모두 (2)를 택한다.** 현재 history projection은 다음만 보존한다.

- 정규화된 `role`
- sanitization 뒤의 `text`
- projection이 방출한 row의 순서와 row `id`
- 존재하는 경우 `ts`

다음은 보존하지 않는다.

- client가 만든 정확한 live `turnId`
- retry에 안전한 terminal-turn failure verdict
- `working`, `wireId`, `sendState` 같은 live-only 상태
- reasoning preview, typing, tool progress 같은 휘발성 상태

따라서 이 PR은 `failed`, `attemptFailed`, 합성 `turnId`를 wire에 추가하지 않는다. 현재 transcript로 만들 수 없는 의미를 boolean이나 이름만 바꾸어 약속하지 않는 것이 핵심이다.

## 2. 범위

이 변경이 소유하는 표면은 다음이다.

- `packages/plugin/src/channel-contract.ts`의 history 계약 설명
- `packages/client/src/types.ts`의 live-only `turnId` 설명
- `packages/plugin/src/history-utterance-correspondence.test.ts`의 projection 특성화
- `packages/client/src/nats-client-wrapper-hydration.test.ts`의 결정적 hydration 특성화

`packages/plugin/src/history.ts`, client history reducer, wire shape는 기존 동작을 유지한다. delivery mirror(#114), live bubble 대응(#111), core 저장 형식 변경은 범위 밖이다.

## 3. 근거의 종류

근거의 강도를 섞지 않는다.

### 3.1 공개 계약

`openclaw/plugin-sdk/llm`이 선언하는 shape로부터 다음을 알 수 있다.

- transcript에는 `UserMessage`, `AssistantMessage`, `ToolResultMessage`가 있다.
- `AssistantMessage.content`는 `TextContent`, `ThinkingContent`, `ToolCall` 등의 리스트다.
- `AssistantMessage.stopReason`에는 `"error"`가 있다.
- text, thinking, tool call은 서로 다른 content block shape다.

`runtime.subagent.getSessionMessages`의 반환 원소는 구체적인 transcript entry 타입으로 선언되어 있지 않다. `__openclaw` 봉투는 이 레포가 관찰해서 읽는 비공개 shape다.

### 3.2 이 레포가 소유하는 코드

라인 번호 대신 안정적인 symbol을 근거로 삼는다.

- `handleInboundMessage`는 client의 `user_message.id`에서 live `turnId`를 정한다.
- 같은 함수의 `onPartialReply`는 answer text를 progress draft로 보낸다.
- `deliverDraftFinalPayload`는 `draft.finalize`를 통해 그 draft를 최종 text로 완료할 수 있다.
- `history.ts`의 `extractText`, `normalizeRole`, `extractId`, `normalize`가 stored message를 history row로 투영한다.
- `pageBefore`는 투영된 row `id`를 pagination cursor로 사용한다.
- client의 `promoteAnchor`는 live `turnId`와 user bubble의 `wireId`를 정확히 비교한다.

### 3.3 핀된 core에 대한 static observation

핀된 구현을 읽으면 다음 경로가 존재한다.

- 모델 스텝마다 assistant message가 저장될 수 있다.
- tool round 전 assistant message가 text와 tool call을 함께 가질 수 있다.
- `stopReason:"error"`인 assistant attempt/message를 저장한 뒤 retry 또는 fallback이 성공하여 뒤에 정상 assistant message가 추가될 수 있다.
- session-message read 결과에는 client가 만든 live `user_message.id`를 exact `turnId`로 복원할 공개 필드가 없다.

이는 현재 핀에 대한 static observation이다. 아래 합성 테스트가 core 실행 전체를 재현하거나 가능한 shape를 exhaustively 증명한다는 뜻은 아니다.

## 4. history projection 특성화

`history-utterance-correspondence.test.ts`는 공개 계약과 호환되는 명시적 fixture를 `recent`에 넣어 현재 normalizer를 검사한다.

예를 들어 다음 fixture는 agent row 두 개를 만든다.

```text
user       "which agents are configured?"
assistant  [text "Let me check that.", toolCall agents_list]   stopReason toolUse
toolResult "alpha, beta, gamma"
assistant  [text "You have three agents: alpha, beta, gamma."] stopReason stop
```

현재 projection의 결과는 다음과 같다.

- visible text가 있는 두 assistant message는 각각 agent row가 된다.
- tool-call-only assistant message는 text가 없어 row가 되지 않는다.
- thinking-only assistant message도 row가 되지 않는다.
- `toolResult` role은 history timeline에 들어가지 않는다.
- 방출되는 user/agent row의 상대 순서는 유지된다.

이 fixture는 **현재 normalizer가 해당 입력 shape를 어떻게 다루는지** 고정한다. “core의 모든 다단계 turn이 이 shape다”, “live utterance와의 발산 원인은 정확히 하나다”, “raw transcript의 모든 boundary identity가 보존된다”는 결론을 증명하지 않는다.

## 5. 정확한 live `turnId`는 복원하지 않는다

live `turnId`는 `handleInboundMessage`가 client의 `user_message.id`에서 얻는 값이다. stored message projection에는 이 exact client-generated id가 없으므로 같은 namespace의 값을 안전하게 채울 수 없다. 다른 transcript id를 `turnId`라는 이름으로 싣는 것은 `promoteAnchor`가 사용하는 live correlation namespace와 충돌한다.

다만 이것을 “어떤 grouping도 불가능하다”로 넓혀 말하지 않는다.

- 정규화된 user row는 user boundary라는 구조적 근거를 남긴다.
- raw transcript의 tool call/result는 projection 전에 추가 관계 정보를 가질 수 있다.
- 현재 projection은 tool result를 제거하므로 그 정보 일부를 client에 전달하지 않는다.

테스트는 실제 두 user turn fixture에 두 번째 user boundary를 넣고, 전체 normalized output이 one-user multi-step fixture와 다름을 확인한다. 동시에 어느 history row에도 exact live `turnId`를 합성하지 않는다는 현재 계약을 고정한다.

완전한 grouping이 제품 요구가 되면 stored lifecycle metadata나 delivery mirror 같은 별도 설계가 필요하다. #95는 그 설계를 가장하지 않는다.

## 6. terminal-turn failure verdict는 복원하지 않는다

`AssistantMessage.stopReason === "error"`는 stored assistant attempt/message의 종료 상태이지 user turn 전체의 durable verdict가 아니다. realistic한 경로에서 다음 순서가 가능하다.

```text
user message
assistant attempt, stopReason "error"   # 저장됨
retry/fallback assistant, stopReason "stop" # 성공하여 저장됨
```

첫 번째 row를 `failed:true`로 보내면 reload 시 성공한 turn이 실패한 것처럼 보인다. 그 신호를 retry affordance에 쓰면 이미 성공했고 side effect가 있었을 수 있는 turn을 다시 실행할 위험이 있다.

반대 방향의 손실도 있다. `normalize`는 display text가 없거나 sanitization 뒤 빈 문자열이면 row를 만들지 않는다. 따라서 textless, tool-only, thinking-only, `NO_REPLY` 같은 sanitized-away error attempt는 `stopReason`을 검사할 row 자체가 없다.

두 사실을 함께 보면 current transcript projection에서 retry-safe terminal verdict를 도출할 수 없다. 그래서 이 PR은 다음을 하지 않는다.

- `stopReason:"error"`를 turn-level `failed`로 승격
- `attemptFailed`를 terminal failure처럼 client bubble에 전달
- 보이지 않는 error attempt를 위해 합성 failure row 생성

테스트는 error attempt 뒤 성공 row가 와도 terminal failure 필드를 내보내지 않는 것과, textless/sanitized-away error attempt가 row가 되지 않는 현재 동작을 고정한다. 후자는 이상적인 표현이라고 주장하는 것이 아니라, 이 자료가 terminal verdict의 근거가 될 수 없음을 문서화한다.

terminal outcome을 복원하려면 retry/fallback이 끝난 뒤의 lifecycle verdict를 내구성 있게 저장하고 history row 또는 turn과 연결하는 별도 설계가 필요하다. #114의 delivery mirror는 transcript에 전혀 쓰이지 않는 delivery-only 교환을 다루며, 그 자체로 lifecycle verdict나 exact client id를 제공하지는 않는다.

## 7. hydration 계약

client hydration은 raw transcript가 아니라 plugin이 보낸 **normalized history row projection**을 입력 계약으로 삼는다.

- cold reload는 row 하나당 bubble 하나를 같은 순서와 row id로 만든다.
- 같은 snapshot을 다시 적용해도 중복을 만들지 않는다.
- 동일 text를 가진 인접 row도 서로 다른 id면 별도 bubble이다.
- older page는 입력 row 순서로 prepend된다.
- `ts`가 없어도 row 순서는 유지된다.
- mid-session snapshot은 current three-tier reducer 규칙에 따라 live bubble과 reconcile된다.

이것은 projection에 대한 결정성 계약이다. raw transcript와 live utterance의 완전한 동치, 모든 turn boundary의 복원, terminal outcome의 복원을 약속하지 않는다.

## 8. 테스트와 남은 작업

집중 테스트는 다음을 고정한다.

- plugin: contract-compatible assistant/tool/thinking shape의 projection, emitted-row order, error-attempt 한계, exact live `turnId` 비합성, 실제 second-user boundary 보존
- client: cold hydration의 row order/id, reload 결정성, idempotence, pagination, optional timestamp, current mid-session reconciliation

남은 작업은 현재 PR에 흡수하지 않는다.

| 항목 | 위치 | 이유 |
| --- | --- | --- |
| durable terminal-turn verdict | 별도 lifecycle 설계가 필요함 | retry/fallback 완료 뒤 상태를 저장해야 함 |
| exact live turn correlation | 별도 identity 설계가 필요함 | client-generated id를 durable storage와 연결해야 함 |
| delivery-only 교환의 transcript 누락 | #114 | 현재 delivery mirror가 없음 |
| live bubble과 stored row의 대응 개선 | #111 | live delivery 정책과 함께 결정해야 함 |
| 실제 tool-calling 실행과 합성 fixture 비교 | #109 이후 | 합성 characterization을 실측으로 가장하지 않기 위해 별도 확인 |
| `__openclaw.seq` / 합성 id 은퇴 | 후속 | untyped envelope 의존과 cursor compatibility 검토 필요 |
