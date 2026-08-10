# Issue #94 — final 응답이 progress draft를 덮어써 앞선 어시스턴트 메시지를 파괴하는 문제

- 이슈: [#94](https://github.com/mir-stream/openclaw-webchannel/issues/94) (P1 / kind/bug / area/plugin)
- 상류 리포트: rota-crew#281-A (Rota 0.4.0 제품 리뷰)
- 브랜치: `mir-stream/issue-94` (base `develop`, 시작 커밋 `2bea2d8`)
- 리포트 기준 커밋 `7164006` 이후 15커밋은 #87/#89 턴-아웃컴 계열과 CI뿐이며, `delivery.deliver`의 finalize 분기는 **HEAD에서 그대로다** (2026-08-10 코드 레벨 확인 완료).

---

## 1. 의도 (Intent)

**사용자가 스트리밍 중 읽은 텍스트는 턴이 정착(settle)해도 사라지지 않아야 하며, 라이브 화면과 새로고침 후 화면이 같은 모양이어야 한다.**

`streaming.mode: "partial"`(= `setup_openclaw`의 기본값)에서 한 턴의 답변이 **여러 개의 어시스턴트 메시지**로 나뉘면, 지금은 전부 draft에 누적해 보여준 다음 `finalize(text)`가 **마지막 메시지 하나로 draft를 통째로 교체**한다. 화면에 있던 앞부분이 눈앞에서 지워진다. 이건 라이브 경로의 사용자 가시 데이터 손실이다.

이 변경이 소유하는 표면:
- `packages/plugin/src/inbound.ts`의 `delivery.deliver` 최종 전달 분기
- `packages/plugin/src/message-adapter.ts`의 progress draft controller (누적 상태 노출)

소유하지 **않는** 표면: 클라이언트(`packages/client`)는 변경하지 않는다. 히스토리 계약(`HistoryMessage`) 확장(#95), 툴 활동 표면(#97), typing 신호(#96).

---

## 2. 현상과 증거

전달 이음매(`delivery.deliver`)에서의 실측 — 들어온 payload와 그 시점 `draft.snapshotText()`를 나란히 찍은 것:

```
[PROBE deliver] kind=final len=440
  head="운영사업부 F/O 직원 12명을 확인했습니다.\n\n| # | 이름 | 입사일 | 상태 |…"
  draftSnap="운영사업부 F/O 직원 목록을 조회하겠습니다.\n\n운영사업부 F/O 직원 12명을 확인했습니다.\n\n| # |…"
  snapLen=467
```

- draft(=위젯이 보여주던 것) **467자**, 첫 문장 포함
- final payload **440자**, 첫 문장 없음
- `deliver`는 그 턴 통틀어 **정확히 1회** 호출 — 즉 앞 메시지는 non-final 블록으로도 우리에게 온 적이 없다

클라이언트 상태 전이(1ms 간격):

```
working=true   '…앞 문단… + 본문'
working=false  '본문'          ← 앞 문단 소실, messages.length 불변(버블 1개가 짧아짐)
```

같은 턴을 새 클라이언트가 히스토리에서 하이드레이트하면 **어시스턴트 메시지 2개**가 온전히 온다. 즉 **트랜스크립트가 옳고 라이브가 손실**이며, 동시에 **라이브 1버블 vs 하이드레이트 2버블**이라는 형상 불일치도 이미 존재한다.

---

## 3. 근본 원인 (현행 코드)

`packages/plugin/src/inbound.ts` (약 543–549행):

```ts
// Only the final reply replaces the draft. Non-final visible
// blocks (rare for this channel) fall through to a plain send.
if (draft && info?.kind === "final") {
  const sent = await draft.finalize(text);
  if (sent) finalReplyDelivered = true;
  return { visibleReplySent: sent };
}
```

주석의 전제 — "non-final 가시 블록은 따로 와서 plain-send 된다" — 가 **이 경로에서 성립하지 않는다**. core는 마지막 메시지만 final로 넘기고, 앞 메시지들은 `onPartialReply`를 통해 draft에만 흘러들어갔다.

한편 draft controller는 경계를 정확히 처리하고 있다 (`message-adapter.ts`):

```ts
let answerText = "";      // 현재 메시지의 누적 partial
let answerPrefix = "";    // 이미 완료된 메시지들 (…+ "\n\n")
const answerBody = () => answerPrefix + answerText;
```
- `handleAssistantMessageBoundary()` (365행)가 `rollCurrentIntoPrefix()`로 완료분을 prefix에 넘긴다
- 경계 이벤트가 늦거나 안 와도 `pushAnswerText`의 **missed-boundary 방어**(divergence 감지 → 자체 rollup, `absorbedMissedBoundaries`로 이중 롤 방지)가 같은 일을 한다
- `snapshotText()` (386행) = `hasPendingContent() ? composeText() : ""` → 467자의 출처

**즉 손실은 오로지 "replace-on-finalize" 한 스텝에서만 발생한다.** 정보는 프로세스 안에 온전히 살아있다.

---

## 4. 설계

### 4.1 채택안 — 완료된 앞 메시지들을 **각각의 정착 버블로 승격**하고, final은 새 버블로 붙인다

핵심 순서(그리고 이게 유일하게 순서가 맞는 조합이다):

```
draft.finalize(completed[0])          // 이미 화면에 있던 draft 버블 → 첫 어시스턴트 메시지로 확정
transport.sendText(wsKey, completed[1], undefined, turnId)   // 2개 이상이면 순서대로
…
transport.sendText(wsKey, text, undefined, turnId)           // core가 준 final = 마지막 버블
```

**왜 "prefix를 새 버블로 먼저 보내고 draft를 final로 finalize" 가 아닌가:** draft 버블은 클라이언트 리스트에 **이미 앞자리에 존재**한다. 새 `agent_message`는 꼬리에 append 된다(`nats-client-wrapper.ts:1486`, id 없는 프레임 → `a-<uid>`로 새 버블). 따라서 prefix를 새 프레임으로 보내면 **final 아래에 앞부분이 붙는** 뒤집힌 순서가 된다. draft를 앞부분으로 확정하고 뒤를 append 해야 시간순이 맞다.

부수 효과(의도된 것): 라이브 형상이 **N개 버블**이 되어 히스토리 하이드레이트 형상과 일치한다. 오늘 남아있는 "재접속 시 앞 문단이 별도 버블로 튀어나오는" 스냅샷 병합 불일치도 같이 사라진다.

### 4.2 controller 변경 — `answerPrefix: string` → 완료 메시지 **배열**

지금은 완료분이 `"\n\n"`로 이어붙은 단일 문자열이라 "메시지 몇 개였는지"를 복원할 수 없다. 트랜스크립트가 메시지 단위로 남는 이상 우리도 단위를 보존해야 한다.

```ts
// message-adapter.ts
const completedAnswers: string[] = [];              // 완료된 어시스턴트 메시지들
const answerPrefix = () => completedAnswers.length ? completedAnswers.join("\n\n") + "\n\n" : "";
const answerBody  = () => answerPrefix() + answerText;

const rollCurrentIntoPrefix = () => {
  if (answerText.length === 0) return;              // 기존 no-op 규칙 유지 (선행/중복 경계 방어)
  completedAnswers.push(answerText);
  answerText = "";
};
```

`answerBody()`의 문자열 결과는 **오늘과 바이트 단위로 동일**해야 한다 → `composeText()`/`snapshotText()`/기존 draft 렌더링/`flush` 동작은 무변경. 이건 순수 리팩터이며, 기존 message-adapter 테스트가 그대로 통과하는 것으로 증명한다.

새 읽기 전용 접근자 하나를 controller 타입에 추가:

```ts
/**
 * 이미 완료된 어시스턴트 메시지들의 텍스트(가장 오래된 것부터).
 * 진행 중인 메시지(answerText)는 포함하지 않는다. 부작용 없음.
 * 최종 전달 시점에 "draft가 들고 있으나 core의 final payload에는 없는 앞 메시지"를
 * 복원하기 위해 inbound.ts가 읽는다.
 */
completedAnswerTexts: () => readonly string[];
```

### 4.3 분기 조건 (중복 방지가 가장 중요한 부분)

`delivery.deliver`의 `kind === "final"` 경로에서:

```
completed = draft.completedAnswerTexts()

(a) completed 가 비었다                       → 오늘 그대로: draft.finalize(text)
(b) core가 이미 앞 메시지를 흡수했다           → 오늘 그대로: draft.finalize(text)
(c) 그 외                                    → §4.1 분할 전달
```

**(b)의 판정**: `text`가 `completed[0]`(trim 기준)를 **포함**하면 흡수된 것으로 본다.
- `includes` 기준을 쓰는 이유: 보수적이기 때문. 애매하면 오늘 동작으로 떨어지고, 최악의 경우가 "현행 유지"다. 반대로 관대하게 판정하면 **같은 문단이 두 번 보이는 새 결함**을 만든다 — 그쪽이 훨씬 나쁘다.
- `startsWith`만으로 판정하지 말 것: core가 앞에 상태 문구/공백을 덧붙일 수 있다.
- 비교 전 양쪽 `trim()`. 빈 문자열이 된 completed 원소는 애초에 배열에 들어가지 않는다(`rollCurrentIntoPrefix`의 no-op 규칙).

### 4.4 전달 결과 회계 (`visibleReplySent` / `finalReplyDelivered`)

- `visibleReplySent`와 `finalReplyDelivered`는 **최종 답변(`text`) 프레임의 전달 성패**를 따른다. 앞 버블 전송이 실패해도 final 전달은 반드시 시도하고, final이 성공했으면 `true`다.
- 앞 버블 전송 실패는 **삼키고 로그만** 남긴다 (`event=webchannel.deliver.prefix_drop …`). 여기서 예외를 던지면 답변 자체가 사라진다 — 오늘보다 나쁜 상태가 된다.
- `draft.finalize()`는 멱등이며 첫 호출 결과를 캐시한다(`message-adapter.ts:388`). 분할 경로에서도 finalize는 정확히 1회만 호출된다.
- P0-4 결정(“final 프레임 전송 실패가 `turn_settled{ok}`를 억제하지 않는다”)은 **유지**한다. 이 변경은 그 계약을 건드리지 않는다.

### 4.5 영향 없는 경로 (명시적으로 확인할 것)

| 경로 | 이유 |
| --- | --- |
| `streaming.mode: "progress"` / `block` / `off` | `pushAnswerText`가 안 불리므로 `completedAnswers`는 항상 비어 (a)로 떨어진다 |
| 단일 어시스턴트 메시지 턴 (대다수) | `completedAnswers`가 비어 (a) |
| 중단(abort)/에러 방어 finalize (`inbound.ts:580`, `:596`) | `snapshotText()`를 그대로 쓰므로 무변경 — 이 경로는 손대지 말 것 |
| `kind === "block"` 전달 | 분기 조건이 `kind === "final"`로 한정 |

---

## 5. 검토했으나 기각한 대안

| 대안 | 기각 사유 |
| --- | --- |
| **상류 이슈 제안 (1)**: final이 snapshot의 suffix면 snapshot으로 finalize | core가 최종 텍스트를 재포맷/정규화하면 suffix 검사가 조용히 실패해 **무음 무효화**된다. 게다가 라이브 1버블 vs 하이드레이트 2버블 불일치가 그대로 남는다 |
| **상류 이슈 제안 (2) 원안**: 앞부분을 별도 버블로 "먼저" 보내고 draft를 final로 finalize | 순서가 뒤집힌다 (§4.1). 채택안은 (2)의 의도를 순서가 맞는 형태로 구현한 것 |
| **상류 이슈 제안 (3)**: core가 모든 가시 어시스턴트 메시지를 `deliver`로 넘기게 | 계약상 가장 깨끗하지만 core 변경이 필요하고, 그 사이 손실은 계속된다. 본 변경은 core가 나중에 그렇게 바뀌면 §4.3(b)로 자동 폴백하므로 **상충하지 않는다** |
| draft를 아예 안 쓰고 매 메시지를 plain send | partial 스트리밍 UX(진행 중 갱신)를 버리는 회귀 |
| 클라이언트에서 마지막 draft 텍스트를 기억했다 병합 | 손실 지점이 서버 측인데 클라이언트에 보정 로직을 심는 것 = 잘못된 계층. 다른 소비 제품은 여전히 손실 |

---

## 6. 구현 계획 (파일별)

1. `packages/plugin/src/message-adapter.ts`
   - `answerPrefix: string` → `completedAnswers: string[]` (+ 파생 함수). **`answerBody()` 출력 불변**.
   - `ProgressDraftController` 타입에 `completedAnswerTexts: () => readonly string[]` 추가 + JSDoc.
   - `handleAssistantMessageBoundary`의 멱등/`absorbedMissedBoundaries` 규칙과 `pushAnswerText`의 missed-boundary rollup은 **동작 변경 없이** 새 표현으로 이식.
2. `packages/plugin/src/inbound.ts`
   - `delivery.deliver`의 `kind === "final"` 분기를 §4.3/§4.4대로 재작성.
   - 기존 주석("Only the final reply replaces the draft…")이 **틀린 전제**이므로 지우고, 왜 분할하는지·왜 순서가 이렇게 되는지·(b) 가드가 왜 보수적인지를 남긴다.
3. 테스트 (§7).

주변 코드가 "왜"를 길게 남기는 스타일이다. 그 밀도와 톤을 맞출 것.

---

## 7. 테스트 계획 (완료 기준)

### `message-adapter.test.ts`
| # | 케이스 | 기대 |
| --- | --- | --- |
| M1 | 기존 스위트 전부 | 무변경 통과 (리팩터 무해성 증명) |
| M2 | 경계 2회 + partial 스트림 | `completedAnswerTexts()` = 완료 메시지 2개, `snapshotText()`는 오늘과 동일 문자열 |
| M3 | 경계 이벤트 없이 divergent partial (missed-boundary) | 자체 rollup이 배열에 들어가고 이중 롤 없음 |
| M4 | 선행/중복 경계 (answerText 비어있음) | 빈 원소가 배열에 들어가지 않음 |

### `inbound.test.ts` — 이 이슈의 핵심 회귀
| # | 케이스 | 기대 |
| --- | --- | --- |
| I1 | partial 모드, 어시스턴트 메시지 2개, final payload = 두 번째만 | `finalizeDraft`가 **첫 메시지 텍스트**로 호출되고, 이어서 final 텍스트가 별도 `sendText`로 전송. **앞 문단이 어디에서도 소실되지 않음** |
| I2 | 어시스턴트 메시지 3개 | 버블 3개, 순서 = 스트리밍 순서 |
| I3 | 단일 메시지 턴 | 오늘과 동일: `finalizeDraft(final)` 1회, 추가 `sendText` 없음 |
| I4 | final payload가 앞 메시지를 이미 포함 | 분할하지 않음 (중복 렌더 방지 가드) |
| I5 | 앞 버블 `sendText` 실패 | final은 그대로 전달, `visibleReplySent === true` |
| I6 | final `sendText` 실패 | `visibleReplySent === false`, 그럼에도 `turn_settled{ok}`는 억제되지 않음 (P0-4 계약 유지) |
| I7 | progress/block 모드 | 오늘과 동일 경로 (분할 없음) |
| I8 | 중단(abort) 경로 | `snapshotText()` 기반 방어 finalize 동작 무변경 |

게이트:
```bash
npm run build && npm run typecheck && npx vitest run packages/plugin
```
최종 1회는 전체 `npm test`. 실패 0.

> ⚠️ 이 worktree는 자체 `node_modules`를 설치해 쓴다 (원본 workspace 심볼릭 링크 아님).

---

## 8. 리스크 / 함정

1. **중복 렌더가 이 변경의 최대 위험**이다. 같은 문단이 두 번 보이는 것은 손실보다 더 나쁘게 인지된다. §4.3(b) 가드를 보수적으로 유지하고 I4를 반드시 고정할 것.
2. **버블 순서**. §4.1의 순서를 어기면 답변이 뒤집힌다. I2로 고정.
3. **`finalize`는 멱등이고 캐시된다.** 분할 경로에서 finalize를 두 번 부르려는 유혹(앞 버블용, final용)에 넘어가면 두 번째는 조용히 캐시된 첫 결과를 돌려주고 **final이 사라진다**. final은 반드시 `sendText`로 나가야 한다.
4. **`turnId` 전파**. 새로 추가하는 `sendText`에 `turnId`를 반드시 넘길 것 — 클라이언트의 턴 상관(`finalizeDraftsForTurn`, 앵커 승격)이 이걸로 동작한다.
5. **missed-boundary 방어는 실전에서 도는 코드다.** 배열 이식 시 `absorbedMissedBoundaries` 카운팅을 깨뜨리면 텍스트가 이중으로 붙는다. M3로 고정.
6. `answerBody()` 결과가 한 글자라도 달라지면 기존 draft 렌더가 바뀐다 — M1이 그 감시탑이다.
7. 클라이언트는 건드리지 않는다. 클라이언트 변경이 필요해 보이면 그건 설계가 틀어졌다는 신호이니 멈추고 보고할 것.

---

## 9. 범위 밖 (발견 시 별도 이슈)

- `HistoryMessage`가 `{id, role, text, ts}` 4필드뿐이라 `turnId` 등이 재접속에서 소실되는 문제 → #95
- typing이 턴당 1회라 버블 사이 작업이 안 보이는 문제 → #96
- 툴 활동 구조화 표면 → #97
- 승인 origin 라우팅 → #93 (별도 worktree/브랜치)

---

## 10. 완료 정의

- [ ] M1–M4, I1–I8 green
- [ ] `npm run build && npm run typecheck && npm test` 실패 0
- [ ] 다중 어시스턴트 메시지 턴에서 **라이브 버블 수 == 히스토리 하이드레이트 버블 수**
- [ ] 어떤 경로에서도 같은 문단이 두 번 렌더되지 않음
- [ ] `inbound.ts`에 "non-final 블록은 따로 plain-send 된다"는 **틀린 전제 주석이 남아있지 않을 것**
