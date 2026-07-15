# P0-1 구현 계획 — Gateway direct WebSocket 완전 삭제

> 근거 리뷰: [P0.md § P0-1](./P0.md) · 작성: 2026-07-15 · 상태: **CONVERGED v4**
> (codex gpt-5.6-sol 적대리뷰 4라운드: 8→10→1→0 material findings)
> 브랜치: `feat/p0-1-gateway-ws-removal` (base: `review`)
>
> 개정 이력:
> - v2: codex(gpt-5.6-sol) R1 적대리뷰 8건 반영 — 의존관계 지도 완성(setup-entry 포함),
>   verifier 대체 전략 신설, D2 뒤집음(sendTextToAnyOpen 삭제), ticketParam migration,
>   테스트 분류표, T3 2계층화, tarball 서술 정정, 릴리즈 계약 명시.
> - v3.1: codex R3 1건 반영 — Stage 2 step 4를 D4(deprecated-accepted 유지)와 정합화.
> - v3: codex R2 10건 반영 — D4 schema-validation 순서 문제(deprecated 유지+detector),
>   CI 712-test floor 관리 신설, approvals decision 역경로 커버리지 공백 정정(신규 직접
>   테스트), client 타입 trim 정밀화, T3a를 source guard로 하향, D2 사실주장 축소+테스트
>   4종, D5 "pure assert" 표현 정정(cache-init 의미론), T4 allowlist 정밀화+package
>   metadata 정리, Stage 1 호환 re-export 명시.

## 1. 의도

Gateway가 browser용 WebSocket endpoint(`/webchannel/ws`, `?ticket=` upgrade)를 여는 것은
zero-inbound 전제와 충돌한다. deprecated 유지가 아니라 **코드·공개 API·문서에서 삭제**한다.
NATS transport가 내부적으로 WebSocket(`ws` 패키지)을 쓰는 것은 별개이며 유지한다
(`packages/plugin/src/nats-transport.ts:23`이 `ws`를 import — dependency 유지 확정).

**이 변경 후 성립해야 하는 invariant**: gateway boot 이후 browser-facing inbound
listener/route가 하나도 등록되지 않는다. 유일한 browser 경로는 NATS relay 경유 E2E다.

## 2. 비범위 (scope guard)

- **P0-2** auto-admission / unauthenticated handshake 삭제 — manifest의 `nats.admission`,
  `nats.devOpen`, `credentials.mode:"open"`, `auth.strategy` enum(`"anonymous"` 포함)은
  그대로 둔다. 단 P0-1이 도입하는 **removed-config 감지기**(§4 D4)는 P0-2가 재사용할
  공용 seam으로 설계한다.
- **P0-4** 전송 결과 계약 — receipt/state 모델, synthetic messageId 제거는 P0-4.
  단 `sendTextToAnyOpen` **삭제 자체는 P0-1 범위다** (§4 D2, v2에서 변경).
- 문서 전면 재작성(P3-x) — 현재형 문서의 Gateway-WS 지원 서술만 제거, 역사 문서는 archive 표기.
- 릴리즈 실행 자체는 별도 (D3은 릴리즈 노트/버전 계약만 정의).

## 3. 사전 조사 결과 (2026-07-15, 코드 직접 확인 + codex R1 교차검증)

### 3.1 삭제 대상 (production 코드)

| 파일 | 내용 |
|---|---|
| `packages/plugin/index.ts` (225L) | legacy Gateway-WS entry: `registerFull`, `registerHttpRoute` + `transport.handleUpgrade` 배선 |
| `packages/plugin/src/transport.ts` (768L) | `WebChannelTransport`: WS 소켓맵, `safeSend` backpressure, `soleOpenSocket`, `?ticket=` upgrade |
| `packages/plugin/src/transport.test.ts` | 위 클래스 테스트 |
| `packages/client/src/client.ts` (540L) | `WebChannelClient` (WS + `?ticket=` carrier) |
| `packages/client/src/client.test.ts` | 위 클래스 테스트 |
| `smoke/` 전체 (7 스크립트) | 전부 gateway-WS 대상 — NATS smoke는 `e2e/`/`scripts/pack-load-smoke.sh`에 별도 존재 |
| `auth.ts` 내 WS verifier 표면 | `ConnectionVerifier`, `resolveVerifier`, `makeAnonymousVerifier`, `makeJwtVerifier`, `readQueryParam`, `ticketParam` (§3.3/D5로 대체) |

