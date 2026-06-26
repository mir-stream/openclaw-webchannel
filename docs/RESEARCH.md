# WebChannel — 조사 노트 (RESEARCH)

> 📌 **현재 동작 상태의 단일 진실원: [`STATUS.md`](STATUS.md).** 이 문서는 레퍼런스/조사 노트이며 명시된 설치본 시점 기준이다.

> 목적: WebChannel 개발을 이어받는 에이전트가 **재조사 없이** 바로 착수하도록,
> OpenClaw 내부에서 직접 확인한 사실·정확한 경로·API 이름을 정리한 레퍼런스.
> 표기: ✅ = 설치본 소스/문서에서 직접 확인 / ⚠️ = 추론·미확정 / 📄 = 문서 경로.
> 조사 시점 기준 설치본: **OpenClaw `v2026.6.6` (8c802aa)**.
> ⚠️ 절대경로는 **이 환경(macOS, 2026-06-15 확인)** 기준. 다른 머신에선 아래 "경로 유도"로 다시 구할 것.

---

## 0. 환경 / 위치 (이 머신 = macOS / fnm 노드 관리)

- **플랫폼:** macOS (darwin). Node는 **fnm**으로 관리됨(글로벌 npm도 fnm 노드 아래). ✅
- 설치 위치: `/Users/mircorn/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/openclaw/` ✅
  - 바이너리(shim): `~/.local/state/fnm_multishells/<세션>/bin/openclaw` → `../lib/node_modules/openclaw/openclaw.mjs` (symlink) ✅
    - ⚠️ shim 경로의 `<세션>`(예: `23123_...`)은 셸 세션마다 바뀜. 안정 경로는 위 설치 위치를 직접 쓸 것.
  - npm global: `openclaw@2026.6.6` ✅ (`npm root -g` = `.../v24.16.0/installation/lib/node_modules`)
- 문서: `<설치>/docs/` ✅
- 번들 플러그인(채널 포함) 빌드 산출물: `<설치>/dist/extensions/` ✅
- 타입 정의(`.d.ts`)·런타임(`.js`)도 `dist/` 아래. minified지만 타입은 읽을 만함.
- 작업 디렉토리: `/Users/mircorn/workspace/openclaw-webchannel` (npm-workspaces 모노레포; docs는 `docs/` 아래). ✅

> **경로 유도(머신 독립):** 올바른 fnm 노드가 활성일 때 `OC="$(npm root -g)/openclaw"` 로 설치 루트를 구함.
> fnm 노드 버전(`v24.16.0`)이 올라가면 경로의 버전 세그먼트도 바뀌므로, 절대경로 하드코딩보다 이 방식 권장.

---

## 1. 게이트웨이 큰 그림 ✅

- **단일 상시 프로세스 + 단일 멀티플렉스 포트** (기본 `18789`, bind 기본 `loopback`, auth 기본 필수).
- 한 포트에서 동시 서빙: WS 컨트롤/RPC · HTTP API(`/v1/models`,`/v1/chat/completions`,`/v1/responses`,`/v1/embeddings`,`/tools/invoke`) · **플러그인 HTTP 라우트**(예: `/api/v1/admin/rpc`) · Control UI.
- 포트 우선순위: `--port` → `OPENCLAW_GATEWAY_PORT` → `gateway.port` → `18789`.
- 📄 `docs/gateway/index.md`, `docs/gateway/protocol.md`

### WS 프로토콜 핵심 ✅
- 첫 프레임은 반드시 `connect` → 게이트웨이 `hello-ok` 스냅샷 반환. 현재 **protocol v4**.
- 프레임: `{type:"req",id,method,params}` / `{type:"res",id,ok,payload|error}` / `{type:"event",event,payload,seq?}`.
- 역할: `operator`(컨트롤 플레인) / `node`. 스코프: `operator.read|write|approvals|admin|pairing` 등.
- 📄 `docs/gateway/protocol.md`, `docs/gateway/operator-scopes.md`
- ⚠️ **공개 npm 클라이언트 패키지 없음** (문서 명시). 외부 앱은 WS 프로토콜 직접 구현. 📄 `docs/gateway/external-apps.md`

