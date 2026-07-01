# WebChannel — 기획서

> 📌 **현재 동작 상태의 단일 진실원: [`STATUS.md`](STATUS.md).** 이 문서는 설계·계획 기준이며 명시된 날짜 시점 기준이다.

> OpenClaw용 셀프호스트 웹 채널 플러그인 + 브라우저 클라이언트
> 외부 위젯 SaaS(Now4real, Stream 등) 없이, 게이트웨이 위에서 바로 도는 웹 채팅 채널.

> ⚠️ **용어 주의(2026-06-15):** 이 문서의 초기 기획은 브라우저 UI를 "React 위젯"으로 상정했다. 실제로는 그 연결/프로토콜 로직을 **무프레임워크 `openclaw-webchannel-client`(`packages/client`, zero-dep)** 로 추출했고, **React `openclaw-webchannel-widget`는 삭제**했다. 아래에서 "위젯"은 대부분 *브라우저 클라이언트*를 가리키는 역사적 표현으로 읽으면 된다. 현재 파일 구조는 §8 참조.

---

## 1. 개요 (Overview)

**WebChannel**은 OpenClaw에 React 기반 웹 채팅 위젯을 1급 **Channel**로 붙이는 프로젝트다.
슬랙·텔레그램과 동등한 채널로 등록되어 같은 에이전트·세션·라우팅·승인 체계를 그대로 쓰되,
프론트엔드(React 위젯)와 브라우저 전송(WebSocket)을 직접 소유한다.

- **한 줄 정의:** "OpenClaw 게이트웨이 포트에 WebSocket으로 붙는, 셀프호스트 웹 채팅 채널."
- **배포 단위:** OpenClaw 게이트웨이 하나. (별도 백엔드 프로세스/서버 없음)
- **이름 근거:** React 위젯이라 스코프가 명확해 "channel"이라는 일반 단어로 인한 혼동 우려 없음.

---

## 2. 배경 / 문제 (Background)

OpenClaw에는 슬랙·텔레그램·디스코드·매트릭스 등 다양한 채널이 있지만, **셀프호스트 웹 채팅 채널이 없다.**

기존 커뮤니티 웹 채널은 전부 **외부 위젯 SaaS에 종속**된다:

| 프로젝트 | 종속 | 한계 |
|---|---|---|
| `openclaw-now4real` | Now4real 클라우드 | 위젯·메시지 배달을 외부가 처리 |
| `openclaw-channel-streamchat` | getstream.io | Stream 계정·인프라 필요 |
| `pinchchat` 등 | (채널 아님) | 세션 모니터링용 대시보드 |

이들은 "브라우저에 답을 밀어주는 전송"과 "프론트 위젯"을 외부 서비스에 떠넘긴다.
**WebChannel은 그 두 가지를 직접 구현**해 외부 SaaS 0개, 완전 셀프호스트를 달성한다.

---

## 3. 목표 / 비목표

### 목표 (Goals)
- OpenClaw에 `kind: "channel"` 플러그인으로 등록되는 1급 웹 채널.
- 게이트웨이 포트에서 **WebSocket** 업그레이드를 직접 수락 (추가 서버 없음).
- React 위젯에서: 메시지 송수신, 진행상황(progress draft) 표시, **HITL 승인 버튼**.
- 채널 표준 기능 계승: 세션/라우팅, allowlist, pairing, 멀티계정, 운영 통합.

### 비목표 (Non-goals) — 적어도 Phase 1에서는
- ❌ 구조화 tool-call inspector (전체 인자/결과를 데이터로 받아 리치 카드 렌더) → Phase 2.
- ❌ 실시간 음성 대화(WebRTC/Talk) → 별도 트랙, OpenClaw Talk 기능 재사용 영역.
- ❌ 토큰 단위(token-delta) 스트리밍 → OpenClaw 채널은 블록/프리뷰 기반이라 비대상.
- ❌ operator 대시보드 / 컨트롤 플레인 UI (Control UI가 이미 담당).

---

## 4. 아키텍처 (Architecture)

