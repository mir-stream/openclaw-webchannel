# 기획서 v2 — `examples/webchannel-app`: 공개 API만 쓰는 레퍼런스 데모

> 목적: 제3자 개발자가 `@mir-stream/webchannel-{saas,client}`의 **공개(published) API만으로**
> WebChannel 앱(SaaS 백엔드 + 브라우저 클라이언트)을 어떻게 만드는지 보여주는 실행 가능한 레퍼런스.
> 기존 `demo/`(도청/카오스 레드팀 포함 쇼케이스)는 **그대로 유지**하고, 이건 **별도**로 추가한다.

## v2 개정 이유 (v1 적대리뷰 F1~F9 반영)

- **F1 (핵심)**: v1 §6은 `natsCredentials`만 주고 `registration`을 생략 → bootstrapJwt가 **dead code**
  (`nats-client.ts:68-80` 명시). 반대로 실제 브라우저 플로우(`demo/web/src/widget.ts:170+`)는
  **X25519+Ed25519 device 키쌍 → `/bootstrap` → `registration` 블록**이 필수인데 v1이 통째로 누락했고,
  registration을 넣으면 **에이전트 부재 시 PoP register가 ~15초 후 terminal error**가 된다.
  → v2는 **전체 production 플로우**를 채택하고 무에이전트 종단 상태를 명시적 "에이전트 대기" UX로 설계한다.
- **F2**: `buildBootstrapClaims`는 claims만 만들고 **서명(RS256)은 발급자 몫**(`bootstrap-claims.ts:18`).
  데모가 크립토를 손으로 짜는 건 "footgun을 소비자에게 떠넘기지 말자"는 이 기획의 논리와 모순.
  → v2는 **공개 서명 API `createBootstrapIssuer`를 0.1.2에 추가**한다.
- **F3**: `dist/`는 gitignore + exports가 dist만 가리킴 → run.sh/검증에 `npm run build` 선행 필요, stale-dist 위험 명시.
- **F4**: `isValidSubjectToken`은 이 데모에 소비자 없음(enroll이 내부 검증) → **드롭**.
- **F5**: 경계 테스트는 앱-소스 정적 체크만, 런타임 export assert는 기존 `examples/minimal-consumer` 참조.
- **F6**: `BrowserCredentials`에서 `userSeed` 제거(브라우저 미사용), `issuerAccountId` 외부모드 커플링 1줄 문서화.
- **F7**: 새 서버가 `demo/saas-server.ts`의 제품 경로 ~60-70% 재구현임을 **명시적 수용**(드리프트 완화책 포함).
- **F8**: 런타임 스모크는 **상태 시퀀스**를 검증(어떤 상태가 성공인지 정의).
- **F9**: client 무변경(0.1.1 유지), 레지스트리 실설치는 PAT 게이트(정직하게 명시).

## 1. 목표 / 비목표

**목표 (옵션 가 — 라이브러리 사용 레퍼런스, 전체 플로우):**
- 브라우저가 **device 키쌍 생성 → bootstrap JWT 수령 → NATS 연결 → PoP register 시도**까지 **전체
  production 플로우**를 공개 API만으로 수행. 에이전트(openclaw)가 붙으면 register 완료 → 실제 서비스 가능.
- 모든 라이브러리 접점이 **패키지 이름** 경유이며 **공개 export만** 사용. 상대경로/딥 서브패스 임포트 **금지**.
- 에이전트는 **pluggable** — 무에이전트 시 "⏳ 에이전트 대기" 상태로 우아하게 멈추고, openclaw 연결 안내를 노출.

**비목표:**
- 브라우저↔에이전트 실제 대화 완성(openclaw 게이트웨이 = 사용자 영역).
- 도청/카오스/멀티계정 스위처(기존 `demo/` 담당).
- GitHub Packages 레지스트리 실설치(read:packages PAT 필요 — §10).