---

## 2. 채널 플러그인 SDK ✅ (이 프로젝트의 본체)

📄 **핵심 가이드: `docs/plugins/sdk-channel-plugins.md`** (단계별, acme-chat 예제 포함)

### 채널 플러그인이 *소유*하는 것
Config(계정/토큰 해석·셋업) · Security(DM 정책/allowlist) · Pairing(DM 승인) ·
Session grammar(대화 id→세션키) · Outbound(전송) · Threading. 
**Core가 소유:** 공유 `message` 툴, 프롬프트 와이어링, 세션키 외형, dispatch.

### 필수 파일 구조 ✅
```
package.json            # "openclaw": { "channel": { "id","label","blurb" }, "extensions":[...], "setupEntry":... }
openclaw.plugin.json    # { "id","kind":"channel","channels":[...], "channelConfigs": { "<id>": { schema, uiHints } } }
index.ts                # defineChannelPluginEntry({ plugin, registerFull(api){...}, registerCliMetadata })
setup-entry.ts          # defineSetupPluginEntry(plugin)
src/channel.ts          # createChatChannelPlugin<ResolvedAccount>({ base, security, pairing, threading, outbound })
```
- `channelConfigs.<id>.schema` → `channels.<id>` 설정 검증(cold-path, 런타임 로드 전).
- `configSchema` → `plugins.entries.<id>.config` 검증(플러그인 자체 설정).

### 핵심 import 경로 ✅
- `openclaw/plugin-sdk/channel-core` — `createChatChannelPlugin`, `createChannelPluginBase`, `defineChannelPluginEntry`, `defineSetupPluginEntry`, `OpenClawConfig`(type)
- `openclaw/plugin-sdk/channel-outbound` — `defineChannelMessageAdapter`, receipt/durable send/live preview helpers
- `openclaw/plugin-sdk/channel-inbound` — inbound route/envelope, mention gating
- `openclaw/plugin-sdk/approval-runtime` — `approvalCapability` 빌더들
- `openclaw/plugin-sdk/interactive-runtime` — `MessagePresentation`, `ReplyPayloadDelivery` 타입
- ⚠️ 외부 앱은 `openclaw/plugin-sdk/*` import 금지. 단 **우리는 플러그인이므로 사용 OK.**

### createChatChannelPlugin 선언 옵션 ✅ (acme-chat 예제 기준)
```ts
createChatChannelPlugin<ResolvedAccount>({
  base: createChannelPluginBase({ id, setup: { resolveAccount, inspectAccount } }),
  security: { dm: { channelKey, resolvePolicy, resolveAllowFrom, defaultPolicy:"allowlist" } },
  pairing:  { text: { idLabel, message, notify({target,code}){...} } },
  threading:{ topLevelReplyToMode: "reply" },
  outbound: {
    attachedResults: { sendText: async (p)=>({ messageId }) },  // 여기서 Map<sessionKey,ws>.send
    base: { sendMedia: async (p)=>{...} },
  },
})
```

---

## 3. WebSocket을 게이트웨이 포트에서 받기 ✅ (가장 중요한 검증)

플러그인 HTTP 라우트로 **별도 서버 없이** WS 업그레이드를 받을 수 있음.

### registerHttpRoute ✅
📄 `docs/plugins/architecture-internals.md` (§Gateway HTTP routes, ~line 620)
```ts
api.registerHttpRoute({
  path: "/webchannel/ws",
  auth: "plugin",            // "gateway" | "plugin" (필수)
  match: "exact",            // "exact"(기본) | "prefix"
  handler: async (req, res) => { ... return true },  // 일반 HTTP
  handleUpgrade: (req, socket, head) => { ... return true },  // ← WS 업그레이드
})
```
- 핸들러 시그니처(d.ts 확인): `(req: IncomingMessage, res: ServerResponse) => Promise<boolean|void>|boolean|void` → **raw Node 객체** → SSE도 가능.
- `auth: "plugin"` 라우트는 operator 런타임 스코프 자동 부여 안 됨(웹훅/자체검증용).