```
┌──────────────────────────────────────────────────────────────┐
│  OpenClaw 게이트웨이 프로세스 (단일 포트, 기본 :18789)          │
│                                                                │
│   ┌──────────────────────────────────────────────────────┐   │
│   │  WebChannel 플러그인  (kind: "channel")              │   │
│   │                                                        │   │
│   │   registerHttpRoute({ path:"/webchannel/ws",          │   │
│   │                       handleUpgrade })   ◄── WS 수락    │   │
│   │   Map<sessionKey, ws>                     연결 추적      │   │
│   │   createChatChannelPlugin({ security, pairing,         │   │
│   │                             threading, outbound })      │   │
│   │   approvalCapability                      HITL          │   │
│   └───────────────┬───────────────────▲────────────────────┘   │
│                   │ inbound dispatch   │ outbound.sendText      │
│                   ▼                    │                        │
│            OpenClaw 에이전트 런타임 (코어: tool 실행, 세션, 라우팅) │
└───────────────────────────────────────┼────────────────────────┘
                    ▲ WebSocket          │
                    │ (게이트웨이 포트)   │
            ┌───────┴────────────────────┴───────┐
            │  React 위젯 (브라우저)              │
            │  · 메시지 입력/렌더                 │
            │  · progress draft(tool 활동) 표시   │
            │  · [Allow][Deny] 승인 버튼          │
            └────────────────────────────────────┘
```

### 두 조각
1. **WebChannel 플러그인** — 게이트웨이 *안에서* 로드되는 모듈. 별도 실행물 아님.
2. **React 위젯** — 브라우저 프론트엔드. (정적 자산; 개발 중 Vite, 배포 시 정적 호스팅 또는 플러그인 라우트로 서빙)

### 전송 = WebSocket (WebRTC 아님)
- 나르는 것: 텍스트 메시지 + JSON 이벤트 + 승인 왕복 → WebSocket의 정확한 용도.
- 게이트웨이가 이미 WS로 말함. 플러그인 라우트가 `handleUpgrade(req, socket, head)`로 그 포트의 업그레이드를 받음.
- `new WebSocketServer({ noServer: true })` 사용 → **자체 포트 listen 안 함.** 게이트웨이가 넘긴 소켓만 처리.
- WebRTC는 실시간 음성 전용 미디어 경로(OpenClaw Talk). 채팅 채널 전송 아님.

---

## 5. 데이터 흐름 (Data Flow)

### Inbound (브라우저 → 에이전트)
1. React 위젯이 WS로 사용자 메시지 전송.
2. 플러그인이 sessionKey 해석(`messaging.resolveSessionConversation`) 후 채널 inbound로 dispatch.
3. allowlist/pairing 정책 통과 시 에이전트 런 시작.

### Outbound (에이전트 → 브라우저)
1. 코어가 채널의 `outbound.sendText`(및 media) 호출.
2. 플러그인이 `Map<sessionKey, ws>`에서 해당 소켓을 찾아 `ws.send(...)`.
3. 위젯이 렌더. 답은 항상 지시한 그 위젯으로 돌아감(deterministic routing).

### 진행상황 (Progress Draft) — 순수 채널 기본 기능
- `channels.webchannel.streaming.mode: "progress"` 설정 시,
  에이전트가 일하는 동안 **하나의 갱신 메시지**에 tool 활동 라인 표시:
  ```
  Working…
  🔎 Web Search: for "..."
  🛠️ Bash: run tests
  ✍️ Write: to /tmp/file
  ```
- `toolProgressDetail: "raw"`로 raw 명령/디테일까지 노출 가능.
- 끝나면 draft가 최종 답으로 전환.

### 승인 (HITL)
- tool/exec 승인 필요 시 에이전트 런이 블록되고, 코어가 승인 프롬프트를 **이 채널 outbound로** 전달.
- 코어 무료 제공: same-chat `/approve <id> allow-once|allow-always|deny`.
- `approvalCapability`로 위젯에 네이티브 **[Allow][Deny] 버튼** 제공.
- 승인 ID `plugin:` 접두 → plugin approval, 그 외 → exec approval.

---

## 6. UI가 보여주는 것 (Phase 1, 순수 채널)

| 표시 항목 | 출처 | 비고 |
|---|---|---|
| 최종 답변 (텍스트 + 카드/버튼/셀렉트/구분선) | `MessagePresentation` | 정제된 본문 |
| 진행중 tool 활동 라인 | progress draft | "에이전트가 뭘 하는지" 가시화(텍스트) |
| 블록/프리뷰 스트리밍 | block/preview streaming | 점진 표시(토큰 단위 아님) |
| 승인 프롬프트 + 버튼 | approvalCapability / `/approve` | HITL 완전 지원 |
| 미디어(이미지/파일) | outbound media | |