Packaging 사실관계 (정정): tarball `files`는 `dist`, `index-nats.ts`, `setup-entry.ts`,
`openclaw.plugin.json`, `README.md`를 **의도적으로** 포함한다. NATS-only인 것은
`openclaw.extensions`(`["./dist/index-nats.js"]`)와 `setupEntry`(`./dist/setup-entry.js`)다.
`index.ts`/`src/transport.ts`는 tarball에 없다 — 단 guard 테스트가 없으므로 T2로 고정한다.

### 3.2 `transport.ts` 의존관계 전체 지도 (non-test production, rg 검증 완료)

| 소비자 | 가져가는 것 | 처리 |
|---|---|---|
| `setup-entry.ts:3,13` | **`WebChannelTransport` 인스턴스화** — setup-safe 검사용 outbound adapter shape. **출하 entry** (`openclaw.setupEntry` → `dist/setup-entry.js`) | 신규 setup-safe no-op `WebChannelPeerChannel` 구현으로 교체 (§4 D1) |
| `index-nats.ts:55` | `WEBCHANNEL_ID`, `type WebChannelTransport` (cast 3곳: L231, L605, L790) | contract로 교체, cast 제거 |
| `src/inbound.ts:3-4` | `WEBCHANNEL_ID`, `ANON_PEER_ID`, `type WebChannelTransport`, `type InboundWsMessage` | contract로 교체 |
| `src/channel.ts:7-8` | `WEBCHANNEL_ID`, `type WebChannelTransport` | contract로 교체 |
| `src/message-adapter.ts:22-23` | `WEBCHANNEL_ID`, `type WebChannelTransport` | contract로 교체 |
| `src/approvals.ts:73-79` | `WEBCHANNEL_ID`, `ANON_PEER_ID`, `type {WebChannelTransport, ApprovalDecision, ApprovalOption, ApprovalRequestPayload}` (+`ResolveAccountTransport` 반환 타입) | contract로 교체 |
| `src/control-lane.ts:26` | `type InboundWsMessage` | contract로 교체 |
| `src/approval-e2e-crypto.ts:57` | `type {ApprovalRequestPayload, ApprovalDecision}` | contract로 교체 |
| `src/nats-channel.ts:20` | `type {ApprovalDecision, ApprovalRequestPayload}` (+frame 타입 중복 정의) | contract가 canonical, re-export |
| `src/setup.ts:54`, `src/setup-wizard.ts:42`, `src/session-route.ts:55` | `WEBCHANNEL_ID`만 | contract로 교체 |
| `index.ts:19-20` | class + `InboundWsMessage` | 파일째 삭제 |

`ANON_PEER_ID` canonical 정의는 `auth.ts`(transport는 re-export만).
`InboundWsMessage`/`OutboundWsMessage`/`HistoryMessage`는 transport.ts/nats-channel.ts 중복
정의 → contract로 단일화.

### 3.3 verifier 표면의 실제 상태 (v2 정정 — "미참조면 삭제"는 성립 안 함)

`index-nats.ts:45`가 `resolveVerifier`/`ConnectionVerifier`를 import하고, register-hop
계정에 대해 `resolveVerifier(accountAuth, api.logger)`를 호출한다(≈L947). 용도는 **HTTP
upgrade 검증이 아니라 config fail-loud 검증**이다: `AccountRuntime.verifier`(≈L95-102)
주석이 명시하듯 register hop의 실제 JWT 검증은 `verifyJwtAndExtractIdentity`(≈L1002-1008)가
수행하고, verifier는 "register-hop 계정의 auth misconfig를 boot 시점에 시끄럽게 실패"시키는
역할만 남아 있다. 그런데 `makeJwtVerifier`(auth.ts:243-270)는 `?ticket=` query 캐리어를
포함한다 — 그대로 두면 완료 조건("`?ticket=` production symbol 0개") 위반.