## 2. 공개 API 변경 — `packages/saas` 0.1.2 (additive, client 무변경)

운영자의 **크립토 작업 2개**를 안전한 공개 API로 연다. 그 외(raw `mintNatsUserCreds`/roles, 저수준 전송층)는
계속 비공개.

### 2.1 `issueBrowserCredentials` — 브라우저 로그인 NATS 크리덴셜
브라우저는 에이전트와 별개 액터. `DeviceFlowEnrollment`는 `role:"agent"`만 민팅하고 `userSeedRaw`를 버림
(`device-flow-enrollment.ts:589-597`)이라 브라우저 creds를 못 만든다. 오늘은 `/test/nats-user`(TEST-ONLY)뿐 →
이것이 **최초의 정식 공개 경로**.

```ts
export type BrowserCredentials = {
  userJwt: string;
  userSeedRaw: string;                       // 브라우저 친화 raw seed — WebChannelNATSClient 필수
  permissions: { pub: string[]; sub: string[] };
  // NOTE: base32 `userSeed`(SU…)는 브라우저가 안 써서 이 타입에서 제외(F6). Node 소비자가 필요하면 별도.
};
export type IssueBrowserCredentialsOptions = {
  accountSeed: string;      // = trustChain.private.natsAccountSeed
  tenant: string;
  peerId: string;           // ★필수(타입강제) — 인증 세션 subject, 절대 클라 입력 아님
  issuerAccountId?: string; // 외부관리(Synadia/NGS)일 때만. self-contained 데모엔 미사용(외부모드 커플링 주의)
  ttlSeconds?: number;      // 주면 반드시 > 0 (0은 내부적으로 '무한만료' — nats-user-creds.ts:175)
};
export async function issueBrowserCredentials(o: IssueBrowserCredentialsOptions): Promise<BrowserCredentials>;
```
- 내부 `mintNatsUserCreds({ role:"browser", ... })` 얇은 래퍼. `ttlSeconds > 0` 검증. `peerId` 필수.
- 부채(문서화): `userSeedRaw`는 nkeys 비공개 `getRawSeed()` 캐스트 의존(`nats-user-creds.ts:129`). 제품 client가
  이미 의존하므로 감수.

### 2.2 `createBootstrapIssuer` — RS256 bootstrap JWT 서명 (F2 신규)
`buildBootstrapClaims`(공개, claims만)와 짝. 데모가 webcrypto RS256을 손으로 짜지 않게 한다.

```ts
export type BootstrapIssuer = { sign(claims: BootstrapClaims): Promise<string> };
export async function createBootstrapIssuer(opts: {
  rsaPrivateKeyPem: string;   // = trustChain.private.rsaPrivateKeyPem (공개 SaasTrustChainPrivate)
  kid: string;                // = trustChain.kid (공개 SetupTrustChainResult)
}): Promise<BootstrapIssuer>;
```
- 구현은 데모의 `importRsaPrivateKeyFromPem` + `signBootstrapJwt`(`demo/saas-server.ts:204-233`)를 패키지로 승격.
- 키 로테이션은 운영자가 새 kid/PEM으로 issuer 재생성(기존 데모의 activeSigner 패턴을 공개 형태로).
- 문서화(계약): issuer가 캡처한 `kid`는 **반드시 서빙 중인 JWKS에 존재**해야 함(로테이션 시 JWKS 갱신과
  issuer 재생성을 함께). 이 데모는 둘 다 하나의 `loadOrCreateTrustChain` 결과에서 나와 자동 정합.

### 2.3 계속 비공개
`mintNatsUserCreds`/`NatsUserRole`(agent tenant-wide·observer footgun), 저수준 `NatsClient`/nkey 전송층.
`isValidSubjectToken`은 **추가 안 함**(F4 — 소비자 없음; enroll이 내부 검증).

## 3. 아키텍처 / 디렉토리

