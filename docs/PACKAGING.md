# WebChannel — 패키지화 / 배포 (PACKAGING)

> 📌 **현재 동작 상태의 단일 진실원: [`STATUS.md`](STATUS.md).** 이 문서는 배포 구조·체크리스트 기준이며 명시된 날짜 시점 기준이다.
>
> ⚠️ **superseded — `hmac-ticket` 전략은 이후 완전히 제거됨.** 아래 `hmac-ticket`·`ticket.ts`·`smoke-client.mjs` 관련 서술은 스냅샷 당시의 역사 기록이며, 현행 인증은 `jwt`뿐이다 ([`AUTH.md`](AUTH.md) §4, [`BACKLOG.md`](BACKLOG.md)).

> WebChannel을 **남들이 가져다 쓸 수 있는 수준**으로 배포하기 위한 패키지 구조와 작업 목록.
> 상태(2026-06-15): 구조 **결정됨**. **완료** — auth seam, **헤드리스 `openclaw-webchannel-client`(framework-agnostic, zero-dep)** 구현, hmac-ticket E2E 검증(node smoke 스크립트).
> **변경** — 기존 React `openclaw-webchannel-widget`는 **삭제**(2026-06-15). 사용자가 원한 건 React 위젯이 아니라 *기능*이었고, 그 기능은 `openclaw-webchannel-client`가 프레임워크 없이 제공한다. (브라우저 UI는 소비자가 client 라이브러리 위에 직접 얹는다 — 이 repo는 데모 UI를 배포하지 않는다.)
> **미완** — 플러그인 publishable(private 해제·dist 빌드·`openclaw` peerDep·exports), README·라이선스·ClawHub.

---

## 1. 패키지 경계 — 왜 쪼개나

**1축 (런타임):** WebChannel 코드는 **돌아가는 런타임이 둘**(Node 서버 vs 브라우저)이고, 둘의 의존성 그래프는 섞이면 안 된다. (재사용 명분이 아니라 **기술적 강제**)

| | 플러그인 패키지 | 브라우저 패키지 |
|---|---|---|
| 어디서 도나 | OpenClaw 게이트웨이 (Node 서버) | 브라우저 |
| 누가 설치 | 백엔드 배포자 | 프런트엔드 빌드 |
| 의존성 | `ws`, `openclaw/plugin-sdk`(peer) | 없음 (zero dep) |
| 배포 | npm (+ ClawHub) | npm (+ `<script>` 임베드 가능) |

npm 패키지는 `dependencies` 목록이 하나라, 한 패키지에 묶으면 프런트 번들이 `openclaw/plugin-sdk`·`ws`(Node 전용)를 끌어들여 **빌드가 깨지거나 비대해진다.** (`@sentry/node` vs `@sentry/browser`, `@trpc/server` vs `@trpc/client`이 같은 이유로 분리됨.)

```
openclaw-webchannel    (서버, Node)            ← 게이트웨이에 설치  (packages/plugin: index.ts, src/*)
openclaw-webchannel-client    (브라우저, 무프레임워크)  ← 헤드리스 연결/프로토콜/상태  (packages/client)
```
> **npm workspaces 모노레포.** 루트는 워크스페이스 매니저(코드 없음, `workspaces:["packages/*"]`), 두 패키지는 `packages/` 아래 대칭. 게이트웨이 `plugins.load.paths`는 `packages/plugin`을 가리킨다. 📄 구조 트리는 `PLAN.md` §8.

> **2축 (프레임워크)는 이제 패키지 경계가 아니다.** 브라우저 쪽은 **무프레임워크 코어(`client`) 하나**만 배포한다. React/Vue/순수 JS 뷰는 *소비자 쪽*에서 그 위에 얹는다(이 repo가 React 뷰를 떠안지 않는다). — 과거엔 React `openclaw-webchannel-widget`를 별도 패키지로 뒀으나 2026-06-15 삭제(§4 D).

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
| `openclaw-webchannel-protocol` | 와이어 타입(Inbound/Outbound 메시지) 공유 | 타입 드리프트가 실제로 아플 때. 그 전엔 **복제 + contract test**(`transport.ts:39` 패턴) |
| `openclaw-webchannel-ticket` | ticket 서명/검증 zero-dep 모듈 | SaaS 백엔드가 SDK 없이 깨끗이 설치해야 할 때. 그 전엔 플러그인의 SDK-free 서브패스 export |

→ 미리 쪼개면 군더더기. **실제 필요가 보일 때 떼어낸다.** (`openclaw-webchannel-ticket`은 SaaS 백엔드 연동 시 가장 먼저 떼어질 후보.)

> **`openclaw-webchannel-client` — 분리 완료(2026-06-15).** 헤드리스 브라우저 WS 클라이언트(React 제거). 트리거(non-React 소비자)가 실제로 왔다 → `packages/client`에 zero-dep로 신규 구현. 와이어 타입은 `transport.ts`를 복제(`openclaw-webchannel-protocol`은 여전히 보류).

---

## 4. publishable 체크리스트  (✅ 완료 / 🟡 부분 / ⬜ 미착수)

### A. 구조
- ✅ **npm workspaces 모노레포**(2026-06-15) — `openclaw-webchannel`(`packages/plugin`) + `openclaw-webchannel-client`(`packages/client`), 루트는 워크스페이스 매니저(`workspaces:["packages/*"]`, 단일 lock). 게이트웨이 load path = `packages/plugin`.
- ⬜ 플러그인 패키지명 `openclaw-webchannel` → 스코프명 확정(`openclaw-webchannel`?) 미정.

