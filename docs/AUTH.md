# WebChannel — 인증 설계 (AUTH)

> 📌 **현재 동작 상태의 단일 진실원: [`STATUS.md`](STATUS.md).** 이 문서는 인증 설계 기준 문서다.

> 브라우저 클라이언트가 게이트웨이 WebSocket에 붙을 때의 **인증·신원(identity)** 모델.
> 상태: **결정됨** — 구 `BACKLOG.md`(삭제됨)의 "브라우저 Auth 모델 (완전 OPEN)" 항목을 대체한다.
> 용어(2026-06-15): "위젯"은 이제 무프레임워크 **`openclaw-webchannel-client`**(`packages/client`)를 가리킨다. React `openclaw-webchannel-widget`는 삭제됨 — `getTicket` 주입점은 client에 그대로 존재.
> 핵심 원리: 인증을 코어에 하드코딩하지 않고 **주입 가능한 검증기(ConnectionVerifier) 한 점**으로 수렴시키고,
> 흔한 방식은 **config로 고르는 빌트인 전략**으로 제공한다. (배포된 플러그인은 코드가 아니라 JSON config로 설정되므로)

---

## 1. 인증이 붙을 수 있는 3개 레이어 (요약)

| 레이어 | 개념 | 우리에게 |
|---|---|---|
| ① 게이트웨이 연결 auth (`gateway.auth.mode`) | 게이트웨이 본체 | 통과 = **operator(주인) 자격** → 브라우저 직접 노출 금지 |
| ② 플러그인 라우트 auth (`registerHttpRoute({auth})`) | **우리 플러그인 코드** | ✅ **여기서 인증.** `auth:"plugin"`으로 두고 `handleUpgrade`에서 자체 검증 |
| ③ allowlist + pairing | 채널 기능 | "이 peer 허용?" 판정 — 단 **누구인지를 ②가 먼저 확정**해야 의미 있음 |

→ ②와 ③은 대체재가 아니라 보완재. ②의 검증 결과(`peerId`)가 ③의 입력이 된다.

---

## 2. 결정 사항

- **라우트는 `auth:"plugin"` 유지.** 모든 신원 해석을 우리 검증기 한 seam(`handleUpgrade`)으로 일관시킨다.
- 게이트웨이 공유 토큰(`gateway.auth.token`)은 operator 자격이라 **브라우저에 노출하지 않는다** → `auth:"gateway"`를 브라우저 경로에 직접 쓰지 않음.
- **SaaS 임베드 시나리오(우리 주 사용처):** SaaS가 구글 로그인 등 사용자 신원을 *이미* 소유한다.
  에이전트 연결은 **2차 로그인이 아니라**, SaaS 백엔드가 발급한 **짧은 수명 서명 ticket**을 플러그인이 검증하는 **신원 전달(handoff)**이다. 로그인은 SaaS 한 곳뿐.

---

## 3. 공개 API = 검증기 계약 (ConnectionVerifier)

빌트인이든 커스텀이든 내부적으로 전부 이 한 줄로 수렴한다. 이것이 우리가 문서화·버전관리하는 **유일한 auth 공개 표면**.

```ts
type ConnectionIdentity = { peerId: string; displayName?: string };
type ConnectionVerifier = (req: IncomingMessage) => Promise<ConnectionIdentity | null>;
// null => WS 업그레이드 거절 (401 / close 1008)
```

- 실행 위치: `src/transport.ts`의 `handleUpgrade` (현재 `:137`). 통과 시 `identity.peerId`를 sessionKey로 사용.
- 지금은 무조건 `ANON_PEER_ID`(`transport.ts:145`) 하드코딩 → **이 자리를 "검증기 실행 → 없으면 소켓 destroy, 있으면 peerId 매핑"으로 교체**하는 것이 핵심 변경.
- ⇒ auth 구멍 하나가 **세션 분리(세션키 매핑)까지 동시 해결**한다.

---

## 4. 빌트인 전략 (config로 선택)

| strategy | 검증 방법 | 누가 씀 |
|---|---|---|
| `anonymous` | 검증 없음, 전원 단일 peer | dev/loopback 전용 (현재 동작) |
| `hmac-ticket` | 호스트 백엔드가 `{sub,exp}` 서명 → 공유 시크릿으로 검증 | **우리 SaaS** |
| `jwt` ✅ 구현됨 | RS256 + JWKS 공개키 + `iss`/`aud` 검증 | 이미 JWT 발급하는 호스트 (Auth0 / Clerk / Keycloak / 자체 IdP) |
| `trusted-header` | 프록시가 주입한 신원 헤더 읽기 | 게이트웨이가 trusted-proxy 뒤일 때 |