```
examples/
  minimal-consumer/            # 기존 — 런타임 경계 테스트(exports 차단 assert). 유지·참조
  webchannel-app/              # ★신규
    package.json               # deps: @mir-stream/webchannel-{saas,client}; devDeps: tsx, esbuild, typescript
    README.md                  # 사용법 + openclaw 게이트웨이 꽂는 법(사용자 영역) + 무에이전트 종단 상태 설명
    tsconfig.json
    server/
      index.ts                 # SaaS 백엔드(전부 공개 API)
      nats.ts                  # 공개 natsConfig → operator.jwt/resolver.json + nats.conf + nats-server 부팅
      users.ts                 # 데모-로컬 최소 인증(BYO auth 스텁 — 라이브러리 무관)
    web/
      index.html
      app.ts                   # 브라우저: device 키쌍 → /bootstrap → WebChannelNATSClient(registration)
    run.sh                     # ★build(saas+client) → server → nats-server → openclaw 연결 안내
    test/
      no-internal-imports.test.mjs   # 앱 소스에 ../packages/·딥임포트 0건 정적 assert (런타임 assert는 minimal-consumer 참조)
```

## 4. SaaS 백엔드 (`server/`) — 전부 공개 API
부팅(모두 `@mir-stream/webchannel-saas`):
1. `loadOrCreateTrustChain(path, { operatorName, accountName })` → `natsConfig`(공개
   `NatsSelfContainedAccountConfig`: operatorJwt+resolverConfig+accountPublicKey), `private.natsAccountSeed`,
   `private.rsaPrivateKeyPem`, `kid`, `jwks` 확보.
2. `server/nats.ts`가 natsConfig로 operator.jwt/resolver.json/nats.conf 작성 후 `nats-server` 기동(표준 운영).
3. `createBootstrapIssuer({ rsaPrivateKeyPem, kid })` → bootstrap 서명자.
4. `new DeviceFlowEnrollment({ saasTrustChain: private, natsAccountConfig: natsConfig, ... })`.

HTTP 라우트(공개 API만):
- `POST /login` — 데모-로컬 유저 검증 → 세션. peerId = 안정 유저 id.
- `POST /bootstrap` — **★세션 게이트 필수(N1)**: 미인증 401. body `{ accountId, deviceX25519PublicKey,
  devicePopPublicKey }`에서 **`peerId`는 body가 아니라 세션 uuid**(body peerId 무시), `accountId`는 서버에서
  검증(단일계정 데모면 서버 고정, 다계정이면 `canAccess(user, accountId)` → 미인가 403). 통과 시
  `buildBootstrapClaims({ iss, peerId: session.uuid, accountId, tenant, deviceX25519PublicKey,
  devicePopPublicKey })` → `issuer.sign(claims)` → `{ jwt }`. (mirror `demo/saas-server.ts:563-579`.)
  키길이 assert가 throw(`bootstrap-claims.ts:91-96`)하므로 try/400 감싼다.
  ※ 이 게이트 없으면 누구나 임의 accountId/피해자 peerId로 SaaS-서명 부트스트랩 JWT를 받는 발급 오라클이 됨.
- `POST /nats-user` — 세션 게이트 → `issueBrowserCredentials({ accountSeed: private.natsAccountSeed, tenant,
  peerId: session.uuid })` → `{ ...creds, natsUrl }`. role 자유선택 없음.
- `POST /api/enroll` · `/api/poll` · `POST /admin/enrollments/:code/approve` — DeviceFlowEnrollment 위임.
- `GET /.well-known/jwks.json` — `result.jwks`. `GET /` · `/app.js` — 정적 웹 + esbuild 번들. `GET /me` — `{ natsUrl }`.

## 5. 브라우저 (`web/app.ts`) — 전부 공개 API, 전체 플로우
1. 로그인.
2. **device 키쌍 생성**: X25519(ECDH, **non-extractable**) `crypto.subtle.generateKey({name:"X25519"}, false,
   ["deriveBits"])` + `generateDevicePopKeyPair()`(공개 export → Ed25519 `{ privateKey, publicJwk }`).