### handleUpgrade 지원 ✅ (소스에서 확인)
- 타입: `PluginHttpRouteRegistration.handleUpgrade?: OpenClawPluginHttpRouteUpgradeHandler` (dist d.ts) ✅
- 디스패치: `dist/plugins-http-*.js`의 `createGatewayPluginUpgradeHandler`가
  업그레이드 요청을 매칭되는 플러그인 라우트의 `handleUpgrade(req,socket,head)`로 넘김 ✅
  (게이트웨이 auth 충족 검사 포함: `matchedPluginRoutesRequireGatewayAuth`).
- **구현 패턴(권장):** `new WebSocketServer({ noServer: true })` → `handleUpgrade`에서 `wss.handleUpgrade(req,socket,head,cb)`.
  자체 `listen()` 안 함 → 추가 포트/프로세스 없음. (`ws` npm 라이브러리 필요)

### 결론
✅ **추가 서버 0개.** 게이트웨이 포트에 WS(또는 SSE) 핸들러를 플러그인이 얹음.

---

## 4. 채널이 *받는* 것 = 전달 투영 (Tool/Thinking 제거됨) ✅

채널 outbound로 가는 건 raw 모델 출력이 아니라 **정제된 전달 메시지**.
- tool-call XML(`<tool_call>...`, `<function_call>...` 등) **제거** ✅ 📄 `docs/web/webchat.md`
- `isReasoning:true`(사고과정) 페이로드 **제외** ✅ 📄 `docs/web/webchat.md`
- 전달 형태: **MessagePresentation** 블록 ✅ 📄 `docs/plugins/message-presentation.md`
  ```ts
  type MessagePresentationBlock =
    | {type:"text";text} | {type:"context";text} | {type:"divider"}
    | {type:"buttons";buttons} | {type:"select";placeholder?;options}
  // + title?, tone?: "neutral"|"info"|"success"|"warning"|"danger"
  ```
- 네이티브 카드/blocks(Slack blocks, Telegram buttons 등)는 채널 렌더러가 소유.

> ⇒ **순수 채널은 tool call을 "데이터"로 못 받음.** 보려면 §6(progress draft, 사람용 텍스트) 또는 §8(onAgentEvent, 구조화).

---

## 5. 스트리밍 ✅

📄 `docs/concepts/streaming.md`
- 두 레이어: **Block streaming**(완성된 블록을 채널 메시지로) / **Preview streaming**(임시 미리보기 메시지 편집).
- ⚠️ **진짜 토큰 단위(token-delta) 스트리밍은 채널에 없음.** 메시지 기반(send+edit).
- 설정: `agents.defaults.blockStreamingDefault`, `channels.<ch>.blockStreaming`, `*.textChunkLimit`, `*.chunkMode`.

---

## 6. Progress Drafts ✅ (순수 채널의 "tool 활동 보여주기")

📄 `docs/concepts/progress-drafts.md`
- `channels.<ch>.streaming.mode: "progress"` → 작업 중 **하나의 갱신 메시지**에 tool 활동 라인:
  ```
  Working…
  🔎 Web Search: for "..."
  🛠️ Bash: run tests
  ✍️ Write: to /tmp/file
  ```
- 에이전트가 "읽고/계획/**tool 호출**/**승인 대기**" 동안 갱신. 끝나면 최종 답으로 전환.
- 디테일: `agents.defaults.toolProgressDetail: "explain"`(기본) | `"raw"`(raw 명령/디테일 붙임).
- ⇒ **순수 채널로도 "에이전트가 무엇을 하는지"는 텍스트로 가시화 가능.** (구조화 X)

---

## 7. 승인 / HITL ✅ (불가능 아님 — 1급 기능)