소비자 OpenClaw config (이 스키마는 `openclaw.plugin.json`의 `channelConfigs.webchannel.schema`가 검증):

```json5
channels: {
  webchannel: {
    auth: {
      strategy: "hmac-ticket",
      // 시크릿은 평문 금지 — OpenClaw SecretRef(env/file/exec) 사용
      ticketSecret: { env: "WEBCHANNEL_TICKET_SECRET" },
    },
  },
}
```

→ **우리조차 커스텀 코드 없이 이 config만으로 동작.** 빌트인이 95%를 덮는 것이 목표.

### 커스텀 인증 (코드 탈출구, 드묾)

빌트인으로 안 되는 인증은 소비자가 자기 얇은 래퍼 플러그인에서 우리 패키지를 *라이브러리로* 사용:

```ts
import { createWebChannel } from "openclaw-webchannel";
createWebChannel({
  auth: async (req) => {
    const id = await myWeirdAuth(req);
    return id ? { peerId: id } : null;
  },
});
```

---

## 5. ticket 수명주기 (`hmac-ticket`)

수명이 3층으로 분리된다 — **단명 ticket은 "접속하는 순간"에만 적용**되고 대화 길이와 무관하다.

| | 수명 | 역할 |
|---|---|---|
| SaaS 세션(구글 로그인) | 길다 (시간~일) | 진짜 신원. 위젯이 가진 쿠키 |
| **ticket** | 짧다 (~1분) | 소켓 여는 **한 번**만 쓰는 입장표 |
| WS 연결 | 열려있는 내내 | 실제 대화 통로 |

- ticket은 `handleUpgrade`에서 검증되고 소켓이 열리는 순간 임무 끝. 이후 만료돼도 **열린 대화엔 영향 없음.**
- 짧게 두는 이유: ticket은 URL 쿼리 등에 실려 로그에 남을 수 있어 누출 폭을 줄이려는 것.
- **재연결:** 소켓이 끊기면 위젯이 SaaS에 새 ticket을 요청(`getTicket`)해 재연결. SaaS 세션은 살아있으므로 재로그인 없음.

---

## 6. 양쪽 패키지의 책임

| | 플러그인 패키지 (서버) | 클라이언트 패키지 (브라우저) |
|---|---|---|
| 역할 | 검증기(strategy) 실행 | ticket을 **호스트에게 받아** WS에 실어 보냄 |
| 주입점 | `auth` config / 함수 | `getTicket: () => Promise<string>` 콜백 |
| 재연결 | — | 끊기면 `getTicket` 재호출 → 새 표로 재연결 |

- 클라이언트도 인증을 *모른다*. "호스트야 표 줘" 하고 나르기만. `trusted-header`/쿠키 방식이면 `getTicket`은 no-op.
- **ticket 발급 헬퍼:** `issueWebChannelTicket({ sub, secret, ttlSeconds })` — 호스트 백엔드가 서명에 사용.
  서명/검증 코드가 **두 독립 Node 프로세스(SaaS 백엔드 + 게이트웨이 플러그인)**에서 동일해야 하므로 **zero-dep**(SDK 안 물게)으로 제공. → `PACKAGING.md` §3 참조.

---

## 7. 안전 기본값 ✅ (구현됨)

`resolveVerifier`가 강제한다 (`src/auth.ts`):

- **strategy 명시 강제** — `auth` 미설정/미지원 strategy/시크릿 누락 시 **throw → 플러그인 로드 거부**(조용한 전세계 오픈 불가).
- `anonymous`는 선택 시 **경고 로그** 발생(dev 전용).
- `trusted-header`(미구현 빌트인) 사용 시 "게이트웨이가 클라이언트 헤더를 덮어쓰는 프록시 뒤여야 함" 문서화 필요.

---

## 8. 코드 위치 ✅ (구현됨)

