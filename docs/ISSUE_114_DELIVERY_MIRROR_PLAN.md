# Issue #114 — 플러그인 소유 delivery journal: 클라이언트가 보는 durable identity의 SSOT

- 이슈: [#114](https://github.com/mir-stream/openclaw-webchannel/issues/114) (keystone)
- 엄브렐러: [#212](https://github.com/mir-stream/openclaw-webchannel/issues/212)
- 관련: [#95](https://github.com/mir-stream/openclaw-webchannel/issues/95) (history 계약), [#104](https://github.com/mir-stream/openclaw-webchannel/issues/104) (client 중복), [#111](https://github.com/mir-stream/openclaw-webchannel/issues/111)·[#215](https://github.com/mir-stream/openclaw-webchannel/issues/215) (live final-routing ceiling), [#223](https://github.com/mir-stream/openclaw-webchannel/issues/223) (ordinal desync), [#227](https://github.com/mir-stream/openclaw-webchannel/issues/227)/[#228](https://github.com/mir-stream/openclaw-webchannel/issues/228) (client 재구성 케이스)
- 상태: **v6 설계 = THE 설계 (구현 전).** v1~v3 REJECT(폐기), v4/v5(§14/§15)는 진화 뼈대. **v5는 §16.2의 9개 Telegram-정련 + §16.5/§16.6를 반영해 v6로 흡수됨 — v6가 최종.** v6가 v5를 4곳 뒤집음(서버-배정 id, persist-before-publish, 영구 delete, per-conversation seq). **v5 뼈대 통찰 유지: "저널=클라가 쓰는 정확한 순서 이벤트 스트림, history=클라 자신의 reducer 재생"**(서버가 순서/tombstone 규칙 발명 안 함). 회귀 방화벽=§0.2, 식별자 결정판=§16.5. 리뷰 통과 전 코드 없음.

---

## 0. 북극성과 절대 규칙 (회귀 방지 앵커)

> **우리 플러그인 = Telegram 플러그인 + Telegram 서버.**
> **우리 클라이언트 = Telegram 앱.**

우리 플러그인은 실제 Telegram에서 **둘로 나뉘는 두 역할을 혼자 다 한다.** 그래서 질문이 오면 **어느 역할의 레퍼런스를 읽어야 하는지**부터 정한다:

| 역할 | 담당 질문 | 읽을 레퍼런스 (clone된 core) |
|---|---|---|
| **Telegram 플러그인** (core↔전송 브릿지) | 배달 시점 id 배정, live 라우팅, "현재 draft 마감", 못 붙는 final=새 메시지 | `[core] src/channels/message/live.ts`, `send.ts`, `src/auto-reply/reply/` |
| **Telegram 서버** (SSOT 저장/프로토콜) | 저널·history 소유, message_id 배정, per-conversation seq, gap-sync, persist-before-publish | Telegram 서버/프로토콜 모델 (§16.0/§16.2) |

**핵심 함의(회귀 차단):** 내장 Telegram 플러그인은 core에서 **식별자-없는 `onAssistantMessageStart()`(인자 0개)** 를 받고도 identity를 스스로 소유한다 — **배달 행위**에서 만든다. **우리가 그 플러그인이다.** 따라서 "core가 id/ordinal을 안 줘서 못 한다"는 **영원히 성립 불가**다. → [[아닌 것 목록 §0.2]] N1/N5.

- **플러그인이 SSOT다. 그리고 SSOT는 플러그인이 "자기 저장소"에 담는다.**
  플러그인이 답변마다 자기 id를 발급하고, 그 id로 live 전송하고, **자기 store에 durable하게 쓰고, history를 자기 store에서만 서빙한다.**
- **클라이언트는 순수 view다.** text·위치로 identity를 추측하지 않는다. 서버가 준 id를 그대로 신뢰한다.
- **core transcript는 클라이언트용으로 읽지 않는다.** core transcript는 core의 LLM-문맥 자료다(그 목적으로는 이미 잘 동작한다). 우리가 클라이언트에게 보여줄 대화는 **우리 journal**이다. 두 저장소는 목적이 다르며 섞지 않는다.
- 미래의 Tool message·reasoning까지 우리가 다루려면 core가 무엇을 저장하느냐에 **의존할 수 없다.** 그래서 identity와 저장을 플러그인이 소유한다.

### 0.1 두 identity 문제 — 혼동 금지, 그러나 **둘 다 플러그인 소유** (S1 철회 반영, 2026-08-23)

질문은 **두 개**지만, **답의 소유주는 하나(플러그인)** 다. 예전엔 (1)을 "core-limited"라 적었는데 **그게 회귀의 씨앗이었다 → 철회.** (§16.1 S1)

1. **LIVE final-routing** — "이 identity 없는 final/block을 어디에 붙이나?"
   → **플러그인 소유. "배달 행위"에서 정한다.** 내장 Telegram 채널 그대로: **현재 draft를 마감**(`editFinal(previewId, edit)`), 현재 draft에 **못 붙는 final은 degrade가 아니라 그냥 새 메시지**(`kind!=="final"||!draft → deliverNormally`, `[core] live.ts`). ordinal/`assistantMessageIndex` 매칭은 **금지** — 그게 #215/#223 자충수였다. → [[아닌 것 목록 §0.2]] N5/N10.
2. **DURABLE client-facing identity** — "클라이언트가 보는 id는? live에서도, 리로드 후에도?"
   → **플러그인 소유.** 서버가 messageId 배정(+클라 random_id) → live → 저널 commit(**publish 전**) → 저널에서 history 서빙. **core 의존 없음, core transcript 안 읽음.**

**두 질문의 유일한 차이는 "언제"다** (배달 순간 vs 영속 서빙) — **어느 쪽도 core 한계가 아니다.** "core의 id/ordinal은 못 믿는다"는 probe 결과는 **문제 정의 자체가 틀린 것**이다: 우리는 core의 id를 애초에 안 쓴다. **history를 core transcript에서 읽으려는 충동 = 이 혼동의 증상**(→ N2). 유일한 진짜 구조적 한계는 **S3(gateway 오프라인)** 뿐(§16.1).

### 0.2 아닌 것 목록 (NOT list / anti-index) — **말·설계·리뷰 전에 먼저 읽어라**

> **이 목록의 존재 이유:** 회귀는 항상 "폐기된 경로가 압축 후 새것처럼 보여서" 일어난다. 폐기 *라벨*은 살아남아도 폐기 *이유*는 안 살아남기 때문이다. 그래서 여기 **각 오판 = 반증하는 한 문장 + 30초 재검증 지점**을 박제한다. **무언가를 "core 한계다/구조적이다/불가능하다/이게 스펙이다"라고 말하기 전에 이 표에 이미 죽어 있는지 확인하라.** 새 회귀를 저지르면 여기에 한 줄 추가한다.

| # | ❌ 아닌 것 (하지 말 것) | ✅ 반증하는 사실 (재검증 지점) | 왜 자꾸 재발하나 |
|---|---|---|---|
| **N1** | "core가 답변별 id를 안 줘서 identity는 core-limited다" | 내장 Telegram 채널도 **똑같은 인자-0개 `onAssistantMessageStart()`**(`[core] embedded-agent-subscribe.types.ts:70`)를 받고 **배달 행위**에서 id를 만든다(`[core] src/channels/message/live.ts`). **우리가 그 플러그인이다.** (S1, 철회) | core의 **타입 표면**(void 콜백)을 능력 천장으로 오독. 레퍼런스 동작을 안 읽음 |
| **N2** | 클라 history를 위해 core transcript/`getSessionMessages`를 읽거나 core에 mirror-후-되읽기 | SSOT=플러그인이 **자기 store에서** history 서빙. v1(mirror-into-core+되읽기+dedup)은 claude·codex **둘 다 P0 REJECT** — mirror row와 LLM row는 **text/위치밖에** 공유 안 함(§2.2) | 압축 후 코드 다시 보면 `getSessionMessages`가 "원래 방식"처럼 읽힘 |
| **N3** | "tool·reasoning·notice·approval은 ephemeral이라 durable 아님/gap 아님" | plugin=Telegram-**서버**는 service message를 보존한다. 판별 기준은 **MESSAGE vs INDICATOR**. 순수 표시기(isTyping, 마감 전 rolling draft)만 ephemeral. 현재 클라의 분리된 ephemeral 배열이 **고칠 위반**(§15.9) | 현재(타협된) 클라 구현을 스펙으로 착각 (→ N7) |
| **N4** | "클라가 보는 durable id는 core-blocked, core가 줘야 함" | durable client-facing id는 **플러그인 소유**: 서버 messageId 배정 + 클라 random_id(§16.2-1). core 의존 0 | 하위목표를 "core의 id를 읽어 전달"로 잘못 정의 |
| **N5** | ordinal/`assistantMessageIndex`/위치를 **정체성 키**로 써서 final↔lane 매칭 | **현재-draft 마감** 모델. ordinal 매칭이 **#215/#223 자충수**(§16.1). count/위치로 identity 추론 = 0.6.1 post-mortem 근본원인. **정밀판(§16.5): 내장 Telegram도 ordinal을 쓰긴 함 — 단 block-회전 힌트로만, 정체성 키로는 절대 안 씀.** ordinal 자체가 금지가 아니라 "정체성으로 쓰기"가 금지 | 콜백 순서가 ordinal을 "무료 제공"하는 것처럼 보임 |
| **N6** | agent 답변을 publish 후에 커밋(commit-after) | **persist-before-publish**: egress 시점엔 텍스트가 이미 있어 유령 없음 = Telegram persist-then-deliver(§16.2-2, §15.8 뒤집음) | "보낸 걸 기록"이 순서상 자연스러워 보임 |
| **N7** | "현재(shipped) 클라/플러그인 동작 = 스펙" | shipped 코드는 재설계가 없애는 문제의 **타협**을 품고 있다. 항상 물어라: **"이게 원칙인가, 타협된 코드가 우연히 그렇게 도는 것뿐인가?"** 같은 core의 레퍼런스(내장 채널)를 읽어라 | 압축 후 코드가 유일한 ground truth로 보임 (모든 회귀의 상위 원인) |
| **N8** | "live와 history는 (의도적으로) 다를 수 있다" | 우리가 스트림 전체를 소유 → 차이는 전부 **버그**. live==history는 **절대**(공유 reducer로 양쪽 보장, §15.9) | 상태/tool 버블 렌더 차이를 "gap"으로 합리화 |
| **N9** | partial-first/모드 의존 저널, legacy fallback·epoch 마커 유지 | SSOT는 모드 의존 불가. **파괴적 컷오버 승인**("아직 아무도 안 씀") → 저널이 첫날부터 유일 store, cutover/epoch/legacy 기계 **전부 삭제**(§15.6) | "안전한 전환기"가 신중해 보임 (실은 원칙 후퇴) |
| **N10** | 못 붙는 final → degrade/skip, 안 그림 | **현재-draft 우선 마감 → 안 되면 새 메시지(또는 애매하면 preview 유지)**, degrade 아님(§16.1, 정밀판 §16.5). ("skip-degrade, never guess"는 옛 §0.1의 오판 잔재) | 옛 "core ceiling→degrade" 어법이 압축 후 되살아남 |

**메타 규칙(N1·N3·N5의 공통 근본):** 무언가를 **"core-limited / 구조적 / 불가능"** 이라 단정하기 전에 — **같은 core 위의 레퍼런스(내장 Telegram 채널, clone `/home/orca/workspace/openclaw` `src/channels/message/`·`src/auto-reply/reply/`)가 어떻게 하는지 먼저 읽는다.** 세 번(getSessionMessages, tool-durable, S1) 다 이걸 안 해서 나온 오판이다.

---

## 1. 문제 정의 — 근본 원인 하나

세 delivery 경로(`onPartialReply`, `deliver(block)`, `deliver(final)`)와 durable 저장 사이에 **답변 하나를 가리키는, 플러그인이 소유한 안정적 identity가 없다.** 그래서 양쪽이 추측한다.

- **플러그인**은 core의 ordinal로 추론 → compaction/fallback에서 desync (#223, post-mortem P2-F1/F2).
- **클라이언트**는 text/위치로 추론 → 크로스디바이스/리로드에서 중복·덮어쓰기 (#104/#227/#228, post-mortem P3-F2).

#212의 모든 증상은 이 한 gap의 다른 얼굴이다. **해법: 플러그인이 답변마다 자기 id를 발급→journal에 durable 기록→live/리로드 모두 같은 id로 서빙.** 그러면 양쪽의 추측이 사라진다.

---

## 2. 결정 — 플러그인 소유 delivery journal (v1 폐기 이유 포함)

### 2.1 채택: plugin-owned delivery journal

플러그인이 배달하는 대화 메시지(user + agent)를 **플러그인 소유 durable store(journal)**에 우리 id로 기록한다. history는 그 journal에서만 서빙한다. 이것이 Slack/Telegram이 실제로 하는 방식이다: `sendMessage`가 서버 메시지 id를 돌려주고, history가 **같은** id를 돌려준다. 어느 클라이언트도 플랫폼 메시지를 별개의 LLM transcript row와 짝맞추지 않는다(§3.4).

### 2.2 폐기: v1 = delivery-mirror-into-core-transcript (dead end, 다시 열지 말 것)

v1은 `appendAssistantMirrorMessageByIdentity`로 core transcript에 미러 row를 쓰고, `getSessionMessages`로 되읽어 우리 미러 row와 core LLM row를 짝맞춰 dedup하려 했다. **claude·codex 독립 적대 리뷰 둘 다 P0로 REJECT.** 확정된 이유:

- **짝맞추기 키가 존재하지 않는다.** 미러 row는 `sourceMessageId`(우리 id)를, LLM row는 무관한 core row id를 가진다. 두 row가 공유하는 건 **text/위치뿐** — 우리가 버리려는 anti-pattern. 부분적으로만 미러된 turn마다 **중복 아니면 누락** (수학적으로 불가피). [claude F1, codex P0-1, 둘 다 CONFIRMED]
- **core 자신도 이 짝맞추기를 안 한다.** transcript owner가 있으면 core는 auto-mirror를 **끈다**(`hasTranscriptOwner` → mirror off; `dispatch-DnzGTpPs.js:604,1654`). 즉 "mirror + owner 공존"을 애초에 피한다. [codex F7, CONFIRMED]
- linchpin(read가 태그를 보존)은 **무조건 참이 아니다**: 256KiB 초과 row는 placeholder로 투영돼 provider/model/openclawDeliveryMirror가 **전부 소실**된다(`session-utils.fs:571,606`). [codex F8, CONFIRMED]
- send-then-mirror는 **크래시 갭**이 영구적이고, 미러 실패 시 fallback이 core id를 노출 → §0.1이 금지한 core 의존으로 회귀. [codex P0-3/claude F4]

교훈: **남의 저장소를 되읽어 섞고 dedup하려는 순간 다시 추측이다. 우리는 우리 저장소를 쓴다.**

---

## 3. 검증된 사실 (근거 강도 분리; `ISSUE_95`의 규율)

태그: **[계약]** = `plugin-sdk/*.d.ts` 공개 shape(의존 가능) · **[우리코드]** = 이 레포(우리가 바꿈) · **[core-static]** = 핀된 core 번들 static observation(동작 이해용, 의존은 계약으로만).

### 3.1 플러그인은 자기 소유 durable store를 가진다 — [계약]

- `PluginStateKeyedStore<T>` / `PluginStateSyncKeyedStore<T>` (`plugin-sdk/plugin-state-runtime.d.ts` → `plugin-state-store.types-*.d.ts:9-41`): `register / registerIfAbsent / update? / lookup / consume / delete / entries / clear`. SQLite+WAL 백엔드(`sqlite-wal`, `configureSqliteConnectionPragmas`).
  - `OpenKeyedStoreOptions = { namespace, maxEntries, overflowPolicy?: "evict-oldest"|"reject-new", defaultTtlMs? }` (같은 파일 44-50). **주의: `maxEntries` 필수 = 바운드 store.** 무한 로그엔 부적합할 수 있음 → 보존/eviction 정책 결정 필요(§6-저장).
- `json-store` (`plugin-sdk/json-store.d.ts`): `saveJsonFile / loadJsonFile / writeJsonFileAtomically / readJsonFileWithFallback` — 우리 스키마의 atomic JSON 파일. 무한, 완전 우리 소유.
- `state-paths` (`plugin-sdk/state-paths.d.ts`): `STATE_DIR`, `resolveStateDir` — 저장 위치.

→ **journal은 계약으로 buildable.** 저장 매체 선택(keyed store vs json 파일 vs SQLite 직접)은 §6.

### 3.2 [실측] partial/progress 모드: controller가 이미 drain에서 답변별 authoritative {id, text}를 낸다 — [우리코드]

`emitTurnSnapshot`(`message-adapter.ts:1678-1698`)이 drain(버퍼 final flush 후, `turn_settled` 전)에서 `turn_snapshot`을 방출한다:

- `answers = state.lanes.filter(streamedVisibleAnswerText).map(lane => ({ id: lane.id ?? nextMessageId(), text: answerTextIsAuthoritative ? answerText : streamedAnswerText }))` — **답변 lane마다 {id, 최종 text}**.
- `id`는 lane이 live로 쓴 그 wire id(없으면 새 id) → **live id == snapshot id.**
- `remove[]`는 플러그인이 오배송을 아는 bubble id.
- wire 계약: `turn_snapshot { turnId, answers:[{id,text}], remove[] }` (`channel-contract.ts:92-97`). 클라이언트는 이미 이걸 적용한다.

⚠️ **[라운드-2에서 이 전제가 REFUTED됨 — "snapshot을 적으면 됨"은 틀렸다]**
turn_snapshot은 **완전한 턴 기록이 아니라 교정 패치다.** 계약(`channel-contract.ts:79-90`)이 명시: 클라이언트는 `answers`/`remove`에 든 것만 교체하고 **나머지 모든 버블(notice, error, final-only 답변, adopted history)은 보존**한다. 그래서:
- **final-only 답변(예: A,B는 스트리밍, C는 final-only)은 `answers`에서 빠진다** — shipped 테스트가 C 누락·overflow 누락을 고정(`message-adapter.test.ts:472-505, 602-644`). snapshot만 저장하면 리로드 때 C가 **삭제**된다.
- **progress 모드는 `onPartialReply`가 없어**(`inbound.ts:979-985`) `streamedVisibleAnswerText`가 안 켜져 `answers`가 **빈다**. → snapshot이 답변 text를 주는 건 **partial 모드뿐.**
- snapshot text도 `answerTextIsAuthoritative`일 때만 최종; 아니면 streamed fallback(최종 tail 누락 가능).

→ **결론(수정): journal은 snapshot이 아니라 "실제 배달 지점"에서 채워야 한다.** 즉 클라이언트로 성공적으로 보낸 **모든 agent 버블**을 그 send site에서 {id, text}로 journal에 기록하고, drain의 `remove[]`/authoritative-final을 **교정**으로 적용한다(codex 라운드-1 step 6: "commit a callback from the actual committed wire-send sites"). 이것이 진짜 "delivery outbox"다. **"얇은 층" 아님 — controller의 모든 send site + off/block send + 전 모드 id 민팅 + 순서 seq + 트랜잭션 저장을 건드리는 실질 서브시스템.** §5/§6를 이에 맞게 재설계해야 함.

### 3.3 [실측] off/block 모드엔 답변 id가 아예 없다 — 스코프 경계 — [우리코드]

> ⛔ **이 절의 두 주장은 SUPERSEDED다 — PR #250(#238)이 뒤집는다.** 거기서 플러그인은 **모든 배달 행위(delivery act)에서 id를 민팅**하며 off/block의 plain send도 포함한다. 그래서 (a) 아래 `sendText(wsKey, text, undefined, turnId)`만 나가고 client가 `a-N`을 자체 발급한다는 **[실측]은 더 이상 성립하지 않고**, (b) "off/block의 durable id는 **분리된 후속**"이라는 스코프 판정도 끝났다 — 그 후속이 바로 #238이다. 식별자 최종 판정은 **§16.5**. 아래 본문은 **당시 측정 기록(역사)** 으로만 남긴다.

- `turn_snapshot`/draft는 `streaming.mode ∈ {partial, progress}`에서만 생긴다(`inbound.ts:1014-1017`). "block"/"off"는 draft 없음(`inbound.ts:985`) → snapshot 없음 → 답변 id 없음. `sendText(wsKey, text, undefined, turnId)`만 나가고 client가 `a-N` 자체 발급(`nats-client-wrapper.ts:2562`).
- 플러그인 기본 streaming 모드는 "off"(`message-adapter.ts:146-149`). **단 [실측] 제품/데모는 partial로 돈다** — `run.sh:287`이 `"streaming":{"mode":"partial"}` 설정(`docs/gaps/P0_CORE_CHAT_GAPS.md:472-473`). ⚠️ operator가 `channels add`로 수동 등록하며 mode를 안 주면 "off" → journal-only history가 비어 **회귀**. off-mode history 연속성은 §6에서 처리(전환기엔 off/block에 `getSessionMessages` fallback 유지).
- **그러나 #212 identity 버그(#173/#172/#104 …)는 전부 partial 모드에서 발생**한다 — lane/다중답변이 거기만 존재(`docs/gaps/P1_RICH_UX_GAPS.md`). off/block은 답변당 plain send라 그 오배송·재구성 버그가 안 생긴다.

→ **#114는 partial/progress를 먼저 SSOT화한다**(버그가 사는 곳, 재료가 이미 있음). off/block의 durable id는 **분리된 후속**(id 민팅 신설 필요; 더 큼; 급하지 않음).

### 3.4 플랫폼 레퍼런스 (adopt) — [reference]

- Slack `chat.postMessage`는 서버 메시지 id(`ts`)와 완성 메시지를 반환; `conversations.history`가 **같은** `ts`를 돌려준다.
- Telegram `sendMessage`는 보낸 `Message`(chat 내 유일한 `message_id`)를 반환.
- **어느 쪽도** 플랫폼 메시지를 별개의 LLM transcript row와 재조정하지 않는다. → 우리 journal 모델이 이 구조다.

---

## 4. 설계 원칙 (journal)

두 리뷰의 "safer mechanism"을 채택한다.

1. **id는 lane 생성 시 민팅한다** (첫 프레임 성공 시가 아님). UUID/ULID + 플러그인 소유 monotonic delivery sequence. 모든 모드(draft/block/off).
2. **commit-before-publish.** live 프레임을 쏘기 전에 journal에 `{sessionKey, answerId, sequence, role, text?, state}`를 durable하게 쓴다(초기 state=pending). live 전송 실패해도 리로드가 journal에서 회복.
3. **drain 후 authoritative 확정.** 최종 text/상태는 controller의 turn_snapshot에서 확정(state=committed). identity-less final에서 짜내지 않는다.
4. **history는 journal에서만 서빙.** core transcript 안 읽음. 클라이언트는 우리 id를 받음 → text/위치 추측 원천 소멸.
5. **live == durable == history, 같은 id.** lane.id = live 전송 id = journal answerId = history row id.
6. **못 붙는 final = 새 메시지, degrade 아님 (2026-08-23 정정 — 옛 "degrade" 표현은 폐기).** 현재 draft(lane)에 붙는 final은 그 id를 in-place 마감; 현재 draft에 **안 붙는 final은 새 메시지로 배달**(내장 채널 `deliverNormally`; 애매한 edit 실패는 preview 유지). **위치/ordinal로 소급 귀속은 금지**(그게 #215/#223 자충수). ⚠️ 예전 "확정 못하면 degrade/skip"은 내장 채널 레퍼런스와 배치되는 오판이었다 → [[아닌 것 목록 §0.2]] N10, 결정판 §16.5.
7. **legacy는 명시적 cutover 경계.** journal 도입 이전 대화는 journal에 없다. cutover 이전 구간은 별도 정책(best-effort 또는 표시 없음)으로 다루고, **journal era 안에서는 절대 core row와 섞지 않는다.**

---

## 5. 변경 표면 (partial/progress 우선)

실측(§3.2)에서 partial/progress는 controller가 이미 답변별 {id,text}를 낸다. 그래서 이 스코프는 v1 우려보다 작다.

**IN (partial/progress):**
- **journal store (신규 모듈)** [우리코드 + 계약 store §3.1]: `{sessionKey, answerId, sequence, role, text, ts}` commit/update/read; 저장 매체·보존·write lock.
- **controller 훅 `message-adapter.ts`** [우리코드]: `emitTurnSnapshot`(drain) 시점에 같은 answers를 journal에도 durable commit. (지금은 wire로만 방출 — 저장 경로 추가.) user 메시지는 inbound 수신 시 journal 기록.
- **history `history.ts`** [우리코드]: agent/user 버블을 `getSessionMessages`(core transcript) 대신 journal에서 서빙. pagination cursor = journal sequence.
- **client `nats-client-wrapper.ts`** [우리코드]: history를 journal 기반으로 렌더(순수 view). partial의 live/snapshot id는 이미 서버 id라 live 경로 변경은 최소.
- **plugin 특성화 테스트** + test-inventory 갱신.

**OUT → 후속:**
- off/block 모드 per-answer id 신설(controller/wire/client) — §3.3. ⚠️ **절반 해소(PR #250 / #238)**: controller/wire 쪽(플러그인이 모든 배달 행위에서 id 민팅)은 거기서 처리됐고, **client 쪽은 아직 OUT**이다. 식별자 판정은 §16.5.
- client text/위치 매칭 완전 제거(#104/#227/#228, `adoptedFromLiveId`, tier-2 exact-text) — journal 착지 후.
- `getSessionMessages` 기반 history 제거 — cutover 후.

---

## 6. 열린 결정 / 하드 프라블럼 (적대 리뷰 대상)

두 리뷰가 노출한 것 + journal 특유의 것. 답 정하기 전 구현 없음.

- ✅ [실측 완료] **snapshot ↔ journal 급전.** partial/progress는 drain에서 답변별 {id,text}를 낸다(§3.2) → journal은 그걸 적으면 됨. off/block은 안 냄(§3.3) → 후속. [codex F6 해소]
- ✅ [해소] **id 민팅(off/block).** ~~[후속으로 분리] 거긴 답변 id가 없다. 별도 작업(§3.3).~~ → **PR #250(#238)이 이 항목을 구현한다**: 플러그인이 **모든 배달 행위(delivery act)에서 id를 민팅**하므로 off/block에도 답변 id가 있다. "거긴 답변 id가 없다"는 더 이상 성립하지 않는다. 남은 client 쪽은 §5 OUT 항목 참고. 식별자 판정은 §16.5.
- **commit-before-publish의 크래시 갭.** commit 후 publish 전 크래시 시 pending 기록의 상태 정합성. 재시작 후 pending을 어떻게 확정/폐기?
- **restart-stable id / idempotency.** answerId가 재시작·재시도에도 안정적이어야 중복 안 남(현재 id는 메모리 생성). idempotency 정체성 = answerId 자체로. [codex F/B]
- **저장 매체·보존.** keyed store(maxEntries 바운드) vs json 파일(무한) vs SQLite 직접. history 1000 cap/pagination과의 정합. eviction이 오래된 history를 지우나?
- **순서.** 지연/재시도 interleave 시 durable live-order 키가 필요(timestamp/seq는 append 순서일 뿐). 플러그인 monotonic sequence가 그 키. [codex F9/E]
- **legacy cutover + off-mode 연속성.** 경계를 무엇으로(시각/sequence/플래그)? 이전 구간 UX? **off/block로 설정된 operator는 journal이 비어 history가 회귀** — 전환기엔 그 모드에 `getSessionMessages` fallback을 남긴다(단 partial journal era와 절대 섞지 않음; v1의 merge 부활 금지). 이 fallback이 core-transcript-read를 다시 들이는지 리뷰 확인 필요.
- **성능.** 답변당 journal write 비용, write lock 경합. (v1의 O(n) idempotency scan 문제는 journal에선 사라지지만 자체 비용 확인.) [codex F10]
- **멀티디바이스/재시도 replica.** 서버는 공유 subject로 한 번만 publish(`nats-channel.ts:757`)하고 2번째 기기 등록이 재-write를 안 만든다 → 진짜 위험은 replica/retry identity. [codex H 정정]
- **degrade 정의.** #215 ceiling으로 lane 미확정 시 journal 동작(§4-6)의 정확한 규칙.

---

## 7. 구현 전 프로브 (실측; core-static를 계약으로 착각 금지)

- **P1 (snapshot 내용):** turn_snapshot이 각 모드에서 답변별 {id, 최종 text}를 authoritative하게 담는지 실측. block-only 포함.
- **P2 (id 파이프라인):** lane.id가 draft에서 client까지 실제로 그대로 가는지; block/off에서 id를 실어보낼 수 있는지.
- **P3 (store):** 선택한 매체로 commit→read round-trip; 재시작 후 지속성; eviction/보존 실측.
- **P4 (client):** 서버 id 사용 + `a-N` 폐기 시 기존 hydration 테스트 영향.

durable worktree에서. 스크래치패드 금지(`no-scratchpad-for-real-work`).

---

## 8. 범위 / 비범위

**범위(이번):** partial/progress 모드 — journal store, drain-time commit 훅, journal 기반 history, client 순수-view 렌더 (§5 IN).
**비범위(후속):** off/block 모드 per-answer id 신설 — ⚠️ **절반 해소(PR #250 / #238)**: controller/wire 쪽은 거기서 처리됐고 **client 쪽만 남았다**(§5 OUT · §6 참고); client text/위치 매칭 제거(#104/#227/#228); #215/#223 최종 종결; `getSessionMessages` 기반 history 제거(cutover 후); core 저장 형식 변경 없음.

---

## 9. 검증(테스트) 계획

- journal commit/update/read 단위 특성화; 재시작 지속성; 순서 키.
- history가 journal에서만 서빙(core transcript 미read) 특성화; pagination.
- client가 서버 id로 렌더, `a-N` 미발급; 리로드=live 수렴(같은 id).
- 실측(P1-P4)을 합성 fixture로 가장하지 않는다.

---

## 10. 결정 로그

- 2026-08-22 v1: delivery-mirror-into-core-transcript 설계 작성.
- 2026-08-22 v1 REJECT: claude+codex 독립 적대 리뷰 둘 다 P0 REJECT — 미러↔LLM row 짝맞추기 키 부재(수학적 중복/누락), core 자신도 안 함, oversized 투영 필드 소실, send-then-mirror 크래시 갭/core 의존 회귀. §2.2에 dead-end로 봉인.
- 2026-08-22 v2: 플러그인 소유 journal로 전환(사용자 지시 + 두 리뷰 공통 대안 = Slack/Telegram 모델). **core transcript는 클라이언트용으로 읽지 않는다.**
- 2026-08-22 실측: `emitTurnSnapshot`이 drain에 답변별 {id,text}+remove를 방출함 확인(`message-adapter.ts:1678-1698`); off/block은 draft/snapshot 없음; 기본 모드 "off"이나 데모는 partial(`run.sh:287`). → 스코프를 partial 우선으로 좁혔고 "journal = snapshot 저장하는 얇은 층"으로 잠정 판단.
- 2026-08-22 v2 라운드-2 REJECT (claude+codex 독립, 둘 다): **"얇은 층" 전제가 틀렸다.**
  - **[결정타] turn_snapshot은 완전 기록이 아니라 교정 패치** — final-only 답변·notice·overflow는 `answers`에서 빠지고(테스트로 고정), progress 모드는 answers가 빔. snapshot만 저장하면 리로드 때 답변 소실. → journal은 **실제 배달 지점**에서 채워야 함(§3.2 수정).
  - **문서 내부 모순**: §0("core 절대 안 읽음") vs §5/§8(off/block·legacy엔 getSessionMessages 유지). 모드별 라우팅으로 정리하되 "같은 세션에 두 store 병합" 금지(v1 부활 금지).
  - **commit 타이밍 미정**(drain vs before-publish), **`nextMessageId()` 재시작 불안정**(재시도 중복), **`remove[]`/tombstone 미설계**, **user-msg id seam 부재**(coalescing이 개별 id/text 파기; ingress dedupe가 ACK 후 handler 전 crash면 journal 누락), **저장 매체 어느 것도 요건 미충족**(keyed store=바운드/트랜잭션 없음, json=lost-update), **durable monotonic seq/pagination cursor 미설계**, **controller의 sessionKey가 route-scoped 키가 아님**(멀티테넌트 충돌 위험, `inbound.ts:1018` vs `1037`).
  - 방향(플러그인 소유 delivery outbox → 자기 history 서빙)은 **불변, 두 리뷰 다 지지.** 규모가 "얇은 층"이 아니라 실질 서브시스템임이 확정.
- 2026-08-22: 사용자 결정 **(a) — delivery-outbox 서브시스템을 v3로 제대로 설계** (최소 쪼개기(b)/보류(c) 아님). §11이 v3 착수 지점.

---

## 11. [SUPERSEDED — v3 착수 메모. §11~§14는 역사(archive)] 

> ⛔ **§11~§14는 SUPERSEDED 역사다. 현재 설계는 §15(v5)+§16(Telegram 감사)뿐.** RESUME/현재 상태는 **§15·§16**에서 읽어라. §11~§14는 v3→v4 진화 기록으로만 남긴다(왜 그 경로들이 죽었는지). **여기 있는 "다음 단계/RESUME HERE" 문구를 현재 지시로 읽지 말 것** — 이게 압축 후 회귀 씨앗이었다(→ §0.2 N9).

**(옛 결정, 역사)**: (a) delivery-outbox 서브시스템을 제대로 설계한다. 방향 불변(§0). 구현은 v3 설계가 적대 리뷰(claude+codex) 통과한 뒤.

**v3가 반드시 해결할 8개 급소** (라운드-2 확인, 전부 CONFIRMED):
1. **feed = 실제 wire-send site** (turn_snapshot 아님; snapshot은 교정 패치라 §3.2). 성공적으로 보낸 모든 agent 버블을 그 지점에서 {id,text,order} 기록 + drain의 `remove[]`/authoritative-final을 교정 적용.
2. **전 모드 id 민팅** — off/block/progress엔 per-answer id 없음(`inbound.ts:985,979-985`). send site에서 부여.
3. **restart-stable id** — `nextMessageId()`(`message-adapter.ts:23-31`)는 시각+난수 → 재시도 중복. `(conversation,turn,lane)`에서 결정적 파생 필요.
4. **`remove`/tombstone 원자성** — 개별키 store엔 다중키 트랜잭션 없음. insert+delete 사이 crash에도 중복/누락 없게.
5. **저장 매체** — keyed store(바운드/eviction/트랜잭션 없음)도 json(lost-update)도 미달. 인덱스+트랜잭션+append 순서 되는 store 선정(SDK `sqlite-runtime` 검토).
6. **durable monotonic seq + pagination** — 재시작·멀티기기에도 대화 순서 보존. 현재 wire는 `before:string`만(`channel-contract.ts:29-34`) → cursor 설계 필요.
7. **user-msg id seam** — 큐 coalescing이 개별 id/text 파기(`inbound-queue.ts:145-205`); ingress dedupe가 ACK 후 handler 전 crash면 journal 누락(`ingress-dedupe.ts:516`). 클라 `user_message.id`를 end-to-end 보존.
8. **route-scoped 세션 키** — controller는 pre-route `wsKey`(`inbound.ts:1018`); history는 tenant/account/agent-scoped route 키(`inbound.ts:1037`, `nats-account-runtime.ts:393`) 써야 멀티테넌트 안전.

**추가 정합성 결정**:
- **§0 절대규칙 정밀화**: partial(journal era) 세션은 journal-only. off/block·legacy는 모드별 분기로 기존 history 유지(전환기) — **같은 세션에 두 store 병합 금지**(v1 부활 금지). end-state는 core-read 0.
- **commit 타이밍**: send site 기록(mid-turn 리로드 커버) vs crash-gap 트레이드오프를 명시적으로 택1.
- **cutover 마커**: 빈 대화 / 미지원 모드 / write 실패 / legacy 부재를 구분하는 durable 마커.

**v3 프로세스**: 위 8+3을 해결한 설계 작성 → claude+codex 적대 리뷰(새 리뷰어) → 내가 수렴 → 통과 후 구현(implementer 위임, 라운드별 새 reviewer, 커밋/PR은 승인 후). 실측 필요 시 durable worktree(스크래치패드 금지).

---

## 12. [SUPERSEDED 역사] v3 설계 — delivery-outbox 서브시스템 (append-only event log)

> §11의 8개 급소 + 3개 정합성 결정을 전부 해결한 설계. §0(북극성/절대규칙)·§0.1(두 identity 문제) 불변. 이 절이 적대 리뷰 대상이다.

### 12.0 한 문장 + 핵심 통찰

플러그인이 **자기 소유 SQLite에 append-only event log("delivery journal")를 적고, 클라이언트 history를 오직 그 log의 projection으로만 서빙한다.** 답변마다 우리가 발급한 결정적(restart-stable) id를 붙이고, 실제 wire-send 지점에서 event를 append하며, drain의 `remove[]`/authoritative-final은 별도 seal event로 교정 적용한다.

**핵심 통찰(라운드-2 급소 3·4·6 동시 해소):** journal을 **mutable row 집합이 아니라 append-only event log**로 두면 —
- **gap 4 (remove 원자성):** 모든 쓰기가 단일-행 append거나 하나의 seal-event append → 다중키 트랜잭션 불필요. remove는 파괴가 아니라 event(tombstone). projection이 fold로 반영.
- **gap 6 (순서):** append 순서 = autoincrement `seq` = durable monotonic 대화 순서. pagination cursor = `seq`.
- **gap 3 (idempotency):** event의 primary identity = 결정적 answerId(또는 turnId-seal). `INSERT OR IGNORE` → 재시도/재시작 중복 흡수.

### 12.1 데이터 모델 — event log + projection

**source of truth = 이벤트 테이블(append-only).** 3종 event:

| event | 언제 | 키 필드 |
|---|---|---|
| `user` | 클라 user_message 수신(코얼레싱/ACK 이전) | `msgId`(클라 `user_message.id`), `text` |
| `bubble` | agent 버블을 wire로 성공 배달한 지점 | `answerId`(결정적), `turnId`, `text`, `kind`(streamed/final-only/block/degraded) |
| `seal` | turn drain | `turnId`, `removedIds[]`, `authoritative[]:{answerId,text}` |

**클라이언트가 보는 history = 이벤트를 seq 순서로 fold한 projection:**
- `user`/`bubble` event → 버블. 같은 `answerId`/`msgId` 재등장 = idempotent(무시 또는 최신 text 반영).
- `seal.removedIds` → 해당 answerId 버블 tombstone(뷰에서 제외).
- `seal.authoritative` → 해당 answerId의 text를 최종본으로 확정(streamed lane의 drain-시점 authoritative tail 반영, §3.2).

projection은 (a) 쿼리 시 fold하거나 (b) 물화 뷰 테이블로 유지 — 어느 쪽이든 이벤트 로그가 진실. **삭제(DELETE)는 event log에서 절대 안 함**(보존/eviction은 §12.5에서 turn 단위로만).

### 12.2 저장 매체 — 우리 소유 SQLite (계약 실증 완료)

- **매체:** `node:sqlite`의 `DatabaseSync`(Node v24.18.0에서 플래그 없이 stable — 실측) + SDK 계약 `runSqliteImmediateTransactionSync`(IMMEDIATE 락 트랜잭션, `plugin-sdk/sqlite-runtime.d.ts:5`) — [계약].
- **위치:** `resolveStateDir(...)`(`plugin-sdk/state-paths.d.ts`) 아래 우리 파일 예: `webchannel-journal.db`. WAL pragma 우리가 설정 — [계약].
- **⚠️ core agent DB 안 씀.** `resolveOpenClawAgentSqlitePath`/`ensureOpenClawAgentDatabaseSchema`(같은 모듈)는 **core의 DB**다. 그걸 쓰면 v1 회귀(§2.2). 우리는 **우리 스키마의 우리 파일**만 연다.
- **왜 다른 매체는 미달(라운드-2 확정):** keyed store = `maxEntries` 필수(바운드)·다중키 트랜잭션 없음·범위 쿼리 없음(§3.1); json-store = whole-file replace → lost-update·append당 O(file)(§6). SQLite만 (인덱스 페이지네이션 + 원자 트랜잭션 + autoincrement 순서)를 동시 충족.

**스키마(초안):**
```sql
CREATE TABLE IF NOT EXISTS journal_event (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,   -- gap 6: durable monotonic order
  session    TEXT NOT NULL,                        -- gap 8: route-scoped key
  kind       TEXT NOT NULL,                        -- 'user' | 'bubble' | 'seal'
  turn_id    TEXT,
  ref_id     TEXT,                                 -- answerId(bubble) | msgId(user); gap 3 결정적
  text       TEXT,
  payload    TEXT,                                 -- seal: JSON {removedIds, authoritative}
  state      TEXT,                                 -- bubble: 'pending' | 'committed'
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_journal_session_seq ON journal_event(session, seq);
CREATE UNIQUE INDEX IF NOT EXISTS ux_journal_ref ON journal_event(session, kind, ref_id);
```
`ux_journal_ref` + `INSERT OR IGNORE`/upsert = gap 3 idempotency. `ix_journal_session_seq` = gap 6 pagination(`WHERE session=? AND seq<? ORDER BY seq DESC LIMIT n`).

### 12.3 identity — restart-stable 결정적 answerId (gap 2·3)

- **폐기:** `nextMessageId()`(`message-adapter.ts:23-31`, 시각+난수) → 재시작/재시도 시 새 id → 중복 row. [우리코드, 라운드-2 CONFIRMED]
- **채택:** `answerId = f(session, turnId, ordinal)` — 결정적 파생(예: `sha1(session|turnId|ordinal)` 앞 N자). `ordinal` = 그 turn 안에서의 결정적 순번(lane 생성 순서; degraded final은 그 turn의 degraded 카운터).
  - 재시도/재시작으로 같은 turn을 다시 배달해도 **같은 answerId** → `ux_journal_ref`로 흡수 → 중복 없음.
  - **전 모드(scope 내 partial/progress):** lane 있는 버블은 lane 생성 시, degraded final(§12.11)은 send site에서 발급 → **wire에 나가는 모든 agent 버블이 우리 id를 가진다.**
- **⚠️ 잔여 가정(프로브 P-A):** 이 스킴은 `turnId`가 재시작 후 같은 turn에 대해 **안정적**이라는 데 의존한다. turnId가 core 발급이면 재시도 시 재사용되는지 실측 필요. 불안정하면 turn-scoped가 아니라 content-addressed fallback 필요 — **리뷰 전 실측 프로브로 명시.**

### 12.4 delivery outbox — feed는 실제 send site (gap 1)

turn_snapshot이 아니라(§3.2 REFUTED) **실제로 wire에 성공 배달한 지점**에서 event를 append한다. 단일 choke-point 모듈 `deliveryOutbox`:

```
deliveryOutbox.laneOpen(session, answerId, turnId)        -> bubble(state=pending, text="") append  [commit-before-publish]
deliveryOutbox.bubbleDelivered(session, answerId, text, kind) -> bubble(state=committed, text) upsert
deliveryOutbox.userReceived(session, msgId, text)         -> user event append
deliveryOutbox.turnSealed(session, turnId, removedIds, authoritative) -> seal event append
```

**send site 매핑(partial/progress; `inbound.ts` deliver 클로저 1420-1559):**
- streamed lane 최초 프레임 직전 → `laneOpen`(pending).
- `deliverDraftFinalPayload`(kind:"final") 성공 → `bubbleDelivered(final)`.
- `deliverAuthorizedBlock`(block) 성공 → `bubbleDelivered(block)`.
- **final-only 답변**(스트리밍 안 된 C; snapshot.answers에서 빠지는 그 케이스) → 그 배달 site에서 `bubbleDelivered` → **journal은 잡는다**(snapshot이 못 잡던 라운드-2 결정타 해소).
- fallback `sendText(...,undefined,turnId)`(identity-less final) → §12.11 degrade: 우리 id 발급 후 `bubbleDelivered(degraded)`.
- drain `emitTurnSnapshot`(`message-adapter.ts:1678-1698`) → `turnSealed(removedIds, authoritative)`. **snapshot은 이제 "기록원"이 아니라 "교정원"** — text 진실은 send site, remove/authoritative-tail만 seal이 준다.

partial 스트리밍 프레임(`onPartialReply` 다발)은 **journal에 매 프레임 append 안 함**(churn). pending row의 text는 최종 확정(bubbleDelivered/seal.authoritative) 때 채운다. mid-turn 리로드는 pending(마지막 확정 text 또는 빈) 표시 — §12.10.

### 12.5 seal 원자성 + 보존 (gap 4)

- **원자성:** seal은 **단일 event append**(payload에 removedIds/authoritative 통째). `INSERT OR IGNORE`로 idempotent. projection이 fold 시 반영 → insert+delete 사이 crash 자체가 없음(파괴 연산이 없으니까). 물화 뷰를 쓰면 seal append와 뷰 갱신을 `runSqliteImmediateTransactionSync` 하나로 묶어 원자화 — [계약].
- **보존/eviction:** event log는 무한 성장. keyed store의 랜덤 evict-oldest는 부적합(대화 중간이 뚫림). 정책: **turn(또는 session) 단위 롤링** — 오래된 turn의 event 전체를 함께 제거(대화 순서 보존). 오늘 history 1000-row wall(§6, `history.ts pageBefore`)과 정합되게 상한 설정. 부분 제거 금지.

### 12.6 순서 + pagination cursor (gap 6)

- `seq` autoincrement = 단일 writer(§12.8 가정) 하에 durable monotonic 대화 순서. 재시작해도 이어짐, 멀티기기여도 서버 단일 writer.
- **wire 변경:** 현재 history 요청은 `before:string`만(`channel-contract.ts:29-34`). cursor를 `seq` 인코딩 opaque 토큰으로 확장(클라는 불투명 취급). 페이지: `WHERE session=? AND seq<cursor ORDER BY seq DESC LIMIT n`. 최소 계약 추가(기존 `before`와 병존 or 대체 — 리뷰 결정).

### 12.7 user-message id seam (gap 7)

- **id 보존:** 클라 `user_message.id`를 그대로 `user` event `ref_id`로 → end-to-end 보존.
- **coalescing 관통:** 큐 coalescing(`inbound-queue.ts:145-205`)은 **core LLM-문맥용 최적화**지 클라 뷰 병합이 아니다. 클라가 user_message 2개 보냈으면 journal엔 user event 2개(각자 id). → coalescing 전에 `userReceived`를 부른다.
- **ACK-before-handler crash gap:** ingress dedupe가 ACK 후 handler 전 crash면 journal 누락(`ingress-dedupe.ts:516`). → `userReceived` journal append를 **ACK 이전**(또는 ACK와 동일 durable 단계)에 둔다. commit-before-ack 순서.
- **⚠️ 프로브 P-B:** ACK 지점과 handler 지점 사이에 journal append를 끼울 수 있는지 실코드 확인 필요.

### 12.8 route-scoped 세션 키 (gap 8)

- controller는 pre-route `wsKey`(`inbound.ts:1018`)로 생성되지만 history는 tenant/account/agent-scoped route 키(`inbound.ts:1037`, `nats-account-runtime.ts:393`)를 쓴다. journal이 wsKey로 쓰고 route키로 읽으면 miss/크로스테넌트 충돌.
- **결정:** journal의 `session` 컬럼은 **항상 route-scoped 키**. 첫 agent 배달은 route 해석(~1037) 이후에 일어나므로 그 시점에 route키를 캡처해 outbox에 바인딩. `laneOpen` 호출을 route 해석 이후로 보장.
- **단일 writer 가정:** `seq` monotonic·pagination은 "sessionKey당 단일 writer"에 의존. nats publish가 공유 subject로 1회(`nats-channel.ts:757`, §6 codex-H)라 서버 단일 소유가 유력하나, **수평 확장 시 같은 session을 여러 프로세스가 쓰는지 프로브 P-C로 실측.** 다중 writer면 seq를 DB autoincrement(단일 파일 직렬화)로 유지하되 파일 공유 여부 확인.

### 12.9 history routing + cutover marker (결정 A·C)

- **routing(§0 정밀화):** journal era 세션 = journal-only(core-read 0). 그 외 = 모드별 분기. **같은 세션에 두 store 병합 절대 금지(v1 부활 금지).**
- **cutover marker(4-way 구분, gap: 빈 대화 vs 미지원 모드 vs write 실패 vs legacy):** 세션별 durable marker `journal_meta{session, mode, first_seq, started_at}`를 첫 journal event 때 기록.
  1. marker 있음 → **journal-only** 서빙.
  2. marker 없음 + off/block 모드 → **legacy `getSessionMessages` fallback**(전환기 한정; end-state에서 제거).
  3. marker 없음 + partial 모드 → **빈 대화**(신규; journal이 곧 채움). ≠ 에러.
  4. journal write 실패 → **에러 surface**(빈 대화로 위장 금지).
- **end-state:** off/block per-answer id(후속) + legacy backfill(선택) 후 core-read 0 전면. 그 전까지 fallback은 off/block 세션에만, partial-journal 세션과 절대 안 섞임.

### 12.10 commit timing (결정 B)

- **채택: commit-before-publish(pending at laneOpen) + drain seal.**
- 근거: pending을 wire 전송 전에 적으면 **mid-turn 리로드/전송실패에도 회복**(§4-2). 위험 방향이 안전하다 — pending 적고 wire 실패 시 리로드가 그 버블을 보여줌(클라가 못 본 걸 뒤늦게 봄 = Telegram이 수락한 메시지 보여주는 것과 동형, 안전). 반대(send-then-journal)는 live로 보여주고 리로드 때 소실 = 불안전.
- crash-gap 잔여: pending 후 seal 전 crash → pending 버블이 seal 없이 남음. 리로드는 pending의 마지막 확정 text 표시(라이브로 본 것과 동일). 허용, 명시.

### 12.11 degrade 규칙 — identity-less final (§0.1 두 문제 경계)

- identity-less final/block(#111/#215/#223 ceiling)은 **problem (1) live final-routing** — 어느 core 답변인지 못 정함 → **추측 금지**(어느 기존 lane에 우겨넣지 않음).
- 그러나 **problem (2) durable client id는 플러그인 소유** — degrade가 "durable id 없음"을 뜻하지 않는다. → 그 final에도 **우리 answerId를 새로 발급**해 `bubble(kind=degraded)` 로 journal에 남긴다. 클라는 그걸 한 번 렌더, 리로드도 한 번(같은 id). **degrade = "기존 lane에 귀속 안 함"이지 "기록 안 함"이 아니다.** 이게 §0.1 두 문제를 안 섞는 결정적 적용점.

### 12.12 변경 표면 (파일별, partial/progress 우선)

- **신규 `delivery-journal.ts`(우리코드+계약 SQLite):** DatabaseSync 오픈/스키마/WAL, `runSqliteImmediateTransactionSync` 트랜잭션, event append/upsert, projection fold, pagination, 보존.
- **신규 `delivery-outbox.ts`:** send-site choke-point API(§12.4). deliver 경로가 여길 통해서만 journal에 닿음.
- **`inbound.ts`:** deliver 클로저(1420-1559) send site들에 outbox 호출; route키 캡처(1037 이후); user event를 ACK 이전(§12.7).
- **`message-adapter.ts`:** lane 생성 시 결정적 answerId(§12.3); `emitTurnSnapshot`(1678-1698) drain에서 `turnSealed` 호출(wire 방출은 유지, journal seal 추가).
- **`inbound-queue.ts` / `ingress-dedupe.ts`:** user id seam(§12.7).
- **`history.ts`:** journal projection에서 서빙 + cutover routing(§12.9). `getSessionMessages`는 off/block fallback에만 잔존.
- **`channel-contract.ts` / 클라:** history cursor=seq(§12.6); 클라는 서버 id 렌더(순수 view), `a-N` 자체발급 축소.
- **특성화 테스트** + test-inventory 갱신.

### 12.13 구현 전 필수 프로브 (실측; durable worktree, 스크래치패드 금지)

- **P-A (turnId 재시작 안정성):** 같은 turn 재시도 시 turnId 재사용? §12.3 결정적 id의 전제. 불안정이면 id 파생 재설계.
- **P-B (ACK/journal 순서):** ingress dedupe ACK 지점 이전에 user journal append를 끼울 수 있나(§12.7)?
- **P-C (단일 writer):** sessionKey당 단일 프로세스 writer인가(§12.8 seq/pagination 전제)? 수평확장 배포 형태 확인.
- **P-D (store round-trip):** 우리 SQLite commit→restart→read 지속성, 트랜잭션 원자성, 보존 실측.
- **P-E (final-only 배달 site):** final-only 답변(C)이 실제로 별도 send site를 통과하는지(§12.4 gap-1 해소의 근거) 실코드 확인.

### 12.14 리뷰어 공격 지점(예상 반론, 미리 노출)

1. `turnId` 불안정 시 §12.3 전부 붕괴 → P-A로 방어. 실패 시 대안(content-address) 필요.
2. event-log projection 비용(대화 길어지면 fold 비용) → 물화 뷰 or 스냅샷 체크포인트 필요할 수 있음.
3. off/block fallback이 core-transcript-read를 전환기에 되살림 → §0 위반 아닌지(모드별 분기·session 단위 비혼합으로 방어하나 리뷰 확인).
4. 다중 writer면 seq monotonic 깨짐 → P-C.
5. pending-but-never-sealed 버블이 리로드에 계속 노출(§12.10 crash-gap) → 허용 범위인지.
6. user coalescing 관통이 core 측 turn 구조와 클라 뷰를 어긋나게 함(의도적: SSOT) → 하위 기능(Tool message 등)에서 문제 없는지.

### 12.15 v3 결정 로그 델타

- 2026-08-22 v3: append-only event log + 우리 소유 SQLite(`node:sqlite` DatabaseSync + 계약 `runSqliteImmediateTransactionSync`, STATE_DIR)로 급소 3·4·6 동시 해소. feed=send site, snapshot=교정원, degrade=귀속만 포기 id는 발급, cutover 4-way marker, commit-before-publish+seal. core agent DB 미사용 확정(v1 회귀 회피). 남은 리스크는 프로브 P-A~E로 격리(전제 실측 후 구현). **다음: claude+codex 적대 리뷰(새 리뷰어).**
- 2026-08-22 v3 라운드-3 리뷰 (claude 완료 NEEDS_CHANGES; codex 진행). **핵심 findings 다 소스로 확인** — §13에 실측 결과와 v3.1 방향 정리.

---

## 13. 라운드-3 실측 결과 (core 소스 clone + Explore 추적) — v3.1 방향

> core 소스를 핀 태그(`v2026.7.1-2`)로 `/home/orca/workspace/openclaw`에 clone. 우리 레포는 Explore로 정밀 추적. 아래는 file:line 확인된 사실. [우리코드]/[core-static] 구분.

### 13.1 실측 확정 사실

- **[우리코드] `lane.id`는 write-once, 위치-파생 아님.** `lane.id ??= reservation.id`(`message-adapter.ts:860`), 첫 wire 프레임 성공 후 고정. progress/final/snapshot answers 모두 동일 값(`nats-channel.ts:469,455-461`; snapshot `message-adapter.ts:1688`). → **내 §12.3 "결정적 파생 id"는 불필요. lane.id 자체가 안정 identity.**
- **[우리코드] 재시작은 재전송하지 않는다.** 트랜스포트는 **core NATS pub/sub(JetStream 아님)** — `packages/plugin/src` 어디에도 ack/ackWait/nak/consumer 없음. ACK는 admission 영수증(handler 전 durable 기록, `ingress-dedupe.ts:254,516-518`), outcome store는 durable(`plugin-sdk/persistent-dedupe`). 재시작 replay는 outcome lookup으로 re-ACK만, **재dispatch 안 함**(`ingress-dedupe.ts:425-429`). → **mid-turn crash = 턴 유실, 재시도 없음.** findings ①②(restart-stable 파생 id)가 실측으로 **소멸** — 파생을 버리고 lane.id 사용.
- **[우리코드] 저널 훅은 inbound이 아니라 message-adapter 안에 있어야 한다.** inbound deliver는 boolean만 받는다(`deliverDraftFinalPayload → {sent}`, `inbound.ts:566,1538`; fallback `sendText(...,undefined,...)` `inbound.ts:1549`). lane.id는 `sendLaneFrame` 안에서만 안다(Q3). → **feed point = `sendLaneFrame` 성공 seam + `sendIndependent` seam** (v3의 "inbound send site" 정정).

### 13.2 실측으로 드러난 진짜 하드 프라블럼 2개 (durability 아님 — LIVE core→plugin 동작)

- **[우리코드] Q5 fallback/retry 재스트리밍 = 같은 답변, 새 lane.id.** draft controller는 턴당 1개(`inbound.ts:1019`)지만 fallback run이 assistant-message boundary를 다시 쏘면 `closeAndRotate → newLane(gen+1)`(`message-adapter.ts:1507,1521-1522`)로 **새 id의 새 lane** 생성. 코드 주석: "attempt-local, may repeat inside one user turn after model fallback ... Finals may all repeat one turn-level value"(`inbound.ts:1517-1522`). snapshot `remove[]`는 **independent 버블 id지 lane id 아님**(`message-adapter.ts:913`) → **덧난 fallback lane을 안 지운다.** 저널이 순진하게 기록하면 답변 중복.
- **[우리코드] Q4 K≥2 토폴로지의 final-only 답변은 independent 버블 → lane.id 미포착 + snapshot 누락.** 버퍼드 K≥2 경로에서 final-only C는 `materializedAnswerLanes()`(스트리밍 안 한 lane 제외, `message-adapter.ts:1025-1028`)에 타깃이 없어 `deliverTerminalIndependent → sendIndependent`(877)로 나가고, **그 reservation.id는 lane.id로 저장 안 됨**, answers 필터(1685-1686)에서도 빠짐(문서화된 VERIFY-1 엣지, `inbound.ts:197-199`).

→ 두 문제 다 **feed point를 message-adapter의 실제 send seam(sendLaneFrame + sendIndependent)에 두고, 그 seam에서 wire에 실린 reservation.id를 잡아 기록**하면 포착 자체는 된다. 남는 건 **Q5 중복을 저널이 어떻게 교정하느냐** — 이게 §0.1 problem(1)(live routing) 성격이라 신중해야 함(추측 금지). **미측정: 현재 live client가 fallback 중복을 이미 억제하는가?** (core 소스로 조사 중.)

### 13.3 v3.1 개정 방향 (실측 반영, codex 결과 합쳐 확정 예정)

1. **결정적 파생 id 폐기** → `lane.id`(write-once) = durable answerId. gap 3(restart-stable) DROP(재전송 없음, §13.1). findings ①② 해소.
2. **feed point 이동**: inbound send site → **message-adapter `sendLaneFrame`/`sendIndependent` seam**(id를 아는 유일 지점). §12.4/§12.12 정정.
3. **commit-after-publish**: pending-빈-버블(finding ④) 제거. wire 성공 후 실제 text로 bubble event 기록; mid-turn 리로드는 live 채널 재접속이 커버(재접속 재푸시 실측 필요 — 신규 프로브 P-F). 좁은 crash 창(전송 성공~append)만 명시. decision B 뒤집음.
4. **Q5 fallback 중복 = #114 범위 밖 (경계 확정).** [실측 P-G] `supersededAnswerBubbleIds`는 **오직 `sendIndependent`(913)에서만** 채워짐 = independent 버블 중복(#172/#104)만 remove[]에 든다. `closeAndRotate`(1507)는 fallback 회전 이전 lane을 remove에 **안 넣음** → **live 뷰도 fallback 이전 lane을 안 지운다.** 따라서 fallback 중복은 §0.1 **problem(1) live-routing(core-limited, #215/#223 family)** 성격의 기존 동작이지, #114(**problem(2) durable identity**)가 고칠 대상이 아니다. **규율: 저널은 live가 배달한 버블 + live가 적용한 remove[]를 충실히 미러한다. live가 fallback을 이중 렌더하면(problem-1 버그) 저널도 동일하게 이중 — 저널이 새 supersession을 발명하면 그게 problem-1 추측 회귀다.** #114의 계약 = **"history == live 수렴 뷰(post-remove[]), durable, 안정 id"**. fallback 이중 렌더 수정은 별도 problem-1 이슈로 분리(#215/#223).
5. **Q4 final-only 포착**: `sendIndependent` seam에서 reservation.id로 bubble event 기록(kind=independent-final).
6. **off/block core-read 종료 트리거**(finding ⑤): 과대주장 철회 — #114 end-state = "partial/progress 세션 core-read 0". off/block core-read 0은 후속 id 작업 의존으로 명시(무기한 아님, 의존성 등록).
7. **신규 프로브**: P-F(live 재접속 시 진행 중 턴 재푸시?), P-G(현재 live client의 fallback 중복 억제 규칙 = 저널 교정이 맞춰야 할 대상).

### 13.4 codex 라운드-3 리뷰 (REJECT, 14 findings) — 내 판정

codex도 v3 REJECT. 대부분 내 실측과 일치·확증, 일부는 내가 놓친 급소. 저장 매체는 CONFIRMED(`runSqliteImmediateTransactionSync` = BEGIN IMMEDIATE+savepoint+COMMIT, `openclaw-state-db:358-405`, 공급된 DatabaseSync만 건드림; core-agent DB = `agents/<agent>/agent/openclaw-agent.sqlite`, 미사용 확인).

| # | finding | 판정 | v4 반영 |
|---|---|---|---|
| 1 | **§12.9 mode-branch가 SSOT 분열** (partial→off 전환 시 어느 store도 완전 X; off=기본값) | ACCEPT (결정타) | **전-모드 저널**(§14.1). partial-우선 폐기 |
| 2 | final-only C는 `draft.finalize`가 버퍼링+`true` 반환(전송 X), 실제 전송은 drain `sendLaneFrame` | ACCEPT | feed = **transport egress**(§14.2) |
| 3 | feed가 다수 버블 클래스 누락(preview settle, independent, error fallback, control-lane, core-initiated) | ACCEPT | transport egress 단일 choke(§14.2) |
| 4 | schema가 append-only ∧ idempotent 동시 불가; seal ref_id=null 중복 | ACCEPT | 불변 event 정체성 분리 + seal:`<turnId>`; commit-after로 open/commit 분리 제거(§14.3) |
| 5 | fold가 client 슬롯-refill 순서 연산 미인코딩; tombstone 지배 미보장 | ACCEPT | projection=**client live-reconcile 충실 재현**(§14.4) |
| 6 | user local id(u-1) ≠ wire id → 이중 렌더 or text-match | ACCEPT | **client-민팅 user id 단일 사용**(§14.6) |
| 7 | pending=영구 유령 + live text 미재현 | ACCEPT | **commit-after-publish, pending 없음**(§14.5) |
| 8 | pagination을 raw seq로 = 지워진 버블 부활, events≠messages | ACCEPT | **materialized read model에서 페이지**(§14.4) |
| 9 | 4-way marker가 failed-write/legacy 구분 불가, 첫 event와 비원자 | ACCEPT | epoch marker + 첫 event 동일 txn(§14.7) |
| 10 | turnId=client message.id(정상 클라 안정), 단 id-less/empty-id는 붕괴 | ACCEPT(부분) | 비어있음 검증 + 서버 turn key 할당·echo(§14.6) |
| 11 | append-only도 다중 write txn 필요; dedupe store↔journal은 cross-store(단일 txn 불가) | ACCEPT | 동일 DB txn(event+marker+view); cross-store 창은 client replay+idempotency로(§14.7) |
| 12 | route/ACK 우회 2개(pre-route 에러 apology; control-lane 직접 ACK) | ACCEPT | egress 훅이 control 포함 포착; pre-route 에러는 저널 제외(§14.2/§14.6) |
| 13 | single-writer 미강제; NATS queue group 없어 replica 팬아웃 | ACCEPT(PLAUSIBLE, 배포 의존) | 현재 단일 프로세스 OK; HA는 queue group 필요 — **핵심 잔여 프로브 P-C**(§14.8) |
| 14 | retention("턴 삭제") turn membership 없어 불가; fold O(session); DatabaseSync가 event loop 블록 | ACCEPT | read model 체크포인트 + turn membership; 쓰기 배치·busy-timeout 벤치(§14.4/§14.8) |

**세 경로(claude·codex·core-소스 실측)가 같은 v4로 수렴.** 리뷰어에게 끌린 게 아니라 findings가 전부 북극성(플러그인=전면 SSOT, 클라=순수 view, history==live 수렴 뷰)을 강화. → v4로 개정.

---

## 14. [SUPERSEDED 역사 → §15] v4 설계 — 전-모드 저널 (CQRS: event log + materialized read model)

> 라운드-3(claude+codex REJECT)와 core-소스 실측이 수렴한 아키텍처. §0/§0.1 불변. v3(§12)의 partial-우선·pending·inbound-훅·raw-seq-pagination을 폐기하고, 실측이 강제한 형태로 재설계.

### 14.0 한 문장

플러그인이 **모든 스트리밍 모드에서** wire로 나가는 모든 durable agent 버블과 user 메시지를 **transport egress 단일 지점**에서 우리 소유 SQLite **event log(불변 write model)**에 기록하고, 그 로그를 **client의 live 재조정 알고리즘과 동일하게 fold한 materialized message table(read model)**로 투영해 history를 서빙한다. history == live 수렴 뷰, durable, 안정 id — core transcript는 클라이언트용으로 절대 안 읽는다.

### 14.1 전-모드 저널 (finding 1 — SSOT는 모드 의존일 수 없다)

- v3의 "partial 우선, off/block 후속"은 **틀렸다.** 한 세션이 partial→off로 바뀌면 off 답변은 id-없는 `sendText`(`inbound.ts:1547`)라 저널 밖 → 리로드 유실. off가 **기본값**(`message-adapter.ts:146-149`)이라 더 심각. **모드 의존 SSOT는 SSOT가 아니다.**
- **v4: 모든 모드의 모든 durable 버블을 저널한다.** off/block의 id-없는 send에도 egress에서 **우리 id를 민팅**해 기록(§14.2). → cutover가 단순해지고(legacy만 epoch로 시간 경계), core-read는 전 모드에서 0(§14.7).
- 우선순위(구현 순서)로서 partial이 먼저인 것은 맞다(버그가 거기 산다). 그러나 **설계는 전-모드 완전체**여야 SSOT다. off/block id는 "후속"이 아니라 v4 설계의 일부.

### 14.2 feed = transport egress 단일 choke point (findings 2·3·12)

- v3의 "inbound send site"·"sendLaneFrame/sendIndependent"는 **불완전**: (a) `draft.finalize(C)`는 final-only C를 **버퍼링하고 `true`를 반환**(전송 안 함, `message-adapter.ts:2341-2350`; 실제 전송은 drain), 그래서 inbound `{sent}` 훅은 안 보낸 걸 기록. (b) 다수 버블 클래스가 다른 경로로 나감(preview settle `1627-1656`, independent `877-923`, pre-lane preview `1305-1326`, error fallback `inbound.ts:1598-1604`, control-lane hedge `nats-account-runtime.ts:1172-1177`, core-initiated `channel.ts:279-308`).
- **v4: 유일하게 새지 않는 지점 = transport egress** — agent 버블이 실제로 wire 프레임으로 직렬화되는 곳(`nats-channel.ts`의 `agent_message`/final/independent 프레임 방출). 여기 훅을 걸어:
  - durable 버블 프레임 타입만 기록(`agent_message`·final·independent). **progress 프레임은 live-only → 저널 안 함.**
  - 프레임에 id가 있으면(=lane.id) 그대로, **없으면(off/block sendText, core-initiated) egress에서 민팅**해 실어보내며 동시 기록. → 전-모드 완전 포착 by construction.
- **commit-after-publish**: 프레임이 실제로 wire에 나간 **직후** event append(§14.5). `draft.finalize`의 낙관적 `true`가 아니라 실제 egress가 기준.
- pre-route 에러 apology(route 해석 실패, `inbound.ts:1577-1604`)는 세션 컨텍스트가 없으므로 **저널 제외**(또는 명시적 no-session 마커). control-lane 답변은 egress를 통과하므로 자동 포착(route 키 확보 필요, §14.6).

### 14.3 event log (write model) — 불변·append-only·idempotent (finding 4)

- v3 schema는 `laneOpen→bubbleDelivered`가 같은 `(session,kind,ref_id)`라 append-only(UPSERT는 mutate)와 idempotent(INSERT OR IGNORE는 text 버림)를 **동시 만족 못 함**. commit-after(§14.5)로 open/commit 분리가 사라져 이 충돌 자체가 제거됨 — durable 버블당 **event 1개**.
- **event 종류(각자 불변 정체성):**
  - `bubble` — durable 버블 egress 시. 정체성 = `answerId`(=lane.id 또는 egress-민팅 id). 유니크 `(session, answerId)`.
  - `seal` — 턴 drain 시. 정체성 = `seal:<turnId>`(null 아님). payload = `{removedIds[], authoritative[]:{answerId,text}}`. 유니크 `(session, 'seal', turnId)`.
  - `user` — user 메시지 수신 시. 정체성 = client-민팅 `msgId`(§14.6). 유니크 `(session, 'user', msgId)`.
- 전부 **한 번 append, 절대 mutate 안 함.** idempotency = 유니크 정체성 + `INSERT OR IGNORE`(재-egress·client replay 흡수). seal은 turnId 키라 중복 seal 흡수.

```sql
CREATE TABLE IF NOT EXISTS journal_event (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  session    TEXT NOT NULL,              -- route-scoped key (§14.6)
  kind       TEXT NOT NULL,              -- 'bubble' | 'seal' | 'user'
  identity   TEXT NOT NULL,              -- answerId | turnId | msgId  (불변 정체성)
  turn_id    TEXT,                       -- bubble/user의 소속 턴 (retention/turn membership, finding 14)
  text       TEXT,
  payload    TEXT,                       -- seal: JSON
  kindtag    TEXT,                       -- bubble 세부: streamed|final-only|block|independent|degraded
  created_at INTEGER NOT NULL,
  UNIQUE(session, kind, identity)
);
CREATE INDEX IF NOT EXISTS ix_event_session_seq ON journal_event(session, seq);
CREATE INDEX IF NOT EXISTS ix_event_turn ON journal_event(session, turn_id);
```

### 14.4 read model = client live-reconcile를 충실히 재현한 materialized table (findings 5·8·14)

- **왜 필요:** (finding 5) client는 answer **슬롯만 refill**(다른 버블 위치 보존, `nats-client-wrapper.ts:1466-1484`)하는데 raw event fold는 순서가 어긋남. (finding 8) raw seq pagination은 bubble(seq100)과 그 remove-seal(seq102) 사이 커서에서 **지워진 버블 부활**; `LIMIT n`이 events≠messages. (finding 14) 매 리로드 O(session) fold + `DatabaseSync`는 event loop 블록.
- **v4: event log를 접어 materialized `journal_message` 테이블 유지** — client live 재조정과 **동일 규칙**:
  - `answerId` 키 map 갱신(같은 id 재등장=교체, 이중 렌더 없음).
  - `seal.authoritative` → 해당 answerId text 최종 확정. `seal.removedIds` → **tombstone(도착 순서 무관 지배; 늦게 온 bubble도 tombstone이면 안 살아남음)**.
  - user/기타 버블의 **슬롯 위치 보존**(client와 동일한 순서 연산).
- history 서빙·pagination은 **이 message 테이블에서**(projected message 순서 + tombstone 적용됨). 커서 = message 테이블의 high-water(§14.7 wire cursor). fold 비용은 append 시 1회(증분), 읽기는 인덱스 조회.
- **정합성 계약(테스트로 고정):** 이 projection의 산출물 == client가 같은 event를 live로 받았을 때의 최종 뷰. client 재조정 로직과 **한 소스에서 파생하거나 golden 테스트로 등가 증명**(안 그러면 live≠history 회귀).

### 14.5 commit-after-publish — pending 없음 (finding 7)

- v3의 laneOpen pending은 **영구 유령**(publish 실패/크래시 시 안 보낸 빈 버블 남고 seal이 안 지움) + live text 미재현. SQLite row는 "의도"지 "수락된 wire payload"가 아님 — Telegram 비유 실패.
- **v4: egress 성공 직후에만 event append.** 미완/크래시 버블은 저널에 없음 = 안 보임. 재시작은 턴 유실·재시도 없음(실측 Q6)이므로 정합적·정직(Telegram: 미완=미저장).
- 좁은 창(egress 성공 ~ append 사이 크래시)만 남음: 그 버블은 live로 보였으나 history에 없음. **경계·수용**(재시도 없음이므로 재현 불가; 다음 상호작용까지 그 한 버블만 결손). user 메시지는 client replay가 커버(§14.6).

### 14.6 identity — lane.id(agent) + client-민팅 id(user), 결정적 파생 폐기 (findings 6·10)

- **agent 버블:** `lane.id`(write-once, `message-adapter.ts:860`) 또는 egress-민팅 id(off/block/core-initiated). v3의 `f(session,turnId,ordinal)` **결정적 파생 폐기** — 재시작 재전송이 없어(Q6) 불필요하고, ordinal 파생은 §1 안티패턴.
- **user 버블(finding 6):** client가 local 버블(`u-1`)과 다른 wire id(`abc`)를 쓰면 id-only 뷰가 이중 렌더, text-match는 §0 금지. **해법: client가 user_message.id를 민팅해 local 렌더·wire·history에서 동일하게 사용**(rekey·text-match 불필요). 서버는 그 id를 그대로 `user` event로.
- **turn key(finding 10):** turnId = client message.id, 정상 클라는 재접속·재시도에 재사용(안정, `nats-client.ts:1236-1247`). 단 **id-less/empty-id 입력**은 turnId가 빈 문자열로 충돌. **해법: egress/ingress에서 turn key 비어있음 검증 — 없으면 서버가 turn key를 durable 할당하고 ACK 전에 echo.** seal 키가 이 turn key.
- **route-scoped key(finding 12):** `session` 컬럼 = 항상 route 해석 후 키(`inbound.ts:1037`). egress 훅은 route 해석 이후 실행되므로 캡처 가능(첫 agent egress는 항상 route 이후). pre-route 에러 경로만 예외(§14.2, 저널 제외).

### 14.7 원자성·cutover·전-모드 core-read 0 (findings 9·11)

- **원자성:** event + materialized view 갱신 + (해당 시) marker를 **동일 journal DB의 한 `runSqliteImmediateTransactionSync`**로 커밋(계약). 세 write가 한 DB라 원자적.
- **cross-store 창(finding 11):** ingress outcome store(`PersistentDedupe`)와 journal DB는 별개 DB라 단일 txn 불가. user 메시지 = **journal write를 ACK 이전 pre-ACK seam(`ingress-dedupe.ts:516-524`)에 두고**, 크래시로 ACK 유실 시 **client app-level replay ledger**(`nats-channel-ack`)가 재전송 → idempotent `user` event가 흡수. 즉 cross-store 정합은 단일 txn이 아니라 **client replay + idempotency**로 보장.
- **cutover(finding 9):** (1) 배포 시 **전역 journal-epoch 마커**(epoch 시각/seq) 1회 기록. (2) 세션별 marker는 **첫 event와 동일 txn**. 라우팅: epoch 이후 세션 = 항상 journal-only; epoch 이전 = legacy(시간 경계, 유한·소멸). marker-없음+epoch이후 = 진짜 빈 세션. write 실패 = **wire history-error 응답**(빈 세션 위장 금지; 계약에 error 타입 추가). **전-모드 저널(§14.1)이라 "미지원 모드" 케이스가 사라져 3-way로 단순화.**
- **end-state: 전 모드 core-read 0.** off/block 포함 모두 journal-backed(§14.1). legacy만 epoch 이전으로 한정.

### 14.8 성능·확장 (findings 13·14)

- **쓰기 비용 [실측 P-D' 완료]:** WAL+`synchronous=NORMAL`+`busy_timeout`에서 버블당 IMMEDIATE txn = **평균 0.95ms, p50 0.098ms, p99 4.1ms**(6000 txn). 턴배치 = meanTxn 1.23ms, p50 0.165ms, p99 17.9ms. **전형 쓰기는 sub-ms → event-loop 블록 무해.** max 스파이크(버블당 393ms/턴배치 145ms)는 **WAL auto-checkpoint** 이벤트(드묾). **결정: 버블당 write 채택**(egress 훅과 자연 정합, p99도 더 낮음). checkpoint는 hot-path 밖으로 — 턴 사이 타이머 `PRAGMA wal_checkpoint(PASSIVE)` + `wal_autocheckpoint` 튜닝. 블로커 아님(튜닝 항목).
- **retention/turn membership:** event에 `turn_id` 보유(§14.3)라 "턴 단위 롤링 제거" 가능. read model 체크포인트가 durable truth가 되면 오래된 event 프리픽스 제거 가능(그때 체크포인트를 truth로 명시).
- **single-writer(finding 13) [실측 P-C 완료 — 블로커 아님]:** 인바운드는 queue group 없는 평문 SUB(per-peer subject, `nats-transport.ts:694-695`, `nats-channel.ts:333,753`) → NATS는 팬아웃. **단일 소비자는 core의 gateway 싱글톤 락**(`[core] gateway-lock.ts:226-230,321-322`, config-path별 파일 락/호스트당) + **프로세스당 account-runtime 1개**(`nats-account-runtime.ts:225`)에서 나온다. 배포 모델은 single-gateway-per-account가 지원되는 유일 형태(`[core] fly.toml:17-26` 단일 머신, `docs/concepts/architecture.md:143` "Exactly one Gateway…per host", `docs/install/render.mdx:95` 수평확장은 "외부 상태 직접"). **→ 우리 저널의 single-writer 전제 = core 자신의 로컬-디스크 상태 모델과 동일한 제약**(새 약점 아님; core도 SQLite를 로컬 디스크에). 현 배포에서 seq/pagination 안전. **미래 멀티호스트 HA면** queue group(인바운드 단일 소비) 또는 공유파일+idempotent `ux(answerId)` 필요 — 단 그건 core 자체도 이미 외부상태를 요구하는 조건이므로 #114 밖. 설계는 이를 **배제하지 않게**(id-idempotency로 공유파일 시 행 중복 방지) 남겨둔다.

### 14.9 변경 표면 (v4, 전-모드)

- **신규 `delivery-journal.ts`:** 우리 SQLite(open/schema/WAL/busy_timeout), `runSqliteImmediateTransactionSync` txn, event append(idempotent), materialized projection(client-등가), pagination, retention.
- **transport egress 훅(`nats-channel.ts`):** durable 버블 프레임 egress 시 journal append; id-없는 프레임에 민팅.
- **`inbound.ts`/`nats-account-runtime.ts`:** route 키 캡처; user event를 pre-ACK; turn key 비어있음 검증·서버 할당.
- **`history.ts`:** materialized read model에서 서빙 + epoch/marker 라우팅. core-read는 legacy(epoch 이전)만.
- **client(`nats-client-wrapper.ts`, `nats-client.ts`):** user_message.id 민팅해 local=wire=history 동일 id; history를 서버 id로 렌더(순수 view); `a-N`/text-match 폐기; live-reconcile 로직을 projection과 등가로 유지(공유 or golden).
- **`channel-contract.ts`:** history cursor(read-model high-water), history-error 응답 타입.
- 특성화 테스트 + test-inventory.

### 14.10 프로브(구현 전, durable worktree)

- ✅ **P-C 완료(최중요):** single-writer = "단일 프로세스 배포에서 보장" = **core 자신의 로컬-디스크 상태와 동일 제약**(gateway 싱글톤 락 + 프로세스당 runtime 1). 현 배포 안전, 블로커 아님. HA는 core도 외부상태 요구(#114 밖). (§14.8)
- ✅ **P-D' 완료:** 버블당 IMMEDIATE txn p50 0.098ms/p99 4.1ms(sub-ms, 무해); WAL checkpoint 스파이크만 hot-path 밖으로. 버블당 write 채택. (§14.8)
- **P-H:** off/block egress에서 id 민팅·client가 서버 id 사용 시 기존 hydration/`a-N` 테스트 영향.
- **P-I:** projection이 client live-reconcile와 등가임을 golden으로 증명하는 fixture 셋(슬롯 refill, tombstone 지배, 늦은 seal, fallback 이중 lane).
- (해소됨: P-A turnId=client id 안정, P-B pre-ACK seam 존재 `ingress-dedupe.ts:516-524`, P-E final-only=버퍼→drain egress, P-F/P-G는 §13.3-4로 경계 확정 = fallback은 #114 밖.)

### 14.11 범위·비범위 (v4)

- **범위:** 전-모드 delivery journal(event log + read model), transport egress feed, epoch/marker cutover, client user-id 민팅 + 서버-id 렌더, projection≡live-reconcile. 구현은 partial 먼저 검증 후 off/block egress-id 확장(같은 설계 내 단계).
- **비범위:** fallback 이중 렌더 수정(§13.3-4, problem-1, #215/#223); reasoning/tool-activity durable화(별도); core 저장 형식 변경 없음; HA queue group(P-C 결과에 따라 별도).

---

## 15. v5 설계 — "이벤트 스트림 SSOT + 공유 reducer" (라운드-4 반영)

> 라운드-4: v4 아키텍처는 **양쪽 다 CONFIRMED-sound**(단일 transport-egress choke point, 우리 SQLite, all-mode). REJECT 사유는 전부 **spec 미완**. v5는 뼈대 유지 + 라운드-4 통합 통찰로 spec을 닫는다. §0/§0.1 불변.

### 15.0 통합 통찰 (라운드-4의 결정타 2개가 합쳐짐)

- **codex#1(P0):** `progress`의 **첫 프레임 = 슬롯 클레임 = 순서 결정**. 이걸 버리면 순서 정보가 소실돼(held A가 B보다 먼저 슬롯 잡았다는 사실) history≠live. [CONFIRMED: `message-adapter.ts:1234-1302,1719-1748`, 테스트 M13d `message-adapter.test.ts:3074-3111`]
- **codex#5(P1):** client는 "tombstone dominance"를 **안 한다** — `remove:[X]` 후 늦은 `agent_message{X}`는 X를 **부활**(answers win, order-sensitive). [CONFIRMED: `nats-client-wrapper.ts:1503-1526,2569-2587`]

→ **v5 원칙: 저널은 "클라가 view 계산에 실제로 쓰는 이벤트를, 전송된 순서 그대로" 기록한다. history = 클라 자신의 reducer를 그 스트림에 재생한 결과.** 서버는 순서·tombstone·supersession 규칙을 **발명하지 않는다**(그게 추측 = 회귀). 같은 입력 + 같은 함수 = live==history **by construction**. 이것이 "플러그인=이벤트 스트림의 SSOT, 클라=순수 view"의 가장 순수한 형태.

### 15.1 라운드-4 finding 판정표 (claude NEEDS_CHANGES + codex REJECT, 15개)

| finding | 판정 | v5 반영 |
|---|---|---|
| codex1/claude2 **순서 정보(슬롯 클레임) 소실** | ACCEPT(P0) | **placement event**를 lane 첫 progress(슬롯 클레임)에 기록(§15.3). progress 텍스트 churn은 여전히 미기록 |
| codex5/claude(암묵) **tombstone dominance는 클라 알고리즘 아님** | ACCEPT(P0) | 서버가 dominance 발명 금지. **완전 순서 스트림 + 클라 reducer 재생**(§15.0/§15.4) |
| codex4 **INSERT OR IGNORE가 same-id 개정 폐기** | ACCEPT(P1) | event 정체성 = **per-frame(revision-aware)**, projection이 answerId로 last-write-wins fold(§15.3) |
| codex3/claude1 **epoch marker가 legacy/new/실패 구분 불가, straddle 손상** | **DISSOLVED (사용자 결정: 파괴적 OK)** | cutover/epoch/era 기계장치 **통째 삭제** — 저널이 첫날부터 유일 저장소(§15.6) |
| claude2 **스트리밍했으나 프레임 실패한 lane이 리로드 유실** | ACCEPT(HIGH) | **seal.authoritative = create-or-update(upsert)**; snapshot answers도 정당한 feed(§15.4) |
| codex6/claude3 **egress가 kindtag 파생 불가; route apology 제외** | ACCEPT | egress는 **프레임 타입만 필터**(durable vs progress); answer-여부=**seal 멤버십**; apology도 기록(§15.3) |
| codex6/claude4 **route key가 egress에 안 내려감** | ACCEPT | journal write = **route key를 클로저로 잡은 per-turn 등록 콜백**; stable conversation key 확인 P-J(§15.5) |
| codex2/claude7 **cross-store 복구가 휘발성 client ledger 의존, ACK 경로 누락** | ACCEPT(P0) — **단, 비대칭 폐기(사용자 정정)** | 플러그인이 user 메시지도 **유일 SSOT**. 저널 기록 = **접수의 hard 요건**(best-effort 아님). 클라 낙관 버블은 provisional(`pending/sendState`), 실패 시 `retract`로 제거 = Telegram outbox(§15.7) |
| codex7 **publish=로컬 WS enqueue; journal 실패 의미 미정** | ACCEPT(P1) | journal 실패를 **send 결과와 분리**(reservation 롤백 유발 금지); 양방향 좁은 창 경계·수용(§15.8) |
| codex8/claude(암묵) **user id가 held/deferred/retracted 미포함** | ACCEPT(P1) | client user-id 통일에 **held/deferred/retracted/cancel 생애 규칙** 포함(§15.5-client) |
| codex5/claude5 **golden-test로는 등가 보장 불가** | ACCEPT | **단일 공유 pure reducer만**(golden 대안 삭제). durable-view를 client-local send state와 분리(§15.4) |
| claude6/codex3 **legacy가 0으로 안 수렴** | **DISSOLVED (파괴적 OK)** | legacy 개념 자체가 사라짐 — 파괴적 컷오버라 첫날부터 core-read 0 전면(§15.6) |
| codex9 **read model 순서/커서/compaction spec 미완** | ACCEPT(P2) | journal_message 완전 명세(rank/tombstone/revision/checkpoint/cursor)(§15.4) |
| claude nit **egress append 순서** | ACCEPT | 버블당 동기 append, egress 순서 보존(reorder 방지) |
| claude nit **reasoning/tool durable 갭** | **재-정정(사용자 2026-08-23): tool 메시지는 durable이어야 함** | 현재 `state.reasoning`·`state.toolActivity`가 별개 ephemeral 배열인 건 **북극성 위반 한계지 스펙 아님.** Telegram이 tool/service 메시지 보존하듯 우리도 저널·history에 남긴다. tool/상태 버블 = durable 메시지 → placement/bubble 이벤트로 저널(stable id 필요). 순수 표시기(isTyping, 롤링 초안)만 ephemeral(§15.9) |

### 15.2 저장·feed (v4에서 확정, 유지)

- 우리 소유 SQLite(`node:sqlite` DatabaseSync + 계약 `runSqliteImmediateTransactionSync`, `resolveStateDir`). core-agent DB 미사용(확정).
- feed = `nats-channel.ts`의 **단일 egress**(`sendToPeer`/`sendText`/`finalizeDraft`, `nats-channel.ts:761`) — 모든 durable 프레임이 통과함 CONFIRMED(양쪽 리뷰). progress는 별도 타입(`nats-channel.ts:469`).
- 버블당 IMMEDIATE txn(p50 0.1ms 실측); WAL checkpoint는 hot-path 밖.

### 15.3 이벤트 모델 — 완전 순서 스트림 (findings codex1·4·6)

egress에서 **클라가 view에 쓰는 이벤트만, 전송 순서(seq)대로** 기록. per-frame 불변 정체성. **[스파이크 P-I 정정] 이벤트는 4종** — `remove`는 독립 wire 프레임이 아니라 **`turn_snapshot(seal)` 안의 필드**다(실측: `OutboundWsMessage`에 `remove` 멤버 없음, 클라에 `case "remove"` 없음). 아래는 스파이크에서 실제 클라 소비와 대조해 확정한 모델:

| event | 언제(egress) | 필드 | 클라 소비 |
|---|---|---|---|
| `user` | user 메시지 수신(pre-ACK) | msgId(client-민팅), text | publish echo 항상 append(`nats-client-wrapper.ts:804`) |
| `placement` | lane 첫 progress(슬롯 클레임) | answerId, turnId, seq(=순서) | 첫 progress가 tail에 슬롯 점유(`:2467`), 텍스트 없음 |
| `bubble` | durable 프레임(agent_message/final/independent) egress 성공 | answerId, turnId, text | upsert-by-id(`:2562`), 없으면 append |
| `seal` | drain turn_snapshot | turnId, answers[]:{id,text}, **remove[]** | `applyTurnSnapshot`(`:2557,1486-1557`) |

- **순서**: `seq` autoincrement = 전송 순서. placement가 슬롯 순서를 박제(codex1 해소).
- **정체성**: event row = per-frame 유일(seq or (answerId,frameSeq)). **projection이 answerId로 last-write-wins fold**(codex4 해소; append-only ∧ 개정 양립).
- **egress 필터**: 프레임 **타입**만 본다(durable vs progress). answer 여부는 **seal.answers 멤버십**에서 파생(kindtag-at-egress 불필요, codex6 해소). notice·apology·control-hedge·core-initiated = durable non-answer → 기록(위치 보존 view 요소). route-apology도 포함(codex6 escape 해소).

### 15.4 read model = 공유 reducer 재생 (findings codex5·claude5·claude2·codex9)

- **history = 단일 공유 pure reducer(events in seq order) → view.** 이 reducer는 **클라의 live 재조정 그 자체**(한 모듈, 클라 렌더와 서버 projection이 공유 import). golden 대안 삭제(claude5).
- reducer가 재현할 클라 실제 규칙(발명 금지):
  - placement/bubble = answerId 키 map, 위치는 슬롯 클레임(placement) 순서 보존.
  - `seal.answers` = 해당 answerId text 확정 + **없으면 생성(create-or-update)** — 프레임 실패해 snapshot으로만 온 답변 회복(claude2).
  - `remove` 후 늦은 same-id `bubble` = **부활**(order-sensitive, tombstone 지배 아님; codex5). answers ∩ remove = answers win.
- **durable-view ⊥ client-local state**: reducer는 durable view(answers/notices/순서/텍스트)만. sendState/working/held 등 클라 로컬 UI 상태는 reducer 밖(북극성: 클라가 자기 send state 소유).
- **journal_message(materialized) 완전 명세**(codex9): stable rank(슬롯 순서), tombstone 표현, revision, projector checkpoint(seq high-water), cursor 정의. pagination은 이 테이블에서(projected message 순서). log-prefix 삭제 시 checkpoint를 새 truth로 원자 승격(경계 명시).

### 15.5 seam — route key + user-id 생애 (findings codex6/claude4, codex8)

- **route key(server)**: journal write는 **route 해석(`inbound.ts:1046`) 후 route-scoped 키를 클로저로 잡은 per-turn 콜백**. `NatsChannel`은 route를 모르므로(codex6) 콜백을 turn-handler가 주입. **P-J: agents-bind 등 config 변경이 route 키를 바꿔 대화 orphan 되는가**(기존 history도 동일 제약) — stable conversation 키 존재 확인.
- **user-id(client)**: client가 `user_message.id`를 민팅해 local==wire==history 동일. **held/deferred/retracted/cancel 생애 규칙 명시**(codex8): 초기 렌더에 id 예약, 취소/철회 시 해제 API 추가, coalescing turn anchor와의 관계. 파괴적 컷오버(§15.6)로 legacy가 없으므로 text-match(tier-2/3, `nats-client-wrapper.ts:2081-2113`)는 **이 통일과 함께 즉시 제거** 가능.

### 15.6 파괴적 컷오버 — 저널이 첫날부터 유일 저장소 (사용자 결정 2026-08-23)

**사용자 결정: "이번엔 파괴적 업데이트 OK — 아직 제대로 쓰는 곳 없다."** → v4/v5 초안의 epoch marker·birth-time era·legacy fallback·mode-branch·history-error 마커 **전부 삭제.** cutover 기계장치가 통째로 사라진다.

- **저널이 배포 첫날부터 유일 저장소.** 모든 세션 journal-only, **core-read 0 즉시·전면.** legacy 개념 없음, straddle 없음, epoch 없음, birth-era 없음. (codex3/claude1/claude6가 통째 DISSOLVED.)
- 기존(배포 이전) 대화는 **버려진다**(파괴적). 클라 history 3-tier 텍스트/위치 adoption도 함께 제거 가능(더 이상 legacy core row 없음).
- write 실패: 저널이 유일 저장소이므로 **실패 = 접수 실패**로 다룬다(§15.7의 hard 요건과 동일 규율); 조용한 빈-세션 위장 금지.
- **이점**: §0("core transcript 안 읽음")이 전환기 예외 없이 **문자 그대로 즉시 성립.** 설계가 크게 단순해짐.

### 15.7 user-message durability = 플러그인이 유일 SSOT (사용자 정정 2026-08-23)

**사용자 정정: user 메시지도 플러그인(=Telegram 서버)이 유일 SSOT다.** 클라에서 "입력하는 순간 생성"된 건 provisional일 뿐 SSOT가 아니다 — 정상적으로 서버에 접수·저장돼야 진짜다. 접수 실패하면 클라에서도 그 메시지가 지워진다. → 내 "user text = client-authoritative/best-effort"는 **오답, 폐기.**

- **저널 기록 = 접수(accept)의 hard 요건.** user 메시지는 저널에 durable 기록돼야 접수 확정. 실패 시 접수 실패로 다룬다(best-effort 아님).
- **클라는 이미 이 provisional 모델을 구현**한다(확인): 버블 생성 시 `pending:true, sendState:"queued"`(`nats-client-wrapper.ts:724`), 실패 시 `failed`, `retract(id)`가 트랜스크립트에서 **제거**(`:761`). = Telegram outbox(시계→체크→실패). 클라 재전송 ledger는 "**미확정 메시지 재시도**"라는 정상 역할이지, 서버 갭을 땜빵하는 게 아니다.
- **cross-store(dedupe-db ↔ journal-db) 정합**(codex2): 저널을 접수 권위로 삼아 해소 — 저널 기록 성공이 접수 확정의 일부. dedupe store는 최적화 계층. 순서: 저널-먼저 → 확정. 저널 실패 → 미확정 → 클라 outbox가 재시도(정상). 별도 txn 불필요(단일 권위).
- ACK 직접 경로(control-lane, known-outcome 단락, cancelled debounce; `nats-account-runtime.ts:981-985,1135-1145`, `bounded-inbound-debouncer.ts:371-386`)가 durable 버블을 내면 각각 journal 훅 필요 — egress 콜백이 덮는지 구현 시 확인(대부분 egress 통과).

### 15.8 write 실패·publish 의미 (finding codex7)

- **publish = 로컬 WS enqueue**(NATS flush/수신 미대기, `nats-transport.ts:699-746`). "성공"은 best-effort. 양방향 좁은 창(journal-먼저 or wire-먼저) 존재 — 경계·수용(Telegram 서버도 accept↔수신 창 있음).
- **journal append 실패를 send 결과와 분리**: `sendToPeer` try 안에 넣어 `false` 반환→reservation 롤백→다른 id 재시도(codex7)를 **금지**. journal 실패는 로그+재시도(비파괴), send 성패에 영향 없음.
- egress append는 **동기·egress 순서 보존**(batched/deferred는 reorder 유발, claude nit).

### 15.9 범위·비범위·프로브 (v5) — live==history 절대 불변 (사용자 정정 2026-08-23)

**절대 불변: live == history.** 우리가 스트림을 통제하므로 둘이 다를 이유가 없다. 유일한 예외는 **버그**뿐이고, 버그는 공유 reducer/스트림이라 고치면 **양쪽이 함께** 개선된다. 영구적 "의도적 갭"은 없다.

- **"메시지"는 전부 durable, "표시기"만 ephemeral** (사용자 정정 2026-08-23, 북극성 직결):
  - **durable(저널·history):** user, agent 답변, notice/상태 버블, **tool 메시지**, reasoning(트랜스크립트에 남길 content면). Telegram이 tool/service 메시지를 보존하듯 우리 플러그인(=Telegram 서버)도 보존한다. → placement/bubble 이벤트로 저널(stable id 부여 필요).
  - **ephemeral(저널 안 함, 순수 표시기):** `isTyping` 스피너, finalize 전 "Working…" 롤링 초안 텍스트, sendState UI 장식. live에도 "메시지"가 아니고 history에도 없음 = 불일치 없음.
  - ⚠️ **현재 클라의 `state.reasoning`·`state.toolActivity` 별개 ephemeral 배열**(`nats-client-wrapper.ts:131-132`)은 **북극성 위반 한계지 스펙이 아니다.** tool을 live-only로만 두는 지금 상태가 바로 live≠history 결함 — #114가 이를 durable로 만들어 해소한다. (per-type 결정은 "durable 메시지냐 순수 표시기냐"로 명시적으로 내린다; 절대 "live엔 있는데 history엔 없는" 상태를 남기지 않는다.)
- **fallback 이중 렌더는 갭이 아니다**: 스트림 재생이라 live·history에 **동일하게** 나타난다(둘 다 이중, 불일치 없음). 이중 렌더 제거는 problem-1(#215/#223)의 별도 라우팅 개선 — 고치면 스트림이 바뀌어 **양쪽 동시 개선.**
- **범위:** 전-모드 event-stream 저널 + 공유 reducer read model, egress feed, **파괴적 컷오버(§15.6)**, client user-id 통일(§15.5), **tool/상태 버블 durable화(stable id + 이벤트 모델)**, projection≡live-reducer(공유 모듈). 구현 단계화: partial 답변 먼저 → off/block egress-id → tool/status durable. **설계상 tool durable은 확정(비범위 아님).**
- **비범위(별도 이슈, live==history는 항상 유지):** fallback 이중 렌더 라우팅(problem-1, #215/#223); HA queue group(P-C: core도 외부상태 요구).
- **잔여 프로브:** ✅P-A~P-G, ✅P-C, ✅P-D' 완료.
  - ✅ **P-I CONFIRMED (스파이크, 검증 완료)** — 클라 live 재조정이 순수 공유 reducer `reduceDurableView(events)→DurableView`로 **깨끗이 추출됨.** worktree `spike/114-shared-reducer` commit `ad81bac`: `packages/client/src/durable-view-reducer.ts` + 14 vitest(8 시나리오 + 6 **등가 앵커** = 실제 private `applyTurnSnapshot`을 인스턴스화해 호출·비교, 순환 아님). Advisor가 직접 14/14 통과·소스 확인. 라운드-4 P0(슬롯 클레임 순서 [A,B]≠[B,A], 늦은 remove-후-부활, seal create-or-update #215 회복, final-only C, notice 슬롯 보존) 전부 green. **중심 베팅(history==live by construction) 성립.**
    - **구현 형태(스파이크가 확정):** `render = merge(reduceDurableView(eventLog), clientLocalOverlay)` — 핸들러는 local overlay(working/receipts/sendState/isTyping) 부수효과 유지, **durable `messages` 재조정만 reducer에 위임.** DurableMessage = `{id,role,text,turnId}` (client-local 제외, §0.1).
    - 스파이크 범위 외(구현 시): 실제 클라를 reducer 호출로 refactor; reducer 모듈을 client·plugin 공유 위치로 이동(의존성 없어 기계적); `placement`는 텍스트 미보유(never-final draft 저널링은 비범위).
    - reducer 밖(의도적): `history` 3-tier 텍스트/위치 adoption(`:2063-2258`) = reconnect/late-join 추측 → 서버 스냅샷으로 대체될 workstream C. #114가 스트림 저널링으로 이를 가능케 함.
  - **P-J(route 키 안정성/orphan)**, **P-H(off/block id client 영향)** — 구현 단계에서.

### 15.10 v5 결정 로그

- 2026-08-22 v4 라운드-4: claude NEEDS_CHANGES + codex REJECT. **둘 다 아키텍처 CONFIRMED-sound**(단일 egress choke point). REJECT는 spec 미완(순서 슬롯-클레임 소실 P0, cross-store 복구 P0, epoch 모호성 P0 등 15건).
- 2026-08-22 v5: 통합 통찰("이벤트 스트림 SSOT + 클라 reducer 재생, 서버는 규칙 발명 금지")로 15건 전부 반영. 아키텍처 불변, spec 완성.
- 2026-08-22 **P-I 스파이크 CONFIRMED (중심 베팅 증명)**: 클라 재조정이 순수 공유 reducer로 깨끗이 추출됨(worktree `spike/114-shared-reducer` `ad81bac`, 14/14 통과, 등가 앵커=실제 applyTurnSnapshot 호출). Advisor 직접 검증. 이벤트 모델 4종으로 정정(remove=seal 필드). 구현 형태 `render=merge(reduce(log),overlay)` 확정.
- 2026-08-23 **사용자 원칙-감사 → 내 3개 "범위 선"이 원칙 후퇴였음, 전부 정정(설계가 더 단순+순수해짐)**:
  1. **파괴적 컷오버 OK**(아직 실사용처 없음) → epoch/era/legacy/cutover 기계장치 통째 삭제, core-read 0 첫날부터 전면(§15.6). codex3/claude1/claude6 DISSOLVED.
  2. **live==history는 절대 불변**(§15.9) → 내 "의도적 갭"은 오답. fallback은 스트림 재생이라 양쪽 동일(불일치 없음). **[재-정정] tool 메시지는 durable이어야 한다** — 처음엔 "현재 클라가 ephemeral 배열에 담으니 갭 아님"이라 했는데, 그건 현재 한계를 스펙으로 착각한 회귀. Telegram이 tool/service 메시지 보존하듯 우리도 저널·history에 남긴다("메시지"=durable, "표시기"만 ephemeral). tool을 지금 live-only로 두는 게 바로 결함이고 #114가 durable화로 해소. 설계상 확정(비범위 아님).
  3. **플러그인이 user 메시지도 유일 SSOT**(§15.7) → 내 "best-effort/client-authoritative"는 오답. 저널=접수 hard 요건; 클라 provisional 버블(`pending/sendState/retract`, `:724,761`)=Telegram outbox. 실측 확인.
  → **설계·핵심 실측 완료(더 단순·순수). 다음: 단계별 구현(partial 먼저: 저널 store + egress feed + reducer 배선 + read model; implementer 위임, 라운드별 새 reviewer, 커밋/PR은 명시 승인 후).**

---

## 16. Telegram discrepancy register (원칙-감사 리뷰) + 알려진 구조적 차이

> 리뷰 렌즈: **"플러그인=Telegram 서버, 클라=Telegram 앱"** 원칙에서 벗어나는 지점(Telegram이 하는데 우리가 안/못/다르게 하는 것). 병렬 2인: claude(판정 없이 divergence 나열, 18건) + codex(구조적 라벨 + Telegram 공식문서 대조, 18건). 세 소스트리(플러그인·클라·core 소스)로 검증.

### 16.0 Telegram 모델 교정 (codex가 공식문서로 바로잡음 — 이걸 먼저)

- **id 불변식**: Telegram id는 per-message-box monotonic이고 **한 계정의 모든 기기/세션에 동일**하지만, private/basic 채팅은 상대방과 다를 수 있음(channel/supergroup만 cross-account 동일). → 우리 목표는 **"한 유저의 모든 기기·리로드에 동일 id"**지 우주적 동일이 아님(달성 가능).
- **AI 스트리밍 = 만료되는 `SendMessageAction` live draft**(durable `Message`와 별개, TTL/정식메시지 도착 시 소멸). → **우리 "메시지 vs 표시기" 분리(§15.9)가 바로 Telegram의 AI 모델이다.** 스트리밍 progress/reasoning/tool-진행중 = ephemeral live draft, 최종 답변 = durable message. 검증됨.
- **id 이원화**: 클라 `random_id`(멱등 dedup, 만료 안 함) + 서버 `message_id`(정체성 배정). → v5가 "클라가 durable id 민팅"한 건 divergence. 정답 = **서버가 messageId 배정, 클라는 random_id.**

### 16.1 KNOWN STRUCTURAL DIFFERENCES (영구 — 못 고침) + 철회된 오판

**진짜 영구 차이는 S3 하나뿐.** S1은 철회(내가 레퍼런스를 안 보고 core 한계라고 우긴 오판), S2는 AI 공통이라 강등.

- **~~S1. Core가 메시지 형성을 소유 → final↔lane 영구 불확정.~~ 철회 (2026-08-23).** **오판이었다.** openclaw 내장 채널(Telegram 포함)도 **똑같은 core 위에서 똑같은 식별자-없는 `onAssistantMessageStart()`를 받는다** — core는 Telegram한테도 답변 id를 안 준다. 그런데 내장 채널은 멀쩡하다. 왜냐하면 **식별자를 core가 아니라 "배달 행위"에서 만들기 때문**이다(`[core] src/channels/message/live.ts`, `send.ts`): 채널이 보낼 때 플랫폼이 message_id를 돌려주고(`draft.id()`=previewId, receipt는 배달결과에서 생성), 스트리밍/최종은 **그 id를 in-place 편집**(`editFinal(previewId, edit)`), **"현재 draft 마감" 모델**이지 core ordinal 매칭이 아니다. 현재 draft에 못 붙는 final은 **그냥 새 메시지**(`kind!=="final"||!draft → deliverNormally`). → **우리 #215/#223는 core 한계가 아니라 우리가 `assistantMessageIndex`로 억지 매칭한 자충수.** v6가 "배달 시점 우리(=서버)가 id 배정 + 현재-draft 마감 + 못 붙는 final은 새 메시지"(=내장 채널 그대로)를 채택하면 풀린다. **core-limited 아님.** (§0.1 problem-1도 이 관점에서 재검토 필요 — degrade가 아니라 "새 메시지"가 Telegram 답.)
- **S2. 중단된 생성의 정확한 이어붙이기 불가 — 강등(구조적 아님, AI 공통).** gateway 재시작 시 반쪽 답변을 같은 내용으로 못 잇는다(`[core] main-session-restart-recovery.ts`가 새 비결정 호출로 복구). **단 이건 우리가 Telegram보다 못한 게 아니다**: Telegram 일반 메시지는 완성 바이트 제출이라 무관하지만, **Telegram AI 봇은 정확히 같은 문제**를 겪고 **동일하게 처리**(live draft 만료 + 새 메시지). → 우리도 같은 방식이면 끝. 원칙 위반 아님, AI-스트리밍의 공통 현실.
- **S3. 개인 gateway 가용성 경계 (유일한 진짜 영구 차이) — 단, 아래처럼 좁혀야 정확함 (2026-08-23 codex 2인 정정).**
  - **영구(구조적):** gateway **프로세스가 죽어 있는 동안**에는 권위 트랜잭션(접수 → messageId/conversation-seq 배정 → authoritative history 서빙)을 **실행할 수 없다.** 권위 트랜잭션은 플러그인 코드가 돌아야 일어나는데, 그 코드가 없다. JetStream/relay가 raw intent를 **보관**해줄 순 있어도 **부재중인 플러그인의 트랜잭션을 대신 실행할 순 없다.** 완전 해소=서버/SSOT를 always-on 컴포넌트로 승격=제품 모델이 바뀜. Telegram은 권위가 이미 always-on 클라우드라 자유롭다. (`[plugin] nats-channel.ts:288-335`, `[core] gateway-lock.ts:289`)
  - **영구 아님(후속 fixable):** gateway 재시작을 **가로지르는 무손실 접수**는 구조적 한계가 **아니다.** JetStream/always-on relay spool + SDK의 payload-bearing durable queue(`ChannelIngressQueue`, `channel-outbound` durable-receive)로 raw intent를 보관하면 닫힌다. **내장 Telegram 플러그인 자신이 `extensions/telegram/src/telegram-ingress-spool.ts`로 이걸 한다.** → 후속 이슈 "agent-down ingress 보관(JetStream/relay spool)"로 분리.
  - 즉 S3의 진짜 영구 알맹이는 "**프로세스 부재중 즉시 권위 처리 불가**"뿐. "메시지 유실"은 후속으로 닫을 수 있다.

> **메타 교훈(또 반복한 회귀):** "core가 X를 안 줘서 못 한다"고 단정하기 전에 **같은 core 위의 레퍼런스(내장 Telegram 채널)가 어떻게 하는지 먼저 읽어라.** S1은 안 읽고 우겨서 나온 오판. 레퍼런스는 clone된 `/home/orca/workspace/openclaw`에 있다.

### 16.2 Telegram-faithful 설계 개정 (v6에 반영 권고 — 렌즈가 드러낸 진짜 개선)

v5보다 Telegram에 더 충실하고, **live==history를 유지하면서** 원칙을 강화한다. (양쪽 리뷰 교차 확인.)

1. **서버-배정 messageId + 클라 random_id** (codex3/claude4). 플러그인이 user·agent **양쪽 durable id를 배정**(저널 seq와 함께 트랜잭션 배정, 배달 전), 클라는 멱등용 `random_id`만 보내고 낙관 버블을 **random_id로** 화해(text 아님). → v5 §15.5/§15.7의 "클라가 durable user id 민팅"을 대체. #1(text/position 추측)·#3(3중 id)도 함께 해소.
2. **persist-before-publish** (codex5/claude9). id/seq 배정 + 이벤트 커밋을 **wire push 전에**(user·agent 공통). egress 시점엔 텍스트가 이미 있으니 유령 없음 = Telegram persist-then-deliver. → v5 §15.8의 commit-after 결정 **뒤집음**(안전 방향: history엔 있고 재접속이 따라잡음).
3. **영구 typed delete + revision/seq 지배** (codex9/claude5). order-sensitive 부활 폐기 → `messageDeleted`(sequenced) + revision 지배. 복원은 새 id 또는 명시적 restore. **클라·공유 reducer 양쪽** 변경(둘 다 바꾸니 live==history 유지, codex 라운드-4 "dominance 발명 금지"와 안 충돌).
4. **typed 이벤트 + edited 마커** (codex10/claude6). untyped LWW 대신 `messageCreated`/`messageEdited`/`messageDeleted` + monotonic revision; stale revision 거부; "edited" 표시. → §15.3 4-kind 모델을 typed union으로 확장.
5. **durable content = tagged union**(not {role,text}) (codex12/claude11-12, 사용자 tool-durable 지시). user·answer·notice·**tool·approval**·(content로 남길 reasoning) = stable id + 구조화 내용 + seq. 순수 표시기만 ephemeral. → DurableMessage 타입 확장.
6. **per-conversation 연속 seq + `getDifference(afterSeq)` gap-sync** (codex4/claude7). Telegram pts/qts. ⚠️ **codex 날카로운 지적: DB-global AUTOINCREMENT를 그대로 노출하면 다른 대화 때문에 phantom gap 생김** → **대화별 연속 seq** 필요. 클라가 last-applied seq 보존, gap 감지, 차이만 fetch. 스냅샷을 authoritative high-water로 감쌈.
7. **불변 plugin-소유 conversation id** (codex14, P-J 해소). authenticated account/peer로만 keying, mutable core route/agentId 배제. agents-bind가 대화를 orphan 안 시킴. → §15.5 P-J를 설계로 해결.
8. **커밋된 user 이벤트를 전 기기 broadcast** (codex7/claude18). 서버가 확정 user 메시지(server id·seq)를 계정의 모든 기기로. 멀티디바이스 수렴. origin은 random_id로 화해.
9. **durable 아니면 이름값 못함**: WAL `synchronous=NORMAL`은 정전 시 커밋 롤백 가능(codex5) → "durable" store엔 `FULL` 재고(P-D' 성능 재측정). 클라 outbox는 memory-cap-100 아니라 **IndexedDB 영속**(codex13/claude): 리로드가 미전송 메시지 잃지 않게, 실패 버블은 재시도/취소로 유지.

### 16.3 전체 discrepancy 레지스터 (병합, 라벨·근거)

claude 18 + codex 18을 병합(중복 제거). 라벨: **[S]**=structural-permanent(§16.1), **[#114]**=이번에 닫음(§16.2 반영), **[later]**=후속 이슈.

| Telegram vs 우리 | 라벨 | 근거 |
|---|---|---|
| 서버가 history store 소유 vs 우리는 core transcript 투영 | [#114] | `history.ts:268` getSessionMessages; §15.6 파괴적 컷오버가 해소 |
| 서버-배정 id vs 클라가 text/position로 추측 adopt | [#114] | `nats-client-wrapper.ts:2081-2113`; §16.2-1 |
| 한 계정 전 기기 동일 id vs 같은 메시지 3중 id | [#114] | `:2593,805,808`; §16.2-1 |
| 서버 messageId + 클라 random_id vs 클라가 durable id 민팅 | [#114] | §15.5; `message-adapter.ts:23`; §16.2-1 |
| 영구 delete vs remove-후-부활 | [#114] | `:1503,2569`; §16.2-3 |
| 명시적 edit + "edited" vs 무표시 LWW 덮어쓰기 | [#114] | §15.3-4; `:1524`; §16.2-4 |
| pts/qts gap-sync vs full-refetch, gap 감지 없음 | [#114] | 전송=core NATS, seq 미노출; §16.2-6 |
| 서버 seq 순서 vs stream-replay 순서(슬롯클레임+부활) | [#114] | §15.0; §16.2-3/6 |
| persist-before-deliver vs commit-after-publish(agent) | [#114] | §15.8; §16.2-2 |
| 전송 확인(sent/delivered/read)+persist vs 로컬 WS enqueue만 | [#114 부분/later] | `nats-transport.ts:759`; §16.2-2/9 |
| 모든 message/service 타입 durable vs tool/reasoning/notice/approval ephemeral | [#114] | `:131-132`, `channel-contract.ts:29`; §16.2-5 |
| service message가 typed durable vs 이벤트 모델서 누락(approval 등) | [#114] | `channel-contract.ts:98-100`; §16.2-5 |
| final↔답변 연결 vs 우리가 ordinal 억지매칭 desync | **[#114]** (S1 철회) | 내장 채널은 "현재 draft 마감 + 못 붙으면 새 메시지"; core 한계 아님(§16.1) |
| **원본 inbound 각각을 durable 보존** vs 우리는 journaling 없이 메모리서 `{id:last,text:joined}`로 병합 | **[#114]** (라벨 정정) | ⚠️ codex 정정: "Telegram은 coalesce 안 함"은 **틀림** — 내장 Telegram도 coalesce함(`[core] extensions/telegram/src/bot-handlers.runtime.ts:636`). 차이는 **병합 전 각 원본을 journal에 남기느냐**다. `inbound-queue.ts:145`. 턴-레벨 coalesce는 남겨도 됨 |
| ordinal을 **durable id/final-attribution 키로 안 씀** vs 우리는 `assistantMessageIndex`로 final↔lane 매칭 | [#114] | ⚠️ codex 정정: "Telegram은 ordinal 아예 안 씀"은 **틀림** — 내장 Telegram은 ordinal을 **queued-block 회전/상관 힌트**로 씀(`[core] bot-message-dispatch.ts:1357-1441`), 단 **durable id나 final 정체성으론 절대 안 씀**. 우리 죄는 ordinal을 **정체성**으로 쓴 것. `channel-contract.ts:60-64` |
| 안정 message_id 페이지 vs churn되는 id 커서(`before`) | [#114] | `history.ts:338`; §16.2-6 |
| 한 답변=한 id(변경=edit) vs 재스트림=새 id 이중렌더 | [#114] | 현재-draft in-place 편집 모델 채택 시 해소(§16.1); core 한계 아님 |
| 즉시 멀티디바이스 반영 vs B는 스냅샷까지 지연 | [#114] | `:2070`; §16.2-8 |
| ~~정확한 재전송 vs 중단 생성 재생성(비결정적)~~ | ~~[S2]~~ **삭제** | codex 정정: Telegram AI도 동일(만료+새 메시지) → **구조적 차이 아님**. 이 행은 없는 차이를 광고함. §16.1 S2 |
| 클라우드 권위(기기 독립) vs 개인 gateway(**프로세스 부재중** 권위 처리 불가) | **[S3, 좁힘]** | 무손실 접수는 후속 fixable; 프로세스 부재중 즉시 권위 처리만 영구. §16.1 |
| 앱 업글이 history 안 지움 vs 파괴적 컷오버 | [later, 의도적] | §15.6; 운영상 수용 |
| 불변 chat 정체성 vs conversation key에 mutable agentId 포함 | [#114] | `session-route.ts:198`; §16.2-7 |
| accepted 전 durable vs ACK-후-handler crash gap; NORMAL 롤백 | [#114/later] | `ingress-dedupe.ts:471`; §16.2-9 |
| pending/failed 영속 재시도 vs memory-cap outbox, 실패=제거 | [#114] | `nats-client.ts:1236`; §16.2-9 |
| 1급 edit/delete API vs 메시지 변경 연산 없음 | [later] | `channel-contract.ts:48`; "message mutation API" 후속 |
| 단일 권위 상태 vs 단일-writer 가정(NATS 팬아웃) | [later] | §14.8; P-C; "HA ownership" 후속 |

### 16.4 결론

- **원칙 부합 여부**: v5 방향(플러그인 소유 저널 + 공유 reducer)은 원칙에 맞고, §16.2의 9개 개정을 반영하면 **Telegram 업데이트 프로토콜 수준까지** 충실해진다(typed create/edit/delete + per-conversation seq gap-sync + 서버 id/random_id + persist-before-publish + durable content union).
- **진짜 영구 한계는 S3의 알맹이("gateway 프로세스 부재중 즉시 권위 처리 불가") 하나뿐.** S1(core가 id 안 줌)은 **철회**, S2(중단 생성)는 AI 공통이라 **삭제**, S3은 "무손실 접수(후속 fixable) + 프로세스 부재중 권위 처리(영구)"로 **좁힘**. → **#114엔 core가 강제하는 identity 천장이 없다.** (4-모델 합의: §16.5)

### 16.5 식별자(identifier) 최종 결론 — 4-모델 합의로 매듭 (2026-08-23)

> claude-opus ×2 + codex(gpt-5.6-sol, max) ×2, 전원 소스 근거. codex 2인은 **실제 Telegram 확장**(`[core] extensions/telegram/src/*`)까지 읽음(generic barrel `src/channels/message/`보다 깊음). **이 절이 식별자 문제의 확정 답이다 — 다시 열지 말 것.**

**Q. core가 채널에 답변별 안정 식별자를 주는가? → 아니다 (전원 CONFIRMED).**
- `onAssistantMessageStart()` = 인자 0개(`[core] embedded-agent-subscribe.types.ts:70`). `onPartialReply` payload엔 id 필드 자체가 없음(`[core] get-reply-options.types.ts:58-61`). `BlockReplyContext.assistantMessageIndex`만 유일한 상관자인데 **source-stream ordinal**이지 durable id 아님(subscription마다 0에서 시작, reset마다 +1, 재시도=새 카운터; `[core] embedded-agent-subscribe.ts:169-207,401-450`). deliver-seam은 `{kind}`만 안정 계약(`ChannelDeliveryInfo`엔 assistantMessageIndex 없음; 지금 넘어오는 건 구현 누수). 내부 `deliveryId`/`streamItemId`는 채널에 안 넘김.

**Q. 그럼 내장 Telegram은 어떻게 식별하나? → 배달 행위에서 자기가 만든다 (CONFIRMED).**
- 첫 전송에서 Telegram `sendMessage`가 준 `sent.message_id`를 draft가 저장(`[core] extensions/telegram/src/draft-stream.ts:284-328`), 이후 스트리밍은 **그 id를 in-place edit**(`:329-377`). 최종도 같은 id로 마감. 못 마감하면 draft 비우고 **새 메시지로 sendPayload**(`lane-delivery-text-deliverer.ts:536-603`); 애매한 edit 실패는 **preview 유지**(중복 안 만듦). 멀티메시지는 경계/블록-ordinal 변화 시 lane을 **회전**(`forceNewMessage` → 다음 전송이 새 message_id)(`bot-message-dispatch.ts:1289-1303`).

**Q. 우리가 따라할 수 있나? → 예, 완전히. 오히려 더 쉬움 (전원 CONFIRMED, 구조적 불가 0).**
- Telegram은 **외부 플랫폼**이 send 응답으로 id를 주지만, **우리는 우리가 플랫폼이다** → lane 생성 시 **로컬에서 id를 민팅**(외부 왕복 없음; `message-adapter.ts:23-63,862-907` 이미 그렇게 함). SDK는 **구성 모델**을 그대로 export(`deliverFinalizableLivePreview` + `LivePreviewFinalizerDraft{flush,id,clear}` + `editFinal`/`deliverNormally`; `plugin-sdk/channel-outbound.d.ts`). 단 `message.live` facet엔 **완제품 draft 핸들은 없음**(capability map만) → draft는 **우리가 구성**(이미 함). 클라 wire는 이미 id-기반 upsert(progress/agent_message 같은 id).

**세 가지 정밀 정정 (codex의 깊은 read가 드러냄 — 기존 문서 표현이 과했음):**
1. **"Telegram은 ordinal 아예 안 쓴다"는 틀림.** 내장 Telegram은 `assistantMessageIndex`를 **queued-block 회전/상관 힌트**로 쓴다(`bot-message-dispatch.ts:1357-1441`). 다만 **durable id로도, final 정체성으로도 절대 안 쓴다.** ⇒ 정확한 규칙: **ordinal은 블록-회전 힌트로 OK, 정체성 키로는 금지**(우리 죄는 후자). [[아닌 것 목록 §0.2]] N5는 이 정밀판으로 읽어라.
2. **"못 붙는 final = 새 메시지"는 fallback이지 첫 동작이 아님.** 첫 동작은 항상 **현재 draft 마감 시도**; 안 되면 새 메시지, **애매하면 preview 유지**. N10은 "현재-draft 우선 → 안 되면 새 메시지(또는 유지), 절대 degrade 아님"으로 읽어라.
3. **"#215/#223 = 전부 ordinal 자충수"는 과함.** 두 개가 섞여 있다: (a) **ordinal-desync 자충수**(현재-draft 모델 채택으로 완전 해소) + (b) **identity-less final의 "이 final이 어느 이전 답변인가" 의미론적 귀속** — 이건 core가 Telegram에게도 안 주는 **공유 현실**이다. **그러나 현재-draft 모델은 이 질문을 아예 우회한다**(현재 draft를 마감하거나 새 메시지일 뿐, 과거로 소급 귀속 안 함) — Telegram과 **똑같이**. 즉 (b)는 "우리 vs Telegram 격차"가 **아니라** 스트리밍의 본질이고, 소급 귀속을 **시도할 때만** 문다. 우리가 물린 건 소급 ordinal 귀속을 시도했기 때문.

**결론:** durable 식별자는 **우리가 100% 소유 가능**(구조적 불가 없음). 의미론적 소급-귀속은 Telegram도 못 하지만 현재-draft 모델이 우회하므로 실질 문제 아님. **불가능한 identity 차이 = 없음(빈 목록, 전원 일치).**

### 16.6 이번 라운드가 새로 잡은 fixable 결함 (issue 재편 때 v6 슬라이스로)

전부 [FIXABLE-IN-#114] 또는 후속(구조적 아님). 원칙 정정이 아니라 설계/스펙 보강이라 여기 모아둠:

- **v6를 THE 설계로 승격.** 문서 상태줄(§상단)이 아직 "v5 spec-complete"인데 v6가 v5를 4곳(클라-민팅 id, commit-after, delete 부활, global seq)에서 뒤집음 → v5 준수하면서 북극성 위반 가능. (codex-disc #1)
- **persist-before-publish로 §15.8 확정.** §15.8(commit-after)이 §0/N6·§16.2-2(persist-before)와 정면 모순. v6=persist-before가 이김. buffered-final이 transport 전에 `true` 반환 → 성공 보고됐는데 바이트 미전달 가능(`message-adapter.ts:2341-2350`). (codex-disc #4/#6)
- **ingress 진짜 durability.** 지금 `accepted` 마커만 쓰고 본문은 in-process 큐에만 두고 ACK → crash 시 본문 영구 소실, replay는 마커 보고 재-ACK(`ingress-dedupe.ts:471-519`). SDK가 payload-bearing durable queue 제공. (codex-disc #5)
- **프로토콜 버전 bump + capability negotiation.** v6가 correctness-critical id/seq/delete/sync 프레임 추가하는데 버전 협상 없음 → 옛 클라가 delete/sync를 조용히 무시하고 영구 발산(`protocol.ts`). (codex-disc #15)
- **wire 런타임 검증.** "typed"가 TS 전용, 런타임은 `JSON.parse(...) as T` 무검증 → 악성/깨진 mutation·seq 프레임이 reducer 오염 가능(`nats-channel.ts:875-980`). v6에 런타임 디코딩/불변식. (codex-disc #17)
- **원본 inbound 각각 journaling** (병합 전) — §16.3 행 정정과 동일. (codex-disc #16)
- 후속(구조적 아님): agent-down ingress 보관(JetStream/relay spool; S3 무손실 부분), delivery/read-state 프로토콜, message mutation API, HA journal ownership.