📄 `docs/tools/exec-approvals.md`, `docs/tools/exec-approvals-advanced.md`

### 두 패밀리
- **Exec approvals**: 호스트 명령(`system.run`/셸). 메서드 `exec.approval.request|get|list|resolve|waitDecision`.
- **Plugin approvals**: 플러그인 정의 툴 승인. 메서드 `plugin.approval.request|list|resolve|waitDecision`.
- 이벤트(WS): `exec.approval.requested|resolved`, `plugin.approval.requested|resolved`.

### 흐름
1. 승인 필요 → 게이트웨이가 `*.requested` 브로드캐스트, **에이전트 런 블록**.
2. `operator.approvals` 스코프 클라이언트가 `*.resolve` 호출(allow/deny). `*.waitDecision`으로 대기 가능(타임아웃 시 null).
3. `*.list`/`*.get`으로 대기중 승인 리플레이.

### 채널 안에서의 승인 (핵심)
- **코어가 same-chat `/approve <id> allow-once|allow-always|deny` 무료 제공** ✅ → 채널이 아무것도 안 해도 텍스트 승인 가능.
- 채널이 **네이티브 버튼**을 원하면 `approvalCapability` 구현(텔레그램 inlineButtons, Matrix 리액션 ✅❌♾️ 등).
- 승인 ID `plugin:` 접두 → plugin approval, 그 외 → exec approval.
- 텔레그램 설정 예: `channels.telegram.execApprovals.{enabled,approvers,target:"dm"|"channel"|"both"}`, `capabilities.inlineButtons`. (WebChannel도 동일 패턴) 📄 `docs/channels/telegram.md`
- `allowFrom`(대화 허용) ≠ `execApprovals.approvers`(승인 권한). 만료 기본 30분.

---

## 8. 에이전트 이벤트 구독 (Phase 2 — 구조화 tool inspector용) ✅

플러그인이 tool call을 **데이터로** 받아 위젯에 forward 가능.
📄 `docs/plugins/sdk-runtime.md` (api.runtime.events), `docs/plugins/sdk-overview.md`
- `api.runtime.events.onAgentEvent((event)=>{...})` ✅
- `api.runtime.events.onSessionTranscriptUpdate((update)=>{...})` ✅
- `api.agent.events.registerAgentEventSubscription(...)` — "sanitized event subscriptions for workflow state and **monitors**" ✅
- WS 이벤트 레벨에선 `session.tool`/`session.operation`/`session.message`(구독: `sessions.messages.subscribe`), 스트리밍 `agent` 이벤트 — `operator.read` 필요. 📄 `docs/gateway/protocol.md`
- ⇒ Phase 2: 플러그인이 자기 세션의 tool 이벤트를 골라 자체 WS로 브라우저에 보냄.

### Thinking/Reasoning ✅
- 기본은 이벤트로도 안 흐름. `reasoningDefault: "off"|"on"|"stream"` 켜야 함(+ owner/authorized/operator-admin 컨텍스트). 📄 `docs/gateway/config-agents.md`
- tool 호출은 `operator.read`만 있으면 옴. thinking은 한 단계 더 명시적으로 켜야 함.

---

## 9. WebSocket vs WebRTC ✅

- **채팅 채널 전송 = WebSocket.** (텍스트/JSON 이벤트/승인 → WS의 용도)
- OpenClaw의 **WebRTC는 Talk(실시간 음성) 전용** ✅ 📄 `docs/nodes/talk.md`
  - `talk.client.create`의 `transport:"webrtc"`, OpenAI Realtime 음성. 브라우저엔 ephemeral 크리덴셜만.
  - 채널/채팅 전송 아님. 음성 대화가 필요해지면 Talk 기능 재사용(직접 구현 X).

---

## 10. 복사·참고할 소스 ✅

