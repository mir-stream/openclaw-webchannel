# Telegram 차이 원장

WebChannel의 대원칙은 **“우리 플러그인 = Telegram 서버 + Telegram 플러그인,
우리 클라이언트 = Telegram 앱”**이다. 기본값은 Telegram(`../openclaw/extensions/telegram`)과
Telegram Bot API/MTProto 계약을 그대로 따르는 것이다.

이 문서는 그 기본값에서 **의도적으로 벗어나기로 승인한 목표 결정만** 기록한다. 각 항목에 무엇이
달라야 하는지와 함께 **왜 그 차이를 받아들였는지**를 남긴다. 이유가 사라지면 그 차이도 다시
검토해야 하기 때문이다. 목표 결정과 현재 구현은 별개이며, 구현 상태는 각 항목에 따로 적는다.

## 규칙

- Telegram과 다르게 동작하는 결정을 새로 할 때는 같은 PR에서 이 원장에 항목을 추가한다.
  기록하지 않은 차이는 버그로 본다.
- 항목에는 다음을 적는다.
  - Telegram의 동작과 근거 위치
  - 우리 동작
  - 의도
  - 결정일·결정자
  - 구현 상태·확인일
  - 재검토 조건
  - 관련 이슈
- 지원하지 않는 기능이라는 사실만으로는 의도적인 차이가 아니다. 그런 미지원 범위는
  [`STATUS.md`](STATUS.md)에서 관리한다. 다만 오너가 Telegram과 다른 목표를 승인했다면 구현 전에도
  원장에 기록하고, 현재 구현 상태를 명시한다.
- 항목을 폐기할 때는 지우지 않는다. 상태를 `폐기`로 바꾸고 날짜와 사유를 남긴다.

아래 구현 상태는 2026-10-02 기준 `develop` `732ef8b`의 코드와 각 후속 PR을 대조한 기록이다.
상태 표기는 이 문서 PR이 런타임 동작을 바꾼다는 뜻이 아니다.

## 항목

### TD-6. CLI 발신은 실행 중인 gateway를 경유한다

| | |
| --- | --- |
| Telegram | `extensions/telegram/src/outbound-adapter.ts`는 `deliveryMode: "direct"`로 Bot API를 호출한다. CLI 프로세스에서도 Telegram 서버에 전달할 수 있다. |
| WebChannel | 서버 역할을 맡은 gateway에 CLI 발신을 `webchannel.send` RPC로 넘긴다. serving gateway의 agent·cron 발신은 `deliveryMode: "direct"`를 유지한다. |
| 의도 | 계정 NATS 연결·대화 키·원장과 core transcript 기록을 실제 serving gateway가 소유한다. CLI에 별도 런타임을 만들지 않는다. |
| 결정 | #418 작업 지시 및 2026-10-04 오너 결정에 따라 upstream 수정 없이 플러그인에서 handoff를 구현한다. |
| 구현 | CLI가 선택한 정확한 account ID와 tenant/store를 고정한다. gateway는 실제 serving tuple과 다르면 거부하고 자신의 설정으로 transcript 세션을 계산한다. CLI session key를 받지 않으며 CLI transcript도 생성하지 않는다. durable payload의 tuple을 전송 직전에 재검사한다. |
| 검증 | `outbound-gateway.test.ts`: CLI/gateway 설정·기본 계정·serving tuple 차이, 실제 transcript, 런타임 교체, CLI/agent/cron, 중복 RPC 및 오류를 검증한다. gateway socket과 NATS publish는 테스트 대역이며 암호화·SQLite·pinned core action/durable-send 경로는 실제 구현이다. |
| 배포 | CLI와 gateway 플러그인을 함께 갱신하고 gateway를 재시작한다. 기존 gateway에 전용 RPC가 없으면 발신은 거부된다. |
| 제한 | 원격 CLI의 로컬 키 저장소 요구(#451), 오프라인 peer 전달은 그대로다. RPC 중복 억제는 현재 handler의 10분/1,000건 메모리 캐시이며 재시작을 넘는 outbox가 아니다. |
| 관련 | #418, #457, [PR #430](https://github.com/mir-stream/openclaw-webchannel/pull/430) |
