# ClawChannel — 기획서

> OpenClaw용 셀프호스트 웹 채널 플러그인 + React 위젯
> 외부 위젯 SaaS(Now4real, Stream 등) 없이, 게이트웨이 위에서 바로 도는 웹 채팅 채널.

---

## 1. 개요 (Overview)

**ClawChannel**은 OpenClaw에 React 기반 웹 채팅 위젯을 1급 **Channel**로 붙이는 프로젝트다.
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
**ClawChannel은 그 두 가지를 직접 구현**해 외부 SaaS 0개, 완전 셀프호스트를 달성한다.

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
│   │  ClawChannel 플러그인  (kind: "channel")              │   │
│   │                                                        │   │
│   │   registerHttpRoute({ path:"/clawchannel/ws",          │   │
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
1. **ClawChannel 플러그인** — 게이트웨이 *안에서* 로드되는 모듈. 별도 실행물 아님.
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
- `channels.clawchannel.streaming.mode: "progress"` 설정 시,
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

### Phase 0 — 최소 동작 (Walking skeleton)
- 플러그인 등록(`kind: "channel"`) + `registerHttpRoute`/`handleUpgrade`로 WS 수락.
- 연결맵 + `outbound.sendText` → 텍스트 1왕복.
- React 위젯: 입력창 + 메시지 렌더 + WS 연결.
- **완료 기준:** 위젯에서 보낸 메시지에 에이전트가 답하고, 그 답이 위젯에 뜬다.

### Phase 1 — 완전한 순수 채널 (MVP, 본 기획의 목표)
- `streaming.mode: "progress"` → tool 활동 라인 표시.
- `approvalCapability` → 승인 버튼 왕복(HITL).
- DM allowlist + pairing(신규 사용자 승인 코드).
- 미디어 송수신, 재연결/연결맵 수명주기 안정화, 멀티세션.
- 설정 스키마(`channels.clawchannel.*`) + `openclaw channels status` 통합.

### Phase 2 — tool inspector 확장 (선택)
- `api.runtime.events.onAgentEvent` 구독 → 자기 세션의 tool 이벤트를 WS로 forward.
- React에서 구조화 tool 카드(인자/결과/접기) 렌더.
- (옵션) `reasoningDefault: "on"|"stream"` 켜고 thinking 블록 렌더.

### Phase 3 — 다듬기 (선택)
- 정적 위젯 자산을 플러그인 라우트로 서빙(완전 단일 배포).
- typing indicator(`heartbeat.sendTyping`), 인터랙티브 버튼 액션, 테마.

---

## 8. 구성요소 / 파일 구조 (제안)

```
clawchannel/
├── package.json              # openclaw.channel 메타데이터
├── openclaw.plugin.json      # 매니페스트 (kind: "channel", channelConfigs)
├── index.ts                  # defineChannelPluginEntry / registerFull (WS 라우트)
├── setup-entry.ts            # defineSetupPluginEntry (경량 셋업 로딩)
├── src/
│   ├── channel.ts            # createChatChannelPlugin (security/pairing/outbound)
│   ├── transport.ts          # WebSocketServer(noServer) + Map<sessionKey, ws>
│   ├── inbound.ts            # WS 메시지 → 채널 inbound dispatch
│   ├── approvals.ts          # approvalCapability
│   └── channel.test.ts       # 콜로케이트 테스트
└── widget/                   # React 위젯 (별도 빌드)
    ├── src/
    │   ├── useClawChannel.ts  # WS 클라이언트 훅 (연결/송신/이벤트 디스패치)
    │   ├── Chat.tsx           # 메시지 렌더 + 입력
    │   ├── ProgressDraft.tsx  # 진행 라인 렌더
    │   └── ApprovalPrompt.tsx # [Allow][Deny] 버튼
    └── (vite 설정)
```

### 핵심 SDK 표면
- `openclaw/plugin-sdk/channel-core` — `createChatChannelPlugin`, `defineChannelPluginEntry`
- `openclaw/plugin-sdk/channel-outbound` — outbound 어댑터/receipt
- `openclaw/plugin-sdk/approval-runtime` — `approvalCapability` 헬퍼
- `api.registerHttpRoute({ handleUpgrade })` — WS 수락
- `messaging.resolveSessionConversation(...)` — 세션 그래머

---

## 9. 설정 (Config) — 예시

```json5
{
  channels: {
    clawchannel: {
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

- **라우트 인증:** 플러그인 WS 라우트는 `auth` 명시 필수.
  - `auth: "gateway"` → 게이트웨이 공유 auth 요구. 단 게이트웨이 토큰=operator 자격이라 **공개 브라우저에 직접 노출 금지.**
  - `auth: "plugin"` → 플러그인 자체 인증(권장: 위젯용 per-user 토큰/세션 + 채널 allowlist/pairing).
- **사용자 정체성:** 채널 allowlist + pairing 승인 코드로 신규 사용자 관리.
- **승인권 분리:** `allowFrom`(대화 허용) ≠ `execApprovals.approvers`(승인 권한).
- **노출 범위:** 게이트웨이는 기본 loopback bind. 외부 접근은 Tailscale/VPN/리버스 프록시 + 적절한 auth 모드.
- **전송 보안:** 운영 시 `wss://`(TLS) 종단 — 리버스 프록시 또는 tailnet.

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
- **브라우저 auth 모델:** `plugin` auth로 per-user 토큰 발급 방식 설계 필요(게이트웨이 토큰 직접 노출 회피).
- **위젯 호스팅:** 개발(Vite) vs 배포(정적 호스팅 vs 플러그인 라우트 서빙) 결정.
- **세션 그래머:** 익명/다중 탭 사용자를 sessionKey로 어떻게 매핑할지(쿠키? 발급 토큰?).
- **공개 패키지화:** npm/ClawHub 배포 시 이름 충돌·버전 핀 고려(현 시점 공개 클라이언트 패키지 미출시).

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
