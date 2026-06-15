# ClawChannel — 백로그 (Backlog)

나중에 결정/구현할 항목. 본 기획(`PLAN.md`)에서 의도적으로 미룬 것들.

---

## 🔐 브라우저 Auth 모델 — ✅ 결정됨 (📄 `AUTH.md`)

**상태:** **결정 완료.** 인증은 `auth:"plugin"` + `handleUpgrade`의 **검증기(ConnectionVerifier) 한 점**으로 수렴,
흔한 방식은 **config로 고르는 빌트인 전략**(`anonymous`/`hmac-ticket`/`jwt`/`trusted-header`)으로 제공.
SaaS 임베드는 SaaS가 발급한 단명 서명 ticket을 플러그인이 검증(2차 로그인 아님). 상세 설계는 `AUTH.md`.

**현재 코드 상태: ✅ 구현됨(2026-06-15).** `src/auth.ts`의 검증기 seam + `anonymous`/`hmac-ticket` 빌트인 + 안전 기본값(미설정 시 로드 거부), per-peer 라우팅, 위젯 `getTicket`. **hmac-ticket E2E 라이브 검증 완료.** (`anonymous`는 dev 전용·경고.)

**잔여(후속, AUTH.md §9):**
- `jwt` / `trusted-header` 빌트인, `createClawChannel({auth})` 커스텀 함수 주입.
- 세션 중 강제 만료(revocation) + **잘못된 ticket 시 재연결 루프 UX**.
- 멀티탭 정책.

**관련:** `AUTH.md`(상세), `PACKAGING.md`(ticket 헬퍼 패키지화), `PLAN.md` §10·§12.

---

## 🖥️ 채팅 UI 호스팅 방식 — ✅ 게이트웨이 서빙 구현됨

**상태:** 후보 ③(**플러그인이 게이트웨이 포트로 서빙**, `src/static-assets.ts` + `/clawchannel/` 라우트)을 **구현 완료**(PLAN.md Phase 3). dev는 Vite(프록시), 배포는 **client 데모** `npm run build:demo`(→`packages/client/dist-demo`, base `/clawchannel/`) 산출물을 게이트웨이가 서빙. (구 React 위젯 서빙은 위젯 삭제로 대체됨.)
- 잔여: ② 별도 정적 호스팅 / ④ `<script>` 임베드는 선택지로 남김. 별도 오리진 호스팅 시 **크로스오리진 WS URL 옵션**(아래) 필요.

---

## 📦 남은 작업 (2026-06-15 기준)

**SaaS 임베드 경로**
- **크로스오리진 게이트웨이 URL 옵션** — `@clawchannel/client`의 `url` 옵션으로 **해결됨**(다른 오리진 게이트웨이 직접 지정).
- **SaaS 실연동** — 백엔드가 서버측 `issueClawChannelTicket`로 발급 → 클라이언트 `getTicket`. (현재 데모는 브라우저 발급 = DEV 전용)
- `@clawchannel/ticket` zero-dep 패키지 분리(SaaS 백엔드가 SDK 없이 소비할 때).

**출시 경로(PACKAGING §4 B/F)**
- 플러그인 publishable: `private` 해제·실 semver·`dist` 빌드·`openclaw` peerDep·`exports`. client `private` 해제.
- 패키지별 README, MIT 라이선스, ClawHub 등록, 호환성 매트릭스, CI.

**기능 잔여(PLAN §7)**
- 미디어 송수신, DM pairing(승인 코드), `allowFrom` 실유저화(현재 `web-anon`만), `openclaw channels status` 통합.
- 정적 자산 캐시 헤더(nit), 플러그인 매니페스트 메타데이터 경고(label/blurb/docsPath) 정리.
- Phase 2: onAgentEvent tool inspector(구조화 카드), thinking 렌더.