### B. 플러그인 패키지 → publishable  ⬜ (대부분 미완)
- ⬜ `"private"`/semver — 플러그인 `package.json`은 아직 `private:true`, `0.0.0`.
- ⬜ 빌드: `openclaw.extensions`가 아직 TS 소스. 게이트웨이가 소스 직접 로드 중이라 동작하지만, 출시엔 `dist/` 빌드 + `files`. **(superseded — entry는 이제 `./index-nats.ts`가 기본값이고 direct gateway entry removed; `STATUS.md` 참조.)**
- ⬜ **`openclaw` peerDependency 선언**(여전히 미선언) + 테스트 버전(`v2026.6.6`).
- ⬜ ESM `exports`/`.d.ts`.
- ○ SDK 접점 adapter 격리.

### C. Auth  ✅  → 상세 `AUTH.md`
- ✅ `JWT register verifier` + `register-hop verification` 배선(하드코딩 `ANON_PEER_ID` 제거).
- ✅ 빌트인 `anonymous` + `hmac-ticket` + `jwt` + config 스키마.
- ✅ 안전 기본값(strategy 미설정 거부, anonymous loud opt-in).
- ✅ ticket 발급/검증 zero-dep(`src/ticket.ts` for hmac, `src/jwt.ts`+`src/jwks.ts` for RS256+JWKS). node smoke 스크립트(`NATS live harness` 등)가 발급측을 수행해 E2E 검증.
- ⬜ `trusted-header` 빌트인, `createWebChannel({auth})` 커스텀 함수 주입.

### D. 헤드리스 클라이언트 `openclaw-webchannel-client`  ✅ (2026-06-15)
- ✅ `packages/client` 신규 구현 — **framework-agnostic, zero runtime dep**. ESM, `tsc` 빌드(라이브러리 → `dist/` JS + `.d.ts`).
- ✅ `WebChannelNATSClient`: `connect()`/`close()`/`send()`/`decide()` + `subscribe(listener)`(불변 상태 스냅샷 push) + `getState()`. (재연결 백오프+지터, 동시-connect sentinel, 매 재연결 `getTicket`, progress 드래프트, 승인 카드, 고아 드래프트 정리, **typing indicator: `WebChannelState.isTyping` + `typing` 케이스 자동 settle**, **history pagination: connect 시 `history` 프레임으로 `state.messages` hydrate + `loadHistory({before?, limit?})` 페이지네이션 메서드, id 중복 가드**.)
- ✅ **상태 소유권이 클라이언트** — 메시지/승인 리듀서가 여기 단일 출처. 순수 JS/Vue/React 뷰는 얇은 뷰. `state.messages`는 초기 비어있다가 connect 성공 시 서버 `history` 프레임으로 hydrate (스크롤 복원 / 페이지 reload 시 "어제 무슨 얘기했지?" UX 해결).
- ✅ **크로스오리진 `url` 옵션** + same-origin `path` 옵션.
- ✅ `vitest` 유닛 29케이스 + 라이브 게이트웨이 hmac-ticket + jwt E2E(node smoke 스크립트 `smoke-client.mjs`, `NATS live harness`) 통과. (브라우저 UI는 소비자가 client 라이브러리 위에 직접 구성 — 이 repo는 데모 페이지를 배포하지 않는다.)
- ✅ **삭제된 React `openclaw-webchannel-widget` 대체.** 위젯(`webchannel/widget`: `useWebChannel` 훅 + `Chat.tsx` + example)은 2026-06-15 삭제. 위젯이 들고 있던 연결 로직은 client에 프레임워크 없이 재구현됐다.
- ⬜ `"private"` 해제(출시 시) / `<script>` 임베드 UMD / README.

### E. 세션 분리  ✅
- ✅ 단일 `web-anon` → 검증기 `peerId`. ⬜ 멀티탭 정책.

### F. 배포 위생 / DX  ⬜
- ⬜ 패키지별 README. ⬜ 라이선스 MIT.
- ✅ 테스트 green(auth/ticket/transport/approvals/channel + 크로스런타임 + client 유닛 + smoke). ✅ **hmac-ticket E2E 라이브 검증**(2026-06-15).
- ⬜ ClawHub 등록 / 호환성 매트릭스 / CI.

---

## 5. 남은 작업 / 다음 순서

지금까지: C(auth)·A 분리·D 헤드리스 클라이언트(+ 위젯 삭제)·E2E **완료**. 다음은 목표별:

- **SaaS 임베드 목표** → ① 크로스오리진은 client `url` 옵션으로 **완료**, ② SaaS 백엔드 ticket 발급 연동(`issueWebChannelTicket` 호출 → `getTicket`), 필요 시 ③ `openclaw-webchannel-ticket` zero-dep 패키지 분리.
- **출시 목표** → B(플러그인 publishable: private 해제·dist 빌드·`openclaw` peerDep·exports) + D(client `private` 해제·README) + F(라이선스·ClawHub·CI).

---

## 관련 문서
- `AUTH.md` — 인증 설계 상세(검증기 계약, 빌트인 전략, ticket 흐름, 안전 기본값).
- `PLAN.md` — 전체 기획 / 단계.
- OpenClaw: `docs/plugins/manage-plugins.md`, `docs/plugins/manifest.md`, `docs/clawhub/publishing.md`, `docs/plugins/building-plugins.md`.
