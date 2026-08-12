# Issue #95 — history 계약이 무엇을 보존하는지 확정한다

- 이슈: [#95](https://github.com/mir-stream/openclaw-webchannel/issues/95) (P2 / kind/design / area/plugin / area/client)
- 상류 리포트: rota-crew#280, #281, #283 (Rota 0.4.0 제품 리뷰)
- 브랜치: `mir-stream/issue-95` (base `develop`, 시작 커밋 `4613ee8`)
- OpenClaw 기준 버전: `2026.6.10`
- 관련: [#114](https://github.com/mir-stream/openclaw-webchannel/issues/114) (delivery mirror — 완전한 (a)의 비용), [#111](https://github.com/mir-stream/openclaw-webchannel/issues/111) (live 측 과다 생성), [#109](https://github.com/mir-stream/openclaw-webchannel/pull/109) (tool-calling fixture)

---

## 1. 고정 의도와 범위

**reload된 타임라인이 무엇을 보존하고 무엇을 보존하지 않는지 계약에 적어 넣는다.**

이슈는 두 답 중 하나를 요구했다. (a) `HistoryMessage`를 확장해 reload가 충실한 재구성이 되게 하거나, (b) hydration이 role과 text만 보존한다고 명시하거나.

**결론은 (b)를 기본으로 하되, transcript가 실제로 뒷받침할 수 있는 한 축에서만 (a)를 취한다.** 근거는 §5–§6에 있고, 핵심은 이것이다 — `turnId`는 **보낼 값 자체가 존재하지 않는다**. 게으름이 아니라 불가능이다.

이 변경이 소유하는 production 표면은 다음뿐이다.

- `packages/plugin/src/history.ts` — `failed` 파생
- `packages/plugin/src/channel-contract.ts` — wire 타입 + 계약 문서화
- `packages/client/src/nats-client.ts`, `types.ts` — client 측 타입 재선언
- `packages/client/src/nats-client-wrapper.ts` — `history` reducer의 fresh-insert / adopt 두 지점

`WEBCHANNEL_PROTOCOL_VERSION`은 **올리지 않는다**(§5.2). live 측 과다 생성 교정(#111), delivery mirror(#114), 슬래시 명령 durability는 범위 밖이다.

---

## 2. 전제와 그 출처

[`ISSUE_93_APPROVAL_ORIGIN_ROUTING_PLAN.md`](./ISSUE_93_APPROVAL_ORIGIN_ROUTING_PLAN.md) §2의 분류를 따른다. hash-named 내부 번들 경로(`dist/<name>-<hash>.js`)는 인용하지 않는다 — 매 빌드마다 바뀌고, 그것이 지금의 버전 핀을 만든 원인이다. 실제로 #113 조사에서 이 레포가 인용한 core 경로 71개 중 **34개가 핀된 버전에서 이미 죽어 있었다**.

**A. 계약 (`openclaw/plugin-sdk/*` export) — 설계 전제로 삼아도 된다**

| 전제 | 계약 표면 |
| --- | --- |
| transcript 메시지 shape는 `UserMessage` / `AssistantMessage` / `ToolResultMessage`다 | `openclaw/plugin-sdk/llm` export |
| `AssistantMessage.content`는 content block의 **리스트**다 (`TextContent` / `ThinkingContent` / `ToolCall`) | 같은 export |
| `AssistantMessage.stopReason`은 선언된 필드이고 `"error"`를 포함한다 (`StopReason`) | 같은 export |
| `TextContent`만 `.text`를 갖는다 — `ThinkingContent`는 `.thinking`, `ToolCall`은 이름/인자만 | 같은 export |
| `runtime.subagent.getSessionMessages`는 `{ messages: unknown[] }`를 준다 | `plugin-sdk` runtime 타입 |

마지막 줄이 §6.2의 근거다. 반환 원소에 **타입이 없다**.

**B. 우리 코드 — 읽어서 확인했고 우리가 소유한다**

| 전제 | 위치 |
| --- | --- |
| live `turnId`는 client가 보낸 `user_message.id`다 | `inbound.ts:220-222` |
| 턴 중간 status text는 progress draft로 흘러간다 | `inbound.ts:541-547` (`onPartialReply`) |
| 그 draft는 최종 답변으로 **덮인다** | `inbound.ts:629-633` (`draft.finalize`) |
| `extractText`는 `.text`를 가진 part만 올린다 | `history.ts:90-107` |
| user/agent 이외 role은 버려진다 | `history.ts:109-114` |
| id는 `__openclaw.id`, 없으면 `h-{ts}-{idx}` 합성 | `history.ts:130-134` |
| `pageBefore` 커서는 `id` 문자열 일치로 찾는다 | `history.ts:307`, `:321` |
| reducer는 `wireId === turnId`로 user bubble을 승격한다 | `nats-client-wrapper.ts:1916` (`promoteAnchor`) |
| protocol 불일치는 양방향 terminal이다 | `nats-register.ts:392-398`, `nats-client.ts:1878-1887` |
| 슬래시 명령은 평범한 `user_message`로 나간다 (특별 처리 없음) | `demo/web/src/widget.ts:340-344` |

**C. 관찰된 core 동작 — 설계 전제가 아니라 테스트로 고정할 대상**

내부 구현을 읽어 알아낸 것이다. 번들 경로를 근거로 남기지 않고, 핀된 devDependency에 대해 §7의 테스트가 고정한다. 깨지더라도 **fail-safe** 하도록 설계했다(각 항목의 마지막 문장).

1. **core는 assistant 메시지를 "모델 스텝마다" 하나씩 append 한다.** 사용자에게 보이는 턴 하나가 아니다. tool round가 N번이면 assistant 메시지는 N+1개다. → §3.
2. **턴 중간 스텝은 짧은 status text를 `toolCall` 블록과 같은 `content` 리스트에 함께 담는 일이 흔하다.** → §3.
3. **내용을 만들지 못하고 실패한 턴은 `stopReason:"error"`인 진짜 assistant 메시지로 저장되며**, 고정된 sentinel 문자열을 text로 갖는다. → §4.2. 우리는 `stopReason`(계약)만 읽고 sentinel 문자열은 **매칭하지 않는다**.
4. **session-messages 읽기 경로는 display projection을 적용하지 않는다.** 그래서 sentinel이 그대로 온다. → §6.3.
5. **읽기 경로가 `__openclaw` 봉투를 붙이며 최소한 `id`를 담는다.** 이 봉투 shape는 `openclaw/plugin-sdk/*` 어디에도 선언되어 있지 않다. → §6.2. 없으면 `h-{ts}-{idx}`로 degrade 한다.
6. **transcript 메시지 어디에도 두 assistant 메시지를 한 agent 턴으로 묶는 필드가 없다.** → §6.1.
7. **core는 슬래시 명령의 사용자 입력도, 그 결과도 transcript에 쓰지 않는다.** → §4.3.

---

## 3. transcript는 무엇에 대해 canonical인가 — 범위를 좁힌 정의

이 절이 이 문서에서 가장 중요하다. **"transcript가 canonical"을 "row 집합 = utterance 집합"으로 읽으면 틀린다.**

**transcript는 순서(order)와 경계 정체성(boundary identity)에 대해 canonical이다. row 집합의 크기에 대해서는 아니다.**

live 경로를 정답으로 쓸 수 없다는 것이 출발점이었다. #111이 문서화한 대로 live는 bubble을 **과다 생성**할 수 있다(측정: assistant 메시지 2개가 bubble 4개로 정착). 그래서 저장된 transcript를 기준으로 삼았다. 그러나 측정해 보니 **transcript도 row를 과다 생성한다** — 방향만 다를 뿐이다.

> **증거의 성격 — 아직 합성이다.** 이 절의 근거는
> `packages/plugin/src/history-utterance-correspondence.test.ts`의 **합성 픽스처**다.
> 계약 타입(`AssistantMessage`/`ToolResultMessage`/`ToolCall`, `openclaw/plugin-sdk/llm`)
> 으로 조립했고 mutation으로 고정했지만, **실제 에이전트 루프가 이 shape을 만들어내는
> 것을 아직 관측하지 못했다.** 라이브 확인은 [#109](https://github.com/mir-stream/openclaw-webchannel/pull/109)의
> tool-calling fixture가 머지된 뒤에 한다. 둘이 어긋나면 화해시키지 않고 **어긋났다는
> 사실을 보고**한다 — 합성 쪽을 실측에 맞춰 고치는 순간 이 절은 근거를 잃는다.

`packages/plugin/src/history-utterance-correspondence.test.ts`가 고정한 실측:

```
user       "which agents are configured?"
assistant  [text "Let me check that.", toolCall agents_list]   stopReason toolUse
toolResult "alpha, beta, gamma"
assistant  [text "You have three agents: alpha, beta, gamma."]  stopReason stop
```

- **live: bubble 1개.** "Let me check that."는 progress draft로 들어갔다가(`inbound.ts:541-547`) 최종 답변에 덮인다(`inbound.ts:629-633`). 정착한 bubble이 아니다.
- **transcript: agent row 2개.** C1 + C2 때문에 별도 메시지로 저장되고, `extractText`가 `.text`를 올린다.

즉 **reload 하면 턴 중간 status 줄이 영구 bubble로 승격된다.** 모델링상의 흠이 아니라 실제 reload 충실도 결함이다.

### 3.1 발산의 원인은 정확히 하나다

인접한 shape들은 모두 대응을 보존한다는 것도 같이 고정했다.

| shape | 결과 | 이유 |
| --- | --- | --- |
| `toolCall`만 있는 스텝 | row 없음 | `.text`가 없어 `extractText`가 ""를 준다 |
| `thinking`만 있는 스텝 | row 없음 | `.thinking`은 `.text`가 아니다 |
| `toolResult` | 타임라인에 없음 | role 필터에서 탈락 (tool 출력이 bubble로 새지 않는다는 증명도 겸한다) |
| 다단계 턴의 상대 순서 | 보존됨 | — |

**유일한 발산 원인: `toolCall`과 같은 스텝에 실린 턴 중간 assistant text.** "row ≠ utterance"라는 막연한 걱정을 검증 가능한 한 문장으로 좁힌 것이고, 덕분에 #109의 tool-calling fixture로 하는 실측이 낚시가 아니라 뾰족한 테스트가 된다.

### 3.2 그래서 hydration 계약은 두 가지를 다르게 요구한다

- **cold reload**(빈 상태로의 hydration) — row 하나당 bubble 하나, row 순서 그대로. **이것이 계약이다.**
- **mid-session snapshot**(live bubble 위로 떨어지는 경우) — 중복도 유실도 없이 row 순서로 **수렴**해야 한다.

row가 live bubble보다 많을 때 수렴은 필연적으로 live bubble의 text를 **고쳐 쓰고** 뒤에 덧붙이는 형태가 된다. 실측(probe)으로 확인한 실제 동작이다.

```
BEFORE  [user "which agents…"(u-0), agent "You have three…"(webchannel-1)]
AFTER   [user "which agents…"(core-1), agent "Let me check that."(core-2), agent "You have three…"(core-3)]
```

`core-2`가 live bubble을 adopt 하면서 text를 답변에서 status 줄로 **바꿔 썼고**, `core-3`이 새로 삽입됐다. 최종 상태는 cold reload와 정확히 같다(테스트가 그 등가를 고정한다). 다만 **사용자 눈앞에서 bubble의 내용이 바뀐다.** 바람직하다고 주장하지 않는다 — 특성화해서 적어 둘 뿐이다.

---

## 4. 네 가지 특성화

### 4.1 transcript는 assistant utterance마다 정확히 row 하나를 주는가

**아니다.** §3이 답이다. `sanitizeHistoryText`가 row를 **버리는** 것이 대응을 깨뜨리는 주범일 것이라는 초기 가설은 **틀렸다**. 측정 결과 버려지는 것은 전부 live에서도 bubble이 아니었던 것들이다(`NO_REPLY`만, `[tool calls omitted]`만, tool-call만, think만, 내부 컨텍스트만, 공백만). 즉 그 drop은 C1의 모델-스텝 단위 저장을 **교정**하는 쪽으로 작동한다. 실제 발산은 §3.1의 한 가지 shape에서 나온다.

### 4.2 내용 없이 실패한 턴은 무엇이 남는가

**`stopReason:"error"`인 진짜 assistant 메시지가 남는다**(C3). 그리고 그것은 계약 필드이므로 우리가 읽어도 안전하다 → §5.1의 `failed`.

이슈가 지적한 부분적 예외가 성립한다. 다만 **간극은 여전하다**: RPC 오류처럼 assistant 메시지가 **아예 쓰이지 않는** 경로는 남길 것이 없다. 그 경로를 메우려면 #114의 delivery mirror가 필요하다.

### 4.3 슬래시 명령은 wire와 transcript에 무엇을 남기는가

**wire에는 남는다. transcript에는 양쪽 다 남지 않는다.**

이슈의 서술("로컬 렌더링, wire에 나가지 않음")은 Rota 위젯 기준이고 **이 레포에는 해당하지 않는다**. 여기서 슬래시 명령은 평범한 `user_message`로 나간다(`demo/web/src/widget.ts:340-344`). 플러그인이 가로채는 것은 control-lane 라우팅용 `/stop`뿐이다(`control-lane.ts:58`).

그러나 core는 명령을 agent run 이전에 처리하고 반환하므로, **사용자의 `/command`도 그 결과도 transcript에 쓰이지 않는다**(C7). 결과적으로 **reload하면 교환 전체가 사라진다.** 이슈의 프레이밍보다 강하고, 테스트하기도 쉽다.

**Telegram은 이 문제를 delivery mirror로 푼다** — 전달된 assistant 답변을 합성 메시지로 transcript에 되써 넣는다. WebChannel에는 그 장치가 없다. 비용까지 정리해 [#114](https://github.com/mir-stream/openclaw-webchannel/issues/114)로 분리했다. #95는 손실을 **기록만** 한다.

### 4.4 transient 분류 (Telegram 기준)

Telegram 구현을 읽고 분류했다. 넷 다 **휘발성이며 transcript에 닿지 않는다**.

| transient | Telegram이 하는 일 | 지속되는가 |
| --- | --- | --- |
| typing | `sendChatAction("typing")` | 아니오 |
| reasoning preview | 전용 draft 레인, 메시지를 수정했다가 **삭제** | 아니오 |
| tool progress | 답변 draft 미리보기에 렌더, placeholder는 **삭제** | 아니오 |
| `wireId` / receipt | 전송 계층 내부 | 아니오 |

이는 이 레포가 이미 내려 둔 결정과 일치한다 — `docs/P1_REASONING_LANE_PLAN.md`가 reasoning을 "의도적으로 휘발성이며 새 로드 후 사라진다"고 이미 적어 두었다(§321, §330-331, §408). #95는 그 결정을 **wire 계약으로 끌어올려** 확정한다.

---

## 5. 계약 변경

### 5.1 `failed` — 추가한다

```ts
export type HistoryMessage = {
  id: string; role: "user" | "agent"; text: string; ts?: number;
  failed?: boolean;
};
```

계약 필드 `AssistantMessage.stopReason === "error"`에서만 파생한다. 내부 상수 의존이 **없다**.

**false일 때는 필드를 아예 생략한다.** "실패 아님"의 표현이 하나뿐이게 하려는 것이고, 그래야 구버전 플러그인의 row와 byte 단위로 같아진다.

**명시하는 degradation:** 구버전 플러그인은 이 필드를 보내지 않으므로, **부재는 "실패 아님"과 구분되지 않는다.** 구버전 + 신버전 client 조합에서 실패한 턴은 평범한 bubble로 보인다 — 정확히 오늘의 동작이다. 이것을 tri-state로 만들지 않는다. 다만 "필드가 hop을 건너며 조용히 사라진다"는 것이 #95가 제기된 바로 그 불만이므로, **새 사례를 적어 두지 않고 도입하지는 않는다.**

에러 상세(`errorMessage` / `errorCode`)는 **wire에 싣지 않는다**. live에서 보여준 적 없는 provider 문자열이다. 테스트가 유출을 막는다.

### 5.2 protocol version은 올리지 않는다

핸드셰이크는 **협상 없는 엄격한 동등 비교**이며 양방향 terminal이다(`nats-register.ts:392-398`, `nats-client.ts:1878-1887`). 따라서 **bump는 배포된 모든 client↔plugin 쌍을 즉시 깨뜨리고**, 양쪽이 함께 재배포될 때까지 복구되지 않는다. bump는 안전한 선택이 아니라 **비싼 선택**이다.

선언된 규칙 자체가 더 좁다 — `protocol.ts:4-7`은 "backward-compatible 하지 **않은**" 변경으로 한정한다. 그리고 backward-compatibility는 양쪽 다리에서 성립한다.

- 전송 계층에 스키마가 없다. 봉투는 `JSON.stringify` / `JSON.parse` 왕복이고 필드 allowlist가 없다.
- 신 plugin → 구 client: reducer는 알려진 필드로 새 객체를 만들 뿐 입력을 열거하지 않는다. 모르는 필드는 **거부가 아니라 무시**된다.
- 신 client → 구 plugin: 새 필드는 optional이고 부재가 처리된다.

**단, 이것은 일회성 판독이 아니라 유지되는 불변식이어야 한다.** #95는 v3 이후 **최초의** 추가 wire 변경이다(`channel-contract.ts`는 v3 bump 이후 커밋이 0건이었다). 그래서 그 성질을 §7.3의 테스트로 고정했다.

---

## 6. 채택하지 않은 것과 그 이유

### 6.1 `turnId` — (b). 보낼 값이 존재하지 않는다

이슈는 "`turnId`만으로도 grouping 절반은 풀리고, 순수 추가 필드다"라고 했다. wire 상으로는 추가지만 **producer 쪽에서 구현 불가능**하다.

1. live `turnId`는 **client가 만든 `user_message.id`**다(`inbound.ts:220-222`). core는 그 값을 저장하지 않는다.
2. transcript 메시지 어디에도 두 assistant 메시지를 한 agent 턴으로 묶는 필드가 없다(C6). 유일한 구조적 연결은 entry 수준의 부모 참조인데, 읽기 경로가 그것을 노출하지 않는다.

즉 넣을 값이 없다. 억지로 다른 식별자를 그 이름에 넣으면 **네임스페이스가 섞인다** — 위젯이 live bubble과 hydrate된 row를 같은 키로 묶게 되고, `promoteAnchor`가 user bubble의 `wireId`를 `turnId`와 대조하므로(`nats-client-wrapper.ts:1916`) 단순한 미관 문제가 아니라 live 경로의 위험이 된다.

테스트가 고정하는 것은 그 **귀결**이다(테스트가 정직하게 고정할 수 있는 것은 그것뿐이다): 구조가 다른 두 transcript — 다단계 턴 하나 vs. 별개의 턴 둘 — 이 **byte 단위로 같은 agent row**로 환원된다.

**그래서 reload 후 turn grouping은 복원할 수 없다.** 계약 타입에 이 이유를 적어 두었다.

### 6.2 `seq` — 보류한다

`__openclaw.seq`는 단조 증가하는 transcript 서수이고, 취약한 `h-{ts}-{idx}` 합성을 은퇴시킬 후보였다. **보류한다.**

- id **값**을 바꾸면 tier-1 중복 제거와 `pageBefore` 커서(`history.ts:307`, `:321`)가 구버전 id를 들고 있는 client에서 깨진다 → 타임라인 중복. #95가 막으려는 결함의 바로 그 부류다.
- 그래서 합성 은퇴를 미루면, 남는 것은 **소비자가 없는 필드를 위해 타입 없는 봉투(A의 마지막 줄)에 새로 의존하는 것**뿐이다.

소비자가 생기면 다시 본다. 그때의 첫수는 **상류에 `getSessionMessages`의 반환 타입을 선언해 달라고 요청하는 것**이지, 선언되지 않은 의존을 더 깊게 만드는 것이 아니다.

### 6.3 sentinel 표시 — 알려진 결함으로 남긴다

내용 없이 실패한 턴은 core의 sentinel 문자열을 text로 갖고(C3), 읽기 경로가 display projection을 적용하지 않으므로(C4) **그 내부 문자열이 사용자에게 그대로 보인다.** core 자신의 chat UI는 사람이 읽을 문구로 바꿔 보여준다.

**#95는 고치지 않는다.** sentinel도 core의 대체 문구도 **내부 상수**다. 매칭 지점을 client로 옮겨도 의존이 사라지지 않고 옮겨질 뿐이며, 얻는 것은 미관뿐이다. 깨끗한 부분만 내보내고 지저분한 부분은 이름을 붙여 남긴다.

비용을 매긴 선택지 둘:

1. **client 측 문자열 매칭** — 작지만 내부 상수 의존. core가 문자열을 바꾸면 오늘 동작으로 degrade.
2. **상류 요청** — session-messages 읽기에 display projection을 달아 달라고 한다. #114와 같은 부류의 간극이며, 근본 해결.

---

## 7. 무엇을 테스트가 고정하는가

### 7.1 `packages/plugin/src/history-utterance-correspondence.test.ts` (12)

§3의 실측(row가 utterance보다 많다), §3.1의 경계 shape 4종, `failed` 파생과 생략, user row 비오염, 에러 상세 비유출, 봉투에서 `id`만 읽는다는 사실, 그리고 §6.1의 귀결.

### 7.2 `packages/client/src/nats-client-wrapper-hydration.test.ts` (14)

cold reload = row당 bubble 하나(계약), 결정성, 멱등성, 동일 text 인접 row의 분리 유지, 페이지네이션 순서, tier-3 positional 양방향(정상 경로 + row가 bubble보다 많은 경우), working draft 비침해, `failed` 전파와 adopt/cold 등가.

### 7.3 추가 필드 불변식 — 범위를 정직하게 적는다

reducer에는 모르는 필드를 **받아들이는** 코드가 없다. 알려진 필드로 새 객체를 만들 뿐 입력을 열거하지 않아서 **누락에 의해** 무시될 뿐이다. 그러므로 이 테스트는 "설계된 능력"의 증명이 아니라, **나중에 누군가 엄격한 validator를 넣어 거부하게 되는 것을 잡는 회귀 가드**다. 그 validator가 들어오는 순간 조용히 protocol bump가 강제되기 때문에 가드가 필요하다.

### 7.4 mutation 확인

모든 테스트를 production 코드를 실제로 망가뜨려 실패시키는 것으로 확인했다(`history.ts` 7종, `nats-client-wrapper.ts` 11종, `failed` 관련 6종). 한 가지를 기록해 둔다 — "반복 reload 결정성" 테스트는 처음에 **모든** mutation을 통과했다. 양쪽이 아무것도 hydrate 하지 않으면 동등성이 **공허하게** 성립하기 때문이다. 비어 있지 않음을 함께 단언하도록 고친 뒤에야 공유 상태 mutation에 죽었다.

---

## 8. 남은 작업

| 항목 | 상태 | 비고 |
| --- | --- | --- |
| live↔hydrate 등가, adoption tier 수정 | **보류** | #111의 live 과다 생성이 좁혀질 때까지. 4-bubble live를 2-row transcript와 비교하면 엉뚱한 쪽을 "고치게" 된다 |
| §3 실측의 실장비 확인 | 대기 | #109의 tool-calling fixture 재사용. **합성 테스트와 실측이 어긋나면 그 어긋남 자체가 가장 값진 산출물이다** — 조정하지 말고 보고할 것 |
| 슬래시 명령 durability | #114 | mirror 없이는 불가능 |
| RPC 실패 경로 durability | #114 | assistant 메시지가 쓰이지 않는 경로 |
| sentinel 표시 | §6.3 | 상류 요청이 근본 해결 |
| `seq` / id 합성 은퇴 | §6.2 | 소비자가 생기면. 첫수는 상류 타입 선언 요청 |
