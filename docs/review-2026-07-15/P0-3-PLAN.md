# P0-3 Implementation Plan — BYO-NATS authenticated registration 단일화

> Spec: `docs/review-2026-07-15/P0.md` §P0-3. **r6** (TechLead; codex gpt-5.6-sol
> 적대 리뷰 R1 B3+M5+M1 → R2 B1+M2+m1 → R3 B1+M2+m1 → R4 B1+M1+3NIT →
> R5 M2+NIT(role:"agent"은 신설 아닌 기존 코드 강화—서버강제 TTL+exp 테스트;
> anti-drift 추출을 client 패키지 reginbox까지 확장; PID-reuse 가드) 전량 반영).
> Status: DRAFT — codex R6 대기.
>
> 선행: P0-1 (gateway-WS 제거, `806c1a6`), P0-2 (auto-admission/handshake 삭제,
> `e7991b9`), P1-1 (agent key registry v2, `895b8e0`) — 모두 review 머지 완료.
> P0-2가 static-creds 계정을 fail-loud로 막아둔 seam
> (`nats-credential-source.ts:242-254` throw + `:256-315` unreachable 리졸버 블록)이
> 이 계획의 landing site다.

## 1. Goal and invariants

**제품 계약 (P0.md).** BYO-NATS는 relay 선택권이지 인증 생략 옵션이 아니다.
Self-hosted, Synadia, 기타 managed NATS 모두 **동일한 application identity와 key
attestation**을 사용한다.

**Invariants (변하지 않는 것):**

- I1. register-hop은 유일한 peer admission 경로다 (P0-2). P0-3은 admission 경로를
  추가하지 않는다 — credential source(Axis A)만 넓힌다.
- I2. attested agent identity 없이 serve하지 않는다. `index-nats.ts:496-502`의
  fail-closed 가드는 모든 credential source에 대해 유지된다.
- I3. application-layer 검증(JWT+PoP+attested-key wrap)은 broker permission이
  올바르다는 가정으로 생략되지 않는다. broker scoping은 방어심화(anti-DoS/noise),
  crypto가 primary boundary.
- I4. relay는 ciphertext만 관찰한다. key-substitution은 어느 relay에서든 양방향
  fail (browser: pinned `agentPublicKey`로만 unwrap 유도; agent: PoP+JWT 검증).
- I5. wire/protocol 변경 없음 (frame 11/4 유지, protocol version 1 유지).
  register 검증 **로직**은 변경 없음 — explorer 검증: register 경로는
  credential-source-agnostic이며, static 모드가 막힌 유일한 이유는 identityKey
  공급 slot이 없기 때문. (단, D6-1 shared-audience fail-closed와 D6-5 PoP
  opt-out 제거는 **serve-여부/config 계층** 변경이며 register 검증 알고리즘
  자체는 불변.)

## 2. Scope

**In:**
1. static credential source 재활성 — attested identity를 enrollment에서 공급받는
   identity/transport split + **전용 identity accessor** (D1).
2. BYO 운영 계약 — permission template의 exported contract화(allow+deny 완전형)
   + preflight probe(프로토콜 배리어 포함) + over-broad 진단 (D3, D4).
3. Live harness parity — self-hosted enrolled / static-BYO / external-account
   3-mode가 같은 registration suite(적대 레그 포함)를 공유 (D5).
4. Binding-gap disposition — shared-audience **collision-set 전체** fail-closed,
   `requirePoP:false` opt-out 제거 (D6).
5. Schema/docs flip — "static is rejected until P0-3" 문구 해제, BYO 운영 문서 (D7).

**Out (명시):**
- 브라우저 NATS creds의 SaaS-외 발급 체계 구축. 브라우저 creds는 SaaS-mint가
  유일 지원 경로로 유지된다(self-contained 또는 external `issuerAccountId` 모드,
  둘 다 이미 구현+테스트: `external-nats-account.test.ts`). 운영자가 직접 배포하는
  경우는 template 준수 전제의 **문서화된 tolerated 구성**이며 도구는 만들지 않는다
  (Q2 — 사용자 회부, 권고 비범위).
