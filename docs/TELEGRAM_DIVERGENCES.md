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

### TD-6. issuer가 달라진 저장소는 자동 리셋하지 않고 기동을 거부한다

| | |
| --- | --- |
| Telegram | update offset 상태를 bot ID와 token fingerprint에 결속하고 바뀐 상태를 리셋한다(`extensions/telegram/src/update-offset-store.ts`). |
| WebChannel 목표 결정 | history·대화 키를 유효 JWT issuer에 결속한다. issuer 불일치나 기존 미기록 상태는 해당 계정 기동을 거부하고 doctor에서 보관 후 명시적 초기화를 안내한다. 자동 마이그레이션·삭제는 하지 않는다. |
| 의도 | 같은 `sub`를 쓰는 새 issuer의 사용자가 이전 사용자의 평문 대화·키를 상속하지 못하게 하고, 데이터 보관과 초기화는 운영자가 명시적으로 결정하게 한다. |
| 결정 | 2026-09-30, 프로젝트 오너. 2026-10-02 과제에서 자동 마이그레이션·삭제 금지를 재확인. |
| 구현 상태 (2026-10-02) | #412 구현: tuple별 issuer 메타데이터, 기동 거부와 doctor 안내. 기존 데이터는 운영자 절차가 필요하다. |
| 재검토 | 별도 승인된 issuer 간 데이터 이전 절차를 설계할 때. |
| 관련 | #412, [수동 절차](STORAGE_IDENTITY_V2.md#issuer-binding-412) |

### TD-1. DM 정책 기본값은 `open`이다

| | |
| --- | --- |
| Telegram | 기본 `dmPolicy`는 `pairing`이다. 처음 보는 사용자에게 pairing 코드를 주고, 봇 주인이 승인한다(코어 `zod-schema.channel-messaging-common.ts`의 기본값, `extensions/telegram/src/dm-access.ts`). |
| WebChannel 목표 결정 | 기본값은 `open`이다. `open`·`allowlist`·`disabled`의 의미와 schema 검증은 SDK `DmPolicy`·Telegram을 그대로 따른다. |
| 의도 | Telegram 봇에는 인터넷의 누구나 DM할 수 있으므로 닫힌 기본값이 필요하다. WebChannel에는 SaaS가 해당 계정(JWT `aud`)용 토큰을 발급한 사용자만 닿는다. **SaaS의 JWT 발급이 pairing 승인에 해당한다.** 같은 일을 두 번 심사하지 않는다. |
| 결정 | 2026-09-30, 프로젝트 오너 |
| 재검토 | SaaS 밖의 주체가 이 계정 JWT를 얻을 수 있게 되는 경우. 또는 tenant 매니저 권한 API(TD-2)가 도입되는 경우. |
| 구현 상태 (2026-10-02) | 기본 `open` 동작은 있다. SDK `dmPolicy` 의미·schema 정합화는 #406에서 대기 중이다. |
| 관련 | #406 |

### TD-2. 입장한 모든 peer를 명령 권한이 있는 sender로 인정한다

