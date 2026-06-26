# 3-패키지 상태 신뢰성 진단 판정 문서 (openclaw-webchannel)

*Created At: 2026-06-26T00:05:43.547697+00:00*

## Goal

빌드/테스트는 통과하지만 저장소 상태를 신뢰할 수 없는 openclaw-webchannel(plugin/web/saas 3패키지) 프로젝트에 대해, 4개 완료조건 각각의 통과/불통과 여부와 근거를 담은 진단 판정 문서를 산출하여 PM이 후속 정리·병합을 결정할 근거를 제공한다.

## User Stories

1. **As a** PM, **I want to** 현재 무엇이 진짜 동작 상태인지 4개 조건별 통과/불통과와 근거가 적힌 진단 판정 문서를 받는다, **so that** 주니어가 어지럽힌 저장소 상태를 신뢰할 수 있는지 판단하고 후속 remediation을 스스로 결정하기 위해.
2. **As a** PM, **I want to** 녹색 게이트 3종(typecheck+build+test 731 passing)이 재현 가능하게 통과하는지 검증된 결과를 본다, **so that** 코드 동작 기반선이 신뢰 가능함을 확정하기 위해.
3. **As a** PM, **I want to** 흩어진 AC 보고서 .md 난립 대신 STATUS.md 단일 진실원 정리 여부 판정을 받는다, **so that** 현재 상태의 단일 출처를 확보하기 위해.
4. **As a** PM, **I want to** plugin/web/saas 3패키지의 빌드·의존·인터페이스 계약 일치 여부(특히 plugin build 스크립트 부재가 의도인지 누락인지) 판정을 받는다, **so that** 패키지 간 계약 모순을 식별하기 위해.
5. **As a** PM, **I want to** 런타임 데모 실증 조건이 현재 가장 큰 신뢰 공백으로 기록된 진단을 본다, **so that** 데모 복구 및 증거 기준을 별도로 의사결정하기 위해.

## Constraints

- 산출물 범위는 진단 판정까지만 — .md 정리/jwks→main 머지/plugin build 결정 등 실제 remediation 수행은 포함하지 않음
- 프로젝트는 openclaw plugin / web(client) 라이브러리 / saas 라이브러리 3개 패키지로 구성됨
- 모든 실작업이 main이 아닌 jwks feature 브랜치에 미머지로 쌓여있음(main 대비 약 40,841줄 추가 / 약 27커밋)
- 루트에 AC2~AC6 보고서 .md 9개가 추적된 채로 존재하고 packages/saas에도 AC1~AC3_*.md 중복 존재
- plugin 패키지에는 build 스크립트가 없어 client·saas만 빌드됨
- 조건 1·3·4는 에이전트가 자율 검증 가능(명령 재현, 파일 존재/내용 대조, 계약 비교)
- 헤드리스 캡처 수단(playwright/puppeteer)이 저장소에 없음
- 브라우저↔에이전트 데모가 현재 0개 — examples/live-e2e-chat가 ee89ba3에서 삭제됨(echo-bot이 진짜 OpenClaw가 아니라 아키텍처 오해 유발)

## Success Criteria

1. 조건1(녹색 게이트 3종): typecheck(3패키지 clean) + build(client·saas 통과) + test(731 tests/39 files 전부 통과, 실제 nats-server AC6 device-flow E2E 포함)가 재현 가능하게 통과
2. 조건2(런타임 데모 실증): 실제 브라우저↔에이전트 채팅이 NATS 경유로 최소 1회 도는 것 확인 — 현재 '검증 불가(미충족)'로 판정하고 biggest gap으로 기록
3. 조건3(문서 단일 진실원): STATUS.md 하나가 현재 상태의 단일 출처로 정리됨
4. 조건4(3-패키지 계약 일치): plugin/web/saas의 빌드·의존·인터페이스 계약이 서로 모순 없음, plugin build 스크립트 부재가 의도인지 누락인지 판정 포함
5. 진단 문서가 4개 조건 각각에 대해 통과/불통과 여부와 근거를 명시

## Assumptions

- '뭔가 잘못됐다'는 코드가 깨진 문제가 아니라 '상태를 신뢰할 수 없는' 문제로 추정됨
- 진짜 문제는 '무엇이 깨졌나'가 아니라 '지금 무엇이 진짜 동작 상태인지를 어떻게 신뢰/확정하느냐'로 추정됨
- 조건 1·3·4는 자율 워크플로(에이전트)가 증거를 수집해 판정할 수 있다고 가정
- index-nats.ts↔OpenClaw 에이전트 루프는 코드 seam만 구현된 상태이며 실행 런처/데모 없이 테스트로만 커버됨

## Decide Later

The following items were deferred or identified as premature at this stage. They should be revisited when more context is available:

- 조건 2(런타임 데모 실증)의 '통과' 판정에 인정되는 증거의 형태는 무엇인가요? (a) 사람(PM) 육안 서면 확인, (b) 에이전트 headless 캡처 로그·스크린샷, (c) 검증 불가(decide-later) — 증거 기준 및 데모 복구 여부는 진단 이후 PM이 별도 결정
- AC 보고서 .md 파일 정리(루트 9개 + packages/saas 중복)
- jwks feature 브랜치 → main 머지
- plugin build 스크립트 추가/유지 결정
- 삭제된 브라우저 데모(examples/live-e2e-chat) 복구 여부
- headless 캡처 도구(playwright/puppeteer) 도입

---
*PM ID: pm_seed_interview_20260625_235505*
*Interview ID: interview_20260625_235505*