### 번들 채널 (이 설치본 `dist/extensions/`)
존재 확인된 채널: `telegram`, `signal`, `sms`, `imessage`, `irc`, `mattermost`, `clickclack`, `microsoft`, `google` ✅
- `dist/extensions/telegram/openclaw.plugin.json` 존재 확인 ✅
- **webhook/HTTP inbound 패턴 참고:** `microsoft`(Teams), `google`(Chat), `mattermost` — WebChannel의 라우트-기반 inbound와 형태 유사. (문서가 Teams/Google Chat을 inbound 예제로 지목)
- ⚠️ 번들은 minified 빌드물. 원본 가독 소스는 GitHub `openclaw/openclaw` 레포의 해당 채널 참고 권장.

### 커뮤니티 (웹 채널 — 전부 외부 SaaS 종속)
- `now4real/openclaw-now4real` (**MIT**) — 웹 위젯 채널. **구조 템플릿 1순위.** inbound 웹훅(`/now4real/webhook`)+outbound API 호출. 단 위젯·배달은 Now4real 클라우드.
- `def-initialize/openclaw-channel-streamchat` (GPL-3.0) — Stream Chat 채널. inbound는 Stream에 봇 WS, outbound는 placeholder→progressive update(스트리밍 패턴 참고, 코드는 GPL이라 패턴만).
- (채널 아님) `MarlBurroW/pinchchat`(대시보드), `Hiich/openclaw-browser-plugin`(크롬확장), `GreenSheep01201/claw-voice-chat`(음성), `actionagentai/openclaw-dashboard`(Next.js operator 대시보드, MIT, `lib/gateway-client.ts`+`use-openclaw-*` 훅+80+ 메서드 타입 — WS 클라이언트 참고용).
- `openclaw/openclaw` **Issue #49178** — 재사용 WS 클라이언트 SDK 부재(공식 인지). WebChannel이 채우는 빈칸이 실재함을 확인.

---

## 11. 다음 에이전트를 위한 요점 / 주의

1. **추가 서버 만들지 말 것.** `registerHttpRoute({handleUpgrade})` + `WebSocketServer({noServer:true})`로 게이트웨이 포트에 얹는다.
2. **MVP는 순수 채널(PLAN.md Phase 1).** tool inspector(onAgentEvent)는 Phase 2. progress draft로 tool 활동은 이미 보임.
3. **outbound.sendText = `Map<sessionKey, ws>`에서 소켓 찾아 send.** 연결 수명주기(끊김/재연결/dedupe/backpressure)가 진짜 작업량. openclaw 특유 난제 아님.
4. **승인은 채널 내장.** `/approve`는 코어 무료. 버튼은 `approvalCapability`.
5. **auth는 결정됨 → 📄 `AUTH.md`.** `auth:"plugin"` + 검증기(ConnectionVerifier) seam + 빌트인 전략(`anonymous`/`hmac-ticket`/`jwt`/`trusted-header`). 게이트웨이 토큰=operator 자격이라 브라우저 직접 노출 금지(불변).
6. **세션키 매핑:** 검증된 `peerId`가 기본 sessionKey(auth가 동시 해결). 잔여는 멀티탭 정책. `messaging.resolveSessionConversation`이 후크.
7. **번들은 minified.** 정확한 시그니처는 `dist/**/*.d.ts` grep 또는 GitHub 원본 참고.
8. 구현으로 **검증됨**: `handleUpgrade` auth 게이팅, 승인 출발-peer 라우팅, 정적 서빙(§13). **여전히 미검증(⚠️)**: outbound **media** 정확 시그니처, live-preview/receipt contract test 요구.

---

## 12. 빠른 grep 치트시트 (재확인용)

