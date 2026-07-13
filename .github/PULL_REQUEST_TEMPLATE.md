<!--
이 저장소(openclaw-webchannel)는 다운스트림(rota-crew 등)이 소비하는 클라이언트·
플러그인·SaaS 계약을 배포합니다. "타입상 optional이지만 런타임 필수"인 필드가
조용히 추가되어 다운스트림 프로덕션 채팅이 터미널로 파손된 F2 사고가 있었고,
다운스트림 CI는 타입만 보므로 그 파손을 못 잡았습니다. 아래 계약 체크리스트는
그 부류의 재발을 막기 위한 것입니다 — 해당 없으면 그대로 두고 체크만 비워 두세요.
-->

## 요약

<!-- 무엇을·왜. 한두 문단. -->

## 변경 종류

- [ ] 기능 추가
- [ ] 버그 수정
- [ ] 리팩터링(동작 불변)
- [ ] 문서/빌드/CI
- [ ] 계약 변경(아래 체크리스트 필수 검토)

## 다운스트림 계약 체크리스트

와이어/HTTP 계약을 건드렸다면 각 항목을 확인하세요. **"해당 없음"도 명시적으로
표시**하세요(빈칸 = 미검토로 간주).

- [ ] **클라↔플러그인 와이어 계약** 변경 여부 — 프레임 타입(InboundMessage/
      OutboundMessage), register 챌린지/응답 필드, E2E 봉투(ENVELOPE_VERSION).
      → 비하위호환이면 `WEBCHANNEL_PROTOCOL_VERSION` 범프가 필요한가?
      (client `packages/client/src/protocol.ts` ↔ plugin
      `packages/plugin/src/protocol.ts` 락스텝)
- [ ] **플러그인↔SaaS HTTP 계약** 변경 여부 — enroll / poll / bootstrap 요청·응답
      필드(`EnrollmentRequest` 등, 플러그인 사본 ↔ `packages/saas` 미러 정합).
- [ ] **"타입상 optional이지만 런타임 필수"인 필드**를 추가했는가? (F2 교훈:
      다운스트림 CI는 타입으로 못 잡음) — 추가했다면 런타임 폴백·핸드셰이크·
      계약 테스트로 강제되는지 확인.
- [ ] 다운스트림 **rota-crew의 `WC_REF` SHA 범프 + 계약 테스트** 갱신이 필요한가?
- [ ] **게이트웨이 플러그인 재배포/재등록**이 필요한가? (register/enroll 핸드셰이크
      또는 플러그인 측 계약이 바뀐 경우)
- [ ] **client / plugin / saas 락스텝 버전 정합** — 세 패키지 버전이 어긋나지 않는가?

## 테스트

- [ ] `npx vitest run` 루트 스윕 그린(베이스라인 이상)
- [ ] 3패키지 `tsc --noEmit` + 빌드 그린
- [ ] examples 소비자 테스트 / pack-load 스모크 그린(계약·export 변경 시)
- [ ] 하위호환 양방향 검증(신·구 클라 ↔ 신·구 플러그인) — 계약 변경 시