| 위치 | 동작 |
|---|---|
| `src/auth.ts` | `ConnectionVerifier` 계약 + `anonymous`/`hmac-ticket`/`jwt` 전략 + `resolveVerifier`(안전 기본값) |
| `src/ticket.ts` | zero-dep HS256 발급(`issueWebChannelTicket`)/검증(`verifyTicket`, alg 핀·timing-safe·exp) |
| `src/jwt.ts` | zero-dep RS256 검증(`verifyJwt`, alg 핀 RS256·constant-time iss/aud·exp·Web Crypto `verify`) |
| `src/jwks.ts` | JWKS fetcher + 5분 TTL 캐시 + kid 조회 + fail-closed (`JWKSCache`); URL / 파일 / 인라인 3종 소스 |
| `src/transport.ts` `handleUpgrade` | 검증기 실행 → 실패 시 401+destroy, 성공 시 `peerId`로 `registerConnection` |
| `src/inbound.ts` / `approvals.ts` | per-peer 라우팅 — 답변/progress는 캡처된 `wsKey`, 승인은 `turnSourceTo`(= 출발 peer) |
| `index.ts` | config `channels.webchannel.auth` → `resolveVerifier` → `transport.setVerifier` + WS·정적 라우트 |
| `openclaw.plugin.json` | `channelConfigs.webchannel.schema.auth`(strategy enum + ticketSecret string\|{env} + ticketParam + `auth.jwt.{jwksUrl,jwks,jwksFile,issuer,audience,clockSkew}`) |
| `openclaw-webchannel-client` (`packages/client/src/client.ts`) | `getTicket` 주입 → `?ticket=` + 재연결 재발급. (구 위젯 훅 `useWebChannel.ts`는 삭제) |
| `packages/client/demo/devTicket.jwt.ts` | 데모용 RS256 발급 + 자체 키페어 영속 (브라우저 localStorage / Node `demo/.cache/`) |

→ **hmac-ticket E2E 라이브 검증됨(2026-06-15):** 유효 ticket 연결 + 에이전트 응답, 미·오 ticket 거절. (멀티유저 outbound/approval 라우팅 포함 — 더는 미해결 아님)
→ **jwt 빌트인 검증됨(2026-06-20):** vitest 53 케이스(RS256 7종 거절 + JWKS TTL·fail-closed·kid 회전 + auth fail-closed) 모두 통과. hmac-ticket 회귀 없음.

---

## 9. 미해결(후속)

- **크로스오리진 게이트웨이 URL:** `openclaw-webchannel-client`는 `url` 옵션으로 **해결됨**(다른 오리진 게이트웨이 직접 지정). same-origin이면 `path`만으로 충분.
- **SaaS 실연동:** 현재 데모는 **브라우저에서 ticket 발급**(`packages/client/demo/devTicket.ts`, DEV 전용, 시크릿 노출). 실서비스는 SaaS 백엔드가 서버측 `issueWebChannelTicket`로 발급 → 클라이언트 `getTicket`이 호출. ticket 서명 모듈은 `openclaw-webchannel-ticket`로 분리 후보(`PACKAGING.md` §3).
- **세션 중 강제 만료(revocation):** 이미 열린 소켓은 자동으로 안 닫힘. SaaS 로그아웃/만료 시 즉시 끊으려면 별도 처리(heartbeat 재검증 또는 서버측 강제 close). 또한 **잘못된 ticket 시 클라이언트가 재연결 루프**(앰버) — "인증 실패" UX 미구현.
- `trusted-header` 빌트인, `createWebChannel({auth})` 커스텀 함수 주입은 후순위.
- 멀티탭 사용자를 같은 peerId로 묶을지/탭별 분리할지 정책.

---

## 10. `jwt` (JWKS) 빌트인 ✅ 구현됨

SaaS 운영자가 자체 IdP 또는 외부 IdP(Auth0/Clerk/Keycloak 등)에서 발급한 RS256 JWT를 브라우저가 `?ticket=`로 실어 보내면 게이트웨이가 JWKS 공개키로 검증한다. 클라이언트 SDK는 변경 없음 — `getTicket`이 JWKS-서명된 compact JWT를 반환하기만 하면 된다.

### 10.1 config 예시

```json5
channels: {
  webchannel: {
    auth: {
      strategy: "jwt",
      jwt: {
        // 정확히 1개 필수 (jwksUrl | jwksFile | jwks)
        jwksUrl: "https://your-tenant.auth0.com/.well-known/jwks.json",
        issuer: "https://your-tenant.auth0.com/",
        audience: "https://api.your-saas.example/webchannel",
        clockSkew: 60  // 기본 60s, exp leeway
      },
      // 선택. 기본 "ticket"
      ticketParam: "ticket"
    }
  }
}
```