```bash
# 이 머신(macOS/fnm): 올바른 fnm 노드가 활성일 때 아래 한 줄로 설치 루트 유도
OC="$(npm root -g)/openclaw"   # = /Users/mircorn/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/openclaw
# 채널 SDK 가이드
sed -n '1,760p' $OC/docs/plugins/sdk-channel-plugins.md
# HTTP 라우트 / 업그레이드
grep -rn 'registerHttpRoute\|handleUpgrade' $OC/docs/plugins/architecture-internals.md
grep -rn 'handleUpgrade' $OC/dist/*.d.ts $OC/dist/plugins-http-*.js
# 승인
sed -n '1,90p' $OC/docs/tools/exec-approvals.md
grep -n 'same-chat\|/approve\|approvalCapability' $OC/docs/tools/exec-approvals-advanced.md
# progress draft
sed -n '1,75p' $OC/docs/concepts/progress-drafts.md
# 에이전트 이벤트(Phase 2)
grep -n 'onAgentEvent\|registerAgentEventSubscription' $OC/docs/plugins/sdk-*.md
# 번들 채널
ls $OC/dist/extensions/ | grep -iE 'telegram|google|microsoft|mattermost'
```

---

## 13. 구현 중 확인된 SDK 사실 ✅ (auth · 승인 라우팅 · 정적 서빙)

> 2026-06-15 구현·E2E로 확인. 미래 에이전트가 재조사 없이 활용할 것.

### 승인을 "출발 peer"로 라우팅 (멀티유저 핵심)
- 승인 요청 페이로드(`ExecApprovalRequestPayload`/`PluginApprovalRequestPayload`)에 **`turnSourceChannel` + `turnSourceTo`** 필드가 있음. `turnSourceTo`는 inbound 턴의 `reply.to`에서 채워짐 = 우리가 기록한 peer `wsKey` = **transport 소켓맵 키와 동일**.
  - d.ts: `dist/plugin-sdk/exec-approvals-*.d.ts`(turnSource* 필드), `plugin-approvals-*.d.ts`. 번들 `signal`/`googlechat` 네이티브 어댑터가 동일 패턴 사용.
- ⇒ `approvalCapability`의 `resolveOriginTarget`/`transport.prepareTarget`에서 `turnSourceChannel==="webchannel"` 필터 후 `turnSourceTo`를 sessionKey로 쓰면 승인 카드가 **요청한 그 브라우저**로 감. (구현: `src/approvals.ts`)
- 답변·progress draft는 이미 inbound가 캡처한 `wsKey`로 per-peer 전달(`src/inbound.ts`).

### 정적 자산 서빙 (게이트웨이 단일 배포)
- `registerHttpRoute`는 **exact `/webchannel/ws` + prefix `/webchannel/`가 같은 auth 레벨에서 공존** 가능("fallthrough chains on same auth level"); exact가 우선이라 WS 업그레이드 영향 없음.
- 게이트웨이 HTTP 레이어가 **라우트 매칭 전에 경로를 정규화/디코드**함 → `..`·인코딩 traversal이 우리 핸들러에 닿기 전에 무력화(루트 대시보드로 떨어짐). 그래도 핸들러 자체 containment 체크 보유(`src/static-assets.ts`).
- 예제 빌드 base를 `/webchannel/`로 두면 자산 URL이 그 prefix로 해석됨(`vite.config.ts` build 시).

### 플러그인 로딩 / 테스트 루프
- 사용자 게이트웨이는 `plugins.load.paths`(레포 경로) + `openclaw.extensions:["./index.ts"]`로 **TS 소스를 직접 로드** → `openclaw gateway restart`가 소스 변경을 즉시 반영(플러그인은 빌드 불필요; 정적 서빙되는 채팅 UI는 `packages/client`에서 `npm run build:demo` 필요). 상세 E2E 절차는 memory `webchannel-live-gateway-e2e`.

### ticket = JWT HS256 (자체 구현, zero-dep)
- `src/ticket.ts`: `node:crypto` HMAC로 `base64url(header).base64url(payload).base64url(sig)`. 검증 시 **alg를 HS256로 명시 핀**(헤더 신뢰 안 함) + timing-safe 비교 + `exp`. 브라우저측 동일 포맷은 Web Crypto(`crypto.subtle`)로 발급(`example/devTicket.ts`), 크로스런타임 호환성 테스트로 보장(`src/devticket-webcrypto.test.ts`).
