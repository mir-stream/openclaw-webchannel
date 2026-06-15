# ClawChannel — 패키지화 / 배포 (PACKAGING)

> ClawChannel을 **남들이 가져다 쓸 수 있는 수준**으로 배포하기 위한 패키지 구조와 작업 목록.
> 상태: 구조는 **결정됨**, 실행은 진행 예정.

---

## 1. 두 개의 패키지 — 왜 쪼개나

ClawChannel 코드는 **돌아가는 런타임이 둘**이고, 둘의 의존성 그래프는 섞이면 안 된다. (재사용 명분이 아니라 **기술적 강제**)

| | 플러그인 패키지 | 위젯 패키지 |
|---|---|---|
| 어디서 도나 | OpenClaw 게이트웨이 (Node 서버) | 브라우저 |
| 누가 설치 | 백엔드 배포자 | 프런트엔드 빌드 |
| 의존성 | `ws`, `openclaw/plugin-sdk`(peer) | `react`(peer) |
| 배포 | npm (+ ClawHub) | npm (+ `<script>` 임베드 가능) |

npm 패키지는 `dependencies` 목록이 하나라, 한 패키지에 묶으면 프런트 번들이 `openclaw/plugin-sdk`·`ws`(Node 전용)를 끌어들여 **빌드가 깨지거나 비대해진다.** (`@sentry/node` vs `@sentry/browser`, `@trpc/server` vs `@trpc/client`이 같은 이유로 분리됨.)

```
@clawchannel/plugin    (서버, Node)   ← 게이트웨이에 설치  (현재 루트 코드: index.ts, src/*)
@clawchannel/widget    (브라우저)      ← 프런트에 설치     (현재 clawchannel/widget)
```

---

## 2. OpenClaw 플러그인은 어떻게 공유·설치되나

핵심: **OpenClaw 플러그인도 그냥 npm 패키지다.** 특별한 빌드 형식이 아니라, `package.json`에 `"openclaw"` 블록이 있으면 OpenClaw가 플러그인으로 인식한다.

```json package.json
{
  "name": "@acme/openclaw-plugin",
  "type": "module",
  "openclaw": { "extensions": ["./dist/index.js"] }
}
```

설치는 `npm install`이 아니라 **OpenClaw가 관리**한다 (다운로드·추적·게이트웨이 자동 재시작 포함):

```bash
openclaw plugins install clawhub:<pkg>      # ClawHub (OpenClaw 전용 레지스트리)
openclaw plugins install npm:@acme/openclaw-plugin
openclaw plugins install git:github.com/acme/repo@v1.0.0
openclaw plugins install ./my-plugin        # 로컬 개발
```

- **ClawHub** = OpenClaw 플러그인 전용 디스커버리 레지스트리(검색·버전·보안 스캔·리뷰). `clawhub package publish your-org/your-plugin`로 등록.
- **npm만으로도 충분** — ClawHub는 "남들이 발견하게" 하려는 선택지. 비공개/내부 배포면 npm·git·사내 레지스트리로 족함.

| | 웹 패키지 | 플러그인 패키지 |
|---|---|---|
| 누가 설치 | 번들러가 `import` | OpenClaw가 `openclaw plugins install` |
| "이게 X다" 표시 | — | `package.json`의 `"openclaw"` 필드 |

---

## 3. 지금은 미루는 패키지 (트리거가 올 때만 분리)

| 후보 | 무엇 | 분리 트리거 |
|---|---|---|
| `@clawchannel/protocol` | 와이어 타입(Inbound/Outbound 메시지) 공유 | 타입 드리프트가 실제로 아플 때. 그 전엔 **복제 + contract test**(`transport.ts:39` 패턴) |
| `@clawchannel/ticket` | ticket 서명/검증 zero-dep 모듈 | SaaS 백엔드가 SDK 없이 깨끗이 설치해야 할 때. 그 전엔 플러그인의 SDK-free 서브패스 export |
| `@clawchannel/client` | 헤드리스 브라우저 WS 클라이언트(React 제거) | non-React 소비자(Vue/순수JS)가 생길 때. 그 전엔 위젯 내부 모듈 |