- `jwksUrl`: HTTPS URL. 5분 TTL 캐시. fetch 실패 시 캐시 비우고 throw (fail-closed).
- `jwksFile`: 배포에 동봉된 JWKS 파일 경로. 매 refresh마다 재읽기.
- `jwks`: 인라인 JWKS 객체 (`{keys:[...]}`). 테스트/오프라인 배포용.
- `issuer` / `audience`: 필수. `aud`는 string 또는 배열 모두 허용 (배열인 경우 expected audience가 하나라도 포함되면 통과).
- `clockSkew`: exp leeway (초). 기본 60.
- 셋 중 어느 JWKS 소스도 없거나 2개 이상이면 `resolveVerifier`가 throw → 플러그인 로드 실패 (fail-closed).
- ticketParam 기본값 `"ticket"` — hmac-ticket과 동일.

### 10.2 외부 IdP 연동

- **Auth0**: JWKS URL = `https://<tenant>.auth0.com/.well-known/jwks.json`. issuer = `https://<tenant>.auth0.com/`. audience = 본 서비스의 API identifier (Auth0 Application 설정의 "Identifier").
- **Clerk**: JWKS URL = `https://<frontend-api>.clerk.accounts.dev/.well-known/jwks.json` (Front-end API 기준). issuer = Clerk Frontend API URL. audience = 본 서비스의 "Audience" claim.
- **Keycloak**: JWKS URL = `https://<keycloak-host>/realms/<realm>/protocol/openid-connect/certs`. issuer = `https://<keycloak-host>/realms/<realm>`. audience = Keycloak client id.
- 자체 IdP: OpenID Connect Discovery(`/.well-known/openid-configuration`)의 `jwks_uri`를 그대로 사용.

### 10.3 kid 회전 (key rotation)

IdP가 새 키로 회전하면:
1. IdP는 새 `kid`를 JWKS에 추가 (이전 키는 일정 시간 유지).
2. 게이트웨이 캐시(5분) 안에 새 토큰 도착 → 캐시 미스 → 즉시 1회 refetch → 새 kid로 검증 통과.
3. IdP가 이전 키 폐기 → JWKS에서 제거 → 게이트웨이는 다음 refresh(5분 이내)부터 이전 kid 거절.

→ **fail-closed**: 캐시가 stale라도 잘못된 kid로 검증을 통과시키는 일은 없다. fetch 자체가 실패해도 stale 캐시로 fallback 하지 않고 throw — 인프라 장애가 인증 우회로 이어지지 않는다.

### 10.4 검증 알고리즘 (defense-in-depth)

`src/jwt.ts`가 강제한다:
- `alg` 핀 `RS256` — `none` / `HS256` / `ES256` / 기타 즉시 거절.
- `iss` / `aud` 상수시간 비교.
- `exp` 미경과 (`clockSkewSec` 기본 60s leeway).
- `sub` 비어 있으면 거절.
- `displayName` = `name` 또는 `preferred_username` (OIDC 관례) → 있으면 채워서 반환.
- 3-segment / base64url 디코드 / JSON 파싱 어느 하나 실패해도 모두 `null` 반환 (절대 throw 안 함 — 인프라 에러는 JWKS 레이어에서 throw).
- `verifyJwt`는 항상 `Promise<JwtIdentity | null>` — `verifyTicket`(HS256)과 동일한 fail-soft 시맨틱.

### 10.5 데모

`packages/client/demo/devTicket.jwt.ts` 가 자체 RSA-2048 키페어를 생성하고 브라우저에서 RS256 JWT를 self-issue 한다 (DEV 전용, 개인키 노출). 데모는 mode 토글로 `hmac-ticket` / `jwt` 둘 다 선택 가능. console에 public JWK를 출력하므로 운영자는 그 JWK를 게이트웨이 JWKS 파일에 복사해 붙여 넣으면 데모 → 게이트웨이 E2E 검증이 된다.

테스트: `packages/plugin/src/jwt.test.ts` (33) + `packages/plugin/src/jwks.test.ts` (20).

---

## 관련 문서
- `PACKAGING.md` — 2-패키지 구조, ticket 헬퍼 패키지 분리 트리거, 배포.
- `RESEARCH.md` §1·§3·§7 — 게이트웨이 auth, `registerHttpRoute` auth 의미, 승인.
- OpenClaw: `docs/plugins/architecture-internals.md`(라우트 auth), `docs/gateway/trusted-proxy-auth.md`, `docs/gateway/secrets.md`(SecretRef).
