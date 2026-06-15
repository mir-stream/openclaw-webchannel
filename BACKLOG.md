# ClawChannel — 백로그 (Backlog)

나중에 결정/구현할 항목. 본 기획(`PLAN.md`)에서 의도적으로 미룬 것들.

---

## 🔐 브라우저 Auth 모델 (deferred — 현재 완전 OPEN)

**상태:** **결정 보류(TBD). 당분간 인증 완전 OPEN으로 운영.**
- 현재 WS 라우트는 `auth:"plugin"` + 토큰 검증 없음 → 사실상 누구나 접속 가능(loopback dev 가정).
- 모든 연결은 단일 익명 피어 `web-anon` 으로 매핑됨(세션 분리 없음).
- ⚠️ **운영 노출 금지 전제:** 게이트웨이는 loopback bind. 외부 노출 시 반드시 이 항목을 먼저 해결.
- 채널 `allowFrom:["web-anon"]` allowlist는 형식상 통과용일 뿐 실제 사용자 식별 아님.

**왜 미루나:** progress draft / 승인(HITL) 같은 가시적 기능을 먼저 검증하려고 의도적으로 뒤로 미룸.
멀티세션·승인권 분리·pairing 이 전부 "어느 소켓이 어느 사용자냐"에 의존하므로, 그 설계와 함께 한 번에 풀 예정.

**문제:** React 위젯이 브라우저에서 게이트웨이 WS 라우트에 붙을 때 어떻게 인증할 것인가.

**제약/맥락:**
- 게이트웨이 공유 토큰(`gateway.auth.token`)은 **operator(owner) 자격**으로 취급됨 → 공개 브라우저에 직접 노출 금지.
- 플러그인 라우트는 `auth` 명시 필수: `"gateway"`(게이트웨이 공유 auth) vs `"plugin"`(플러그인 자체 인증).
- 채널은 자체 allowlist + pairing(승인 코드)으로 사용자 정체성을 관리할 수 있음.

**유력 방향(미확정):**
- `auth: "plugin"` 로 두고 **위젯용 per-user 토큰/세션**을 플러그인이 자체 발급·검증.
- 채널 allowlist/pairing과 연동해 신규 사용자 승인.
- 익명/다중 탭 사용자를 어떤 식별자로 sessionKey에 매핑할지와 함께 설계(쿠키 vs 발급 토큰).

**관련:** `PLAN.md` §10 보안, §12 미해결 질문(sessionKey 매핑).

---

## 🖥️ 위젯 호스팅 방식 (open)

**상태:** 개발은 Vite(dev)로 진행, **배포 방식만 추후 확정.**

후보:
- ① Vite dev 서버 (개발 기본값)
- ② 별도 정적 호스팅 (nginx/Netlify/S3)
- ③ **플러그인이 게이트웨이 포트로 서빙** (`registerHttpRoute`) — 단일 출처·단일 배포, 기획 방향과 가장 부합 (PLAN.md Phase 3)
- ④ 임베드 `<script>` 스니펫 (남의 사이트에 심는 위젯)

영향: CORS/origin(`gateway.controlUi.allowedOrigins`), 배포 단위, 사용 형태.