**대체 설계 (D5)**: `resolveVerifier` 호출부를 HTTP-request 개념이 없는
`assertJwtAuthConfig(accountAuth)` (가칭, auth.ts에 신설)로 교체한다. 이 함수는
`makeJwtVerifier`의 config 검증 부분(strategy/issuer/audience 필수, JWKS 소스 정확히 1개 —
`jwksCacheFor`/`JWKSCache.create` 재사용)만 수행하고 request-파싱 closure를 만들지 않는다.
이후 `ConnectionVerifier`/`resolveVerifier`/`makeAnonymousVerifier`/`makeJwtVerifier`/
`readQueryParam`/`ticketParam`을 삭제한다. 유지: `verifyJwtAndExtractIdentity`,
`preflightResolveJwks`, `verifyJwt`, JWKS 캐시, `SecretRef`, `ANON_PEER_ID`, JWT 타입.
`AccountRuntime.verifier` 필드는 제거(검증은 boot-시점 assert로 charge가 옮겨감).

### 3.4 유지 대상

- `packages/client/src/nats-client*.ts`, `pop-register.ts`, `saas-bootstrap.ts` 등 NATS 경로 전부.
- plugin `package.json`의 `ws` dependency (nats-transport 사용).
- `auth.ts`의 JWT/JWKS 검증 코어 (§3.3 유지 목록).

## 4. 설계 결정

### D1. 공유 계약 모듈: `packages/plugin/src/channel-contract.ts` (신규)

```ts
export const WEBCHANNEL_ID = "webchannel";          // transport.ts에서 이동
export { ANON_PEER_ID } from "./auth.js";            // canonical home 유지, 편의 re-export
export type ApprovalDecision = ...;                  // transport.ts에서 이동
export type ApprovalOption = ...;
export type ApprovalRequestPayload = ...;
export type InboundWsMessage = ...;                  // 중복 정의 단일화
export type OutboundWsMessage = ...;
export type HistoryMessage = ...;

/** NATS production path가 사용하는 outbound peer-channel 계약. */
export interface WebChannelPeerChannel {
  sendText(peerId: string, text: string, id?: string, turnId?: string): boolean;
  sendProgress(peerId: string, id: string, text: string, turnId?: string): boolean;
  finalizeDraft(peerId: string, id: string, text: string, turnId?: string): boolean;
  sendReasoning(peerId: string, id: string, turnId: string, text: string): boolean;
  sendTurnSettled(peerId: string, turnId: string): boolean;
  sendTyping(peerId: string): boolean;
  sendHistory(peerId: string, messages: HistoryMessage[]): boolean;
  sendApprovalRequest(...): boolean;                 // approvals.ts 요구 시그니처 그대로
  sendApprovalResolved(...): boolean;
  sendApprovalSnapshot(...): boolean;
  // sendTextToAnyOpen 없음 — D2. WS 전용 멤버(handleUpgrade/setVerifier/liveness) 금지.
  // + 소비자 retype 후 tsc가 요구하는 멤버만 추가 (임의 확장 금지)
}

/** setup-safe no-op 구현 — setup-entry.ts 전용 (모든 send가 false 반환, side-effect 없음). */
export class NullPeerChannel implements WebChannelPeerChannel { ... }
```

- 멤버 목록의 최종 판정자는 tsc: 소비자 retype 후 컴파일이 요구하는 것만 추가.
- `NatsChannel implements WebChannelPeerChannel` 선언, index-nats cast 3곳 제거.
- `setup-entry.ts`는 `new WebChannelTransport()` → `new NullPeerChannel()`로 교체
  (setup 경로는 outbound adapter *shape*만 필요 — 현 주석의 계약 그대로).
- 기존 `src/protocol.ts`(protocol-version 전용)는 그대로 두고 새 파일을 만든다.

### D2. `sendTextToAnyOpen`은 **P0-1에서 계약과 구현 모두 삭제** (v2에서 뒤집음)

P0.md는 새 interface가 "아무 socket이나 고르는 fallback / sole-open-socket 추측"을 보존하지
말 것을 명시한다. `NatsChannel.sendTextToAnyOpen`(nats-channel.ts:473-483)의
"등록 peer가 정확히 1일 때 전달"도 collection cardinality로 수신자를 **추측**하는 동일
의미론이다 — v1의 "WS 소켓맵 추측만 금지" 해석은 리뷰 문서를 임의로 좁힌 것이므로 폐기.

