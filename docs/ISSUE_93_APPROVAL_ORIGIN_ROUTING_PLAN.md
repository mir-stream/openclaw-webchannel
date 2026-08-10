# Issue #93 — 승인 프롬프트 origin 라우팅 복구 기획서

- 이슈: [#93](https://github.com/mir-stream/openclaw-webchannel/issues/93) (P1 / kind/bug / area/plugin)
- 상류 리포트: rota-crew#284 (Rota 0.4.0 제품 리뷰)
- 브랜치: `mir-stream/issue-93` (base `develop`, 시작 커밋 `2bea2d8`)
- 리포트 기준 커밋 `7164006` 이후 15커밋은 전부 #87/#89 턴-아웃컴 계열과 CI라, 본 이슈가 짚은 코드는 **HEAD에서 한 줄도 변하지 않았다** (2026-08-10 코드 레벨 확인 완료).

---

## 1. 의도 (Intent)

**plugin-kind 승인 요청이 "그 턴을 일으킨 바로 그 peer의 위젯"에 도달해야 한다.**

지금은 `turnSource*`가 전부 null로 들어오는 경로에서 승인 대상이 `web-anon`으로 고정되고, 실제 배포에는 `web-anon` 소켓이 없으므로 프레임이 드롭된다. 결과적으로 **승인 게이트가 걸린 모든 write 툴이 타임아웃으로 실패**한다 — 제품 관점에서 채널이 쓸 수 없는 상태다.

이 변경이 소유하는 표면:
- `packages/plugin/src/approvals.ts` 의 `resolveOriginTarget`
- 그 resolver가 정답을 계산하는 데 필요한 최소한의 주입 배선 (`channel.ts` → `nats-account-runtime.ts`)
- transport(`NatsChannel`)의 "현재 열려 있는 peer 열거" 읽기 전용 접근자

이 변경이 소유하지 **않는** 표면: 승인 UX, exec 승인 정책/approvers 설정, core의 `turnSource*` 생성 로직, 승인 카드 렌더링.

---

## 2. 현상과 증거

상류 리포트의 실측(실 게이트웨이 / 실 NATS / 실 브라우저 등가 클라이언트):

```
[PROBE origin-target] {
  "pluginId":"rota-approval-gate",
  "toolName":"rota__manage_leave",
  "sessionKey":"agent:rota:webchannel:review-agent:direct:d21d9f07-4fcb-48c8-8acb-8fee081c8038",
  "turnSourceChannel":null, "turnSourceTo":null,
  "turnSourceAccountId":null, "turnSourceThreadId":null
}
[webchannel] approval plugin:111e1824-… not delivered:
             no matching open socket for "web-anon" (account "review-agent")
[ws] ⇄ res ✓ plugin.approval.waitDecision 119969ms
```

즉 **정보는 요청 안에 다 들어있다** (`sessionKey`). 우리가 그걸 안 쓰고 있을 뿐이다.

---

## 3. 근본 원인 (현행 코드)

`packages/plugin/src/approvals.ts` (capability 생성부, 약 925–941행):

```ts
resolveOriginTarget: ({ request }) => {
  const src = request.request;
  const channel = src.turnSourceChannel?.toLowerCase();
  if (channel && channel !== WEBCHANNEL_ID) return null;      // (B)
  const to =
    typeof src.turnSourceTo === "string" && src.turnSourceTo.length > 0
      ? src.turnSourceTo
      : ANON_PEER_ID;                                          // (A)
  return { to };
},
```

**결함 A (주)** — `turnSourceTo`가 없으면 `ANON_PEER_ID`(`"web-anon"`, `auth.ts:15`)로 폴백한다. 이 폴백은 "익명 단일 세션 개발 경로"를 위해 쓰인 것인데, 실 배포에서는 존재하지 않는 소켓 키가 되어 전량 드롭된다.

**결함 B (부)** — `turnSourceChannel`이 `null`이면 `if (channel && …)` 가드가 **공허하게 통과**한다. 즉 webchannel이 **출처를 모르는 승인까지 자기 것이라 주장**한다. plugin-kind 요청은 항상 이 상태로 들어오므로, 다른 채널이 일으킨 턴의 승인을 webchannel이 가로챌 수 있는 구조다. (오늘은 A 때문에 어차피 드롭되어 눈에 안 띌 뿐이다.)

왜 `turnSource*`가 비는가 (core 측, 우리가 못 고치는 부분): core의 `before_tool_call` 경로가 `params.ctx?.turnSourceTo`를 그대로 전달하고, 그 값은 `createOpenClawCodingTools`가 `options.currentMessagingTarget ?? options.currentChannelId`로 만든다. 이 채널의 턴에는 둘 다 채워지지 않는다.

---

## 4. 설계

### 4.1 핵심 아이디어 — 파싱이 아니라 **재도출 후 대조**

`sessionKey`는 우리가 만든 키다. `inbound.ts:166`에서 `wsKey = peerId || ANON_PEER_ID`가 정해지고, `inbound.ts:273`이 `resolveWebchannelSessionRoute(api, accountId, wsKey)`로 세션키를 만든다 (`session-route.ts`, 강제 스코프 `per-account-channel-peer`). 그리고 **그 `wsKey`가 곧 transport 소켓맵 키다**.

따라서 정답 peer는 다음으로 구한다:

```
현재 이 account에 열려 있는 peer p 각각에 대해
  resolveWebchannelSessionRoute(api, accountId, p).sessionKey === request.sessionKey
가 성립하는 p
```

**문자열 파싱을 하지 않는다.** 그 이유가 이 설계의 핵심이고, 상류 이슈의 제안(“세션키를 역파싱”)보다 이쪽을 택한 근거다:

1. **`identityLinks` 문제.** `session-route.ts:100`은 `api.config.session?.identityLinks`를 넘겨 키를 만든다. 링크가 설정된 배포에서는 세션키의 peer 세그먼트가 **소켓 키가 아니라 정규화된 identity**일 수 있다. 역파싱은 그 경우 존재하지 않는 소켓 키를 뱉는다(=지금과 똑같이 드롭). 재도출-대조는 같은 함수를 통과시키므로 **구조적으로 항상 맞는다**.
2. **구분자 안전성.** peerId에 `:`가 들어가도 파싱 규칙을 고민할 필요가 없다.
3. **결함 B가 공짜로 닫힌다.** 다른 채널의 세션키는 `resolveWebchannelSessionRoute`가 만들어낼 수 없는 문자열이므로 어떤 peer와도 매칭되지 않는다 → `null` 반환 → webchannel이 남의 승인을 주장하지 않는다. **별도의 채널 가드 문자열 검사를 추가하지 말 것.** (기존 `turnSourceChannel !== WEBCHANNEL_ID` 조기 반환은 그대로 둔다 — 값이 있을 때는 여전히 유효한 빠른 배제다.)
4. **익명 경로가 특례 없이 포함된다.** 익명 세션도 `wsKey = "web-anon"`으로 같은 경로를 타므로, `web-anon` 소켓이 실제로 열려 있으면 열거에서 자연히 매칭된다.

### 4.2 폴백 정책 (fail-closed 방향)

| 상황 | 동작 |
| --- | --- |
| `turnSourceTo`가 비어있지 않음 | 그대로 사용 (현행 유지, 최우선) |
| `sessionKey` 대조로 peer 확정 | 그 peer 반환 |
| 대조 실패 + `web-anon` 소켓이 실제로 열려 있음 | `web-anon` 반환 (익명 개발 경로 보존) |
| 대조 실패 + `web-anon` 소켓 없음 | **`null` 반환** + 진단 로그 1줄 |

마지막 행이 오늘과 달라지는 지점이다. 오늘은 존재하지 않는 대상으로 보내고 조용히 드롭되지만, 앞으로는 “경로를 못 찾았다”가 명시적으로 드러난다. core는 origin 대상이 없으면 승인 없음으로 fail-closed 하므로 **보안 태세는 완화되지 않는다** (승인이 자동 통과되는 경로를 만들지 말 것 — 이건 절대 조건이다).

진단 로그는 `event=webchannel.approval.origin_unresolved accountId=… sessionKey_present=…` 형태의 구조화 1줄로, **sessionKey 원문/peerId 원문을 그대로 찍지 말 것** (기존 `formatAccountIdForLog` 류의 마스킹 관행을 따른다).

### 4.3 배선 (주입)

`resolveOriginTarget`은 SDK에서 `{ cfg, accountId, approvalKind, request }`만 받는다 (`node_modules/openclaw/dist/plugin-sdk/approval-native-helpers-C9ao-3_P.d.ts:98`). 여기에는 `api`도, 열린 peer 목록도 없다. 따라서 **주입 콜백 하나를 추가**한다:

```ts
// approvals.ts
export type ResolveApprovalOriginPeer = (params: {
  cfg: OpenClawConfig;
  accountId: string | null | undefined;
  sessionKey: string;
}) => string | null;

export function createClawApprovalCapability(
  transport: WebChannelPeerChannel,
  resolveAccountTransport?: ResolveAccountTransport,
  resolveOriginPeer?: ResolveApprovalOriginPeer,   // ← 추가 (optional)
)
```

`undefined`면 현행 동작(=`turnSourceTo` → anon 폴백)을 그대로 유지한다. 기존 테스트 7개 호출부(`approvals.test.ts`)가 인자 없이 호출하므로 **optional은 필수**다.

배선 경로 (아래에서 위로 이미 다 존재함, 새 모듈 사이클 없음):

1. `packages/plugin/src/nats-channel.ts` — `NatsChannel`에 읽기 전용 접근자 추가:
   ```ts
   /** 현재 구독(=열린 소켓)이 살아있는 peerId 목록. 진단/라우팅 read-only. */
   listRegisteredPeerIds(): string[] { return [...this.peerSubscriptions.keys()]; }
   ```
   `peerSubscriptions`(`nats-channel.ts:137`)가 `registerPeer`/`unregisterPeer`가 관리하는 진짜 생존 집합이다. **`WebChannelPeerChannel` 인터페이스는 건드리지 않는다** — 이건 전송 표면이 아니라 NATS 구현체의 진단 표면이다.

2. `packages/plugin/src/nats-account-runtime.ts` — resolver 구현 후 `createWebChannelPlugin`에 전달:
   ```ts
   resolveApprovalOriginPeer: ({ cfg, accountId, sessionKey }) => {
     const runtime = accountRuntimes.get(accountId ?? "default");
     const install = accountCoordinator.currentInstall();
     if (!runtime || !install) return null;
     const api = createAccountExecutionApi(install, cfg);   // nats-account-coordinator.ts:573
     for (const peerId of runtime.channel.listRegisteredPeerIds()) {
       if (resolveWebchannelSessionRoute(api as any, runtime.accountId, peerId).sessionKey === sessionKey) {
         return peerId;
       }
     }
     return null;
   },
   ```
   `createAccountExecutionApi(install, cfg)`는 `{ runtime, logger, config, generation }`을 만들며, `resolveWebchannelSessionRoute`가 실제로 읽는 것은 `api.runtime.channel.routing.resolveAgentRoute`와 `api.config.session?.identityLinks` 둘뿐이다 — 필요·충분하다.

3. `packages/plugin/src/channel.ts:143,220` — `opts` 타입에 필드 추가하고 그대로 전달.

### 4.4 성능

열린 peer 수만큼의 `resolveAgentRoute` 호출이 승인 1건당 발생한다. 승인은 사람이 개입하는 저빈도 이벤트고 peer 수는 배포당 수십 규모다. 캐시를 넣지 말 것 — `identityLinks`/binding이 설정 리로드로 바뀔 수 있고, 스테일 캐시는 **잘못된 사람에게 승인 카드를 보내는** 실패 모드가 된다. 정확성 > 마이크로 최적화.

---

## 5. 검토했으나 기각한 대안

| 대안 | 기각 사유 |
| --- | --- |
| 세션키 문자열 역파싱 (상류 이슈 제안) | `identityLinks` 하에서 소켓 키와 다른 값을 뱉을 수 있고, peerId 구분자 가정을 새로 만든다. §4.1 참조 |
| `turnSourceChannel === null`일 때 세션키의 `:webchannel:` 세그먼트로 채널 판정 | 재도출-대조가 같은 판정을 부작용 없이 해준다. 별도 문자열 규칙은 중복이자 표류 위험 |
| core에 `turnSourceTo` 채우기 요청 | 올바른 장기 해법이지만 상류 의존이고, 그 사이 채널은 사용 불가 상태로 남는다. 본 변경은 core가 나중에 채워주면 자동으로 `turnSourceTo` 우선 경로로 되돌아가므로 **상충하지 않는다** |
| `web-anon` 폴백을 무조건 유지 | 이 이슈 그 자체 |
| 모든 열린 peer에 브로드캐스트 | 승인 권한 누설. 절대 불가 |

---

## 6. 구현 계획 (파일별)

1. `packages/plugin/src/nats-channel.ts` — `listRegisteredPeerIds()` 추가 (+ JSDoc: read-only 진단 표면임을 명시).
2. `packages/plugin/src/approvals.ts`
   - `ResolveApprovalOriginPeer` 타입 export.
   - `createClawApprovalCapability`에 3번째 optional 파라미터.
   - `resolveOriginTarget` 재작성: 우선순위 = `turnSourceTo` → resolver → (`web-anon` 소켓 생존 시) anon → `null`.
     - "web-anon 소켓 생존" 판정도 resolver를 통해서 한다 (resolver가 `web-anon`을 열거 결과로 돌려줄 수 있으므로, 별도 조회 API를 새로 만들지 말 것).
   - 기존 주석 블록을 새 계약에 맞게 **다시 쓴다** (이 저장소의 관례상 "왜"를 남긴다. 특히 §4.1의 네 가지 근거와 §4.2의 fail-closed 방향).
3. `packages/plugin/src/channel.ts` — `opts.resolveApprovalOriginPeer` 배선.
4. `packages/plugin/src/nats-account-runtime.ts` — resolver 구현 + 전달.
5. 테스트 (아래 §7).

---

## 7. 테스트 계획 (완료 기준)

`packages/plugin/src/approvals.test.ts`의 기존 `resolveOriginTarget` 블록(210–250행)을 확장한다.

필수 케이스:

| # | 시나리오 | 기대 |
| --- | --- | --- |
| T1 | `turnSourceTo` 존재 | 그 값 그대로 (회귀 방지 — 기존 테스트 유지) |
| T2 | `turnSourceChannel`이 타 채널 | `null` (기존 테스트 유지) |
| T3 | `turnSource*` 전부 null + `sessionKey`가 열린 peer P의 키와 일치 | `{ to: P }` — **이 이슈의 핵심 회귀 테스트** |
| T4 | 전부 null + `sessionKey`가 어떤 peer와도 불일치 + `web-anon` 미개통 | `null` (드롭이 아니라 명시적 미해결) |
| T5 | 전부 null + `sessionKey` 불일치 + `web-anon` 개통 | `{ to: "web-anon" }` (익명 개발 경로 보존) |
| T6 | 전부 null + `sessionKey`가 **타 채널** 세션키 문자열 | `null` (결함 B — webchannel이 주장하지 않음) |
| T7 | resolver 미주입(legacy 2-인자 호출) | 현행 동작 그대로 (하위 호환) |

추가로 `packages/plugin/src/index-nats-wiring.test.ts`에 배선 테스트 1건: 플러그인 생성 시 `resolveApprovalOriginPeer`가 실제로 전달되는지 (배선 누락은 이 클래스의 전형적 사일런트 실패다).

그리고 **통합 성격 1건** — `nats-channel`의 `registerPeer` → `listRegisteredPeerIds` → `unregisterPeer` 후 목록에서 사라짐 (라우팅이 죽은 peer를 고르지 않음을 고정).

게이트:
```bash
npm run build && npm run typecheck && npx vitest run packages/plugin
```
전체 스위트(`npm test`)도 최종 1회. 실패 0이어야 한다.

> ⚠️ 이 worktree는 자체 `node_modules`를 설치해 쓴다 (원본 workspace 심볼릭 링크 아님). 크로스 패키지 게이트를 여기서 돌려도 안전하다.

---

## 8. 리스크 / 함정

1. **`accountId`가 `null`로 들어오는 경우.** SDK가 unscoped 컨텍스트에서 `null`을 줄 수 있다. resolver는 `"default"`로 폴백하되, 매칭 실패 시 조용히 anon으로 넘어가지 말고 §4.2 표를 따를 것.
2. **`currentInstall()`이 `undefined`인 시점.** 계정 리로드/재-warm 창에서 발생 가능. `null` 반환 + 로그. 예외를 던지면 승인 경로 전체가 깨진다 — **resolver는 절대 throw하지 않는다** (내부를 try/catch로 감싸고 실패 시 `null`).
3. **`resolveAgentRoute`가 config 리로드 중 다른 결과를 낼 수 있음.** 승인 1건 내에서 한 번만 호출되므로 문제되지 않으나, 캐싱을 도입하면 문제가 된다 (§4.4).
4. **`web-anon` 특례를 조용히 없애지 말 것.** 익명 단일 세션 개발 경로는 실사용 경로다.
5. **보안 불변식**: 어떤 변경도 "승인 대상을 못 찾았을 때 자동 승인"으로 이어져서는 안 된다. 못 찾으면 승인은 오지 않고 툴은 거부/타임아웃된다 — 그게 옳다.
6. `approvals.ts`는 이미 크고 주석 밀도가 높다. **주변 코드의 주석 밀도와 톤을 맞출 것** (근거 있는 "왜"를 남기는 스타일).

---

## 9. 범위 밖 (발견 시 별도 이슈)

- `execApprovals.approvers` 미설정 시 `Plugin approval unavailable (no approval route)`로 더 앞단에서 실패하는 문제 → 설정 UX 이슈. 본 변경으로 고쳐지지 않으며, 고치려 들지 말 것.
- core가 `turnSource*`를 채우도록 하는 상류 작업.
- 승인 카드의 위젯 렌더링/문구.
- #94(final이 draft를 덮어써 앞 메시지 소실) — 별도 worktree/브랜치.

---

## 10. 완료 정의

- [ ] T1–T7 + 배선 테스트 + peer 생존 테스트 green
- [ ] `npm run build && npm run typecheck && npm test` 실패 0
- [ ] 실제 배포 형상(비-익명 peer)에서 승인 카드가 **요청을 일으킨 그 peer에게** 도착 — 최소한 단위 테스트로 그 경로가 고정되어 있을 것
- [ ] 결함 B(타 채널 승인 주장)가 T6로 고정
- [ ] diff에 `web-anon` 무조건 폴백이 남아있지 않을 것