> **순수 채널 한계:** tool 정보는 *미리 포맷된 사람용 문자열*. 전체 JSON 인자/결과를 *데이터로* 받아
> 나만의 리치 tool 카드를 그리는 "inspector"는 Phase 2(`onAgentEvent`)에서.

---

## 7. 기능 범위 / 단계 (Scope & Phases)

> 상태 표기: ✅ 완료 / 🟡 부분 / ⬜ 미착수. (2026-06-15 기준)

### Phase 0 — 최소 동작 (Walking skeleton) ✅
- ✅ 플러그인 등록 + `registerHttpRoute`/`handleUpgrade`로 WS 수락, 연결맵, 텍스트 1왕복, React 위젯.

### Phase 1 — 완전한 순수 채널 (MVP) 🟡
- ✅ `streaming.mode: "progress"` tool 활동 라인.
- ✅ `approvalCapability` 승인 버튼(HITL) — 출발 peer로 라우팅(turnSourceTo).
- 🟡 DM allowlist(✅) — **pairing(승인 코드)은 미구현**. 신규 사용자 승인은 auth(ticket)로 대체 방향.
- ✅ 재연결/연결맵 수명주기, **멀티세션(per-peer, auth로 해결)**. ⬜ **미디어 송수신** 미구현.
- ✅ 설정 스키마(`channels.webchannel.*`, auth 포함). ⬜ `openclaw channels status` 통합 미확인.

### Auth (원래 BACKLOG → 구현됨) ✅  📄 `AUTH.md`
- ✅ `ConnectionVerifier` seam + 빌트인 `anonymous`/`hmac-ticket`/`jwt` + 안전 기본값 + zero-dep ticket 발급/검증.
- ✅ 멀티유저 outbound/approval per-peer 라우팅. ✅ 위젯 `getTicket` + 재연결 재발급.
- ✅ **hmac-ticket + jwt E2E 라이브 검증**(페이지 서빙 + ticket 연결 + 에이전트 응답 + 미·오 ticket 거절).
- ⬜ 잔여: `trusted-header` 전략, 커스텀 함수 주입, 세션 revocation, 멀티탭 정책.

### Phase 2 — tool inspector 확장 (선택) ⬜
- `api.runtime.events.onAgentEvent` 구독 → tool 이벤트 WS forward, 구조화 tool 카드, (옵션) thinking.

### Phase 3 — 다듬기 🟡
- ✅ **typing indicator (native "Bot is typing…")** — 서버는 턴 시작 시 `{type:"typing"}` 프레임을 한 번 푸시, 클라이언트는 `WebChannelState.isTyping`을 true로 플립; 첫 `progress` / `agent_message` (또는 `approval_*`) 도착 시 자동 settle (US1, US2). 기본 ON, 끄려면 `channels.webchannel.capabilities.typing = "off"` (US2 / AC4). 텔레그램·디스코드 패리티: best-effort, no ack/retry, no stop frame. wire envelope: `InboundWsMessage` 불변, `OutboundWsMessage`에 `{type:"typing"}` 케이스 한 개만 추가 (US3 / AC1).
- ✅ **history pagination (최근 N개 스냅샷 + 페이지네이션)** — 서버는 첫 pong 직후 `{type:"history", messages:[{id,role,text,ts}]}` 스냅샷을 1회 푸시; 클라이언트는 `state.messages` 앞에 prepend + id 중복 가드 (US1, US2). 사용자가 위로 스크롤하면 클라이언트가 `{type:"load_history", before?, limit?}` 발송 → 서버는 같은 포맷으로 회신. 기본 N=50, 페이지=50, `channels.webchannel.history.{enabled,limit,pageSize}` config로 조정 (US3). wire envelope: `InboundWsMessage`에 `load_history` 케이스 추가, `OutboundWsMessage`에 `history` 케이스 추가 — 모든 기존 케이스 회귀 0, history drop-only 그룹(`progress`/`typing`과 동일) — 백프레셔 드롭 시 소켓 유지 (US4 / AC1-AC7).
- ⬜ 인터랙티브 버튼 액션, 테마.

---

## 8. 구성요소 / 파일 구조 (현재)