| | |
| --- | --- |
| Telegram | DM allowlist(봇 주인 계열)에 든 sender에게만 명령 권한을 준다(`extensions/telegram/src/bot-message-context.body.ts`). |
| WebChannel 목표 결정 | DM 정책으로 입장이 허용된 peer에는 플러그인이 command-authorized stamp를 부여한다. 코어의 `commands.allowFrom`·`ownerAllowFrom`과 명령·도구별 정책은 그대로 적용한다. |
| 의도 | 지금은 권한을 나눌 수단이 없다. 그 상태에서 명령을 막으면 코어가 아무 응답 없이 버리는 결함이 생긴다. 권한 분리는 클라이언트 설정이 아니라 **서버 측에서 설정**해야 하는 문제다. 나중에 tenant 매니저 권한으로 서버가 명령 권한을 설정하는 API를 제공할 예정이며, 그때까지는 입장한 모든 peer에 plugin stamp를 부여한다. |
| 결정 | 2026-09-30, 프로젝트 오너 |
| 결과 | 명령 권한이 있는 sender로 인정되므로, 코어는 그 peer의 인라인 지시(`/think`, `/model` 등)와 세션 reasoning 상태도 존중한다. `/exec`, `/verbose`, `/reasoning`, `/model`의 세션 기본값은 peer별 세션에 저장된다. 실제 명령·도구 효과의 허용 범위는 코어의 allowlist와 각 명령·도구 정책이 결정한다. |
| 재검토 | tenant 매니저 권한 API를 도입할 때. 비용·설정에 영향을 주는 명령을 일반 사용자에게 막아야 하는 배포가 생길 때. |
| 구현 상태 (2026-10-02) | 권한 stamp 변경은 PR #420에서 대기 중이다. pinned SDK `2026.7.1-2`의 코어 계약을 추적한 `packages/plugin/src/command-gate.ts` 문서와 PR #420 본문을 근거로 한다. |
| 관련 | #407, [PR #420](https://github.com/mir-stream/openclaw-webchannel/pull/420) |

### TD-3. 빈 응답은 가짜 메시지가 아니라 실패 상태로 알린다

| | |
| --- | --- |
| Telegram | 코어가 fallback 대상으로 판정한 turn에 전달된 응답이 없으면 "No response generated. Please try again."을 봇 메시지로 보낸다(OpenClaw `54257e02001`의 `extensions/telegram/src/bot-message-dispatch.ts:449-458`). |
| WebChannel 목표 결정 | 해당 turn을 실패 상태(cause `empty`)로 마감한다. 클라이언트는 실패 표시와 재시도를 보여 준다. 플러그인은 대화 원장에 agent 메시지를 만들지 않는다. 다만 코어가 직접 만든 빈 응답 안내(interactive DM에서 모델 출력이 완전히 비었을 때 코어가 생성하는 isError 페이로드)는 코어의 응답으로 보고 그대로 전달한다. 텍스트 매칭으로 재분류하지 않는다. |
| 의도 | Telegram 봇은 앱 UI를 제어할 수 없어서 상태를 텍스트로 전할 수밖에 없다. WebChannel은 앱(클라이언트)도 우리가 만든다. 그러니 사실은 상태로 전달하고, 에이전트가 말하지 않은 내용을 원장에 쓰지 않는다. |
| 결정 | 2026-09-30, 프로젝트 오너 |
| 재검토 | 클라이언트가 아닌 제3자 앱이 상태 프레임 없이 텍스트만 소비해야 하는 경우. |
| 관련 | #404 ([오너 정정 1](https://github.com/mir-stream/openclaw-webchannel/issues/404#issuecomment-5924069816), [오너 정정 2](https://github.com/mir-stream/openclaw-webchannel/issues/404#issuecomment-5926887447)) |
| 구현 상태 (2026-10-02) | **구현 보류(2026-10-01, 오너 확정).** pinned SDK `2026.7.1-2`의 `noVisibleReplyFallbackEligible`이 queued/follow-up, message-tool 전달, continuation, 의도적 silence를 구분하기에는 거칠다. SDK를 올릴 때 재개한다. 작업은 브랜치 `wip/c3-empty-turn-404`에 있다. 결정 자체는 유효하다. |

### TD-4. 평문 단어로는 실행을 중단하지 않는다