3. `POST /bootstrap`(X25519 공개키 raw base64url + PoP 공개 JWK.x 전달) → bootstrapJwt 수령.
4. `POST /nats-user` → `{ userJwt, userSeedRaw, natsUrl }`.
5. `new WebChannelNATSClient({ natsUrl, natsCredentials:{ userJwt, userSeedRaw }, tenant, accountId, peerId,
   bootstrapJwt, registration:{ devicePrivateKey: popKeyPair.privateKey, deviceX25519PrivateKey: x25519.privateKey } })`
   → connect. **(N2 정정: `devicePrivateKey`가 Ed25519 PoP 키 — `devicePopKeyPair` 필드는 없음.
   `nats-client.ts:106-119`.)**
   - `registration`/`natsCredentials`는 ctor 교차타입으로 구조적 수용(리터럴이 widget.ts:194-208과 동일하게
     excess-property 통과; 타입명 미노출은 cosmetic, client 무변경).
6. **무에이전트 종단 상태(F1/F8)**: connect(NKEY auth) → `status:"connected"` 도달 → PoP register가 에이전트
   부재로 ~15초 후 타임아웃 → 종단 `status:"error"`(sticky, 재시도 불가). 앱이 **`state.error` 문자열로 분기**
   (무에이전트 = `"[nats-client] request timeout"`; JWT 거부 = `"...unauthorized"`) → **"⏳ 에이전트 대기 —
   openclaw를 붙이고 재시도"** + [재시도] 노출. 붉은 에러 박스 노출 안 함.
   - **[재시도] = 전체 재인증(N4/F1c)**: bootstrap JWT는 기본 TTL 300s(`bootstrap-claims.ts:88`)라 단순 client
     재생성만으론 만료 JWT를 제시할 수 있음 → device 키 재생성 + `/bootstrap` + `/nats-user` 재수행 후 새 client
     (= widget.ts `connectLane` 패턴 전체).
   - ※ `state.error` 문자열 매칭은 **데모급 계약**(래퍼가 `err.name`을 평탄화). 앱 코드에 그 취지 주석.

## 6. 인증 (BYO)
`server/users.ts`: 시드 유저 1~2명 + 최소 검증. "실제로는 당신의 IdP/DB를 꽂으세요" 주석. 패키지 내부
`demo-users` 재사용 안 함(자족성).

## 7. 에이전트 연결 (openclaw = 사용자 영역)
`run.sh`는 build → SaaS → nats-server만 띄우고 **에이전트 붙이는 명령을 안내 출력**
(`openclaw channels add … / openclaw gateway …`). 데모가 openclaw를 부팅하지 않는다.

## 8. 실행 흐름 (`run.sh`)
`npm run build -w packages/saas -w packages/client` → server(tsx) → (natsConfig로) nats-server → 안내 출력.
(F3: 빌드 선행 필수 — dist가 gitignore이고 exports가 dist만 가리킴. stale-dist 방지 위해 매 실행 build.)

## 9. 검증 계획
1. **typecheck** — webchannel-app + 워크스페이스 + 기존 demo 모두 그린(dist 빌드 선행).
2. **no-internal-imports 테스트** — 앱 소스에 `../packages/`·딥 서브패스 0건 정적 assert. (런타임 exports 차단
   보증은 `examples/minimal-consumer/test/boundary.test.mjs`가 이미 담당 — 중복 작성 금지, 참조만.)