→ 미리 쪼개면 군더더기. **실제 필요가 보일 때 떼어낸다.**

---

## 4. publishable 체크리스트  (● 배포 MVP 필수 / ○ 나중)

### A. 구조
- ● 모노레포(workspaces): `@clawchannel/plugin` + `@clawchannel/widget`
- ● 현재 루트 코드 → plugin, `clawchannel/widget` → widget으로 정리
- ● 패키지명/스코프 확정 (현재 `openclaw-clawchannel`)

### B. 플러그인 패키지 → publishable
- ● `"private": true` 제거 + 실제 semver (현재 `0.0.0`)
- ● 빌드(tsc): TS→`dist/`, `openclaw.extensions`를 `./index.ts`→`./dist/index.js`로, `files` 화이트리스트
- ● **`openclaw`를 peerDependency로 선언** (현재 의존성 선언 자체 없음) + 테스트 버전(`v2026.6.6`) 기재
- ● ESM `exports` 맵 + `.d.ts` 동봉
- ○ SDK 접점을 adapter 한 파일로 격리 (현재 `.d.ts:NNN` 줄번호가 주석에 흩어져 버전업에 취약)

### C. Auth  → 상세는 `AUTH.md`
- ● `ConnectionVerifier` 계약 + `handleUpgrade` 배선(하드코딩 `ANON_PEER_ID` 제거)
- ● 빌트인 `anonymous` + `hmac-ticket` (최소 2종) + config 스키마
- ● **안전 기본값**(strategy 미설정 거부, anonymous loud opt-in)
- ● ticket 발급 zero-dep 헬퍼
- ○ `jwt` / `trusted-header` 빌트인, `createClawChannel({auth})` 라이브러리 export

### D. 위젯 패키지 → publishable
- ● Vite library 빌드: ESM + CSS + 타입
- ● 공개 API: `mount(el, { url, getTicket })` (또는 React 컴포넌트)
- ● `react`를 peerDependency로 (번들에 React 금지)
- ● 재연결 시 `getTicket` 재호출
- ● 와이어 타입 공유: 당장은 복제 + contract test
- ○ `<script>` 임베드용 UMD / 헤드리스 client 분리

### E. 세션 분리
- ● 단일 `web-anon` → identity별 peerId (C의 검증기 결과에서 자동으로 떨어짐)
- ○ 멀티탭 정책

### F. 배포 위생 / DX
- ● 패키지별 README(설치법·config·auth 전략표·테스트된 OpenClaw 버전·SaaS 예제)
- ● 라이선스 MIT
- ● 테스트 green: smoke + 채널 SDK contract test + auth 전략 유닛테스트
- ○ ClawHub 등록 / 호환성 매트릭스 / CI / example 호스트 앱

---

## 5. 추천 순서 (의존관계 기준)

1. **C(auth seam) 먼저** — 검증기 계약/peerId가 세션 분리(E)·위젯 getTicket(D)·ticket 헬퍼의 뿌리. 안전 기본값도 여기.
2. **A/B(구조 + 플러그인 publishable)** — 코드가 안정됐을 때 패키지 경계를 그음.
3. **D(위젯)** — plugin의 auth/프로토콜 확정 후 getTicket·재연결.
4. **F(문서/테스트/배포)** — 마지막에 위생.

> 한 줄 요약: **auth를 먼저 코드로 정리 → 그 다음 2패키지로 쪼개고 배포 가능하게.**

---

## 관련 문서
- `AUTH.md` — 인증 설계 상세(검증기 계약, 빌트인 전략, ticket 흐름, 안전 기본값).
- `PLAN.md` — 전체 기획 / 단계.
- OpenClaw: `docs/plugins/manage-plugins.md`, `docs/plugins/manifest.md`, `docs/clawhub/publishing.md`, `docs/plugins/building-plugins.md`.
