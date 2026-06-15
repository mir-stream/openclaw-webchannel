# ClawChannel — 백로그 (Backlog)

나중에 결정/구현할 항목. 본 기획(`PLAN.md`)에서 의도적으로 미룬 것들.

---

## 🔐 브라우저 Auth 모델 — ✅ 결정됨 (📄 `AUTH.md`)

**상태:** **결정 완료.** 인증은 `auth:"plugin"` + `handleUpgrade`의 **검증기(ConnectionVerifier) 한 점**으로 수렴,
흔한 방식은 **config로 고르는 빌트인 전략**(`anonymous`/`hmac-ticket`/`jwt`/`trusted-header`)으로 제공.
SaaS 임베드는 SaaS가 발급한 단명 서명 ticket을 플러그인이 검증(2차 로그인 아님). 상세 설계는 `AUTH.md`.

**현재 코드 상태(미구현):** WS 라우트는 `auth:"plugin"` + 검증 0 → 누구나 접속 가능(loopback dev 가정),
모든 연결이 단일 익명 피어 `web-anon`(`transport.ts:18`)으로 매핑됨. **배포 전 검증기 seam으로 교체 필요.**
⚠️ 그 전까지 **운영 노출 금지** — 게이트웨이는 loopback bind 유지.

**잔여(후속, AUTH.md §9):**
- 세션 중 강제 만료(revocation) — 이미 열린 소켓은 자동으로 안 닫힘.
- `jwt` / `trusted-header` 빌트인은 후순위(우선 `anonymous` + `hmac-ticket`).
- 멀티탭 사용자를 같은 peerId로 묶을지/분리할지 정책.

**관련:** `AUTH.md`(상세), `PACKAGING.md`(ticket 헬퍼 패키지화), `PLAN.md` §10·§12.

---

## 🖥️ 위젯 호스팅 방식 (open)

**상태:** 개발은 Vite(dev)로 진행, **배포 방식만 추후 확정.**

후보:
- ① Vite dev 서버 (개발 기본값)
- ② 별도 정적 호스팅 (nginx/Netlify/S3)
- ③ **플러그인이 게이트웨이 포트로 서빙** (`registerHttpRoute`) — 단일 출처·단일 배포, 기획 방향과 가장 부합 (PLAN.md Phase 3)
- ④ 임베드 `<script>` 스니펫 (남의 사이트에 심는 위젯)

영향: CORS/origin(`gateway.controlUi.allowedOrigins`), 배포 단위, 사용 형태.