| | |
| --- | --- |
| Telegram | `/stop` 외에도 평문 abort 단어와 일부 명령이 대기 입력을 비우고 실행을 중단한다(`extensions/telegram/src/telegram-ingress-supersede.ts`). |
| WebChannel 목표 결정 | 명시적인 `/stop`(Stop 버튼)만 중단과 대기 입력 취소를 수행한다. `/stop`은 서버가 아직 받지 않은 이전 입력까지 취소하고, 해당 말풍선은 "취소됨"으로 남긴다. |
| 의도 | Telegram은 입력창 외에 중단 수단이 없다. WebChannel 앱에는 항상 Stop 버튼이 있다. 평문 단어 매칭은 사용자가 "멈춰"라는 말을 본문으로 쓸 때 오작동한다. |
| 결정 | 2026-09-30, 프로젝트 오너 |
| 재검토 | Stop 버튼이 없는 소비 앱을 공식 지원하게 될 때. |
| 구현 상태 (2026-10-02) | 평문 abort 단어로 중단하지 않는 동작은 구현돼 있다. 서버가 아직 수락하지 않은 이전 입력까지 취소하는 동작은 PR #424에서 대기 중이다. |
| 관련 | #398, [PR #424](https://github.com/mir-stream/openclaw-webchannel/pull/424) |

### TD-5. 승인 결정이 거부되면 그 사유를 결정한 기기에 알린다

| | |
| --- | --- |
| Telegram | 승인 권한이 없는 sender가 승인 버튼을 누르면 서버 로그만 남긴다. 사용자에게는 사유를 보여 주지 않고 버튼을 그대로 둔다(`extensions/telegram/src/approval-*.ts`, callback query 처리). |
| WebChannel 목표 결정 | 플러그인이 결정을 거부하면 비영속 프레임 `approval_decision_rejected {id, decision, reason}`을 보낸다. 사유는 `not-approver`와 `not-pending`이다. 같은 계정에 살아 있는 승인을 권한 없는 sender가 결정하면 `not-approver`로 응답한다. 다른 계정에 살아 있는 승인 ID는 없거나 종료된 ID와 같이 `not-pending`으로 응답한다. 클라이언트는 자기 미확정 추측인 카드만 되돌리고 사유를 표시한다. |
| 의도 | 승인 결과는 서버가 확정하는 사실이고, 우리는 앱도 함께 만든다(TD-3과 같은 원칙). 사유 없이 버튼만 남으면 사용자는 결정이 적용됐는지 알 수 없다. 같은 계정 안에서는 권한 문제를 알려 주되, 다른 계정의 승인 ID가 현재 살아 있는지는 없는 ID나 종료된 ID와 구별할 수 없게 해 노출 정보를 최소화한다. |
| 결정 | 2026-10-01, 프로젝트 오너. 2026-10-02, 프로젝트 오너 정정: 최초 결정의 cross-account `not-approver` 합침을 `not-pending` 합침으로 바꿨다. |
| 재검토 | 사유 노출이 권한 구조 탐색에 쓰일 수 있다는 근거가 생길 때. |
| 구현 상태 (2026-10-02) | 거부 프레임과 정정된 cross-account 사유 매핑은 PR #421에서 구현 중이다. 아직 `develop`에 병합되지 않았다. |
| 관련 | #400, [PR #421](https://github.com/mir-stream/openclaw-webchannel/pull/421) |

### TD-A5. 입장 정책 거부는 수락 전 요청 상태로 알린다

| | |
| --- | --- |
| Telegram | 앱의 메시지는 Telegram 서버가 수락하고, 봇 플러그인은 별도 sender 정책으로 실행을 차단한다. 로컬 레퍼런스 `extensions/telegram/src/bot-message-context.ts`의 `resolveTelegramDmAllow`/DM policy gate 참조. |
| WebChannel 목표 결정 | 플러그인이 서버 역할도 소유하므로 새 입력은 수락·broadcast 전에 거부한다. 해당 요청 ID에 `inbound_rejected{reason:"policy-denied"}`를 보내며 allowlist 내용·상세 이유는 공개하지 않는다. client는 자동 재시도 없이 일반적인 정책 거부를 표시한다. |
| 의도 | 실행할 권한이 없는 새 입력을 수락한 대화 행으로 만들지 않고, 사용자는 요청이 거부됐다는 사실을 알 수 있게 한다. 가짜 agent 메시지로 상태를 대체하지 않는다. |
| 결정 | 2026-10-02, 프로젝트 오너. 2026-10-03 재개 지시로 재확인. |
| 구현 상태 (2026-10-03) | 일반/제어 입력 앞의 gate, 암호화·크기 제한을 지키는 결과 프레임, client의 상관된 terminal send 상태 및 데모 안내로 구현. 이미 확정된 수락·취소·stop·convergence 영수증은 정책 변경 후에도 그대로 응답한다. 거부 자체는 새 durable 대화 행이나 영구 tombstone이 아니다. |
| 재검토 | 서버 입장 정책과 실행 시점 권한 정책을 분리하는 제품 요구가 생길 때. |
| 관련 | #442, #415 A5, #406, protocol 7 |

