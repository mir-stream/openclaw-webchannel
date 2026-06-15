# ClawChannel — 패키지화 / 배포 (PACKAGING)

> ClawChannel을 **남들이 가져다 쓸 수 있는 수준**으로 배포하기 위한 패키지 구조와 작업 목록.
> 상태(2026-06-15): 구조 **결정됨**. **완료** — auth seam, 위젯 lib/example 분리, 위젯 라이브러리 빌드(`file:`/tarball 소비 가능), 게이트웨이 정적 서빙, hmac-ticket E2E 검증.
> **미완** — 플러그인 publishable(private 해제·dist 빌드·`openclaw` peerDep·exports), README·라이선스·ClawHub, 크로스오리진 게이트웨이 URL 옵션.

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

→ 미리 쪼개면 군더더기. **실제 필요가 보일 때 떼어낸다.** (위젯 *라이브러리 빌드*는 별도 패키지가 아니라 위젯 패키지 내 빌드 타깃으로 이미 완료 — §4 D. `@clawchannel/ticket`은 SaaS 백엔드 연동 시 가장 먼저 떼어질 후보.)

---

## 4. publishable 체크리스트  (✅ 완료 / 🟡 부분 / ⬜ 미착수)

### A. 구조
- 🟡 `@clawchannel/plugin`(루트) + `@clawchannel/widget`(`clawchannel/widget`) **2-패키지 경계 확립**(각자 package.json). **풀 모노레포 workspaces는 미적용**(필요해지면).
- ✅ 위젯 내부 `src/lib`(재사용) / `src/example`(데모) 분리 + 공개 배럴.
- ⬜ 플러그인 패키지명 `openclaw-clawchannel` → 스코프명 확정(`@clawchannel/plugin`?) 미정.

### B. 플러그인 패키지 → publishable  ⬜ (대부분 미완)
- ⬜ `"private"`/semver — 플러그인 `package.json`은 아직 `private:true`, `0.0.0`.
- ⬜ 빌드: `openclaw.extensions`가 아직 `./index.ts`(TS 소스). 게이트웨이가 소스 직접 로드 중이라 동작하지만, 출시엔 `dist/` 빌드 + `files`.
- ⬜ **`openclaw` peerDependency 선언**(여전히 미선언) + 테스트 버전(`v2026.6.6`).
- ⬜ ESM `exports`/`.d.ts`.
- ○ SDK 접점 adapter 격리.

### C. Auth  ✅  → 상세 `AUTH.md`
- ✅ `ConnectionVerifier` + `handleUpgrade` 배선(하드코딩 `ANON_PEER_ID` 제거).
- ✅ 빌트인 `anonymous` + `hmac-ticket` + config 스키마.
- ✅ 안전 기본값(strategy 미설정 거부, anonymous loud opt-in).
- ✅ ticket 발급/검증 zero-dep(`src/ticket.ts`) + 브라우저 발급기(`devTicket.ts`, 데모).
- ⬜ `jwt`/`trusted-header` 빌트인, `createClawChannel({auth})` 커스텀 함수 주입.

### D. 위젯 패키지 → 라이브러리 소비 가능  ✅ (file:/tarball)
- ✅ Vite 라이브러리 빌드(`vite.lib.config.ts` → `dist-lib` ESM, react external) + `tsconfig.lib.json`(.d.ts).
- ✅ `package.json` `exports`/`types`/`files:["dist-lib"]` + `build:lib`/`prepack`.
- ✅ 공개 API: `Chat` 컴포넌트 + `useClawChannel({ getTicket, path })` 훅(배럴 export). (`mount()` 형태 아님)
- ✅ `react` peerDependency. ✅ 재연결 시 `getTicket` 재호출.
- ✅ 와이어 타입: 위젯/서버 각자 선언 + 서버측 contract test.
- ⬜ **크로스오리진 게이트웨이 URL 옵션** — 현재 same-origin(`window.location.host`)만. 다른 오리진 소비처면 필요.
- ⬜ `"private"` 해제(출시 시) / `<script>` 임베드 UMD / 헤드리스 client 분리(○).

### E. 세션 분리  ✅
- ✅ 단일 `web-anon` → 검증기 `peerId`. ⬜ 멀티탭 정책.

### F. 배포 위생 / DX  ⬜
- ⬜ 패키지별 README. ⬜ 라이선스 MIT.
- ✅ 테스트 green(auth/ticket/transport/approvals/static-assets/channel + 크로스런타임 + smoke). ✅ **hmac-ticket E2E 라이브 검증**(2026-06-15).
- ⬜ ClawHub 등록 / 호환성 매트릭스 / CI.

### 게이트웨이 정적 서빙 (Phase 3) ✅
- ✅ `src/static-assets.ts` + `/clawchannel/` prefix 라우트, 예제 빌드 base `/clawchannel/`. traversal-safe(게이트웨이 정규화 + 컨테인먼트 체크). 📄 `PLAN.md` §7 Phase 3.

---

## 5. 남은 작업 / 다음 순서

지금까지: C(auth)·A 분리·D 위젯 라이브러리화·게이트웨이 서빙·E2E **완료**. 다음은 목표별:

- **SaaS 임베드 목표** → ① 크로스오리진 게이트웨이 URL 옵션(소비처가 다른 오리진일 때 1순위), ② SaaS 백엔드 ticket 발급 연동(`issueClawChannelTicket` 호출 → `getTicket`), 필요 시 ③ `@clawchannel/ticket` zero-dep 패키지 분리.
- **출시 목표** → B(플러그인 publishable: private 해제·dist 빌드·`openclaw` peerDep·exports) + F(README·MIT·ClawHub·CI) + 위젯 `private` 해제.

---

## 관련 문서
- `AUTH.md` — 인증 설계 상세(검증기 계약, 빌트인 전략, ticket 흐름, 안전 기본값).
- `PLAN.md` — 전체 기획 / 단계.
- OpenClaw: `docs/plugins/manage-plugins.md`, `docs/plugins/manifest.md`, `docs/clawhub/publishing.md`, `docs/plugins/building-plugins.md`.
