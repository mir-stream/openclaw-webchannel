# docs/ — index

현재 동작 상태의 **단일 진실원은 [`STATUS.md`](STATUS.md)**다. 커밋 메시지·Ouroboros
seed(`.ouroboros/*`)·평가 점수에 "AC 100% / complete"가 보여도, 그것과 충돌하면 STATUS.md가 옳다.

| 문서 | 무엇 | 성격 |
|---|---|---|
| [`STATUS.md`](STATUS.md) | 지금 무엇이 되고 안 되는지 (게이트웨이-WS ✅ / NATS E2E 🚧) | **진실원 · 항상 최신 유지** |
| [`PLAN.md`](PLAN.md) | 전체 범위·아키텍처·단계(Phase 0–3)·리스크 | 설계/계획 기준 |
| [`AUTH.md`](AUTH.md) | 인증·신원 모델 (ConnectionVerifier seam, 빌트인 전략) | 설계 (라이브 검증됨) |
| [`TRUST_AND_ONBOARDING.md`](TRUST_AND_ONBOARDING.md) | E2E NATS relay 신뢰 결합 + 디바이스-플로우 온보딩 | ⚠️ 설계 전용 (E2E 미실행) |
| [`PACKAGING.md`](PACKAGING.md) | 패키지 구조·배포/ClawHub 체크리스트 | 일부 미완 |
| [`RESEARCH.md`](RESEARCH.md) | OpenClaw 내부 API·경로 조사 노트 | 레퍼런스 (설치본 시점 기준) |
| [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md) | 외부 채널 대비 기능 갭 분석 | 리서치 아티팩트 (advisory) |
| [`archive/`](archive/) | 옛 PRD 등 역사 스냅샷 | 보관 (참조 금지, STATUS/PLAN 사용) |

패키지별 문서는 각 패키지 README 참조: `packages/plugin/README.md`,
`packages/client/README.md`, `packages/saas/README.md`.
Ouroboros 빌드 히스토리는 `.ouroboros/` (역사 기록).