- 계약에 넣지 않고, `NatsChannel.sendTextToAnyOpen` 구현도 삭제.
- 호출부 2곳의 fallback 분기 제거:
  - `channel.ts:197-203` — `ctx.to` 부재/targeted send 실패 시 fallback 호출 → **명시적
    drop**: `[webchannel] outbound send has no resolvable target peer — dropped` error 로그.
    (synthetic messageId 반환 등 결과 계약 재설계는 P0-4에서 — 이 단계에서는 거짓 fallback만 제거)
  - `message-adapter.ts:108-114` — 동일 처리.
- **노출 범위 (증명된 범위로 한정, v3 정정)**: 코드로 증명되는 것은 "captured inbound 왕복의
  최종 전달은 `inbound.ts:367-381`이 `transport.sendText(wsKey, …)`로 직접 targeted 전송하고
  `reply.to = wsKey`가 `inbound.ts:271`에서 기록된다"까지다. `channel.ts`/`message-adapter.ts`의
  outbound adapter는 core가 독립적으로 진입하는 seam이며, **모든** core 발신이 살아있는
  per-peer key를 공급한다는 보장은 repo에 없다. 따라서 이 삭제는 "target 부재/stale-target
  proactive send가 명시 실패로 바뀌는 **의도된 breaking change**"로 분류하고 CHANGELOG에
  기재한다 (P0.md의 결정이며 P0-4 목표 상태와 정합).
- 테스트 4종 신설: (a) 유효 target → 전달, (b) target 부재 → 명시 drop 로그 + 미전달,
  (c) stale target(등록 해제된 peer) → 명시 drop, (d) 다계정 상황에서 타 계정으로 새지 않음.
- 기타: nats-channel의 sendTextToAnyOpen 케이스 삭제, `inbound.test.ts:121`의 구조적 fake
  멤버 `sendTextToAnyOpen` 제거 — 모든 fake는 compile-checked `WebChannelPeerChannel` 구현으로
  강제해 금지 symbol이 테스트에 잔존하거나 interface drift를 가리지 못하게 한다.

### D3. Breaking change / 릴리즈 계약

- 루트에 `CHANGELOG.md` 신설, `0.3.0` 항목에 BREAKING 명시: `WebChannelClient` root export
  삭제, `auth.ticketParam` config 제거, `sendTextToAnyOpen` untargeted fallback 제거.
- 버전 계약: `.github/workflows/publish.yml`은 **plugin/client/saas 3-way lockstep**을
  강제한다 — 릴리즈 시 세 패키지 모두 `0.3.0`으로 bump (client만 breaking이어도 동일).
  이번 PR에서는 CHANGELOG와 버전 bump 준비 노트만, 태그/publish는 별도.

### D4. `auth.ticketParam` 제거 = config-breaking → **targeted migration error**

manifest의 flat channel/auth 스키마는 `additionalProperties:false`다. **주의 (v3): property를
스키마에서 지우면 OpenClaw의 스키마 검증이 `resolveWebchannelAccountConfig()`(account-config.ts:214)
도달 전에 flat config를 일반 스키마 오류로 거부할 수 있다** — detector가 targeted error를
낼 기회 자체가 없다 (named-account leaf는 비검증이라 detector까지 도달, 비대칭). 처리:

- manifest에서 `auth.ticketParam`을 **삭제하지 않고 deprecated-accepted로 유지**: property는
  스키마에 남기되 description을 "REMOVED — load-time migration error. `openclaw channels add`로
  재설정" 문구로 교체하고 uiHint는 삭제. 스키마 통과 후 detector가 targeted error를 담당한다.
  (스키마에서의 물리적 제거는 다음 release에서 — CHANGELOG에 예고.)
