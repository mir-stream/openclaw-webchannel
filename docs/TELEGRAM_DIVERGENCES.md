# Telegram 차이 원장

WebChannel의 대원칙은 **“우리 플러그인 = Telegram 서버 + Telegram 플러그인,
우리 클라이언트 = Telegram 앱”**이다. 기본값은 Telegram(`../openclaw/extensions/telegram`)과
Telegram Bot API/MTProto 계약을 그대로 따르는 것이다.

이 문서는 그 기본값에서 **의도적으로 벗어난 결정만** 기록한다. 각 항목에 무엇이 다른지와 함께
**왜 그 차이를 받아들였는지**를 남긴다. 이유가 사라지면 그 차이도 다시 검토해야 하기 때문이다.

## 규칙

- Telegram과 다르게 동작하는 결정을 새로 할 때는 같은 PR에서 이 원장에 항목을 추가한다.
  기록하지 않은 차이는 버그로 본다.
- 항목에는 다음을 적는다.
  - Telegram의 동작과 근거 위치
  - 우리 동작
  - 의도
  - 결정일·결정자
  - 재검토 조건
  - 관련 이슈
- 아직 구현하지 않은 기능은 차이가 아니다. 그런 미지원 범위는 [`STATUS.md`](STATUS.md)에서 관리한다.
  이 원장에는 "그렇게 만들지 않기로 한 것"만 넣는다.
- 항목을 폐기할 때는 지우지 않는다. 상태를 `폐기`로 바꾸고 날짜와 사유를 남긴다.

## 항목

### TD-1. DM 정책 기본값은 `open`이다

| | |
| --- | --- |
| Telegram | 기본 `dmPolicy`는 `pairing`이다. 처음 보는 사용자에게 pairing 코드를 주고, 봇 주인이 승인한다(코어 `zod-schema.channel-messaging-common.ts`의 기본값, `extensions/telegram/src/dm-access.ts`). |
| WebChannel | 기본값은 `open`이다. `open`·`allowlist`·`disabled`의 의미와 schema 검증은 SDK `DmPolicy`·Telegram을 그대로 따른다. |
| 의도 | Telegram 봇에는 인터넷의 누구나 DM할 수 있으므로 닫힌 기본값이 필요하다. WebChannel에는 SaaS가 해당 계정(JWT `aud`)용 토큰을 발급한 사용자만 닿는다. **SaaS의 JWT 발급이 pairing 승인에 해당한다.** 같은 일을 두 번 심사하지 않는다. |
| 결정 | 2026-09-30, 프로젝트 오너 |
| 재검토 | SaaS 밖의 주체가 이 계정 JWT를 얻을 수 있게 되는 경우. 또는 tenant 매니저 권한 API(TD-2)가 도입되는 경우. |
| 관련 | #406 |

### TD-2. 입장한 모든 peer가 모든 명령을 쓸 수 있다

| | |
| --- | --- |
| Telegram | DM allowlist(봇 주인 계열)에 든 sender에게만 명령 권한을 준다(`extensions/telegram/src/bot-message-context.body.ts`). |
| WebChannel | DM 정책으로 입장이 허용된 peer는 `/new`, `/reset`, `/model` 등 등록된 명령을 모두 쓸 수 있다. |
| 의도 | 지금은 권한을 나눌 수단이 없다. 그 상태에서 명령을 막으면 코어가 아무 응답 없이 버리는 결함이 생긴다. 권한 분리는 클라이언트 설정이 아니라 **서버 측에서 설정**해야 하는 문제다. 나중에 tenant 매니저 권한으로 서버가 명령 권한을 설정하는 API를 제공할 예정이며, 그때까지는 전부 개방한다. |
| 결정 | 2026-09-30, 프로젝트 오너 |
| 결과 | 명령 권한이 있는 sender로 인정되므로, 코어는 그 peer의 인라인 지시(`/think`, `/model` 등)와 세션 reasoning 상태도 존중한다. |
| 재검토 | tenant 매니저 권한 API를 도입할 때. 비용·설정에 영향을 주는 명령을 일반 사용자에게 막아야 하는 배포가 생길 때. |
| 관련 | #407 |

### TD-3. 빈 응답은 가짜 메시지가 아니라 실패 상태로 알린다

| | |
| --- | --- |
| Telegram | 최종 응답이 없으면 "No response generated. Please try again."을 봇 메시지로 보낸다(`extensions/telegram/src/bot-message-dispatch.ts`). |
| WebChannel | 해당 turn을 실패 상태(cause `empty`)로 마감한다. 클라이언트는 실패 표시와 재시도를 보여 준다. 플러그인은 대화 원장에 agent 메시지를 만들지 않는다. 다만 코어가 직접 만든 빈 응답 안내(interactive DM에서 모델 출력이 완전히 비었을 때 코어가 생성하는 isError 페이로드)는 코어의 응답으로 보고 그대로 전달한다. 텍스트 매칭으로 재분류하지 않는다. |
| 의도 | Telegram 봇은 앱 UI를 제어할 수 없어서 상태를 텍스트로 전할 수밖에 없다. WebChannel은 앱(클라이언트)도 우리가 만든다. 그러니 사실은 상태로 전달하고, 에이전트가 말하지 않은 내용을 원장에 쓰지 않는다. |
| 결정 | 2026-09-30, 프로젝트 오너 |
| 재검토 | 클라이언트가 아닌 제3자 앱이 상태 프레임 없이 텍스트만 소비해야 하는 경우. |
| 관련 | #404 |

### TD-4. 평문 단어로는 실행을 중단하지 않는다

| | |
| --- | --- |
| Telegram | `/stop` 외에도 평문 abort 단어와 일부 명령이 대기 입력을 비우고 실행을 중단한다(`extensions/telegram/src/telegram-ingress-supersede.ts`). |
| WebChannel | 명시적인 `/stop`(Stop 버튼)만 중단과 대기 입력 취소를 수행한다. `/stop`은 서버가 아직 받지 않은 이전 입력까지 취소하고, 해당 말풍선은 "취소됨"으로 남긴다. |
| 의도 | Telegram은 입력창 외에 중단 수단이 없다. WebChannel 앱에는 항상 Stop 버튼이 있다. 평문 단어 매칭은 사용자가 "멈춰"라는 말을 본문으로 쓸 때 오작동한다. |
| 결정 | 2026-09-30, 프로젝트 오너 |
| 재검토 | Stop 버튼이 없는 소비 앱을 공식 지원하게 될 때. |
| 관련 | #398 |