### TD-E7. 브라우저 bootstrap JWT는 최대 1시간으로 제한한다

| | |
| --- | --- |
| Telegram | 플러그인은 Bot API bot token을 사용하며, 브라우저 기기마다 SaaS bootstrap JWT의 `iat`/`exp`를 검증하는 단계가 없다(레퍼런스 `extensions/telegram/src/channel.ts`의 account/token 경로). |
| WebChannel 목표 결정 | RS256 bootstrap JWT의 `iat`를 필수로 하고 `0 < exp−iat ≤ 3600초`를 검증한다. 미래 발급/만료의 clock skew는 수명 상한과 별도로 검사한다. SaaS builder·signer도 같은 상한을 지킨다. |
| 의도 | 기기 등록에 쓰는 bearer 토큰의 노출 시간을 제한하고, 발급 시각을 모르는 토큰이나 무제한 수명을 허용하지 않는다. |
| 결정 | 2026-10-02, 프로젝트 오너가 #415 제품 선택지 권장안 승인. |
| 구현 상태 (2026-10-03) | #447 별도 PR에서 구현. 데모·레퍼런스·예제는 기존 5분 기본값을 유지한다. NATS 자체 credentials는 별도 계약이다. |
| 재검토 | 신뢰하는 외부 IdP가 이 수명 계약을 지원하지 못하거나 다른 기기 등록 계약이 필요할 때. |
| 관련 | #415 E7, #447 |

### TD-F7. 클라이언트 교체 뒤 held 입력은 수동 복원하는 메모리 초안으로 남긴다

| | |
| --- | --- |
| Telegram | 앱의 전송 대기 메시지는 서버 수락 전에도 앱이 소유한다. 앱은 대기 메시지를 로컬에 저장해 재시작 뒤에도 유지하고, 재연결되면 **자동으로 다시 보낸다**. 입력창 초안은 채팅별로 클라우드에 동기화된다. 봇 플러그인은 아직 전송되지 않은 입력의 보존을 담당하지 않는다. |
| WebChannel 목표 결정 | 데모 앱은 같은 로그인·계정의 탭 전환, 재인증, BFCache 동안 미전송 입력을 메모리에 보존하고 “Not sent · connection replaced”와 복원/삭제 동작을 표시한다. 새 client에 자동 재전송하지 않는다. 로그아웃·사용자/tenant 변경·권한 회수 때 제거한다. reload 영속화는 #368에 남긴다. |
| 의도 | 사용자가 작성한 미전송 텍스트를 잃지 않으면서, 연결 교체가 새로운 전송 의도로 해석되지 않게 한다. 그래서 Telegram과 달리 자동 재전송하지 않고 메모리에만 두며 사용자가 직접 복원한다(다른 로그인·계정으로의 교체가 섞일 수 있는 웹 위젯에서 자동 재전송은 의도하지 않은 발신이 된다). 이미 전송된 요청은 미전송으로 표시하지 않는다. |
| 결정 | 2026-10-02, 프로젝트 오너. 2026-10-03 재개 지시로 재확인. |
| 구현 상태 (2026-10-03) | 로그인 shell의 계정별 메모리와 inert 복원 UI로 구현. 실제 client/암호화 경로의 재인증 및 DOM의 탭/BFCache/로그아웃 회귀 검증. |
| 재검토 | #368의 영속 outbox 및 명시적 재전송 계약을 설계할 때. |
| 관련 | #395, #415 F7, #368 |
