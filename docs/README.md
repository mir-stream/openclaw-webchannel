# docs/ — index

현재 동작 상태의 **단일 진실원은 [`STATUS.md`](STATUS.md)**다. 커밋 메시지·Ouroboros
seed(`.ouroboros/*`)·평가 점수에 "AC 100% / complete"가 보여도, 그것과 충돌하면 STATUS.md가 옳다.

| 문서 | 무엇 | 성격 |
|---|---|---|
| [`STATUS.md`](STATUS.md) | 지금 무엇이 되고 안 되는지 (NATS E2E ✅ production default / Gateway-WS 🔧 legacy dev-only) | **진실원 · 항상 최신 유지** |
| [`SPLIT_DEMO.md`](SPLIT_DEMO.md) | 분할 호스트(Mac)/컨테이너 라이브 데모 재현 가이드 | 재현 가이드 |
| [`BACKLOG.md`](BACKLOG.md) | 후속 작업 (legacy Gateway-WS 전송 제거 등; `hmac-ticket` 전략 제거 완료) | 백로그 |
| [`PLAN.md`](PLAN.md) | 전체 범위·아키텍처·단계(Phase 0–3)·리스크 | 설계/계획 기준 |
| [`AUTH.md`](AUTH.md) | 인증·신원 모델 (ConnectionVerifier seam, 빌트인 전략) | 설계 (라이브 검증됨) |
| [`TRUST_AND_ONBOARDING.md`](TRUST_AND_ONBOARDING.md) | E2E NATS relay 신뢰 결합 + 디바이스-플로우 온보딩 | ✅ 라이브 검증됨 (live-proven) |
| [`PACKAGING.md`](PACKAGING.md) | 패키지 구조·배포/ClawHub 체크리스트 | 일부 미완 |
| [`RESEARCH.md`](RESEARCH.md) | OpenClaw 내부 API·경로 조사 노트 | 레퍼런스 (설치본 시점 기준) |
| [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md) | 외부 채널 대비 기능 갭 분석 | 리서치 아티팩트 (advisory) |
| [`archive/`](archive/) | 옛 PRD 등 역사 스냅샷 | 보관 (참조 금지, STATUS/PLAN 사용) |

패키지별 문서는 각 패키지 README 참조: `packages/plugin/README.md`,
`packages/client/README.md`, `packages/saas/README.md`.
Ouroboros 빌드 히스토리는 `.ouroboros/` (역사 기록).
