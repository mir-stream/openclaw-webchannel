# Issue #94 — partial draft가 어시스턴트 메시지 경계를 잃고 마지막 메시지로 덮이는 문제

- 이슈: [#94](https://github.com/mir-stream/openclaw-webchannel/issues/94) (P1 / kind/bug / area/plugin)
- 상류 리포트: rota-crew#281-A (Rota 0.4.0 제품 리뷰)
- 브랜치: `mir-stream/issue-94` (base `develop`, 시작 커밋 `2bea2d8`)
- 계약 기준: `openclaw/plugin-sdk`의 export 표면. §5의 심볼은 `2026.6.10`(peer floor)과 `2026.7.1-2`(현 npm latest) 양쪽에서 **선언이 동일함을 확인**했다. 따라서 이 변경은 devDependency 상향도 `minGatewayVersion` 상향도 요구하지 않는다.
- 상태: 제품 의미론 결정 완료, 계약 검증 완료, 구현 전

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
| `onBlockReplyQueued(payload, ctx)` | block이 논리적으로 방출된 시점의 **동기** 알림이다. `ctx.assistantMessageIndex`가 있으면 어느 어시스턴트 메시지 소유인지도 안다. | 활성 lane에 순서대로 기록한다. 소유권 판정에 내용 비교를 쓰지 않는다. |
| `delivery.deliver(..., { kind:"block" })` | core가 전달하는 가시 어시스턴트 block이다. **`info`는 `kind`뿐이라 소유권 정보를 담지 않는다**(§5.2). | partial 모드에서는 이미 lane에 반영된 텍스트이므로 회계만 하고 버블을 만들지 않는다. |
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

## 5. core 계약이 주는 것과 주지 않는 것

경계 신호는 계약 표면에 있다. 다만 **index를 읽을 수 있는 자리는 하나뿐**이고, 그 자리는 delivery 이음매가 아니다. 설계는 이 비대칭 위에 세운다.

### 5.1 계약이 주는 것 — `openclaw/plugin-sdk/reply-runtime`

`GetReplyOptions`가 이 경로로 export되고, 콜백들은 그 안에 선언돼 있다.

```ts
type PartialReplyPayload = Pick<ReplyPayload, "text" | "mediaUrls"> & {
  delta?: string;
  replace?: true;
};

onPartialReply?: (payload: PartialReplyPayload) => Promise<void> | void;

/** Called when a new assistant message starts (e.g., after tool call or thinking block). */
onAssistantMessageStart?: () => Promise<void> | void;

/** Called synchronously when a block reply is logically emitted, before async
 *  delivery drains. Useful for channels that need to rotate preview state at
 *  block boundaries without waiting for transport acks. */
onBlockReplyQueued?: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;

type BlockReplyContext = {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /** Source assistant message index from the upstream stream, when available. */
  assistantMessageIndex?: number;
};
```

- `onAssistantMessageStart`는 새 어시스턴트 메시지가 시작됐음을 알린다.
- `replace:true`는 **같은 현재 메시지**의 교체 갱신임을 알린다.
- `onBlockReplyQueued`는 **동기**로, 비동기 전달이 drain되기 전에 온다. JSDoc이 밝힌 용도가 정확히 "block 경계에서 preview 상태를 회전시키려는 채널"이다. 이 설계는 계약이 허용하는 정도가 아니라 이 훅의 명시된 목적 위에 있다.
- `assistantMessageIndex`는 `BlockReplyContext`에만 있고, `when available`로 optional이다.

### 5.2 계약이 주지 않는 것 — delivery 이음매에는 index가 없다

WebChannel이 쓰는 전달 이음매는 `ChannelEventDeliveryAdapter`이고, 그 `info`는 `kind` 하나뿐이다.

```ts
type ChannelEventDeliveryAdapter = {
  deliver: (payload: ReplyPayload, info: ChannelDeliveryInfo) => Promise<ChannelDeliveryResult | void>;
  // ...
};
type ChannelDeliveryInfo = { kind: ReplyDispatchKind };   // 이게 전부다
```

`assistantMessageIndex`를 담은 `ReplyDispatchRuntimeInfo`는 **별개 타입**이다. `ReplyDispatcher.appendBeforeDeliver` 훅용이고 `plugin-sdk`에서 export되지 않는다. index를 payload 메타데이터에서 뽑는 `getReplyPayloadMetadata`도 미노출이다.

`2026.6.10`과 `2026.7.1-2`에서 동일하다. **버전 문제가 아니라 이음매가 원래 그렇게 생겼다.** 따라서 `deliver` 시점에 index로 lane을 찾는 설계는 어느 버전에서도 성립하지 않는다.

### 5.3 Telegram을 근거로 쓰지 않는다

core의 Telegram 채널은 delivery 이음매에서 `info.assistantMessageIndex`를 실제로 읽는다. 그러나 Telegram은 core에 번들된 내부 채널이라 공개 플러그인 계약보다 넓은 이음매를 쓴다. **플러그인이 설 수 있는 자리가 아니므로 설계 근거로 인용하지 않는다.** 참고 가치는 "core가 메시지 경계를 실제로 보존한다"는 사실까지다.

### 5.4 계약 밖에 남는 가정

다음 두 가지는 계약이 보장하지 않는다. JSDoc에 순서 규정이 없다.

- `onAssistantMessageStart`가 그 메시지의 첫 `onPartialReply`보다 먼저 온다.
- `onPartialReply.text`가 itemId별 누적이라 다음 메시지에서 `""`로 재시작한다.

이건 #23이 이미 지적한 unpinned cross-package 가정이다. §6.5 fail-safe가 방어하는 대상이 바로 이 둘이며, 새로운 계약 밖 가정을 추가로 도입하지 않는다.

따라서 core가 단순 문자열만 쏟아내서 관계를 알 수 없는 문제가 아니다. **WebChannel이 제공된 경계를 버리고 ID 하나에 합친 것이 문제다.** 이 이슈에서 core는 바꾸지 않는다.

---

## 6. 채택 설계 — 메시지 경계에서 lane을 정착하고 회전한다

### 6.1 정상 시퀀스

```text
onAssistantMessageStart()             # 첫 메시지: 빈 lane이므로 회전 없음
onPartialReply(A1)                    # progress(id=A, text=A1)
onPartialReply(A2)                    # progress(id=A, text=A2)
onBlockReplyQueued(A, index=0)        # 활성 lane에 block payload 기록 (동기)

onAssistantMessageStart()             # A를 id=A로 정착, 새 lane으로 회전
onPartialReply(B1)                    # progress(id=B, text=B1), A와 다른 ID
onPartialReply(B2)                    # progress(id=B, text=B2)
delivery.deliver(payload=B, {kind:"final"})   # agent_message(id=B) — 활성 lane 정착
```

라이브 결과는 `[A 버블, B 버블]`이고 히스토리도 `[A 메시지, B 메시지]`다.

**lane 소유권은 콜백 축이 전부 결정한다.** `deliver`는 `kind` 하나만 받으므로(§5.2) lane을 식별하지 않고 **활성 lane에만** 작용한다. 회전은 `onAssistantMessageStart`가, block 소유권 기록은 `onBlockReplyQueued`가 담당한다.

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
2b. **회전한 lane은 실제 어시스턴트 텍스트가 생기기 전까지 `progress` 프레임을 보내지 않는다.** 프로토콜에 버블 삭제 프레임이 없어서(`OutboundWsMessage`에 `progress`/`agent_message`만 있음) 한 번 보낸 id는 반드시 `agent_message`로 정착시켜야 한다. 회전 직후 툴 스캐폴드를 그 lane으로 내보내면 abort 시 스캐폴드 텍스트가 담긴 버블이 강제로 남아 §7("스캐폴드는 완료된 어시스턴트 메시지가 아니다")을 어긴다. 따라서 회전 후의 툴 진행 표시는 억제하고, 메시지 사이 작업의 가시성은 #96에서 다룬다. **첫 lane의 스캐폴드 동작은 지금 그대로 유지한다**(무회귀).
3. partial은 활성 lane만 갱신한다. `replace:true`도 활성 lane 안에서만 본문을 교체한다.
4. 경계가 오면 이전 lane에 실제 어시스턴트 텍스트가 있는 경우만 정착한다. partial이 있으면 사용자가 마지막으로 본 정제된 cumulative snapshot을 쓴다. partial이 없었다면 그 lane에 기록된 queued block payload들을 순서대로 이어 본문으로 쓴다. block 하나를 곧바로 assistant 메시지 전체라고 가정하지 않는다.
5. **`assistantMessageIndex`는 `onBlockReplyQueued`에서만 읽는다.** 용도는 두 가지로 한정한다 — (a) 기록하는 block이 활성 lane 소유인지 대조, (b) 경계 누락 진단 로그. index가 없으면(`when available`) 콜백 직렬 순서와 내부 generation으로 대체한다. **delivery 이음매에는 index가 없으므로**(§5.2) 그쪽 상관에는 쓰지 않는다.
6. **`deliver`는 lane을 식별하지 않고 활성 lane에만 작용한다.**
   - `kind:"final"` → 활성 lane을 정착한다. final은 정의상 현재/마지막 메시지의 최종형이므로 활성 lane이 곧 대상이다.
   - `kind:"block"` → partial 모드에서 그 텍스트는 이미 partial로 활성 lane에 들어와 있다. 전송 결과만 회계하고 **새 버블을 만들지 않는다.** 회전이 이미 일어난 뒤 늦게 drain된 block도 같은 규칙으로 중복이 생기지 않는다 — 앞 lane은 이미 자기 본문으로 정착했기 때문이다.
   - draft lane이 없는 모드(block/off)는 기존 plain append 경로를 그대로 유지한다.
   - 이 규칙은 index도, 텍스트 비교도, queue↔delivery 순서 일치 가정도 요구하지 않는다. dedupe는 lane 상태 자체가 수행한다.
7. final이 오기 전에 현재 lane이 화면에 나오지 않았어도 final용 새 ID 하나로 버블을 append/정착할 수 있어야 한다.
8. 정착 latch는 턴 전체가 아니라 lane별이다. A를 정착한 뒤에도 B를 별도로 정착할 수 있어야 한다.

### 6.3 callback과 delivery를 하나의 직렬 queue로 처리한다

core callback 타입이 Promise를 허용해도 모든 호출자가 그 Promise를 기다린다는 전제에 기대지 않는다. 아래 작업을 한 queue에 넣는다.

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

`final`이 앞 메시지를 인용하거나 반복해도 boundary가 갈랐으면 별도 버블이다. final이 현재 메시지를 재포맷해 partial과 크게 달라져도 같은 lane만 교체한다.

### 6.5 contract 위반에 대한 방어

정상 소유권은 구조화된 이벤트가 결정한다. 다만 `onAssistantMessageStart`가 누락된 비정상 stream에서도 이미 화면에 보인 텍스트를 조용히 덮지는 않는다.

- `replace:true`: 명시된 같은-message 교체이므로 활성 lane을 갱신한다.
- `replace`가 아닌 cumulative partial이 기존 본문을 확장하지 않고 갑자기 갈라짐: boundary 누락으로 진단 로그를 남기고 기존 lane을 보존한 뒤 새 lane으로 회전한다.
- 뒤늦은 boundary: 이미 방어 회전한 generation을 다시 회전시키지 않는다.

이 방어는 final과 앞 메시지의 의미를 내용으로 추측하는 로직이 아니다. 구조화된 `replace` 계약이 깨졌을 때 **이미 표시한 데이터를 보존하는 실패 안전장치**다.

#### 6.5.1 방어 회전과 history 형상

방어 회전이 도는 정상 경로에서는 core가 실제로 새 어시스턴트 메시지를 시작했는데 경계만 누락한 것이므로, core transcript에도 메시지가 둘 있다. 즉 라이브 2 = history 2로 형상이 어긋나지 않는다.

어긋나는 경우는 하나뿐이다 — **같은 메시지를 재작성하는 partial이 `replace:true` 없이 왔는데 방어 회전이 오작동**하면 라이브 2 / history 1이 된다. 이 발산은 **수용한다.** 데이터 유실(#94 본체)보다 중복 표시가 낫다. 대신 두 가지를 요구한다.

- 방어 회전은 **반드시 contract-violation 진단 로그를 남긴다.** 로그 없는 조용한 회전은 금지한다.
- `replace:true` 경로는 **절대 회전하지 않는다**(M4/M7로 고정). 오작동 가능 구간을 `replace` 표시가 없는 divergence 하나로 좁힌다.

이 수용은 §13의 "라이브 = history" 항목에 대한 명시적 예외다.

**수용의 실제 비용 (실측, 2026-08-10).** 초안은 "재접속 시 history가 정본으로 수렴시킨다"고 적었으나 **틀렸다.** tier-3 화해는 채택하거나 삽입할 뿐 **잉여 로컬 버블을 제거하지 않는다.** 로컬 `[u, A, B, C]`(B/C가 같은 메시지) 대 스냅샷 `[core-u1, core-a1≈A, core-a2≈C]`를 합성 프레임으로 돌린 결과:

```
라이브 세션 재접속: [core-u1, core-a1, core-a2("C 재작성"), webchannel-c("C 재작성")]
스냅샷 재전달:      동일 — 중복이 해소되지 않는다
전체 리로드(빈 상태): [core-u1, core-a1, core-a2]   ← 여기서만 수렴
```

`core-a2`가 anchor 체인을 타고 **로컬 B**에 채택되고 로컬 C가 남아, 재작성된 메시지가 **세션 내내 두 번 보인다.** 전체 리로드에서만 사라진다.

수용 결론은 유지한다 — 중복 표시는 여전히 데이터 유실보다 낫다. 다만 비용이 초안의 서술보다 크므로, **방어 회전을 좁게 유지하는 것(`replace:true` 무회전, 진단 로그 필수)이 선택이 아니라 요구사항**이다. 이 형상은 PR 1의 `C4b`가 테스트로 고정한다.

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
6. abort/error cleanup은 이미 정착한 A를 건드리지 않고 활성 lane만 snapshot으로 정착한다. 정착 조건은 **lane별 `started`**(그 lane이 `progress` 프레임을 하나라도 보냈는가)다. §6.2-2b 때문에 회전 후 텍스트가 없는 lane은 `started === false`라 정착시킬 대상 자체가 없다 — 빈 버블도, 중단 마커도 생기지 않는다.
7. 기존 `snapshot || "⏹ Stopped."` fallback은 현재도 도달 불가한 방어선이다(`started` ⇒ 프레임 발신 ⇒ 스냅샷 비어있지 않음). lane 모델에서도 같은 이유로 도달 불가로 남는다. 이 fallback을 회전 lane의 표시 수단으로 쓰지 않는다.

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
- `onBlockReplyQueued`를 새로 배선하고 `context?.assistantMessageIndex`를 controller에 전달한다. **`delivery.deliver`의 `info`에서는 `kind`만 읽는다**(§5.2 — 그 타입에 index가 없다).
- final은 활성 lane만 finalize한다. partial 모드의 non-final block은 회계만 하고 버블을 만들지 않는다.
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
| M5 | 한 lane에 `onBlockReplyQueued`가 여러 번 (index 있음/없음 둘 다) | 순서를 보존해 같은 lane에 기록하고 버블은 한 번만 정착 |
| M6 | partial 없이 queued block만 있는 lane | block payload를 순서대로 이은 본문으로 정착 |
| M6b | 회전 후 `deliver(kind:"block")`가 늦게 도착 | 새 버블 없음, 정착된 앞 lane 불변, 전송 결과만 회계 |
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

reducer(`agent_message`의 id upsert/append)는 이미 다중 ID를 지원하므로 위험 표면이 아니다. **실제 위험은 history 화해 로직**(`nats-client-wrapper.ts`의 3-tier 매칭)이다. 턴당 버블이 하나라는 전제가 깨지면서 tier-3 positional 매칭이 상시 경로가 된다.

| # | 케이스 | 기대 |
| --- | --- | --- |
| C1 | 같은 `turnId`로 ID A/B의 progress/final frame 수신 | 버블 2개 유지, 순서 보존 |
| C2 | 라이브 2 / snapshot 2 (대칭) | tier-2 또는 tier-3로 각각 채택, 중복 없음 |
| C3 | **라이브 1 / snapshot 2** — **첫** lane(A) 정착 실패로 로컬에 B만 있음 (§8-1) | `[u, A, B]`로 수렴 |
| C3b | **라이브 1 / snapshot 2** — 이 기기가 렌더링한 적 없는 **뒤쪽** 답변을 history가 복구 (§8-4) | `[u, A, B]`로 수렴 |
| C4 | **라이브 3 / snapshot 2** — 스냅샷이 마지막 버블보다 앞선 시점 (§8-4 복구 경로) | 앞 2개는 채택, 남는 로컬 버블이 중복/유실을 만들지 않을 것 |
| C4b | **라이브 3 / snapshot 2** — B와 C가 같은 메시지 (§6.5.1 방어 회전 오작동) | 수용된 발산의 **실제 비용**을 고정: 라이브 세션에서 재작성 메시지가 2번 보이고 스냅샷 재전달로 해소되지 않으며, 전체 리로드에서만 3개로 수렴 |
| C5 | lane 회전으로 턴당 draft id가 N개 | `staleDraftWatch` / `finalizeDraftsForTurn`이 각 id를 정상 disarm·정착 |

C3/C4는 지금 우연히 맞을 수는 있어도 테스트로 고정돼 있지 않다. 이 변경이 그 전제를 상시 경로로 만들므로 반드시 고정한다.

**C3의 수렴 경로 정정 (실측, 2026-08-10).** 초안은 "tier-3 anchor 전진이 B를 A 자리에 잘못 채택하지 않을 것"이라고 적었으나 실제 경로는 반대다. 로컬에 B만 있는 상태에서 **`core-a1`(A의 행)이 라이브 B 버블에 채택되고**(anchor 체인이 그 자리에 먼저 닿는다) `core-a2`가 뒤에 fresh-insert 된다. 즉 어느 버블이 어느 메시지를 들고 있는지는 한 칸 밀리지만, `adoptAt`이 canonical 텍스트로 교체하고 남는 행이 순서대로 뒤에 삽입되므로 **최종 배열은 내용·순서 모두 정확하다.** 보장 대상은 "채택 자리"가 아니라 **수렴한 배열**이다.

### e2e 게이트

#87이 `test(e2e): gate the #87 turn outcome in CI`로 남긴 선례를 따른다. 라이브 경로 데이터 유실 결함이므로 단위 테스트만으로 닫지 않는다.

- partial 모드 다중 어시스턴트 메시지 턴이 CI에서 **두 개의 서로 다른 id로 정착**하는지 e2e로 확인한다.
- `e2e/protocol-version-lockstep.test.ts`: 새 프레임 타입이 없으므로 protocol 버전은 올리지 않는다. 이 판단을 테스트로 명시해 둔다.

게이트:

```bash
npm install          # 이 워크스페이스에는 node_modules가 없다 — 없으면 아래가 전부 실패한다
npm run build
npm run typecheck
npx vitest run packages/plugin
npm test             # 루트 vitest — client 회귀와 e2e 포함
```

---

## 11. 기각한 설계

| 설계 | 기각 사유 |
| --- | --- |
| draft snapshot 전체로 final | 데이터는 남지만 A/B가 한 버블이어서 history 형상과 다르다. B의 권위 있는 final 수정도 잃을 수 있다. |
| 턴 끝에 prefix를 잘라 새 버블로 전송 | 경계를 너무 늦게 복원하며 순서/ID/finalize latch가 복잡해진다. |
| `final.includes(previous)` 또는 suffix 검사 | 인용/반복/재포맷을 메시지 동일성으로 오판한다. core의 구조화된 경계를 버린다. |
| 모든 partial 프레임 영구 저장 | 보존 단위를 스트리밍 프레임으로 잘못 잡아 히스토리를 오염시킨다. |
| core 변경 | 필요한 경계 신호가 `plugin-sdk`에 이미 있다(§5.1). 이 결함의 소유자는 WebChannel 플러그인이다. |
| 앞 버블 실패 시 턴 전체 실패 | 모델 실행 결과와 transport live-delivery 결과를 혼동한다. history 복구 경로도 있다. |
| `deliver`의 `info.assistantMessageIndex`로 lane 상관 | 그 필드가 존재하지 않는다. `ChannelDeliveryInfo`는 `{kind}`뿐이고 6.10/7.1-2 동일하다(§5.2). 계약 밖 seam을 캐스팅으로 뚫는 것도 #23의 실패를 반복하는 길이다. |
| `onBlockReplyQueued`↔`deliver` FIFO 순서로 상관 | queue 순서와 전달 순서가 같다는 보장이 계약에 없다. `preparePayload`가 payload를 교체할 수 있어 참조 동일성도 못 쓴다. 새로운 계약 밖 가정을 도입하느니 §6.2-6처럼 활성 lane만으로 해소한다. |

---

## 12. 범위 밖

- 히스토리 메시지 메타데이터 확장 → #95
- typing 신호 → #96
- 툴 활동 구조화 표면 → #97
- 승인 origin 라우팅 → #93
- reasoning lane의 별도 제품 정책

### 12.1 PR 1에서 발견한 인접 결함 (실측, 2026-08-10)

C1~C5 특성 테스트를 쓰면서 클라이언트 화해/valve 쪽 결함 두 건을 실측했다. **둘 다 이 이슈의 원인이 아니고 이 변경으로 고치지 않는다.** 여기 적어두는 이유는 PR 2에서 다시 발견하고 범위를 넓히는 일을 막기 위해서다.

**(1) 다른 기기가 시작한 턴은 화해되지 않고 영구 중복된다 — 기존 결함, #94와 무관.**

리듀서의 inbound 프레임 12종 중 **다른 기기의 user 메시지를 라이브로 렌더링하는 것이 없다.** user 버블은 `send()`가 만드는 로컬 `u-<n>` 에코가 유일한 반면, agent 프레임은 공유 `.out`으로 모든 기기에 간다. 따라서 "다른 기기가 시작한 턴을 지켜보는 기기"에는 로컬 user 버블이 없고, tier-3는 anchor가 없으면 발화하지 않으므로(`anchor !== null` 가드) 스냅샷 전 행이 fresh-insert 되어 라이브 버블이 그대로 남는다.

```
로컬 [A1(T1), B1(T2)] + 스냅샷 [u1, a1, u2, b1]
  → [core-u1, core-a1, core-u2, core-b1, webchannel-a1, webchannel-b1]   중복 2
```

턴당 버블이 1개이던 시절에도 동일하게 재현된다. #94는 턴당 중복 **개수**를 늘릴 뿐 이 결함을 만들지 않는다. PR 1의 테스트는 전부 단일 기기 시나리오라 영향받지 않는다.

**(2) `reasoning` 프레임의 turn 단위 disarm이 #94 이후 valve를 약화시킨다 — #94가 도달 가능하게 만든다.**

staleness valve의 disarm은 경로마다 단위가 다르다. `progress`/`agent_message`는 `staleDraftWatch.delete(id)`로 **lane 단위**지만, `reasoning`은 `disarmStaleDraftsByTurn(turnId)`으로 **turn 전체**를 disarm 한다. 턴당 lane이 하나일 때는 둘이 같은 뜻이었다.

#94 이후에는 갈라진다: lane A의 정착 프레임이 유실되고(§8-1) lane B가 계속 스트리밍하는 중에 turn T의 `reasoning` 프레임이 하나 오면, 죽은 lane A까지 watch에서 빠져 **만료되지 않는다.** `turnInFlight()`가 참으로 남아 `turn_settled`/`​/stop`/재접속 재무장 중 하나가 올 때까지 composer가 잠긴다.

PR 2에서 고칠 수도 있지만 **클라이언트 소유이고 플러그인 lane 모델과 독립**이므로 기본은 별도 처리다. PR 2 안에서 고치기로 한다면 그 결정을 명시적으로 기록하고 범위에 넣어라 — 조용히 흡수하지 마라.

---

## 13. 완료 정의

- [ ] 한 턴의 완료된 assistant 메시지 N개가 라이브에서도 N개 버블로 남는다.
- [ ] 각 메시지는 고유 ID를 가지며 partial은 해당 활성 ID만 갱신한다.
- [ ] final은 마지막 메시지 ID만 확정하고 앞 버블을 변경하지 않는다.
- [ ] live와 history hydrate의 메시지 **수와 순서**가 일치한다(§6.5.1의 방어 회전 예외 제외).
      **본문 일치는 완료 조건이 아니다** — core는 라이브 응답에서 메타데이터 구획을 걷어내고 transcript에는 원본을 저장하므로 두 텍스트는 애초에 byte-equal이 아니다(`nats-client-wrapper.ts:1052-1054`). 본문 수렴은 hydrate의 정본 텍스트 채택(`adoptAt`)이 담당하며, 이 이슈가 보장할 대상이 아니다.
- [ ] 메시지 동일성 판정에 `includes`/suffix/문자열 split을 사용하지 않는다.
- [ ] 앞 lane 전송 실패 후에도 마지막 final 전달이 시도된다.
- [ ] abort/error/단일 메시지/progress/block/off 경로에 회귀가 없다.
- [ ] 중단/에러 경로에서 빈 버블도 중단 마커 버블도 생기지 않는다(§6.2-2b, §8-6).
- [ ] history 화해 비대칭 케이스(C3/C4)와 다중 draft id watchdog(C5)이 테스트로 고정된다.
- [ ] 다중 어시스턴트 메시지 턴이 e2e에서 두 개의 서로 다른 id로 정착한다.
- [ ] 계약 밖(core 내부 번들) 의존을 새로 늘리지 않는다 — 신규 근거는 `plugin-sdk` export만 인용한다.
- [ ] build/typecheck/plugin tests/full tests가 모두 통과한다.

---

## 14. compact 이후 구현 시작점

**현재 상태 (2026-08-10).** PR 1은 끝났고 **PR 2가 남았다.** 플러그인 production 코드는 아직 한 줄도 안 바뀌었다.

| | |
| --- | --- |
| PR 1 | [#103](https://github.com/mir-stream/openclaw-webchannel/pull/103) — 계획서 + 클라이언트 특성 테스트. 프로덕션 무변경. **사용자가 직접 리뷰·머지한다.** |
| PR 2 | 이 문서의 나머지 전부. 브랜치 `mir-stream/issue-94-pr2`, **base는 `mir-stream/issue-94-pr1`** (PR 1 머지 후 `develop`으로 rebase) |

**base 브랜치는 `develop`이다. `main`이 아니다.** main은 #87(PR #88)·#81(PR #98)보다 뒤에 있어서, main을 base로 잡으면 남의 머지 작업이 이 PR의 diff에 딸려 들어온다. `gh pr create` 전에 `git diff --stat origin/develop...HEAD`로 소유하지 않은 파일이 섞였는지 확인한다.

**게이트는 지금 돌아간다.** 워크스페이스 `mir-stream-issue-94`(브랜치 `mir-stream/issue-94-pr2`)에 `node_modules`가 설치돼 있고, PR 1 rebase 직후 기준선을 재확인했다 — plugin 1561 passed, client 447 passed, 전체 2310 passed, build/typecheck exit 0. 유일한 에러는 `spawn nats-server ENOENT`(로컬에 바이너리 없음, CI는 설치). 의존성 drift 없음.

### 14.1 PR 분할 (확정)

**PR 1 — 클라이언트 화해 특성 테스트 (테스트 전용, 소)**
`packages/client/src/nats-client-wrapper.test.ts`에 §10의 C1~C5b를 추가한다. 플러그인 변경과 완전히 독립이며 합성 프레임만으로 검증된다. 목표는 프로덕션 무변경이다.

**작성 규칙 (리뷰 2라운드에서 두 번 어겨 정한다).** 특성 테스트의 가치는 주석에 있고, 주석이 테스트보다 강한 주장을 하면 다음 사람을 오도한다. **"이 테스트가 X를 구속한다"고 쓸 거면 X를 깨는 뮤테이션을 실제로 돌려 확인하고 쓴다.** 확인하지 못하면 "이 형상이 이렇게 수렴한다"는 사실 기록으로만 쓴다. 실제로 이 규칙 없이 쓴 주석 두 개가 자명하게 참인 assertion(C4 오라벨, 구 C3의 짝짓기 주장)을 감추고 있었다.

이걸 먼저 떼는 이유: C3(라이브 1 / snapshot 2)와 C4(라이브 3 / snapshot 2)는 3-tier 매칭을 추적해 보면 **현재 우연히 맞지만 테스트로 고정된 적이 없다.** 만약 실제로 틀렸다면 그건 `nats-client-wrapper.ts` 프로덕션 수정이고, 메인 PR 안에서 터지면 "메시지 경계 수정"이 클라이언트 화해 로직 수정까지 껴안게 된다. 먼저 확인하면 어느 쪽이든 메인 PR이 깨끗하다.

**PR 2 — #94 본체 (대, 원자적)**
adapter lane 모델 + inbound 배선 + M1~M10 / I1~I10 + e2e 게이트. **더 쪼개면 깨진다** — inbound가 경계를 넘기지 않으면 adapter는 회전할 수 없고, adapter에 lane이 없으면 "활성 lane만 정착"이 성립하지 않는다. §6.5 fail-safe도 못 뗀다. 현재 코드에 이미 `absorbedMissedBoundaries` 방어가 있어서, 빼고 먼저 내보내면 #23이 막아둔 것을 되돌리는 셈이다.

**기각한 분할:** "id는 하나로 둔 채 `answerPrefix`만 배열로 바꾸는 무동작 리팩터를 먼저" 안. 회전 없는 lane 구조는 2단계에서 다시 쓰이므로 버려질 코드를 리뷰시키게 된다. 대신 **PR 2 안에서 커밋을 ① adapter lane 모델 ② inbound 배선 ③ 테스트 ④ e2e 순으로 나눈다.** 분할 PR의 리뷰 이점 대부분을 얻으면서 버려지는 중간 상태를 만들지 않는다.

### 14.2 구현 순서 (PR 2)

아래 순서로 바로 시작한다. 재조사는 필요 없다.

1. `packages/plugin/src/channel.test.ts`의 기존 “두 assistant 메시지가 한 ID에 합쳐진다” 테스트를 두 ID/두 버블 기대값으로 바꾸고, final이 앞 메시지를 인용하는 실패 테스트를 먼저 추가한다.
2. `packages/plugin/src/message-adapter.ts`의 턴 고정 `id`/`answerPrefix`를 lane별 ID와 settle latch로 교체한다.
3. `pushAnswerText`가 문자열만 받지 말고 `text`/`delta`/`replace`를 보존하도록 바꾼다.
4. `packages/plugin/src/inbound.ts`에서 partial/boundary/queued-block/delivery를 같은 직렬 queue에 넣는다. `onBlockReplyQueued`를 새로 배선해 `context?.assistantMessageIndex`를 넘기고, `deliver`의 `info`에서는 `kind`만 읽는다.
5. plugin 테스트가 green이 된 뒤 client의 다중 ID reducer 회귀 테스트와 전체 게이트를 실행한다.

구현 중 다시 열면 안 되는 결정:

- boundary가 메시지 소유권의 source of truth다. final 본문을 `includes`/suffix로 비교하지 않는다.
- **`deliver`에는 `assistantMessageIndex`가 없다**(§5.2). index는 `onBlockReplyQueued`의 `BlockReplyContext`에서만 읽는다. 이 필드를 delivery 이음매에서 찾다가 캐스팅으로 뚫으려 하지 않는다.
- `deliver`는 lane을 식별하지 않는다. `final`은 활성 lane을 정착시키고, partial 모드의 non-final block은 버블을 만들지 않는다.
- `onBlockReplyQueued`는 같은 assistant 메시지에 여러 번 올 수 있다. **block 하나를 메시지 하나로 가정하지 않는다.**
- settle latch는 턴별이 아니라 lane별이다. `started`도 lane별이다.
- 회전한 lane은 어시스턴트 텍스트가 생기기 전까지 `progress`를 보내지 않는다. 프로토콜에 버블 삭제가 없어서, 한 번 보이면 반드시 버블로 남는다(§6.2-2b).
- 위험한 클라이언트 표면은 reducer가 아니라 history 3-tier 화해 로직이다(§10 C3/C4).
- 앞 lane send 실패가 queue를 reject 상태로 고정하거나 마지막 final을 막아서는 안 된다.
- tool/item progress scaffold는 완료된 assistant 메시지가 아니다.

현재 코드에서 바로 볼 지점:

- `message-adapter.ts`: `const id = nextMessageId()`, `answerText`, `answerPrefix`, `handleAssistantMessageBoundary`, turn-wide `finalizeResult`
- `inbound.ts`: `onPartialReply`가 `p.text`만 넘기는 부분, `onAssistantMessageStart`, `draft.finalize(text)` final 분기
- `channel.test.ts`: `preserves earlier message text across an assistant-message boundary...` 테스트가 현재 잘못된 one-id 계약을 고정함

GitHub #94의 제목/본문도 이 문서와 같은 확정안으로 이미 갱신돼 있다.
