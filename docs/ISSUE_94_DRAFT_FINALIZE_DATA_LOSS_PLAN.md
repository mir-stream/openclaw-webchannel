# Issue #94 — partial draft가 어시스턴트 메시지 경계를 잃고 마지막 메시지로 덮이는 문제

- 이슈: [#94](https://github.com/mir-stream/openclaw-webchannel/issues/94) (P1 / kind/bug / area/plugin)
- 상류 리포트: rota-crew#281-A (Rota 0.4.0 제품 리뷰)
- 브랜치: `mir-stream/issue-94` (base `develop`, 시작 커밋 `2bea2d8`)
- 검증 대상: 이 저장소가 pin한 OpenClaw `2026.6.10`; 보고 환경 `2026.7.1`
- 상태: 제품 의미론 결정 완료, 구현 전

---

## 1. 확정된 제품 계약

이 이슈에 남은 가치판단은 없다. 다음을 구현 계약으로 확정한다.

1. **보존 단위는 완료된 어시스턴트 메시지다.** 한 턴에 어시스턴트가 사용자에게 두 번 발화했다면 두 메시지 모두 남는다.
2. **라이브 화면도 어시스턴트 메시지마다 별도 버블이다.** 라이브와 히스토리 하이드레이트의 메시지 수와 순서가 같아야 한다.
3. **partial/delta는 현재 메시지를 만드는 동안의 임시 갱신이다.** 임시 갱신 자체를 모두 저장하지는 않지만, 메시지가 완료되면 그 버블은 정착되고 다음 메시지가 같은 버블을 덮지 못한다.
4. **`final`은 현재(마지막) 어시스턴트 메시지의 최종 형태다.** 턴 전체를 대표하는 합성 문자열이 아니며, 앞 메시지와 합칠지 텍스트 내용으로 추측하지 않는다.
5. **툴/item progress는 휘발성 상태 UI다.** 어시스턴트가 실제로 발화한 commentary/final-answer 텍스트와 같은 보존 단위가 아니다.
6. **이 저장소의 플러그인에서 고친다.** core는 이미 메시지 시작, partial 교체, block 소유권, 최종 전달에 대한 구조화된 경계를 제공한다.
7. **앞 메시지의 라이브 전송 실패와 에이전트 턴 결과는 별개다.** 실패를 기록하고 마지막 메시지 전달을 계속 시도하며, 재접속 시 히스토리로 복구한다.

따라서 목표 형상은 아래와 같다.

```text
assistant message A
  partial(A1) -> partial(A2) -> bubble A 정착

assistant message B
  partial(B1) -> partial(B2) -> final(B)로 bubble B 정착
```

`A + B`를 한 문자열로 만들었다가 턴 끝에서 다시 분해하는 경로는 만들지 않는다.

---

## 2. 용어와 보존 여부

| 값/이벤트 | 의미 | 화면/저장 계약 |
| --- | --- | --- |
| `onPartialReply({ text, delta, replace })` | 현재 어시스턴트 메시지의 스트리밍 갱신. `text`는 현재 누적 본문이고 `replace:true`는 같은 메시지 안의 교체 갱신이다. | 활성 버블 하나를 편집한다. 각 중간 프레임은 영구 보존하지 않는다. |
| tool/item `progress` | 플러그인이 만드는 `Working…`, 툴명, 상태 줄 같은 작업 진행 표시다. | 휘발성 scaffold다. 실제 어시스턴트 발화로 히스토리에 남기지 않는다. |
| assistant `commentary` | 모델이 사용자에게 내보낸 가시 텍스트 단계다. reasoning이나 툴 상태 줄이 아니다. | 하나의 어시스턴트 메시지로 완료되면 별도 버블로 보존한다. |
| `delivery.deliver(..., { kind:"block" })` | core가 전달하는 가시 어시스턴트 block이다. `assistantMessageIndex`가 있으면 원래 메시지 소유권도 안다. | 동일 index의 활성/정착 버블과 연결한다. 내용 비교로 중복 여부를 판정하지 않는다. |
| `delivery.deliver(..., { kind:"final" })` | 현재 턴의 마지막 어시스턴트 메시지에 대한 권위 있는 최종 payload다. | 현재 메시지 버블만 확정한다. 앞 버블을 대체하지 않는다. |

핵심 구분은 간단하다. **스트리밍 프레임은 휘발성이지만, 그 스트림이 완성한 어시스턴트 메시지는 휘발성이 아니다.**

---

## 3. 현상과 증거

`streaming.mode:"partial"`에서 한 턴이 여러 어시스턴트 메시지를 만들면 현재 플러그인은 모든 partial을 ID 하나의 draft에 이어 붙인다. 턴 끝에는 core가 넘긴 마지막 메시지 하나로 그 ID를 finalize한다.

전달 이음매에서 실측한 값은 다음과 같다.

```text
[PROBE deliver] kind=final len=440
  head="운영사업부 F/O 직원 12명을 확인했습니다.\n\n| # | 이름 | 입사일 | 상태 |…"
  draftSnap="운영사업부 F/O 직원 목록을 조회하겠습니다.\n\n운영사업부 F/O 직원 12명을 확인했습니다.\n\n| # |…"
  snapLen=467
```

- 라이브 draft: 467자, 첫 번째 어시스턴트 메시지 포함
- final payload: 440자, 마지막 어시스턴트 메시지만 포함
- `delivery.deliver` 호출: 이 재현 턴에서는 final 1회
- 정착 직전/직후: 버블 수는 1개 그대로인데 텍스트가 짧아짐
- 같은 턴의 히스토리: 어시스턴트 메시지 2개가 모두 존재

즉 transcript와 core의 메시지 경계는 보존되어 있고, WebChannel 라이브 draft만 그 경계를 평탄화해 데이터가 사라진다.

---

## 4. 근본 원인

### 4.1 플러그인이 서로 다른 메시지를 draft 하나에 합친다

현재 `packages/plugin/src/message-adapter.ts`는 대략 아래 상태를 턴 전체에서 공유한다.

```ts
const id = nextMessageId();
let answerText = "";
let answerPrefix = "";
const answerBody = () => answerPrefix + answerText;
```

`handleAssistantMessageBoundary()`는 완료된 `answerText`를 `answerPrefix`로 옮길 뿐, 기존 버블을 확정하고 새 ID로 회전하지 않는다. 그 결과 메시지 A와 B가 wire에서 구분되지 않는 문자열 `A + "\n\n" + B`가 된다.

### 4.2 마지막 payload가 합쳐진 draft 전체를 교체한다

현재 `packages/plugin/src/inbound.ts`의 final 분기는 다음 형태다.

```ts
if (draft && info?.kind === "final") {
  const sent = await draft.finalize(text);
  return { visibleReplySent: sent };
}
```

여기서 `text`는 마지막 어시스턴트 메시지 B이고 draft ID에는 A+B가 들어 있다. 같은 ID의 `agent_message`가 B로 교체되므로 A가 사라진다.

### 4.3 기존 계획도 같은 평탄화를 전제로 했다

이 문서의 이전 버전은 턴 끝에 `answerPrefix`를 배열로 복원한 뒤 다음을 시도하려 했다.

- 첫 조각으로 기존 draft를 finalize
- 나머지 조각과 final을 새 메시지로 append
- `final.includes(앞 메시지)`로 core가 앞 메시지를 흡수했는지 추측

이 설계는 폐기한다. 메시지 경계가 이미 구조화되어 있는데 먼저 문자열로 잃은 뒤 내용으로 복원할 이유가 없다. 특히 B가 A를 인용하면 `includes`가 참이 되어 서로 다른 메시지를 같은 메시지로 오판한다.

---

## 5. core 계약은 모호하지 않다

pin된 OpenClaw `2026.6.10`의 공개 타입과 런타임에는 필요한 신호가 이미 있다.

```ts
type PartialReplyPayload = {
  text?: string;
  delta?: string;
  replace?: true;
  mediaUrls?: string[];
};

onAssistantMessageStart?: () => void | Promise<void>;
onBlockReplyQueued?: (
  payload: ReplyPayload,
  context?: { assistantMessageIndex?: number },
) => void | Promise<void>;

type ReplyDispatchRuntimeInfo = {
  kind: "tool" | "block" | "final";
  assistantMessageIndex?: number;
};
```

- `onAssistantMessageStart`는 새 어시스턴트 메시지가 시작됐음을 알린다.
- `replace:true`는 **같은 현재 메시지**의 교체 갱신임을 알린다.
- `onBlockReplyQueued`와 `assistantMessageIndex`는 block이 어느 어시스턴트 메시지 소유인지 연결한다.
- `kind:"final"`은 마지막 메시지의 최종 전달이다.

OpenClaw Telegram 채널도 같은 계약을 사용한다. 활성 answer lane을 materialize한 뒤 stream을 멈추고 `forceNewMessage()`로 새 메시지 ID를 만든다. `onAssistantMessageStart`와 `onBlockReplyQueued` 작업은 직렬 queue에 넣어 callback 호출 순서를 transport 완료 순서와 분리한다. `2026.6.10`과 확인 시점의 `2026.7.1` 모두 이 기본 구조를 쓴다.

따라서 core가 단순 문자열만 쏟아내서 관계를 알 수 없는 문제가 아니다. **WebChannel이 제공된 경계를 버리고 ID 하나에 합친 것이 문제다.** Telegram/Discord/Slack이 이미 붙는 core를 이 이슈에서 바꾸지 않는다.

---

## 6. 채택 설계 — 메시지 경계에서 lane을 정착하고 회전한다

### 6.1 정상 시퀀스

```text
onAssistantMessageStart()             # 첫 메시지: 빈 lane이므로 회전 없음
onPartialReply(A1)                    # progress(id=A, text=A1)
onPartialReply(A2)                    # progress(id=A, text=A2)
onBlockReplyQueued(A, index=0)        # block 순서와 메시지 소유권 기록

onAssistantMessageStart()             # A를 id=A로 정착, 새 lane으로 회전
onPartialReply(B1)                    # progress(id=B, text=B1), A와 다른 ID
onPartialReply(B2)                    # progress(id=B, text=B2)
delivery.deliver(final B, index=1)    # agent_message(id=B, text=final B)
```

라이브 결과는 `[A 버블, B 버블]`이고 히스토리도 `[A 메시지, B 메시지]`다.

### 6.2 활성 lane 상태

턴 전체에 고정된 `id`와 `answerPrefix` 대신 현재 어시스턴트 메시지 단위의 lane을 둔다.

```ts
type AssistantDraftLane = {
  generation: number;
  assistantMessageIndex?: number;
  id: string;
  answerText: string;
  queuedBlocks: Array<{ text?: string; assistantMessageIndex?: number }>;
  started: boolean;
  settled: boolean;
  settleResult?: Promise<boolean>;
};
```

세부 규칙:

1. ID는 lane마다 하나씩 만들고, 다음 메시지가 시작되면 새 ID로 회전한다.
2. 첫 `onAssistantMessageStart`와 내용 없는 중복 경계는 빈 버블을 만들지 않는다.
3. partial은 활성 lane만 갱신한다. `replace:true`도 활성 lane 안에서만 본문을 교체한다.
4. 경계가 오면 이전 lane에 실제 어시스턴트 텍스트가 있는 경우만 정착한다. partial이 있으면 사용자가 마지막으로 본 정제된 cumulative snapshot을 쓴다. 같은 index의 queued block payload들은 순서대로 보존해 partial이 없는 경우의 본문과 delayed-delivery correlation에 쓴다. block 하나를 곧바로 assistant 메시지 전체라고 가정하지 않는다.
5. block/final 전달은 `assistantMessageIndex`가 있으면 그 값으로 lane과 연결한다. index가 없는 경우에도 callback 직렬 순서와 내부 generation으로 연결한다.
6. 이미 정착한 index의 block delivery가 나중에 drain되면 전송 결과만 회계하고 두 번째 버블을 만들지 않는다. dedupe 키는 index/generation이지 텍스트가 아니다.
7. final이 오기 전에 현재 lane이 화면에 나오지 않았어도 final용 새 ID 하나로 버블을 append/정착할 수 있어야 한다.
8. 정착 latch는 턴 전체가 아니라 lane별이다. A를 정착한 뒤에도 B를 별도로 정착할 수 있어야 한다.

### 6.3 callback과 delivery를 하나의 직렬 queue로 처리한다

core callback 타입이 Promise를 허용해도 모든 호출자가 그 Promise를 기다린다는 전제에 기대지 않는다. Telegram과 같이 아래 작업을 한 queue에 넣는다.

- partial ingest
- queued block 기록
- assistant-message boundary materialize/rotate
- block/final delivery의 lane 정착
- abort/error cleanup

각 작업의 실패는 해당 작업에서 잡아 queue가 영구 reject 상태가 되지 않게 한다. 그래야 A의 live send가 실패해도 B의 final 전달이 실행된다.

### 6.4 문자열 추론 금지

정상 경로에서 다음 검사를 사용하지 않는다.

- `final.includes(previous)`
- `snapshot.endsWith(final)`
- `startsWith`/공백 정규화로 메시지 동일성 판정
- `A + "\n\n" + B`를 나중에 split

`final`이 앞 메시지를 인용하거나 반복해도 메시지 index/boundary가 다르면 별도 버블이다. final이 현재 메시지를 재포맷해 partial과 크게 달라져도 같은 lane만 교체한다.

### 6.5 contract 위반에 대한 방어

정상 소유권은 구조화된 이벤트가 결정한다. 다만 `onAssistantMessageStart`가 누락된 비정상 stream에서도 이미 화면에 보인 텍스트를 조용히 덮지는 않는다.

- `replace:true`: 명시된 같은-message 교체이므로 활성 lane을 갱신한다.
- `replace`가 아닌 cumulative partial이 기존 본문을 확장하지 않고 갑자기 갈라짐: boundary 누락으로 진단 로그를 남기고 기존 lane을 보존한 뒤 새 lane으로 회전한다.
- 뒤늦은 boundary: 이미 방어 회전한 generation을 다시 회전시키지 않는다.

이 방어는 final과 앞 메시지의 의미를 내용으로 추측하는 로직이 아니다. 구조화된 `replace` 계약이 깨졌을 때 **이미 표시한 데이터를 보존하는 실패 안전장치**다.

---

## 7. progress scaffold와 다른 streaming mode

- `streaming.mode:"partial"`: 이 이슈의 주 경로다. 답변 partial이 있으므로 메시지별 draft lane을 사용한다.
- `streaming.mode:"progress"`: tool/item 줄만 draft에 보인다. 이 scaffold는 휘발성이며 final 답변이 오면 원래대로 원자적으로 정착한다. scaffold를 완료된 어시스턴트 메시지로 승격하지 않는다.
- `streaming.mode:"block"` / `"off"`: draft lane이 없다. core가 넘긴 각 block/final은 기존 append 경로를 유지하되, 회귀 테스트로 전달 순서와 중복 부재를 확인한다.
- reasoning lane: 이 계획의 대상이 아니다. reasoning과 사용자에게 발화한 commentary를 혼동하지 않는다.

`progress`/`block`/`off`에 숨겨진 문자열을 partial처럼 복원하는 기능은 이 변경에 넣지 않는다. #94는 WebChannel이 실제로 받은 메시지 경계를 보존하지 못한 결함을 고친다.

---

## 8. 전달 실패와 턴 결과

메시지별 live delivery와 agent-run 결과를 분리한다.

1. A lane 정착이 `false`를 반환하거나 throw해도 진단 로그를 남기고 B lane/final 전달을 계속한다.
2. A 실패 때문에 `turn_settled{outcome:"error"}`로 바꾸지 않는다. 모델 실행은 성공했을 수 있고 transcript에는 A가 남아 있다.
3. inline 재전송은 하지 않는다. ack 없는 재시도는 A 중복 버블을 만들 수 있다.
4. 재접속/register 시 history snapshot이 빠진 메시지를 복구한다.
5. B final 자체가 실패해도 기존 P0-4 결정대로 사용자 메시지의 턴 outcome을 거짓 실패로 바꾸지 않는다. `visibleReplySent`와 `finalReplyDelivered`는 B final의 실제 live delivery 결과를 따른다.
6. abort/error cleanup은 이미 정착한 A를 건드리지 않고 활성 lane만 snapshot으로 정착한다.

---

## 9. 구현 계획

### `packages/plugin/src/message-adapter.ts`

- 단일 `id` + `answerPrefix` 누적 모델을 rotatable `AssistantDraftLane` 모델로 교체한다.
- `pushAnswerText(text)` 대신 `text`/`delta`/`replace`를 보존해 받는 API로 바꾼다.
- 메시지 경계 materialize/rotate, queued block correlation, lane별 settle latch를 추가한다.
- tool/item progress scaffold는 활성 assistant text가 생기기 전의 휘발성 표시로 유지한다.
- `snapshotText()`는 **현재 활성 lane**의 방어 정착용 snapshot만 반환하게 명확히 한다.

### `packages/plugin/src/inbound.ts`

- `onPartialReply`, `onBlockReplyQueued`, `onAssistantMessageStart`, `delivery.deliver`를 같은 lane event queue에 연결한다.
- `info.assistantMessageIndex`를 controller에 전달한다.
- final은 현재/해당 index lane만 finalize한다.
- 현재의 “final 하나가 턴 전체 draft를 교체한다”는 주석과 분기를 제거한다.
- 앞 lane 실패를 격리하고 마지막 final delivery 회계를 유지한다.

### 클라이언트

production 변경은 예상하지 않는다. 현재 reducer는 다음을 이미 지원한다.

- 동일 `id`의 `progress`/`agent_message`: 같은 버블 update/finalize
- 서로 다른 `id`: 서로 다른 버블 append

따라서 서버가 A/B에 다른 ID를 주면 원하는 형상이 나온다. 이 전제를 회귀 테스트로 고정한다.

### 문서

- 이 계획과 GitHub #94를 확정된 메시지-boundary rotation 설계로 맞춘다.
- `docs/gaps/P0_CORE_CHAT_GAPS.md`의 “multi-step turn이 single bubble로 finalize”를 “assistant message마다 별도 bubble”로 수정한다.
- `docs/gaps/README.md`에 partial streaming의 #94 correctness gap을 표시한다.

---

## 10. 테스트 계획

### controller 단위 테스트

| # | 케이스 | 기대 |
| --- | --- | --- |
| M1 | 첫 boundary 후 A partial | 빈 버블 없이 A ID 하나 생성 |
| M2 | A partial → boundary → B partial | A가 정착되고 B는 다른 ID 사용 |
| M3 | A → B → C | 세 lane/세 ID, 발생 순서 유지 |
| M4 | `replace:true`로 A 본문 수정 | 새 버블 없이 A lane만 교체 |
| M5 | 같은 index의 queued block이 하나 이상 있음 | 순서를 보존해 같은 lane과 연결하고 버블은 한 번만 정착 |
| M6 | 같은 index block delivery가 늦게 도착 | 중복 버블 없음 |
| M7 | boundary 누락 + non-replace divergence | 기존 lane 보존, 진단 후 방어 회전 |
| M8 | 늦은 boundary | 방어 회전을 두 번 적용하지 않음 |
| M9 | A 정착 실패 | queue는 살아 있고 B 정착 실행 |
| M10 | lane별 동시/재진입 settle | 각 lane당 terminal frame 정확히 1회 |

### inbound 통합 테스트

| # | 케이스 | 기대 |
| --- | --- | --- |
| I1 | A partial, boundary, B partial, final=B | A/B 두 버블, 서로 다른 ID, 순서 보존 |
| I2 | assistant 메시지 3개 | 라이브 세 버블, history와 같은 순서 |
| I3 | 단일 메시지 | 한 ID에서 partial→final, 기존 UX 유지 |
| I4 | final B가 A 문장을 인용/포함 | A와 B는 여전히 별도 버블 (`includes` 회귀 방지) |
| I5 | final B가 B partial을 전면 재작성 | B만 교체, A 불변 |
| I6 | A live 정착 `false`/throw | B final은 시도되고 성공 결과를 반환 |
| I7 | B final 실패 | 기존 P0-4 턴 outcome 계약 유지 |
| I8 | abort/clean resolve/error | 정착된 A 불변, 활성 lane만 settle, working 잔존 없음 |
| I9 | progress mode | tool scaffold는 휘발성, 답변은 원자적 final |
| I10 | block/off mode | 기존 append와 delivery 회계 무회귀 |

### 클라이언트 회귀 테스트

- 같은 `turnId`에서 ID A/B의 progress/final frame을 받으면 버블 2개가 유지된다.
- history snapshot의 A/B와 라이브 형상이 같은지 확인한다.

게이트:

```bash
npm run build
npm run typecheck
npx vitest run packages/plugin
npm test
```

---

## 11. 기각한 설계

| 설계 | 기각 사유 |
| --- | --- |
| draft snapshot 전체로 final | 데이터는 남지만 A/B가 한 버블이어서 history 형상과 다르다. B의 권위 있는 final 수정도 잃을 수 있다. |
| 턴 끝에 prefix를 잘라 새 버블로 전송 | 경계를 너무 늦게 복원하며 순서/ID/finalize latch가 복잡해진다. |
| `final.includes(previous)` 또는 suffix 검사 | 인용/반복/재포맷을 메시지 동일성으로 오판한다. core의 구조화된 경계를 버린다. |
| 모든 partial 프레임 영구 저장 | 보존 단위를 스트리밍 프레임으로 잘못 잡아 히스토리를 오염시킨다. |
| core 변경 | 필요한 경계와 index가 이미 있고 Telegram이 같은 계약으로 동작한다. 이 결함의 소유자는 WebChannel 플러그인이다. |
| 앞 버블 실패 시 턴 전체 실패 | 모델 실행 결과와 transport live-delivery 결과를 혼동한다. history 복구 경로도 있다. |

---

## 12. 범위 밖

- 히스토리 메시지 메타데이터 확장 → #95
- typing 신호 → #96
- 툴 활동 구조화 표면 → #97
- 승인 origin 라우팅 → #93
- reasoning lane의 별도 제품 정책

---

## 13. 완료 정의

- [ ] 한 턴의 완료된 assistant 메시지 N개가 라이브에서도 N개 버블로 남는다.
- [ ] 각 메시지는 고유 ID를 가지며 partial은 해당 활성 ID만 갱신한다.
- [ ] final은 마지막 메시지 ID만 확정하고 앞 버블을 변경하지 않는다.
- [ ] live와 history hydrate의 메시지 수/순서/본문이 일치한다.
- [ ] 메시지 동일성 판정에 `includes`/suffix/문자열 split을 사용하지 않는다.
- [ ] 앞 lane 전송 실패 후에도 마지막 final 전달이 시도된다.
- [ ] abort/error/단일 메시지/progress/block/off 경로에 회귀가 없다.
- [ ] build/typecheck/plugin tests/full tests가 모두 통과한다.

---

## 14. compact 이후 구현 시작점

이 문서 커밋 시점에는 **문서와 GitHub Issue만 수정됐고 production/test 코드는 아직 그대로다.** 다음 세션은 재조사보다 아래 순서로 바로 시작한다.

1. `packages/plugin/src/channel.test.ts`의 기존 “두 assistant 메시지가 한 ID에 합쳐진다” 테스트를 두 ID/두 버블 기대값으로 바꾸고, final이 앞 메시지를 인용하는 실패 테스트를 먼저 추가한다.
2. `packages/plugin/src/message-adapter.ts`의 턴 고정 `id`/`answerPrefix`를 lane별 ID와 settle latch로 교체한다.
3. `pushAnswerText`가 문자열만 받지 말고 `text`/`delta`/`replace`를 보존하도록 바꾼다.
4. `packages/plugin/src/inbound.ts`에서 partial/boundary/queued-block/delivery를 같은 직렬 queue에 넣고 `assistantMessageIndex`를 전달한다.
5. plugin 테스트가 green이 된 뒤 client의 다중 ID reducer 회귀 테스트와 전체 게이트를 실행한다.

구현 중 다시 열면 안 되는 결정:

- boundary/index가 메시지 소유권의 source of truth다. final 본문을 `includes`/suffix로 비교하지 않는다.
- `onBlockReplyQueued`는 같은 assistant index에 여러 번 올 수 있다. **block 하나를 메시지 하나로 가정하지 않는다.**
- settle latch는 턴별이 아니라 lane별이다.
- 앞 lane send 실패가 queue를 reject 상태로 고정하거나 마지막 final을 막아서는 안 된다.
- tool/item progress scaffold는 완료된 assistant 메시지가 아니다.

현재 코드에서 바로 볼 지점:

- `message-adapter.ts`: `const id = nextMessageId()`, `answerText`, `answerPrefix`, `handleAssistantMessageBoundary`, turn-wide `finalizeResult`
- `inbound.ts`: `onPartialReply`가 `p.text`만 넘기는 부분, `onAssistantMessageStart`, `draft.finalize(text)` final 분기
- `channel.test.ts`: `preserves earlier message text across an assistant-message boundary...` 테스트가 현재 잘못된 one-id 계약을 고정함

GitHub #94의 제목/본문도 이 문서와 같은 확정안으로 이미 갱신돼 있다.