- P1-6 doctor 연동 (PR #39 미머지 — 이 브랜치에 doctor 없음). preflight만 확장.
- agentId 식별자 신설 (D6-4: 현 아키텍처는 account당 단일 agent, attested key가
  곧 agent identity — P1-1 registry가 교체 의미론 제공).
- register 검증 알고리즘 변경 (I5).

## 3. Current-state map (explorer 2-갈래 + TechLead spot-check + codex R1 교정)

### 3.1 Binding 강제 현황 (P0.md 7종 대조)

| # | Binding | 상태 | 근거 |
|---|---------|------|------|
| 1 | JWT sig/iss/aud/exp | ENFORCED | `jwt.ts:208,213,245-301` (RS256 pin, kid 필수, 상수시간 iss/aud, exp+leeway) ← `nats-register.ts:175` |
| 2 | tenant/accountId/peerId | PARTIAL | peerId=`sub` 필수(`jwt.ts:304,354`); accountId는 `aud==accountId`(`index-nats.ts:202`)+subject namespace로 구조적 바인딩; tenant는 present-시-비교(`nats-register.ts:194`, P0-2 A4) |
| 3 | device pubkey + PoP | ENFORCED* | `cnf.jwk` 완전검증(`jwt.ts:306-348`); PoP 기본 ON(`register-pop-gate.ts:16-18`), 단회 nonce(`nats-register.ts:229-258`). *`requirePoP:false` opt-out 존재 → D6-5가 제거 |
| 4 | agentId + attested key | PARTIAL(설계상) | agentId 부재; attested key = P1-1 registry active key, browser가 bootstrap에서 pin(`saas-bootstrap.ts:287-301`) 후 pinned key로만 unwrap(`late-join-decryptor.ts:287-296`) |
| 5 | subject peer == claim peer | ENFORCED | `nats-register.ts:202` (+unregister `:152`), `assertValidSubjectToken` `:213` |
| 6 | reply == 요청자 reginbox | ENFORCED | `nats-channel.ts:707-722` reginbox prefix allowlist |
| 7 | NATS cred perms == identity | **SaaS-mint 경로만** | mint는 올바름(`nats-user-creds.ts:146-176`); plugin은 broker 강제 여부를 **검증하지 않음** — preflight는 JWKS+dial+자기 subtree sub만(`preflight.ts:424-431`) |

**Pre-register no-turn**: `peerSessionKeys`는 register만이 writer, 키 없는 inbound
drop(`nats-channel.ts:735-740`) → dispatch 미도달. **Key-swap**: pinned-key 유도 +
AAD(peerId) + Poly1305 (`late-join-decryptor.ts:287-296`).

### 3.2 Credential source seam

- 리졸버 throw: `nats-credential-source.ts:242-254`. 그 아래 `:256-315` = 완성돼
  있으나 unreachable한 static 리졸버 블록 (P0-3 landing site, 주석 명시).
- `consumeCredentialSource`(`consume-credentials.ts:80-126`): **enrolled 모드도
  static 커넥터로 dial한다** — persisted `{userJwt,userSeed}` + `natsUrl ?? source.url`.
  enrolled가 static 대비 더 갖는 것은 `identityKey` 반환(`:120-125`) 하나뿐.
- 영속 shape (`~/.openclaw-webchannel/<account>/credentials.json`,
  `enrollment-client.ts:130-151`): top-level `identityKey{publicKey,privateKey}`
  (base64url X25519, 32B 검증 `account-config.ts:477-491`),
  `enrollment.{creds{userJwt,userSeed},natsUrl,issuer}`.
- **[codex R1-4 교정]** `loadPersistedEnrolledCreds`는 `enrollment.creds.userJwt`
  + `userSeed`가 **둘 다 비어있지 않아야만** 무엇이든(identityKey/issuer 포함)
  반환한다(`account-config.ts:438-464`) — identity가 transport-검증 accessor에
  **결합**돼 있다. `index-nats.ts:359`의 issuer 소비도 같은 결합 loader 경유.
  → D1이 전용 identity accessor로 분리한다.
- 스키마: `openclaw.plugin.json:188-249`; `credentials.mode` enum
  `["static","enrolled","open"]`, "static is rejected until P0-3" 문구 `:210-213`.
  `assertNoRemovedConfig`(`account-config.ts:184-208`)는 static을 거부하지 않음
  (리졸버 throw가 유일한 차단 — Layer 2). Layer 1 변경은 D6-5(requirePoP)만.
- 테스트: `nats-credential-source.test.ts:157-168` static-signal 5케이스 throw
  단언 → flip 대상. **[codex R1-8 교정]** `:67`의 legacy static 리졸버 상세
  suite는 `describe.skip` — **현재 실행되지 않는다**. static 재활성과 함께
  **un-skip + 현행화**가 필수 (silent-skip 재발 방지의 핵심).

### 3.3 하네스/preflight 현황

- 하네스 4종(`e2e/local/run-{all-real,enrolled-transport,derived-trust,two-account-isolation}.sh`)
  전부 self-hosted 로컬 nats-server + device-flow 전용. static/BYO/Synadia 토큰
  등장 0회. 공유 드라이버 `all-real.mjs`는 2개 하네스가 재사용 — 파라미터화 가능.
  **[codex R1-9]** `all-real.mjs`의 단언은 echo 왕복(happy-path)뿐(`all-real.mjs:
  111-135`) — 적대 레그는 D5가 추가.
- SaaS external-account mint(`issuerAccountId`+signing key, `issuer_account` stamp)는
  **JWT shape 수준**으로 구현+테스트(`nats-user-creds.ts:178-200`,
  `external-nats-account.test.ts:27-67,106-123` — operator/account JWT·resolver
  구성은 의도적으로 미발행). 라이브 재현은 D5 Mode C가 신규로 만든다 (feasibility
  체크포인트 포함 — R1).
- preflight Gate A(`preflight.ts:248-314,373-452`): issuer/aud 일관성 + JWKS + relay
  dial(자기 subtree `_preflight` sub). **permission-set 검증/over-broad 진단 없음.**
  **[codex R1-5 교정]** Gate A API(`RunAddPreflightOptions`, `preflight.ts:334-358`)는
  enrollment 번들만 받고 resolver 입력(natsConfig/legacyNats/env)이 없다 — dial도
  `opts.enrollment.*`로 수동 구성(`:463-482`). D4가 API를 재설계한다.
  **[codex R1-2 교정]** `-ERR Permissions Violation`은 **비동기 error 이벤트**
  (`nats-transport.ts:388`; `subscribe()`/`publish()`는 동기 성공 —
  `nats-transport.ts:424,454`)이고 현 preflight는 그 이벤트를 기다리지 않는다
  (`preflight.ts:487-493`). 동기 성공/실패로 probe 판정 불가 — D4가 PING 배리어를
  설계한다.

## 4. Design decisions

### D1 — Identity/transport split: 전용 identity accessor + enrollment 필수, static은 transport만 교체

**결정.** register-hop 계정은 credential source와 무관하게 **enrollment
(`channels add`)가 필수**다. enrollment이 영속화하는 것 중:

- `identityKey` + `issuer` = **application identity 재료** — 모든 모드가 사용.
- `enrollment.creds{userJwt,userSeed}` + `natsUrl` = **transport 재료** — enrolled
  모드만 사용; static 모드는 이를 **전부 무시**하고 config/env의 static 재료로 대체.

구현:

1. **신규 전용 accessor** (`account-config.ts`):
   `loadPersistedAgentIdentity(accountId, opts?) → { identityKey: KeyPair; issuer?: string } | undefined`.
   `credentials.json`에서 `identityKey`(기존 32B 검증 `parseIdentityKey` 재사용)와
   `enrollment.issuer`만 읽는다 — **transport 재료(userJwt/userSeed) 존재 여부와
   무관** (codex R1-4: 기존 `loadPersistedEnrolledCreds`는 transport 재료가 없으면
   identity도 안 내놓는 결합 loader). `loadPersistedEnrolledCreds`는 enrolled
   transport 소비용으로 유지하되, 내부에서 identity 파싱을 공유 헬퍼로 위임해
   두 accessor가 drift하지 않게 한다.
   - `index-nats.ts:359`의 issuer 소비를 신규 accessor로 교체 — enrolled transport
     재료가 손상/삭제돼도 identity/issuer 체인은 살아있다 (static 모드의 전제).
2. `nats-credential-source.ts:242-254`의 static-signal throw 삭제. `:256-315`
   블록이 그대로 live가 된다 (블록 상단 "UNREACHABLE until P0-3" 주석 갱신).
   리졸버 자체는 identity를 모른다 — split은 consume 계층의 일이다.
3. `consume-credentials.ts` static 분기(`:85-88`) 재작성:
   - `loadPersistedAgentIdentity(accountId)`로 identity 로드.
   - 있으면 → static 재료로 connect + `identityKey` 반환 (enrolled 분기와 동일한
     반환 shape).
   - 없으면 → **연결하지 않고** (transport factory 미호출) 신규 구조화 결과
     `{ status: "identity-missing", accountId }` 반환. (기존 `creds-missing`과
     구분: remediation이 다르다 — "static creds는 transport만 교체한다; attested
     identity가 필요하니 먼저 enroll하라".)
   - dial URL = `source.url` (리졸버 체인: env `WEBCHANNEL_NATS_URL` > `nats.url` >
     legacy > default). **persisted `natsUrl`은 static 모드에서 참조하지 않는다**
     — static = 운영자가 transport를 전부 소유한다는 명시적 선언.
4. `index-nats.ts:411-421` consume 결과 처리에 `identity-missing` 분기 추가:
   account-scoped skip + actionable log (P0-2 degradation 모델 동일). `:496-502`
   F2 가드는 backstop으로 유지 (belt-and-suspenders).
5. readiness (Gate B, `formatAccountReadiness`): credential source mode
   (`static`/`enrolled`)와 effective dialed URL을 readiness 라인에 노출.

**왜 이 모양인가.** register 경로는 source-agnostic이므로 identity만 공급되면
등록·wrap·pin 체인이 바이트 동일하게 동작한다. enrolled 경로가 이미 static
커넥터로 dial하므로 transport 계층엔 신규 코드가 사실상 없다. attestation 사슬
(P1-1 registry → bootstrap 배달 → browser pin)도 무변경 — SaaS가 identity
권위라는 계약(I3)이 유지되고 relay 반쪽만 BYO로 열린다.

### D2 — 브라우저 creds는 SaaS-mint 유지; BYO relay의 지원 경로는 external-account 위임

(r1과 동일 — 변경 없음.)

- (a) **self-hosted relay가 SaaS 계정 신뢰를 preload** (현 하네스 모델), 또는
- (b) **external/managed account** — 운영자가 자기 NATS account의 signing key를
  SaaS에 위임(`issuerAccountId` seam), SaaS가 그 계정 명의로 per-peer scoped
  browser creds를 mint (`issuer_account` stamp). Synadia/NGS shape.

운영자가 SaaS를 우회해 브라우저 creds를 직접 배포하는 구성은 금지하지 않되
(I3 — app-layer가 primary boundary), **template 준수 전제의 tolerated 구성**으로
문서화만 한다. 도구/발급기는 비범위.

**왜.** 브라우저 creds mint에는 peerId-scoped grant가 필수인데(`webchannel.
{tenant}.*.{peerId}.>`), peerId는 SaaS 로그인이 authenticate하는 값이다. SaaS 외의
발급자는 이 인증 사슬을 재구축해야 하며 그것은 P0-3 범위를 넘는다. 기존
external-account seam이 정확히 이 문제를 위임 서명으로 푼다.

### D3 — Permission template: allow+deny 완전형 canonical 계약 + JWT-claim 기반 parity 테스트

**결정 (codex R1-7 반영).** 신규 모듈 `packages/plugin/src/nats-permission-template.ts`:

```ts
/** NATS user JWT의 permissions 클레임과 같은 shape — allow/deny 완전형. */
export type SubjectPermissionSet = {
  pub: { allow: string[]; deny: string[] };
  sub: { allow: string[]; deny: string[] };
};
/** BYO-NATS 운영자가 broker에 설정해야 하는 subject grant 계약. */
export function requiredNatsPermissions(tenant: string): {
  agent: SubjectPermissionSet;                       // pub/sub allow: webchannel.{tenant}.>
  browser: (peerId: string) => SubjectPermissionSet; // …*.{peerId}.>
  observer: SubjectPermissionSet;                    // sub allow 전체 + pub.deny: [">"]
};
export function formatPermissionTemplate(tenant: string): string; // 사람용 출력
```

- **observer의 deny-all은 `pub.deny: [">"]`로 표현** — mint 구현과 동일
  (`nats-user-creds.ts:148-176`; 빈 allow-list는 NATS에서 deny-all이 **아니다**).
  `mintNatsUserCreds`의 반환 projection(`permissions.pub: []`,
  `nats-user-creds.ts:202`)은 deny를 소거하므로 parity 기준으로 **쓰지 않는다**.
- **Parity는 repo-root 공유 fixture로 고정한다** **[codex R2-2 반영 — r2의
  "plugin barrel export + saas devDep" 철회]**. 철회 사유: plugin은
  `exports`/`main`/`types`가 없는 번들-전용 패키지(`packages/plugin/package.json:1`
  — 빌드 산출물은 `index-nats.js`/`setup-entry.js`뿐, `:40`)라 import 가능한
  라이브러리 표면이 없고, 이를 만들려면 subpath export + 선언 빌드 + files +
  pack 검증의 패키징 공사가 필요하다. 운영자는 template을 **import가 아니라 CLI
  출력/문서로** 소비하므로 (P0.md의 "제공한다"는 CLI/docs로 충족) 공개 API 승격은
  과잉이다. 대신:
  - **canonical fixture**: `contracts/nats-permissions.v1.json` (repo root, 신규)
    — 고정 샘플 값(`tenant="t1"`, `peerId="p1"`, `accountId="a1"`)에 대한
    agent/browser/observer 3-role의 `SubjectPermissionSet` 완전형(allow+deny).
  - **plugin 쪽 테스트**: `requiredNatsPermissions("t1")` 산출 == fixture
    (fs로 fixture 읽기 — cross-package import 없음, tsconfig/패키징 무접촉).
  - **saas 쪽 테스트**: `mintNatsUserCreds(...)` 산출 **JWT claim 디코드**
    (`nats.pub.{allow,deny}`/`nats.sub.{allow,deny}`; 디코드는
    `external-nats-account.test.ts` 방식 재사용) == fixture, 3-role 각각.
  - 이행성으로 template == mint가 고정된다. mint가 바뀌면 saas 테스트가,
    template이 바뀌면 plugin 테스트가 부러진다. 순환/의존 추가 0.
  - **fixture 거버넌스 [codex R3(R2-2 후속) 반영]** — "셋이 함께 표류"를 막는
    현실 앵커:
    - **subject-coverage 테스트 (plugin)**: 런타임이 실제 사용하는 subject
      집합(`.register`/`.reginbox.*`/`.in`/`.out`/challenge 등 —
      `nats-channel.ts`의 subject 빌더에서 도출)을 열거해 각각이 template
      grant에 **매칭됨**을 단언 — template이 현실 subject와 어긋나면 fixture와
      일치해도 부러진다.
    - **실서버 매트릭스 (기존 확장)**: `nats-permissions-realserver.test.ts`에
      template-도출 positive/negative 케이스 추가 — template대로 mint된 creds가
      허용 subject는 통과, 비허용 subject(타 peer subtree, tenant 밖)는 거부됨을
      실 nats-server로 확인.
    - **[codex R4-2 반영]** JSON은 주석이 없으므로 소유권/버전은 fixture 안의
      **`_meta` 속성**으로 담는다(`{ "_meta": { "source": "plugin
      requiredNatsPermissions", "version": "v1", "bumpRule": "..." }, "agent":
      {...}, "browser": {...}, "observer": {...} }`). 양측 parity 비교는 `_meta`를
      **제외한** payload로 수행(테스트가 명시적으로 strip). grant 의미 변경 시
      `v1`→`v2` 파일명 bump + 양측 테스트 동시 갱신.
    - **[codex R4-2 반영] subject-coverage는 반드시 공유 빌더에서 도출**한다 —
      현재 subject 문자열은 `nats-channel.ts:317`(register wildcard)/`:595`
      (outbound)/`:707`(reginbox prefix)에 **인라인**돼 있어, 테스트가 문자열을
      손으로 복제하면 실제 빌더와 독립적으로 표류해 anti-drift 목적을 무력화한다.
      → S3에서 이 subject 조립을 **exported 빌더 함수**(예: `subjects.ts`의
      `registerSubject(t,a,p)`/`outSubject(...)`/`reginboxPrefix(...)`)로
      추출하고 런타임·template-coverage 테스트가 **같은 함수**를 소비한다
      (인라인 문자열 신설 금지). 이 추출이 subject-coverage 테스트의 전제.
    - **[codex R5-1 반영] client 패키지도 반드시 포함**한다 — plugin만 추출하면
      절반이다. `packages/client/src/nats-client.ts`는 **독립적인** subject
      빌더(`registerSubject`/`inboundSubject`/`outboundSubject`, `:829-848`)와
      **미factored 인라인 reginbox prefix**(`:1120`,
      `webchannel.${tenant}.${accountId}.${peerId}.reginbox`)를 갖는다 —
      가장 보안 민감한 reply 채널이다. plugin만 커버하는 테스트는 client가
      template/reply-allowlist가 더는 안 받는 subject로 표류해도 green으로 남는다.
      두 안 중 택1: **(A) 진짜 cross-package canonical subject 모듈**을
      client·plugin 양쪽이 소비(가장 강함 — 단일 진실원), 또는 **(B) client-side
      coverage 테스트를 별도로** 두되 client의 reginbox 조립도 함께 추출·검사.
      구현 시 두 패키지가 이미 공유하는 저수준 모듈이 있으면 (A), 없어서 신규
      의존이 필요하면 (B)로 — 어느 쪽이든 **client reginbox가 반드시 커버**돼야
      한다 (S3 완료 기준).
    - 위치: repo-root `contracts/`는 신규 관례다(기존 전례는 package-local
      `packages/saas/src/fixtures/pre-p1-1-wire-shapes.json`) — 두 패키지가
      **같은 파일**을 읽어야 하는 첫 사례라 repo-root를 채택하고, 이 결정을
      fixture 헤더에 명기 (구현 시 more idiomatic한 공유 위치가 발견되면 교체
      가능 — 의미는 경로가 아니라 단일-파일 3자 일치에 있다).
- `formatPermissionTemplate` 출력처: (1) `channels add`에서 static 모드 감지 시
  안내 출력, (2) preflight FAIL/WARN 진단 메시지, (3) docs BYO 섹션(D7).

### D4 — Preflight: PING-배리어 probe + Gate A API 재설계

**결정 (codex R1-2, R1-5 반영).**

**4a. probe 프로토콜 배리어.** NATS 권한 위반은 비동기 `-ERR` 이벤트다
(`nats-transport.ts:388`). probe 판정은 다음 패턴으로 한다:

1. probe 시작 전 transport에 **임시 error listener 부착**. correlation은
   **[codex R2-4 반영] (operation 종류, 정확한 subject) 쌍**으로 한다 —
   nats-server의 `-ERR 'Permissions Violation for {Publish|Subscription} to
   "<subject>"'`에서 `Publish`/`Subscription` 토큰까지 매칭. subject만으로는 P1
   (sub)과 P2(pub)가 같은 `_preflight` subject를 쓰므로 오귀속 위험.
2. `SUB`/`PUB` 송신 후 **`PING` 송신 → `PONG` 수신 대기** (프로토콜 배리어 —
   서버가 PONG 전에 해당 op의 `-ERR`을 먼저 보낸다; 같은 배리어를
   `nats-permissions-realserver.test.ts:630-642`가 이미 신뢰) + 타임아웃(기본 2s).
3. 판정: PONG 전 correlate된 `-ERR` 수신 = **거부됨**; PONG까지 무-ERR = **허용됨**.
4. **probe는 한 transport에서 반드시 순차 실행** (P1→P2→P3; 동시 진행 금지 —
   같은 error 채널(`nats-transport.ts:388`)에 섞이면 correlation이 깨진다).
   각 probe는 **자기 배리어 완료 후** cleanup: 임시 listener 제거 + probe sub
   `UNSUB`. disconnect는 마지막 probe의 배리어 후에만 (기존 `finally` 즉시
   disconnect가 서버 응답을 race-out시키는 문제 — `preflight.ts:487-493` — 해소).
   - `NatsTransport`에 PING/PONG 왕복이 노출돼 있지 않으면 최소 seam
     (`flush(): Promise<void>` 또는 protocol-event hook)을 추가한다 — transport
     변경은 이 seam 하나로 한정.

probe 3종 (모든 source mode 공통 — enrolled에도 이득):
- **P1 dial + 자기 subtree sub** (기존 `_preflight` sub 유지, 배리어 판정으로 강화):
  거부되면 FAIL + template 인용.
- **P2 agent pub probe**: `webchannel.{tenant}.{accountId}._preflight`로 publish —
  거부되면 FAIL + template 인용 (agent grant의 pub 반쪽).
- **P3 foreign negative probe**: `_webchannel_preflight_foreign.{random}`
  (webchannel 네임스페이스 밖) subscribe — **허용되면** over-broad **WARN**
  (FAIL 아님: 기능은 하되 격리 보증 약화 — BACKLOG의 cross-peer error-string
  leak 리스크 인용). 거부가 기대값.

**4b. Gate A API 재설계.** 현 `RunAddPreflightOptions`(`preflight.ts:334-358`)는
enrollment 번들만 받는다. 변경:

- `RunAddPreflightOptions`에 **resolver 입력**을 추가: `natsConfig`(account의
  `nats` 블록), `legacyNats`, `saasBaseUrl`(raw), `env`(주입 가능), `accountId`,
  `tenant`.
- Gate A의 relay-dial 단계는 `resolveNatsCredentialSource` +
  `consumeCredentialSource`를 **런타임과 동일하게 호출**한다 — enrolled 모드는
  지금과 같은 재료로 dial되고(동작 보존), static 모드는 **실제 서빙에 쓸 static
  재료로** dial된다. 수동 static-source 구성(`preflight.ts:463-482`)은 이 호출로
  대체. 이렇게 해야 "런타임과 같은 코드가 같은 판단"이라는 주장이 **API 수준에서
  사실**이 된다 (codex R1-5: r1의 주장은 현 API에선 거짓이었다).
- `channels add` 호출부는 방금 enroll한 계정의 config를 로드해 위 입력을 채운다.
- **한계 명시 (R2)**: add-time env와 run-time env가 다르면 static 해석이 달라질
  수 있다 — 진단 라인에 "add-time env 기준" 명시, Gate B readiness가 run-time
  effective 값(mode/URL)을 재표시해 보완 (D1-5).

**4c. 한계 명시 (browser-creds).** 브라우저 creds는 plugin이 볼 수 없어 probe
불가. over-broad **browser** grant는 도구로 검출하지 않으며, template 문서 +
add-time 안내로 계약을 표면화한다 (Q2 — 권고 비범위).

### D5 — Live harness: 3-mode가 같은 registration suite(적대 레그 포함) 공유

**결정.** `all-real.mjs` 드라이버를 **transport provisioning 파라미터화 + 적대
레그 추가**로 확장하고, 신규 하네스 `run-byo-static.sh`(Mode B)와
`run-external-account.sh`(Mode C)를 추가. Mode A = 기존 `run-all-real.sh`.

**공유 suite 확장 (codex R1-9 + R2-3 구체화).** `all-real.mjs`에 negative-leg
모듈 추가 — 3-mode 전부에서 실행, **N1-N3 전부 필수** (escape hatch 없음).

- **raw 테스트 API (전제)**: 현 드라이버는 happy-path 1콜뿐이고
  (`all-real.mjs:111`) browser entry는 production client를 즉시 구성한다
  (`browser-jwt-entry.ts:258`) — raw publish/register 주입 수단이 없다. 신규
  node-측 헬퍼 **`e2e/local/raw-probe.ts` — `node --import tsx`로 실행**
  **[codex R3-3 반영]**: plain `.mjs`는 빌드된 `nats-transport.js`가 없어 raw
  import가 불가하고, tsx 경로는 기존 정확한 전례가 있다
  (`enrolled-transport-roundtrip.ts:28`을 `run-enrolled-transport.sh:336`이
  `node --import tsx`로 구동). SaaS `/test/nats-user`로 mint한 browser creds
  (N1/N2, 그리고 N3의 MITM 커넥션도 **피해자 peerId의 browser creds** — D5 N3
  참조, 신규 mint 권한 불요)로 **raw `NatsTransport`**를 열어 임의 subject
  publish / register request(2-phase) / reginbox 구독을 수행. production client
  무접촉 — suite가 이 헬퍼로 N1-N3를 구동.
- **SIGSTOP fail-safe (전제)** **[codex R3-2 반영]**: N3의 gateway 일시정지는
  누수 시 self-hosted 단일 runner를 영구 점유하는 운영 리스크다. 계약:
  (a) 하네스가 `GW_STOPPED` 상태 플래그를 유지, (b) N3 전체를 trap/finally로
  감싸 **어떤 종료 경로든 무조건 `kill -CONT $GW_PID`를 cleanup의 TERM보다
  먼저** 실행 (stopped 프로세스는 TERM/pkill로 죽지 않는다 —
  `run-all-real.sh:53,74`의 현 cleanup은 그대로면 좀비 유발), (c) 재개 후 pid
  liveness 확인, (d) cleanup 최후단에 SIGKILL fallback. **[codex R4-4]** 이
  최종 SIGKILL(및 그 앞의 `kill -CONT`)은 `GW_STOPPED` 플래그와 **무관하게
  무조건** 실행한다 — STOP과 플래그 세팅 사이에 시그널이 끼어드는 race를 닫으려면
  cleanup이 플래그를 신뢰해선 안 된다(플래그는 진단용일 뿐). **[codex R5-3 NIT]**
  단, 정상 `wait` 성공 후엔 `GW_PID`를 비워 PID 재사용 프로세스에 오시그널하는
  것을 막는다(또는 fallback 시그널 전 liveness/identity 확인).
- **계정 B 프로비저닝 (전제)**: N2는 두 번째 서빙 계정이 필요하다. **3-mode
  하네스 모두 계정 2개(distinct aud=accountId)를 enroll+서빙**한다 — 2-계정
  구성은 `run-two-account-isolation.sh:211` 전례(한 gateway 기동 전 순차
  enroll)가 있고, D6-1 pre-pass의 "distinct aud는 정상 serve" 확인도 겸한다.
  주의: 여기서 "계정 2개"는 **application-layer** 계정(bootstrap JWT `aud`가
  다른 두 accountId)이지 NATS resolver 계정이 아니다 — Mode C에서도 **하나의
  external NATS account가 두 application namespace를 전송**하면 충분하다
  (codex R3 확인). browser creds의 grant는 accountId 세그먼트가 `*`
  (`nats-user-creds.ts:161`)라 계정 B subject로의 publish가 broker를 통과한다
  — 그래서 **app-layer 검증이 정확히 시험 대상**이 된다.
- **N1 pre-register no-turn**: raw-probe가 register 없이 계정 A peer subject
  `…{peerId}.in`으로 (유효 browser creds로) ciphertext-형 payload publish.
  판정 2축: (a) gateway 로그에 `no registered session key` drop 라인, (b) 이후
  타임아웃 창 동안 해당 peer로 outbound frame 0건 + echo 응답 부재 (turn 미생성).
- **N2 wrong-binding 401**: 계정 A용으로 mint된 bootstrap JWT를 **계정 B
  subject**의 `.register`에 raw-probe로 제시 → reply status 401 (aud 불일치).
  D6-3 negative의 라이브판.
- **N3 active-relay key-swap (결정적 MITM 시뮬레이션)** **[codex R3-1 반영 —
  2-phase 프로토콜 계약]**: "active relay"의 능력 = 임의 subject pub/sub —
  **피해자 peerId의 browser-scope creds** 커넥션으로 재현한다 **[codex R4-1
  반영 — tenant-wide creds 불필요]**: MITM에게 필요한 능력은 피해자 peer의
  `.register` 구독 + `.reginbox.*` 발행뿐이고, 둘 다 browser grant
  `webchannel.{tenant}.*.{peerId}.>`(`nats-user-creds.ts:171-172`) 안이다.
  기존 `/test/nats-user`로 같은 peerId의 creds를 한 벌 더 받으면 끝 — 신규
  mint 권한 불요, 그리고 "peer subtree 가시성을 가진 relay조차 key-swap
  불가"라는 속성을 더 정확히 모델링한다.
  register는 **같은 `.register` subject 위의 2-phase 흐름**이다:
  `{op:"challenge"}`(`pop-register.ts:229`) → nonce 수신 → `{op:"register"}`
  (`pop-register.ts:254`), 총 3회 재시도(`pop-register.ts:223`) + 요청당 5s
  타임아웃(`nats-client.ts:1121`). 따라서 MITM 계약은:
  1. gateway **SIGSTOP** (유일 응답자 확보) → production client가
     `registerWithPop` 시작.
  2. MITM은 **challenge에도 응답**한다 (유효한 nonce shape) — 이것 없이는
     register phase에 도달하지 못하고 timeout-소진 실패가 되어 **잘못된 이유로**
     통과/실패한다.
  3. register phase에 **공격자 X25519 키로 wrap한 위조 wrappedConversationKey
     reply** 발행.
  4. 단언은 **정확한 cause**로: `onError(..., "secure-channel-failed")` —
     "세션 미수립"/"registration failed" 같은 느슨한 단언 금지 (timeout 실패와
     key-거부 실패가 구분 안 됨). 메커니즘: pin은 존재하는데 attacker-wrapped
     key의 **pinned-key ECDH unwrap이 throw** → catch가 거부+disconnect
     (`nats-client.ts:1237`; missing-pin 검사 `:1219-1230`과 혼동 금지 —
     codex R3-4 인용 교정).
  5. 회복 단언은 **SIGCONT 후 새 client 인스턴스로** — unwrap 실패 경로는
     `disconnect()`를 불러 해당 인스턴스가 terminal이 된다 (같은 인스턴스
     재시도는 회복을 증명하지 못한다).
  6. **드라이버 전제**: 기존 browser entry는 오류 cause를 버리고 `e.message`만
     노출한다(`browser-jwt-entry.ts:281`) — N3 드라이버는 `onError`의 cause를
     보존하는 결과 shape를 사용한다 (raw-probe 쪽 N3 진입점에서 cause 그대로
     전달; production entry 변경 없이 하네스 전용 entry/result로).

**Mode B (static-BYO, self-hosted).** 기존 로컬 JWT nats-server 그대로:
1. `channels add`로 enroll (identity 확보 — D1의 필수 전제).
2. 하네스가 agent용 NATS user creds를 **enrollment 번들 밖에서** 확보한다.
   **[codex R4-1 반영 — mint 권한 설계]**: r4의 "하네스가 nats.conf의 account
   seed로 직접 서명" 전제는 **거짓** — reference enrollment-server는 account
   seed를 절대 내보내지 않는다 (`enrollment-server.ts:94-151`의 명시적 계약:
   public NATS config만 기록; `run-all-real.sh:86,98`도 public 2파일만 소비).
   seed 반출 대신 **test-gated agent-role mint**를 쓴다. **[codex R5-2 교정 —
   이건 신설이 아니라 기존 코드의 강화다]**: `role:"agent"` 경로는 reference
   서버에 **이미 존재**하고(`enrollment-server.ts:961-980`, `ENABLE_TEST_ROUTES`
   게이트 + startup 경고 + per-mint 로그) tenant-wide 권한도 올바르게 부여된다.
   문제는 그 `mintNatsUserCreds()` 호출이 **`ttlSeconds`를 안 넘겨 비만료
   creds를 발급**한다는 것(`nats-user-creds.ts:82,185` — omit → `exp=undefined`).
   따라서 구현은 **신규 옵션 추가가 아니라**: (a) 기존 `role:"agent"` mint 호출에
   **서버가 강제하는 `ttlSeconds`(예: 900)를 주입** — caller-selectable 금지
   (오설정으로 테스트 게이트가 켜져도 무제한-수명 tenant-wide creds가 안 나오게),
   (b) 산출 JWT의 **`exp` 디코드 테스트**로 만료 강제 고정, (c) 기존 test-게이트
   (`ENABLE_TEST_ROUTES`) 재사용. 의미론: static source가 시험하는 속성은
   "transport 재료가 enrollment 번들 밖에서 왔다"이지 서명자가 누구냐가 아니므로,
   이 경로는 "운영자가 nsc로 발급"의 유효한 등가물이다.
3. `WEBCHANNEL_NATS_USER_JWT/_SEED` env 주입 + `credentials.mode:"static"` —
   gateway가 static source로 기동.
4. 동일 suite (echo 왕복 + N1-N3) 실행.
5. **fail-closed 레그**: enrollment 없는 신규 계정 + static creds → 기동 로그에
   `identity-missing` skip 확인 (serve 안 됨).

**Mode C (external-account shape).** **[codex R1-6 반영 — 구체 생성 계획]**
신규 헬퍼 `e2e/local/mint-external-account.mjs`:
1. operator NKEY 생성 → **operator JWT** 인코드.
2. 운영자 account identity NKEY(A…) + **위임 signing key** NKEY 생성 →
   **account JWT** 인코드 (`signing_keys: [signingKeyPub]`, operator 서명).
3. nats.conf 생성: `operator: <operator JWT>` + `resolver: MEMORY` +
   `resolver_preload: { <accountPub>: <account JWT> }` (기존 `run-all-real.sh:
   115-136`의 conf 생성 패턴 확장).
4. SaaS를 `issuerAccountId=<accountPub>` + `accountSeed=<signing key seed>`로 기동
   → browser/agent user creds가 signing-key 서명 + `nats.issuer_account` stamp로
   mint되어 **그 서버에 실제로 CONNECT 가능한지가 이 하네스의 검증 대상**
   (기존 테스트는 JWT shape까지만 — `external-nats-account.test.ts:106-123`).
5. 동일 suite (echo 왕복 + N1-N3) 실행.

- **Feasibility**: **사전 해소** — `@nats-io/jwt`가 `encodeOperator`/
  `encodeAccount`/`encodeUser`를 export함을 TechLead가 실측 확인 (§7 R1).
  **[codex R2-1 반영] Mode C 격하 경로는 없다** — r2의 "대안 (ii) 축소" 문구
  삭제. 실 resolver 라이브 테스트가 실패하면 P0-3이 **막히는 것**이지 수용
  기준이 재정의되는 것이 아니다 (P0.md:215-217 + 본 계획 §8 완료 조건의
  무조건 요구). 인코딩 API 세부가 어긋나면 대안은 (i) account JWT 수동 조립
  (라이브러리 저수준 sign 사용)뿐 — 검증 수준은 동일.
- 실 NGS 연결은 creds 비밀 문제로 CI 비범위 (e2e-nats-relay-seed AC4 전례).
- CI: 신규 하네스는 e2e-gate에 추가하되 self-hosted runner 직렬 큐 고려 순차 실행.

**완료 조건 매핑**: Mode A/B/C가 같은 `all-real.mjs`를 실행한다는 사실 자체가
"같은 registration suite 공유". suite 복제 금지 (drift 방지).

### D6 — Binding-gap dispositions

1. **Shared-audience: collision-set 전체 fail-closed, pre-connect 검사.**
   **[codex R1-1 반영 — r1의 "두 번째만 skip"은 오답]** 충돌한 (issuer,aud)의
   토큰은 **집합 내 모든 계정의 subject에서 verify**되므로 첫 계정만 남겨도
   안전하지 않다. 또한 현 검사 위치(`index-nats.ts:482`, transport 연결 후)는
   naïve skip 시 인증된 live 연결을 누수한다. 설계:
   - serving 루프 **진입 전 pre-pass**: 전체 `plans`에 대해 `deriveAccountAuth`를
     먼저 평가해 normalize된 `(issuer, audience)` 키로 collision map 구성
     (기존 `registerHopAudClaims` 로직을 pre-pass로 이동·확장).
   - 충돌 집합(2개 이상)에 속한 **모든 계정을 skip** — transport를 열기 전에
     결정되므로 연결 누수 없음. 각 계정마다 error-level 로그: 충돌 상대와
     remediation("register-hop 계정마다 distinct audience(=accountId)") 명시.
   - serving 루프 내 기존 검사·경고는 pre-pass 결과 소비로 대체.
   - *제품 콜 Q1 — 사용자 승인 완료 (2026-07-16, fail-closed 확정; 격상 shape는
     codex R1-1로 collision-set 전체 skip으로 강화).*
2. **tenant claim은 present-시-비교 유지** (P0-2 A4 결정 존중 — absent 수용은
   호환성; 구조적 binding이 primary). AUTH.md에 근거 서술 추가만.
3. **accountId는 aud+subject namespace로 바인딩 유지** — 신규 claim 도입은
   wire/mint 변경(I5 위반)이며, aud=accountId mint + subject-scoped creds +
   shared-aud fail-closed(D6-1)로 스펙 의도 충족. 명시 negative 테스트:
   계정 A 토큰 → 계정 B subject 401 (unit + 라이브 N2).
4. **agentId 부재는 설계상 충족으로 문서화** — account당 단일 agent, attested
   key(P1-1 registry active key)가 agent identity이고 browser는 그 key를 pin.
5. **`auth.requirePoP:false` opt-out 제거.** **[codex R1-3 반영 — r1의 "존치"
   번복]** P0.md:203은 device PoP를 필수 binding으로, `:218`은 그 fail-closed를
   요구한다. P0-2 이후 register-hop이 유일한 문이므로 opt-out은 "유일한 문의
   잠금 해제"이고, 문서 경고는 enforcement가 아니다. 설계:
   - `register-pop-gate.ts`의 `resolveRequirePoP`와 `auth.requirePoP` config를
     제거 — PoP는 **무조건 ON**.
   - `requirePoP` 설정이 존재하면 **Layer-1 migration error**
     (`assertNoRemovedConfig` — P0-2 D4/D5 seam과 동일한 방식: `false`는 제거된
     보안 완화이므로 fatal; `true`는 no-op라도 혼동 방지 위해 동일하게 reject,
     메시지에 "PoP는 항상 활성, 키 삭제" 명시).
   - schema에서 `requirePoP` 제거 대신 **deprecated-accepted 유지** (P0-2 교훈:
     스키마가 literal을 받아야 seam의 targeted error에 도달한다).
   - 이 결정으로 §7 Q3는 소멸 (스펙 직접 요구 — 사용자에게 보고로 통지).
   - 기존 `requirePoP:false` 의존 테스트/하네스는 PoP-on으로 재작성 (통삭제
     금지 — P0-2 codex gutting 교훈).

### D7 — Schema/docs flip (P0-2 blind-substitution 교훈 적용)

- `openclaw.plugin.json`: `credentials.mode` 설명에서 "static is rejected until
  P0-3" 해제 → "static = BYO transport; enrollment(identity)는 여전히 필수" 의미로
  재서술. `nats` 블록 설명(`:190`) 동일 취지 갱신. enum에서 `"open"`은 유지
  (migration error 라우팅용 — P0-2 D4 seam 존중). `auth.requirePoP`는
  deprecated-accepted (D6-5).
- 리졸버 throw 메시지 소멸에 따른 문서 참조 정리: "track P0-3" 문구를 인용하는
  문서(README/AUTH/BACKLOG/STATUS 등) 전수 grep 후 **의미 단위로** 갱신 — 자동
  치환 금지 (P0-2 re-review에서 blind-substitution이 보안 서술을 역전시킨 전례).
- 신규 docs: `docs/AUTH.md` 또는 `docs/TRUST_AND_ONBOARDING.md`에 "BYO-NATS 운영
  계약" 섹션 — permission template 전문(observer deny 포함), external-account
  위임 경로, tolerated self-issued browser-creds 구성의 한계, preflight 진단
  목록, requirePoP 제거 마이그레이션 노트.
- CHANGELOG: static-creds un-servable window (P0-2) 종료 + requirePoP 제거 +
  shared-audience fail-closed 격상.

## 5. Stages

1. **S1 — identity accessor + resolver/consume split**: `loadPersistedAgentIdentity`
   신설(+`index-nats.ts:359` 교체), throw 삭제, static 분기 identity 로드,
   `identity-missing` 결과. 테스트: flip 5케이스 + **`describe.skip` legacy suite
   un-skip·현행화** + accessor 단위. (게이트: plugin vitest, "Test Files" 라인
   포함 전체 요약 확인)
2. **S2 — index-nats wiring**: `identity-missing` skip 분기, readiness 라인
   source/URL 노출, **shared-audience pre-pass collision-set skip**(D6-1),
   **requirePoP 제거 + Layer-1 error**(D6-5) + 테스트.
3. **S3 — permission template + preflight**: 신규 모듈(allow+deny 완전형) +
   `contracts/nats-permissions.v1.json` fixture(`_meta` 포함) + 양측(plugin/saas)
   parity 테스트(saas 쪽은 JWT-claim 디코드) + subject 빌더 추출(**plugin
   `nats-channel.ts` + client `nats-client.ts` reginbox 둘 다**) + subject-coverage
   테스트 + Gate A API 재설계 + PING-배리어 순차 3-probe (+ 필요시
   `NatsTransport.flush()` seam). probe/실서버 매트릭스 테스트는 **실 nats-server**
   포함 (`nats-permissions-realserver.test.ts` 전례).
4. **S4 — harness**: raw-probe 헬퍼 + 2-계정 프로비저닝 → suite 적대 레그
   N1-N3(필수) → Mode B/C 하네스 + fail-closed 레그 + e2e-gate 배선.
5. **S5 — schema/docs/CHANGELOG** (D7).
6. **S6 — gates**: typecheck×3, build, guard, pack-smoke, 전체 vitest — **vitest
   요약은 "Test Files" 줄까지 확인, collection failure 0 단언** (P0-2 75-테스트
   무음 미실행 교훈), CI baseline은 **현행 1398**(`.github/workflows/e2e-gate.yml:
   172-206`) 기준으로 완료 후 PASSED 실측치로 상향. 라이브 하네스 Mode A/B/C —
   **TechLead 직접 실행** (codex 샌드박스는 소켓 EPERM으로 라이브 회귀를 못 잡는다).

## 6. Test plan

- **Flip**: `nats-credential-source.test.ts:157-168` 5케이스 — throw 단언 →
  `{mode:"static", url, userJwt, userSeed}` 해석 단언.
- **Un-skip (codex R1-8)**: `nats-credential-source.test.ts:67` `describe.skip`
  legacy static 리졸버 상세 suite(우선순위/부분-secret/creds-file/SecretRef,
  ~:155) — un-skip 후 현행 구현에 맞게 현행화. **un-skip 전후 실행 테스트 수를
  기록**해 PR에 명시 (silent-skip 역감시).
- **identity accessor**: transport 재료 없는 credentials.json에서 identity 반환;
  identityKey 손상(≠32B) 시 undefined; issuer 동반 반환.
- **consume**: static+persisted-identity → identityKey 반환; static+identity 없음 →
  `identity-missing` (transport factory 미호출 단언); static은 persisted natsUrl
  무시하고 source.url dial.
- **index-nats**: `identity-missing` → account skip+log, 프로세스 생존; F2 backstop
  유지; readiness 라인 mode/URL; **shared-audience: 충돌 집합 전원 skip +
  transport 미개설 단언, 비충돌 계정은 정상 serve** (run-two-account-isolation은
  distinct aud라 무영향 — S2에서 확인, R3).
- **requirePoP**: config 존재 → Layer-1 migration error; PoP 없는 register 시도
  → 거부 (기존 gate 테스트 강화, opt-out 케이스는 migration-error 테스트로 전환).
- **template parity (fixture 3자 일치 + 현실 앵커)**: plugin 테스트 —
  `requiredNatsPermissions` == `contracts/nats-permissions.v1.json`; saas
  테스트 — minted **JWT claim 디코드** == 같은 fixture (agent/browser/observer,
  allow+deny 전부 — observer `pub.deny:[">"]` 포함); **subject-coverage** —
  런타임 subject 집합이 template grant에 매칭; **실서버 매트릭스** —
  template-도출 creds의 allow/deny를 실 nats-server로 확인.
- **preflight**: 실 nats-server로 P1/P2 거부→FAIL+template 인용, P3 허용→WARN,
  전부 그린→PASS 라인; PING-배리어 타임아웃 경로; cleanup(listener/UNSUB) 검증.
- **negative bindings**: 계정 A 토큰 → 계정 B subject 401 (unit) + 라이브 N2.
- **라이브**: Mode A/B/C 각 echo 왕복 + N1-N3 + Mode B fail-closed 레그.
- CI baseline: **1398 → 완료 후 PASSED 실측 상향** (codex R1-8: r1의 1435는
  워크트리 측정치였고 커밋된 baseline이 아님).

## 7. Risks / open questions

- **Q2 (D4c)**: over-broad **browser**-creds 검출 도구화 (sample creds를 preflight에
  넘기는 opt-in flag) — **권고: 비범위** (계약은 template+문서로 표면화).
- ~~Q3~~ — D6-5로 소멸 (requirePoP opt-out 제거가 스펙 직접 요구; 사용자에게
  보고로 통지).
- **R1**: Mode C feasibility — **사전 해소 (TechLead 직접 확인, 2026-07-16)**:
  workspace의 `@nats-io/jwt`가 `encodeOperator`/`encodeAccount`/`encodeUser`를
  모두 export한다 (saas 패키지에서 ESM import로 실측). S4 진입 시 인코딩 산출
  JWT가 실 nats-server resolver에서 수용되는지만 확인. **격하 경로 없음**
  (codex R2-1) — 실패 시 P0-3 블록.
- **R2**: Gate A add-time env vs run-time env 차이 — 진단 라인에 "add-time env
  기준" 명시 + Gate B readiness가 run-time effective 값 재표시 (D4b).
- **R3**: shared-audience 격상 × run-two-account-isolation.sh — distinct aud라
  무관 예상, S2 테스트로 확인.
- **R4**: `"open"` enum 존치 — P0-2 seam 의도 유지 (제거하면 generic schema
  reject가 migration error를 선점).
- **R5**: PING-배리어를 위한 `NatsTransport` seam — 기존 protocol 처리에 PONG
  대기가 없다면 `flush()` 추가가 필요. transport는 P0-2에서 검증된 코어라 변경
  최소화: flush 하나만, 기존 경로 무접촉. codex R2에서 침습도 검증.
- **R6**: requirePoP 제거의 blast radius — **전수 grep 완료 (TechLead,
  2026-07-16)**: `register-pop-gate.ts`(모듈)·`nats-register.ts:228-230`(소비처)·
  `auth.ts:101`(type)·`openclaw.plugin.json:56`(schema)·
  `register-pop-gate.test.ts`(opt-out 케이스 → migration-error 테스트로 전환)·
  `nats-register.test.ts:219-222`(**주의**: cnf-없는 identity에 도달하기 위해
  requirePoP:false를 사용 — PoP 무조건-ON에서는 pop_jwk 있고 cnf 없는 JWT로
  같은 분기 도달하도록 재작성; 통삭제 금지)·`docs/AUTH.md:23`·
  `e2e/local/enrolled-transport-roundtrip.ts:86`(주석). 이 목록이 S2 재작성
  목록의 기준선.

## 8. 완료 조건 (P0.md 대조)

- [ ] Self-hosted(A)/static-BYO(B)/external-account(C) 하네스가 같은 registration
      suite(`all-real.mjs` — echo + N1-N3 적대 레그) 공유, 전부 GREEN.
- [ ] 잘못된 issuer/audience/account/peer/device/agent binding 전부 fail-closed:
      shared-audience collision-set 전체 skip(D6-1), PoP 무조건 ON(D6-5),
      negative 테스트(unit+라이브 N2)로 고정.
- [ ] register 이전 publish는 turn 미생성 — 라이브 N1로 3-mode 재확인.
- [ ] active relay의 register-reply redirect/key-swap 불가 — reginbox allowlist
      (기존) + 라이브 N3 (2-phase SIGSTOP-MITM: 위조 reply 거부를 **cause=
      `secure-channel-failed`로 정확 단언** + SIGCONT 후 **fresh client**로
      정상 register 회복, 3-mode 전부 — escape hatch 없음).
- [ ] permission template(allow+deny) + fixture 3자-일치 parity 테스트 +
      preflight 순차 PING-배리어 3-probe (correlation = op종류+subject).
- [ ] static-creds 계정: enrolled identity 있으면 serve, 없으면 identity-missing
      skip (라이브로 확인).
- [ ] vitest 전체 요약 "Test Files" 라인 무결 + collection failure 0 + baseline
      PASSED-기준 상향.
