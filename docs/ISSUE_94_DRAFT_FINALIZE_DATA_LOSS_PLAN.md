# Issue #94 — partial draft가 어시스턴트 메시지 경계를 잃고 마지막 메시지로 덮이는 문제

- 이슈: [#94](https://github.com/mir-stream/openclaw-webchannel/issues/94) (P1 / kind/bug / area/plugin)
- 상류 리포트: rota-crew#281-A (Rota 0.4.0 제품 리뷰)
- PR 1 브랜치: `mir-stream/issue-94-pr1` (base `develop`)
- 계약 기준: `openclaw/plugin-sdk`의 export 표면. §5의 심볼은 `2026.6.10`(peer floor)과 `2026.7.1-2`(현 npm latest) 양쪽에서 **선언이 동일함을 확인**했다. 따라서 이 변경은 devDependency 상향도 `minGatewayVersion` 상향도 요구하지 않는다.
- 상태: 제품 의미론 결정 완료, 계약 검증 완료, 구현 전

---

## 1. 확정된 제품 계약

이 이슈에 남은 가치판단은 없다. 다음을 구현 계약으로 확정한다.

1. **보존 단위는 완료된 어시스턴트 메시지다.** ordinary 경로에서 한 턴에 어시스턴트가 사용자에게 두 번 발화했다면 두 메시지 모두 남는다.
2. **라이브 화면도 어시스턴트 메시지마다 별도 버블이다.** partial/final ordinary 경로의 라이브와 히스토리 하이드레이트는 메시지 수와 순서가 같아야 한다. 단, public identity가 없는 authorized block과 leading-terminal-error 후속 final은 §6.2의 at-least-once 예외라 이미 materialize된 본문이 fallback으로 중복될 수 있다. exact-once 화해는 [#111](https://github.com/mir-stream/openclaw-webchannel/issues/111)로 분리한다.
3. **partial/delta는 현재 메시지를 만드는 동안의 임시 갱신이다.** 임시 갱신 자체를 모두 저장하지는 않지만, 메시지가 완료되면 그 버블은 정착되고 다음 메시지가 같은 버블을 덮지 못한다.
4. **`kind:"final"`은 메시지 식별자가 아니라 core의 최종-payload 전달 분류다.** 한 턴에 error/answer/warning뿐 아니라 이미 materialize된 assistant block의 replay도 올 수 있다. terminal notice는 assistant lane을 소비하지 않는다. leading terminal error 뒤 identity 없는 non-notice final은 모두 **uncorrelated independent delivery**로 보존한다. 이미 materialize된 본문과 중복될 수 있지만 current/existing/stale lane에 오귀속하거나 payload를 버리지 않는다. 앞 메시지와 합칠지 텍스트 내용으로 추측하지 않는다.
5. **툴/item progress는 휘발성 상태 UI다.** 첫 durable consumer가 정해지기 전에는 turn-level provisional preview 하나로만 보인다. 첫 성공한 lane 또는 authoritative independent delivery가 preview ID를 claim해 scaffold를 실제 payload로 교체한다. lane/independent 모두 send 전에는 reserve만 하고 실제 `true`에만 commit하며, commit 때 provisional scaffold writer를 invalidate한다. 이후 tool/item event는 claimed ID로 `progress`를 보내지 않는다. independent claim은 assistant lane 소유권을 만들지 않는다.
6. **ordinary #94는 이 저장소의 플러그인에서 고친다.** core는 메시지 시작과 partial 교체 경계를 제공한다. 다만 queued block은 승인 전 tentative 신호이고 실제 승인된 delivery에는 lane identity가 없으므로, block partial dedupe/same-message grouping/exact lane ownership과 leading-error replay 화해에는 #111의 public identity 확장이 필요하다.
7. **앞 메시지의 라이브 전송 실패와 에이전트 턴 결과는 별개다.** 실패를 기록하고 마지막 메시지 전달을 계속 시도하며, 재접속 시 히스토리로 복구한다.
8. **queued payload는 wire 본문이 아니다.** `onBlockReplyQueued`는 TTS/media 준비와 `beforeDeliver` rewrite/cancel 전 신호이므로 tentative ordering reservation만 만든다. 사용자가 볼 수 있는 본문과 `visibleReplySent`는 실제 post-hook `delivery.deliver(kind:"block")`만 결정한다.
9. **notice는 block 소유권보다 먼저 분류한다.** `isStatusNotice`/`isFallbackNotice`/`isCompactionNotice` 중 하나인 block은 독립 notice 경로를 쓰며 assistant lane을 만들거나 정착하거나 막지 않는다.
10. **visible provisional preview는 첫 성공한 lane/independent delivery가 원자적으로 claim한다.** P가 visible+unclaimed면 lane generation 또는 independent delivery sequence가 P를 reserve하고 P ID로 보낸다. lane transport boolean 또는 independent delivery의 `visibleReplySent`가 실제 `true`일 때만 claim과 writer invalidation을 commit하며 `false`/throw면 P와 tentative lane assignment를 rollback한다. 성공한 claim 뒤 cleanup은 scaffold를 다시 settle하지 않고 뒤 consumer는 fresh ID를 쓴다.

따라서 ordinary 경로의 목표 형상은 아래와 같다.

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
| tool/item `progress` | 플러그인이 만드는 `Working…`, 툴명, 상태 줄 같은 작업 진행 표시다. | 첫 durable consumer 전에는 provisional preview ID 하나를 쓴다. lane 또는 authoritative independent delivery가 P를 reserve해 같은 ID로 보내고 성공했을 때만 claim/writer invalidation을 commit한다. 실패하면 P는 unclaimed/active로 돌아간다. claim 뒤 tool/item scaffold emission은 suppress하고 claimed P를 다시 `progress`로 덮지 않는다. 이미 `develop`에 랜딩한 #96/#101의 `turnActive`가 bubble 사이 turn-level in-flight 표시를 유지한다. |
| assistant `commentary` | 모델이 사용자에게 내보낸 가시 텍스트 단계다. reasoning이나 툴 상태 줄이 아니다. | 하나의 어시스턴트 메시지로 완료되면 별도 버블로 보존한다. |
| `onBlockReplyQueued(payload, ctx)` | block이 논리적으로 방출된 뒤 그 block의 async delivery보다 먼저 오는 **승인 전** 알림이다. TTS/media 준비와 `beforeDeliver` rewrite/cancel 전이며, 다음 `onAssistantMessageStart`보다 먼저 온다는 보장도 없다. `ctx.assistantMessageIndex`는 optional이다. | notice flag를 먼저 분류한 뒤 tentative ordering reservation 또는 독립 tentative notice token만 만든다. callback payload 본문은 복사·materialize·전송하지 않고, callback 결과로 실제 delivery를 억제하거나 lane ID를 고르지 않는다. count/order/index는 final payload 분류에도 쓰지 않는다. |
| `delivery.deliver(..., { kind:"block" })` | `beforeDeliver`와 `delivery.preparePayload`를 통과해 실제 전송이 승인된 wire-authoritative block이다. **`info`는 `kind`뿐이라 소유권 정보를 담지 않는다**(§5.2). | actual payload의 notice flag를 lane logic보다 먼저 다시 분류한다. partial mode의 block은 reservation 수/상태와 무관한 authoritative independent delivery다. visible+unclaimed P를 성공 시 claim하고, 아니면 fresh ID를 쓴다. queued callback이 전송을 suppress하거나 lane ID를 고르지 않는다. |
| `delivery.deliver(..., { kind:"final" })` | core 최종-payload 배열의 한 원소다. 한 턴에 여러 번 올 수 있고 `kind`만으로 assistant-message/block 소유권을 알 수 없다. 지원 하한의 terminal-error 경로는 `[error, ...retained assistantTexts]`를 만들 수 있으며 callback cardinality도 이에 대응하지 않는다. | leading error 전 ordinary answer는 current lane을 정착한다. terminal notice/error와 leading-error/extra uncorrelated non-notice payload는 independent claim-or-fresh 경로로 보내고 실제 send 결과를 반환한다. 어느 independent payload도 assistant lane을 소비하지 않는다. |

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
- `onBlockReplyQueued`의 JSDoc은 block의 논리 방출과 **그 block의 async delivery drain 사이** 순서를 보장한다. 그러나 다음 `onAssistantMessageStart`와의 순서는 말하지 않는다. 실제 지원 하한 `2026.6.10`도 `flushBlockReplyBuffer()`의 Promise를 기다리지 않고 다음 start callback을 호출하므로 queued callback이 다음 경계 뒤에 도착할 수 있다. 또한 이 payload는 TTS/media 준비와 dispatcher `beforeDeliver` rewrite/cancel 전 값이다. 따라서 이 훅을 "항상 현재 활성 lane에 기록해도 되는 wire 본문"이나 "뒤 delivery를 이미 처리했다는 credit"으로 해석하지 않는다.
- `assistantMessageIndex`는 `BlockReplyContext`에만 있고, `when available`로 optional이다.
- 같은 `2026.6.10` 실행 경로는 agent attempt 종료 시 `onBlockReplyFlush`를 await해 pending block callback/delivery task를 비운 뒤 `replyResult`를 반환하고, dispatcher가 그 다음에 final 배열을 순회한다. 따라서 **first final 직전 queue drain**은 지원 하한에서 late block reservation epoch를 닫는 terminal barrier로 쓸 수 있다. 공개 타입만으로 미래 core의 임의 순서를 보장하는 것은 아니므로, barrier 뒤 도착한 예상 밖 actual block도 §6.2-7의 conservative fallback으로 버리지 않고 보존한다.

### 5.2 공개 lifecycle은 주지만 승인된 delivery의 lane identity는 주지 않는다

WebChannel이 쓰는 실제 전달 이음매는 `ChannelEventDeliveryAdapter`이고, 그 `info`는 `kind` 하나뿐이다.

```ts
type ChannelEventDeliveryAdapter = {
  deliver: (payload: ReplyPayload, info: ChannelDeliveryInfo) => Promise<ChannelDeliveryResult | void>;
  // ...
};
type ChannelDeliveryInfo = { kind: ReplyDispatchKind };   // 이게 전부다
```

한편 `AssembledChannelTurn.dispatcherOptions`에는 공개 lifecycle observer가 있다.

```ts
type ReplyDispatchRuntimeInfo = {
  kind: ReplyDispatchKind;
  assistantMessageIndex?: number;
};

type ChannelTurnDispatcherOptions = Omit<
  ReplyDispatcherWithTypingOptions,
  "deliver" | "onError"
>;

onSkip?: (payload, info & { reason }) => void;
onBeforeDeliverCancelled?: (payload, info) => Promise<void> | void;
onDeliverySettled?: (info) => void;
```

따라서 플러그인은 `onSkip`, `onBeforeDeliverCancelled`, `onDeliverySettled`를 관찰해 tentative reservation을 정리할 수 있고, delivery adapter의 별도 `onError(err, {kind})`도 실패 진단에 연결할 수 있다. `onSkip`은 normalize 단계, `onBeforeDeliverCancelled`는 rewrite가 `null`을 반환하거나 throw한 단계, `onDeliverySettled`는 성공·취소·실패 뒤에 호출된다. 모두 §6.3의 event queue로 직렬화하고 cleanup을 idempotent하게 만든다.

그러나 이 observer들은 **승인된 payload를 보내기 전에 그 payload와 lane을 결합하는 identity가 아니다.** 실제 `delivery.deliver`가 받는 `ChannelDeliveryInfo`에는 여전히 index/token이 없고, `onDeliverySettled`는 delivery가 끝난 뒤 호출되며 index도 optional이다. `dispatcherOptions.beforeDeliver`를 새로 주입해 index를 훔치는 방법도 쓰지 않는다. 조립 과정에서 custom `beforeDeliver`가 기존 reply pipeline의 정상 message-sending hook을 대체할 수 있어 rewrite/cancel 체인 자체를 우회하게 된다. payload metadata를 읽는 비공개 helper나 런타임 extra-field cast도 금지한다.

`2026.6.10`과 `2026.7.1-2`에서 이 비대칭은 동일하다. **버전 문제가 아니라 공개 이음매의 역할 차이다.** lifecycle signal은 index가 실제로 있을 때 reservation/empty-predecessor cleanup을 도울 수 있지만, approved block의 lane ID를 고르는 shared identity는 아니다. 따라서 §6.2는 partial mode의 모든 authorized block을 lane과 무관한 independent delivery로 보존하되, visible+unclaimed provisional P만 순서 보존용으로 claim하고 아니면 fresh ID를 쓴다. block partial dedupe/same-message grouping/exact lane ownership은 #111의 core 계약 의존성으로 남긴다.

### 5.3 Telegram을 근거로 쓰지 않는다

core의 Telegram 채널은 delivery 이음매에서 `info.assistantMessageIndex`를 실제로 읽는다. 그러나 Telegram은 core에 번들된 내부 채널이라 공개 플러그인 계약보다 넓은 이음매를 쓴다. **플러그인이 설 수 있는 자리가 아니므로 설계 근거로 인용하지 않는다.** 참고 가치는 "core가 메시지 경계를 실제로 보존한다"는 사실까지다.

### 5.4 계약 밖에 남는 가정

다음 세 가지는 계약이 보장하지 않는다. JSDoc에 순서 규정 또는 필수 상관값이 없다.

- `onAssistantMessageStart`가 그 메시지의 첫 `onPartialReply`보다 먼저 온다.
- `onPartialReply.text`가 itemId별 누적이라 다음 메시지에서 `""`로 재시작한다.
- 앞 메시지의 `onBlockReplyQueued`가 다음 메시지의 `onAssistantMessageStart`보다 먼저 온다. queued callback은 자기 block delivery보다만 먼저 오며 index도 없을 수 있다.

앞의 두 항목은 #23이 이미 지적한 unpinned cross-package 가정이고 §6.5 fail-safe가 방어한다. 세 번째는 §6.2의 unresolved-lane 보존과 delivery fallback이 방어한다. 직렬 queue는 **이미 enqueue된 작업의 순서**만 지킬 뿐, 나중에 호출된 callback을 과거 경계 앞으로 옮길 수 없으므로 이것을 queue만으로 해결했다고 쓰지 않는다.

`kind:"final"`의 다중성과 replay는 가정이 아니라 지원 하한 `2026.6.10`의 관측 가능한 동작이다. `replyResult`가 배열이면 dispatcher가 각 원소를 같은 `kind:"final"` delivery seam으로 순서대로 보낸다. 고정 builder는 errored run에서 먼저 `errorText`를 넣고, canonical single-answer 경로를 쓸 수 없으면 보존된 `assistantTexts`를 앞에서부터 모두 뒤에 넣는다. 여기서 `assistantTexts` 원소는 assistant-message lane이 아니라 방출된 assistant block일 수 있다. A lane이 A1/A2 두 block, B lane이 B 한 block을 만들면 이미 두 lane이 스트리밍된 뒤에도 `[error, A1, A2, B]`가 된다. 이 저장소도 terminal error → retained answer와 answer → timeout/tool warning을 `inbound.test.ts`에서 모델링하지만, 기존 fixture가 `streaming.mode:"off"`라 draft settle/replay 중복을 검출하지 못한다.

**queued callback은 final 배열과 cardinality-isomorphic하지 않다.** 기본 partial 모드는 block streaming이 꺼져 있어 callback이 0개여도 terminal final은 `[error,A1,A2,B]`일 수 있다. block streaming을 켜도 같은 lane의 A1/A2가 `A1 + "\n\n" + A2` callback 하나로 coalesce되고 B callback 하나가 따로 오는 동안 final 배열은 여전히 세 assistant text를 보낼 수 있다. 따라서 `onBlockReplyQueued`의 count/order/index는 late predecessor의 tentative ordering barrier에만 쓰며 final payload나 actual block을 분류·계수·억제·grouping하는 근거로 쓰지 않는다. callback payload 자체도 승인 전이라 본문 보존이나 뒤 block delivery 억제의 근거가 아니다.

delivery 이음매에는 payload index나 배열 시작/끝 표지가 없으므로 **leading terminal error 뒤의 non-notice final을 기존 lane/block에 정확히 상관할 공개 계약이 없다.** ordinary non-notice final이 terminal error보다 먼저 오면 causal current lane을 정착한다. terminal error/notice는 lane을 소비하지 않는다. leading terminal error가 먼저 왔다면 뒤의 identity 없는 non-notice final은 모두 uncorrelated independent delivery로 진단하고 claim-or-fresh로 한 번 전송한다. delivery는 실제 send 결과를 `visibleReplySent`에 반환한다. 이 at-least-once 정책은 materialized A/B와 replay A1/A2/B의 의미상 중복을 명시적으로 수용하지만 payload 유실, current-lane 오귀속, history adoption 전 stale live ID 재사용은 피한다. exact-once에는 core가 stable assistant message/block identity를 공개 callback과 terminal delivery 양쪽에 전달해야 하며 [#111](https://github.com/mir-stream/openclaw-webchannel/issues/111)이 그 의존성과 후속 화해를 추적한다. exact-text/substring/참조 동일성이나 비공개 metadata는 쓰지 않는다.

따라서 **ordinary #94 데이터 유실은** core가 제공한 assistant-message 경계를 WebChannel이 버리고 ID 하나에 합친 문제이며, partial/final lane 회전 수정에는 core 변경이 필요 없다. 반면 authorized block의 partial dedupe/same-message grouping/exact lane ownership과 leading-terminal-error 후속 final의 exact-once에는 stable public identity가 실제로 부족하며 #111이 그 별도 core 계약 gap을 추적한다.

---

## 6. 채택 설계 — provisional preview를 첫 성공한 lane/independent delivery에 넘기고 메시지별 lane을 회전한다

### 6.1 정상 시퀀스

```text
onAssistantMessageStart()             # 첫 메시지: 빈 lane이므로 회전 없음
onPartialReply(A1)                    # progress(id=A, text=A1)
onPartialReply(A2)                    # progress(id=A, text=A2)

onAssistantMessageStart()             # A를 id=A로 정착, 새 lane으로 회전
onPartialReply(B1)                    # progress(id=B, text=B1), A와 다른 ID
onPartialReply(B2)                    # progress(id=B, text=B2)
delivery.deliver(payload=B, {kind:"final"})   # agent_message(id=B) — 활성 lane 정착
```

라이브 결과는 `[A 버블, B 버블]`이고 히스토리도 `[A 메시지, B 메시지]`다.

이 ordinary partial/final 경로는 `[A 버블, B 버블]`을 정확히 만든다. block callback/delivery가 끼면 shared identity 부재 때문에 별도 at-least-once 경로를 탄다. 아래 순서도 지원 하한에서 가능하다.

```text
onAssistantMessageStart()             # A 시작
... A는 commentary-only라 partial 없음 ...
onAssistantMessageStart()             # B 시작; 빈 A를 unresolved 상태로 보존
onPartialReply(B1)                    # B 본문은 ingest하되 A 뒤 순서 barrier를 넘지 않음
onBlockReplyQueued(preHookA, index=0|없음) # 늦게 온 A reservation을 unresolved 앞 lane에 연결
delivery.deliver(postHookA, {kind:"block"}) # P가 없으므로 post-hook A를 fresh fallback F-A로 보존
onDeliverySettled(block, index=0|없음)      # index가 있으면 barrier 해소; 없으면 terminal drain까지 유지
delivery.deliver(payload=B, {kind:"final"})  # B 정착
```

라이브 결과는 `[F-A 버블, B 버블]`이다. F-A는 actual block을 보존한 독립 fallback이지 A draft lane의 ID가 아니다. 경계는 빈 앞 lane을 즉시 버리지 않고, 뒤 lane의 wire emission은 reservation이 index가 있는 lifecycle 또는 terminal drain으로 해소될 때까지 기다린다. reservation이 하나뿐이어도 actual delivery의 identity를 증명하지 못하므로 callback 본문, FIFO, 후보 cardinality로 A lane을 고르지 않는다.

툴 호출만 한 assistant message A 뒤에 answer B가 오는 정상 mixed turn은 별도 preview 소유권이 필요하다.

```text
onAssistantMessageStart()             # tool-only A 시작
onToolStart()/onItemEvent()           # progress(id=P, text="Working…") — P는 아직 lane 소유가 아님
onAssistantMessageStart()             # B 시작; A는 unresolved, P는 그대로 provisional
onPartialReply(B1)                    # B1 ingest; A barrier 때문에 아직 P를 새 ID로 버리지 않음
delivery.deliver(payload=B, final)    # terminal callback drain에서 A=empty 확정
                                      # B가 P를 claim하고 agent_message(id=P, text=B)로 교체
```

결과는 **B 버블 하나**다. `Working…` ID를 A에 귀속한 뒤 B에 새 ID를 주면 `turn_settled`가 A의 scaffold를 그대로 정착시켜 ghost bubble을 만들므로 그 설계는 금지한다.

### 6.2 provisional preview, 순서가 있는 lane 상태, unresolved 보존

턴 전체에 고정된 `id`와 `answerPrefix` 대신 **소유자 없는 turn-level provisional preview 하나**, 어시스턴트 메시지 단위의 **순서 있는 lane 목록**, 승인 전 block ordering reservation/notice token, final-reconciliation 상태를 둔다. 현재 lane 하나만 보존하면 늦은 queued callback이 요구하는 predecessor barrier를 유지할 수 없고, preview를 첫 lane에 미리 귀속하면 tool scaffold ghost를 지울 수 없다.

```ts
type AssistantDraftLane = {
  generation: number;
  assistantMessageIndex?: number;
  id?: string; // successful send 뒤 commit된 ID만 저장
  tentativeProvisionalId?: string;
  answerText: string;
  answerRevision: number;
  tentativeBarrierReservationIds: string[];
  closed: boolean;
  resolution: "open" | "unresolved" | "materialized" | "empty";
  acceptsLateIndexlessReservations: boolean;
  started: boolean;
  settled: boolean;
  failedDeliveryCount: number;
  lastFailedDelivery?: {
    revision: number;
    frameType: "progress" | "final";
    error: "false" | "throw";
  };
  settleResult?: Promise<boolean>;
};

type ProvisionalPreview = {
  id: string;
  text: string;
  started: boolean;
  scaffoldWriter: "active" | "invalidated";
  claim:
    | { state: "unclaimed" }
    | { state: "reserved"; owner: ProvisionalClaimOwner }
    | { state: "claimed"; owner: ProvisionalClaimOwner };
  settleResult?: Promise<boolean>;
};

type ProvisionalClaimOwner =
  | { kind: "lane"; generation: number }
  | { kind: "independent"; deliverySequence: number };

type TentativeBlockReservation = {
  token: string;
  barrierGeneration?: number;
  assistantMessageIndex?: number;
  state: "pending" | "retired";
};

type TentativeNoticeToken = {
  token: string;
  noticeKind: "status" | "fallback" | "compaction";
  assistantMessageIndex?: number;
  state: "pending" | "retired";
};

type AuthorizedBlockDisposition = {
  sequence: number;
  route: "provisional-claim" | "fresh-fallback";
  settled: boolean;
};

type FinalReconciliationState = {
  ordinaryAnswerSettled: boolean;
  leadingTerminalErrorSeen: boolean;
};
```

세부 규칙:

1. 첫 `onAssistantMessageStart`는 최초 lane을 가리키는 no-op이고, 이후 경계는 이전 lane을 `closed`로 표시한 뒤 새 current lane을 연다. lane ID는 경계에서 미리 확정하지 않는다. 첫 partial/progress 또는 final-only frame의 **성공한 wire send 뒤에만** committed `lane.id`와 `started=true`를 기록한다.
2. 경계 시점에 내용이 없는 앞 lane은 버블을 만들지 않지만 **즉시 폐기하지도 않는다.** queued callback이 뒤늦게 ordering reservation을 제공할 수 있으므로 `unresolved` predecessor로 남긴다. 뒤 lane의 partial/final은 메모리에 ingest하되 unresolved predecessor를 추월해 wire에 내보내지 않는다. lifecycle/terminal drain에서 앞 lane이 실제로 비어 있었음이 확정된 뒤 generation 순서로 푼다. actual block independent delivery는 그 predecessor의 body/ID를 선택하지 않는다.
3. tool/item event가 durable assistant text보다 먼저 오면 `ProvisionalPreview.id`로만 `progress`를 보낸다. 이 ID는 아직 어느 lane에도 속하지 않으며 `claim.state="unclaimed"`, `scaffoldWriter="active"`다. **lane generation과 independent delivery sequence는 같은 two-phase claim helper를 쓴다.**
   - 첫 lane frame이 streaming partial의 `progress`이든 progress-mode/final-only의 `agent_message`이든, P가 visible+unclaimed면 `{kind:"lane", generation}`으로 P를 reserve하고 그 lane에 `tentativeProvisionalId=P`만 붙인 채 해당 frame을 P로 보낸다. 실제 send가 `true`면 `lane.id=P`, `started=true`, `claim.state="claimed"`를 commit하고 scaffold writer를 invalidate한다.
   - 그 lane send가 `false` 또는 throw면 P를 `unclaimed`로 rollback하고 `tentativeProvisionalId`를 지우며 committed `lane.id`/`started`를 만들지 않는다. 실패한 revision/frame/result와 진단은 그 delivery에 기록하고 해당 revision의 generation-order barrier를 **failed로 해소**해 뒤 consumer를 막지 않는다. queue를 계속 살리되 같은 revision을 그 자리나 terminal cleanup에서 blind retry하지 않으며, lane의 최신 answer snapshot은 메모리에 남는다.
   - 실패 lane의 **나중 별도 partial/final update**는 ID 선택을 새로 수행한다. 그때도 P가 unclaimed면 다시 reserve할 수 있지만, 그 사이 뒤 lane이나 independent delivery가 P를 성공적으로 claim했다면 실패 lane은 P를 재사용하지 않고 fresh ID로 보낸다. 실패한 tentative P assignment가 lane에 남아 later upsert를 오귀속해서는 안 된다.
   - **모든 authoritative independent visible delivery**—actual block notice/non-notice, terminal notice/error, leading-error 또는 ordinary-answer 뒤 extra uncorrelated final—도 send 직전에 같은 helper를 쓴다. P가 visible+unclaimed면 `{kind:"independent", deliverySequence}`로 reserve하고 P ID로 보낸다. P가 없거나 아직 visible하지 않거나 이미 reserved/claimed면 fresh ID를 쓴다. independent owner는 assistant lane을 만들지 않는다.
   - independent send도 `true`에만 claim/writer invalidation을 commit한다. `false` 또는 throw면 P를 `unclaimed`로 rollback하고 writer를 active로 유지한다. lane/independent 모두 reserve → send → commit/rollback 전체를 event queue 한 작업으로 직렬화하며 실제 delivery 결과를 보존한다.
   - 어느 owner든 claim이 commit되면 뒤 consumer는 fresh ID를 받고 cleanup은 예전 scaffold를 settle하지 않는다. block-only turn도 P를 actual block으로 교체한 버블 하나로 끝난다. 반대로 실패한 send는 P를 소비하거나 writer를 끄지 않는다.
   - preview가 lane/independent owner에게 claim된 뒤에는 후속 tool/item scaffold emission을 전부 suppress한다. 새 ID로 두 번째 scaffold를 만들지 않을 뿐 아니라, claimed P에도 `progress(P, Working…)`를 절대 보내지 않는다. client는 ID upsert이므로 durable `agent_message(P,F)` 뒤 그런 progress가 오면 F를 `Working…`으로 덮고 다시 working 상태로 연다(C8). bubble 사이 turn-level 활동은 새 base에 랜딩한 #96/#101의 `turnActive`가 나타낸다. 후속 tool 상세를 별도 bubble에 보이는 구조화 surface는 #97 범위다.
   - turn 전체가 tool-only/clean-silent이고 lane/independent delivery 모두 끝내 성공하지 않으면, 이미 보낸 preview는 삭제할 수 없으므로 기존 동작대로 그 scaffold 자체를 같은 ID에서 settle한다. 이는 실제 durable delivery가 하나도 없는 no-delete 비용에만 한정한다.
4. partial은 current lane만 갱신한다. `replace:true`도 그 lane 안에서만 본문을 교체한다. predecessor barrier나 앞선 send 실패 때문에 아직 wire에 못 나갔더라도 freshest snapshot을 보관한다. 순서가 열리거나 나중 별도 update가 왔을 때 다시 ID를 선택해 한 번 보내되, 실패 직후 같은 frame을 자동 재전송하지 않는다.
5. partial-mode lane의 durable 본문은 성공한 partial snapshot 또는 ordinary final send만 materialize한다. tentative callback payload는 물론 actual block independent delivery도 draft lane을 materialize하거나 settle하지 않는다.
6. **모든 queued block callback은 notice flag부터 분류한다.** `isStatusNotice`/`isFallbackNotice`/`isCompactionNotice` 중 하나면 lane을 찾기 전에 독립 `TentativeNoticeToken`을 만들고 끝낸다. 이 token은 assistant lane을 생성·정착·차단하지 않으며 actual delivery 전에는 아무 본문도 보내지 않는다. non-notice callback만 `TentativeBlockReservation`을 만든다.
   - `assistantMessageIndex`가 있으면 matching retained lane의 ordering barrier에 기록한다. index가 없으면 기존 `acceptsLateIndexlessReservations` barrier, 가장 이른 unresolved predecessor, current lane 순으로 **보수적인 지연 범위**만 정한다. 이는 actual payload의 owner/ID를 고르는 상관이 아니다.
   - late indexless barrier는 첫 callback이나 actual delivery만으로 닫지 않고 terminal callback drain까지 유지한다. callback payload를 이어 붙이지 않으며 reservation 수/순서를 actual delivery에 대응시키지 않는다.
   - unresolved 후보가 여러 개면 가장 이른 predecessor부터 뒤 emission을 보수적으로 막고 진단한다. 잘못된 lane body를 만드는 대신 필요 이상 지연할 수 있으며 terminal drain이 해소한다.
   - callback count/order/index는 **final reconciliation과 완전히 독립**이고, callback handler의 반환값이나 성공 여부도 actual delivery를 suppress하는 권한이 없다.
7. **actual `deliver(kind:"block")`는 wire-authoritative payload의 notice flag부터 다시 분류한다.** callback과 actual 사이 rewrite가 flag를 바꿀 수 있으므로 이전 분류를 재사용하지 않는다.
   - actual payload가 status/fallback/compaction notice면 independent claim-or-fresh 경로로 한 번 전송한다. tentative notice token/reservation, partial 유무, A/B interleave와 관계없이 assistant lane을 만들거나 정착하거나 막지 않는다.
   - partial mode의 non-notice actual payload도 reservation이 0개, 1개, 여러 개인 모든 경우 **independent claim-or-fresh** 경로로 보존한다. ordering reservation은 body/ID/owner 선택에 절대 쓰지 않는다. callback 누락이나 notice→non-notice rewrite 뒤 unrelated reservation 하나만 남는 반례가 있으므로 "후보 하나"도 block→lane 상관 증거가 아니다.
   - FIFO, text, object reference, private metadata로 lane을 고르지 않는다. block partial dedupe, same-message grouping, exact lane ownership은 #111 전까지 시도하지 않는다.
   - independent send의 실제 결과를 그대로 `visibleReplySent`로 반환하고 그 결과로 provisional claim을 commit/rollback한다. `false`/throw를 callback-side accounting으로 성공 처리하지 않고, queued callback 때문에 승인된 delivery를 drop하지 않는다.
8. **dispatcher lifecycle과 delivery error도 같은 queue에서 reservation을 해소한다.**
   - `onSkip`과 `onBeforeDeliverCancelled`도 payload의 세 notice flag를 먼저 분류한 뒤 실제 send 없이 tentative state를 정리한다. `assistantMessageIndex`가 있고 그 index의 outstanding record가 하나로 특정될 때만 해당 barrier reservation을 retire한다. index/token이 없거나 같은 index record가 여러 개면 sole-candidate/FIFO 추측을 하지 않고 terminal drain까지 유지한다.
   - `onDeliverySettled`는 actual delivery가 기록한 disposition을 idempotent하게 retire한다. optional index가 특정하는 barrier record가 하나일 때만 reservation도 정리한다. delivery adapter `onError`는 `kind`만으로 실패를 진단하고 queue를 살려 두며, terminal drain이 불명확한 cleanup을 완결한다.
   - cancel/skip/failure 뒤 모든 barrier reservation이 retire되고 partial/final 본문이 없는 predecessor는 `empty`가 되어 뒤 lane barrier가 열린다. `onBeforeDeliverCancelled`와 `onDeliverySettled`가 둘 다 와도 이중 해소하지 않는다.
   - 첫 final 직전과 final 없는 `inbound.run` 종료의 terminal drain은 late-reservation epoch를 닫고 남은 tentative reservation/token을 모두 retire한다. 이때 partial/final body가 없던 closed predecessor를 `empty`로 확정한다.
9. **`deliver(kind:"final")`은 payload 분류와 final-reconciliation state로 처리한다.**
   - 첫 final을 처리하기 전에 이미 enqueue된 callback/delivery/lifecycle 작업을 drain한다. 이 terminal barrier는 tentative state를 정리할 뿐 final 상관표를 만들지 않는다.
   - status/fallback/compaction/terminal-error notice는 assistant lane의 terminal slot을 소비하지 않고 independent claim-or-fresh 경로를 탄다.
   - terminal error가 ordinary answer보다 먼저 오면 `leadingTerminalErrorSeen=true`로 만든다. callback 유무/개수/본문은 이 전이에 관여하지 않는다.
   - `leadingTerminalErrorSeen`이 false인 첫 ordinary non-notice answer final은 current lane의 논리 terminal slot을 소비하고 `ordinaryAnswerSettled=true`로 만든다. current lane이 아직 wire-visible하지 않으면 partial과 같은 two-phase lane claim helper로 P를 reserve하거나 fresh ID를 고른다. final-only first send도 `true`에만 P claim/lane ID를 commit하고 `false`/throw에는 rollback하되 terminal payload를 blind retry하지 않는다.
   - leading terminal error 뒤의 모든 non-notice final은 public identity가 없으므로 uncorrelated independent delivery다. payload마다 진단하고 claim-or-fresh로 전송한다. current/existing/stale lane ID를 사용하지 않고, block ordering reservation을 소비하거나 payload를 accounting-drop하지 않는다.
   - ordinary answer가 이미 정착된 뒤 또 온 identity 없는 non-notice final도 settle latch에 삼키지 않고 independent claim-or-fresh로 보존한다. timeout/warning 같은 notice도 같은 independent claim transaction을 쓴다.
   - draft lane이 없는 mode(block/off)는 기존 plain append 경로를 그대로 유지한다.
10. lane transport boolean과 independent delivery의 `visibleReplySent`는 각각 **실제 claim-ID 또는 fresh-ID send 결과**다. `false`/throw도 해당 payload에서 격리하고 tentative P claim을 rollback한 뒤 다음 delivery를 계속 시도한다. turn 단위 `finalReplyDelivered`는 final payload의 실제 send 결과만 OR로 누적하며, lane progress 실패를 성공으로 회계하거나 queue failure로 승격하지 않는다.
11. final이 오기 전에 current lane이 화면에 나오지 않았어도 two-phase preview claim 또는 새 ID로 버블을 append/정착할 수 있어야 한다. terminal notice는 ordinary completed-assistant subsequence의 구성원이 아니다. P가 보였다면 앞선 **successful lane 또는 independent delivery**만 P를 claim할 수 있어 append-only client에서 실패한 consumer가 위치를 독점하지 않는다. 성공한 partial/final ordinary 경로에서는 A/B가 generation 순서로 정확히 한 번씩 존재한다. authorized block과 leading-error 후속 final은 #111 전까지 의미상 중복될 수 있다.
12. final 없는 clean resolve/abort/error에서는 `inbound.run`이 끝난 뒤 callback/delivery/lifecycle queue를 drain하고 late-reservation epoch를 닫는다. 그 뒤 truly empty predecessor를 제거하고, **실제** assistant text가 있는 lane만 generation 순서로 정착한다. 단, 마지막 전송에서 실패한 것과 같은 content revision을 cleanup이 재전송하지 않는다. 이후 들어온 새 revision만 새 delivery attempt가 될 수 있다. tentative reservation/token만 있는 lane은 정착하지 않는다.

**명시적 비용:** index 없는 경계 뒤 predecessor가 실제로 빈 메시지였으면, 다음 lane의 preview는 terminal drain이 그 predecessor를 `empty`로 확정할 때까지 지연될 수 있다. timeout으로 임의 확정하면 원래 data-loss race가 다시 열린다. authorized block은 이미 partial로 materialize된 lane과 별도 independent 버블로 보일 수 있다. 첫 successful independent delivery는 eligible P를 재사용하지만, P가 없거나 이미 claimed면 fresh ID를 쓰므로 같은 assistant message의 여러 block도 여러 버블이 된다. leading terminal error 뒤 `[A1,A2,B]`도 materialized A/B와 함께 다시 보일 수 있다. 모두 stable approved-delivery identity가 없는 #111 전까지의 at-least-once 비용이다. 어느 경우에도 pre-hook payload를 게시하거나 actual/final payload를 current lane에 조용히 덮어쓰거나 버리지는 않는다.

**provisional ID의 순서/단일-writer 불변식:** visible+unclaimed P가 있을 때 independent F를 fresh ID로 먼저 append하고 뒤 B가 P를 claim하면 client는 P의 기존 배열 위치를 유지해 `[B(P), F]`가 된다. block-only turn이면 cleanup이 P scaffold를 settle해 `[ghost P, F]`가 된다. 따라서 authoritative independent delivery는 lane보다 먼저 P claim 기회를 가져야 한다. 성공한 F는 `[F(P), B(new)]`를 만들고 block-only면 한 버블만 남긴다. 실패한 F는 claim을 rollback하므로 B 또는 다음 successful independent payload가 P를 claim한다. 같은 원칙으로 첫 lane A의 `progress(P)`/`agent_message(P)`가 실패했는데 A가 P를 committed claim하면 뒤의 성공한 B/F가 P를 교체하지 못해 scaffold ghost가 남는다. A도 성공 전에는 tentative owner일 뿐이며, 실패 시 P와 lane assignment를 함께 rollback해야 한다. 그 뒤 B/F가 P를 성공적으로 claim하고 A의 later update가 오면 A는 fresh ID를 쓴다. 또한 성공한 claim 뒤 provisional writer가 살아서 `progress(P, Working…)`를 보내면 reducer가 durable payload를 같은 자리에서 덮어쓴다. 모든 owner의 claim commit은 writer invalidation과 같은 queue transaction이어야 하며, C8은 올바른 same-P 형상, fresh-F→P-B 역전, late-scaffold overwrite 비용을 고정한다.

**상관하지 않는 이유:** queued callback이 자기 delivery보다 먼저 온다는 순서만으로 둘 사이 shared identity가 생기지는 않는다. actual X의 callback이 누락되었거나 queued notice가 actual non-notice로 rewrite된 동안 unrelated A reservation 하나만 남을 수 있다. 그러므로 pending reservation이 정확히 하나여도 X를 A에 적용하지 않는다. reservation/token은 predecessor ordering barrier와 lifecycle/terminal cleanup에만 사용하고 body/ID/owner 선택에는 절대 사용하지 않는다.

### 6.3 callback과 delivery를 하나의 직렬 queue로 처리한다

core callback 타입이 Promise를 허용해도 모든 호출자가 그 Promise를 기다린다는 전제에 기대지 않는다. 아래 작업을 한 queue에 넣는다.

- partial ingest
- tentative block reservation / notice token 기록
- assistant-message boundary close/rotate, lane/independent provisional reserve·commit·rollback과 scaffold-writer invalidation, unresolved predecessor 관리
- actual block의 notice-first independent claim-or-fresh delivery, dispatcher skip/cancel/settled와 delivery error cleanup, final reconciliation
- abort/error cleanup

queue는 호출된 이벤트의 순서와 mutual exclusion을 제공할 뿐이다. 다음 boundary가 먼저 호출되고 앞 block callback이 나중에 호출되면 queue도 그대로 boundary → block 순서로 처리한다. §6.2의 retained predecessor와 generation-order emission barrier가 의미를 복구하며, "한 queue에 넣었으니 late callback도 안전하다"고 가정하지 않는다.

각 작업의 실패는 해당 작업에서 잡아 queue가 영구 reject 상태가 되지 않게 한다. 그래야 A의 live send가 실패해도 B의 final 전달과 추가 final fallback이 실행된다.

### 6.4 문자열 추론 금지

정상 경로에서 다음 검사를 사용하지 않는다.

- `final.includes(previous)`
- `snapshot.endsWith(final)`
- `startsWith`/공백 정규화로 메시지 동일성 판정
- `A + "\n\n" + B`를 나중에 split

ordinary final이 leading terminal error보다 먼저 current lane의 terminal slot을 소비할 때 앞 메시지를 인용하거나 반복해도 boundary가 갈랐으면 별도 버블이다. 그 final이 current partial을 크게 재포맷해도 해당 lane만 교체한다. 반대로 leading error 뒤의 non-notice final은 내용이 기존 A/B와 같아 보여도 공개 identity가 없으므로 모두 independent claim-or-fresh 경로를 탄다. callback count/order, exact text, substring, 참조 동일성으로 suppress하거나 lane을 고르지 않는다.

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

- `streaming.mode:"partial"`: 이 이슈의 주 경로다. 첫 assistant text 전 tool scaffold는 provisional preview이고, 이후 답변 partial/final은 메시지별 durable lane을 사용한다. 첫 lane `progress`도 P를 tentatively reserve할 뿐이며 실제 send `true`에만 lane ID/claim을 commit한다. `false`/throw면 P와 lane assignment를 rollback하고 다음 consumer를 계속 처리한다. authorized `kind:"block"`은 lane과 상관하지 않는 independent delivery이며 같은 two-phase helper를 쓴다. 성공한 lane/independent claim 뒤에는 provisional tool writer를 invalidate하므로 후속 tool/item event가 durable P를 덮지 않는다.
- `streaming.mode:"progress"`: tool/item 줄은 P가 unclaimed인 동안만 provisional preview에 보인다. answer text는 final-only `agent_message`가 첫 lane wire frame이므로 partial과 동일하게 P reserve → send → success-only commit / failure rollback을 수행한다. 그보다 먼저 성공한 terminal notice/error 또는 uncorrelated independent payload가 있으면 그 delivery가 P를 claim하고 뒤 answer는 fresh ID를 쓴다. 어느 successful claim 뒤든 후속 tool/item scaffold는 suppress하며, turn-level 활동은 #96/#101의 `turnActive`가 계속 표시한다. durable delivery가 전혀 없는 clean-silent turn만 no-delete 제약 때문에 scaffold 자체를 settle한다.
- `streaming.mode:"block"` / `"off"`: draft lane이 없다. core가 넘긴 각 authorized block/final은 기존 append 경로를 유지하고, pre-hook callback payload가 아니라 actual delivery의 append/순서/결과 동작을 회귀 테스트로 확인한다.
- reasoning lane: 이 계획의 대상이 아니다. reasoning과 사용자에게 발화한 commentary를 혼동하지 않는다.

`progress`/`block`/`off`에 숨겨진 문자열을 partial처럼 복원하는 기능은 이 변경에 넣지 않는다. #94는 WebChannel이 실제로 받은 메시지 경계를 보존하지 못한 결함을 고친다.

---

## 8. 전달 실패와 턴 결과

메시지별 live delivery와 agent-run 결과를 분리한다.

1. A lane의 첫 partial/progress 또는 final-only 정착이 `false`를 반환하거나 throw하면 tentative P claim/ID를 rollback하고 진단 로그를 남긴 뒤 B lane 및 모든 final payload 전달을 계속한다. P 실패를 lane materialization으로 기록하지 않는다.
2. A 실패 때문에 `turn_settled{outcome:"error"}`로 바꾸지 않는다. 모델 실행은 성공했을 수 있고 transcript에는 A가 남아 있다.
3. inline 재전송은 하지 않고 실패 revision/frame을 기록한다. ack 없는 재시도는 A 중복 버블을 만들 수 있으므로 terminal cleanup도 같은 revision을 다시 보내지 않는다. 이후 별도 callback이 만든 새 revision만 새 delivery attempt가 될 수 있다.
4. 재접속/register 시 history snapshot이 빠진 메시지를 복구한다.
5. 어떤 final payload send가 실패해도 기존 P0-4 결정대로 사용자 메시지의 턴 outcome을 거짓 실패로 바꾸지 않는다. 각 `visibleReplySent`는 해당 delivery의 실제 결과이고, 턴 단위 `finalReplyDelivered`는 final payload 중 하나라도 실제 전송됐는지 OR로 누적한다.
6. abort/error cleanup은 이미 정착한 lane을 normal-finalize로 다시 보내지 않는다. 먼저 event queue를 drain하고 late indexless barrier 및 남은 tentative state를 닫는다. partial/final로 채워진 predecessor를 generation 순서로 정착한 뒤 current lane만 snapshot으로 방어 정착한다. 정착 조건은 **실제 assistant text 존재**다. block ordering reservation/token과 `ProvisionalPreview.started`, 실패한 tentative lane claim은 wire content의 증거가 아니다. successful lane/independent claim은 P를 durable payload로 교체하고 scaffold writer도 invalidate했으므로 cleanup 대상에서 제외한다. successful claim이 하나도 없었던 tool-only turn에서만 legacy scaffold settle 조건을 쓴다.
7. 기존 `snapshot || "⏹ Stopped."` fallback은 현재도 도달 불가한 방어선이다(`started` ⇒ 프레임 발신 ⇒ 스냅샷 비어있지 않음). lane 모델에서도 같은 이유로 도달 불가로 남는다. 이 fallback을 빈 lane이나 새 ghost bubble의 표시 수단으로 쓰지 않는다.

---

## 9. 구현 계획

### `packages/plugin/src/message-adapter.ts`

- 단일 `id` + `answerPrefix` 누적 모델을 turn-level `ProvisionalPreview` + generation 순서가 있는 `AssistantDraftLane[]` 모델로 교체한다.
- `pushAnswerText(text)` 대신 `text`/`delta`/`replace`를 보존해 받는 API로 바꾼다.
- 메시지 경계 close/rotate, lane generation 또는 independent delivery sequence가 소유하는 preview reserve/commit/rollback, tentative lane ID와 failed revision/frame 기록, scaffold-writer active/invalidated state, unresolved predecessor 보존, persistent late-indexless barrier, generation-order emission barrier, tentative block reservation/notice token, actual block independent disposition, final phase state, lane별 settle latch를 추가한다.
- tool/item progress scaffold는 첫 successful lane 또는 independent delivery가 claim하기 전의 소유자 없는 휘발성 표시로 유지한다. 모든 owner가 같은 reserve/send/commit-or-rollback helper를 쓰고, success commit과 같은 queue 작업에서만 writer를 invalidate한다. 빈 first assistant message나 failed lane에 ID를 귀속하거나 claimed P를 tool progress로 갱신하지 않는다.
- `snapshotText()`는 **현재 활성 lane**의 방어 정착용 snapshot만 반환하게 명확히 한다.

### `packages/plugin/src/inbound.ts`

- `onPartialReply`, `onBlockReplyQueued`, `onAssistantMessageStart`, `delivery.deliver`, dispatcher `onSkip`/`onBeforeDeliverCancelled`/`onDeliverySettled`, delivery `onError`를 같은 lane event queue에 연결한다.
- `onPartialReply`가 만드는 첫 lane `progress`와 ordinary final-only `agent_message`의 실제 boolean/throw 결과를 controller의 공통 provisional transaction에 돌려준다. 실패 lane의 tentative P ID를 clear하고 뒤 callback을 계속 처리하며, 실패 frame을 같은 호출에서 재전송하지 않는다.
- `onToolStart`/`onItemEvent`의 scaffold writer도 같은 preview claim state를 읽는다. P가 claim되는 즉시 loop를 stop/invalidate하고, 이미 enqueue된 late tool/item 작업도 claim state를 재확인해 wire emission 없이 끝낸다.
- `onBlockReplyQueued`를 새로 배선하고 `context?.assistantMessageIndex`를 controller에 전달하되 payload는 tentative reservation/token 분류에만 쓴다. **`delivery.deliver`의 `info`에서는 `kind`만 읽는다**(§5.2 — 그 타입에 index가 없다).
- custom `dispatcherOptions.beforeDeliver`는 추가하지 않는다. existing reply pipeline의 정상 rewrite/cancel hook을 대체할 수 있기 때문이다. 실제 `delivery.deliver`가 받은 post-hook/post-`preparePayload` payload만 전송·materialize한다.
- callback과 actual block 모두 세 notice flag를 lane logic보다 먼저 분류한다. partial mode의 actual block notice/non-notice는 reservation 수/상태와 무관한 independent delivery다. visible+unclaimed P를 먼저 reserve해 같은 ID로 보내고 success에만 commit하며, P가 없거나 claimed면 fresh ID를 쓴다. callback 결과로 실제 delivery를 억제하거나 block→lane body/ID/owner를 고르지 않는다.
- lifecycle observer는 skip/cancel/success/failure 뒤 reservation/token을 idempotent하게 retire하고 empty predecessor barrier를 해제한다. first-final/turn-end drain은 남은 tentative state를 모두 정리한다.
- first-final 직전에 queued callback/delivery/lifecycle 작업을 drain해 empty predecessor와 late-owner epoch를 닫는다. callback 기록은 final 분류에 사용하지 않는다. final payload는 terminal notice, ordinary current-lane answer, leading-error 뒤 uncorrelated fallback으로 분류한다.
- terminal notice/error, leading-error 후속 및 ordinary-answer 뒤 extra uncorrelated final은 assistant lane을 소비하지 않고 모두 같은 independent claim-or-fresh helper를 쓴다. current/existing/stale lane ID를 추측하지 않는다.
- 현재의 “final 하나가 턴 전체 draft를 교체한다”는 주석과 분기를 제거한다.
- 앞 lane/independent send 실패를 격리하고 delivery별 실제 결과 및 final의 턴 단위 OR 회계를 유지한다.

### 클라이언트

production 변경은 예상하지 않는다. 현재 reducer는 다음을 이미 지원한다.

- 동일 `id`의 `progress`/`agent_message`: 같은 버블 update/finalize
- 서로 다른 `id`: 서로 다른 버블 append
- history adoption: live `webchannel-*` ID를 canonical `core-*` ID로 교체하며 old-ID alias는 보존하지 않음

따라서 서버가 ordinary A/B에 다른 ID를 주면 원하는 형상이 나온다. adoption 뒤 settled lane의 old ID를 다시 쓰면 새 버블이 append되므로 identity 없는 leading-error 후속 final은 old ID가 아닌 provisional-or-fresh independent ID를 써야 한다. C7은 P가 없는 snapshot-adopted 형상에서 canonical A/B가 불변인 fresh fallback과 stale-ID 추측의 실제 비용을 고정한다. C8은 P가 있는 형상에서 successful independent delivery가 P를 쓰지 않으면 append-only 위치 때문에 뒤 B와 순서가 역전되고, claim 뒤 scaffold writer가 P를 다시 쓰면 durable payload가 덮임을 고정한다. semantic exact-once는 client alias가 아니라 #111의 public identity 없이는 보장하지 않는다.

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
| M1b | tool scaffold P → 빈 first lane boundary → B partial/final send `true` | B가 P claim을 commit해 한 버블로 교체, scaffold sibling 없음 |
| M2 | A partial → boundary → B partial | A가 정착되고 B는 다른 ID 사용 |
| M3 | A → B → C | 세 lane/세 ID, 발생 순서 유지 |
| M4 | `replace:true`로 A 본문 수정 | 새 버블 없이 A lane만 교체 |
| M5 | 한 lane에 `onBlockReplyQueued`가 여러 번 (index 있음/없음 둘 다) | body를 복사·전송하지 않고 ordering reservation만 남김; count/order로 actual delivery를 상관하지 않음 |
| M6 | partial 없이 queued callback만 있는 lane | callback payload로 버블을 만들지 않음; skip/cancel/terminal drain 뒤 empty |
| M6b | P 없는 상태에서 B boundary/partial 뒤 A `onBlockReplyQueued(index=A)` 하나가 도착하고 actual block 승인 | reservation은 A predecessor barrier만 유지; actual post-hook payload는 fresh fallback F-A, lifecycle 뒤 B 공개 |
| M6c | M6b와 같지만 index 없음 | sole-candidate 상관 금지; actual은 F-A로 보존하고 reservation은 terminal drain에서 해소, B는 그 뒤 공개 |
| M6d | P 없는 상태에서 queued `preHookA`가 `beforeDeliver`에서 `postHookA`(+media/TTS)로 rewrite | pre-hook text/media는 한 번도 wire에 안 나가고 actual rewritten payload만 fresh fallback으로 전송 |
| M6e | reservation 0개/1개/여러 개인 partial-mode `deliver(kind:"block")` | 모든 경우 actual payload를 independent claim-or-fresh로 보존; 어느 lane도 materialize/settle하지 않음 |
| M6f | callback payload의 세 notice flag 각각 | lane보다 먼저 분류해 independent tentative notice token만 생성; predecessor barrier/settle 없음 |
| M6g | actual block의 세 notice flag 각각, callback↔actual flag rewrite, lane partial 유/무 및 A/B interleave | actual 분류만 wire route를 결정해 notice는 independent ID로 전송; A/B lane 생성·정착·차단 없음 |
| M6h | A reservation이 skip 또는 beforeDeliver cancel/throw된 뒤 B (index 있음/없음) | index가 특정하면 lifecycle, 없으면 terminal drain에서 A empty/B barrier 해제; 중복 callback에도 ghost/영구 barrier 없음 |
| M6i | authorized block independent send가 `true`/`false`/throw | actual 결과를 그대로 반환/진단하고 success에만 P claim commit, false/throw는 rollback한 뒤 settled cleanup; callback 결과로 성공 처리하거나 delivery suppress하지 않음 |
| M7 | boundary 누락 + non-replace divergence | 기존 lane 보존, 진단 후 방어 회전 |
| M8 | 늦은 boundary | 방어 회전을 두 번 적용하지 않음 |
| M9 | A 정착 실패 | tentative ID/claim을 남기지 않고 queue는 살아 있으며 B 정착 실행 |
| M10 | 같은 lane의 동시/재진입 settle | 그 lane의 terminal frame 정확히 1회; 별도 final delivery slot은 막지 않음 |
| M11a | **기본 partial / block streaming off**: queued callback 0개, A/B materialized(P도 이미 lane-claimed) 뒤 final `[terminal error,A1,A2,B]` | A/B lane 불변; error와 uncorrelated A1/A2/B를 각각 fresh ID로 전송; materialized 내용과의 중복을 at-least-once 비용으로 수용 |
| M11b | **block streaming enabled + effective coalescing**: queued callbacks `[A1+"\n\n"+A2(index=0),B(index=1)]`, final은 동일한 `[terminal error,A1,A2,B]` | callbacks는 ordering reservation일 뿐; actual blocks와 final 세 개 모두 independent claim-or-fresh, callback 수로 dedupe/group하지 않음; 이미 lane-claimed P와 partial/final A/B 불변 |
| M12 | leading error 뒤 fallback send가 `true`/`false`/throw를 섞어 반환 | 모든 non-notice final 전송을 계속 시도하고 delivery별 실제 `visibleReplySent` 반환; queue 생존, 기존 lane 불변 |
| M13a | visible P → authorized block success → B partial/final | block sequence가 P reserve/send/commit, B는 fresh lane ID; wire 배열 `[block(P),B(new)]` |
| M13b | visible P → authorized block success → block-only turn end | block이 P를 교체한 한 버블만 남고 cleanup이 scaffold를 재-settle하지 않음 |
| M13c | visible P → block send `false`/throw → B | independent reservation rollback; B lane이 P를 claim, failed block ghost 없음 |
| M13d | visible P → block notice 또는 terminal notice/error/fallback success → 뒤 lane/independent payload | 첫 successful independent payload가 P를 non-lane claim; 뒤 payload는 fresh ID, lane 소유권 변화 없음 |
| M13e | visible P → terminal error send `false` → retained A success | error rollback 뒤 uncorrelated A가 P를 claim; 실제 visible 버블은 A(P) 하나 |
| M13f | visible P → block/notice/error 또는 lane send `true`로 P claim → 후속 tool/item event → B 또는 block-only end | successful claim이 provisional writer를 invalidate; 후속 tool scaffold wire 0회, durable payload(P) 불변, independent claim 뒤 B가 있으면 fresh ID |
| M13g | visible P → A의 첫 lane frame `progress(partial)`/`agent_message(final-only)` × send `false`/throw → B lane send `true` | A는 P reserve 뒤 rollback, tentative lane ID clear, writer active, inline retry 0회; B가 P를 reserve/commit해 한 버블, A failure 결과 보존, queue 생존 |
| M13h | visible P → A의 첫 `progress(partial)` send 실패 → independent F send `true` → A의 later partial update | F가 P를 reserve/commit하고 writer invalidate; A later update는 fresh ID를 사용해 P를 mutate하지 않음, ghost/tentative owner 없음 |

### inbound 통합 테스트

| # | 케이스 | 기대 |
| --- | --- | --- |
| I1 | A partial, boundary, B partial, final=B | A/B 두 버블, 서로 다른 ID, 순서 보존 |
| I2 | assistant 메시지 3개 | 라이브 세 버블, history와 같은 순서 |
| I3 | 단일 메시지 | 한 ID에서 partial→final, 기존 UX 유지 |
| I4 | final B가 A 문장을 인용/포함 | A와 B는 여전히 별도 버블 (`includes` 회귀 방지) |
| I5 | final B가 B partial을 전면 재작성 | B만 교체, A 불변 |
| I6 | A live 정착 `false`/throw | A tentative ID가 남지 않고 B final은 시도되어 실제 성공 결과를 반환 |
| I7 | B final 실패 | 기존 P0-4 턴 outcome 계약 유지 |
| I8 | abort/clean resolve/error | 정착된 A 불변, queue drain 뒤 unresolved/current만 settle, working 잔존 없음 |
| I9 | progress mode | final-only lane/independent delivery가 P를 two-phase reserve하고 첫 successful send만 claim; 뒤 payload는 fresh ID |
| I10 | block/off mode | 기존 append/순서와 실제 delivery 결과 처리 무회귀 |
| I11 | P 없는 commentary-only A의 queued callback 하나가 B boundary/partial 뒤 도착 (index 있음/없음 parameterize), actual block 승인 | callback text는 미전송; actual post-hook A는 fresh independent fallback, empty predecessor는 lifecycle/terminal drain에서 제거, B는 별도 ID |
| I12a | 기본 partial / block streaming off에서 callback 없이 A/B materialized, core final `[terminal error,A1,A2,B]` | 기존 A/B 불변; error와 A1/A2/B fresh fallback 모두 보존, fallback별 실제 send 결과, outcome error; 의미상 중복 명시 수용 |
| I12b | block streaming enabled에서 callbacks `[A1+"\n\n"+A2(index=0),B(index=1)]`, core final은 같은 `[terminal error,A1,A2,B]` | actual block fallback들과 final error/A1/A2/B fallback을 모두 독립 보존; 기존 partial/final A/B 불변, 중복 명시 수용, outcome error |
| I13 | partial 모드에서 answer final → timeout/tool-warning final | 두 payload 모두 보존, lifecycle verdict가 outcome 결정 |
| I14 | partial 모드에서 reservation 0개/1개/여러 개인 authorized block delivery | 모든 actual payload를 independent claim-or-fresh로 보존; callback payload/owner는 사용하지 않음 |
| I15 | tool-only assistant A가 scaffold를 띄운 뒤 answer B가 시작하고 send `true` | B가 provisional ID claim을 commit해 final 뒤 버블 하나, `turn_settled` 후 ghost scaffold 없음 |
| I16 | P 없는 commentary-only A의 A1/A2 queued callback이 B boundary/partial 뒤 모두 index 없이 도착 | callbacks는 ordering barrier일 뿐; actual A1/A2는 각각 fresh independent fallback, empty A는 terminal drain에서 제거, B 별도 정착 |
| I17 | queued 원문 뒤 `beforeDeliver`가 text/media를 rewrite하고 actual block 승인 | provisional-or-fresh independent wire에는 post-hook/post-prepare payload만 1회; queued 원문 0회 |
| I18 | A queued block이 normalize skip 또는 beforeDeliver cancel/throw된 뒤 answer B (index 있음/없음) | exact-index lifecycle 또는 terminal cleanup 뒤 A ghost/영구 barrier 없이 B가 provisional ID를 claim해 정착 |
| I19 | actual block independent transport가 `true`/`false`/throw | delivery별 실제 `visibleReplySent`, provisional commit/rollback, error 격리, 뒤 payload 계속 시도 |
| I20 | `isStatusNotice`/`isFallbackNotice`/`isCompactionNotice` block 각각, callback↔actual flag rewrite, lane partial 유/무와 A/B interleave | callback은 tentative token/reservation뿐이고 actual 분류만 wire route를 결정; notice는 provisional-or-fresh independent ID이며 lane을 생성·정착·차단하지 않음 |
| I21 | tool scaffold P → authorized block success → answer B | `agent_message(P,block)` 뒤 B가 fresh ID로 append되어 `[block,B]`; 같은-turn order 유지 |
| I22 | tool scaffold P → authorized block success → block-only cleanup | P 한 버블만 durable block으로 정착; `Working…` ghost sibling 없음 |
| I23 | tool scaffold P → block `false`/throw → answer B | claim rollback 뒤 B가 P를 재사용; queue 생존, failed block/ghost 없음 |
| I24 | P와 block notice/terminal error/fallback sequence (error false → retained A success 포함) | 각 independent send가 같은 reserve/commit/rollback helper 사용; 첫 성공만 P claim, 뒤 성공은 fresh ID |
| I25 | P → successful independent block/notice/error → late `onToolStart`/`onItemEvent` → B 및 block-only cleanup | late scaffold emission 0회, `agent_message(P,F)` 본문 불변/settled, B는 fresh ID; lane이 P를 claim한 variant도 scaffold가 lane text를 덮지 않음 |
| I26 | pinned runtime에서 첫 lane frame (`progress` partial / final-only `agent_message`) × 결과 (`false`/throw) × 다음 successful consumer (lane B / independent F) | 2×2×2 모두 A의 tentative P/ID rollback·inline retry 0회·실제 실패 결과·queue 생존; 다음 consumer가 P로 성공해 ghost 없음. partial-first + F-claim branch의 later A update는 fresh ID |

### 클라이언트 회귀 테스트

reducer(`agent_message`의 id upsert/append)는 이미 다중 ID를 지원하므로 위험 표면이 아니다. **실제 위험은 history 화해 로직**(`nats-client-wrapper.ts`의 3-tier 매칭)이다. 턴당 버블이 하나라는 전제가 깨지면서 tier-3 positional 매칭이 상시 경로가 된다.

| # | 케이스 | 기대 |
| --- | --- | --- |
| C1 | 같은 `turnId`로 ID A/B의 progress/final frame 수신 | 버블 2개 유지, 순서 보존 |
| C2 | 라이브 2 / snapshot 2 (대칭) | tier-2 또는 tier-3로 각각 채택, 중복 없음 |
| C3 | **라이브 1 / snapshot 2** — **첫** lane(A) 정착 실패로 로컬에 B만 있음 (§8-1) | `[u, A, B]`로 수렴 |
| C3b | **라이브 1 / snapshot 2** — 이 기기가 렌더링한 적 없는 **뒤쪽** 답변을 history가 복구 (§8-4) | `[u, A, B]`로 수렴 |
| C4 | **라이브 3 / snapshot 2 → 나중 snapshot 3** — 첫 스냅샷이 마지막 버블보다 앞선 시점 (§8-4 복구 경로) | C가 먼저 live ID로 생존하고, 나중 `core-a3`가 tier-1 anchor → tier-3 경로로 C를 채택 |
| C4b | **라이브 3 / snapshot 2** — B와 C가 같은 메시지 (§6.5.1 방어 회전 오작동) | 수용된 발산의 **실제 비용**을 고정: 라이브 세션에서 재작성 메시지가 2번 보이고 스냅샷 재전달로 해소되지 않으며, 전체 리로드에서만 3개로 수렴 |
| C5a | lane 회전으로 턴당 draft id가 N개 | `turn_settled`가 같은 turn의 모든 working lane을 정착 |
| C5b | grace 중 B 하나에 `progress` 또는 `agent_message` 도착 (두 frame type parameterize) | B id만 disarm되고 죽은 A/C는 계속 watch되어 만료 |
| C6 | provisional scaffold와 첫 durable answer가 같은 ID의 progress/final을 사용 | answer 버블 하나만 남고 `turn_settled`가 ghost scaffold를 만들지 않음 |
| C7 | live A/B가 history snapshot으로 `core-a1/core-a2`에 adopt된 뒤 error + fresh fallback A1/A2/B; 이어 old-id upsert를 별도로 주입 | canonical A/B는 mutate되지 않고 fresh fallback은 append됨. old `webchannel-a`도 alias가 없어 별도 append됨을 실측; exact-once를 주장하지 않음 |
| C8 | visible P 뒤 independent F: (a) F가 P를 사용한 뒤 B는 new ID (b) F가 P를 사용한 block-only settle (c) F가 fresh ID, B가 P를 사용 (d) fresh F 뒤 block-only settle (e) `agent_message(P,F)` 뒤 late `progress(P,Working)` | (a)는 `[F(P),B(new)]`, (b)는 `[F(P)]`; 잘못된 fresh-first (c)는 `[B(P),F]`, (d)는 `[ghost P,F]`; (e)는 F가 Working으로 덮이고 다시 working이 되는 실제 비용. same-P claim과 claim 뒤 scaffold-writer invalidation 필요성을 고정 |

C3/C4는 지금 우연히 맞을 수는 있어도 테스트로 고정돼 있지 않다. 이 변경이 그 전제를 상시 경로로 만들므로 반드시 고정한다.

**C3의 수렴 경로 정정 (실측, 2026-08-10).** 초안은 "tier-3 anchor 전진이 B를 A 자리에 잘못 채택하지 않을 것"이라고 적었으나 실제 경로는 반대다. 로컬에 B만 있는 상태에서 **`core-a1`(A의 행)이 라이브 B 버블에 채택되고**(anchor 체인이 그 자리에 먼저 닿는다) `core-a2`가 뒤에 fresh-insert 된다. 즉 어느 버블이 어느 메시지를 들고 있는지는 한 칸 밀리지만, `adoptAt`이 canonical 텍스트로 교체하고 남는 행이 순서대로 뒤에 삽입되므로 **최종 배열은 내용·순서 모두 정확하다.** 보장 대상은 "채택 자리"가 아니라 **수렴한 배열**이다.

### e2e 게이트

#87이 `test(e2e): gate the #87 turn outcome in CI`로 남긴 선례를 따른다. 라이브 경로 데이터 유실 결함이므로 단위 테스트만으로 닫지 않는다.

- partial 모드 다중 어시스턴트 메시지 턴이 CI에서 **두 개의 서로 다른 id로 정착**하는지 e2e로 확인한다.
- tool scaffold 뒤 빈 assistant boundary와 answer가 오는 partial turn이 **같은 provisional ID를 재사용해 한 버블**로 끝나는지 확인한다.
- queued block의 rewrite/cancel 및 actual send `true`/`false`/throw는 I17~I19의 pinned-runtime integration으로 고정한다. 특히 cancel(A) → B가 ghost/barrier 없이 끝나고 pre-hook text/media가 wire에 한 번도 나오지 않아야 한다.
- 세 notice flag는 I20에서 partial 유/무와 A/B interleave를 교차해 고정한다. callback token은 wire를 만들지 않고 actual authorized notice만 독립 전송되며 lane 상태를 건드리지 않아야 한다.
- provisional claim 뒤 late tool/item event는 I25에서 block/notice/error와 lane owner를 교차한다. claimed P에 scaffold `progress`가 0회여야 하고 B는 fresh ID를 써야 한다.
- lane-owned P failure는 I26의 pinned-runtime 2×2×2 matrix로 고정한다. partial-progress/final-only 첫 frame이 `false`/throw여도 tentative P가 남지 않고, 뒤 lane/independent success가 P를 차지하며 queue가 살아 있어야 한다.
- terminal-error fixture는 plugin integration I12a/I12b에서 (a) callback 0개와 (b) coalesced callback 2개를 각각 만들되 final `[error,A1,A2,B]`는 같게 고정한다. 두 경우 모두 wire에는 기존 materialized A/B에 더해 error와 fresh fallback A1/A2/B가 남아야 한다. provider별 error 재현에 기대지 않으므로 live e2e를 불안정하게 만들지 않는다.
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
| 첫 `Working…` ID를 first assistant lane에 즉시 귀속 | first assistant message가 tool-only/empty면 B가 새 ID를 쓰고, delete 없는 client가 A scaffold를 `turn_settled`에서 영구 정착한다. preview는 첫 successful lane/independent delivery가 나올 때까지 committed owner 없이 둔다. |
| ordinary partial/final #94 수정을 위한 core 변경 | assistant-message 경계 신호는 `plugin-sdk`에 이미 있어 기존 draft 평탄화의 소유자는 WebChannel 플러그인이다(§5.1). block partial dedupe/grouping/exact ownership 및 leading-error exact-once에 필요한 stable public identity는 예외이며 #111의 core 계약 gap이다. |
| 앞 버블 실패 시 턴 전체 실패 | 모델 실행 결과와 transport live-delivery 결과를 혼동한다. history 복구 경로도 있다. |
| `deliver`의 `info.assistantMessageIndex`로 lane 상관 | 그 필드가 존재하지 않는다. `ChannelDeliveryInfo`는 `{kind}`뿐이고 6.10/7.1-2 동일하다(§5.2). 계약 밖 seam을 캐스팅으로 뚫는 것도 #23의 실패를 반복하는 길이다. |
| `dispatcherOptions.beforeDeliver`를 추가해 runtime index 캡처 | custom hook이 assembled reply pipeline의 기존 message-sending rewrite/cancel hook을 대체할 수 있어 관찰하려던 승인 체인을 바꾼다. 공개 lifecycle observer만 합성하고 실제 deliver seam은 그대로 둔다. |
| queued callback payload를 lane 본문으로 materialize | payload는 TTS/media 및 `beforeDeliver` 전이라 rewrite되거나 cancel될 수 있다. tentative reservation/token만 만들고 actual post-hook delivery만 게시한다. |
| `onBlockReplyQueued`↔`deliver`를 payload FIFO/참조/텍스트로 1:1 동일성 상관 | queue 순서와 delivery 순서가 같다는 보장이 없고 hooks/`preparePayload`가 payload를 교체할 수 있다. actual payload는 lane과 무관한 independent claim-or-fresh 경로로 보존하며 reservation을 body/lane ID/owner 선택에 쓰지 않는다. |
| pending reservation이 하나면 actual block을 그 lane에 적용 | sole candidate는 shared identity가 아니다. actual callback 누락 또는 notice→non-notice rewrite 중 unrelated reservation 하나가 남으면 오귀속한다. cardinality 최적화 없이 independent delivery로 보내며 eligible P claim은 순서 보존일 뿐 lane 상관이 아니다. |
| queued callback 수를 delivery credit으로 삼아 actual block suppress | callback은 승인 전이고 actual delivery는 wire-authoritative다. callback-side 결과로 승인된 payload를 폐기하거나 성공으로 회계하면 rewrite/cancel/실패 계약을 깨뜨린다. |
| visible+unclaimed P가 있는데 independent delivery를 무조건 fresh ID로 append | 뒤 lane이 P를 claim하면 reducer가 기존 P 위치를 갱신해 `[B(P),F]`로 역전되고, block-only cleanup은 `[ghost P,F]`를 남긴다. independent delivery도 먼저 P를 reserve해야 한다(C8). |
| independent delivery가 P를 send 전에 영구 claim | transport가 `false`/throw여도 P가 소비되어 뒤 lane/성공 payload가 fresh ID를 쓰고 scaffold가 남는다. send 전에는 reserve만 하고 `visibleReplySent:true`에만 commit하며 실패에는 rollback한다. |
| lane의 첫 partial/final send 전에 P와 `lane.id`를 영구 assign | send가 `false`/throw여도 실패 lane이 P를 독점하고 writer를 끄면 뒤의 성공한 lane/independent payload가 scaffold를 교체하지 못한다. P와 lane assignment 모두 tentative로 두고 실제 `true`에만 commit하며 실패에는 둘 다 rollback한다. |
| claim 뒤 기존 tool/item draft loop를 계속 실행 | client는 ID로 upsert하므로 durable `agent_message(P,F)` 뒤 `progress(P,Working)`가 F를 덮고 working 상태를 다시 연다. lane/independent claim과 동시에 provisional writer를 invalidate하고 이후 scaffold emission을 suppress한다(C8). |
| partial 모드의 모든 `kind:"block"` 무조건 폐기 | actual block은 승인된 가시 payload다. lane dedupe는 못 해도 provisional-or-fresh independent 경로로 전부 보존한다. |
| block notice를 lane/reservation 뒤에 분류 | notice callback이 empty predecessor barrier를 만들거나 actual notice가 assistant lane을 settle한다. 세 notice flag를 callback/actual 양쪽에서 가장 먼저 분류해 독립 경로로 보낸다. |
| 모든 `kind:"final"`을 active lane settle latch로 전달 | `final`은 메시지 ID가 아니며 error/notice/replay가 current assistant lane을 소비해서는 안 된다. first-final-wins latch는 뒤 payload를 삼킨다. |
| 모든 `kind:"final"`을 무조건 fresh ID로 append | leading error 없는 ordinary answer는 causal current lane의 권위 있는 terminal payload이므로 그 lane을 정착해야 한다. terminal/extra independent final은 eligible P를 claim하거나 fresh ID를 쓴다. |
| leading-error 뒤 non-notice final 하나마다 lane cursor 전진 | assistant lane A가 A1/A2 여러 block을 낼 수 있고 final seam에는 identity가 없어 A2를 lane B에 오귀속한다. current/existing lane을 추측하지 않고 모두 provisional-or-fresh independent 경로로 보존한다. |
| queued callback count/order로 final replay atom/group 생성 | 기본 partial에서는 callback 0개 대 final 3개가 가능하고, block mode에서는 coalesced callback 2개 대 final 3개가 가능하다. callback은 tentative block lifecycle에만 쓰고 final과 상관하지 않는다. |
| retained final을 기존/old live lane ID로 upsert | history adoption은 `webchannel-a`를 `core-a1`로 바꾸고 old-id alias를 보존하지 않는다. 기존 canonical ID도 public final identity 없이 고를 수 없다. 각 uncorrelated payload는 eligible P 또는 fresh independent ID만 쓴다. |
| leading-error 후속 final을 이미 보낸 payload라 보고 drop/accounting-only 처리 | callback과 final의 cardinality가 달라 실제 새 payload를 버릴 수 있다. 모든 uncorrelated payload를 전송하고 실제 send 결과를 반환한다. |

---

## 12. 범위 밖

- 히스토리 메시지 메타데이터 확장 → #95
- turn-scoped in-flight signal과 소비 UI → #96/#101에서 `turnActive`로 `develop`에 랜딩; PR2는 이 signal을 변경하지 않음
- 툴 활동 구조화 표면 → #97
- 승인 origin 라우팅 → #93
- reasoning lane의 별도 제품 정책
- 다른 기기에서 시작한 턴의 history/live 영구 중복 → #104
- reasoning activity가 죽은 sibling draft의 stale recovery까지 disarm → #105
- authorized block의 partial dedupe/same-message grouping/exact lane ownership 및 leading-terminal-error 후속 final의 exact-once 화해 → [#111](https://github.com/mir-stream/openclaw-webchannel/issues/111). core가 rewrite/cancel을 지나 실제 `ChannelEventDeliveryAdapter.deliver`까지 유지되는 stable dispatch token 또는 assistant message/block identity를 queued callback, lifecycle callback, actual/terminal delivery에 공개해야 안전하게 lane을 선택·dedupe할 수 있다. `onDeliverySettled`의 optional index만으로는 이미 끝난 wire send의 ID를 고를 수 없다. #94/PR2는 그 전까지 actual block과 uncorrelated final payload를 provisional-or-fresh independent ID로 at-least-once 보존한다.

### 12.1 PR 1에서 발견한 인접 결함 (실측, 2026-08-10)

C1~C8 특성 테스트를 쓰면서 C1~C7 범위에서 클라이언트 화해/valve 쪽 결함 두 건을 실측했다. **둘 다 이 이슈의 원인이 아니고 이 변경으로 고치지 않는다.** 여기 적어두는 이유는 PR 2에서 다시 발견하고 범위를 넓히는 일을 막기 위해서다. C8은 새 client 결함을 주장하지 않고 현재 reducer의 provisional-ID 배열 위치 및 same-ID late-progress overwrite 비용을 고정한다.

**(1) 다른 기기가 시작한 턴은 화해되지 않고 영구 중복된다 — #104, 기존 결함, #94와 무관.**

리듀서의 inbound 프레임 12종 중 **다른 기기의 user 메시지를 라이브로 렌더링하는 것이 없다.** user 버블은 `send()`가 만드는 로컬 `u-<n>` 에코가 유일한 반면, agent 프레임은 공유 `.out`으로 모든 기기에 간다. 따라서 "다른 기기가 시작한 턴을 지켜보는 기기"에는 로컬 user 버블이 없고, tier-3는 anchor가 없으면 발화하지 않으므로(`anchor !== null` 가드) 스냅샷 전 행이 fresh-insert 되어 라이브 버블이 그대로 남는다.

```
로컬 [A1(T1), B1(T2)] + 스냅샷 [u1, a1, u2, b1]
  → [core-u1, core-a1, core-u2, core-b1, webchannel-a1, webchannel-b1]   중복 2
```

턴당 버블이 1개이던 시절에도 동일하게 재현된다. #94는 턴당 중복 **개수**를 늘릴 뿐 이 결함을 만들지 않는다. PR 1의 테스트는 전부 단일 기기 시나리오라 영향받지 않는다.

**(2) `reasoning` 프레임의 turn 단위 disarm이 #94 이후 valve를 약화시킨다 — #105, #94가 도달 가능하게 만든다.**

staleness valve의 disarm은 경로마다 단위가 다르다. `progress`/`agent_message`는 `staleDraftWatch.delete(id)`로 **lane 단위**지만, `reasoning`은 `disarmStaleDraftsByTurn(turnId)`으로 **turn 전체**를 disarm 한다. 턴당 lane이 하나일 때는 둘이 같은 뜻이었다.

#94 이후에는 갈라진다: lane A의 정착 프레임이 유실되고(§8-1) lane B가 계속 스트리밍하는 중에 turn T의 `reasoning` 프레임이 하나 오면, 죽은 lane A까지 watch에서 빠져 **만료되지 않는다.** `turnInFlight()`가 참으로 남아 `turn_settled`/`​/stop`/재접속 재무장 중 하나가 올 때까지 composer가 잠긴다.

이 문제는 **클라이언트 소유이고 플러그인 lane 모델과 독립**이므로 #105로 배출한다. PR 1의 C5b는 `progress`와 `agent_message`가 lane-local임을 각각 고정하지만 reasoning의 turn-wide 정책을 정당화하거나 수정하지 않는다.

### 12.2 PR 2 inbound 리뷰에서 확인한 잔여 위험 (dist 실측, 2026-08-12)

- **leading `errorText` 없는 multi-final도 가능하다 — #111로 유예.** 고정 core 번들의 `node_modules/openclaw/dist/payloads-DMxgzxEO.js:238-241`에서 run의 마지막 assistant message가 tool-only라 `fallbackAnswerSourceText`가 비어 있으면 `shouldUseCanonicalFinalAnswer`가 `false`가 된다. 동시에 `nonEmptyAssistantTexts.length >= 2`이면 core는 leading error/notice 없이 non-error final을 2개 이상 방출할 수 있다. 이미 partial로 A/B가 보인 턴에서 이 final 배열이 오면 첫 ordinary final이 current B lane의 terminal slot을 소비해 B의 streamed body를 A 본문으로 교체하고, 다음 final만 fresh independent bubble로 남는 #94형 live loss가 도달 가능하다. 이 payload들에는 stable final identity가 없어서 플러그인이 어느 lane의 final인지 구분할 수 없고, 본문 비교는 §6.4가 금지한다. 따라서 로컬 text guard는 추가하지 않으며 queued callback과 actual/terminal delivery를 잇는 stable identity를 소유한 #111에서 화해한다.

---

## 13. 완료 정의

- [ ] partial/final ordinary 경로에서 한 턴의 완료된 assistant 메시지 N개가 라이브에서도 N개 버블로 남는다. authorized block과 leading-terminal-error 후속 final은 #111 전까지 provisional-or-fresh independent 중복을 허용한다.
- [ ] 각 메시지는 고유 ID를 가지며 partial은 해당 활성 ID만 갱신한다.
- [ ] first-lane tool scaffold는 provisional ID로 남고 첫 successful lane 또는 independent delivery가 재사용한다. independent owner는 assistant lane을 만들지 않는다.
- [ ] lane generation과 independent delivery sequence 모두 P를 reserve → send하고 lane transport boolean / independent `visibleReplySent`가 실제 `true`일 때만 owner/lane ID와 provisional scaffold-writer invalidation을 commit한다. `false`/throw에는 P와 tentative lane assignment를 rollback하고 writer를 active로 유지한다.
- [ ] successful claim 뒤 tool/item event는 claimed P나 새 scaffold ID로 wire emission하지 않으며 durable P 본문을 덮지 않는다. bubble 사이 in-flight 표시는 base의 `turnActive`(#96/#101)를 사용한다.
- [ ] 다음 boundary 뒤에 늦게 온 `onBlockReplyQueued`도 앞 commentary-only lane의 tentative reservation을 유지한다. callback payload는 wire/body가 아니며, skip/cancel/failure/terminal drain은 empty predecessor를 retire해 뒤 lane의 barrier를 푼다.
- [ ] partial mode의 actual post-hook block delivery를 조용히 폐기하거나 lane에 추측 적용하지 않는다. notice를 먼저 분류한 뒤 reservation 수/상태와 무관한 independent delivery로 보내며, visible+unclaimed P면 reserve/send 후 성공에만 commit하고 P가 없거나 claimed면 fresh ID를 쓴다.
- [ ] queued 원문이 rewrite/cancel되면 원문은 wire에 0회다. cancel(A) → B에서 A ghost/barrier가 없고, actual send `true`/`false`/throw가 모두 lifecycle cleanup 뒤 queue를 살려 둔다.
- [ ] `isStatusNotice`/`isFallbackNotice`/`isCompactionNotice` block은 callback과 actual 양쪽에서 lane logic보다 먼저 분류된다. actual notice만 독립 전송되고 assistant lane을 생성·정착·차단하지 않는다.
- [ ] leading error 없는 첫 ordinary answer final만 current lane의 terminal slot을 확정한다. terminal notice와 leading error 뒤 identity 없는 모든 non-notice payload는 lane을 소비하지 않고 같은 provisional-or-fresh independent 경로로 보존한다.
- [ ] (a) block callback 0개와 (b) coalesced callbacks `[A1+"\n\n"+A2@0,B@1]` 모두 final `[error,A1,A2,B]`를 만나면 기존 A/B는 불변이고 error/A1/A2/B가 모두 보존된다. callback 수로 final을 drop/group하지 않으며 의미상 중복은 명시적으로 수용한다.
- [ ] 각 lane transport boolean / independent `visibleReplySent`의 실제 결과를 보존한다. `true`에만 provisional claim을 commit하고 `false`/throw에는 rollback하며 queue와 나머지 delivery를 계속 처리한다. 실패 frame은 blind inline retry하지 않는다. answer → timeout/warning 순서에서도 어느 payload도 settle latch에 삼켜지지 않는다.
- [ ] 첫 lane frame `progress(partial)`/`agent_message(final-only)` × `false`/throw × 뒤 successful lane/independent의 조합에서 실패 lane은 committed P/ID를 남기지 않고 뒤 성공이 P를 사용한다. partial-first 실패 lane의 later update는 이미 claimed P 대신 fresh ID를 쓴다.
- [ ] history snapshot이 live A/B ID를 canonical ID로 adopt한 뒤 fresh fallback은 canonical A/B를 mutate하지 않고 append된다. old live ID 추측도 하지 않으며 exact-once는 #111 범위다.
- [ ] ordinary partial/final 경로의 live와 history hydrate 메시지 **수와 순서**가 일치한다(§6.5.1의 방어 회전, authorized-block 및 leading-error at-least-once 예외 제외).
      **본문 일치는 완료 조건이 아니다** — core는 라이브 응답에서 메타데이터 구획을 걷어내고 transcript에는 원본을 저장하므로 두 텍스트는 애초에 byte-equal이 아니다(`nats-client-wrapper.ts:1052-1054`). 본문 수렴은 hydrate의 정본 텍스트 채택(`adoptAt`)이 담당하며, 이 이슈가 보장할 대상이 아니다.
- [ ] 메시지 동일성 판정에 `includes`/suffix/문자열 split을 사용하지 않는다.
- [ ] 앞 lane 전송 실패 후에도 모든 final payload 전달이 시도되고 실패 delivery의 실제 결과가 보존되며 queue가 살아 있다.
- [ ] abort/error/단일 메시지/progress/block/off 경로에 회귀가 없다.
- [ ] 중단/에러 경로에서 빈 lane 버블도 중단 마커 버블도 생기지 않는다. successful lane/independent claim은 scaffold cleanup을 금지하고, 모든 durable delivery가 실패하거나 없는 unclaimed tool-only preview만 no-delete 예외로 같은 ID에서 settle한다(§6.2-3, §8-6).
- [ ] history 화해 비대칭(C3/C4), later-snapshot adoption, 다중 draft watchdog(C5a/C5b), lane provisional-ID reuse(C6), snapshot adoption 뒤 fresh-fallback/stale-ID append 비용(C7), independent same-P 순서와 fresh-first 역전/ghost 및 late-scaffold overwrite 비용(C8)이 테스트로 고정된다.
- [ ] 다중 어시스턴트 메시지 턴이 e2e에서 두 개의 서로 다른 id로 정착한다.
- [ ] 계약 밖(core 내부 번들) 의존을 새로 늘리지 않는다 — 신규 근거는 `plugin-sdk` export만 인용한다.
- [ ] build/typecheck/plugin tests/full tests가 모두 통과한다.

---

## 14. compact 이후 구현 시작점

PR 1 완료 시점에는 **문서와 client characterization test만 수정되고 production 코드는 그대로다.** 플러그인 구현과 M/I/e2e 테스트는 PR 2에서 함께 들어간다.

**선행 조건:** clean checkout에 `node_modules`가 없으면 `npm install`을 먼저 실행한다.

### 14.1 PR 분할 (확정)

**PR 1 — 클라이언트 화해 특성 테스트 (테스트 전용, 소)**
`packages/client/src/nats-client-wrapper.test.ts`에 §10의 C1~C8을 추가한다. 플러그인 변경과 완전히 독립이며 합성 프레임만으로 검증된다. 목표는 프로덕션 무변경이다. C6은 새 프로토콜 없이 lane의 provisional ID reuse가 ghost 없이 작동함을 고정한다. C7은 snapshot adoption 뒤 canonical A/B를 건드리지 않는 fresh fallback과 old live ID alias가 없어 stale-ID upsert도 append되는 현재 client 제약을 실측한다. C8은 independent delivery가 P를 먼저 쓴 올바른 `[F(P),B(new)]`/block-only `[F(P)]` 형상과, 일부러 fresh-F 뒤 P-B/turn settle을 주입했을 때 `[B(P),F]`/`[ghost P,F]`가 되는 reducer 비용을 함께 실측한다. 또한 durable `agent_message(P,F)` 뒤 late scaffold `progress(P,Working)`가 F를 덮고 working으로 되돌리는 비용을 고정한다. exact-once나 alias 보존을 주장하지 않고 client production alias map도 이 PR에 추가하지 않는다.

**작성 규칙 (리뷰 2라운드에서 두 번 어겨 정한다).** 특성 테스트의 가치는 주석에 있고, 주석이 테스트보다 강한 주장을 하면 다음 사람을 오도한다. **"이 테스트가 X를 구속한다"고 쓸 거면 X를 깨는 뮤테이션을 실제로 돌려 확인하고 쓴다.** 확인하지 못하면 "이 형상이 이렇게 수렴한다"는 사실 기록으로만 쓴다. 실제로 이 규칙 없이 쓴 주석 두 개가 자명하게 참인 assertion(C4 오라벨, 구 C3의 짝짓기 주장)을 감추고 있었다.

이걸 먼저 떼는 이유: C3(라이브 1 / snapshot 2)와 C4(라이브 3 / snapshot 2)는 3-tier 매칭을 추적해 보면 **현재 우연히 맞지만 테스트로 고정된 적이 없다.** 만약 실제로 틀렸다면 그건 `nats-client-wrapper.ts` 프로덕션 수정이고, 메인 PR 안에서 터지면 "메시지 경계 수정"이 클라이언트 화해 로직 수정까지 껴안게 된다. 먼저 확인하면 어느 쪽이든 메인 PR이 깨끗하다.

**PR 2 — #94 본체 (대, 원자적)**
provisional preview + lane/independent two-phase claim owner + success-only scaffold-writer invalidation + ordered/unresolved lane 모델 + tentative ordering reservation/notice token + dispatcher lifecycle cleanup + authoritative independent claim-or-fresh 처리 + inbound 배선 + M1~M13(세분 케이스 포함) / I1~I26 + e2e 게이트. **더 쪼개면 깨진다** — inbound가 tool/item, partial/final, 경계, queued block, actual delivery, lifecycle을 함께 넘기지 않으면 adapter는 preview reserve/commit/rollback, tentative lane-ID cleanup, writer invalidation, late barrier, cancellation cleanup과 generation-order emission을 운용할 수 없다. adapter에 retained lane/reservation이 없으면 cancel(A) → B의 ghost/영구 barrier 방지도 성립하지 않는다. §6.5 fail-safe도 못 뗀다. 현재 코드에 이미 `absorbedMissedBoundaries` 방어가 있어서, 빼고 먼저 내보내면 #23이 막아둔 것을 되돌리는 셈이다.

**기각한 분할:** "id는 하나로 둔 채 `answerPrefix`만 배열로 바꾸는 무동작 리팩터를 먼저" 안. 회전 없는 lane 구조는 2단계에서 다시 쓰이므로 버려질 코드를 리뷰시키게 된다. 대신 **PR 2 안에서 커밋을 ① adapter lane 모델 ② inbound 배선 ③ 테스트 ④ e2e 순으로 나눈다.** 분할 PR의 리뷰 이점 대부분을 얻으면서 버려지는 중간 상태를 만들지 않는다.

### 14.2 구현 순서 (PR 2)

아래 순서로 바로 시작한다. 재조사는 필요 없다.

1. `packages/plugin/src/channel.test.ts`의 기존 “두 assistant 메시지가 한 ID에 합쳐진다” 테스트를 두 ID/두 버블 기대값으로 바꾸고, final이 앞 메시지를 인용하는 실패 테스트를 먼저 추가한다. 이어 tool scaffold → empty boundary → answer, late reservation, rewrite/cancel, cancel(A) → B, actual send `true`/`false`/throw, 세 notice flag, (a) callback 0개 및 (b) coalesced callback 2개 + 동일 final `[error,A1,A2,B]`의 at-least-once red test를 추가한다. M13/I21~I26의 independent claim 순서/late tool suppression과 lane first-frame partial/final × false/throw × later lane/independent success matrix도 먼저 red로 만든다.
2. `packages/plugin/src/message-adapter.ts`의 턴 고정 `id`/`answerPrefix`를 owner가 lane generation 또는 independent delivery sequence인 provisional claim state, tentative lane ID, ordered lane 목록, unresolved predecessor, persistent late-indexless barrier, tentative reservation/notice token, actual independent disposition, final phase, lane별 settle latch로 교체한다. 모든 P-bound lane/independent send의 reserve → send → success-only commit / false·throw rollback을 queue 안에서 원자적으로 처리한다.
3. `pushAnswerText`가 문자열만 받지 말고 `text`/`delta`/`replace`를 보존하도록 바꾼다.
4. `packages/plugin/src/inbound.ts`에서 tool/item, partial/final, boundary, queued-block/actual delivery와 dispatcher `onSkip`/`onBeforeDeliverCancelled`/`onDeliverySettled`, delivery `onError`를 같은 직렬 queue에 넣는다. lane progress/final 실제 결과를 claim helper에 반환하고, `onBlockReplyQueued`의 optional index는 reservation에만 쓰며 `deliver`의 `info`에서는 `kind`만 읽는다. custom `beforeDeliver`는 추가하지 않는다.
5. plugin 테스트가 green이 된 뒤 client의 다중 ID reducer 회귀 테스트와 전체 게이트를 실행한다.

구현 중 다시 열면 안 되는 결정:

- boundary는 lane 순서를, `onBlockReplyQueued`는 tentative ordering reservation만 제공한다. callback text/media는 body가 아니고 actual block owner도 고르지 않는다. first tool scaffold는 lane 소유가 아니라 provisional preview다. final 본문을 `includes`/suffix로 비교하지 않는다.
- **actual `deliver`에는 `assistantMessageIndex`가 없다**(§5.2). lifecycle observer의 optional index는 cleanup을 돕지만 이미 승인된 wire ID를 고르지 못한다. private cast나 custom `beforeDeliver`로 우회하지 않는다.
- callback과 actual block은 notice flag를 가장 먼저 분류한다. actual notice만 독립 전송하고 lane을 건드리지 않는다.
- partial mode의 actual block은 reservation 수/상태와 무관한 independent delivery다. notice를 먼저 분류하고, visible+unclaimed P면 independent sequence가 reserve해 P ID로 보내며 `true`에만 commit한다. `false`/throw는 rollback하고, P가 없거나 이미 claimed면 fresh ID를 쓴다. callback 결과로 actual delivery를 suppress하거나 pre-hook payload를 보내거나 lane body/ID/owner를 선택하지 않는다.
- leading error 없는 첫 ordinary answer final만 current lane terminal slot을 소비한다. leading terminal error는 lane을 소비하지 않고, 그 뒤 identity 없는 모든 non-notice final은 callback과 무관한 independent claim-or-fresh 경로를 쓴다.
- `onBlockReplyQueued`는 같은 assistant 메시지에 여러 번 올 수 있다. **block 하나를 메시지 하나로 가정하지 않는다.**
- `onBlockReplyQueued` count/order/index는 final payload를 classify/count/suppress/group하지 않는다. 기본 partial의 callback 0개와 block coalescing의 callback 2개가 같은 final 3개를 만들 수 있다.
- `onBlockReplyQueued`가 다음 boundary보다 늦게 호출될 수 있다. 직렬 queue만으로 고쳐졌다고 가정하지 않고 unresolved predecessor/emission barrier를 유지한다. indexless late owner는 lifecycle/terminal drain까지 유지하되 callback만으로 materialize하지 않는다.
- `onSkip`/`onBeforeDeliverCancelled`/`onDeliverySettled`와 delivery `onError`는 같은 queue로 들어가며 cleanup은 idempotent하다. skip/cancel/failure한 tentative A가 B를 영구 차단하거나 ghost를 만들면 안 된다.
- settle latch는 턴별이 아니라 lane별 normal terminal send용이다. preview claim owner와 lane의 `started`를 분리하고, leading-error 후속 final은 cached settle 결과에 삼키거나 기존/stale lane ID에 적용하지 않고 independent claim-or-fresh로 실제 전송한다.
- visible provisional preview는 event queue에서 첫 **successful** lane 또는 independent delivery가 claim한다. lane generation과 independent sequence 모두 P를 reserve/send한 뒤 실제 `true`에만 owner를 commit한다. lane `progress`/final이 `false`/throw면 P와 tentative lane ID를 rollback하고 writer를 active로 둔다. 같은 frame을 inline retry하지 않으며, 뒤 lane/independent success가 P를 재사용할 수 있다. 그 뒤 실패 lane의 later update는 P가 이미 claimed면 fresh ID를 쓴다.
- successful lane/independent commit과 동시에만 provisional scaffold writer/draft loop를 invalidate한다. 이미 enqueue된 tool/item event도 claim state를 재확인해 claimed P와 새 ID 모두에 scaffold `progress`를 보내지 않는다. committed lane의 answer partial writer는 별개라 자기 lane ID 갱신을 계속할 수 있다. bubble 사이 in-flight 표시는 base에 랜딩한 #96/#101 `turnActive`를 유지하고, 구조화된 tool 상세는 #97 범위로 남긴다.
- preview가 claim된 뒤 회전한 lane은 어시스턴트 텍스트가 생기기 전까지 새 answer `progress` ID를 보내지 않는다. 프로토콜에 버블 삭제가 없어서, 한 번 보이면 반드시 버블로 남는다(§6.2-3).
- 위험한 클라이언트 표면은 reducer가 아니라 history 3-tier 화해 로직이다(§10 C3/C4).
- 앞 lane send 실패가 queue를 reject 상태로 고정하거나 뒤 lane/추가 final을 막아서는 안 된다.
- tool/item progress scaffold는 완료된 assistant 메시지가 아니며, 빈 first lane의 durable ID도 아니다.

현재 코드에서 바로 볼 지점:

- `message-adapter.ts`: `const id = nextMessageId()`, `answerText`, `answerPrefix`, `handleAssistantMessageBoundary`, turn-wide `finalizeResult`
- `inbound.ts`: `onPartialReply`가 `p.text`만 넘기는 부분, `onAssistantMessageStart`, `draft.finalize(text)` final 분기
- `channel.test.ts`: `preserves earlier message text across an assistant-message boundary...` 테스트가 현재 잘못된 one-id 계약을 고정함

GitHub #94의 제목/본문도 이 문서와 같은 확정안으로 유지한다. exact-once identity 의존성은 #111에 링크한다.