**npm workspaces 모노레포** — 루트는 워크스페이스 매니저, 두 패키지는 `packages/` 아래 대칭(서버 플러그인 / 무프레임워크 브라우저 클라이언트). 📄 분리 이유·배포는 `PACKAGING.md`.
(과거의 React `openclaw-webchannel-widget`는 2026-06-15 삭제 — `openclaw-webchannel-client`가 대체.)

```
openclaw-webchannel/              # 레포 루트 = 워크스페이스 매니저(코드 없음)
├── package.json                   # { "workspaces": ["packages/*"], scripts: test/typecheck/build }
├── package-lock.json              # 단일 통합 lock
├── smoke/                         # 라이브 게이트웨이 대상 수동 스모크(ws/progress/approval/reconnect/e2e/selfclose)
├── docs/                          # STATUS(진실원)·AUTH·PACKAGING·PLAN·RESEARCH·GAP_ANALYSIS·TRUST_AND_ONBOARDING
└── packages/
    ├── plugin/                    # 서버 패키지(openclaw-webchannel 후보; 현 name "openclaw-webchannel", Node)
    │   ├── package.json           # openclaw.{channel,extensions,setupEntry} = "이게 플러그인이다" 표식
    │   ├── openclaw.plugin.json   # 매니페스트 (channelConfigs: auth/allowFrom/streaming/…)
    │   ├── index.ts               # registerFull: WS 라우트(/webchannel/ws) + 검증기 주입
    │   ├── setup-entry.ts
    │   └── src/                   # auth, ticket, transport, inbound, approvals, message-adapter, channel + *.test.ts
    └── client/                    # 브라우저 패키지(openclaw-webchannel-client, 무프레임워크·zero-dep)
        ├── package.json           # exports→dist, build(tsc 라이브러리) / test(vitest)
        ├── tsconfig.build.json    # 라이브러리 .d.ts emit(→dist)
        └── src/                   # index.ts(배럴), client.ts(WebChannelClient), types.ts, client.test.ts
```

> **게이트웨이 로딩:** `plugins.load.paths`는 이제 `…/openclaw-webchannel/packages/plugin`(레포 루트가 아니라 플러그인 패키지)을 가리킨다. `openclaw.extensions`는 그 패키지 기준 진입점. SDK(`openclaw/plugin-sdk`)는 전역 설치본을 가리키는 `node_modules/openclaw` 심링크로 해석(워크스페이스 install이 prune하므로 재생성 필요).
>
> **(superseded — 진입점은 이제 `./index-nats.ts`(NATS E2E)가 production 기본값이고, `./index.ts`(Gateway-WS, hmac-ticket)는 legacy dev-only. 아래 index.ts/hmac 언급은 역사적 스냅샷; 현행 상태는 `STATUS.md` 참조.)**

### 핵심 SDK 표면
- `openclaw/plugin-sdk/channel-core` — `createChatChannelPlugin`, `defineChannelPluginEntry`
- `openclaw/plugin-sdk/channel-outbound` — outbound 어댑터/receipt
- `openclaw/plugin-sdk/approval-runtime` — `approvalCapability` 헬퍼
- `api.registerHttpRoute({ handleUpgrade })` — `/webchannel/ws` WS 수락
- `api.runtime.channel.routing.resolveAgentRoute(...)` — 채널 스코프 세션키(실제 사용; 구 `resolveSessionConversation` 아님)

---

## 9. 설정 (Config) — 예시

```json5
{
  channels: {
    webchannel: {
      allowFrom: ["user-123"],        // DM allowlist
      dmSecurity: "allowlist",        // DM 정책
      streaming: {
        mode: "progress",             // tool 활동 라인 표시
        preview: { toolProgress: true },
      },
      execApprovals: {
        enabled: true,
        approvers: ["user-123"],      // 승인 권한 (대화 허용 ≠ 승인권)
        target: "channel",            // 지시한 위젯으로 승인 프롬프트
      },
    },
  },
  agents: {
    defaults: {
      toolProgressDetail: "explain",  // "raw"면 raw 명령까지
      // reasoningDefault: "off",     // Phase 2에서 "on"/"stream"
    },
  },
}
```

---

## 10. 보안 (Security)

> 📄 **인증·신원 모델 상세는 `AUTH.md`** (결정됨). 아래는 요약.