3. **런타임 스모크(상태 시퀀스, F8/N3/N4)** — build → server+nats-server 부팅 → 로그인 →
   `/bootstrap`+`/nats-user` 유효 응답 → `WebChannelNATSClient` 생성 → 순서대로 assert:
   **① `status:"connected"` 도달** → **② 종단 `status:"error"`가 connected 후 ~10초 이후 도착하고 메시지가
   `"[nats-client] request timeout"`**(=register 시도가 있었음의 *추론* — "register in flight"는 공개 관측
   불가하므로 타이밍+메시지로 검증, N3) → **③ 앱 분류기 `classify(state)==="waiting-for-agent"`**. 이를 위해
   `web/app.ts`가 순수 함수 `classify(state)`를 **export**해 Node 스모크가 직접 호출(헤드리스 브라우저 불필요, N4).
   단순 "connected" 단정 금지(~15초 뒤 종단 전환으로 flaky/오해). nats-server 바이너리 없으면 스킵+안내.
4. **회귀 없음** — saas/client 기존 스위트 + 기존 demo typecheck 유지.

## 10. 리스크 / 오픈 이슈
- **레지스트리 실설치는 PAT 게이트**: 패키지명 import는 워크스페이스 심링크→exports 맵으로 해석되어 게시
  계약과 동일 검증. read:packages PAT 생기면 실제 `npm i`로 최종 확인(별도 단계, 현재 비목표).
- **nats-server 바이너리** 필요(로컬 부팅). 없으면 스모크 스킵+안내(기존 demo 정책과 동일).
- **드리프트(F7)**: 새 서버는 `demo/saas-server.ts` 제품 경로의 상당 부분 재구현. 완화책: (a) 새 앱을 **제품
  경로의 canonical 레퍼런스**로 선언하고 기존 demo README가 이를 가리키게, (b) 공용 픽스처 최소화. 유지비를
  명시적으로 수용.
- `userSeedRaw`/`getRawSeed()` upstream nkeys 부채(§2.1) — 문서화 후 감수.
- `registration` 타입명 미노출은 cosmetic(구조적 수용). 소비자 DX가 더 필요하면 후속에서 client가 타입만
  export(그때 client bump).

## 11. 작업 분해 (opus implementer 위임용)
1. `packages/saas`: `issueBrowserCredentials`+`BrowserCredentials`/옵션 타입, `createBootstrapIssuer`+`BootstrapIssuer`
   추가 → 배럴 export. `mintNatsUserCreds`/roles 비공개 유지. `isValidSubjectToken` 추가 안 함. saas 0.1.2 bump.
2. `examples/webchannel-app/` 신규(§3) — server/web/run.sh/README, 전부 공개 API·패키지명 import, 전체 플로우(§4/§5).
   반드시 반영: **`/bootstrap` 세션 게이트+peerId=세션+accountId 인가(N1)**; **registration `devicePrivateKey`
   필드(N2)**; **X25519 non-extractable**; **[재시도]=전체 재인증(N4)**; **devDeps에 tsx/esbuild/typescript**;
   **`web/app.ts`가 `classify(state)` export**(스모크용).
3. `test/no-internal-imports.test.mjs`(앱-소스 정적 체크만) + typecheck 세팅. 런타임 exports assert는 minimal-consumer 참조.
4. 검증(§9) — 스모크는 **상태 시퀀스 ①→②(타이밍+메시지)→③(classify)**로(N3/N4). 실행 후 보고.
   **커밋/게시/기존 `demo/` 변경 금지** — 리뷰용 워킹트리로.

---
### 개정 이력
- **v2** — v1 적대리뷰(F1~F9) 반영: 전체 production 플로우 채택 + `createBootstrapIssuer` 공개 추가.
- **v2.1** — v2 재-적대리뷰(fable-5): crux(공개 API만으로 full-flow 구성 + client 무변경 + 무에이전트 대기상태)
  **YES 확정**. 텍스트 수정 5건 반영 — N1 `/bootstrap` 인가 게이트(보안), N2 `devicePrivateKey` 필드명,
  N4 [재시도]=전체 재인증 + 스모크 ②/③ 재정의, JWKS/kid 정합 문서화, devDeps(tsx/esbuild). 아키텍처 변경 없음.