- `account-config.ts` resolve 경로에 **removed-config 감지기** 신설: 해석된 계정 auth 블록에
  `ticketParam` 키가 있으면(flat이든 named-account leaf든) 제거된 설정명·사유·조치
  (`openclaw channels add --channel webchannel` 재설정 안내)를 담은 migration error를 던진다.
  P0-2가 `admission:"auto"`/`devOpen` 감지에 같은 seam을 재사용한다 (P0.md P0-2 "Migration
  동작"과 동일 패턴).
- 테스트: 직접 resolver 호출만이 아니라 **실제 plugin config 로드 경로**(index-nats 계정 해석
  경로)를 통과시키는 테스트로 검증 — flat 잔존 → targeted error(스키마에서 거부되지 않음을
  함께 증명), named-account leaf 잔존 → 동일 targeted error.

### D5. WS verifier 대체 (§3.3) — `assertJwtAuthConfig` 신설, request-기반 verifier 전량 삭제

정확한 의미론 (v3 정정): `assertJwtAuthConfig`는 "pure assert"가 아니라
**validation-and-cache-initialization**이다. `jwksCacheFor()`(auth.ts:193-215)는
`JWKSCache`를 생성해 auth 객체 keyed `WeakMap`에 넣고, 이후 preflight(:233-237)와 live JWT
검증(:362-371)이 **같은 인스턴스를 재사용**한다. 이 재사용은 동일한 derived auth 객체가
runtime에 유지될 때만 성립하며 현재 `AccountRuntime.auth`(index-nats.ts:976-977)가 그 identity를
보존한다. 따라서:

- `assertJwtAuthConfig(accountAuth)`는 구조 검증(strategy/issuer/audience/JWKS 소스 정확히 1개)
  + `jwksCacheFor(accountAuth)` 초기화를 수행하고, 호출부는 검증에 쓴 **동일 auth 객체**를
  `AccountRuntime.auth`로 publish해야 한다 (docstring에 명시).
- 테스트: assert → preflight → live 검증이 하나의 JWKS cache/fetch 시퀀스를 공유함을 증명
  (fetch 호출 횟수 계측).

## 5. 단계별 작업 (stage = commit 단위, 각 단계 후 build/test/typecheck green)

### Stage 1 — 공유 계약 추출 (동작 무변경)
1. `src/channel-contract.ts` 신설 (D1, `NullPeerChannel` 포함).
   **의존 방향 규칙**: `channel-contract.ts → auth.ts` 단방향. `auth.ts`는 contract를
   import하지 않는다 (순환 금지).
2. §3.2 표의 소비자 전부(consumers 11곳) import를 contract로 교체; `ResolveAccountTransport`
   반환 타입을 `WebChannelPeerChannel | undefined`로.
3. `NatsChannel implements WebChannelPeerChannel`; frame 타입 중복 제거(contract re-export).
4. `index-nats.ts` cast 3곳 제거.
5. `setup-entry.ts` → `NullPeerChannel`.
6. **호환 브리지 (v3)**: `transport.ts`는 Stage 1 동안 `WEBCHANNEL_ID`(및 이동한 approval
   타입)를 contract에서 import + re-export해 legacy `index.ts` 컴파일을 유지한다. 이 브리지는
   Stage 2에서 transport.ts와 함께 삭제된다.
7. 테스트 조정은 §6.1 분류표에 따름 (이 단계에서는 retype 계열만).

### Stage 2 — plugin legacy 삭제
1. D5 선행: `assertJwtAuthConfig` 신설, `index-nats.ts` verifier 배선 교체,
   `AccountRuntime.verifier` 제거.
2. `packages/plugin/index.ts`, `src/transport.ts`, `src/transport.test.ts` 삭제.
3. `auth.ts`에서 §3.3 삭제 목록 제거, handleUpgrade 언급 주석 정리.
4. D4: manifest의 `auth.ticketParam` property는 **유지하되** description을 REMOVED/migration
   안내로 교체 (스키마 물리 삭제는 다음 릴리즈 — D4), `uiHints["auth.ticketParam"]` 항목만
   삭제, `account-config.ts` resolve 경로에 removed-config 감지기 설치. 그 외 uiHints의
   WS/upgrade/ticket 문구 정리 (`auth.strategy` help 등; enum 자체는 비범위).
5. 테스트 조정 §6.1 (재작성/삭제 계열).

### Stage 3 — client legacy 삭제
1. `client.ts`, `client.test.ts` 삭제; 배럴에서 `WebChannelClient` 제거.
2. `types.ts` trim (v3 정밀화): **`WebChannelOptions`는 유지되는
   `WebChannelNATSClient`(wrapper)의 public 생성자 입력이다** — wrapper는
   `WebChannelOptions & Omit<NatsClientOptions,"url"|"jwt">`를 받고 `natsUrl`/`bootstrapJwt`
   alias만 읽는다(nats-client-wrapper.ts:59-70). 절차:
   (a) wrapper·위젯이 실제 읽는 필드를 rg로 목록화, (b) WS 전용으로 **증명된** 필드만 제거
   (`url`(WS 게이트웨이 의미), `path`(types.ts:233-237, Gateway WS path 전용), `getTicket`,
   ticket 관련), (c) 유지 필드(`natsUrl`,
   `bootstrapJwt`, `accountId`, `tenant`, `peerId`, reconnect 튜닝 등)의 의미를 docstring으로
   명시, (d) wrapper 생성자가 WS 필드 없이 컴파일됨을 compile-check 테스트로 고정.
   client.ts 전용 `InboundWsMessage`/`OutboundWsMessage`(types.ts:275,300)는 nats-client가
   별도 정의를 쓰는지 확인 후 제거.
   공유 상태 타입(`WebChannelState`, `ChatMessage`, `ApprovalRequest`,
   `WebChannelErrorCause` 등)은 유지.
3. `nats-client-wrapper.ts`의 "drop-in replacement for WebSocket-based WebChannelClient"
   주석 현재형으로 갱신.
4. `index-exports.test.ts` 갱신 (+T1).

### Stage 4 — smoke 삭제 + 참조 정리
`smoke/` 삭제; root/plugin/client README의 smoke·Gateway-WS 사용법 제거.

### Stage 5 — 문서 + package metadata 정리 (v3 정밀화)

원칙: **T4 guard와 양립해야 하므로 "임의 라인 allowlist"는 쓰지 않는다.** 현재형 문서는
금지 symbol이 0이 되도록 고치고, 역사 문서는 통째로 `docs/archive/`로 이동한다(스캔 제외
디렉토리 단위).

- root `README.md`: A/B entry 표에서 Gateway-WS 행 제거, smoke 서술 제거.
- `docs/STATUS.md`, `docs/PACKAGING.md`: 현재형 갱신.
- `docs/BACKLOG.md`: "Remove the legacy Gateway-WS transport" 섹션 DONE 처리 +
  `sendTextToAnyOpen`/`registerFull` 언급(:53,56,103,113,123,132 등) 현재형 정리.
- `docs/AUTH.md`: 살아있는 `ConnectionVerifier`/upgrade 서술(:45-55,138-156) — NATS register
  hop 검증 서술로 재작성 (현재형 문서이므로 archive가 아니라 rewrite).
- `docs/PLAN.md`, `docs/TRUST_ANCHOR_DESIGN.md`: 역사 문서 → `docs/archive/`로 이동 + 상단
  archive 표기 (기존 `docs/archive/` 관례 사용; 링크하는 문서의 상대경로 갱신).
- `packages/plugin/package.json`의 `openclaw.channel.blurb` "served on the gateway port" →
  NATS relay 서술로 교체; `description` 등 metadata 전수 확인.
- `CHANGELOG.md` 신설 (D3).

### Stage 6 — guard 테스트 + CI (§6.2)

## 6. 테스트 계획

### 6.1 기존 테스트 분류 (codex R1 F5 반영)

| 파일 | 분류 | 처리 |
|---|---|---|
| `transport.test.ts` | WS 전용 | 삭제 |
| `client.test.ts` | WS 전용 | 삭제 |
| `channel.test.ts` | 혼합 — `new WebChannelTransport()` 30회, WS 소켓맵 직접 검증(L47-51) 포함 | WS-socket 동작 케이스 삭제; adapter/config 계약 케이스는 purpose-built outbound fake(`WebChannelPeerChannel` 구현)로 재작성; fallback 케이스는 D2 "명시적 drop" 검증으로 교체 |
| `approvals.test.ts` | 혼합 — `new WebChannelTransport()` 29회, `setApprovalDecisionHandler`+fake socket로 WS parse 경로 사용(L512-525), multi-transport 라우팅(L706-714, 957-959, 1083-1091) | approval 라우팅/다계정 로직은 fake `WebChannelPeerChannel`로 재작성 (**커버리지 보존 필수** — 라우팅 결정 로직은 transport와 무관); WS parse/socket 케이스만 삭제. **decision 역경로 커버리지 공백 (v3 정정)**: 기존 NatsChannel 테스트는 이 경로를 커버하지 **않는다** — production 역경로는 `NatsChannel.dispatchInbound()`→`onApprovalDecision`(nats-channel.ts:1059-1061)→`handleApprovalDecision`(index-nats.ts:852-864)인데 어떤 `nats-channel-*.test.ts`도 `setApprovalDecisionHandler` dispatch 분기를 검증하지 않고, 유일한 직접 테스트가 삭제 대상인 WS 테스트(L512-539)다. **신규 테스트 필수**: (a) NatsChannel에 유효한 decoded `approval_decision` 프레임 → handler가 peer/id/decision으로 호출됨 + malformed 거부, (b) wiring 레벨에서 per-account callback이 `accountId`를 담아 `handleApprovalDecision`을 호출함 |
| `inbound.test.ts`, `inbound-debounce.test.ts`, `control-lane.test.ts`, `message-adapter.test.ts`, `nats-cutover-e2e.test.ts`, `setup-wizard.test.ts`, `nats-transport.test.ts` | 타입/상수 참조 위주 (단 `inbound.test.ts:121`은 fake에 `sendTextToAnyOpen` 멤버 보유) | contract로 retype; fake는 전부 compile-checked `WebChannelPeerChannel` 구현으로 교체하고 `sendTextToAnyOpen` fake 멤버 제거 (D2) |
| `auth.test.ts`, `auth-admission.test.ts`, `jwt-middleware.test.ts` | 혼합 | verifier/`?ticket=` 케이스 삭제, `verifyJwt*`/JWKS/admission 케이스 유지, `assertJwtAuthConfig` 케이스 신설 |

원칙: 삭제되는 테스트는 "Gateway-WS 전용 동작"을 검증하던 것에 한정. transport-무관 로직
(approval 라우팅, adapter 계약)의 커버리지는 fake 기반으로 반드시 이전.

### 6.2 신규 guard 테스트 (P0.md "필요한 테스트" 매핑)

| ID | 테스트 | 위치 |
|---|---|---|
| T1 | client 배럴에 `WebChannelClient` export **부재** 명시 assert | `index-exports.test.ts` 확장 |
| T2 | `npm pack` tarball: (a) `openclaw.extensions === ["./dist/index-nats.js"]` + `setupEntry === "./dist/setup-entry.js"`, (b) tarball 파일 목록이 allowlist와 일치(`index.ts`/`transport.ts` 부재), (c) dist 산출물 내 `handleUpgrade`/`?ticket=`/`WebChannelTransport` 문자열 0개 | `scripts/pack-load-smoke.sh` 확장 |
| T3a | source/package guard (v3 하향): `index-nats.ts` 소스에 `registerHttpRoute`/upgrade 참조 0건 + T2의 dist 문자열 검사. **mock-API boot 확장은 채택하지 않음** — 기존 `index-nats-wiring.test.ts`(:6-17)는 entry import가 side-effectful해서 의도적으로 source-text 검사이며, `registerFull` 실기동은 transport/enrollment/구독 상태를 만들므로 P0-1에서 DI 추출은 과잉. behavioral 증명은 T3b가 담당. stale 주석(tsconfig 미포함 서술)은 정정 — tsconfig:14-20이 이미 index-nats.ts 포함 | `index-nats-wiring.test.ts` + `pack-load-smoke.sh` |
| T3b | boot 레벨: live harness의 실제 gateway boot 후 `/webchannel/ws` upgrade 시도 → 연결 거부 assert (browser-facing listener 부재) | `e2e` live harness에 probe 추가 (TechLead 최종 게이트에서 실행) |
| T4 | 금지 symbol guard: `rg 'WebChannelClient\b|WebChannelTransport\b|handleUpgrade|\?ticket='`. 스캔 대상: `packages/`(소스+`package.json` metadata+dist 산출물), 루트 `README.md`, `docs/`, `.github/`. 제외는 **디렉토리/파일 단위로 고정**: `docs/archive/`, `docs/review-2026-07-15/`, `CHANGELOG.md`, `node_modules` — 임의 라인 allowlist 금지 (Stage 5가 현재형 문서를 0건으로 만든다) | `scripts/check-banned-symbols.sh` + 기존 CI job에 step 추가 (self-hosted runner `[self-hosted, linux, x64]`, 새 job 금지 — runner 1대 직렬 큐) |
| T5 | migration: `auth.ticketParam` 잔존 config(flat/named 모두) → targeted error, **실제 plugin config 로드 경로 경유** (D4) | `account-config.test.ts` + index-nats 계정 해석 경로 테스트 |
| T6 | 기존 NATS 전체 suite + live harness 회귀 없음 | 기존 (`npm test`, run-all-real) |

### 6.3 CI 테스트 baseline 관리 (v3 신설)

`.github/workflows/e2e-gate.yml:180-202`가 **passed ≥ 712 (BASELINE=712)** 를 강제한다.
WS 테스트 대량 삭제(transport.test.ts, client.test.ts, channel/approvals WS 케이스)는 이
floor를 깨뜨릴 수 있다. 처리: 대체 테스트(§6.1 재작성 + §6.2 신규)가 모두 든 **같은 PR에서**
최종 카운트를 실측하고, `BASELINE`을 "실측치 − 소량 여유"로 조정하는 커밋을 포함한다.
커밋 메시지에 삭제/신규 테스트 수 대차대조표를 남겨 숫자 하향이 정당함을 증명한다.
(중간 stage 커밋은 로컬 green이면 되고, floor는 PR 단위 CI에서만 걸린다.)

## 7. 검증 게이트

각 stage 후: `npm test` · `npm run typecheck`(demo 포함) · `npm run build`.
최종: `scripts/pack-load-smoke.sh` + live E2E harness(`run-all-real.sh`, T3b 포함) —
live harness는 TechLead가 최종 승인 전 직접 실행.
기준선: 현재 `review` 브랜치 suite green. 테스트 수 감소분은 §6.1 분류표와 1:1 대조 가능해야
하고, CI의 712-test floor 조정은 §6.3 절차를 따른다.

## 8. 리스크

- **R1 (타입 구멍 노출)**: cast가 가리던 구조 불일치가 retype에서 드러남 — tsc가 요구하는
  멤버는 "호출부가 정말 필요한가"를 먼저 판단 후 계약에 추가.
- **R2 (approvals 다계정 경로)**: `ResolveAccountTransport` retype + 테스트 재작성이 approval
  배달 경로(S1)를 건드림 — `approval-broadcast-integration.test.ts`,
  `multidevice-broadcast.test.ts` green 필수, §6.1 커버리지 이전 원칙 준수.
- **R3 (untargeted send 동작 변경)**: D2로 core-initiated untargeted send가 명시 실패로 바뀜 —
  live harness에서 proactive/outbound 시나리오 회귀 확인 (P0-4에서 정식 계약으로 회수).
- **R4 (setup 경로)**: `NullPeerChannel` 교체 후 disabled/unconfigured 채널의 setup-safe
  inspection이 동일하게 동작해야 함 — `setup.test.ts`/`setup-wizard.test.ts` green +
  pack-load smoke의 setupEntry 로드 확인.
- **R5 (문서 과삭제)**: 역사 문서는 archive 표기만 (Stage 5).
- **R6 (widget repo)**: `@mir-stream/webchannel-client` 0.3.0에서 `WebChannelClient` 소멸 —
  위젯 repo가 NATS wrapper를 쓰는지 릴리즈 전 확인, 릴리즈 노트 명시.

## 9. 완료 조건 (P0.md 매핑)

- [ ] `WebChannelClient` / `WebChannelTransport` / `?ticket=` production symbol 0개 (T4 —
  §3.3 verifier 대체까지 포함해야 성립)
- [ ] gateway boot 시 browser-facing socket/upgrade route 미등록 (T3a+T3b)
- [ ] NATS build + pack-load smoke + examples + live harness green (T2, T6)
- [ ] 현재형 문서에서 Gateway-WS 지원 서술 0 (Stage 5)
- [ ] index-nats.ts에 `as unknown as WebChannelTransport` cast 0개 (Stage 1)
- [ ] 계약에 cardinality-추측 fallback 부재 — `sendTextToAnyOpen` 전량 삭제 (D2)