- **라우트 인증:** 라우트는 `auth:"plugin"` 유지 — 모든 신원 해석을 `handleUpgrade`의 **검증기(ConnectionVerifier) 한 점**으로 수렴. `auth:"gateway"`는 토큰=operator 자격이라 브라우저 경로에 직접 안 씀.
- **검증기 = 공개 API:** `(req) => Promise<ConnectionIdentity | null>`. 결과 `peerId`가 곧 sessionKey(세션 분리 동시 해결).
- **빌트인 전략(config 선택):** `anonymous`(dev) / `hmac-ticket`(SaaS) / `jwt` / `trusted-header`. SaaS 임베드는 SaaS가 발급한 단명 서명 ticket을 검증(2차 로그인 아님, handoff).
- **안전 기본값:** strategy 미설정 시 기동 거부, `anonymous`는 시끄러운 opt-in+경고. (현재 검증 0 = 전세계 오픈이므로 배포 전 필수 변경)
- **사용자 정체성:** 검증된 신원 위에 채널 allowlist + pairing. **승인권 분리:** `allowFrom`(대화 허용) ≠ `execApprovals.approvers`(승인 권한).
- **노출 범위:** 게이트웨이는 기본 loopback bind. 외부 접근은 Tailscale/VPN/리버스 프록시 + 적절한 auth 모드. 운영 시 `wss://`(TLS) 종단.

---

## 11. 마일스톤 (제안)

| 단계 | 산출물 | 완료 기준 |
|---|---|---|
| M0 | 플러그인 스캐폴드 + WS 수락 + 텍스트 1왕복 | 위젯↔에이전트 텍스트 대화 |
| M1 | progress draft + 승인 버튼 + allowlist/pairing | tool 활동·HITL 동작, `channels status`에 노출 |
| M2 | 미디어 + 재연결 안정화 + 멀티세션 | 끊김 복구, 동시 세션, 파일 송수신 |
| M3 (선택) | onAgentEvent tool inspector | 구조화 tool 카드 렌더 |
| M4 (선택) | 위젯 자산 게이트웨이 서빙 / 테마 | 완전 단일 배포 |

---

## 12. 리스크 / 미해결 질문

- **WS 연결 수명주기:** 끊긴 소켓 정리, 재연결 시 세션 복원, dedupe(코어 idempotency key 활용),
  backpressure(`maxBufferedBytes` 한도). → openclaw 특유 난제 아님, 일반 WS 서버 엔지니어링.
- ~~**브라우저 auth 모델**~~ → **결정됨.** 검증기(ConnectionVerifier) seam + 빌트인 전략. 📄 `AUTH.md`. (잔여: 세션 중 강제 만료, `trusted-header` 빌트인, 커스텀 함수 주입은 후순위)
- ~~**공개 패키지화**~~ → **결정됨.** 서버/브라우저 2-패키지 분리, npm(+ClawHub) 배포. 📄 `PACKAGING.md`.
- **세션 그래머:** 검증된 `peerId`가 기본 sessionKey. 잔여는 **멀티탭** 정책(같은 사용자의 여러 탭을 묶을지/분리할지)뿐.
- **위젯 호스팅:** 개발(Vite) vs 배포(npm 패키지 / `<script>` 임베드 / 플러그인 라우트 서빙) — Phase 3에서 확정.

---

## 13. 참고 (References)

- 구조 템플릿: `now4real/openclaw-now4real` (MIT, webhook-in/API-out 패턴)
- 스트리밍 패턴: `def-initialize/openclaw-channel-streamchat` (GPL, 패턴만 참고)
- 번들 채널 소스(이 설치본 `dist/extensions/`): `telegram`, `mattermost`, `irc`, `google`, `microsoft`, `signal`
- OpenClaw 문서:
  - `docs/plugins/sdk-channel-plugins.md` — 채널 플러그인 단계별 가이드
  - `docs/plugins/sdk-channel-outbound.md` / `sdk-channel-inbound.md` — outbound/inbound 계약
  - `docs/plugins/architecture-internals.md` — `registerHttpRoute`/`handleUpgrade`
  - `docs/concepts/progress-drafts.md` — 진행 라인
  - `docs/tools/exec-approvals.md` / `exec-approvals-advanced.md` — 승인/HITL
  - `docs/gateway/protocol.md` — 게이트웨이 WS 프로토콜
```
