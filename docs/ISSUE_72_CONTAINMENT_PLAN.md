# Issue #72 — 유출된 브라우저 자격증명·conversation key 봉쇄(containment) 기획서

> 상태: v7 — **적대적 리뷰 5라운드 완료(R1~R5, 서로 다른 리뷰어 5명), 전 지적 반영.**
> R6은 최종 검증 패스로 착수되었으나 **보고가 전달되지 않아 판정이 없다**(§12). 따라서 완료된
> 마지막 라운드는 R5이며, 이 문서가 6라운드를 통과했다고 읽어서는 안 된다.
> 남아 있는 미결 항목은 §10에 있다.
> 기준 브랜치: `develop` (`0d2196d`)
> 대상 이슈: https://github.com/mir-stream/openclaw-webchannel/issues/72
> 이 문서는 **기획서(plan)** 이며 구현 코드·테스트를 포함하지 않는다.

## 0. 이 문서를 읽기 전에 — 자세(posture)와 5가지 이슈 본문 이탈

### 0.1 자세: 사전 강화(preemptive hardening)이며 진행 중 사고 대응이 아니다

알려진 실제 침해 사건은 **없다**. 이슈 #72 본문은 "Trigger"를 조건문으로 서술하지만
(`packages/plugin/CHANGELOG.md:28-32`의 릴리스노트도 "must be treated as potentially
exposed"라는 가정법이다), 이 기획서가 다루는 것은 **그런 사건이 발생했을 때 쓸 수 있는 도구가
현재 존재하지 않는다는 구조적 결손**이다. 따라서:

- 이 문서의 어떤 절차도 "지금 실행하라"가 아니다. "실행할 수 있는 상태를 만들자"이다.
- 구현 우선순위는 P2다. #54가 이미 신규 cross-account 등록을 차단했으므로 유입은 멈춰 있다.
- 반대로, 도구가 없는 상태에서 사건이 발생하면 유일한 복구 수단은 trust chain 전체 재생성
  (전 tenant outage)뿐이다(`packages/saas/src/account-revocation.ts:9-11`). 그 비대칭이 이 작업의
  정당화 근거다.

### 0.2 이슈 본문에서 의도적으로 이탈하는 5가지

이슈 #72의 acceptance criteria 중 다섯 항목은 현재 코드베이스 실측과 충돌하거나, 사용자 결정에
의해 다르게 해소된다. **묻히지 않도록 여기서 먼저 선언한다.**

| # | 이슈 본문의 서술 | 실측/결정 | 귀결 |
|---|---|---|---|
| (a) | "History retain/re-encrypt/purge semantics are explicit" | history는 **in-process Map 하나**다. `packages/plugin/src/history-store.ts:110`이 `readonly #store = new Map<string, MessageEnvelope[]>()`이고 `:50`이 "Deferred: persistence (this implementation is in-process only)"라고 명시한다. | 디스크에 재암호화할 ciphertext가 **없다**. gateway 재시작이 이미 purge다. rotation은 해당 conversation의 envelope list를 명시적으로 drop하기만 하면 된다. "re-encrypt" 기준은 대부분 소멸한다. 대신 `conversation-key-store.ts:17-19`의 "history at rest is sealed with it"이라는 docstring이 디스크 기준으로 **부정확**하다는 별도 결손이 드러난다. |
| (b) | "Self-contained mode publishes the updated account JWT to the resolver and verifies acceptance" | self-contained 모드는 `resolver: MEMORY` + `resolver_preload`를 **생성된 설정 파일에** 써 넣는다(`demo/run.sh:205-206`, `e2e/local/run-all-real.sh:128-129`, `e2e/local/run-enrolled-transport.sh:120-121`, `e2e/local/run-derived-trust.sh:141-142`, `e2e/local/run-two-account-isolation.sh:134`). MEMORY resolver에는 갱신 채널이 없다. | 현 topology에서 **도달 불가능한 기준**이다. §5.6의 resolver 운영 모드 선택이 Track A의 명시적 **선행 결정**이며, 그 결정 없이는 Track A를 착수할 수 없다. |
| (c) | "Epoch introduction … needs a compatibility window or forced upgrade" | 사용자 결정: **forced lockstep upgrade**. `packages/plugin/src/late-join-decryptor.ts:36-38`의 F2 선례가 이미 "Strict 3-way lockstep (client+agent+SaaS ship together)"이다. | `epoch 0 == legacy` 호환 창을 **설계하지 않는다.** 그것은 이 이슈가 닫으려는 downgrade surface를 되살린다. 구 브라우저는 hard-break한다. |
| (d) | "Wrapped-key AAD and message envelopes **bind the epoch**; an old wrapped K cannot roll back a client" | **R2 판정: epoch 결박은 목적을 달성하지 못하며 불필요하다.** envelope 경로는 rotate가 매번 새 32바이트 난수 키를 만들어 세대 분리가 **이미 완전**하고, `openEnvelope`는 프레임 자신의 routing에서 AAD를 만들므로(`packages/plugin/src/e2e-session.ts:64-74`, `:69-70`) 재생된 epoch는 자기정합적이라 아무것도 막지 못한다. wrap 경로는 AAD가 필요하지만(그곳의 wrap 키는 K와 무관해 세대를 넘어 안정적이다 — `packages/plugin/src/late-join-decryptor.ts:230-236`) 거기서 필요한 것은 세대가 아니라 **신선도**이며 그것은 epoch가 아니라 client-chosen nonce가 준다. | epoch를 **어느 AAD에도 넣지 않는다.** `ENVELOPE_VERSION`(`packages/plugin/src/e2e-envelope.ts:60`)은 1로 유지, `canonicalAad`(`:347-358`)·`e2e-session.ts`·`conversation-keys.json` 문서 버전 모두 변경 없음. epoch는 **감사 메타데이터**로만 남고 사이드카 파일에 산다(§6.1). 상세 §6.4. |
| (e) | "K rotation creates a **monotonically versioned** epoch for the selected (tenant, accountId, peerId)" | **부분 충족만 주장한다.** epoch는 감사 사이드카 파일에 살고(§6.1.2), 그 파일이 유실되면 카운터는 1에서 다시 시작한다. 파일을 durable하게 만들 수단이 없다 — 키 파일과 함께 지워지는 것을 막는 것은 코드가 아니라 런북이다. | epoch를 **best-effort·non-durable 감사 라벨**로 명시한다. "단조 증가한다"는 *파일이 살아 있는 한*이라는 조건부 진술이며, 이 AC가 **충족되었다고 주장하지 않는다**(§6.1.1). 보안 영향은 없다 — epoch는 어떤 AAD에도 없으므로(이탈 (d)) 번호 재사용이 과거 wrap/envelope를 되살리지 않는다. |

### 0.3 Track B의 세 가지 하드 전제 (R2에서 확정)

R1은 "epoch를 wrap AAD에 넣으면 rollback이 막힌다"고 했고, R1-정정은 "서버 PoP nonce를 함께
넣으면 된다"고 했다. **둘 다 불충분했다.** R2에서 확정된 전제는 다음 셋이다. 상세는 §6.3·§6.4·§6.6.

1. **신선도 앵커는 client-chosen이어야 한다** — `wrapAad(peerId, clientNonce)`.
   서버 발행 PoP nonce로는 부족하다. challenge reply는 **인증되지 않으며**
   (`packages/client/src/pop-register.ts:258`에서 요청, `:272`에서 무검증 신뢰) 적대적 relay가
   agent를 거치지 않고 직접 응답할 수 있다. relay가 `(구 challenge nonce, 구 wrap)`을 **쌍으로**
   재생하면 브라우저는 그 nonce로 AAD를 계산해 정확히 일치시키고 구 K를 채택한다. agent는 그
   라운드에 관여하지 않으므로 `consume()`(`packages/plugin/src/pop-challenge.ts:162-173`)은 발동조차
   하지 않는다 — 그 함수는 **agent를** 재생으로부터 보호하지 브라우저를 보호하지 않는다.
   브라우저가 로컬 생성한 값만이 relay가 고를 수 없는 값이다.
2. **epoch는 감사 메타데이터이며 암호 결박이 아니다** — §0.2 (d). 따라서 `ENVELOPE_VERSION`,
   `canonicalAad`, `e2e-session.ts`, conversation-key 문서 버전은 **전부 변경하지 않는다.**
   Track B는 message wire를 건드리지 않는다.
3. **재등록은 자동으로 일어나지 않는다.** revocation은 재연결이 아니라 **terminal**을 만든다
   (`packages/client/src/nats-client.ts:818-824`, 오류 문구가 *"reconnecting cannot help"*;
   `natsCredentials`는 생성 시점 옵션 `:142`이며 갱신 훅이 없다; `:1813-1814`가
   *"recovery is a fresh instance"*). 실제 복구 경로는 **임베딩 애플리케이션의 재부트스트랩**이며
   그 운영 비용은 §6.6.3에 명시한다.

**1번 위험은 Track B가 만들어 낸다.** 오늘 register reply 전체를 재생해도 무해한 이유는 정확히 K가
절대 rotate하지 않아 재생된 wrap 속 K가 현재 K와 같기 때문이다. rotation을 도입하는 순간 그 재생이
세션 탈취가 된다.

**2번 덕분에 R1이 계획했던 breaking wire 변경 대부분이 회수되었다.** 남은 wire 변경은 register
**요청**에 `clientNonce` 필드 하나를 추가하는 것뿐이다(§6.3.2, §8.2).

---

## 1. 배경 / 문제 정의

### 1.1 #54가 고친 것

이슈 #54는 bootstrap JWT의 account 권한을 구조적으로 결박했다. 이제 verifier는 immutable runtime
`accountId`로 만들어지고, 운영자 설정이 expected audience를 공급할 수 없다
(`CHANGELOG.md:5-10`, `packages/plugin/CHANGELOG.md:7-12`). A 계정용 토큰을 B의 register subject로
보내면 peer 등록·key wrapping·history snapshot·approval snapshot **이전에** 거부된다.

### 1.2 #54가 구조적으로 고칠 수 없는 것

#54는 **예방(prevention)** 이다. 이미 발급된 것을 되돌리지 못한다. 구체적으로:

1. **브라우저 NATS 자격증명은 회수되지 않는다.** 브라우저 credential은
   `webchannel.{tenant}.*.{peerId}.>`에 pub/sub 권한을 갖는다
   (`packages/saas/src/nats-user-creds.ts:171-172`). `ttlSeconds`를 생략하면 `exp`가 붙지 않아
   **만료되지 않는다**(`packages/saas/src/nats-user-creds.ts:81-88`, 계산은 `:185`). 실제 브라우저
   발급 경로 3곳 중 TTL을 넘기는 곳은 demo 한 곳뿐이며 그것도 optional이다
   (`demo/saas-server.ts:589` — `...(ttl ? { ttlSeconds: ttl } : {})`;
   `packages/saas/reference/enrollment-server.ts:747-752`와
   `examples/webchannel-app/server/index.ts:344-351`은 TTL을 전혀 넘기지 않는다).
2. **conversation key K는 회수·교체되지 않는다.** `ConversationKeyStore`는 `getOrCreate`와 `get`만
   노출한다(`packages/plugin/src/conversation-key-store.ts:159`, `:199-204`). `:117` 주석이
   "Entries are never removed by this store"라고 못 박는다. delete도 rotate도 epoch도 없다.
3. **agent key revocation은 이 둘 어느 쪽도 건드리지 않는다.** `docs/AUTH.md:73` —
   "Revocation permanently tombstones the active identity key … It does not disconnect browsers that
   already pinned the key and does not revoke the agent's existing NATS credentials."

### 1.3 결손의 형태

따라서 남는 노출은 이렇게 정리된다.

```text
공격자가 (가정상) 이미 획득한 것        복구 가능성
─────────────────────────────────────────────────────
B의 wrapped K → unwrap된 K              K를 rotate하면 이후 트래픽은 차단. 이미 캡처한
                                        ciphertext는 영구 복호 가능 (복구 불가)
B의 브라우저 NATS credential            revocation으로 차단 가능 (도구 없음)
이미 late-join으로 당겨간 history 평문   복구 불가
와이어에서 캡처한 ciphertext + 구 K      복구 불가
```

`packages/plugin/CHANGELOG.md:31-32`가 이미 이 점을 정직하게 서술하고 있다 — "cannot make
previously exposed keys or ciphertext secret again". **이 기획서는 그 문장을 뒤집지 않는다.**
rotation이 과거를 치유한다고 암시하는 어떤 문구도 금지한다.

---

## 2. 현재 상태 실측

### 2.1 revocation primitive는 있고, 워크플로는 없다

`packages/saas/src/account-revocation.ts:51`:

```ts
export async function addRevocation(
  accountJwt: string,
  operatorSeed: string,
  userPubkey: string,   // "U…" 또는 "*"
  at: number,           // unix seconds; 이 시각 이전 발급분 거부
): Promise<string>
```

- 계정 JWT의 `revocations` map(`Record<userPubkey, unixSeconds>`)에 항목을 추가해 operator seed로
  재서명한다(`:78-84`). 기존 limits/revocations/signing key는 spread로 보존된다(`:80-84`).
- 입력 검증이 이미 fail-closed다: operator seed가 `SO`로 시작하지 않으면 거부(`:61-66`),
  userPubkey가 `U`도 `*`도 아니면 거부(`:67-71`), `at`이 유한 양의 정수가 아니면 거부(`:72-76` —
  fractional 값은 nats-server의 int64 unmarshal을 깨서 계정을 brick한다).
- **반환된 JWT를 resolver에 반영하는 것은 호출자의 책임이다**(`:14-16`, `:48-49`).
- barrel에 export되어 있다(`packages/saas/src/index.ts:85`).
- **production 호출자가 0개다.** `git grep addRevocation` 결과는 자기 자신, 자기 테스트
  (`packages/saas/src/account-revocation.test.ts`), docstring 언급
  (`packages/saas/src/nats-user-creds.ts:97`, `:223`; `packages/saas/src/setup-trust-chain.ts:88`;
  `packages/saas/src/types.ts:44`; `packages/saas/src/device-flow-types.ts:233`), 그리고 barrel
  export 뿐이다.

### 2.2 브라우저 자격증명 발급 경로

공개 문(door)은 `issueBrowserCredentials`(`packages/saas/src/nats-user-creds.ts:273`)이다. 내부
`mintNatsUserCreds`(`:118`)는 barrel에 export되지 않고, 이 wrapper가 `role: "browser"`를 하드코딩해
role escalation을 봉쇄한다(`:286-293`).

발급 결과 타입 `BrowserCredentials`(`:217-230`)는 `userPubkey`를 이미 노출한다(`:220-225`) —
이슈 #12의 산출물이며, docstring이 "the NATS-revocation key"라고 명시한다. 즉 **revocation에 필요한
식별자는 이미 발급 시점에 손에 들어와 있고, 아무도 그것을 기록하지 않는다.**

실제 호출자:

| 위치 | 성격 | TTL |
|---|---|---|
| `packages/saas/reference/enrollment-server.ts:747` | reference 서버, 세션 인증 후 `peerId = user.uuid`(`:750`) | 없음 → 비만료 |
| `demo/saas-server.ts:584` | demo, `peerId = user.uuid`(`:587`) | optional(`:581`, `:589`) |
| `examples/webchannel-app/server/index.ts:344` | 소비자 예제, `peerId = user.uuid`(`:347`) | 없음 → 비만료 |

`mintNatsUserCreds` 직접 호출자는 브라우저 문이 아니다:
`packages/saas/reference/enrollment-server.ts:978`은 `TEST_ROUTES_ENABLED` 게이트(`:956`) 뒤의
TEST-ONLY 라우트, `demo/saas-server.ts:766`은 chaos probe, `demo/saas-server.ts:800`은 admin 전용
observer/agent 라우트, `packages/saas/src/device-flow-enrollment.ts:690`은 **agent** role
(`:693`)로 브라우저와 무관하다.

> 원장(ledger) hook point는 따라서 `issueBrowserCredentials` **한 곳**이다. 세 호출자 모두 이
> wrapper를 지나므로 wrapper에 계측을 걸면 브라우저 발급을 빠짐없이 잡는다.

### 2.3 브라우저 권한 범위

`packages/saas/src/nats-user-creds.ts:165-172`:

```ts
assertValidSubjectToken(opts.peerId, "peerId");
pub = [`webchannel.${opts.tenant}.*.${opts.peerId}.>`];
sub = [`webchannel.${opts.tenant}.*.${opts.peerId}.>`];
```

`*`는 **accountId 세그먼트를 와일드카드**한다(`:23-26` docstring). 설계 의도는 "같은 peerId가
tenant의 여러 account를 넘나든다"이지만, #54 이전 상황에서는 이것이 A-peer가 B의 subject에
접근하는 통로의 전송 계층 절반이었다. #54는 **인증** 절반을 닫았고, 전송 권한 자체는 그대로다.

### 2.4 conversation key K — epoch가 전혀 없다

- store API: `getOrCreate(peerId)`(`packages/plugin/src/conversation-key-store.ts:159`),
  `get(peerId)`(`:199`). 그 외 공개 메서드 없음.
- 문서 포맷: `packages/plugin/src/conversation-key-document.ts:11`가
  `CONVERSATION_KEY_DOCUMENT_VERSION = 2`, `:16-20`이
  `{ version, storageIdentity, keys: Record<peerId, string> }`. 값은 base64url 32바이트
  (`:13`, `:81-84`, `:132-138`). **per-key 메타데이터 자리가 없다.**
- 저장 위치는 `(tenant, accountId)` tuple scope 디렉터리다
  (`packages/plugin/src/conversation-key-store.ts:123-130` → `tupleStoragePaths`,
  `packages/plugin/src/storage-paths.ts:61`, `:79`, 파일명 상수 `:19`).
  이 tuple-scoped 저장 코드는 이미 `develop`에 있다(최근 커밋 `4d9365f`~`0d2196d`). 다만 **이슈
  #71 자체는 아직 OPEN이다** — 코드는 착륙했고 이슈는 닫히지 않았다.
- 등록 경로: `packages/plugin/src/nats-channel.ts:271` `registerPeer()` → `:282-285`에서
  `this.keyStore.getOrCreate(peerId)`를 live-session 변경보다 **먼저** 호출(#55의 성과), 결과를
  `:288`(이미 등록된 peer) 또는 `:313`(신규)에서 `peerSessionKeys`에 캐시한다(`:202` 선언).
- wrap: `packages/plugin/src/nats-channel.ts:645` `wrapConversationKeyForDevice()`가 `:655`에서
  in-memory 키를 꺼내 `:661-664`에서 `wrapConversationKey(key, devicePublicKey,
  { agentIdentityKeyPair, peerId })`를 호출한다.
- 구성: `packages/plugin/src/nats-account-runtime.ts:817`에서 `new ConversationKeyStore({...})`,
  register handler에는 `:1270-1271`에서 wrap이 주입된다.

### 2.5 wrap AAD — 코드가 이미 이 결손을 지목하고 있다

`packages/plugin/src/late-join-decryptor.ts:119-121`:

```ts
export function wrapAad(peerId: string): Uint8Array {
  return new TextEncoder().encode(peerId);
}
```

바로 위 docstring `:115-117`:

> **NOTE (K-rotation): if the conversation key K ever rotates and old wraps stay replayable, add a
> key-epoch to this AAD so an old-K wrap cannot be rolled back onto a new epoch. Today K is stable
> per peer, so peerId alone is sufficient.**

즉 Track B의 핵심 수정은 **코드 저자가 미리 승인해 둔 처방**이다. 새 설계가 아니라 예고된 후속이다.

브라우저 미러는 `packages/client/src/e2e-crypto-browser.ts:112`의 동일 구현이며, `:107-109`
docstring이 "byte-identical to the agent's `wrapAad`"를 계약으로 못 박는다. 소비 지점은 `:157`
`unwrapConversationKey`(AAD 사용은 `:181`)이고, 클라이언트 호출부는
`packages/client/src/nats-client.ts:1758-1763`이다. 그 직전 `:1742-1755`가 pin 부재를 terminal로
처리하는 fail-closed 게이트다.

### 2.6 message envelope AAD

- `packages/plugin/src/e2e-envelope.ts:60` — `export const ENVELOPE_VERSION = 1 as const;`
- `EnvelopeRouting`(`:79-92`)은 `accountId, tenant, sub, messageId, envelopeType, ts` 6필드.
- `canonicalAad(routing)`(`:347-358`)은 **고정 key order**의 `JSON.stringify`다:
  `{tenant, accountId, sub, messageId, envelopeType, ts}`. `:341-342` docstring —
  "Key order is fixed (tenant first) to ensure JSON serialization is deterministic across all
  JavaScript engines". 이 성질은 필드를 추가할 때도 반드시 보존해야 한다.
- `deserializeEnvelope`(`:265`) → `validateEnvelope`(`:281`) → `:287-291`이 `v !== ENVELOPE_VERSION`을
  **hard reject**한다. 이것이 forced-lockstep의 집행 지점이며 이미 fail-closed다.
- 브라우저 미러는 `packages/client/src/e2e-crypto-browser.ts:189-196`(routing),
  `:198-205`(`v: 1`).

### 2.7 history는 in-memory 전용

- `packages/plugin/src/history-store.ts:110` — `readonly #store = new Map<string, MessageEnvelope[]>();`
- `:50` — "Deferred: persistence (this implementation is in-process only)."
- `:51` — "Deferred: key rotation / revocation rekey of stored envelopes."
- 공개 API는 `append`(`:125`), `loadHistory`(`:156`), `size`(`:212`)뿐. **삭제 API가 없다.**
- register 시 스냅샷 발송은 `packages/plugin/src/nats-register.ts:370` → 주입된
  `sendHistorySnapshot`(`packages/plugin/src/nats-account-runtime.ts:389` 정의, `:1273-1274` 주입).

귀결은 §0.2 (a)에 적은 대로다. 그리고 `packages/plugin/src/conversation-key-store.ts:17-19`의
"history at rest is sealed with it"은 **디스크 기준으로 사실이 아니다**. 재시작 시 history는
사라지고 K만 남는다. 이 docstring 정정은 Track C의 저비용 항목으로 편입한다.

### 2.8 resolver topology — 이 이슈 전체에서 가장 큰 실행 가능성 장벽

self-contained 모드의 nats-server는 이렇게 기동된다:

```text
demo/saas-server.ts:192-199   → operator.jwt + resolver.json 파일로 배출
demo/run.sh:195-209           → 그 둘을 읽어 nats.conf 생성 (:205 resolver: MEMORY,
                                 :206 resolver_preload)
demo/run.sh:210               → nats-server -c "$OCH/nats.conf"
```

동일 패턴이 `e2e/local/run-all-real.sh:115-136`, `run-enrolled-transport.sh:120-121`,
`run-derived-trust.sh:141-142`, `run-two-account-isolation.sh:134`에 반복된다.

**MEMORY resolver에는 런타임 갱신 채널이 없다.** 개정된 account JWT를 반영하는 방법은 두 가지뿐:

1. 설정 파일을 다시 쓰고 `nats-server --signal reload`
2. `$SYS.REQ.CLAIMS.UPDATE`를 지원하는 NATS/full account resolver로 이전

따라서 이슈 #72의 "publishes the updated account JWT to the resolver and verifies acceptance"는
**현재 topology에서 그대로는 구현 불가**다. §5.6이 이 선택을 Track A의 선행 결정으로 정면 취급한다.

### 2.9 operator seed 보유 여부 — 롤아웃 위험

`addRevocation`은 operator seed를 요구하는데, 그것은 chain 생성 시점에
`returnOperatorSeed: true`를 **옵트인한 경우에만** 보존된다
(`packages/saas/src/setup-trust-chain.ts:84-95`, `packages/saas/src/types.ts:38-47`).
그리고 `packages/saas/src/setup-trust-chain.ts:90-93`과
`packages/saas/src/account-revocation.ts:24-27`이 동일한 경고를 반복한다 —
`loadOrCreateTrustChain`에서는 **최초 생성 시에만** 적용되며, 이미 persist된 chain은 그대로
반환되어 영영 operator seed를 얻지 못한다.

즉 **옵트인 없이 만들어진 배포는 오늘 revoke할 방법이 아예 없다.** chain 재생성 = 전 tenant outage.

### 2.10 결손 요약 (G4는 R2에서 철회 → 유효 6종)

> R1에서 G6·G7이 추가되었다. 둘 다 "rotation을 도입하는 순간 결손이 되는" 항목이라 초안이
> 놓쳤다 — 오늘은 K가 불변이라 결손으로 보이지 않는다. R2에서 G6의 성격(서버 nonce로는 부족,
> client-chosen이어야 함)과 G7의 등급(보안 → 감사)이 정정되었다.

| # | 결손 | 근거 | 담당 Track |
|---|---|---|---|
| G1 | 발급 원장(issuance ledger) 부재 — 어떤 `userPubkey`가 어떤 peer에게 언제 나갔는지 아무도 모른다 | `packages/saas/src/nats-user-creds.ts:294-299`가 값을 반환할 뿐 기록 없음; 호출자 3곳 모두 그대로 응답에 실어 보냄 | A |
| G2 | revocation 워크플로 부재 — primitive는 있으나 production 호출자 0 | `packages/saas/src/account-revocation.ts:51` + `git grep` 결과 | A |
| G3 | resolver 갱신 채널 부재 — 개정 JWT를 반영·검증할 경로가 없음 | `demo/run.sh:205`, `e2e/local/run-all-real.sh:128` 등 `resolver: MEMORY` | A(선행 결정) |
| G4 | ~~K epoch 부재 — wrap AAD도 envelope AAD도 세대를 결박하지 않음~~ **R2에서 결손 아님으로 판정.** 세대 결박은 rotation이 매번 새 난수 키를 만드는 것으로 이미 달성된다(§0.2 (d), §6.4.1). 실제 결손은 G6(신선도)이다 | `packages/plugin/src/late-join-decryptor.ts:119-121`, `packages/plugin/src/e2e-envelope.ts:347-358` | — |
| G5 | rotation API 부재 — store에 delete/rotate 없음, "never removed" | `packages/plugin/src/conversation-key-store.ts:117`, `:159`, `:199` | B |
| G6 | **register 라운드에 client-chosen 신선도 앵커 부재** — challenge reply가 인증되지 않아(`packages/client/src/pop-register.ts:258`, `:272`) relay가 `(challenge nonce, register reply)`를 쌍으로 재생할 수 있고, 브라우저에는 그것을 판별할 로컬 값이 없다. wrap AAD는 peerId뿐(`packages/plugin/src/late-join-decryptor.ts:119-121`). 오늘은 K가 불변이라 무해하다 | 위 + reply 구성 `packages/plugin/src/nats-register.ts:389-397` | B (§6.3.1) |
| G7 | **세대 카운터 자체가 없다** — 어느 peer가 몇 번 rotate되었는지 기록할 자리가 없어 운영자가 rotation 수행 여부를 확인할 수 없다. (R1은 이를 보안 결손으로 분류했으나 R2에서 **감사 결손**으로 재분류했다 — §0.2 (d)) | store API `packages/plugin/src/conversation-key-store.ts:159`, `:199`; 문서 형식 `packages/plugin/src/conversation-key-document.ts:16-20` | B (§6.1.2) |

---

## 3. 범위 판단과 3-트랙 분할

### 3.1 왜 나누는가

#72 하나를 통짜로 구현하면 다음이 한 PR에 섞인다: SaaS 영속 원장 SPI, NATS resolver 운영 모드
변경, 실서버 통합 테스트, plugin 문서 포맷 마이그레이션, wire breaking change, 브라우저 crypto
변경, 3-package lockstep 릴리스, 운영 런북. 리뷰 가능한 단위가 아니고, 무엇보다 **가장 싼 항목이
가장 비싼 항목에 인질로 잡힌다.**

실제로 #54 릴리스노트가 지금 미이행 상태로 남긴 약속이 하나 있고(§4.1), 그것은 코드 변경 0줄로
갚을 수 있다.

### 3.2 세 트랙

**Track C — 운영자 런북 + #54 릴리스노트 미이행 항목 해소**
- 산출물: 새 운영 문서 1개 + `CHANGELOG.md`/`packages/plugin/CHANGELOG.md` 문구 수정 +
  `conversation-key-store.ts` docstring 정정.
- 코드 변경 없음(주석/문서만). 독립 배포 가능.
- **아무것도 unblock하지 않지만, 살아 있는 문서 의무를 즉시 청산한다.**

**Track A — SaaS 자격증명 원장 + revocation 워크플로**
- 산출물: ledger SPI + conformance suite(§5.2), `issueBrowserCredentials` 계측(§5.3), 인증된
  operator revoke 라우트 3종 — 단일 / **per-peer 일괄**(§5.4.2) / wildcard — 와 method-aware 인가
  테이블(§5.4.1), 각 경로의 dry-run blast radius(§5.5), **`revocationCapable` 평시 노출**(§5.7),
  그리고 **§5.6 옵션 2의 resolver 이전 + 반영·수용 검증 + live-disconnect 실증**.
- **§5.6 옵션 2는 선행 *결정*이자 Track A의 가장 큰 *산출물*이다** (R3/P2-8). 결정만으로 끝나지
  않고 5개 기동 스크립트의 resolver 블록 교체와 시스템 계정 도입이 따라온다. 일정 산정에서 이것을
  "결정 항목"으로만 취급하면 크게 빗나간다.
- Track B와 **독립적으로 유용하다.** rotation 없이도 "유출된 브라우저 credential을 끊는다"는 그
  자체로 완결된 가치이며, 실제로 Track B는 A 없이는 봉쇄를 완성하지 못한다(아래 정정).

**Track B — K rotation**
- 산출물: **offline rotation CLI 도구**(§6.5 — 패키징·엔트리포인트는 §10 #16), store `rotate()`
  API, generations 사이드카(감사 epoch), wrap AAD의 **client-chosen nonce 결박**, register 요청의
  `clientNonce` 필드와 client 내부 배선(§6.3.5).
- **철회된 산출물**(R2/R3에서): conversation-key 문서 v3, `ENVELOPE_VERSION` 2, envelope epoch,
  in-memory session 교체 계약, `HistoryStore.drop()` API. 앞의 둘은 §6.2·§6.4가, 뒤의 둘은
  §6.6.5·§6.7이 각각 철회 근거를 담는다. **이 목록에서 산출물을 읽을 때 그 항목들을 포함하지 말 것.**
- **breaking**: register 요청 스키마가 바뀌므로 `WEBCHANNEL_PROTOCOL_VERSION` 2 → 3.
  plugin+client+saas 동시 배포, 구 브라우저 hard-break.
- **R2에서 범위가 크게 줄었다.** conversation-key 문서 버전(v2 유지), `ENVELOPE_VERSION`(1 유지),
  `canonicalAad`, `e2e-session.ts`, `nats-channel.ts`의 seal/open seam 3곳, 브라우저 envelope
  미러, `peerSessionKeys` 타입 — **전부 변경 없음**. 근거는 §0.2 (d)와 §6.4.

**⚠ 트랙 독립성 정정 (R1/P1-2, R2에서 메커니즘 재확정).** 초안은 A와 B가 서로 독립이라고
서술했다. **B는 A에 의존한다.**

- agent 측에는 살아 있는 브라우저를 재등록시킬 수단이 없다 — `unregisterPeer`
  (`packages/plugin/src/nats-channel.ts:370-387`)는 subscription과 `peerSessionKeys`를 정리하지만
  peer에게 **아무것도 보내지 않으며**, `:296-298`이 "the browser only re-registers in
  `onConnected`, and the client heartbeat keeps a healthy socket from reconnecting"이라고 명시한다.
  heartbeat 상대는 relay이므로 gateway 재기동도 브라우저 소켓을 끊지 못한다.
- in-band 통지로 우회할 수도 없다: rotation 커밋 후 agent는 K_new로만 봉인할 수 있고 평문
  fallback이 금지되어 있으므로(`packages/plugin/src/nats-channel.ts:688-697`) K_old를 든 브라우저는
  그 프레임을 열 수 없다(§6.6.4).
- **R1이 제시한 "relay가 끊으면 브라우저가 재연결해 재등록한다"는 사슬도 틀렸다** — revocation은
  재연결이 아니라 **terminal**을 만든다(`packages/client/src/nats-client.ts:818-824`;
  `natsCredentials`는 생성 시점 옵션 `:142`이고 갱신 훅이 없다; `:1813-1814`가 "recovery is a
  fresh instance"). 실제 메커니즘은 **임베딩 애플리케이션의 재부트스트랩**(새 `/nats-user` 민팅 →
  새 `userPubkey` → 새 client 인스턴스)이며, 그 운영 비용 3가지는 §6.6.3에 명시한다.

어느 경로든 재등록의 출발점은 **Track A의 revocation**이다. 따라서 A → B 순서는 편의가 아니라
**요구**다(§6.6).

### 3.3 권고 순서: C → A → B

- **C 먼저**: 코드 0줄, 리뷰 비용 최소, 그리고 지금 이 순간 #54 릴리스노트가 약속만 하고 이행하지
  않은 항목이 있다. 문서 부채는 시간이 갈수록 정확도가 떨어진다.
- **A 두 번째**: B 없이도 독립적으로 배포 가능하고 독립적으로 유용하다. resolver 모드 결정이라는
  가장 긴 리드타임 항목을 일찍 착수시킨다. A가 만드는 "인증된 operator 조작 + 감사 기록" 뼈대를
  B의 rotation 라우트가 재사용하고, **무엇보다 A의 relay 측 연결 종료가 B의 forced re-register를
  성립시킨다**(위 정정).
- **B 마지막**: breaking release는 되돌리기 어렵다. A로 "끊는" 능력을 먼저 확보하면, B가 늦어져도
  최악의 경우 credential 차단 + 계정 비활성화로 봉쇄가 성립한다. 역순은 성립하지 않으며, 이제는
  기능적으로도 불가능하다.

### 3.4 Track B는 이번 사이클에서 **연기한다** (사용자 확정)

**취소가 아니라 연기다.** §6의 설계는 기록으로 문서에 그대로 남기며, 이번 사이클에 구현하지 않고
별도 이슈도 만들지 않는다. 근거:

1. **봉쇄 가치의 대부분이 Track A에 있다.** 유출된 credential을 끊지 않으면 공격자는 rotation 이후에도
   ciphertext를 계속 **관측**하고 해당 peer subtree에 **publish**할 수 있다
   (`packages/saas/src/nats-user-creds.ts:171-172`). K를 바꿔도 그 두 능력은 그대로다(§6.8).
   반대로 credential을 끊으면 관측·publish가 즉시 멎는다. 즉 A는 B 없이 의미 있게 유용하지만
   B는 A 없이 반쪽이다 — 그리고 §3.2가 밝힌 대로 B의 재등록 강제는 애초에 A에 의존한다.
2. **B의 범위가 R2~R3에서 크게 줄어 긴급성이 낮아졌다.** 문서 포맷 변경, `ENVELOPE_VERSION` 상승,
   envelope epoch, in-memory 세션 교체 계약, `HistoryStore.drop()`이 모두 철회되어(§3.2의 철회 목록)
   남은 것은 offline 도구 + `rotate` + 사이드카 + `clientNonce` 배선이다. 작아졌다는 것은 나중에
   해도 부담이 작다는 뜻이기도 하다.
3. **B는 여전히 breaking이다**(프로토콜 v2→v3). 봉쇄 능력을 확보하는 데 breaking 릴리스를 전제로
   걸 이유가 없다.

**연기 중 남는 노출을 정직하게 기록한다**: Track A만으로는 **이미 유출된 K를 무력화할 수 없다.**
공격자는 rotation 전에 캡처한 ciphertext를 영구히 복호할 수 있고(§6.8), credential이 끊긴 뒤에도
그 능력은 사라지지 않는다. Track C 런북은 그 사실과, K 교체가 필요할 때의 현행 수단(§4.2 §5의
파일 단위 리셋, 계정 전체 영향)을 계속 안내해야 한다. §4.2 §5-ter의 "Track B 배포 후" 조항은
**아직 발효되지 않는다**.

세 트랙은 각각 별도 GitHub 이슈로 분리하고 #72를 우산 이슈로 남긴다.

---

## 4. Track C 설계 — 런북과 문서 의무

### 4.1 #54 릴리스노트의 4개 유예 조건 이행 현황

이슈 #72 "Why defer from #54"는 4개 조건을 걸었다. 현재 `CHANGELOG.md:12-31`과
`packages/plugin/CHANGELOG.md:26-43`을 실측하면:

| 조건 | 현재 문구 | 판정 |
|---|---|---|
| require full stop/replacement of every vulnerable process | `CHANGELOG.md:21-22` "drain and stop **every** vulnerable replica and keep all affected accounts disabled"; `packages/plugin/CHANGELOG.md:34-35` 동일 | **이행** |
| distinguish prevention from recovery of prior compromise | `CHANGELOG.md:17-19` "Upgrading prevents new cross-account admission; it cannot restore secrecy…" | **이행** |
| document verified current NATS revocation and offline K-reset options | `CHANGELOG.md:23-24` "Revoke … through a verified control", `:28-31` "Integrated, verified K rotation/state invalidation is tracked by #72. If that control is not available … do not improvise" | **미이행.** 옵션을 *문서화*하지 않고 #72를 가리키기만 한다. 운영자는 "verified control"이 무엇인지 알 수 없다. |
| state that historical disclosure cannot be undone | `CHANGELOG.md:18-19`, `packages/plugin/CHANGELOG.md:31-32` | **이행** |

**Track C는 세 번째 항목을 닫는다.**

### 4.2 새 문서: `docs/CREDENTIAL_CONTAINMENT_RUNBOOK.md`

`docs/AUTH.md:75-96`의 "Offline re-key after revocation"이 이미 같은 계열의 절차 문서 선례다.
동일 톤·동일 구조로 작성한다.

> **적용 범위 주의 (§10 #17 미결).** 아래 절차, 특히 §5-bis의 ②(revoke)와 ④-bis(agent
> credential 재발급)는 **SaaS가 NATS 신뢰 체인을 소유하는 배포**(`enrolled` 소스)를 전제로
> 쓰여 있다. `static`(bring-your-own-NATS) 배포에서는 두 단계 모두 그대로 적용되지 않는다.
> 런북 본문은 **첫 화면에서 배포 소스를 판별하게 하고**, `static`이면 §10 #17이 정리될 때까지
> "relay 운영 주체의 자체 revocation 도구를 사용하라"로 안내한 뒤 나머지 단계(①·③·④·⑤·⑥)만
> 따르게 한다. 사고 한복판에서 적용 불가능한 지시를 만나 멈추는 일이 없어야 한다.

내용:

**섹션 1 — 이 문서의 적용 범위와 한계 (맨 앞)**
- 이 런북은 **오늘 사용 가능한 수단**만 기술한다. #72의 통합 도구는 아직 없다.
- 되돌릴 수 없는 것을 먼저 선언한다: 이미 캡처된 평문, 이미 캡처된 ciphertext + 구 K
  (`packages/plugin/CHANGELOG.md:31-32`와 같은 문장을 재사용).

**섹션 2 — 사전 점검: 내 배포는 revoke할 수 있는 상태인가**
- self-contained인지 managed(Synadia/NGS)인지 판별
  (`packages/saas/src/account-revocation.ts:18-19`).
- self-contained라면 `private.operatorSeed`가 존재하는지 확인
  (`packages/saas/src/types.ts:38-47`). 없으면 `addRevocation`은 **사용 불가**이며 유일한 경로는
  trust chain 재생성(전 tenant outage)임을 명시(`packages/saas/src/setup-trust-chain.ts:90-93`).
- managed라면 provider 콘솔이 유일한 revocation 경로임을 명시.
- **agent 재-enrol 경로가 존재하고 실제로 테스트되었는지 확인한다** (R5/P1-3). `*` 광역 revoke는
  agent credential까지 죽이며 plugin은 스스로 재발급하지 못한다
  (`packages/plugin/src/nats-credential-source.ts:21-26`). 재-enrol 수단이 없으면 **`*`를 쓰는 순간
  gateway를 되살릴 방법이 없다.** 이 점검은 사고 시점이 아니라 평시에 통과시켜 둔다.

**섹션 2-bis — revoke할 수 없는 배포를 위한 강등 경로 (R2/P1-4)** — *이 런북의 핵심 산출물*

§5-bis는 revoke를 먼저 하라고 명령한다. 그러나 두 부류의 배포는 **step ①을 실행할 수 없다**:

- `returnOperatorSeed` 없이 만들어진 self-contained chain — `addRevocation` 자체가 불가능하다
  (`packages/saas/src/setup-trust-chain.ts:90-93`).
- operator seed는 있으나 §5.6 옵션 2가 아직 착륙하지 않은 배포 — 개정 JWT를 relay에 반영할
  채널이 없다(§2.8의 `resolver: MEMORY`).

**Track C는 Track A보다 먼저 배포되므로, 런북 출하 시점에는 사실상 모든 배포가 여기 해당한다.**
이들에게 "revoke 먼저"는 실행 불가능한 지시이고, §5의 K 리셋은 첫 조치로 금지되어 있다. 안내가
없으면 운영자는 마비되거나 §6.6.4가 유해하다고 판정한 조작(revoke 없는 rotate)을 한다.

**강등 경로 — 이 저장소가 이미 채택한 조치를 명시적으로 가리킨다** (`CHANGELOG.md:21-22`,
`packages/plugin/CHANGELOG.md:34-35`):

1. **영향 account를 비활성화한다.** 서비스 중단이 봉쇄다. #54가 확립한 조치이며, revoke가
   불가능한 배포에서 유일하게 실효성 있는 차단이다.
2. **모든 취약 replica를 drain·정지한다.**
3. 노출 창과 history를 사고로 검토한다. 되돌릴 수 없는 것(§섹션 1)을 다시 확인한다.
4. **그 다음에야** 복구를 계획한다:
   - operator seed가 없다면 → trust chain 재생성(전 tenant outage)을 일정에 넣는다. 재생성 시
     **반드시 `returnOperatorSeed: true`로 만든다** — 그렇지 않으면 다음 사고에서 같은 자리에
     선다(`packages/saas/src/setup-trust-chain.ts:84-95`).
   - resolver 채널이 없다면 → §5.6 옵션 2 이전이라도 nats.conf 재작성 + **재기동**으로 적용할 수
     있다. **재기동은 해당 relay의 모든 연결을 끊는다**(§6.6.3 비용 3). `--signal reload`는 설정만
     다시 읽고 연결을 끊지 않으므로, 이미 연결된 세션을 떼어내려면 재기동이 필요하다(R5/P2-5).
5. account를 다시 켜기 전에 §4.1의 네 조건이 모두 충족되었는지 확인한다.

이 경로는 정밀하지 않다. **정밀함이 없다는 것이 요점이며, 그것이 Track A를 정당화한다.**

**섹션 3 — 브라우저 자격증명 차단(현행 수단)**
1. 대상 `userPubkey` 확보 방법. 현재 원장이 없으므로 **응답 로그/애플리케이션 세션 기록에서
   역추적**하거나, 불가능하면 §섹션 4의 광역 차단으로 간다. `BrowserCredentials.userPubkey`가
   발급 응답에 실려 나간다는 사실을 명시(`packages/saas/src/nats-user-creds.ts:220-225`).
2. `addRevocation(accountJwt, operatorSeed, userPubkey, at)` 호출
   (`packages/saas/src/account-revocation.ts:51`). **`at`은 unix _seconds_ 다**(`:45-47`).
   두 가지 브릭 경로를 나란히 경고한다:
   - fractional/NaN/Infinity → nats-server의 int64 unmarshal 실패로 계정 brick(`:72-76`이 막는다).
   - **밀리초 값을 잘못 넘김 → 서기 58500년경의 revocation floor = 그 키(또는 `*`면 계정 전체)의
     영구 거부.** `addRevocation`에는 상한 검증이 **없으므로**(`:72-76`) 이것은 통과한다.
     런북은 "지금 시각을 초 단위로 쓰라, `Date.now()`를 그대로 넣지 말라"를 명령형으로 적고
     `Math.floor(Date.now() / 1000)` 형태를 예시로 보여 준다.
3. 반환 JWT를 resolver에 반영: 현재 topology에서는 `resolver.json`을 갱신하고 nats.conf를 다시
   생성한 뒤 nats-server를 **재기동**해야 한다(`demo/saas-server.ts:194-198`,
   `demo/run.sh:195-209`). **`--signal reload`로는 부족하다** — reload는 설정만 다시 읽을 뿐
   이미 연결된 세션을 끊지 않으므로, 유출된 credential을 쥔 세션이 그대로 살아남는다(R5/P2-5).
   **이 단계가 자동화되어 있지 않다는 사실과, 재기동이 그 relay의 모든 연결을 끊는다는 사실을
   함께 경고한다.**
4. 검증: 구 credential로 재연결이 실패하는지 확인. (자동 검증 도구는 Track A 산출물.)

**섹션 4 — `*` 광역 차단의 폭발 반경 경고**
- `"*"`는 계정의 **모든** user를 대상으로 한다(`packages/saas/src/account-revocation.ts:43-44`,
  `:67-71`). 여기에는 **agent credential도 포함된다** —
  `packages/saas/src/device-flow-enrollment.ts:690-695`가 같은 NATS account seed로 agent creds를
  민팅하기 때문이다. 즉 `*` revocation은 브라우저뿐 아니라 **에이전트 전체를 끊는다.**
- 한 NATS account가 여러 논리 tenant를 담을 수 있다는 점도 함께 경고
  (브라우저 권한이 `webchannel.{tenant}.…`로 tenant-scoped라 해도, revocation의 단위는 tenant가
  아니라 **account**다).

**섹션 5 — K 오프라인 리셋(현행 수단)과 그 위험**
- 오늘 K를 "바꾸는" 유일한 방법은 tuple 디렉터리의 `conversation-keys.json`을 치우고 gateway를
  재기동해 신규 K를 생성시키는 것이다
  (경로: `packages/plugin/src/storage-paths.ts:19`, `:79`; store 재생성 동작:
  `packages/plugin/src/conversation-key-store.ts:159`).
- **그러나 `packages/plugin/README.md:194`가 이미 "Do not delete entries or the whole
  `conversation-keys.json`"을 지시하고 있고, `:208`은 백업을 로그/티켓에 첨부하지 말라고, `:210`은
  "do not delete entries"를 반복한다**(`docs/ISSUE_55_CONVERSATION_KEY_CAPACITY_PLAN.md` §5.7의
  runbook이 같은 규율의 출처다). 두 문서가 충돌하지 않도록, 런북은 이
  조작을 "지원되는 일상 운영"이 아니라 **"사고 시에만, 전량 백업 후, gateway 정지 상태에서,
  해당 account의 모든 peer가 재등록을 강요받는다는 것을 알고" 수행하는 파괴적 조작**으로
  명확히 등급 분류한다.
- 부작용을 정직하게 나열: 해당 account의 **모든** peer가 K를 잃는다(파일 단위 조작이라 per-peer
  선택이 불가능하다). 살아 있는 브라우저는 구 K를 메모리에 들고 있고, **재기동만으로는 재등록이
  일어나지 않으므로 그 불일치는 임베딩 앱의 재부트스트랩이나 사용자의 새로고침 전까지 영구히
  지속된다**(§6.6.3 비용 4, R4/P1-A). "재등록 전까지"라는 표현은 재등록이 자동으로 온다는 잘못된
  인상을 주므로 쓰지 않는다. in-memory history는 재기동으로 사라지므로 별도 처리가 필요 없다
  (`packages/plugin/src/history-store.ts:50`, `:110`).
- `docs/AUTH.md:75-96`의 오프라인 절차와 동일한 "gateway 정지 → 파일 이동(삭제 아님) → 재기동"
  형태를 유지한다.

**섹션 5-bis — 순서: gateway 정지가 **먼저**, 그 다음 revoke, 그 다음 K 교체 (R3/P1-1)**

런북은 이 순서를 **명령형으로** 못 박는다.

```text
① 그 gateway의 **모든 프로세스·모든 replica** 정지
→ ② revoke → ③ resolver 반영·수용 확인
→ ④ K 교체(정지 상태에서)
→ **④-bis `*` 광역 revoke를 썼다면: agent credential 재발급/재-enrol**
→ ⑤ gateway 재기동
→ ⑥ **그 gateway의 모든 peer에 대해 강제 새로고침/재부트스트랩을 유도**
→ K_new
```

**④-bis가 없으면 `*` 경로에서 ⑤가 아예 실행되지 않는다** (R5/P1-3). agent credential은 브라우저
credential과 **같은 `accountSeed`로 민팅된다**
(`packages/saas/src/device-flow-enrollment.ts:690-695`의 `role:"agent"` vs
`packages/saas/src/nats-user-creds.ts:286-293`의 `role:"browser"` — 둘 다 호출자가 넘긴 동일
account seed를 쓴다). `addRevocation("*", at)`은 `at` 이전 발급분을 **전부** 거부하므로
(`packages/saas/src/account-revocation.ts:4-7`) gateway가 보관한 credential도 함께 죽는다.
그리고 **plugin은 스스로 재발급할 수 없다** — `static`은 "The plugin is GIVEN these credentials;
it never mints them"이고 `enrolled`는 SaaS device flow의 산물이다
(`packages/plugin/src/nats-credential-source.ts:21-26`).

즉 `*` 경로에서 ④-bis를 건너뛰면 gateway가 relay에 붙지 못해 **봉쇄 절차 자체가 중단된다.**
이것은 예외적 경로가 아니다 — §4.2 §5의 안내가 정확한 `userPubkey`를 특정하지 못할 때 `*`로
보내고, §8.4가 밝히듯 **Track A 이전의 모든 배포**가 그 상태다. 즉 Track C가 먼저 출하되는 시점에
`*`는 사실상 기본 경로다.

④-bis 내용:
- `enrolled` 소스라면 `openclaw channels add --channel webchannel --account <account>`로 재-enrol
  하고 승인한다(`docs/AUTH.md:75-96`의 offline re-key 절차와 같은 형태).
- `static` 소스라면 운영자가 새 credential을 발급받아 설정에 넣는다.
- 두 경우 모두 **gateway가 정지된 상태에서** 수행한다(①이 이미 그 상태를 만든다).

**①은 "프로세스 하나"가 아니라 "모든 replica"다** (R4/P2-D). 구조적 차단은 register를 처리할
responder가 **하나도 없을 때만** 성립한다. 한 replica라도 살아 있으면 그것이 K_old를 계속
발급한다. §4.2 §2-bis가 이미 "모든 취약 replica를 drain·정지"라고 쓰고 있고,
`CHANGELOG.md:21-22`도 "drain and stop **every** vulnerable replica"이며, §7 T7이 "모든 replica
정지"의 운영 책임을 런북에 위임했다 — **§5-bis가 바로 그 런북 명세다.**

**⑥은 생략 가능한 마무리가 아니다** (R4/P1-A). gateway 재기동은 브라우저 소켓을 닫지 않으므로
재등록이 자동으로 일어나지 않으며, 대상은 **revoke된 peer가 아니라 그 gateway의 모든 peer**다 —
revoke되지 않은 peer, 다른 account의 peer까지 포함한다. 상세와 근거는 §6.6.3 비용 4.

**왜 ①이 맨 앞이어야 하는가 — 이것이 load-bearing이다.**

`addRevocation`은 **시각 하한(floor)** 이다 — *"refuse any credential… issued at or before this
timestamp"*(`packages/saas/src/account-revocation.ts:4-7`). **revoke 이후에 민팅된 credential은
설계상 통과한다**, 그리고 그것이 바로 §6.6.2의 재부트스트랩 복구를 성립시키는 성질이다.

gateway가 살아 있는 채로 revoke부터 하면 다음 창이 열린다:

```text
T   : revoke
T+ε : 앱이 즉시 재부트스트랩(§6.6.2가 지시하는 그대로) → 새 credential은 floor를 통과
T+ε': 그 클라이언트가 register → 아직 rotate하지 않았으므로 **K_old를 받는다**
T+Δ : 운영자가 rotate
그 결과: 유효한(비-revoke) credential + 건강한 소켓 + K_old.
       소켓이 건강하므로 다시 등록하지 않는다(`packages/plugin/src/nats-channel.ts:296-298`).
```

그리고 그 상태는 **양방향으로 조용하다** — 운영자에게 아무 신호도 가지 않는다:

- 클라이언트: `openMessage(...)`가 `null`을 반환하면 `if (msg)`에서 그대로 버려진다
  (`packages/client/src/nats-client.ts:1525-1526`, `:1846-1847`). 오류 리스너도, 상태 변화도 없다.
- agent: `console.warn` 한 줄뿐이다(`packages/plugin/src/nats-channel.ts:879-884`).

즉 운영자는 런북을 끝까지 초록불로 통과하고 현장에는 **영구히 벙어리인 세션**이 남는다.

**gateway를 먼저 세우면 이 창이 구조적으로 존재할 수 없다.** register를 처리할 responder가
없으므로 그 창 동안 누구도 K_old를 얻지 못한다. 이것은 절차적 주의가 아니라 구조적 차단이며,
새 메커니즘(발급 동결 스위치 등)을 하나도 요구하지 않는다.

> **온라인 rotation을 나중에 도입한다면 이 보호가 사라진다.** 그때는 revoke와 rotate 사이의
> 발급 동결(issuance freeze)이 **필수**가 된다. 이 문장을 런북과 §10 #6에 함께 남긴다.

②~③은 그대로다. ④는 §5-ter가 정하는 방식(Track B 이전=파일 리셋, 이후=offline `rotate` 도구)을
따른다. ⑥은 자동이 아니다 — §6.6.3의 운영 비용을 참조한다.

**섹션 5-ter — Track B 배포 후 ④의 방식이 바뀐다 (R2/P2-1, R3/P1-2)**

Track B가 착륙하면 **per-peer offline `rotate` 도구**가 생긴다. 계정 전체를 파괴하는 파일 리셋을
쓸 이유가 없어진다.

- Track B 배포와 **동시에** 런북을 갱신해 섹션 5(파일 단위 K 리셋)를 **"Track B 이전 배포 전용"**
  으로 강등하고, ④의 자리에 per-peer `rotate` 절차를 넣는다. §8.3 안무의 한 단계다.
- **①(gateway 정지)은 Track B 이후에도 그대로다.** `rotate` 도구 자체가 gateway 정지를 전제하기
  때문이다(§10 #6). 즉 이 순서는 Track B 전후로 바뀌지 않는다.
- 섹션 6의 "지금은 할 수 없는 것" 목록에서 **per-peer K rotation 항목을 제거**한다.
- generations 사이드카(`conversation-key-generations.json`, §6.1.2)는 감사 파일이며 유실되어도
  보안 영향이 없다. 그럼에도 **키 파일과 함께 옮기거나 지우지 말 것**을 권고하고(감사 연속성),
  손상 시 복구 기준은 §6.1.2를 따른다(키 문서에는 epoch가 없으므로 그것과 비교하지 않는다).

**섹션 6 — 지금은 할 수 없는 것 (Track A/B가 가져올 것)**
- per-credential 정밀 revocation을 위한 원장 조회
- resolver 반영의 자동화 + 수용 검증
- live connection 강제 종료 실증
- per-peer K rotation(파일 단위가 아닌) — Track B 배포 후 이 항목은 §5-ter에 따라 제거된다
- client-chosen nonce 결박에 의한 wrap 재생 방지
- 세대 카운터(감사)

### 4.3 CHANGELOG 문구 변경

**`CHANGELOG.md`** — `:28-31` 문단을 교체한다. 현재:

> Integrated, verified K rotation/state invalidation is tracked by #72. If that control is not
> available for a deployment, do not improvise by deleting files or running an unverified migration:
> keep the accounts disabled and escalate through the service's incident-response process.

변경 후(취지): #72 참조는 유지하되, **현재 사용 가능한 수단이 문서화되어 있음을** 명시하고
런북을 가리킨다. "do not improvise"는 유지한다 — 런북이 있다는 사실이 즉흥 조작을 허가하지
않는다. 추가할 요지:

- self-contained 배포의 NATS revocation은 `addRevocation` + resolver 반영이며 그 절차와 **전제
  조건(operator seed 옵트인 여부)** 은 `docs/CREDENTIAL_CONTAINMENT_RUNBOOK.md`에 있다.
- managed(Synadia/NGS) 배포는 provider 콘솔이 유일한 경로다.
- K 오프라인 리셋은 파일 단위·account 전체 영향의 파괴적 조작이며 런북 §5의 조건에서만 수행한다.
- 통합·검증된 rotation은 여전히 #72(Track B)다.

**`packages/plugin/CHANGELOG.md`** — `:41-43`에 같은 취지의 한 문장을 추가해 런북을 가리킨다.
`:37-39`의 "Rotate K and invalidate old encrypted peer state only through a verified control"은
그대로 두되, "verified control"이 아직 없을 때의 문서화된 대체 수단이 런북에 있음을 덧붙인다.

### 4.4 docstring 정정

`packages/plugin/src/conversation-key-store.ts:17-19` — "K must survive a gateway restart: history at
rest is sealed with it, and live devices hold an unwrapped copy…". `history-store.ts:50`가 in-process
전용임을 선언하므로 **디스크에 sealed history는 존재하지 않는다.** 정정 취지:

- K가 재시작을 견뎌야 하는 진짜 이유는 (1) live device가 unwrap된 사본을 들고 있고, (2) 같은
  peerId의 다른 장치가 동일 K를 받아야 하며, (3) history가 **장래에** 영속화될 때 그것이
  복호 기준이 되기 때문이다.
- 현재 history는 프로세스 메모리에만 존재한다는 사실을 명시하고 `history-store.ts:50`을 가리킨다.

이 정정은 주석만 바꾸므로 Track C에 포함한다.

---

## 5. Track A 설계 — SaaS 자격증명 원장 + revocation 워크플로

### 5.1 원장 레코드 형태

**비밀은 절대 담지 않는다.** `MintedNatsUserCreds`(`packages/saas/src/nats-user-creds.ts:91-111`)의
`userJwt`, `userSeed`, `userSeedRaw`는 **원장에 들어가지 않는다.** `BrowserCredentials`(`:217-230`)의
`userJwt`, `userSeedRaw`도 마찬가지다.

```ts
export type BrowserCredentialRecord = {
  /** 발급 시점의 tenant scope. */
  readonly tenant: string;
  /**
   * 이 credential이 발급된 authorization context. issueBrowserCredentials 자체는
   * accountId를 받지 않으므로(§5.3) 호출자가 명시적으로 공급한다.
   */
  readonly accountContext: string;
  /** 인증된 세션 subject. 절대 client 입력이 아니다. */
  readonly peerId: string;
  /** 민팅된 user public NKEY ("U…"). NATS revocation 키. */
  readonly userPubkey: string;
  /** 발급 시각 — unix **seconds** (§5.1.1). */
  readonly issuedAtSec: number;
  /** exp가 있으면 unix **seconds**, ttlSeconds 미지정이면 null(비만료). */
  readonly expiresAtSec: number | null;
  /** 원장이 아는 최종 상태. */
  readonly status: "active" | "revoked";
  /** revoke된 경우 addRevocation에 넘긴 unix **seconds**. 아니면 null. */
  readonly revokedAtSec: number | null;
};
```

금지 필드(계약으로 못 박고 테스트로 고정): `userJwt`, `userSeed`, `userSeedRaw`, `accountSeed`,
`operatorSeed`, conversation key, device private key. 로그·dry-run 출력·에러 메시지에도 동일 금지.

`expiresAtSec`이 `null`이라는 것은 §2.2 표대로 **현재 실제 배포의 기본값**이다. 원장의 첫 번째
운영 가치는 "우리 배포에 비만료 credential이 몇 개나 살아 있는가"에 답하는 것이다.

#### 5.1.1 시간 단위는 unix seconds 하나로 통일한다 (R1/P1-4)

초안은 한 struct 안에서 `issuedAt`/`expiresAt`을 ms로, `revokedAt`을 seconds로 두었다. 이것은
운영자가 record 값을 그대로 revocation 인자로 재사용할 때 **계정 규모의 사고**를 만든다:

- `addRevocation`의 `at`은 unix **seconds**이며(`packages/saas/src/account-revocation.ts:45-47`)
  검증은 "유한 양의 정수"뿐이다(`:72-76`). **상한이 없다.**
- ms 값(예: `1.75e12`)을 넘기면 revocation floor가 서기 58500년 근처가 된다. 그 키에 대해
  `addRevocation` 의미상 "이 시각 이전 발급분 거부"이므로 **영구 거부**가 된다.
- `*` 경로에서 같은 실수를 하면 그 account의 **모든** user JWT가 영구 거부된다 —
  `packages/saas/src/device-flow-enrollment.ts:690-695`의 agent credential 포함(§5.5).
- 초안은 fractional brick(`:72-76`이 막는 것)을 경고하면서 **크기(magnitude) 브릭**을 새로
  도입했다.

**결정:**

1. 원장 record, SPI, 라우트, dry-run 출력의 모든 시각 필드는 **unix seconds**다. 필드 이름에
   `Sec` 접미사를 붙여 호출부에서 단위 오인이 불가능하게 한다.
2. `BrowserCredentialLedger.nowSec()`도 unix **seconds**를 반환한다(§5.2). **SPI의 모든 시각
   인자·반환에 `Sec` 접미사를 붙인다** — 예외를 두지 않는다(R4/P2-F).
3. **`at`은 서버에서 유도한다.** 기본 경로에서 운영자는 `at`을 공급하지 않으며, 라우트가
   `ledger.now()`를 그대로 쓴다. 이것이 대부분의 사고를 원천 차단한다.
4. 그럼에도 `at`을 운영자 지정으로 남긴다면(과거 시점 지정 등 정당한 용례) **상한 검증을
   추가한다**: `at > now + MAX_SKEW_SEC`이면 거부. `MAX_SKEW_SEC`는 작은 상수(예: 300)로 고정하고
   설정으로 노출하지 않는다. 하한도 `at > 0`을 넘어 "chain 생성 시각 이전"을 거부할지는 구현
   시 판단한다(무해하므로 필수는 아니다).
5. 이 상한 검증은 **`addRevocation` 자체가 아니라 Track A 라우트 계층**에 둔다.
   `account-revocation.ts`의 검증은 "계정을 brick하지 않는 값"을 보장하는 저수준 계약이고,
   "운영자가 의도한 값"은 상위 계층의 관심사다. 저수준에도 상한을 넣고 싶다면 별도 결정이며
   기존 호출자(테스트) 호환을 확인해야 한다 — §10 #10.

### 5.2 SPI + conformance suite

`packages/saas/src/enrollment-repository.ts:42-54`의 `EnrollmentRepository` 인터페이스와
`packages/saas/src/enrollment-repository-conformance.ts`(`:7` `barrier`, `:19` `interpose`) +
`enrollment-repository-conformance.selftest.test.ts` 3종 세트가 이 저장소의 확립된 패턴이다.
**동일 shape를 따른다. 새 모양을 발명하지 않는다.**

```ts
export interface BrowserCredentialLedger {
  /**
   * 구현이 authoritative clock을 소유한다 (EnrollmentRepository:43과 동일 규약).
   * 반환 단위는 unix **seconds** — `EnrollmentRepository.now()`가 ms인 것과
   * (`enrollment-repository.ts:101`이 `Date.now`를 기본 clock으로 쓰고 `:113`이 그대로
   * 반환한다) 다르므로
   * 이름과 docstring 양쪽에 못 박는다(§5.1.1). 두 SPI를 한 코드베이스에서 섞어 쓰는
   * 구현자가 단위를 오인하지 않게 하는 것이 이 주석의 유일한 목적이다.
   */
  nowSec(): Promise<number>;
  recordIssuance(record: BrowserCredentialRecord): Promise<void>;
  getByUserPubkey(userPubkey: string): Promise<BrowserCredentialRecord | null>;
  listByPeer(tenant: string, peerId: string): Promise<readonly BrowserCredentialRecord[]>;
  /** dry-run blast radius 계산용. 명시적 상한과 커서를 갖는다. */
  listActive(
    filter: { tenant?: string; accountContext?: string },
    cursor: string | null,
    limit: number,
  ): Promise<{ records: readonly BrowserCredentialRecord[]; nextCursor: string | null }>;
  markRevoked(userPubkey: string, revokedAtSec: number): Promise<boolean>;
}
```

- in-memory 기본 구현(`MemoryBrowserCredentialLedger`)을 함께 제공한다 —
  `MemoryEnrollmentRepository`(`packages/saas/src/enrollment-repository.ts:56-63` 옵션 shape)와
  동일 위치·동일 성격.
- exported conformance suite를 제공해 durable adapter가 실백엔드로 통과시키도록 한다.
  `docs/AUTH.md:69`가 이미 "Durable adapters must pass the exported core and fault conformance
  suites against the real shared backend"를 계약으로 서술하므로 그 문장의 적용 대상을 넓히는
  형태가 된다.
- `now()`를 SPI에 두는 이유는 `EnrollmentRepository`와 같다: 발급/폐기 시각 판정이 발급자 로컬
  시계가 아니라 저장소 시계를 따라야 감사가 성립한다.

**원장의 신뢰 등급을 정직하게 규정한다.** 원장은 "우리가 발급한 것으로 알고 있는 목록"이지
"실제로 유효한 credential의 완전 집합"이 아니다. 원장 기록이 실패해도 credential은 이미
민팅되었을 수 있다(§5.3의 순서 문제). 이 비대칭을 문서와 타입 주석에 명시한다.

### 5.3 `issueBrowserCredentials` hook point

현재 시그니처(`packages/saas/src/nats-user-creds.ts:273-275`)는
`IssueBrowserCredentialsOptions`(`:235-261`)를 받고 `BrowserCredentials`를 반환한다. **accountId를
받지 않는다.** 브라우저 권한이 accountId를 와일드카드하기 때문이다(`:171-172`).

따라서 원장 계측은 **선택적 additive 옵션**으로 넣는다:

```ts
export type IssueBrowserCredentialsOptions = {
  // …기존 필드…
  /** 공급되면 발급을 이 원장에 기록한다. 생략하면 현재 동작과 byte-identical. */
  ledger?: BrowserCredentialLedger;
  /**
   * 원장에 기록할 authorization context. `ledger`가 있을 때 필수.
   * 브라우저 grant 자체는 accountId를 와일드카드하므로(§2.3) 이 값은 권한이 아니라
   * 감사 라벨이다.
   */
  accountContext?: string;
};
```

- `ledger` 미공급 시 기존 동작과 완전히 동일해야 한다(reference/demo/example 세 호출자가 즉시
  깨지지 않도록).
- `ledger`가 있는데 `accountContext`가 없으면 **fail-closed로 throw**한다. 기존 wrapper가 이미
  `ttlSeconds`(`:276-282`)와 `peerId`(`:283-285`)를 이 방식으로 검증하므로 같은 자리에 같은 모양의
  guard를 추가한다.

**순서 문제 (반드시 결정하고 문서화):** 민팅 후 기록인가, 기록 후 민팅인가?

| 순서 | 실패 시 결과 |
|---|---|
| mint → record | 기록 실패 시 **원장에 없는 살아 있는 credential**(추적 불가) |
| record → mint | 민팅 실패 시 **존재하지 않는 credential의 유령 기록**(무해) |

권고: **record → mint**. `userPubkey`는 `createUser()`로 keypair를 먼저 만들면 JWT 인코딩 전에
확정되므로, 기록에 필요한 모든 비-비밀 필드를 민팅 완료 전에 알 수 있다. 유령 기록은 무해하지만
추적 불가 credential은 이 이슈가 존재하는 이유 그 자체다. 다만 이 순서를 구현하려면
`mintNatsUserCreds`(`:118`) 내부의 keypair 생성과 JWT 인코딩(`:186-200`) 사이에 seam이 필요하다 —
wrapper에서 원장을 다루려면 그 중간 값을 wrapper까지 끌어올려야 한다. **구현 난이도가 있으므로
§10 미해결 질문 #4로 올린다.**

기록 실패를 발급 실패로 만들 것인가도 같은 결정에 딸린다. 권고는 **fail-closed** (기록 못 하면
발급하지 않는다) — 그것이 원장을 감사 가능하게 만드는 유일한 방법이다. 대신 원장 장애가 로그인
플로 전체를 막는다는 가용성 비용을 명시한다.

### 5.4 인증된 operator revoke 라우트

`packages/saas/src/admin-auth.ts:5-10`의 `authorizeEnrollmentAdmin`(bearer + `timingSafeEqual`,
미설정 시 503 fail-closed)을 그대로 재사용한다. 라우트는
`packages/saas/src/enrollment-http-handler.ts:39`의 handler에 편입한다. 그 handler는 이미
`:64-67`에서 경로 패턴으로 admin action을 식별하고 `:69-78`에서 **body 파싱 전에** 인가한다 —
같은 자리에 새 action을 추가한다.

제안 라우트(reference/demo profile 공통):

```text
POST /admin/credentials/revoke           ← 단일 credential
  body: { userPubkey: "U…", dryRun?: boolean }        // at은 서버 유도 (§5.1.1)
POST /admin/credentials/revoke-peer      ← 한 peer의 전체 집합 (§5.4.2)
  body: { tenant, peerId, confirm?: "<dry-run 토큰>" }
POST /admin/credentials/revoke-all       ← "*" 경로, 항상 2단계
  body: { confirm: "<dry-run이 반환한 토큰>" }
GET  /admin/credentials                  ← 원장 조회 (비밀 없음)
```

- 응답과 로그는 §5.1 금지 필드를 절대 포함하지 않는다.

#### 5.4.1 인가 게이트는 **method-aware** 여야 한다 (R1/P2-2)

초안은 "`:67`의 `isAdminAction` 목록에 새 action 이름을 추가한다"고 썼다. 그것은 위 `GET
/admin/credentials`에 대해 **구조적으로 불가능**하다:

```ts
// packages/saas/src/enrollment-http-handler.ts:67
const isAdminAction = req.method === "POST" && ([...].includes(action));
```

`isAdminAction`은 **POST로 한정**되어 있고, `:92`가 `if (!isAdminAction) return json(res, 404,
{ error: "not found" })`로 그 외 전부를 404로 떨어뜨린다. 따라서 GET 라우트는 목록에 이름을
넣어도 도달하지 못한다.

**진짜 위험은 그 다음이다.** 이 사실을 만난 구현자가 가장 쉽게 취하는 우회는 라우트를 `:92`
**위로** 끌어올리는 것인데, 인가 블록은 `:69-78`에 있고 `isAdminAction`으로 게이트되므로
그렇게 올린 GET 라우트는 **인증 없이** 동작한다. 그것은 전체 peer/`userPubkey` 인벤토리를
무인증 공개하는 것이다 — 정확히 이 트랙이 만들려는 원장의 최악 노출.

**결정:** action 목록을 문자열 배열에서 **method-aware 테이블**로 바꾼다.

```ts
// 개념 형태. 정확한 자료구조는 구현 재량.
// 주의: `action`은 `openPath.slice(1)`이다 (enrollment-http-handler.ts:66) — 즉 선행 슬래시만
// 제거한 전체 경로다. 따라서 신규 항목은 "admin/" 접두사를 **포함해야** 한다. R1 초안은
// "credentials/revoke"로 적어 어느 요청과도 매칭되지 않았다 (R2/P2-5 nit).
const ADMIN_ROUTES: ReadonlyArray<{ method: "GET" | "POST"; action: string }> = [
  { method: "POST", action: "approve" },   // 기존 3개는 그대로 (경로가 곧 action)
  { method: "POST", action: "deny" },
  { method: "POST", action: "revoke" },
  // 신규 — 실제 경로 `/admin/credentials/...` → action `admin/credentials/...`
  { method: "POST", action: "admin/credentials/revoke" },
  { method: "POST", action: "admin/credentials/revoke-peer" },
  { method: "POST", action: "admin/credentials/revoke-all" },
  { method: "GET",  action: "admin/credentials" },
];
const isAdminAction = ADMIN_ROUTES.some(r => r.method === req.method && r.action === action);
```

문자열이 실제 요청과 매칭되는지 검증하는 테스트를 §5.4.1 회귀 목록에 **명시적으로** 넣는다 —
매칭 실패는 401이 아니라 **404**로 나타나므로, 404를 "라우트 없음"으로 오독하면 인가 게이트가
비어 있다는 사실이 숨는다.

- 기존 세 action의 동작은 byte-identical하게 보존한다(전부 POST였으므로 의미 변화 없음).
- `:80`의 `const payload = req.method === "POST" ? await body(req) : {}`가 이미 GET을 다루므로
  body 파싱은 손대지 않는다.
- **회귀 테스트 필수**(`packages/saas/src/enrollment-http-handler.test.ts`):
  1. `GET /admin/credentials`가 `Authorization` 없이 **401**(토큰 미설정이면 503)을 반환한다.
     200이나 404가 아니다 — 404는 "라우트가 인가 앞에 있다"를 숨긴다.
  2. 올바른 bearer로는 200.
  3. `POST /admin/credentials/revoke`도 동일하게 무인증 401.
  4. 인가 실패 응답 본문에 원장 내용이 전혀 없다.

#### 5.4.2 per-peer 일괄 revoke (R1/P2-3)

#72는 "one credential **or an explicitly reviewed broader set**"을 요구한다. 초안은 단일과 `*`
두 극단만 두어 **중간항을 빠뜨렸다.**

중간항이 실재하는 이유: `packages/saas/reference/enrollment-server.ts:747-752`는 `/nats-user`
요청마다 **새 credential을 민팅**하며 TTL을 넘기지 않는다. 즉 한 사용자가 로그인할 때마다 비만료
credential이 하나씩 쌓인다. `demo/saas-server.ts:584-590`과
`examples/webchannel-app/server/index.ts:344-351`도 같은 형태다. 따라서 **"이 peer의 credential을
전부 끊어라"가 실무에서 가장 흔한 요청**이며, 그것을 `*`로 처리하면 agent까지 끊는다.

- `listByPeer(tenant, peerId)`(§5.2)가 그 집합을 준다.
- `*`와 **동일한 dry-run/confirm 규율**을 적용한다: 먼저 dry-run이 대상 건수·비만료 건수·
  `userPubkey` 목록(비밀 아님)을 반환하고 확인 토큰을 발급하며, 실행은 그 토큰을 요구한다.
- 원장 커버리지 한계를 여기서도 함께 보고한다 — Track A 도입 이전 발급분은 목록에 없다(§8.4).
- 실행은 각 `userPubkey`에 대한 `addRevocation` 반복이며, **부분 실패를 정직하게 보고한다**:
  성공/실패 건수와 실패한 pubkey를 반환하고, 원장 `status`는 실제 성공한 것만 `revoked`로
  옮긴다. 전체를 원자적으로 만들려 하지 않는다 — 계정 JWT 재서명과 resolver 반영이 건마다
  일어나므로 원자성을 주장하면 거짓이 된다.
- resolver 반영은 **마지막에 한 번**이면 충분하다: `addRevocation`은 이전 revocations를 보존하며
  누적하므로(`packages/saas/src/account-revocation.ts:83`), 모든 항목을 누적한 최종 JWT 하나를
  publish한다.

### 5.5 `*` wildcard blast radius와 dry-run

`"*"` revocation은 계정의 모든 user를 끊는다(`packages/saas/src/account-revocation.ts:43-44`).
같은 NATS account seed가 agent credential도 민팅한다
(`packages/saas/src/device-flow-enrollment.ts:690-695`, role `"agent"` at `:693`). 따라서 `*`는
**브라우저 사고 대응이 에이전트 전면 정지로 번지는 조작**이다.

설계:

1. `*` revoke는 **항상 dry-run을 먼저 요구한다.** 단일 호출로 실행할 수 없다.
2. dry-run 출력은 원장 기반 영향 집계다: tenant별/accountContext별 active 레코드 수, 그중 비만료
   개수, 그리고 **"원장에 없지만 이 account seed로 민팅된 agent credential이 함께 끊긴다"는
   명시적 경고**(원장은 브라우저만 안다 — agent는 `mintNatsUserCreds`를 직접 호출하므로
   §5.3 hook을 지나지 않는다).
3. dry-run은 확인 토큰을 반환하고, 실제 실행은 그 토큰을 요구한다.
   **토큰은 보안 통제이므로 명세가 필요하다** (R5/P2-3). 명세 없이 두면 이전의, 범위가 다른
   dry-run에서 복사해 붙일 수 있는 상수 문자열로 전락해 "검토된 집합"과 "실행된 집합"의 연결이
   끊긴다. 두 가지 중 하나를 택한다:
   - **(a) SPI에 발급/검증을 추가한다** — `BrowserCredentialLedger`에
     `issueConfirmation(digest, expiresAtSec)` / `consumeConfirmation(token, digest)`를 두고
     단일 사용으로 만든다. 상태를 갖지만 감사 기록이 남는다.
   - **(b) 무상태 MAC** — 서버 비밀로 `HMAC(canonicalDigest(reviewedSet) ‖ expiresAtSec)`를
     계산해 토큰으로 쓰고, 실행 시 **실행 대상 집합에서 digest를 다시 계산해** 비교한다. 상태가
     없고 구현이 작다.

   어느 쪽이든 **필수 성질은 동일하다**: 토큰이 **정확히 그 검토된 집합에 결박**되어야 하고
   (집합이 바뀌면 검증 실패), 짧은 만료가 있어야 하며, 토큰 자체는 비밀이 아니지만 재사용
   가능해서는 안 된다. `canonicalDigest`는 `userPubkey` 정렬 목록에 대한 결정적 해시로 정의한다.
   **권고: (b)** — 새 SPI 메서드 없이 결박을 얻는다.
4. dry-run 출력에 비밀이 없음을 테스트로 고정한다(이슈 #72의 "Incident warnings and dry-run output
   expose no secrets" 기준).

**원장의 커버리지 한계를 dry-run이 정직하게 말하게 만드는 것이 핵심이다.** 원장은 브라우저 발급의
완전 집합이 되려 하지만, agent credential과 원장 도입 이전 발급분은 알지 못한다. dry-run이
"내가 모르는 것"을 함께 보고하지 않으면 blast radius 표시는 거짓 안심을 준다.

### 5.6 **선행 결정: resolver 운영 모드** (Track A 착수 전제)

§2.8이 실측한 대로 현재는 `resolver: MEMORY` + `resolver_preload`다. 개정된 account JWT를 반영할
채널이 없다. 세 가지 선택지:

**옵션 1 — MEMORY 유지 + 설정 재작성 + `--signal reload`**
- 변경 범위: `demo/saas-server.ts:192-199`(resolver.json 배출)와 `demo/run.sh:195-209` 계열
  스크립트에 "갱신 후 reload" 경로 추가.
- 장점: topology 변경 없음. 기존 5개 스크립트의 구조를 유지.
- 단점: SaaS 프로세스가 **nats-server 프로세스에 신호를 보낼 수 있어야 한다** — 같은 호스트,
  같은 사용자, PID 접근이라는 배포 결합이 생긴다. 컨테이너/원격 relay에서는 성립하지 않는다.
  "publishes to the resolver"라는 이슈 문구와도 의미가 어긋난다(publish가 아니라 config rewrite).
  reload의 성공/수용을 확인할 프로토콜 수준 신호가 없어 "verifies acceptance"가 약해진다.

**옵션 2 — full/NATS account resolver로 이전 + `$SYS.REQ.CLAIMS.UPDATE`**
- 변경 범위: 5개 기동 스크립트의 resolver 블록 전면 교체, resolver 디렉터리/시스템 계정 도입,
  SaaS가 시스템 계정 자격으로 `$SYS.REQ.CLAIMS.UPDATE`를 발행.
- 장점: 이슈 #72의 acceptance criteria를 **문자 그대로** 만족한다. publish에 대한 응답이 있으므로
  "verifies acceptance"가 실제 검증이 된다. live connection 종료도 nats-server가 담당한다.
- 단점: 가장 큰 변경. 시스템 계정이라는 새 고가치 자격증명이 생긴다. 5개 e2e 스크립트 전부
  회귀 위험. `@nats-io/*` 사용은 `packages/saas`/`e2e`에서만 허용되므로
  (`packages/saas/src/nats-user-creds.ts:38`) 이 코드는 반드시 SaaS 쪽에 머문다.

**옵션 3 — managed(Synadia/NGS) 전제, self-contained는 문서화된 수동 절차만**
- 변경 범위: 최소. self-contained는 Track C 런북의 수동 절차로 두고, managed 모드에 대해서는
  "provider 콘솔에서 수행하라"고 보고만 한다.
- 장점: 가장 싸다.
- 단점: self-contained가 **1급 지원 모드인데** 자동 봉쇄를 못 갖는다. e2e·demo가 전부
  self-contained이므로 "real NATS resolver로 live disconnect를 실증"하는 이슈 #72 테스트를 아예
  작성할 수 없다.

**결정: 옵션 2 (사용자 확정).** 아래는 그 근거이며, §10에서 미결 항목으로 내렸다.

**옵션 2가 포기하는 것 — 반드시 함께 기록한다** (R5/P2-5). 옵션 1/3에서는 revocation 적용이
nats.conf 재작성 + **재기동**을 요구하고, 그 재기동은 relay의 **모든** 연결을 끊는다. 그 부수효과가
브라우저 소켓을 닫아 `onConnected`를 다시 띄운다. 옵션 2에서는 `$SYS.REQ.CLAIMS.UPDATE`가
**revoke된 연결만** 끊으므로 **revoke되지 않은 모든 소켓이 살아남는다.** 즉 옵션 2는
"부수적 소켓 리셋"을 잃고, 그 결과 §4.2 §5-bis의 ⑥(전체 강제 새로고침)이 **조건부에서 무조건으로
바뀐다.** 이것은 옵션 2를 물리는 이유가 아니라 ⑥의 필수성을 확정하는 근거다.

> `--signal reload`와 **재기동**을 혼동하지 않는다. reload는 설정을 다시 읽을 뿐 연결을 끊지
> 않는다. 모든 연결을 끊는 것은 재기동이다. 이 문서의 이전 판본이 둘을 "reload/재기동"으로
> 묶어 쓴 곳들을 R5에서 정정했다.

**착수 순서 — resolver 이전이 Track A의 첫 서브태스크다.** §5.6이 스스로 권고한 완화책을
확정 사항으로 올린다: **resolver 이전만 먼저 착륙시키고 e2e 5종
(`e2e/local/run-all-real.sh`, `run-enrolled-transport.sh`, `run-derived-trust.sh`,
`run-two-account-isolation.sh`, `demo/run.sh`)이 전부 green인지 확인한 뒤** 원장·라우트를 얹는다.
두 가지를 한 PR에 섞으면 resolver 회귀와 원장 버그를 구분할 수 없다.

**(과거 권고 근거, 기록용)** 이유는 두 가지였다. 이유는 두 가지다. (1) 이슈 #72의 두 acceptance criteria("publishes and verifies",
"Active revoked connections terminate")는 옵션 1·3으로는 **정직하게 만족했다고 말할 수 없다** —
만족한 척하는 것이 이 저장소가 과거에 겪은 실패 모드다. (2) 실서버 통합 테스트 선례가 이미
있다: `packages/saas/src/nats-permissions-realserver.test.ts:1-25`가 실제 nats-server를 띄워
권한 집행을 검증하고 바이너리 부재 시 자동 skip한다(`:23-24`). 그 하네스가 resolver 검증의
착지점이 된다.

비용 완화: 옵션 2를 Track A의 **첫 서브태스크**로 분리해, resolver 이전만 먼저 착륙시키고 e2e
5종이 green인지 확인한 뒤 원장/라우트를 얹는다.

**이 결정 없이는 Track A를 시작하지 않는다.** §10 #1.

### 5.7 `returnOperatorSeed` 롤아웃 위험

§2.9의 실측대로, 옵트인 없이 생성된 persisted chain은 **영원히** operator seed를 얻지 못한다
(`packages/saas/src/setup-trust-chain.ts:90-93`). Track A는 이 상태를 조용히 실패하게 두면 안 된다.

- revoke 라우트는 operator seed 부재를 **명시적이고 실행 가능한 오류**로 보고한다:
  "이 배포는 revocation 불가 상태다. 원인은 chain 생성 시 `returnOperatorSeed` 미옵트인이며,
  복구는 chain 재생성(전 tenant outage)뿐이다."
- 부재를 사고 발생 시점이 아니라 **평시에** 알 수 있어야 한다. 원장 조회 라우트(`GET
  /admin/credentials`) 응답에 `revocationCapable: boolean`을 포함하는 것을 권고한다. seed 값은
  물론 절대 노출하지 않는다.
- managed 모드에서는 operator가 애초에 존재하지 않는다(`packages/saas/src/types.ts:41-42`) —
  이것은 결손이 아니라 provider 위임이므로 별도 상태값으로 구분해 보고한다.

---

## 6. Track B 설계 — K rotation

> **하드 전제 3가지는 §0.3에 선언되어 있다.** 요약: (1) 신선도 앵커는 **client-chosen**이어야
> 한다, (2) epoch는 감사 메타데이터이며 암호 결박이 아니다, (3) 재등록 강제는 Track A + 임베딩
> 애플리케이션 재부트스트랩으로만 성립한다.
>
> **R2에서 범위가 크게 줄었다.** `ENVELOPE_VERSION`, `canonicalAad`, `e2e-session.ts`,
> `conversation-keys.json` 문서 버전은 **전부 그대로 둔다.** 상세 근거는 §6.4.

### 6.1 epoch 모델 — 감사 메타데이터

#### 6.1.1 무엇이고 무엇이 아닌가

- epoch는 `(tenant, accountId, peerId)`마다 **단조 증가하는 양의 정수**다. `(tenant, accountId)`는
  store 디렉터리가 결정한다(`packages/plugin/src/conversation-key-store.ts:123-130` →
  `packages/plugin/src/storage-paths.ts:61`, `:79`).
- **암호 결박이 아니다.** wrap AAD에도 envelope AAD에도 들어가지 않는다(§6.4).
- 용도는 하나뿐이다: 운영자가 "이 peer가 몇 세대인지, 언제 rotate되었는지" 확인하는 것.
- **단조성은 best-effort이며 durable하지 않다** (R3/P2-1). 사이드카 파일이 살아 있는 한 번호는
  절대 줄지 않지만, 파일이 유실되면 1부터 다시 센다(§6.1.2). 그것을 코드로 막을 방법이 없다 —
  파일을 지우지 않게 하는 것은 런북의 일이다. 따라서 **#72의 "monotonically versioned epoch"
  AC가 충족되었다고 주장하지 않는다**(§0.2 이탈 (e)). 초안은 §6.1.1에서 충족을 주장하면서
  §6.1.2에서 리셋을 인정해 **자기모순**이었다.
- 보안 영향은 없다: epoch는 어느 AAD에도 없으므로(§0.2 (d)) 번호 재사용이 과거 wrap이나
  envelope를 되살리지 않는다. 잃는 것은 감사 라벨의 정확성뿐이다.
- 초기값 1. epoch도 rotate 시각도 비밀이 아니다. K는 절대 로그에 넣지 않는다.

#### 6.1.2 generations 사이드카 파일

epoch를 `conversation-keys.json` **안에** 넣지 않는다. 별도 파일에 둔다.

```jsonc
// ~/.openclaw-webchannel-v2/<tuple-namespace>/conversation-key-generations.json
{
  "version": 1,
  "storageIdentity": { … },
  "generations": { "<peerId>": { "epoch": 7, "rotatedAtSec": 1770000000 } }
}
```

**왜 별도 파일인가 — 세 가지 이유:**

1. **키 파일을 건드리지 않는다.** R1은 `conversation-keys.json`을 v2→v3로 올리려 했고, 그것이
   R1/P1-1(파서를 잘못 배치하면 전 계정 K 소실)과 R2/P2-4(`legacy-storage-migration.ts`의
   write-side `:1789`·`:1816`, parse-side `:1702`·`:1823`·`:1849` 전수 대응)를 낳았다. 감사
   카운터를 위해 **암호 자료를 담은 파일의 스키마를 바꾸는 것은 나쁜 거래다.** 사이드카는 그
   위험을 0으로 만든다. `parseConversationKeyDocument`(`packages/plugin/src/conversation-key-document.ts:22`),
   `serializeConversationKeyDocument`(`:75`), `conversationKeyMapsEqual`(`:94-106`),
   `CONVERSATION_KEY_DOCUMENT_VERSION`(`:11`) 모두 **변경 없음**.
2. **단조성이 키 파일 조작을 견딘다.** quarantine(`conversation-key-store.ts:220-244`), 런북의
   파일 이동(§4.2 §5), 백업 복원(§8.3), legacy ambiguous quarantine
   (`packages/plugin/src/legacy-storage-migration.ts:329-344`) — 넷 다 **키 파일 하나**를
   대상으로 한다. 사이드카는 살아남는다.
3. **store API가 바뀌지 않는다.** epoch를 어느 호출자도 암호 목적으로 쓰지 않으므로
   `getOrCreate`/`get`은 계속 `Uint8Array`를 반환한다. `peerSessionKeys`
   (`packages/plugin/src/nats-channel.ts:202`)의 값 타입도 그대로다.

**읽기 실패 정책 — fail-open이다** (R2/P2-3). 감사 파일이므로 등록을 막으면 안 된다.

- 파일 부재 → 빈 상태로 간주(정상, 최초 도입 시).
- parse 실패·identity mismatch·I/O 오류 → **error 로그 후 빈 상태로 계속한다.** 격리(archive)도
  하지 않고 throw도 하지 않는다. 키 파일의 fail-closed 정책
  (`packages/plugin/src/conversation-key-store.ts:216-219`가 ENOENT만 빈 Map으로 처리하고
  나머지는 quarantine/throw로 보내는 것)과 **의도적으로 다르다** — 이 파일에는 암호 자료가 없다.
- R1 초안은 이 파일을 fail-closed로 만들려 했다. 그러면 읽을 수 없는 감사 파일 하나가 계정 전체
  register를 `REGISTER_FAILED`로 만들고, §4.2가 그 파일 조작을 금지하므로 복구 경로가 없다.
  **철회한다.**

**쓰기 실패 정책 — 경로마다 다르다** (R3/P2-3).

| 경로 | 사이드카 쓰기 실패 시 |
|---|---|
| **register hot path** — `getOrCreate`의 신규 생성 분기(동기 register 처리 중) | **swallow + log.** register는 성공한다. 감사 파일 하나 때문에 신규 등록을 `REGISTER_FAILED`로 만들지 않는다 — 읽기 fail-open과 같은 근거다. |
| **offline `rotate` 도구** (§6.5) | **fail-closed.** 도구가 오류 종료하고 키를 교체하지 않는다. 운영자가 즉시 보고 고칠 수 있는 대화형 맥락이며, 여기서 카운터를 잃으면 rotate 사실 자체가 기록되지 않는다. |

이 비대칭을 코드 주석에도 남긴다. **양쪽을 같은 헬퍼로 구현하되 정책을 인자로 받는 형태를
권고한다** — 한쪽 정책을 다른 쪽에 무심코 복사하는 것이 R2/P2-3(읽기)과 R3/P2-3(쓰기)이 각각
드러낸 실패 모드다.

사이드카 쓰기는 `ConversationKeyStore.persist()`(`packages/plugin/src/conversation-key-store.ts:272-287`)를
**거치지 않는 별도 경로**로 구현한다. (1) `persist()`는 키 문서 직렬화에 묶여 있고,
(2) `_beforePersist` 테스트 seam이 `:273`에서 **모든** atomic write 앞에 발화하므로 사이드카가 같은
경로를 타면 §7의 R-e(사이드카 커밋 성공 후 키 커밋만 실패시키기)를 작성할 수 없다.

**손실 위험은 감사 손실뿐이다.** epoch가 어떤 AAD에도 없으므로, 카운터가 1로 되돌아가도 재사용된
번호가 과거 wrap/envelope를 되살리지 않는다(그 wrap은 §6.3의 clientNonce에서, 그 envelope는
새 랜덤 키에서 이미 막힌다). R1이 이 파일에 부여했던 **보안** 역할은 R2에서 소멸했다.

- 단독 손실은 안전하다: `newEpoch = (generations[peerId]?.epoch ?? 0) + 1`(§6.5.1과 동일 식)은
  카운터가 없으면 1부터 다시 세지만, 그것은 감사 라벨의 부정확일 뿐이다.
  *(R1 초안은 이 자리에 `max(generations[peerId] ?? 0, 0) + 1`을 적었는데 값이
  `{epoch, rotatedAtSec}` 객체이므로 그 식은 `NaN`이다 — R3/P2-2. 정본은 §6.5.1의 식이다.)*
- **복구는 유계이되 "키 파일의 epoch보다 큰 값"이라는 기준은 쓸 수 없다** (R3/P2-2). 키 문서에는
  epoch가 없고(`packages/plugin/src/conversation-key-document.ts:16-20`) §6.2가 의도적으로 그렇게
  유지한다. 실제 기준은 **"이 account가 과거에 도달했을 법한 값보다 크게"** 이며, 확신이 없으면
  넉넉히 큰 값을 쓴다. 과도한 값은 무해하다 — 감사 라벨이 건너뛸 뿐이다.

#### 6.1.3 `getOrCreate`는 기존 entry의 epoch를 절대 바꾸지 않는다 (R2/P2-6)

명시적 계약으로 고정한다.

- `getOrCreate(peerId)`가 기존 키를 반환하는 경로(`packages/plugin/src/conversation-key-store.ts:165-166`,
  fresh-read 경로는 `:181-183`)에서는 generations 파일을 **읽지도 쓰지도 않는다.**
- `(generations[peerId]?.epoch ?? 0) + 1`은 **발급(신규 생성 또는 rotate)에만** 적용된다.
  조회에는 적용되지 않는다.
- 이 계약이 없으면: 재기동 후 조회가 epoch를 올려 agent가 실제로는 바뀌지 않은 K에 더 높은
  세대를 붙인다. R1 설계(epoch가 AAD에 있던)에서는 그것이 모든 라이브 브라우저의 AAD를
  어긋나게 해 계정을 fail-closed로 만들었을 것이다. R2 설계에서는 감사 오염에 그치지만,
  **계약을 명시하지 않으면 구현자가 틀리게 만들 유인이 그대로 남는다.**

### 6.2 conversation-key 문서는 v2 그대로 둔다

R1의 v2→v3 승격 계획을 **전면 철회한다.** §6.1.2의 근거 1이 이유다.

변경 없는 것(R1이 바꾸려 했던 것):

| 대상 | R1 계획 | R2 결정 |
|---|---|---|
| `packages/plugin/src/conversation-key-document.ts:11` `CONVERSATION_KEY_DOCUMENT_VERSION` | 2 → 3 | **2 유지** |
| `:22` `parseConversationKeyDocument` | `{2,3}` 수용 + 승격 | 변경 없음 |
| `:75` `serializeConversationKeyDocument` | struct 직렬화 | 변경 없음 |
| `:121-141` `parseKeys` | struct 파서 | 변경 없음 |
| `:94-106` `conversationKeyMapsEqual` | key-only 비교 명시 | 변경 없음 (이미 key-only) |
| `packages/plugin/src/legacy-storage-migration.ts` write/parse 전수 (`:344`, `:1702`, `:1789`, `:1816`, `:1823`, `:1849`) | v3 대응 | **변경 없음** |
| v1 마이그레이션 키에 부여할 epoch | 미정 (R2/P2-4가 지적) | **질문 자체가 소멸** — 문서에 epoch가 없다 |

따라서 R1의 테스트 R-a(승격이 quarantine을 유발하지 않는지), R-b(legacy destination 검사),
R-j(`conversationKeyMapsEqual` epoch 비교)도 **불필요해진다.** §7에서 제거한다.

`ConversationKeyStore`에 남는 변경은 **`rotate(peerId)` 추가와 generations 사이드카 관리**뿐이다.

### 6.3 wrap AAD: `wrapAad(peerId)` → `wrapAad(peerId, clientNonce)`

#### 6.3.1 R1의 처방(서버 nonce)은 불충분하다 — relay가 challenge도 재생한다

R1은 PoP challenge nonce를 결박하면 재생이 막힌다고 결론지었다. **틀렸다.** 그 nonce는 **서버가
발행해 relay를 통해 브라우저에게 전달**되며, challenge reply는 어떤 방식으로도 인증되지 않는다:
브라우저는 `packages/client/src/pop-register.ts:258`에서 `{op:"challenge", token}`을 요청하고
`:272`에서 `challengeReply.nonce`를 그대로 신뢰한다. 서명 검증도, 발신자 확인도 없다.

적대적 relay는 따라서 **triple 전체를 재생**할 수 있다:

```text
사전: relay가 과거 라운드의 (challenge reply: N_old, register reply: W_old)를 캡처.
      W_old = Enc(wrapKey, K_old, aad=wrapAad(p, N_old)).
1. 운영자가 rotate → agent는 K_new 보유.
2. 브라우저가 challenge 요청. relay가 agent에 전달하지 않고 **N_old를 직접 응답**한다.
3. 브라우저가 N_old에 서명해 register 전송. relay가 **agent에 전달하지 않는다.**
4. relay가 W_old를 reply로 반환.
5. 브라우저는 wrapAad(p, N_old)로 연다 → W_old의 AAD와 정확히 일치 → Poly1305 통과
   → K_old 채택.
```

agent는 이 라운드에 **한 번도 관여하지 않았다.** 따라서 "agent가 nonce를 이미 소비했다"
(`packages/plugin/src/pop-challenge.ts:162-173`)는 방어는 발동하지 않는다. `consume()`은
agent에 도달한 요청만 태운다.

> R1이 정확히 뒤집은 지점: `consume()`은 **agent를 재생으로부터** 보호한다(같은 nonce로 두 번
> 등록 불가). 그것은 **브라우저를 재생으로부터** 보호하지 않는다. 두 방향은 다른 문제다.

epoch를 넣어도 마찬가지다 — reply의 epoch 필드 역시 relay가 고른다.

**wrap 경로가 특별한 이유**: wrap 키는 `wrapKey = HKDF(X25519(agentIdentity.private,
devicePublicKey), …)`이며(`packages/plugin/src/late-join-decryptor.ts:230-236`) **K에도 epoch에도
의존하지 않는다.** rotation을 넘어 안정적이다. 그래서 AEAD가 세대를 구분해 주지 않고 AAD가
유일한 방어선이다. (envelope 경로는 정반대다 — §6.4.)

device X25519 키는 client 인스턴스마다 새로 생성되므로
(`packages/client/src/browser-jwt-entry.ts:104`, `:257`에서 `crypto.subtle.generateKey`, 전달은
`:182`/`:329`) **새 인스턴스에서는** wrap 키가 달라 재생이 무의미하다. 그러나 **같은 인스턴스**의
재연결·재등록에서는 device 키가 그대로이므로 위 공격이 성립한다.

#### 6.3.2 정정: 앵커는 **client-chosen** 이어야 한다

브라우저를 재생으로부터 보호하려면 AAD에 **브라우저 자신이 만든, relay가 고를 수 없는 값**이
있어야 한다.

```ts
// register 요청에 추가되는 필드. 브라우저가 매 register 시도마다 새로 생성.
clientNonce: string   // base64url(32 random bytes), crypto.getRandomValues

export function wrapAad(peerId: string, clientNonce: string): Uint8Array;
```

- 브라우저는 `clientNonce`를 로컬에서 생성하므로 relay가 과거 값을 강요할 수 없다. 재생된
  `W_old`는 `C_old`에 결박되어 있고 브라우저는 `C_new`로 AAD를 계산한다 → 불일치 → 실패.
- agent는 `clientNonce`를 register 요청 본문에서 읽는다. 파싱 지점은 top-level
  (`packages/plugin/src/nats-register.ts:174`의 `parsed`)이므로 **wrap 지점 `:359`에서 스코프
  안에 있다.** R1이 쓰려 했던 PoP nonce는 `if (identity.popPublicJwk) {` 블록 안의
  `:313`에 block-scoped라 wrap 지점에서 보이지 않았다(R2/P0-1(b)의 지적 — 정확하다).
- **PoP 의존이 사라진다.** `clientNonce`는 PoP 분기 밖에서 읽히므로 `requirePoP:false`에서도
  존재한다. 따라서 R1 §0.3 전제 2("rotation은 PoP를 요구한다")와 그에 딸린 rotate 거부 게이트는
  **철회한다.** R2/P0-1(a)가 지적한 "rotate 후 `requirePoP:false`로 config flip → 앵커 소멸"
  경로도 함께 소멸한다. R1의 오류 문구가 운영자에게 그 노브를 만지라고 가르치던 문제도 없어진다.
- **인증은 필요하지 않다.** relay가 `clientNonce`를 변조하면 agent가 변조값으로 봉인하고
  브라우저의 unwrap이 실패한다 — fail-closed이며, relay가 이미 갖고 있는 DoS 능력의 재현이다.
  브라우저에게 필요한 성질은 "내 값이 AAD에 있다"뿐이고, 그것은 자기 값으로 계산해 보면 안다.
- 그럼에도 **PoP 서명에 함께 결박할 것을 권고한다**(defense-in-depth, relay 유도 DoS 차단):
  `popSignedMessage(peerId, nonce)` → `popSignedMessage(peerId, nonce, clientNonce)`.
  현재 구현은 `webchannel-pop:${peerId}:${nonce}`이며 양쪽에 사본이 있다
  (`packages/client/src/pop-register.ts:60-62`, `packages/plugin/src/pop-challenge.ts:63-65`).
  **비용**: `popSignedMessage`는 client 공개 API다(`packages/client/src/index.ts:13`)
  → public API breaking. 어차피 lockstep 릴리스이므로 수용 가능하다고 판단하나, §10 #14로
  올려 확인받는다.

#### 6.3.3 인코딩

peerId는 subject token이라 `.`/`*`/`>`/공백/제어문자를 담을 수 없다 — **plugin 자신의 검증**이
보장한다: `packages/plugin/src/subject-token.ts:20`의
`SAFE_SUBJECT_TOKEN = /^[A-Za-z0-9_-]{1,128}$/`, 강제는
`packages/plugin/src/nats-register.ts:272-278`에서 subject 사용 **이전에** 이루어진다.

> SaaS 사본(`packages/saas/src/subject-token.ts`)이 아니라 plugin 사본을 근거로 삼는 것이
> 중요하다. 둘은 의도적으로 byte-identical이지만
> (`packages/plugin/src/subject-token.ts:15-16`) **서로 다른 신뢰 도메인**이다 — bootstrap JWT는
> 제3자 IdP가 발행할 수 있으므로 agent가 의존해도 되는 것은 agent 자신이 강제하는 검증뿐이다.

`clientNonce`는 base64url이므로 역시 구분자를 담지 않는다. **agent는 `clientNonce`도
base64url 형식과 길이를 검증한 뒤 사용한다** — 검증 실패는 `REGISTER_UNAUTHORIZED`.

```ts
// 고정 접두사 + 구분자 2필드.
// 예(<US>는 0x1F 한 바이트): "webchannel-wrap-v2<US>peer-abc<US><clientNonce>"
```

- 구분자는 **`0x1F`(UNIT SEPARATOR)**. 위 charset이 이를 배제하므로 인코딩은 단사다.
  `0x00`은 일부 도구/로그 파이프라인이 문자열 종료로 취급하므로 피한다. 구현은 `0x1F`라는
  **숫자 상수**로 쓴다. `:`나 `-`는 두 필드 모두에 나타날 수 있으므로 금지.
- 버전 접두사는 구 형식(`peerId` 평문 UTF-8)과 우연히 같아질 수 없게 한다.
- `JSON.stringify`를 쓰지 않는다. 필드가 둘뿐이고 엔진 간 이스케이프 동일성을 끌어들일 이유가 없다.
- `packages/client/src/e2e-crypto-browser.ts:112`에 **byte-identical 미러**를 만들고 `:107-109`의
  계약 문구를 갱신한다.
- **client는 subject-token 검증을 하지 않는다.** 브라우저가 안전한 이유는 검증이 아니라
  **불일치가 fail-closed이기 때문**이다. 따라서 **client 쪽에 정규화(trim/대소문자/NFC)를 절대
  추가하지 않는다.** 이 문장을 `e2e-crypto-browser.ts`의 `wrapAad` docstring에 넣는다.
- **wrap 계약 소비자 전수** (R3/P2-5) — 하나라도 빠지면 게이트가 늦게 깨진다:

| 위치 | 성격 | 조치 |
|---|---|---|
| `packages/plugin/src/late-join-decryptor.ts:240` | agent wrap의 AAD 구성 | `clientNonce` 전달 |
| `packages/plugin/src/late-join-decryptor.ts:303` | `unwrapConversationKey` 내부 AAD 구성 | 동일 |
| `packages/plugin/src/late-join-decryptor.ts:371` | `decryptBacklog`가 `unwrapConversationKey`를 호출 | opts 통과 경로 갱신 |
| `packages/plugin/src/nats-channel.ts:645-665` | `wrapConversationKeyForDevice` | 시그니처에 `clientNonce` 추가 |
| `packages/plugin/src/nats-account-runtime.ts:1270-1271` | 위 함수의 주입 지점 | 시그니처 동반 변경 |
| `packages/client/src/e2e-crypto-browser.ts:112` / `:181` | 브라우저 `wrapAad` 정의와 사용 | byte-identical 미러 |
| `packages/client/src/nats-client.ts:1758-1763` | 브라우저 unwrap 호출부 | `clientNonce` 전달 |
| **`e2e/local/enrolled-transport-roundtrip.ts:165-182`** | **ALL-REAL 하네스** — `registerWithPop` 후 `unwrapConversationKey`를 별도로 호출한다 | 목록에 없으면 e2e 게이트가 늦게 깨진다 |
| **`packages/client/src/nats-client-wrapped-key.test.ts:97-104`** | `wrapLikeAgent` 미러 fixture, "AAD = UTF-8(peerId)"를 **재구현**한다 | 새 AAD로 갱신 |
| **`packages/client/src/nats-client-wrapper.test.ts:1145-1152`** | 동일한 두 번째 미러 fixture | 동일 |

- **`clientNonce`의 optionality를 명시적으로 결정한다** (R3/P2-5). 현재 `peerId`는 optional이며
  `packages/plugin/src/late-join-decryptor.ts:240`과 `:303` 모두
  `opts.peerId !== undefined ? wrapAad(...) : undefined` 형태다 — 즉 **AAD 없는 경로가 존재한다.**
  `clientNonce`가 같은 패턴을 물려받으면 새 앵커가 조용히 사라질 수 있다.
  **결정: production wrap 경로에서 `clientNonce`는 필수다.** `wrapConversationKeyForDevice`는
  `clientNonce` 없이 호출될 수 없도록 타입으로 강제하고, 값이 없으면 wrap을 만들지 않고 throw한다.
  legacy ephemeral self-test 경로의 optional AAD는 그대로 두되, **production 경로가 그 분기에
  들어갈 수 없음**을 테스트로 고정한다.

#### 6.3.4 두 가지 구현 함정 (R3/P2-7)

1. **register reply에 `clientNonce`를 절대 echo하지 않는다.** `RegisterWithPopResult`는 오늘
   전적으로 `registerReply`에서 조립된다(`packages/client/src/pop-register.ts:330-342`). 디버깅
   편의로 agent가 `clientNonce`를 reply에 실어 주고 클라이언트가 **그것을** 읽어 AAD를 계산하면,
   앵커가 다시 **relay가 고르는 값**이 되어 이 라운드의 성과가 통째로 무효가 된다. 클라이언트는
   반드시 **자기가 생성해 보관한 값**을 쓴다. 이 금지를 코드 주석과 테스트로 고정한다.
2. **agent 측 `clientNonce` 검증의 위치 — `protocolVersion` 검사 *뒤*다** (R5/P2-1에서 정밀화).
   `packages/plugin/src/nats-register.ts:288-291`이 버전 검사를 인증된 tenant/subject 검사 뒤에
   두는 이유를 적고 있고("unauthenticated requests must not gain an account/version oracle"),
   그 검사 자체는 `:292-299`에서 426(`REGISTER_PROTOCOL_MISMATCH`)으로 응답하며 PoP 게이트는
   `:301-302`에서 시작한다. 즉 "인증 뒤, PoP 전"이라는 창은 **이미 버전 게이트가 차지하고 있다.**

   `clientNonce` 검증을 `:292` **앞에** 두면 구 v2 브라우저(당연히 `clientNonce`가 없다)가 426이
   아니라 **401**을 받는다. 그러면 클라이언트에서 `PopRejectedError` → cause `"auth-rejected"`가
   되고, §8.3 7단계 체크리스트가 그것을 재-로그인 플로우로 라우팅하므로 **새 credential로 다시
   시도해도 같은 401** — 무한 재-로그인 루프다. 이것은 §8.3 4단계가 "명확한 mismatch로 거부된다"고
   약속한 것의 정반대이며, 봉쇄와 무관한 일상 업그레이드에서 발생한다.

   **따라서 검증은 `:292-299`의 버전 게이트 뒤, `:301`의 PoP 게이트 앞에 둔다.**

#### 6.3.5 client 내부 배선 (R2/P1-3)

`clientNonce`는 브라우저가 만들지만 **생성 지점과 사용 지점이 두 모듈 떨어져 있다.**

- 생성·전송: `registerWithPop` 루프 내부(`packages/client/src/pop-register.ts:253-297`). 매 시도
  **새로** 생성한다(재시도는 새 라운드다).
- 사용: unwrap은 `packages/client/src/nats-client.ts:1758-1763`.
- 현재 `RegisterWithPopResult`(`packages/client/src/pop-register.ts:201-221`)는 nonce류를 전혀
  싣지 않는다. **`clientNonce`를 결과 타입에 추가해 호출자에게 전달한다.**
- **이것은 wire 변경이 아니라 client 내부 배선이다.** 요청 필드 추가(§6.3.2)만이 wire 변경이다.
- 반환된 `clientNonce`는 그 register 라운드에서 실제 전송한 값이어야 한다. 재시도가 있었다면
  **성공한 시도의 값**이다. 루프가 시도마다 값을 새로 만들므로 성공 분기에서 그 시도의 값을
  결과에 실으면 된다.

**이 재시도 의미론이 성립하는 이유를 명시한다** (R4에서 지적된 미명명 의존): agent가 register를
**매 호출마다 무조건 다시 wrap하기 때문**이다 — `packages/plugin/src/nats-register.ts:358-359`가
`registerPeer` 직후 `wrapConversationKeyForDevice`를 조건 없이 호출하고, `:167-168`의 docstring이
"Idempotent for `register` (re-wrap + re-snapshot on every call), so a client that retries after a
lost reply recovers cleanly"라고 계약으로 적고 있다. agent가 "이미 등록된 peer면 wrap을 건너뛴다"
식으로 최적화되면 재시도한 클라이언트는 **이전 시도의 nonce에 결박된 wrap**을 받아 자기 최신
`clientNonce`로 열지 못한다. **무조건 re-wrap은 `clientNonce` 설계의 전제이며, 구현 시 그
docstring에 이 의존을 추가해 장래의 최적화를 막는다.**

### 6.4 message envelope은 그대로 둔다 — epoch를 넣지 않는다 (R2/P1-2)

**R1의 `ENVELOPE_VERSION` 1→2 계획을 전면 철회한다.**

#### 6.4.1 왜 inert인가

`openEnvelope`(`packages/plugin/src/e2e-session.ts:64-74`)는 수신한 프레임 **자신의** routing에서
AAD를 만든다: `getEnvelopeRouting(envelope)`(`:69`) → `canonicalAad(routing)`(`:70`). 재생된
epoch-1 envelope은 epoch 1을 스스로 공급하므로 자기정합적이다. 그것을 거부하는 유일한 요인은
**수신자가 K_2를 들고 있다는 것**이다.

그리고 rotate는 매번 새로운 32바이트 난수 키를 만든다(§6.5). 따라서:

- (peerId, epoch)와 키는 1:1이다. 서로 다른 epoch가 같은 키를 가질 수 없고, 같은 epoch가 두 키를
  가지려면 generations 파일이 유실되어 번호가 재사용되어야 하는데, 그 경우에도 **키는 여전히
  새 난수**이므로 구 envelope은 복호되지 않는다.
- 즉 **세대 분리는 키 교체만으로 이미 완전하다.** AAD의 epoch가 추가로 막는 것이 없다.

이것은 R1의 P0-1과 같은 부류의 오류다 — **진정성 앵커를 신선도 앵커로 착각**한 것이며, 이번엔
envelope 경로에서 재현되었다. wrap 경로가 AAD를 필요로 하는 이유는 §6.3.1이 보인 대로 **거기서만
키가 세대를 넘어 안정적**이기 때문이다. 두 경로를 같은 논리로 다루면 안 된다.

#### 6.4.2 회수되는 범위

| R1이 계획했던 변경 | R2 결정 |
|---|---|
| `packages/plugin/src/e2e-envelope.ts:60` `ENVELOPE_VERSION` 1 → 2 | **1 유지** |
| `:79-92` `EnvelopeRouting`에 `epoch` 필수 필드 | 추가 안 함 |
| `:347-358` `canonicalAad`에 epoch | 추가 안 함 (고정 key order 논의 자체가 불필요) |
| `:281-323` `validateEnvelope` epoch 검증 | 불필요 |
| `:193-201` `getEnvelopeRouting` | 변경 없음 |
| `packages/plugin/src/e2e-session.ts` `SessionRouting`/`sealEnvelope`/`openEnvelope` | **변경 없음** |
| `packages/plugin/src/nats-channel.ts:512`, `:698`, `:875` 세 seam | **변경 없음** |
| `peerSessionKeys` 값 타입 승격 | 불필요 |
| 브라우저 envelope 미러 (`packages/client/src/e2e-crypto-browser.ts:189-205`) | **변경 없음** |
| `packages/plugin/src/crypto-nats-channel.ts:181`, `:215` | **변경 없음** |
| approval family 분기 (`packages/plugin/src/approval-e2e-crypto.ts:115-117`의 `toAad`) | **논점 소멸** — conversation envelope도 epoch를 안 넣으므로 approval만 안 넣는 비대칭이 없다 |

`packages/plugin/src/e2e-envelope.ts:287-291`의 `v !== ENVELOPE_VERSION` hard-reject는 그대로
유지된다 — 이번 릴리스에서 그 값이 바뀌지 않을 뿐이다.

**Track B는 이제 message wire를 전혀 건드리지 않는다.** 남은 wire 변경은 register **요청**의
`clientNonce` 필드 하나다(§6.3.2, §8.2).

#### 6.4.3 대신 잃는 것 — 정직하게 (R3/P2-6에서 표현 정정)

epoch가 어느 AAD에도 없으므로 세대가 어긋난 상대를 만나면 **오류가 불투명한 것이 아니라
아예 관측되지 않는다.** R2 초안이 "불투명한 오류", "복호 실패 보고"라고 쓴 것은 틀렸다 —
보고 자체가 없다.

- **클라이언트 쪽**: `openMessage(...)`가 `null`을 반환하면 `if (msg)` 가드에서 조용히 버려진다
  (`packages/client/src/nats-client.ts:1525-1526`, `:1846-1847`). 오류 리스너 호출 없음, 상태 변화
  없음, 사용자에게 보이는 신호 없음.
- **agent 쪽**: `console.warn` 한 줄뿐이다(`packages/plugin/src/nats-channel.ts:879-884`).
- **자가 치유되지 않는다**: 소켓이 건강한 한 브라우저는 재등록하지 않으므로
  (`packages/plugin/src/nats-channel.ts:296-298`) 그 세션은 **영구히 벙어리**다.

이것이 epoch를 모든 AAD에서 제거한 대가이며, **동시에 R3/P1-1(발급 창)이 심각한 이유**다 —
그 창으로 만들어진 잘못된 세션은 아무 신호도 내지 않는다. §4.2 §5-bis의 stop-first 순서가
그 창을 구조적으로 없애는 것이 이 위험에 대한 실제 대응이다.

감수하는 근거는 여전히 유효하다: 세대 어긋남은 **절차를 지키면 발생하지 않는다.** 진단 품질을
위해 breaking wire change를 지불하지 않으며, 필요해지면 **비-AAD 평문 진단 필드**로 나중에
additive하게 추가할 수 있다(§10 #5).

### 6.5 store rotation API — **offline 도구** (R3/P1-2)

`rotate`는 **gateway가 정지된 상태에서 실행되는 별도 CLI 도구**가 호출한다. 근거는 §10 #6.
요약: gateway-local 트리거는 **존재하지 않는 표면**이었고(플러그인 매니페스트는
`cliAddOptions`만 노출한다 — `packages/plugin/openclaw.plugin.json:329`; `doctor.ts`는 config/파일을
읽는 CLI-프로세스 모듈이지 gateway RPC가 아니고, `control-lane.ts`는 브라우저 `/stop` 레인이다),
살아 있는 gateway 옆에서 별도 프로세스가 store를 쓰는 것은 #55 §4 I0의 단일 writer 전제와 §9
비목표 5를 위반한다. 게다가 `ConversationKeyStore`는 인스턴스별 lazy-load 캐시이므로
(`packages/plugin/src/conversation-key-store.ts:117-118`, `:210-211`) 살아 있는 gateway는
`peerSessionKeys`에서 K_old를 계속 서빙한다.

**offline이 값을 치르는 대신 되돌려주는 것:**

- gateway가 멈춰 있으면 단일 writer가 성립한다. **다만 "자명하게"는 아니다** (R4/P1-B) — 그것은
  운영자가 ①을 지켰다는 *절차적* 전제이고, §4.2 §5-bis:528은 절차적 주의 대신 **구조적 차단**을
  명시적 기준으로 세웠다. 같은 문서가 자기 기준을 어길 수 없다.

  반례가 실재한다: `getOrCreate`는 캐시된 맵에서 기존 entry를 찾으면 **fresh read 없이 즉시
  반환한다**(`packages/plugin/src/conversation-key-store.ts:163-166`). 따라서 ①을 건너뛰고 도구를
  돌리면, 살아 있는 gateway는 외부 rotate 이후에도 **K_old를 계속 발급·서빙**하는데 도구는
  exit 0으로 끝난다 — 초록불 봉쇄 실패이며, 직전 라운드가 P1으로 평가한 바로 그 부류다.

  **따라서 도구는 살아 있는 gateway를 탐지해 fail-closed로 거부해야 한다 — 권고가 아니라
  요구사항이다** (R5/P1-2). 수단(lock 파일, pid 확인, register subject 프로브) 선택과 오탐/미탐
  의미론은 §10 #16.

  **사후 `generationOf` 검증은 이 자리의 대체재가 될 수 없다.** R4 판본은 탐지를 채택하지 않을
  경우의 fallback으로 그것을 제시했는데, 그 검사는 **①의 준수 여부를 원리적으로 관측하지
  못한다**: 재기동된 새 프로세스가 파일을 읽어 보고하므로, ①을 지켰든 어겼든 **동일하게 epoch N을
  반환한다.** 실제로 잡는 것은 잘못된 tuple 지정이나 무동작(no-op)이지 동시 writer가 아니다.
  더 나쁜 것은 그 사이의 실제 피해가 관측되지 않는다는 점이다 — rotate와 재기동 사이에
  재부트스트랩한 브라우저가 **아직 살아 있는 stale gateway에 등록해 K_old를 받아 간다.** R3/P1-1이
  없앤 발급 창이 그것을 없애려고 쓴 절차 안에서 되살아난다.

  따라서 선택지는 둘뿐이다: **(a) fail-closed 탐지를 필수로 구현한다**(채택), 또는 **(b) 단일
  writer가 전적으로 ①에 의존하며 사후 검증 수단이 없다고 문서에 명시한다.** 효과 없는 검사를
  fallback으로 제시하는 세 번째 선택지는 없다. `generationOf`는 tuple 오지정·무동작 확인용
  보조 점검으로만 남긴다.
- 재기동이 `peerSessionKeys`와 in-process `HistoryStore`를 비운다. 따라서 **R2 §6.6.5의 원자적
  세션 교체 계약과 §6.7의 온라인 drop 기계가 통째로 불필요해진다** — 재기동의 부수효과다.
  이 문서에서 그 기계를 **삭제했다**(남겨 두면 4세대째 stale text가 된다).
- §5-bis의 stop-first 순서(R3/P1-1)와 자연히 한 몸이다. 두 지시가 같은 ① 단계를 공유한다.

비용은 드문 조작 중의 다운타임이다(§6.6.3 비용 4).


```ts
class ConversationKeyStore {
  getOrCreate(peerId: string): Uint8Array;   // 시그니처 변경 없음
  get(peerId: string): Uint8Array | null;    // 시그니처 변경 없음
  rotate(peerId: string): Uint8Array;        // 신규
  generationOf(peerId: string): number | null;  // 신규, 진단 전용
}
```

#### 6.5.1 `rotate(peerId)` 계약

1. peerId가 store에 없으면 **거부한다.** rotate는 생성이 아니다. 조용히 생성하면 blast radius
   표시가 거짓이 된다. typed error를 던진다.
2. **refresh-before-commit** (R2/P2-6): commit 후보를 만들기 전에 키 파일을 fresh-read한다.
   `getOrCreate`의 `readFresh()`(`packages/plugin/src/conversation-key-store.ts:178`, 구현
   `:249-256`)와 같은 non-quarantining 읽기를 재사용해, 순차적으로 겹친 다른 store 인스턴스가
   commit한 membership을 stale snapshot이 덮어쓰지 않게 한다. generations 파일도 같은 규율로
   읽는다.
3. 새 32바이트 난수 키 생성. `newEpoch = (generations[peerId]?.epoch ?? 0) + 1`.
4. **커밋 순서** — generations 먼저, 키 나중(§6.5.3).
5. **fail-closed.** 키 커밋이 실패하면 도구가 오류로 종료하고 키를 교체하지 않는다. 디스크
   상태는 호출 전과 동일하다. *(R2는 여기에 "in-memory 세션도 교체하지 않는다"를 적었으나,
   offline 도구에는 in-memory 세션이 존재하지 않는다 — §6.6.5. R4/P1-C에서 정정.)*
6. epoch overflow: `Number.isSafeInteger` 상한 근처에서 거부한다. 감사 카운터일 뿐이지만 단조성이
   무너지는 경로를 코드에 남기지 않는다.

#### 6.5.2 capacity ceiling과의 상호작용

rotate는 **기존 entry의 교체**이므로 `keys.size`를 늘리지 않는다.

- rotate는 `maxKeys` 검사를 **하지 않는다.** full store
  (`packages/plugin/src/conversation-key-store.ts:171-173`)에서도 성공해야 한다. #55의 I2
  "existing-first" 정신과 일치한다.
- `ConversationKeyCapacityError`(`:85-100`)는 rotate 경로에서 **절대 발생하지 않는다.** 테스트로
  고정한다.
- rotate를 "delete 후 getOrCreate"로 구현하면 full store에서 그 오류가 터진다. **그렇게 구현하지
  않는다.** 단일 원자 연산이며 중간에 entry가 사라진 상태가 관측되어서는 안 된다.
- `maybeWarnCapacity`(`:303-324`)는 rotate 경로에서 호출하지 않는다. 크기가 변하지 않는다.

#### 6.5.3 두 파일 커밋 순서

```text
1. generations[peerId] = {epoch: newEpoch, rotatedAtSec}   ← 먼저 (tmp write + atomic rename)
2. keys[peerId] = newKey                                    ← 그 다음
3. this.keys = candidate                                    ← durable 성공 후에만 공개
```

- **1과 2 사이 crash**: 카운터는 올라갔고 키는 구 키다. 재시도가 더 높은 번호로 성공한다. 번호에
  빈 칸이 생기지만 계약은 단조성이지 연속성이 아니다. 반대 순서였다면 crash 후 카운터가 낮아
  번호가 재사용된다 — R2 설계에서는 감사 오염에 그치지만, 순서를 바로 하는 비용이 0이므로 이
  순서로 고정한다.
- **1 실패**: 아무것도 바뀌지 않는다. rotate가 throw한다.
- **2 실패**: 카운터만 올라간 상태. 키·세션 그대로. rotate가 throw하고 재시도가 더 높은 번호로
  성공한다.
- 키 파일 커밋은 #55가 확립한 `persist(candidate)` 패턴(`packages/plugin/src/conversation-key-store.ts:272-287`)을
  그대로 쓴다 — authoritative Map은 rename 성공 뒤에만 교체된다(I4 durable-before-visible).

#### 6.5.4 account-wide rotation의 두 파일 순서 (R2/P2-6, §10 #7)

account-wide를 단일 원자 커밋으로 구현할 경우에도 같은 순서다: **모든 peer의 generations를 한
번의 rename으로 커밋한 뒤, 모든 키를 한 번의 rename으로 커밋한다.** 두 파일 사이에는 원자성이
없으므로, 중간 crash는 "카운터만 전진"이라는 안전한 방향으로만 어긋난다.

#### 6.5.5 quarantine은 이제 특별 취급이 필요 없다

R1은 키 파일 quarantine(`packages/plugin/src/conversation-key-store.ts:220-244`)을 "epoch
이벤트"로 재분류하려 했다. generations가 별도 파일이므로 quarantine은 그것을 건드리지 않고,
재생성되는 키의 번호는 사이드카에서 이어진다. **기존 quarantine 동작을 변경하지 않는다.**

로그 문구만 보강한다: 현재 `console.error("[conversation-key-store] code=invalid-document
action=quarantine")` 한 줄(`:231-233`)에 "이 account의 모든 peer가 재등록과 새 K를 요구받는다"는
운영 의미를 덧붙인다. peerId나 key material은 넣지 않는다(#55 I7).

### 6.6 재등록 강제 — 실제 메커니즘은 앱 레벨 재부트스트랩이다

#### 6.6.1 R1의 서술은 틀렸다: revocation은 재연결이 아니라 terminal을 만든다

R1은 "Track A의 relay 측 연결 종료 → `onclose` → 재연결 → `onConnected` → 재등록"이라는 사슬을
보증으로 제시했다. **그 사슬은 첫 고리 다음에서 끊어진다.**

- revoked credential로 연결하면 relay가 `authorization violation`을 보내고, client는
  `packages/client/src/nats-client.ts:818-824`에서 `failTerminally(…, "auth-rejected")`로 간다.
  오류 문구 자체가 *"credentials invalid/expired — reconnecting cannot help"* 다.
- 재연결이 무의미한 이유는 구조적이다: `natsCredentials`는 생성 시점 옵션이고
  (`:142`, 소비는 `:660`, `:705`) **갱신 훅이 없다.** 재다이얼은 같은 revoked JWT를 다시 제시한다.
- 복구 모델이 코드에 명시되어 있다: `:1813-1814` — *"no replacement dial is ever created —
  recovery is a fresh instance"*.

따라서 R1 §6.6.3의 "재등록은 0의 부작용으로 이미 일어났거나 브라우저가 재연결할 때 자연히
일어난다"는 **거짓**이다. 브라우저는 재연결하지 않는다. 죽는다.

#### 6.6.2 실제 메커니즘

```text
revoke → relay가 연결 거부 → client terminal("auth-rejected")
       → 임베딩 애플리케이션이 오류를 표면화
       → 사용자가 재-로그인/재-부트스트랩
       → 앱이 /nats-user를 다시 호출해 **새 userPubkey**로 credential 발급
       → 앱이 **새 client 인스턴스**를 만든다 (새 device X25519 키 포함)
       → 새 인스턴스가 register → 새 K 수령
```

핵심은 **새 `userPubkey`** 다. `addRevocation`의 `at`은 "이 시각 이전 발급분 거부"이므로
(`packages/saas/src/account-revocation.ts:45-47`), revoke **이후에** 민팅된 credential은 같은
peer의 것이라도 차단되지 않는다. 즉 재-부트스트랩이 정상 복구 경로다.

부수적으로 device X25519 키도 새로 생성되므로
(`packages/client/src/browser-jwt-entry.ts:104`, `:257`) §6.3.1의 wrap 재생 창까지 닫힌다.

#### 6.6.3 운영자가 지불하는 비용 — 명시한다

이것이 봉쇄의 실제 가격이며 R1 문서 어디에도 없었다.

1. **모든 영향 peer가 terminal이 되고 사람 손이 필요하다.** 자동 복구가 아니다. 임베딩
   애플리케이션이 `auth-rejected`를 명확한 재-로그인 유도로 표면화하지 못하면 사용자는 깨진
   화면만 본다. **Track C 런북은 이 UX 전제를 사전 점검 항목으로 넣어야 한다.**
2. **per-peer 일괄 revoke(§5.4.2)는 그 사용자의 모든 탭·모든 기기를 동시에 끊는다.** 한 peer의
   credential 집합 전체가 대상이기 때문이다. "한 세션만 끊기"는 지원되지 않는다.
3. **§5.6 옵션 2 이전에는 revocation 적용이 relay 전체 재기동을 요구한다.** 현재 topology는
   `resolver: MEMORY`이므로(§2.8) nats.conf 재작성 + **재기동**이 필요하고, 그것은 **대상뿐 아니라
   그 relay의 모든 연결**을 끊는다(`--signal reload`는 연결을 끊지 않으므로 대안이 되지 못한다 —
   R5/P2-5). 즉 옵션 2 착륙 전의 봉쇄는 전면 장애를 동반한다.
   **역설적 부수효과**: 그 전면 절단이 브라우저 소켓을 닫아 `onConnected`를 다시 띄우므로,
   옵션 2 **이전**에는 §5-bis ⑥이 부분적으로 자동 달성된다. 옵션 2를 채택하면
   `$SYS.REQ.CLAIMS.UPDATE`가 **revoke된 연결만** 끊으므로 그 부수효과가 사라지고 **⑥이 무조건
   필요**해진다(§5.6, R5/P2-5).
4. **gateway 재기동은 살아 있는 모든 브라우저를 영구히 고립시킨다 — 유계 다운타임이 아니다**
   (R4/P1-A). R3은 이것을 "그 창 동안"의 일시적 중단으로 적었다. **틀렸다.**

   생존 경로를 끝까지 따라가면:
   - `registerWithPop`의 production 호출 지점은 **하나뿐**이고(`packages/client/src/nats-client.ts:1632`)
     그것은 `onConnected`에서만 도달한다(`:1250-1251`의 `onState(connected)` 분기).
   - heartbeat는 **relay를 향한** raw `ws.send("PING\r\n")`이다
     (`packages/client/src/nats-client.ts:952-970`, 전송은 `:968`). agent를 향하지 않는다.
   - 따라서 **gateway를 세웠다 올려도 브라우저 소켓은 닫히지 않고 `onConnected`도 다시 뜨지
     않는다.** 재등록이 영영 일어나지 않는다.
   - 재기동한 agent는 빈 `peerSubscriptions`/`peerSessionKeys`로 시작하고 그것들은 register에서만
     채워지므로(`packages/plugin/src/nats-channel.ts:271-315`), 그 브라우저의 `.in` 프레임은
     **구독자가 없어** 조용히 사라지고 outbound는 `sendToPeer`가 거부한다(`:688-697`).
   - 브라우저 쪽에 **자동** 탐지가 없다. 정확히 말하면: 전송 tracker는 publish 시점에 `"sent"`로
     전진하고(`packages/client/src/nats-client.ts:1992`) **누락된 ack를 실패로 바꾸는 타임아웃이
     없다.** 그러나 **관측 표면 자체는 존재한다** (R5/P1-1의 정정 — 이전 판본은 "탐지 수단이
     없다"고 잘못 적었다):
     - `"accepted"`는 **agent가 보낸 `ack` 프레임으로만** 도달한다
       (`:1535-1536` → `drainAcked` → `:1558`).
     - 그 전이는 `onSendState`(`:1444`)와 `getSendStateSnapshot`(`:1456`)로 공개되어 있고
       `SendState`/`SendFailure`/`SendReceipt`는 public export다(`packages/client/src/index.ts:36-39`).
     - 따라서 **모든 send가 `sent`에 머물고 `accepted`에 도달하지 않는 것**이 고립의 서명이며,
       임베더는 **wire 변경 없이** 이를 감시해 수 초 내에 재부트스트랩을 띄울 수 있다.

     이것이 §5-bis ⑥을 실행 가능하게 만드는 **유일한 in-band 수단**이다(§8.3 7단계 체크리스트).

   즉 §6.4.3이 지목한 **무음 실패 부류**가 그대로 발생하며, 회복은 ⑤(재기동)가 아니라
   **임베딩 앱의 재부트스트랩 또는 사용자의 페이지 새로고침**에서만 일어난다.

   **부수 피해가 계정 경계를 넘는다.** gateway 하나가 account A와 B를 서빙하고 A의 peer P만
   침해되었다면, revoke 대상이 아니었고 terminal이 되지도 않은 **A의 다른 peer와 B의 모든
   peer**까지 재기동 후 양방향 무음이 된다. **한 account의 봉쇄가 같은 프로세스를 공유하는 무관한
   account들의 부수 피해를 만든다.**

   > **이것은 이 계획이 만든 결함이 아니라 pre-existing 아키텍처 성질이다.** 생존 판정 경로가
   > agent가 아니라 relay를 향하므로 **어떤 이유의 gateway 재기동이든** 살아 있는 브라우저를
   > 고립시킨다. stop-first가 그것을 만든 것이 아니라, 봉쇄 런북이 그것과 충돌할 뿐이다.
   > 별도 이슈로 제기할 것을 §9에 기록한다.

   대응은 §4.2 §5-bis의 ⑥단계(전체 강제 새로고침)이며, 그것은 **revoke 대상 peer만이 아니라 그
   gateway의 모든 peer**를 대상으로 한다.
5. **`*` 광역 revoke는 agent를 함께 죽이며 재-enrol이 필요하다 — 비용 1~5 중 가장 크다**
   (R5/P1-3). agent credential이 브라우저와 같은 `accountSeed`에서 나오고
   (`packages/saas/src/device-flow-enrollment.ts:690-695`) plugin은 재발급 능력이 없으므로
   (`packages/plugin/src/nats-credential-source.ts:21-26`), `*` 경로에서는 **gateway를 다시 켜기
   전에 재-enrol을 완료해야 한다**(§4.2 §5-bis ④-bis). 정확한 `userPubkey`를 특정할 수 있는
   배포 — 즉 Track A 이후 — 에서는 이 비용이 사라진다. **이것이 Track A의 원장을 정당화하는 가장
   구체적인 운영 근거다.**
6. **agent 측 history 손실** (R3). 재기동이 in-process `HistoryStore`를 비우므로
   (`packages/plugin/src/history-store.ts:110`, `:50`) 해당 account의 **모든 대화**에 대해 late-join
   백로그가 사라진다. 보안 관점에서는 이득이지만(§6.7) 사용자 관점에서는 재접속 시 이전 메시지가
   재생되지 않는 것으로 보인다.

**임베딩 애플리케이션이 구현해야 하는 관측 표면** — §8.3 7단계의 산문 게이트를 체크리스트로
바꾸는 지점이다. 클라이언트는 `failTerminally(…, "auth-rejected")`
(`packages/client/src/nats-client.ts:818-824`) 경로에서 `notifyErrorListeners(err, cause)`
(`:1818`)를 통해 `WebChannelErrorCause`가 `"auth-rejected"`인 오류를 내보낸다. 앱은 **그 cause를
구독해 재-로그인/재-부트스트랩 UI로 연결해야 한다.** 이것이 없으면 봉쇄 후 사용자는 원인 없는
정지 화면만 본다.

#### 6.6.4 in-band invalidation 프레임은 여전히 불채택 — 다만 이유가 바뀐다

R1-addendum의 **결론은 유지**하되 근거를 정정한다.

- R1-addendum의 근거였던 "강제 순서상 세션이 이미 끊겨 있다"는 여전히 맞다. 다만 그 이유가
  "relay가 끊고 브라우저가 재연결한다"가 아니라 **"브라우저가 terminal로 죽는다"** 이다(§6.6.1).
  어느 쪽이든 rotate 시점에 통지할 라이브 세션은 없다.
- 물리적 불가 근거도 유지된다: rotation 커밋 후 agent는 K_new로만 봉인할 수 있고 평문 fallback이
  금지되어 있으므로(`packages/plugin/src/nats-channel.ts:688-697`, `sendToPeer`는 `:679`,
  봉인은 `:698-704`) K_old를 든 브라우저는 그 프레임을 열 수 없다.
- 따라서 새 프레임 타입·inbound 핸들러·재연결 가능 teardown 진입점을 만들지 않는다.

#### 6.6.5 세션·history 정리는 재기동의 부수효과다 (R3/P1-2)

R2는 `rotate` → `peerSessionKeys.set` → `historyStore.drop`이라는 **온라인 원자 순서**를 계약으로
두었다. offline 트리거를 채택하면서 **그 계약을 삭제한다.** 실행 순서는 §4.2 §5-bis의 ①~⑥이며,
in-process 상태는 다음과 같이 자동 정리된다.

| R2의 온라인 단계 | offline에서 |
|---|---|
| `peerSessionKeys.set(peerId, newKey)` | 재기동이 맵을 비운다(`packages/plugin/src/nats-channel.ts:400`은 dispose 경로이고, 새 프로세스는 애초에 빈 맵으로 시작한다). 첫 register가 새 K를 싣는다. |
| `historyStore.drop(conversation)` | 재기동이 in-process `HistoryStore`를 통째로 비운다(`packages/plugin/src/history-store.ts:110`의 `#store`는 인스턴스 필드다). |
| "1이 throw하면 2·3을 수행하지 않는다" fail-closed | `rotate` 도구가 실패하면 키를 교체하지 않고 종료한다. 재기동해도 구 K가 그대로이므로 상태가 갈리지 않는다(§6.5.1). |

따라서 **`HistoryStore`에 `drop()` API를 추가할 필요도 없다.** R2 §6.7이 요구했던 한 줄짜리 추가는
철회한다 — 재기동이 이미 그 일을 한다.

남는 계약은 §6.5의 두 파일 커밋 순서뿐이며, 그것은 도구 내부의 문제다.
### 6.7 history 처리 — 재기동이 곧 purge다

- 디스크에 재암호화할 것이 없다(§0.2 (a), §2.7): `packages/plugin/src/history-store.ts:110`의
  `#store`는 인스턴스 Map이고 `:50`이 "Deferred: persistence (this implementation is in-process
  only)"를 명시한다.
- offline 트리거에서는 **rotate 절차가 반드시 gateway 재기동을 포함하므로 history purge가
  자동이다.** 별도 API도, 별도 단계도 없다(§6.6.5).
- 정책은 **purge**로 고정된다 — 선택의 여지가 없다는 뜻이기도 하다. retain은 신 K 클라이언트가
  열 수 없는 잔해를 남기고, re-encrypt는 구 K 소지자가 이미 캡처한 것을 되돌리지 못한다.
- **retroactive secrecy를 주장하지 않는다.** purge는 agent 보관 사본만 없앤다.
- 운영자에게 이것이 **비용**이라는 점을 명시한다(§6.6.3 비용 5): rotate하지 않는 평범한 재기동도
  history를 지우므로, 이 절차가 특별히 파괴적인 것은 아니지만 **해당 대화의 agent 측 백로그는
  사라진다.** late-join 재생이 그만큼 짧아진다.

### 6.8 rotation 후 구 K와 구 wrap이 할 수 있는 것 / 없는 것

**할 수 없는 것:**

- 신 세대 conversation envelope 복호 — 키가 다르다. (AAD가 아니라 **키**가 막는다, §6.4.1.)
- 신 세대 envelope 위조 — 동일 이유.
- **구 register reply를 재생해 브라우저를 rollback** — 재생된 wrap은 구 `clientNonce`에 결박되어
  있고 브라우저는 자기가 방금 만든 `clientNonce`로 AAD를 계산한다(§6.3.2). relay가 challenge까지
  재생해도 이 값은 브라우저가 로컬 생성하므로 강요할 수 없다.
- **재생 창을 닫는 것은 `clientNonce`이지 device 키가 아니다** (R3). 재-부트스트랩이 새 X25519
  키를 만드는 것은 사실이고(`packages/client/src/browser-jwt-entry.ts:104`, `:257`) 부수적으로
  wrap 키까지 바꾸지만, **그것에 보안 주장을 걸지 않는다** — 임베더가 `CryptoKey`를 캐시해
  재사용하면 그 이점은 사라진다. `clientNonce`는 임베더가 무엇을 캐시하든 매 register 시도마다
  새로 생성되므로 유일한 신뢰 가능 앵커다.

**여전히 할 수 있는 것 (정직하게):**

- **rotation 이전에 캡처한 ciphertext를 영구히 복호한다.** 구 K는 계속 유효한 복호 키다.
- rotation 이전에 late-join으로 당겨간 history 평문을 계속 보유한다.
- (Track A가 없다면) 유출된 credential로 relay에 접속해 신 세대 ciphertext를 **관측**한다 —
  복호는 못 하지만 메타데이터(subject, ts, envelopeType, 트래픽 패턴)는 본다. **Track A와 B가
  서로를 대체할 수 없는 이유다.**
- 그 credential로 해당 peerId subtree에 **publish**할 수 있다
  (`packages/saas/src/nats-user-creds.ts:171`). 신 K 없이 내용 위조는 불가하나 DoS/노이즈는 가능하다.
- **revoke 없이 rotate한 경우**, 피해자 브라우저는 살아남아 구 K로 계속 봉인해 보내고 공격자는
  그것을 복호한다. 게다가 같은 인스턴스가 재등록하면 §6.3.1의 wrap 재생 창도 열려 있다.
  이것이 revoke-before-rotate가 선택이 아니라 요구인 이유다.

이 목록은 런북(Track C)과 릴리스노트에 그대로 싣는다. 축약하지 않는다.

---

## 7. 테스트 전략

이슈 #72의 "Tests" 8개 항목을 트랙과 구체 파일에 매핑한다.

| # | 이슈의 테스트 서술 | Track | 착지 파일 | 비고 |
|---|---|---|---|---|
| T1 | pre-#54 A-token-on-B key acquisition 재현 후 containment 실행 | A+B | `e2e/local/run-two-account-isolation.sh` 확장 | 이 하네스가 이미 "A 토큰을 B의 register에 제출" 시나리오를 실 스택으로 구동한다(`e2e/local/run-two-account-isolation.sh:15-21`). **다만 #54가 이미 그 경로를 막았으므로 "취득"을 재현할 수 없다.** 취득 재현은 verifier를 의도적으로 무력화해야 하는데, 그것은 프로덕션 코드에 우회로를 남기는 것과 같다. **대체안**: 취득된 상태를 *가정*하고(원장에 레코드 주입 + store에 알려진 K 배치) containment만 검증한다. 이 이탈을 테스트 주석에 명시한다. |
| T2 | 실 NATS resolver에 userPubkey revocation 반영, live disconnect + 재연결 실패 실증 | A | 신규 `packages/saas/src/account-revocation-realserver.test.ts` | `packages/saas/src/nats-permissions-realserver.test.ts:1-25`의 하네스를 복제한다(바이너리 부재 시 skip: `:23-24`). **§5.6 옵션 2 채택이 전제다.** MEMORY resolver로는 작성 불가 — 이 의존을 테스트 파일 상단에 명시. |
| T3 | 비만료 credential, peer당 복수 credential, 정밀 revoke, wildcard fallback, managed-provider 실패 커버 | A | 신규 `packages/saas/src/browser-credential-ledger.test.ts` + conformance suite `browser-credential-ledger-conformance.ts` + `…-conformance.selftest.test.ts` | `enrollment-repository-conformance.ts`/`.selftest.test.ts` 3종 패턴 그대로. managed-provider 실패는 "operator seed 부재 → 실행 가능한 오류"로 검증(§5.7). |
| T4 | K rotation 후 구 K/구 wrap 실패, 신규 인가 장치는 새 K 수령 | B | `packages/plugin/src/conversation-key-store.test.ts`, `packages/plugin/src/late-join-decryptor.test.ts`, **신규** `packages/client/src/e2e-crypto-browser.test.ts` | 세 번째 파일은 **아직 존재하지 않는다**(R5/P2-6). 그리고 agent↔browser `wrapAad` byte-identity는 **오늘 어디에서도 단언되지 않는다** — `git grep wrapAad`가 테스트에서 잡는 것은 `packages/client/src/nats-client-wrapped-key.test.ts` 하나뿐이고 그것은 계약을 단언하는 대신 `wrapLikeAgent`로 **재구현**한다. 즉 두 구현을 붙들고 있는 것은 현재 R-o뿐이며, 이 파일이 그 계약의 첫 직접 단언이 된다. "신 epoch 수령"이 아니라 "새 K 수령"이다 — 브라우저는 epoch를 받지 않는다(§0.2 (d)). |
| T5 | 구 register reply/envelope 재생 → rollback 거부 | B | §7.2 (별도 확장) | 초안은 "구 epoch wrap 수신 시 client terminal"이라는 게이트를 전제했으나 **그런 게이트는 설계에 존재하지 않는다**(R1/P2-7). 정정된 방어는 nonce 결박이므로 테스트도 그것을 겨냥해야 한다. §7.2에서 다시 유도한다. |
| T6 | revocation 발행 / gateway drain / K persistence / history 전이 / client 재등록 사이 fault injection | A+B | A: ledger conformance의 fault suite(`enrollment-repository-conformance.ts:19-40`의 `interpose`/`throwAfterCommit` 패턴 재사용). B: `conversation-key-store.test.ts`가 이미 쓰는 `_beforePersist` 실패 seam(`packages/plugin/src/conversation-key-store.ts:81-82`, `:273`) | rotate 경로에도 같은 seam이 걸리므로 **"persist throw → 디스크 불변 → 캐시 Map 불변"** 을 결정적으로 검증할 수 있다. *(R2 초안의 "세션 미교체"는 삭제했다 — offline 도구에는 세션이 없어 `conversation-key-store.test.ts`에서 단언할 수 없는 항목이었다. R4/P1-C.)* "gateway drain"과 "client 재등록" 항목은 코드가 아니라 런북(§4.2 §5-bis ①·⑥)이 담당하므로 여기서 자동화하지 않는다. |
| T7 | 복수 gateway 프로세스를 구동해 취약/구 epoch replica가 남지 않음을 증명 | — | **작성 불가** | `docs/ISSUE_55_CONVERSATION_KEY_CAPACITY_PLAN.md` §4 I0이 확립한 배포 전제가 **account당 단일 writer**다. 복수 gateway가 같은 store를 쓰는 것은 지원되지 않는 구성이며, 그 상태에서의 보장을 테스트로 주장하면 존재하지 않는 계약을 만든다. **대체안**(R5/P2-4에서 epoch 표현 정정 — 클라이언트는 epoch를 받지 않는다, §0.2 (d)): (a) 단일 writer 전제 하에서 rotate 후 **새 프로세스가 store를 다시 읽으면 새 K를 얻는다**는 재기동 테스트, (b) **구 K를 캐시한 stale 프로세스**가 새 K를 든 클라이언트를 서비스하려 하면 AEAD 실패로 fail-closed된다는 테스트. 운영 측면의 "모든 replica 정지"는 코드가 아니라 런북(Track C)이 담당한다. |
| T8 | 사고 경고와 dry-run 출력에 비밀 없음 | A | `packages/saas/src/browser-credential-ledger.test.ts`, `packages/saas/src/enrollment-http-handler.test.ts` | §5.1 금지 필드 목록을 fixture로 고정하고, 출력 전체를 문자열 검색해 어떤 금지 필드 값도 나타나지 않음을 확인한다. |

### 7.1 R1/R2가 추가로 요구하는 테스트

이슈 본문의 8개 항목에 없지만 리뷰에서 드러난 결손을 고정하기 위해 필수인 것들.
**R2에서 R-a/R-b/R-j는 삭제되었다** — conversation-key 문서가 v2로 유지되어 마이그레이션 자체가
사라졌기 때문이다(§6.2).

| # | 대상 | Track | 파일 |
|---|---|---|---|
| R-c | **generations 사이드카가 키 파일 조작을 견딘다.** (i) 키 파일 quarantine 후 재생성, (ii) 키 파일 수동 이동 후 재기동, (iii) legacy ambiguous quarantine(`packages/plugin/src/legacy-storage-migration.ts:329-344`). 셋 모두 재-rotation이 **이전 최대치보다 큰** 번호를 낸다(§6.1.2). | B | `packages/plugin/src/conversation-key-store.test.ts` |
| R-d | **사이드카 읽기 실패는 fail-OPEN이다** (R2/P2-3). 손상·identity-mismatch·I/O 오류에서 `getOrCreate`/`rotate`가 정상 동작하고 register가 실패하지 **않는다.** 키 파일의 fail-closed(`packages/plugin/src/conversation-key-store.ts:216-219` 이후 경로)와 다르다는 점을 대조 테스트로 고정한다. | B | `packages/plugin/src/conversation-key-store.test.ts` |
| R-e | **generations→keys 커밋 순서.** 사이드카 커밋 성공 후 키 커밋만 실패시키고, 재시도가 **더 큰** 번호로 성공하는지 검증. 순서를 뒤집으면 실패해야 한다(§6.5.3). **작성 가능 조건**: `_beforePersist`는 `:273`에서 **모든** atomic write 앞에 발화하므로, 사이드카 쓰기가 `persist()`를 거치면 두 쓰기를 구분할 수 없다 — §6.1.2가 요구한 대로 사이드카가 **별도 쓰기 경로**를 쓸 때만 이 테스트가 성립한다(R3/P2-3). | B | `packages/plugin/src/conversation-key-store.test.ts` |
| R-f | **`getOrCreate`가 기존 entry의 epoch를 바꾸지 않는다** (R2/P2-6). 기존 peer를 반복 조회해도 사이드카가 변하지 않고 반환 키가 byte-identical하다. 조회 경로에 `max(...)+1`을 넣는 mutation이 이 테스트를 깨야 한다. *(R1의 R-f — `requirePoP:false` rotate 거부 — 는 §6.3.2에서 게이트 자체가 철회되어 삭제되었다. 애초에 `ConversationKeyStoreOptions`(`packages/plugin/src/conversation-key-store.ts:63-84`)에 auth 입력이 없어 작성 불가능한 테스트였다 — R2/P2-5.)* | B | `packages/plugin/src/conversation-key-store.test.ts` |
| R-g | **`GET /admin/credentials` 무인증 401** (+ POST 3종 동일), 그리고 **`ADMIN_ROUTES` 문자열이 실제 요청과 매칭되는지**(404가 아님을 확인). §5.4.1의 케이스 전부. | A | `packages/saas/src/enrollment-http-handler.test.ts` |
| R-h | **시간 단위 회귀.** ms 값을 `at`으로 넘기면 라우트가 거부한다. 서버 유도 경로에서 `at`이 `nowSec()`와 일치한다(§5.1.1). | A | `packages/saas/src/browser-credential-ledger.test.ts`, handler 테스트 |
| R-i | **per-peer 일괄 revoke의 dry-run/confirm과 부분 실패 보고**(§5.4.2). | A | `packages/saas/src/enrollment-http-handler.test.ts` |
| R-k | **`clientNonce` 배선 왕복** (R2/P1-3). `registerWithPop`가 매 시도 새 값을 만들고, 성공한 시도의 값이 `RegisterWithPopResult`에 실려 unwrap 호출부(`packages/client/src/nats-client.ts:1758-1763`)까지 도달한다. 재시도가 있었던 경우 **성공한 시도의 값**인지 확인. | B | `packages/client/src/pop-register.test.ts`, client register 하네스 |
| R-l | **agent가 `clientNonce`를 검증한다.** 누락·비-base64url·길이 이상은 `REGISTER_UNAUTHORIZED`이며 wrap/history/approval을 하나도 내보내지 않는다(§6.3.3). **위치를 고정한다**(§6.3.4 함정 2): `protocolVersion` 게이트 **뒤**여야 한다 — `protocolVersion: 2`이고 `clientNonce`가 없는 구 클라이언트 요청이 **401이 아니라 426**을 받는지 단언한다(R5/P2-1). 401이면 무한 재-로그인 루프가 된다. | B | `packages/plugin/src/nats-register.test.ts` |
| R-m | **register reply가 `clientNonce`를 echo하지 않는다** (R3/P2-7 함정 1). reply payload 전체를 문자열 검색해 클라이언트가 보낸 `clientNonce` 값이 나타나지 않음을 확인하고, 클라이언트가 AAD에 쓰는 값이 **자기 생성분**임을 고정한다. reply를 읽어 쓰는 mutation이 이 테스트를 깨야 한다. | B | `packages/plugin/src/nats-register.test.ts`, `packages/client/src/pop-register.test.ts` |
| R-n | **production wrap 경로는 AAD 없는 분기에 들어갈 수 없다** (R3/P2-5). `clientNonce` 없이 `wrapConversationKeyForDevice`를 호출하면 wrap을 만들지 않고 throw한다. legacy optional-AAD 분기(`packages/plugin/src/late-join-decryptor.ts:240`, `:303`)가 production에서 도달 불가함을 고정한다. | B | `packages/plugin/src/nats-channel-keystore.test.ts` 또는 wrap 경로 테스트 |
| R-p | **사이드카 쓰기 정책의 비대칭** (R4/P2-E). 사이드카 경로를 쓰기 불가로 만든 뒤: `getOrCreate`의 신규 생성은 **성공**하고(swallow+log) 키가 정상 커밋되며, 같은 조건에서 `rotate`는 **throw**하고 키를 교체하지 않는다(§6.1.2 표). 한쪽 정책을 다른 쪽에 복사하는 mutation이 이 테스트를 깨야 한다 — 그 복사가 R2/P2-3(읽기)과 R3/P2-3(쓰기) 두 라운드의 실패 모드였다. | B | `packages/plugin/src/conversation-key-store.test.ts` |
| R-o | **미러 fixture 동기화** (R3/P2-5). `packages/client/src/nats-client-wrapped-key.test.ts:97-104`와 `nats-client-wrapper.test.ts:1145-1152`의 `wrapLikeAgent`가 새 AAD 형식을 재구현하며, agent 구현과 byte-identical한지 교차 검증한다. | B | 위 두 파일 |

### 7.2 T5 재유도 — 무엇이 rollback을 막는가 (R1/P2-7, R2에서 재정정)

R1은 T5를 "구 epoch wrap → client terminal" 게이트로 상정했고(그런 게이트는 없다), R1-정정은
서버 nonce 결박으로 옮겼다(불충분하다, §6.3.1). **R2의 최종 형태는 다음 두 층이며, epoch는 어느
쪽에도 없다.**

1. **wrap 재생 방어 = client-chosen nonce** (§6.3.2). 이것이 유일한 암호 방어다.
   - `packages/plugin/src/late-join-decryptor.test.ts` + `packages/client/src/e2e-crypto-browser.test.ts`:
     `C_A`로 봉인한 wrap을 `C_B` 컨텍스트에서 열면 실패한다. 두 모듈의 `wrapAad`가
     byte-identical인지도 여기서 고정한다.
   - **가장 중요한 테스트 — 전체 라운드 재생**: `(challenge reply nonce, register reply)`를 쌍으로
     재생하는 적대적 relay를 시뮬레이션하고, 브라우저가 **자기** `clientNonce`로 AAD를 계산하므로
     실패함을 보인다. **대조군을 함께 둔다**: `wrapAad`가 서버 nonce를 쓰는 구현에서는 이 재생이
     *성공*한다는 것을 negative fixture로 고정해, 왜 client-chosen이어야 하는지를 테스트가
     스스로 문서화하게 한다.
2. **세대 분리 = 새 랜덤 키** (§6.4.1). AAD가 아니라 키가 막는다.
   - `packages/plugin/src/conversation-key-store.test.ts`: rotate 전후 키가 byte-different.
   - **신규** `packages/plugin/src/e2e-session.test.ts`(현재 없음, R5/P2-6) 또는 기존 envelope
     테스트 확장: 구 K로 봉인한 envelope을 신 K로 열면 실패한다. **epoch 관련 assertion을 넣지 않는다** — 넣으면 존재하지 않는 계약을
     만든다.

`packages/plugin/src/e2e-envelope.ts:287-291`의 `v !== ENVELOPE_VERSION` hard-reject는 이번
릴리스에서 값이 바뀌지 않으므로 새 테스트 대상이 아니다.

### 7.3 검증 명령 (각 트랙 공통 골격)

`docs/ISSUE_55_CONVERSATION_KEY_CAPACITY_PLAN.md` §7.7의 규율을 따른다 — **격리 worktree에서
`npm ci`로 의존성을 새로 설치한다. 다른 worktree의 `node_modules` symlink를 재사용하지 않는다.**

```bash
npx vitest run <해당 트랙의 대상 파일들>
npm run typecheck
npm run build
npm test
```

Track A의 realserver 테스트는 `nats-server` 바이너리를 요구하며 부재 시 자동 skip된다
(`packages/saas/src/nats-permissions-realserver.test.ts:23-24`). **skip은 통과가 아니다** — CI에서
바이너리 존재를 보장하고, skip 발생 시 그 사실이 요약에 보이는지 확인한다.

---

## 8. 롤아웃 / 마이그레이션

### 8.1 현재 버전

`packages/plugin/package.json:3`, `packages/client/package.json:3`, `packages/saas/package.json:3`
모두 `0.3.0`이며 lockstep이다(`CHANGELOG.md:47` — "Plugin, client, and SaaS release metadata move in
lockstep at `0.3.0`").

### 8.2 트랙별 릴리스 성격

| Track | 성격 | 버전 |
|---|---|---|
| C | 문서·주석만 | 버전 변경 없음(다음 릴리스에 편승) |
| A | additive (`ledger` 옵션은 optional, 미공급 시 기존 동작 동일) + resolver 운영 모드 변경 | minor. 단 §5.6 옵션 2를 택하면 **배포 절차가 바뀐다** — 코드 API는 additive여도 운영 breaking이므로 릴리스노트에서 그렇게 분류한다. |
| B | **breaking** — register **요청**에 `clientNonce` 추가 → `WEBCHANNEL_PROTOCOL_VERSION` 2→3. **문서 포맷·message wire는 변경 없음**(§6.2, §6.4). | major 또는 명시적 breaking minor. 3-package 동시. |

### 8.3 Track B forced-lockstep 배포 안무

**전제: 구 브라우저는 hard-break한다. 이것은 결함이 아니라 결정이다(§0.2 (c)).**

**R2에서 이 절이 크게 단순해졌다.** 문서 포맷 마이그레이션이 사라졌으므로(§6.2) 승격 확인,
quarantine 위험, rollback 시 K 소실 경고가 모두 불필요하다.

배포 순서:

1. **사전 공지.** 구 브라우저 세션이 끊긴다는 사실, 사용자가 새로고침해야 한다는 사실.
2. **conversation-key 파일 백업.** owner-only 권한, 날짜 표시. 로그·CI artifact·티켓에 절대
   첨부하지 않는다(`docs/ISSUE_55_CONVERSATION_KEY_CAPACITY_PLAN.md` §9.1과 동일 규율).
   *(형식은 바뀌지 않지만, `rotate`가 키를 교체하므로 백업 자체는 여전히 필요하다.)*
3. **SaaS 먼저 배포.** SaaS는 새 클라이언트 번들을 서빙하지만 아직 구 브라우저도 존재한다.
4. **plugin(gateway) 배포.** 이 시점부터 구 브라우저는 register에서 protocol mismatch(v2 vs v3)로
   terminal 거부된다 — 명확한 오류이며 AEAD 실패 같은 불투명한 상태가 아니다. **이것이 성립하려면
   `WEBCHANNEL_PROTOCOL_VERSION`을 3으로 올려야 하며, §10 #10에서 그렇게 확정했다**(R2/P2-2).
   register **요청** 스키마에 `clientNonce`가 추가되므로 어차피 프로토콜 변경이다.
5. **브라우저 강제 새로고침.** 임베딩 애플리케이션의 번들 버전 게이트에 의존한다.
6. **런북을 같은 릴리스에 갱신한다.** §4.2 §5-ter에 따라 섹션 5(파일 단위 K 리셋)를 강등하고
   **offline per-peer `rotate`** 절차로 대체한다. §5-bis의 ①(gateway 정지)은 그대로다. 코드가
   먼저 나가고 런북이 늦으면 그 사이의 사고 대응이 불필요하게 파괴적인 조작을 한다(R2/P2-1).
7. **임베딩 애플리케이션의 재-부트스트랩 UX를 점검한다** (R2, §6.6.3 비용 1). 체크리스트로
   구체화한다(R3):
   - 앱이 client의 오류 리스너를 구독하는가?
   - `WebChannelErrorCause === "auth-rejected"`를 **명시적으로** 분기하는가? 이 cause는
     `failTerminally(…, "auth-rejected")`(`packages/client/src/nats-client.ts:818-824`)에서
     `notifyErrorListeners(err, cause)`(`:1818`)로 전달된다.
   - 그 분기가 **재-로그인/재-부트스트랩 플로우**로 연결되는가? (단순 오류 토스트로는 부족하다 —
     새 `/nats-user` 민팅과 **새 client 인스턴스** 생성까지 가야 §6.6.2가 성립한다.)
   - **[R5/P1-1 추가] ack 정체 감시가 있는가?** 위 세 항목은 `auth-rejected`를 다루는데, 그것은
     **revoke된 peer에서만** 발화한다. §5-bis ⑥의 대상인 **부수 피해 peer**(유효한 credential,
     건강한 소켓, 다른 account 포함)에서는 **구조적으로 발화할 수 없다.** 즉 위 세 항목만으로는
     ⑥이 존재하는 이유인 바로 그 집단을 하나도 커버하지 못한다.
     따라서 앱은 `onSendState`(`packages/client/src/nats-client.ts:1444`)를 구독해
     **`sent`에 도달했으나 일정 시간 내 `accepted`에 이르지 못하는 send**를 고립 신호로 처리하고
     재부트스트랩을 유도해야 한다. `accepted`는 agent의 `ack`로만 도달하므로(`:1535-1536`, `:1558`)
     이 신호는 agent 생존과 정확히 대응한다. 임계값은 앱이 정하되 사용자 체감 이내로 둔다.
   **이 점검을 통과하지 못하면 봉쇄 절차의 ⑥단계를 실행할 수단이 없다.**
8. **재기동 후 전체 강제 새로고침 경로를 준비한다** (R4/P1-A, §6.6.3 비용 4). rotate 절차는
   gateway 정지를 포함하는데 **재기동만으로는 어떤 브라우저도 재등록하지 않는다** — 소켓이 닫히지
   않아 `onConnected`가 다시 뜨지 않기 때문이다. 따라서 필요한 것은 "유지보수 창"이 아니라
   **그 gateway의 모든 peer를 재부트스트랩시킬 수 있는 수단**이다(번들 버전 게이트, 서버 주도
   강제 새로고침 등). revoke 대상이 아닌 peer와 **다른 account의 peer까지** 포함한다.
   재기동은 in-process history도 비운다(비용 5).

**문서 포맷은 바뀌지 않는다** — `conversation-keys.json`은 v2 그대로다(§6.2). 따라서 R1이 경고했던
"rollback 시 v3 문서가 quarantine되어 K 소실"은 **더 이상 존재하지 않는다.**

**rollback 시 남는 것은 wire 비호환뿐이다.** 구 plugin(프로토콜 v2)은 새 client(v3)의 register를
protocol mismatch로 거부한다. 즉 rollback은 client 번들도 함께 되돌려야 한다 — 통상적인 lockstep
rollback이며 데이터 손실을 동반하지 않는다.

되돌릴 때 유의할 점 둘:

1. rollback 후에는 `rotate`가 없으므로, 그 사이 사고가 나면 §4.2 섹션 5의 파일 단위 리셋으로
   돌아간다. **이미 rotate된 peer는 새 K를 쓰고 있고 그것은 v2 문서에 정상 저장되어 있으므로**
   구 plugin이 그대로 읽는다 — rotation 효과가 취소되지 않는다(R1 서술과 다르다).
2. `conversation-key-generations.json`은 구 plugin이 읽지도 쓰지도 않으므로 남겨 둔다. 다시
   올라올 때 카운터가 이어진다. 감사 파일이므로 유실되어도 보안 영향은 없다(§6.1.2).

### 8.4 운영자 관점 업그레이드 순서 (요약)

```text
Track C  → 문서만. 즉시.
Track A  → ① resolver 옵션 2 이전만 단독 착륙 → e2e 5종 green 확인   ← 첫 서브태스크(§5.6)
         → ② 원장 + 라우트 + dry-run/confirm 배포
         → 원장이 이 시점 이후 발급분만 안다는 사실을 명시. 기존 발급분은 §5.5 dry-run이
           공백으로 보고한다.
Track B  → **이번 사이클 연기**(§3.4). 설계는 §6에 보존. 착수 시 §8.3 안무를 따르며,
           Track A가 선행이어야 한다.
```

**사고 대응 시 조작 순서는 항상 `gateway 정지 → revoke → resolver 확인 → K 교체 → 재기동`이다**
(R3/P1-1, §4.2 §5-bis). Track A와 B가 모두 배포된 뒤에도 바뀌지 않는다. gateway를 세우지 않고
revoke부터 하면 **revoke 이후 민팅된 credential이 rotate 이전에 K_old를 받아 가는 창**이 열리고,
그 결과 만들어진 세션은 양쪽 모두 아무 신호도 내지 않는다(§6.4.3).

**원장의 소급 공백을 강조한다.** Track A 배포 시점 이전에 나간 credential은 원장에 없고, 따라서
정밀 revoke 대상으로 조회되지 않는다. 그 집합에 대한 유일한 수단은 `*` 광역 차단(§5.5의 폭발
반경 경고 포함)이다. 이 공백은 시간이 지나며 자연 해소되지 않는다 — **비만료 credential이기
때문이다**(§2.2). 운영자가 이를 알고 계획할 수 있도록 릴리스노트에 명시한다.

---

## 9. 비범위 (Non-goals)

1. **per-message forward secrecy / Double Ratchet.** `packages/plugin/src/late-join-decryptor.ts:75-77`이
   이미 "Per-message ratchets (e.g. Double Ratchet) are deferred (see Seed)"로 유예했다. epoch
   rotation은 **운영자가 명시적으로 트리거하는 세대 교체**이지 자동 ratchet이 아니다. 둘을
   혼동해서 서술하지 않는다.
2. **history 영속화.** `packages/plugin/src/history-store.ts:50`의 유예를 유지한다. #72는 영속
   history를 도입할 이유가 되지 못한다 — 오히려 in-memory라는 성질이 이 이슈를 싸게 만든다(§0.2 (a)).
   영속화가 나중에 도입되면 그때 "구 epoch envelope의 at-rest 처리"가 **새 문제로** 열린다.
3. **일정 기반 자동 rotation.** rotation은 운영자 트리거 전용이다. 자동 rotation은 forced
   re-register를 주기적으로 유발해 가용성을 해치고, 그 이득(구 K의 가치 감쇠)은 이 이슈가 겨냥한
   위협 모델에서 미미하다.
4. **managed provider(Synadia/NGS) revocation 자동화.** `packages/saas/src/account-revocation.ts:18-19`가
   명시하듯 managed account에는 operator seed가 없다. Track A는 managed 모드에서 **보고**만 한다 —
   "이 배포는 provider 콘솔에서 revoke해야 한다"는 실행 가능한 안내와 대상 `userPubkey` 제시까지.
   provider API 연동은 범위 밖이다.
5. **cross-process locking / 복수 gateway 지원.** §7 T7과 동일 근거. #55 §4 I0의 단일 writer 전제를
   유지한다.
6. **`webchannel.{tenant}.*.{peerId}.>`의 `*` 축소.** 브라우저 grant를 account-scoped로 좁히는 것은
   그 자체로 별개의 breaking 변경이며 #54가 이미 인증 계층에서 문제를 닫았다. 매력적이지만 #72의
   "봉쇄" 목적과 별개 축이다. 별도 이슈로 기록한다.
7. **gateway 재기동이 살아 있는 브라우저를 조용히 고립시키는 문제 — 이슈 #81로 제기됨.**
   [#81 "Gateway restart silently and permanently mutes every live browser
   session"](https://github.com/mir-stream/openclaw-webchannel/issues/81). 생존 판정 경로가 agent가
   아니라 relay를 향하므로(heartbeat: `packages/client/src/nats-client.ts:952-970`; 재등록은
   `onConnected`에서만: `:1250-1251` → `:1632`), **어떤 이유의** gateway 재기동이든 살아 있는
   브라우저를 양방향 무음 상태로 남긴다. #72와 무관한 **제품 결함**이며 #51과 같은 계열이다.

   **이 문서는 그것을 고치지 않는다** — 봉쇄 런북이 그것과 충돌한다는 사실을 §6.6.3 비용 4와
   §4.2 §5-bis ⑥로 다룰 뿐이다. **§6.6.3 비용 4와 §5-bis ⑥는 #81의 해결에 의존한다**: #81이
   닫히면 ⑥의 상당 부분이 자동화되거나 불필요해질 수 있으므로, #81 진행 시 이 문서를 함께
   갱신한다.

   **#81의 수정 방향에 대한 입력** (R5/P1-1): 새 agent→client 하트비트를 만들 필요가 없을 수 있다.
   **송신 ack 정체(ack-stall)가 이미 관측 가능한 신호**이기 때문이다 — `"accepted"`는 agent가 보낸
   `ack` 프레임으로만 도달하고(`packages/client/src/nats-client.ts:1535-1536` → `drainAcked` →
   `:1558`), 그 경로는 `onSendState`(`:1444`)와 `getSendStateSnapshot`(`:1456`)로 이미 노출되어
   있으며 `SendState`/`SendFailure`/`SendReceipt` 타입도 public export다
   (`packages/client/src/index.ts:36-39`). **wire 변경 0으로** 고립을 수 초 내에 탐지할 수 있다.
   #81의 최소 수정은 "ack 정체를 실패로 승격하는 타임아웃"일 가능성이 높다.

8. **`op:"unregister"`의 재생 가능성 (이슈 #51).** `packages/plugin/src/nats-register.ts:195-220`의
   unregister는 token만 검증하고 nonce·PoP·protocolVersion을 요구하지 않으므로, 캡처된 bootstrap
   JWT로 그 JWT가 만료될 때까지 재생 가능하다. **pre-existing이며 이미 이슈 #51로 추적된다** —
   이번 범위에서 고치지 않는다. 다만 이 문서가 그것을 **인지하고 있음을 명시한다**: rotation
   런북은 "등록된 peer 상태가 안정적"이라고 가정하는데, 재생된 unregister가 그 가정을 깰 수 있다.
   offline 트리거를 채택했으므로 rotate 자체는 영향받지 않지만(gateway가 멈춰 있다), 재기동 후
   재부트스트랩 구간에서 공격자가 반복적으로 unregister를 재생해 복구를 지연시킬 수 있다.
   런북에 "복구가 반복적으로 끊기면 #51을 의심하라"는 한 줄을 남긴다.

9. **conversation key at-rest 암호화.** `packages/plugin/src/conversation-key-store.ts:19-20`이
   "K-at-rest encryption is deferred (a co-located master key adds no real protection)"로 유예했고
   그 판단은 유효하다.

---

## 10. 미해결 질문 / 결정 필요 사항

구현 착수 전에 사람이 결정해야 하는 항목. 번호가 우선순위다.

1. ~~resolver 운영 모드~~ — **결정됨(사용자): 옵션 2** (full/NATS resolver +
   `$SYS.REQ.CLAIMS.UPDATE`). 상세와 trade-off는 §5.6으로 이동했다. 핵심 귀결 둘:
   (a) **resolver 이전이 Track A의 첫 서브태스크**이며 e2e 5종 green 확인 후에 원장·라우트를
   얹는다. (b) 옵션 2는 "부수적 소켓 리셋"을 포기하므로 §4.2 §5-bis의 ⑥이 **무조건 필요**해진다
   (R5/P2-5).

2. **원장 저장 백엔드의 1차 대상.** in-memory 구현 + SPI만 내고 durable adapter는 소비자 몫으로
   둘 것인가(`EnrollmentRepository` 선례,
   `packages/saas/src/enrollment-repository.ts:42-54` + `:56-63`), 아니면 파일 기반 durable
   구현까지 제공할 것인가. 전자가 기존 패턴과 일치하지만, **원장이 프로세스 재시작으로 사라지면
   감사 가치가 사라진다.** reference/demo가 in-memory로만 동작하면 T2/T3의 "실제 운영 유사성"이
   약해진다.

3. **`accountContext`를 무엇으로 채울 것인가.** `issueBrowserCredentials`는 accountId를 받지
   않는다(§5.3). 호출자 3곳(`packages/saas/reference/enrollment-server.ts:747`,
   `demo/saas-server.ts:584`, `examples/webchannel-app/server/index.ts:344`)이 각자 무엇을 공급할지
   결정해야 한다. 후보: 애플리케이션의 논리 account id, tenant 반복, 또는 세션에서 유도한 값.
   **감사 라벨이지 권한이 아니라는 점**을 타입 주석에 못 박는 것이 전제다.

4. **원장 기록과 민팅의 순서, 그리고 기록 실패 시 정책 (§5.3).**
   record → mint(권고, 추적 불가 credential 방지, 단 `mintNatsUserCreds` 내부 seam 필요) vs
   mint → record(구현 단순, 추적 공백 발생). 그리고 기록 실패를 발급 실패로 만들 것인가
   (fail-closed 권고, 가용성 비용 있음).

5. ~~envelope epoch의 필수/선택 여부~~ — **해소됨(R2/P1-2).** epoch를 `canonicalAad`에 넣지
   않는다(§0.2 (d), §6.4). 세대 분리는 새 랜덤 키가 이미 완전히 제공하고, `openEnvelope`가
   프레임 자신의 routing에서 AAD를 만들므로(`packages/plugin/src/e2e-session.ts:69-70`) 재생된
   epoch는 자기정합적이라 아무것도 막지 못한다. **후속(비차단)**: 세대 어긋남 시 오류가
   불투명해지는 비용을 감수했다(§6.4.3). 훗날 진단 품질이 문제가 되면 **비-AAD 평문 필드**로
   additive하게 추가할 수 있다 — 그때는 breaking이 아니다.

6. ~~rotation 트리거 모델~~ — **결정됨: (c) offline** (R3/P1-2). gateway를 정지한 상태에서 별도
   CLI 도구가 store를 열어 `rotate`를 호출한다.
   - **(b) gateway-local은 존재하지 않는 표면이었다.** 플러그인 매니페스트는 `cliAddOptions`만
     노출하고(`packages/plugin/openclaw.plugin.json:329`; `:302`의 "commands" 언급은 도움말
     문자열이다), `doctor.ts`는 config/파일을 읽는 CLI-프로세스 모듈이지 gateway RPC가 아니며,
     `control-lane.ts`는 브라우저 `/stop` 레인이다. 살아 있는 gateway 옆에서 별도 프로세스가
     store를 쓰면 #55 §4 I0의 단일 writer 전제와 §9 비목표 5를 위반하고, `ConversationKeyStore`가
     인스턴스별 lazy-load 캐시이므로(`packages/plugin/src/conversation-key-store.ts:117-118`,
     `:210-211`) 살아 있는 gateway는 `peerSessionKeys`에서 K_old를 계속 서빙한다. 즉 (b)는
     (a)의 공격면이 되거나 깨진 설계가 된다.
   - **R2가 (c)를 물리친 근거는 소멸했다.** 그 근거는 "재기동이 봉쇄 효과 없이 시간만 늘린다"였는데,
     R2/P1-1 이후 우리는 **rotation이 아무것도 강제하지 않는다**는 것을 안다 — 재등록을 만드는 것은
     앱 재부트스트랩이다. 따라서 "재등록을 강제하지 못한다"는 (c)를 (a)/(b)와 구별하지 못한다.
   - **(c)는 값을 치르는 대신 돌려준다**: (모든 replica가 멈춰 있다는 전제 아래) 단일 writer 성립
     — **다만 "자명"하지는 않으며 도구가 fail-closed로 탐지해야 한다(§6.5, R4/P1-B)** —,
     새 control plane·authz 불필요,
     재기동이 `peerSessionKeys`와 `HistoryStore`를 비워 §6.6.5의 원자적 세션 교체 계약과 §6.7의
     drop 기계가 **불필요해진다**(둘 다 삭제했다). §4.2 §5-bis의 stop-first(R3/P1-1)와 같은 ①
     단계를 공유한다. 저장소가 이미 취하는 사고 대응 자세(`CHANGELOG.md:21-22` — 모든 취약 replica
     drain·정지)와도 일치한다.
   - 비용은 드문 조작 중의 다운타임이다(§6.6.3 비용 4·5).
   - **온라인 rotation을 나중에 도입한다면** stop-first가 제공하던 발급 창 차단이 사라지므로
     revoke~rotate 사이의 **발급 동결이 필수**가 된다(§4.2 §5-bis).

7. **rotation의 범위 단위.** 이슈는 "the selected (tenant, accountId, peerId), or an explicitly
   selected account-wide scope"를 요구한다. per-peer rotate는 §6.5로 충분하다. account-wide는 해당
   store의 모든 entry를 교체하는 것이며, 두 파일 순서는 §6.5.4를 따른다. 결정 필요: 단일 원자
   커밋인가, per-peer 반복 + 부분 실패 허용인가. 권고: **단일 원자 커밋**(부분 rotate 상태가
   관측 가능한 것이 더 나쁘다).
   **정정 (R3/P2-4)**: 초안은 account-wide의 비용을 "모든 peer가 동시에 재등록을 강요받는다"로
   서술했으나 **rotation은 아무것도 강제하지 않는다**(§6.6.1). 실제 비용은 다르다 —
   account-wide rotate는 **account-wide revoke를 선행으로 요구한다**(§4.2 §5-bis의 stop-first
   순서상 ②가 ④보다 앞이다). 즉 진짜 blast radius는 rotate가 아니라 그 앞의 revoke이며, 그것은
   §5.5가 이미 다루는 `*` 폭발 반경 문제다. account-wide rotate를 검토할 때는 §5.5의 dry-run을
   먼저 본다.

8. **Track C 런북 §5(K 오프라인 리셋)와 `packages/plugin/README.md:194`·`:210`의 "파일/entry 삭제
   금지" 지시의 조정.** §4.2가 등급 분류로 해소하도록 설계했지만, README 본문 문구도 함께 손봐야 두 문서가
   서로를 부정하지 않는다. 어느 문서를 authority로 삼을지 결정 필요. 권고: README는 "일상 운영
   금지"를 유지하고 사고 시 예외로 런북을 **명시적으로 가리킨다**.

9. **이슈 #71과의 관계.** tuple-scoped 저장 코드는 이미 `develop`에 있으나(`4d9365f`~`0d2196d`,
   `packages/plugin/src/storage-paths.ts:61`) **이슈 #71 자체는 여전히 OPEN**이다. **R2에서
   충돌 위험이 크게 줄었다** — Track B는 더 이상 `conversation-keys.json`의 형식을 바꾸지 않고
   (§6.2) 같은 tuple 디렉터리에 사이드카 파일 하나를 추가할 뿐이다. 그럼에도 #71의 잔여 범위가
   디렉터리 레이아웃이나 마이그레이션 기계를 손댄다면 사이드카의 경로/이전 규칙이 영향을 받으므로,
   Track B 착수 전에 확인한다.

10. ~~`ENVELOPE_VERSION`과 `WEBCHANNEL_PROTOCOL_VERSION`을 함께 올릴지~~ — **해소됨(R2/P2-2).**
    `ENVELOPE_VERSION`은 **1로 유지**(§6.4). `WEBCHANNEL_PROTOCOL_VERSION`은 **2 → 3으로 올린다** —
    register 요청에 `clientNonce`가 추가되어 요청 스키마가 바뀌기 때문이며, 그래야 구 브라우저가
    AEAD 실패라는 불투명한 상태(`packages/client/src/nats-client.ts:1764-1772` →
    `secure-channel-failed`) 대신 register 단계의 명확한 mismatch로 거부된다. §8.3 4단계가 그
    결과에 의존하므로 이 결정 없이는 그 약속을 할 수 없었다.
    **남은 정책 질문(저비용)**: 두 버전이 항상 함께 움직여야 하는지에 대한 규칙이 저장소에 명시된
    적이 없다. 이번 사례가 "독립적으로 움직인다"는 실증이므로 그 규칙을 문서화할 것을 권고한다.
    **함께 결정**: `addRevocation`의 `at`에 저수준 상한 검증을 추가할지(§5.1.1 항목 5). 기존
    호출자는 테스트뿐이므로(`packages/saas/src/account-revocation.test.ts`) 호환 비용은 낮다.

11. ~~approval envelope family의 epoch 결박~~ — **소멸됨(R2/P1-2).** conversation envelope에도
    epoch를 넣지 않으므로 `packages/plugin/src/approval-e2e-crypto.ts:115-117`의
    `toAad(approvalId)`만 다르다는 비대칭이 존재하지 않는다. 두 family 모두 세대 분리를 **키
    교체**에 의존하며 그것으로 충분하다. 이 파일은 Track B에서 전혀 손대지 않는다.

12. ~~`requirePoP: false` account를 doctor가 보고할 것인가~~ — **소멸됨(R2/P0-1).** 신선도 앵커가
    PoP nonce가 아니라 client-chosen `clientNonce`로 바뀌었고, 그것은 PoP 분기 밖
    (`packages/plugin/src/nats-register.ts:174`의 top-level `parsed`)에서 읽히므로
    `requirePoP:false`에서도 존재한다. 따라서 rotation은 PoP를 요구하지 않고, R1의 rotate 거부
    게이트와 그에 딸린 doctor finding 논의가 모두 사라진다. *(Track A의 `revocationCapable`
    노출(§5.7)은 별개 사안으로 남는다.)*

13. ~~session-invalidation 프레임을 실제로 추가할 것인가~~ — **해소됨(R1 추가검토).**
    §6.6.4에서 **채택하지 않기로** 결정했다. rotation 이후 in-band 통지는
    `sendToPeer`의 평문 금지(`packages/plugin/src/nats-channel.ts:688-697`) 때문에 물리적으로
    불가능하고, 커밋 전 통지는 강제 순서(revoke → 연결 종료 확인 → rotate)상 수신자가 없으며,
    `notify → mutate` 순서가 이 저장소의 P0-4 규율을 뒤집는다. 재등록 보증은 Track A의 relay
    측 연결 종료 하나다. 새 프레임 타입·핸들러·재연결 가능 teardown 진입점 모두 불필요해졌다.


14. **`popSignedMessage`에 `clientNonce`를 결박할 것인가 (R2, §6.3.2).** 핵심 보안 성질에는
    필요하지 않다 — 브라우저는 자기 값이 AAD에 있는지만 확인하면 되고, relay가 변조하면 unwrap이
    fail-closed로 실패한다. 결박하면 relay 유도 DoS를 추가로 막는다. **비용**: 현재
    `webchannel-pop:${peerId}:${nonce}` 형식이 양쪽에 있고
    (`packages/client/src/pop-register.ts:60-62`, `packages/plugin/src/pop-challenge.ts:63-65`)
    `popSignedMessage`가 client 공개 API로 export되어 있어(`packages/client/src/index.ts:13`)
    **public API breaking**이다. 어차피 lockstep breaking 릴리스이므로 권고는 "결박한다"이나,
    공개 API 변경은 별도 승인 사안이므로 올린다.

15. **`clientNonce`의 길이·형식 규격.** 권고: 32 random bytes를 base64url로 인코딩하고
    (`crypto.getRandomValues`), agent가 형식과 길이를 모두 검증한다(§6.3.3). 서버 PoP nonce가 같은
    형식이므로(`packages/plugin/src/pop-challenge.ts:122`가 `randomBytes(32).toString("base64url")`)
    검증 코드를 재사용할 수 있다. 확정 필요.


16. **offline rotation 도구의 패키징·전달 경로** (R4/P1-B). §10 #6이 (c)를 결정했으나 도구 자체가
    명세되지 않았다. 결정 필요:
    - **어느 패키지가 싣는가.** `packages/plugin`이 자연스럽다(`ConversationKeyStore`가 거기 있고
      `@nats-io/*` 금지 제약과도 무관하다). 별도 CLI 패키지는 store를 public export해야 하므로
      캡슐화 경계(§`package-encapsulation-boundary` 관례)를 넓힌다.
    - **엔트리포인트가 무엇인가.** 매니페스트는 `cliAddOptions`만 노출하므로
      (`packages/plugin/openclaw.plugin.json:329`) `openclaw` 서브커맨드로 등록할 자리가 없다.
      `npx`/`node dist/...` 형태의 독립 스크립트가 현실적이다.
    - **운영자가 tuple 좌표를 어떻게 주는가.** `ConversationKeyStoreOptions`
      (`packages/plugin/src/conversation-key-store.ts:63-84`)는 `tenant`, `accountId`와
      선택적 `storageRoot`/`home`을 요구한다. 이 값들을 플래그로 받을지 openclaw 설정에서 읽을지
      결정해야 하며, **잘못된 tuple을 주면 엉뚱한 account를 rotate한다**(또는 존재하지 않는 peer로
      §6.5.1 항목 1의 거부에 걸린다).
    - **살아 있는 gateway 탐지 수단 — 필수다**(§6.5, R5/P1-2). lock 파일 / pid 확인 /
      register subject 프로브 중 선택. 사후 `generationOf` 검증은 **대체재가 아니다**(§6.5의 논증).
    - **오탐/미탐 의미론과 override** (R5/P2-2). 이것이 결정되지 않으면 탐지는 새 실패 모드를
      만든다:
      - **미탐(false negative)** = P1-B의 초록불 봉쇄 실패가 그대로 재현된다. lock/pid 방식은
        원격·컨테이너 배포에서 구조적으로 미탐하기 쉽다.
      - **오탐(false positive)이 더 위험하다.** ①은 "모든 프로세스 정지"이고 현장에서는 흔히
        SIGKILL이 쓰이는데, 그러면 lock 파일이나 pid 파일이 **stale하게 남는다** — 권고된 수단
        대부분이 여기 해당한다. 그 상태에서 도구가 ④를 거부하면 운영자에게 남는 유일한 수단은
        §5-ter가 은퇴시키려던 **계정 전체 파괴적 리셋**이다. 봉쇄 절차가 자기 안전장치 때문에
        더 위험한 조작으로 밀려나는 것은 받아들일 수 없다.
      - 따라서 **런북이 게이트하는 명시적 override**가 필요하다(예: `--i-have-stopped-all-replicas`
        류의 긴 플래그 + 확인 프롬프트). override 사용은 로그에 남기고, 사용 시 §5-bis ①의 확인
        절차를 다시 밟도록 런북이 지시한다.
      - 프로브 방식(register subject에 요청을 보내 응답 유무 확인)은 stale 상태가 남지 않아
        오탐이 적다. **권고**: 프로브를 1차 수단으로, lock/pid는 보조로.


17. **봉쇄 워크플로가 `static`(BYO-NATS) 배포를 포함하는가 — 범위 결정** (비차단, 최종본에서 추가).
    이 문서는 `static` credential 소스를 **한 번도 다루지 않는다.** 그러나
    `packages/plugin/src/nats-credential-source.ts:18-19`는 그것을 *"a first-class, co-equal
    source"*로 규정하며 SaaS issuer를 *"ONE optional source among three"*로 강등한다고 적고,
    `:21-24`는 `static`에서 plugin이 *"is GIVEN these credentials; it never mints them and never
    imports from `packages/saas`"*라고 명시한다. 실제 union은 `static | enrolled` 2종이다
    (`:96-99` — docstring의 "three"는 이후 제거된 dev open-NATS를 포함한 수치다).

    **런북의 두 단계가 조용히 `enrolled`을 전제한다:**
    - **② revoke** — `addRevocation`은 SaaS 신뢰 체인의 account JWT를 재서명한다
      (`packages/saas/src/account-revocation.ts:51`). BYO relay에서는 SaaS 체인이 그 relay에 대해
      **아무 권한도 갖지 않을 수 있다.** revocation은 relay 운영 주체의 도구로 가야 한다.
    - **④-bis agent credential 재발급** — "재-enrol"은 다시 실행할 enrolment이 있다는 전제인데
      `static` 배포에는 없다(`:21-24`). 필요한 것은 relay 운영 주체로부터 받는 **새 credential**이다.

    **결정해야 할 것**: 봉쇄 워크플로가 `static`/BYO 배포를 **포함한다고 주장하는가**, 아니면
    `enrolled`(및 managed-issuer) 배포로 **명시적으로 범위를 한정하고 그렇게 적는가**.
    **어느 쪽도 방어 가능하다** — BYO 운영자는 자기 relay의 revocation 도구를 이미 갖고 있을
    개연성이 높으므로 후자가 합리적일 수 있다. **문제는 현재 문서가 세 소스 중 하나를 전제한 채
    순서를 무조건으로 서술한다는 점이다.** §4.2 상단에 임시 범위 주의를 넣어 두었으니, 결정이
    나면 그 주의를 확정 문구로 교체한다.

    **비차단**: Track C·A의 나머지 산출물은 이 결정과 무관하게 진행할 수 있다.
---

## 11. 적대적 리뷰 수렴 기준

매 라운드 reviewer는 이 문서 전체와 실제 호출 경로를 새로 읽고 다음을 공격한다.

- 인용된 `path:line`이 실제로 그 내용인지 (**조작된 인용 1건 = hard fail**)
- §0.2의 다섯 이탈이 정확한지 — 특히 history in-memory 주장, resolver MEMORY 주장, epoch-결박 불필요 논증
- Track A/B/C 분할이 실제로 독립 배포 가능한지, 숨은 의존이 없는지
- 원장에 비밀이 새어 들어갈 경로 (에러 메시지, dry-run, 로그, 응답 body)
- `*` blast radius 서술이 agent credential 영향을 빠짐없이 담았는지
- epoch 단조성이 깨질 수 있는 모든 경로 (마이그레이션, quarantine 후 재생성, rollback, 런북 조작)
- **freshness vs authenticity 혼동** — 어떤 방어가 "진짜 agent가 만들었나"를 보장하고 어떤
  방어가 "지금 라운드의 것인가"를 보장하는지. 정합 쌍(matched pair) 재생을 각 프레임에 대해
  개별적으로 시도해 볼 것. **R1과 R2에서 각각 한 번씩 이 부류의 오류가 나왔다** (wrap 경로,
  envelope 경로) — 세 번째가 없는지 의심할 것
- **신선도 값의 출처가 누구인가** — AAD에 들어가는 값을 공격자가 고를 수 있으면 방어가 아니다.
  서버 발행 값은 인증되지 않은 채널로 전달되면 재생 가능하다(§6.3.1). 각 AAD 필드에 대해
  "이 값을 적대적 relay가 정할 수 있는가"를 물을 것
- **어떤 AAD 필드가 이미 키에 의해 결정되는가** — 키가 세대마다 바뀌면 세대 식별자를 AAD에
  넣는 것은 중복이다. 반대로 키가 세대를 넘어 안정적인 경로(wrap)에서는 AAD가 유일한 방어선이다
- wrap AAD 인코딩의 모호성 — 세 필드 사이 구분자 주입 가능성, 양측 정규화 차이
- `canonicalAad` 고정 key order 성질이 보존되는지
- rotate와 capacity ceiling의 상호작용에서 `ConversationKeyCapacityError`가 샐 수 있는지
- **문서 포맷 version bump가 유발하는 quarantine** — forward와 backward 양방향 모두
  (R2에서 포맷 변경 자체를 철회했으므로, 이 항목은 "포맷을 다시 바꾸자는 제안이 재등장하지
  않는지" 감시로 바뀐다)
- **fail-open이어야 할 파일과 fail-closed여야 할 파일** — 암호 자료를 담은 파일은 fail-closed,
  감사 전용 파일은 fail-open. 뒤바뀌면 감사 파일 하나가 계정 전체를 막는다(R2/P2-3)
- **재등록·복구 경로의 각 고리를 코드로 확인했는가** — "끊으면 다시 붙는다"는 직관은 이
  클라이언트에서 틀렸다(terminal, `packages/client/src/nats-client.ts:818-824`). 사슬의 마지막
  고리까지 따라갈 것
- 커밋 순서(generations → key → session → history)가 어느 지점에서 깨지는지, 그리고 fail-open
  이어야 할 파일과 fail-closed여야 할 파일이 뒤바뀌지 않았는지
- 온라인/오프라인 트리거 모델이 문서 전체에서 **하나로** 일관되는지(§10 #6)
- **agent가 보낼 수 있다고 전제한 프레임이 실제로 봉인 가능한지** — `.out`은 현재 세션 키로만
  봉인되고 평문 fallback이 없다(`packages/plugin/src/nats-channel.ts:688-697`). 키를 교체하는
  절차 안에서 "브라우저에게 알린다"는 단계가 등장하면 그 시점의 키가 무엇인지 확인할 것
- 인가 게이트를 우회하는 라우트 배치 — 특히 GET/비-POST 신규 라우트
- 시간 단위 혼용 (ms vs seconds)과 상한 없는 시각 인자
- rotation이 "과거를 치유한다"고 암시하는 문구가 남아 있는지
- 결정적으로 구현할 수 없는 테스트 약속 (특히 T1·T7의 대체안이 정직한지)
- 설계가 만들지 않은 게이트를 테스트가 전제하는지(§7.2가 고친 부류)
- forced lockstep 배포 안무의 rollback 위험 서술이 충분한지

새 리뷰 라운드에서 유효한 P0/P1/P2 finding이 0개일 때 수렴으로 본다.

## 12. 리뷰 로그

| Round | Verdict | Findings | 반영 |
|---|---|---|---|
| R1 | NEEDS_CHANGES | P0 1건, P1 4건, P2 7건 | v2에 전부 반영. 아래 상세. |
| R1-addendum | — | P1-2 후속 판정 1건 (리뷰 라운드 아님) | v3에 반영: in-band invalidation 프레임 **불채택** 확정, §10 #13 해소, §10 #6이 (b)로 수렴. 아래 상세. |
| R2 | NEEDS_CHANGES | P0 1건, P1 4건, P2 6건 (+ 팀리드 자기정정 1건). **R1의 P1-3·P1-4와 P2 5건은 해소 확인.** | v4에 전부 반영. **범위가 크게 줄었다** — 문서 포맷 변경과 message wire 변경이 모두 철회되었다. 아래 상세. |
| R3 | NEEDS_CHANGES | **P0 0건**, P1 2건, P2 8건. **R2의 `clientNonce` 설계는 5개 방향의 공격을 견뎠고 R2 지적은 1건 외 전부 해소 확인.** | v5에 전부 반영. **두 판정이 모두 기계를 추가하는 대신 제거했다** — stop-first 순서가 발급 창을 구조적으로 없애고, offline 트리거가 온라인 세션 교체 계약을 통째로 불필요하게 만들었다. 아래 상세. |
| R4 | NEEDS_CHANGES | **P0 0건**, P1 3건, P2 3건. **R3의 P1-1과 P2 6/8건은 해소 확인.** P1 3건 중 2건은 R3 판정의 여파, 1건은 R3 정리 누락. | v6에 전부 반영. stop-first 판정은 **유지**하되 그 비용 서술이 틀렸음을 정정했고, offline 도구의 미명세 부분과 잔여 stale text를 메웠다. 아래 상세. |
| R5 | NEEDS_CHANGES | **P0 0건**, P1 3건, P2 6건 (+ 사용자 결정 3건). 설계 코어(client-chosen nonce · epoch-as-audit · stop-first · offline rotation)는 5라운드 연속 통과. 지적은 전부 운영/런북 계층. | v7에 전부 반영 + 결정 3건 반영. **가장 큰 것은 P1-3** — `*` 광역 revoke가 agent credential까지 죽여 런북의 기본 경로가 실행 불가였다. 아래 상세. |
| R6 | **판정 없음** | — | 최종 검증 패스로 착수했으나 **보고가 전달되지 않았다**(유휴 알림 3회, 직접 요청 2회 무응답). PASS도 NEEDS_CHANGES도 아니며, 이 문서는 6라운드를 통과하지 **않았다**. **완료된 마지막 적대적 라운드는 R5**이고 그 지적은 전부 v7에 반영되었다. |

### R1 상세

> **주의**: 아래 "반영" 칸의 절 번호는 **v2 당시의 구조**를 가리킨다. R2에서 §6이 재작성되면서
> §6.2.1/§6.2.2/§6.6.4.x 등 일부는 더 이상 존재하지 않는다(해당 설계 자체가 철회되었다).
> 현행 설계는 §6을 직접 참조할 것. 이 표는 각 라운드가 무엇을 지적하고 무엇을 바꿨는지에 대한
> 이력 기록이며 현행 명세가 아니다.

| ID | 등급 | 지적 | 반영 |
|---|---|---|---|
| P0-1 | P0 | §6.6의 안전성 논거가 **정합 쌍 재생**(구 epoch + 그 epoch로 봉인된 구 wrap을 함께 재생)을 덮지 못한다. 그 쌍은 자기정합적이라 Poly1305와 pinned-identity 검사를 모두 통과하고, 브라우저는 epoch의 독립 기준이 없어 탐지 불가. 공격자가 구 K를 쥔 전제상 완전한 세션 탈취. | `wrapAad(peerId, epoch, nonce)`로 PoP challenge nonce를 결박(§6.3, §6.6.2). §0.3에 하드 전제로 승격. §6.6.1에 공격 시나리오를 명시하고 "Track B가 이 위험을 만든다"를 서술. §6.8의 rollback 항목을 "epoch가 막는다"에서 "nonce가 막는다"로 정정하고 두 공격을 분리. §7.2에서 T5 재유도. **추가**: `requirePoP:false`면 nonce가 없어 완화 불가 → §6.6.5에서 rotation을 거부하도록 결정, §0.3 전제 2로 승격. |
| P1-1 | P1 | v2→v3 승격을 "store read 경로"에 두면 `parseConversationKeyDocument:41-43`의 엄격 등호가 `invalid-document`를 던지고 `conversation-key-store.ts:210-246`이 이를 ordinary corruption으로 quarantine → **업그레이드 첫 기동에 모든 K 소실**. 초안은 같은 위험을 rollback 방향(§8.3)에서만 잡았다. | §6.2.1로 정정: **파서**가 `{2,3}`을 받아들이고 v2를 `{epoch:1,key}`로 승격. `legacy-storage-migration.ts:304-318`도 같은 파서를 쓰므로 store에 두면 안 되는 이유를 명시. §8.3 6단계에 quarantine 부재 확인을 추가. 테스트 R-a/R-b 신설. |
| P1-2 | P1 | agent 측에 살아 있는 브라우저를 재등록시킬 수단이 없다(`nats-channel.ts:370-387`은 아무것도 보내지 않고 `:296-298`이 재연결 불가를 명시). 따라서 §6.7의 "가용성 결함" 분류가 거짓 — 피해자가 구 K로 계속 평문을 생산한다. §3.2의 트랙 독립성 주장도 틀렸다. | §3.2에 독립성 정정 블록 추가(B는 A에 의존). §6.6.4 신설: 주 수단 = Track A relay 종료. `forceReconnect`가 private(`nats-client.ts:987`)이고 트리거 프레임이 없음을 실측 기재. *(v2는 보조 수단으로 in-band 프레임을 열어 두었으나 R1-addendum에서 불채택 확정 — 아래 참조.)* §6.7에 분류 정정 주석. §4.2 섹션 5-bis(revoke→rotate 순서) 신설, §8.4에도 반영. §10 #6 권고를 오프라인→gateway-local로 변경. |
| P1-3 | P1 | epoch 단조성이 선언만 되고 구현되지 않았다. 최소 4개 경로가 1로 리셋하며 그중 하나는 **Track C 런북 자신**이다. | §6.1.2 신설: 별도 파일 `conversation-key-floor.json`(절대 낮아지지 않음, 별도 파일이어야 하는 이유 포함). §6.5.3에 floor→key 커밋 순서와 crash 분석. §6.5.4에서 quarantine을 epoch 이벤트로 재분류. §4.2 섹션 5-ter(floor 보존·디렉터리 조작 금지). §8.3 복원 절차에 "floor는 복원하지 않는다". 테스트 R-c/R-d/R-e 신설. |
| P1-4 | P1 | `at`이 단위 혼용(record는 ms, `revokedAt`은 seconds)이고 상한이 없다(`account-revocation.ts:72-76`). ms 값 → 서기 58500년 floor → 영구 거부, `*`면 agent 포함 계정 전체. | §5.1.1 신설: 전 필드 unix seconds + `Sec` 접미사, `nowSec()`, **서버 유도 `at`**, 운영자 지정 시 `now + MAX_SKEW_SEC` 상한. §4.2 섹션 3에 ms 브릭 경고 추가. 테스트 R-h. 저수준 상한 여부는 §10 #10. |
| P2-1 | P2 | §6.4가 실제 production seam인 `e2e-session.ts`를 언급하지 않았고, `approval-e2e-crypto.ts`가 `toAad(approvalId)`를 쓰는 **별도 envelope family**임을 다루지 않았다. | §6.4.2 신설(`e2e-session.ts:27-32/:40/:64`, 호출부 `nats-channel.ts:512/:698/:875`, `getEnvelopeRouting:193-201`, `peerSessionKeys` 값 타입 승격). `crypto-nats-channel.ts:181/:215`는 production 인스턴스화가 없음을 실측해 분류. §6.4.3 신설: approval family는 이번 범위 밖이며 NOTE만 남긴다 + §10 #11. |
| P2-2 | P2 | `isAdminAction`이 POST 한정(`:67`)이고 `:92`가 나머지를 404 처리하므로 `GET /admin/credentials`를 목록에 추가하는 것이 불가능. 우회로 라우트를 `:92` 위로 올리면 **무인증 노출**. | §5.4.1 신설: method-aware admin 테이블 + 4개 회귀 테스트 케이스. 테스트 R-g. |
| P2-3 | P2 | per-peer 일괄 revoke 부재. reference가 로그인마다 비만료 credential을 새로 민팅하므로(`enrollment-server.ts:747-752`) 중간항이 실무 기본 요청이다. | §5.4.2 신설: `revoke-peer` 라우트, `*`와 동일한 dry-run/confirm, 부분 실패 정직 보고, resolver는 누적 후 1회 publish. 테스트 R-i. |
| P2-4 | P2 | §10 #6(오프라인 권고)과 §6.6/§6.5의 온라인 fail-closed 분석이 서로 다른 세계를 서술. | §10 #6 전면 개정: P1-2 이후 권고를 **gateway-local(b)** 로 변경하고 근거 명시. (c) 채택 시 삭제해야 할 절을 지정. |
| P2-5 | P2 | `conversationKeyMapsEqual`의 비교 상대가 epoch 없는 v1 맵이므로 struct 비교로 바꾸면 마이그레이션이 깨진다. | §6.2.2 신설: **key 바이트만 비교 유지**, epoch는 명시적 비범위, v3→key-only 투영 helper. 테스트 R-j. |
| P2-6 | P2 | 구분자 결론은 옳으나 근거를 SaaS 사본이 아니라 **plugin 사본**에서 인용해야 한다(다른 신뢰 도메인, 제3자 IdP). client가 검증하지 않는다는 점도 미기재. | §6.3.2에서 `packages/plugin/src/subject-token.ts:20` + `nats-register.ts:272-278`로 교체하고 신뢰 도메인 차이를 서술. client 무검증 + fail-closed + **정규화 금지** 문장 추가. |
| P2-7 | P2 | T5가 설계에 없는 클라이언트 측 "구 epoch wrap → terminal" 게이트를 전제. | §7.2 신설: 3층 방어(nonce/envelope epoch/floor)로 재유도. T5 행을 §7.2 참조로 교체. |
| — | 사소 | §6.3의 `late-join-decryptor.ts:303`을 "unwrap self-test"로 오기. | `unwrapConversationKey` 내부 AAD 구성으로 정정. |

### R1-addendum 상세 (P1-2 후속 판정)

> 위와 같은 주의가 적용된다 — 절 번호는 v3 당시 구조다. 결론(in-band 프레임 불채택)은 R2에서도
> 유지되나, 그 근거 중 "브라우저가 재연결한다"는 부분은 R2에서 "terminal로 죽는다"로 정정되었다.

R1의 P1-2는 "in-band invalidation 프레임을 채택할지"를 열어 두었다. 그 판정이 내려졌다.

| 항목 | 내용 |
|---|---|
| 실측 정정 | 클라이언트에 재연결 **기계는 존재한다** — `forceReconnect`(`packages/client/src/nats-client.ts:987-1010`)가 소켓을 내리고 재다이얼하며, 호출 지점은 `:412`, `:424`, `:559`, `:603`, `:830`, `:845`와 프레이밍 가드 `:734`, `:850`, `:852`다. v2가 "수단이 없다"고 뭉뚱그린 것을 "기계는 있고 **트리거가 없다**"로 정밀화했다(§6.6.4). |
| 결정적 제약 | agent→browser `.out`은 per-peer 세션 키로만 봉인되며 평문 fallback이 금지되어 있다 — `sendToPeer`(`packages/plugin/src/nats-channel.ts:679`)의 `:688-697`이 "We NEVER fall back to plaintext on the relay"이고 키 부재 시 `return false`, 봉인은 `:698-704`. rotation 커밋 후 agent는 K_new만 쓸 수 있으므로 K_old를 든 브라우저에게 **복호 가능한 프레임을 보낼 수 없다.** 옵션 (a)의 순진한 형태는 물리적으로 불가능하다(§6.6.4.1). |
| 유일한 성립 형태 | `notify(K_old) → rotate → teardown` — 커밋 **전에** 구 키로 통지. |
| 판정 | **불채택**(§6.6.4.2). 근거 3: (1) 적대적 relay가 드롭 가능하므로 원리적 best-effort이며 보증이 못 된다. (2) `notify → mutate`는 이 저장소가 P0-4에서 배운 "mutate/teardown 완료 후 통지"의 정반대이고, 통지 후 rotate 실패(§6.5.3) 시 브라우저가 재등록해 **같은 K_old를 다시 받는** 거짓 신호가 된다. (3) **결정적** — 강제 순서(§4.2 5-bis: revoke → resolver → 연결 종료 확인 → rotate)에서는 rotate 시점에 피해자 세션이 **이미 끊겨 있어 수신자가 없다.** 프레임이 값을 갖는 유일한 경우는 revoke 없이 rotate하는 것인데 그것은 문서가 금지하는 절차다. 금지된 절차를 위한 wire surface를 만들지 않는다. |
| 파급 | §3.2 정정 블록에 in-band 불가 근거 추가. §6.6.3 순서에서 "4. 재등록 강제" 삭제 → 대신 "0. (선행, Track A)"를 명시(rotate 시점엔 이미 끊겨 있음). §6.6.4.3 신설: A → B가 편의가 아니라 **요구**. §10 #13 **해소 처리**. §10 #6은 (a) 배제 + (c)의 유일한 논거 붕괴로 **(b) gateway-local에 사실상 수렴**(남은 것은 확인). |
| 부수 이득 | 새 프레임 타입·inbound 핸들러·"재연결 가능한 teardown" 진입점(기존 `failConnectionEpoch`(`packages/client/src/nats-client.ts:1799-1821`)는 terminal이라 부적합했다)이 모두 불필요해져 Track B의 wire surface가 줄었다. |


### R2 상세

| ID | 등급 | 지적 | 반영 |
|---|---|---|---|
| (팀리드 자기정정) | — | R1이 "Track A의 relay 측 연결 종료 → 재연결 → 재등록"을 보증으로 삼았으나, revocation은 재연결이 아니라 **terminal**을 만든다: `packages/client/src/nats-client.ts:818-824`가 `authorization violation` → `failTerminally(…, "auth-rejected")`이고 문구가 *"reconnecting cannot help"*; `natsCredentials`는 생성 시점 옵션(`:142`, 소비 `:660`/`:705`)으로 갱신 훅이 없어 재다이얼은 같은 revoked JWT를 재제시; `:1813-1814`가 *"recovery is a fresh instance"*. | §6.6.1에 사슬이 끊기는 지점을 실측으로 명시. §6.6.2에 실제 메커니즘(**앱 레벨 재부트스트랩** → 새 `/nats-user` 민팅 → 새 `userPubkey`는 시각 기반 revocation floor에 걸리지 않음 → 새 client 인스턴스)을 신설. §6.6.3에 **운영 비용 3가지** 신설(전원 terminal+사람 개입 필요 / per-peer 일괄 revoke는 그 사용자의 전 기기·전 탭을 끊음 / 옵션 2 이전에는 relay 전체 재기동이 필요해 전면 장애 동반). §3.2 정정 블록과 §8.3 7단계(앱 재부트스트랩 UX 사전 점검)에 반영. §6.6.4의 "프레임 불채택" **결론은 유지**하되 근거를 "재연결한다" → "terminal로 죽는다"로 정정. |
| P0-1 | P0 | (a) `resolveRequirePoPPolicy`(`packages/plugin/src/auth.ts:165-172`)는 준비 시점 1회 확정이고 rotate 이력이 어디에도 남지 않으므로, rotate 후 `requirePoP:false`로 flip+재시작하면 PoP 블록(`nats-register.ts:312-330`)이 통째로 건너뛰어져 R1의 P0-1이 부활한다. R1 §6.6.5의 오류 문구가 그 노브를 만지라고 **가르치기까지** 한다. (b) PoP를 건너뛰면 어떤 nonce를 결박하는지 문서가 말하지 않는다 — `const nonce`는 `if (identity.popPublicJwk) {` 안의 `:313`에 block-scoped라 wrap 지점 `:359`에서 **스코프 밖**이다. 또한 신선도의 실체는 "nonce"가 아니라 서버 측 단일사용 `consume()`(`pop-challenge.ts:162-173`)이다. | **지적을 수용하되 처방을 바꿨다 — 상세는 아래 "R2에서 발견한 추가 결손" 참조.** 서버 nonce는 근본적으로 부족하다(challenge reply가 인증되지 않아 relay가 쌍으로 재생 가능). 앵커를 **client-chosen `clientNonce`**로 교체(§6.3.2). 그 값은 register 요청 본문 top-level(`nats-register.ts:174`)에서 읽히므로 wrap 지점에서 스코프 안이고((b) 해소), **PoP 분기와 무관**하므로 (a)의 config-flip 경로 자체가 소멸한다. R1 §0.3 전제 2와 §6.6.5의 rotate 거부 게이트를 **철회**했다. §10 #12도 소멸 처리. |
| P1-2 | P1 | envelope의 epoch는 inert하다: `openEnvelope`(`packages/plugin/src/e2e-session.ts:64-74`)가 프레임 **자신의** routing에서 AAD를 만들므로(`:69-70`) 재생된 epoch는 자기정합적이고, 실제로 막는 것은 수신자가 K_2를 든다는 사실이다. 매 rotation이 새 난수 키를 만드는 이상 세대 분리는 **이미 완전**하다. 그 inert 필드가 breaking 예산 전체를 지고 있다. **Ruling: 보안 통제로 주장하지 말 것. 그리고 `wrapAad`에도 epoch가 필요한지 재검토할 것.** | **수용.** 검증 결과 wrap 경로에서도 epoch는 nonce 대비 잉여다(같은 라운드에는 epoch가 하나뿐이고, 라운드 간에는 `clientNonce`가 이미 분리한다). **epoch를 두 AAD 모두에서 제거**했다 — 팀리드 선호 (i). §0.2에 이탈 (d) 추가, §6.4 전면 재작성. 회수된 범위: `ENVELOPE_VERSION` 1 유지, `EnvelopeRouting`/`canonicalAad`/`validateEnvelope`/`getEnvelopeRouting` 무변경, `e2e-session.ts` 무변경, `nats-channel.ts:512`/`:698`/`:875` 무변경, 브라우저 envelope 미러 무변경, `peerSessionKeys` 타입 무변경, `crypto-nats-channel.ts` 무변경, approval family 비대칭 소멸. **추가로** conversation-key 문서를 v3로 올릴 이유도 사라져 §6.2를 "v2 유지"로 전면 철회 — 이로써 R1/P1-1의 quarantine 위험 부류와 R2/P2-4가 통째로 소멸하고 테스트 R-a/R-b/R-j가 삭제됐다. epoch는 **감사 메타데이터**로 사이드카 파일에 남는다(§6.1). §3.2·§7·§10 #5/#11 축소 반영. 비용(세대 어긋남 시 불투명한 오류)은 §6.4.3에 정직하게 명시. |
| P1-3 | P1 | 두 AAD 입력 모두 브라우저에 도달하지 않는다. nonce는 `registerWithPop`의 루프 지역변수(`packages/client/src/pop-register.ts:272`)이고 `RegisterWithPopResult`(`:201-221`)에 없으며 unwrap은 두 모듈 떨어진 `nats-client.ts:1758-1763`이다. epoch는 register reply에 넣는다는 명세가 어디에도 없다. | epoch 절반은 P1-2 해소로 **소멸**(브라우저가 epoch를 받지 않는다). nonce 절반은 §6.3.5로 명세 — `clientNonce`는 브라우저가 만들지만 생성·사용 지점이 떨어져 있으므로 `RegisterWithPopResult`에 실어 전달한다. **wire 변경이 아니라 client 내부 배선**임을 명시. 재시도 시 "성공한 시도의 값"이라는 계약도 고정. 테스트 R-k/R-l 신설. |
| P1-4 | P1 | Track C 런북에 정작 그것이 존재하는 이유인 운영자를 위한 경로가 없다. `returnOperatorSeed` 없는 배포는 revoke 자체가 불가능하고(`packages/saas/src/setup-trust-chain.ts:90-93`), seed가 있어도 §5.6 옵션 2 이전에는 적용 채널이 없다(§2.8). Track C가 **먼저** 배포되므로 출하 시점엔 사실상 전 배포가 여기 해당하는데, §5-bis는 revoke를 먼저 하라 하고 §5는 K 리셋을 첫 조치로 금지한다 → 마비 또는 유해 조작. | §4.2에 **섹션 2-bis 강등 경로** 신설: account 비활성화 → 전 replica 정지 → 사고 검토 → 복구 계획(seed 없으면 `returnOperatorSeed:true`로 chain 재생성 일정화, resolver 채널 없으면 nats.conf 재작성+재기동이지만 relay 전면 장애 동반) → §4.1 4조건 확인 후 재개. 저장소 선례(`CHANGELOG.md:21-22`)를 명시적으로 가리킨다. "정밀하지 않다는 것이 요점이며 그것이 Track A를 정당화한다"고 서술. |
| P2-1 | P2 | §6.6.3 step 0이 §4.2 §5-bis를 ①~③처럼 인용하지만 §5-bis의 ④~⑥은 *gateway 정지 → 파일 단위 K 리셋 → 재기동*이라 step 1의 온라인 `rotate`와 양립 불가. §8.3 7단계는 §5-ter를 추가할 뿐 §5/§5-bis를 은퇴시키지 않아, Track B 이후 운영자가 per-peer rotate 대신 계정 전체 파괴 조작을 한다. §4.2 §6도 per-peer rotation을 여전히 "할 수 없는 것"에 둔다. | §4.2 섹션 5-ter를 **"Track B 배포 후 섹션 5는 은퇴한다"**로 전면 교체: ①~③ 유지, ④~⑥을 gateway-local `rotate`로 대체, 섹션 6 목록에서 per-peer rotation 제거. §8.3 6단계를 그 갱신으로 교체. |
| P2-2 | P2 | §8.3 4단계가 약속하는 register-time protocol mismatch는 `WEBCHANNEL_PROTOCOL_VERSION` bump를 요구하는데 §10 #10이 그것을 미결로 두고 "§6.6" 권고라는 stale 참조까지 달았다. bump 없으면 구 브라우저는 register를 통과해 `unwrapConversationKey`에서 `secure-channel-failed`(`nats-client.ts:1764-1772`)로 죽는다 — §8.3이 부인한 바로 그 불투명한 실패. | §10 #10을 **해소**: `ENVELOPE_VERSION`은 1 유지, `WEBCHANNEL_PROTOCOL_VERSION`은 **2→3**. 근거는 register **요청**에 `clientNonce`가 추가되어 요청 스키마가 바뀌기 때문. §8.3 4단계에 그 의존을 명시. stale "§6.6" 참조 제거. 남은 저비용 정책 질문(두 버전의 연동 규칙 문서화)만 유지. |
| P2-3 | P2 | 읽을 수 없는 floor 파일이 throw하면 그 account 전 peer가 `REGISTER_FAILED`가 되는데(유사 경로 `conversation-key-store.ts:216-219`) §4.2 §5-ter가 유일한 복구를 금지한다. 또한 금지가 과도하다 — floor **단독** 손실은 `max(existing, floor ?? 0)+1`이 살아남은 키 파일 위로 여전히 래칫하므로 안전하고, 위험한 것은 **동시** 손실뿐이며 §6.1.2가 이미 그렇게 적고 있다. | 사이드카 읽기 정책을 **fail-open**으로 확정(§6.1.2): 손상·mismatch·I/O 오류 → error 로그 후 빈 상태로 계속, archive도 throw도 하지 않는다. 키 파일의 fail-closed와 **의도적으로 다르다**는 대조를 명시. 복구를 유계로 제시(“현재 키 파일의 어떤 epoch보다 큰 값을 쓰면 된다; 과도한 값은 무해”). 디렉터리 단위 금지는 유지하되 근거를 "보안"에서 "감사 연속성"으로 강등. 테스트 R-d를 fail-open 검증으로 재작성. |
| P2-4 | P2 | §6.2 인벤토리가 write 측을 누락 — `serializeConversationKeyDocument`(`legacy-storage-migration.ts:1789`, `:1816`), `publishEmptyConversationStore`(`:344`), parse 소비자 `:1702`/`:1823`/`:1849`. v1 유래 키가 받을 epoch도 미정. | **소멸.** 문서 포맷을 바꾸지 않기로 했으므로(§6.2) 이 파일들은 전부 무변경이고 "v1 키의 epoch" 질문 자체가 성립하지 않는다. §6.2의 표에 각 항목을 "변경 없음"으로 명시해 장래에 다시 열리지 않게 했다. |
| P2-5 | P2 | 테스트 R-f가 `requirePoP:false` rotate 거부를 `conversation-key-store.test.ts`에 두지만 `ConversationKeyStoreOptions`(`conversation-key-store.ts:63-84`)에는 auth 입력이 아예 없다 — R1 T5와 같은 "작성 불가능한 테스트" 부류. *Nit*: §5.4.1의 `ADMIN_ROUTES`가 `"credentials/revoke"`를 쓰지만 `action`은 `openPath.slice(1)`(`enrollment-http-handler.ts:66`)이라 실제 값은 `"admin/credentials/revoke"`라 매칭되지 않는다. | 게이트 자체가 철회되어(P0-1) R-f를 **삭제**하고 그 번호를 P2-6의 `getOrCreate` 불변 테스트에 재배정. Nit은 §5.4.1의 코드 예시를 `"admin/..."` 접두사로 수정하고, 매칭 실패가 **401이 아니라 404**로 나타나 인가 부재를 숨긴다는 경고와 전용 테스트를 추가. |
| P2-6 | P2 | §6.5.3이 재기동 후 `getOrCreate`/`rotate`가 `max(existing, floor)`를 쓴다고 했는데, `getOrCreate`는 기존 entry를 그대로 반환한다(`conversation-key-store.ts:181-183`). 조회 경로에 `max`를 적용하면 K는 그대로인 채 epoch만 올라가 모든 라이브 브라우저 AAD가 어긋난다. 또한 `rotate`와 사이드카에 `readFresh()` 상당의 refresh-before-commit 규율, §10 #7 account-wide의 두 파일 순서가 미명세. | §6.1.3 신설: **`getOrCreate`는 기존 entry의 epoch를 절대 바꾸지 않는다**를 명시 계약으로 고정하고, `max(...)+1`은 발급 경로 전용임을 못 박음. (R2 설계에서는 감사 오염에 그치지만 구현자가 틀릴 유인은 그대로이므로 계약화.) §6.5.1 항목 2에 `readFresh()`(`conversation-key-store.ts:178`, 구현 `:249-256`) 재사용 규율 추가. §6.5.4 신설: account-wide도 generations 전체 커밋 → keys 전체 커밋 순서. 테스트 R-f(재배정)로 고정. |

### R2에서 발견한 추가 결손 — 팀리드 P0-1 처방의 정정

R2/P0-1을 수용해 gate 위치를 검토하는 과정에서, **R1이 채택한 처방(서버 PoP nonce 결박) 자체가
불충분하다**는 것이 드러났다. 팀리드의 지적("신선도의 실체는 nonce가 아니라 서버 측 `consume()`이다")을
끝까지 따라가면 나오는 결론이다.

- `consume()`(`packages/plugin/src/pop-challenge.ts:162-173`)은 **agent에 도달한 요청만** 태운다.
- challenge reply는 인증되지 않는다 — 브라우저는 `packages/client/src/pop-register.ts:258`에서
  요청하고 `:272`에서 무검증으로 신뢰한다.
- 따라서 적대적 relay는 agent를 **완전히 우회**해 `(구 challenge nonce, 구 register reply)`를
  쌍으로 재생할 수 있다. 브라우저는 relay가 준 nonce로 AAD를 계산하므로 정확히 일치하고, `consume()`은
  발동조차 하지 않는다. 즉 `consume()`은 **agent를** 재생으로부터 보호하지 **브라우저를** 보호하지 않는다.
- 결론: 앵커는 **브라우저가 로컬 생성한 값**이어야 한다 → `wrapAad(peerId, clientNonce)`(§6.3.2).
- 부수 효과로 P0-1(a)(config flip)와 (b)(스코프)가 모두 소멸하고, PoP 의존이 사라져 §0.3 전제 2와
  §6.6.5, §10 #12가 함께 철회되었다.

같은 부류의 오류가 R1(wrap 경로)과 R2(envelope 경로)에서 한 번씩 나왔으므로, §11의 리뷰 대상에
"신선도 값의 출처가 누구인가"와 "어떤 AAD 필드가 이미 키에 의해 결정되는가"를 상설 항목으로 추가했다.


### R3 상세

| ID | 등급 | 지적 | 반영 |
|---|---|---|---|
| P1-1 | P1 | **발급 창**: `addRevocation`은 시각 하한이므로(`packages/saas/src/account-revocation.ts:4-7`) revoke 이후 민팅된 credential은 설계상 통과한다 — 그것이 §6.6.2의 복구를 성립시키는 성질이다. 그래서 `revoke(T) → 앱이 즉시 재부트스트랩 → 새 credential이 register → 아직 rotate 전이므로 **K_old 수령** → rotate(T+Δ)` 순서가 되면, 그 브라우저는 **유효한 credential + 건강한 소켓 + K_old**로 남고 재등록하지 않는다(`packages/plugin/src/nats-channel.ts:296-298`). 실패는 양방향으로 **조용하다**: 클라이언트는 `if (msg)`에서 무음 폐기(`packages/client/src/nats-client.ts:1525-1526`, `:1846-1847`), agent는 `console.warn` 한 줄(`packages/plugin/src/nats-channel.ts:879-884`). 운영자는 전 항목 초록불로 절차를 마치고 현장에 영구 벙어리 세션을 남긴다. | **판정: 발급 동결 노브를 추가하지 않고 절차를 재배열한다.** §4.2 §5-bis를 **stop-first**로 전면 재작성: `gateway 정지 → revoke → resolver 확인 → K 교체 → 재기동 → 앱 재부트스트랩`. gateway가 멈춰 있으면 register를 처리할 responder가 없으므로 그 창에서 누구도 K_old를 얻지 못한다 — 절차적 주의가 아니라 **구조적 차단**이며 새 메커니즘이 0이다. "왜 ①이 맨 앞인가"를 load-bearing으로 명시해 나중에 "최적화"되지 않게 했다. **온라인 rotation을 도입하면 발급 동결이 필수가 된다**는 조건부 경고를 §5-bis와 §10 #6에 남겼다. §8.4의 순서 문장도 교체. |
| P1-2 | P1 | **gateway-local (b) 트리거는 존재하지 않는 표면이다.** 매니페스트는 `cliAddOptions`만 노출하고(`packages/plugin/openclaw.plugin.json:329`, `:302`는 도움말 문자열), `doctor.ts`는 CLI-프로세스 모듈이지 gateway RPC가 아니며, `control-lane.ts`는 브라우저 `/stop` 레인이다. 별도 CLI 프로세스는 두 번째 writer라 §9 비목표 5·#55 §4 I0 위반이고, `ConversationKeyStore`가 인스턴스별 lazy 캐시라(`:117-118`, `:210-211`) 살아 있는 gateway는 K_old를 계속 서빙한다. R2가 (c)를 물리친 근거("재기동은 봉쇄 효과 없이 시간만 늘린다")는 R2/P1-1 이후 **죽었다** — rotation은 애초에 아무것도 강제하지 않는다. | **판정: (c) offline 채택.** §10 #6을 결정으로 재작성하고 근거를 전부 기재. **propagation이 요점이다**: §6.5 헤더를 "offline 도구"로 바꾸고, **§6.6.5의 원자적 세션 교체 계약을 삭제**해 "재기동의 부수효과" 표로 대체했으며, **§6.7의 `HistoryStore.drop()` API 추가 요구를 철회**했다(재기동이 이미 비운다). §4.2 §5-ter도 offline `rotate` 기준으로 재작성. **정정(R4)**: 이 칸은 원래 "stale text를 남기지 않았다"고 적었으나 **사실이 아니었다** — §3.2 산출물 목록, §6.5.1 항목 5, §7 T6 세 곳에 온라인 설계 잔여물이 남아 R4/P1-C로 적발되었다. |
| P2-1 | P2 | §6.1.1이 monotonicity를 단언하고 #72의 "monotonically versioned epoch" AC 충족을 주장하는데, §6.1.2는 사이드카 단독 유실 시 1로 재시작함을 인정한다 — 양립 불가. §0.2 이탈 규율이 이 한 곳에서 무너졌다. | §0.2에 **다섯 번째 이탈 (e)** 추가: epoch는 **best-effort·non-durable 감사 라벨**이며 이 AC의 충족을 주장하지 않는다. §6.1.1을 조건부 진술로 재작성하고 자기모순이었음을 명시. 보안 무영향(어느 AAD에도 없음)도 함께 기재. |
| P2-2 | P2 | §4.2 §5-ter가 "`conversation-keys.json`의 어떤 epoch보다 큰 값"을 쓰라 하지만 그 문서에는 epoch가 없고(`packages/plugin/src/conversation-key-document.ts:16-20`) §6.2가 의도적으로 그렇게 유지한다 — 실행 불가능한 stale R1 텍스트. 인접 결함: §6.1.2의 `max(generations[peerId] ?? 0, 0) + 1`은 값이 `{epoch, rotatedAtSec}`이므로 `NaN`이다(§6.5.1이 정본). | §6.1.2의 식을 §6.5.1과 동일하게 수정하고 R1 오식을 각주로 남겼다. 복구 기준을 "이 account가 과거에 도달했을 법한 값보다 크게, 확신 없으면 넉넉히"로 교체하고 §5-ter는 §6.1.2를 참조하도록 정리. |
| P2-3 | P2 | 사이드카 **쓰기** 실패 정책이 register hot path에서 미명세. §6.1.3이 발급을 `getOrCreate` 생성 분기(동기 register 경로)에 두는데 §6.5.3은 `rotate`에서 fail-closed이므로, 이를 따라 하면 쓸 수 없는 감사 파일이 신규 등록마다 `REGISTER_FAILED`를 만든다 — R2/P2-3의 쓰기 측 재현. 또한 R-e는 `_beforePersist`가 `:273`에서 **모든** atomic write 앞에 발화하므로 사이드카가 `persist()`를 우회할 때만 작성 가능하다. | §6.1.2에 **경로별 쓰기 정책 표** 신설: register hot path = swallow+log, offline `rotate` 도구 = fail-closed. 비대칭을 코드 주석에 남기고 "같은 헬퍼 + 정책 인자" 구현을 권고(복사 실수가 R2/R3 두 라운드의 실패 모드였다). 사이드카 쓰기가 `persist()`를 **거치지 않는 별도 경로**여야 함을 명시하고 R-e에 그 작성 가능 조건을 기재. |
| P2-4 | P2 | §10 #7이 account-wide rotation의 비용을 "모든 peer가 재등록을 강요받는다"로 서술 — rotation은 아무것도 강제하지 않는다. | §10 #7 정정: 실제 비용은 **account-wide revoke가 선행이라는 것**이며, 그 폭발 반경은 §5.5의 `*` dry-run이 이미 다루는 문제다. stop-first 순서상 ②가 ④보다 앞임을 명시. |
| P2-5 | P2 | wrap 계약 소비자 누락: `e2e/local/enrolled-transport-roundtrip.ts:165-182`(ALL-REAL 하네스가 `registerWithPop` 후 `unwrapConversationKey`를 별도 호출 — 누락 시 게이트가 늦게 깨진다), 미러 fixture 2개(`packages/client/src/nats-client-wrapped-key.test.ts:97-104`, `nats-client-wrapper.test.ts:1145-1152`가 `AAD = UTF-8(peerId)`를 재구현), `late-join-decryptor.ts:371`. 또한 `clientNonce`가 `peerId`의 **optionality**를 물려받으면(`:240`, `:303`이 `!== undefined ? … : undefined`) 새 앵커가 조용히 사라진다. | §6.3에 **소비자 전수 표** 신설(9개 항목). **결정: production wrap 경로에서 `clientNonce`는 필수**이며 없으면 throw, legacy optional-AAD 분기는 production에서 도달 불가함을 테스트로 고정(R-n). 미러 fixture 동기화는 R-o. |
| P2-6 | P2 | §6.4.3이 세대 불일치를 "불투명한 오류 / 복호 실패 보고"로 서술 — 보고 자체가 없다. | §6.4.3 재작성: **관측되지 않고, 양쪽 모두 조용하며, 소켓이 살아 있는 한 자가 치유되지 않는다.** 근거 3건 인용. 이것이 epoch 제거의 대가이자 **P1-1이 심각한 이유**임을 연결. |
| P2-7 | P2 | `clientNonce` 구현 함정 2가지: (1) reply에 echo하면 — `RegisterWithPopResult`가 전적으로 `registerReply`에서 조립되므로(`packages/client/src/pop-register.ts:330-342`) — 앵커가 다시 relay-chosen이 되어 이 라운드의 성과가 무효화된다. (2) 검증 위치 미명세 — `nats-register.ts:288-291`이 `protocolVersion` 검사를 인증 뒤에 두는 이유(pre-auth oracle 회피)가 있다. | §6.3.4 신설(함정 2가지). echo 금지를 코드 주석+테스트(R-m)로 고정하고, `clientNonce` 검증을 **인증된 tenant/subject 검사 뒤, PoP/키 확립 전**에 배치하도록 명시(R-l에 반영). |
| P2-8 | P2 | §3.2의 Track A 산출물이 per-peer 일괄 revoke(§5.4.2)와 `revocationCapable`(§5.7)을 빠뜨리고, §5.6 옵션 2를 선행 결정으로만 취급한다(실제로는 최대 산출물). | §3.2 Track A 항목 재작성: 라우트 3종·method-aware 인가 테이블·`revocationCapable`·resolver 이전을 모두 명시하고, **옵션 2는 결정이자 최대 산출물**이며 일정 산정에서 "결정 항목"으로만 보면 크게 빗나간다고 경고. |
| (누락 보완) | — | §6.6.3에 다운타임 비용 부재; 임베딩 앱 계약의 관측 표면 미명명; §6.8이 fresh device key에 보안 주장을 걸 여지; `op:"unregister"` 재생 가능성 미인지. | §6.6.3에 **비용 4(gateway 다운타임)·5(agent history 손실)** 추가, `WebChannelErrorCause "auth-rejected"` + `notifyErrorListeners`(`packages/client/src/nats-client.ts:1818`)를 관측 표면으로 명명하고 §8.3 7단계를 체크리스트로 구체화(+8단계 유지보수 창). §6.8에 **"창을 닫는 것은 `clientNonce`이지 device 키가 아니다 — 임베더가 `CryptoKey`를 캐시하면 그 이점은 사라지므로 보안 주장을 걸지 않는다"** 추가. §9에 unregister 재생(#51) 인지 항목 신설. |


### R4 상세

| ID | 등급 | 지적 | 반영 |
|---|---|---|---|
| P1-A | P1 | **재기동은 유계 다운타임이 아니라 영구 고립이다.** `registerWithPop`의 production 호출 지점은 하나뿐이고(`packages/client/src/nats-client.ts:1632`) `onConnected`(`:1250-1251`)에서만 도달하는데, heartbeat는 **relay를 향한** raw `ws.send("PING\r\n")`이다(`:952-970`, 전송 `:968`). 따라서 gateway 재기동은 브라우저 소켓을 닫지 않고 `onConnected`를 다시 띄우지 않는다. 재기동한 agent는 register에서만 채워지는 `peerSubscriptions`/`peerSessionKeys`가 비어 있어(`packages/plugin/src/nats-channel.ts:271-315`) inbound는 구독자 없이 사라지고 outbound는 `sendToPeer`가 거부한다(`:688-697`). **revoke 대상이 아닌 peer와 같은 프로세스를 공유하는 다른 account의 peer까지** 양방향 무음이 된다. §6.6.3 비용 4("그 창 동안")와 §4.2 §5("재등록 전까지")가 둘 다 ⑤에서의 회복을 암시해 틀렸다. | 비용 4를 전면 재작성: **영구 고립**, 회복은 임베딩 앱 재부트스트랩 또는 사용자 새로고침에서만. 탐지 불가 근거 추가(전송 tracker가 publish 시점에 `"sent"`로 전진, `packages/client/src/nats-client.ts:1992`; agent 수준 ack 타임아웃 없음). **cross-account 부수 피해**를 명시. §4.2 §5의 "재등록 전까지" 문구 교체. §5-bis에 **⑥단계(그 gateway의 *모든* peer 강제 새로고침)** 를 정식 단계로 추가. §8.3 8단계를 "유지보수 창"에서 "전체 재부트스트랩 경로 준비"로 교체. **pre-existing 아키텍처 성질임을 명시**하고 §9에 별도 이슈 제기 항목 신설(#51 계열). stop-first 판정 자체는 유지 — 그것이 K_old 창을 없애고, 온라인 rotation은 그 창 *더하기* 같은 재등록 문제를 안는다. |
| P1-B | P1 | offline 도구가 명세되지 않았다 — 어느 패키지, 어떤 엔트리포인트, `ConversationKeyStoreOptions`(`packages/plugin/src/conversation-key-store.ts:63-84`)가 요구하는 tuple 좌표를 운영자가 어떻게 주는지 전부 공백이고 §10에도 없다. 더 심각하게, §6.5의 "단일 writer가 **자명하게** 성립"은 절차적 주장인데 §4.2 §5-bis:528은 절차적 주의 대신 **구조적 차단**을 기준으로 세웠다 — 자기 기준 위반이다. 반례: `getOrCreate`가 캐시에서 기존 entry를 찾으면 fresh read 없이 반환하므로(`:163-166`) ①을 건너뛰면 살아 있는 gateway가 외부 rotate 후에도 K_old를 계속 서빙하는데 도구는 exit 0으로 끝난다. | §6.5의 "자명하게"를 철회하고 **살아 있는 gateway 탐지 → fail-closed**를 권고로 명시, 채택하지 않을 경우의 대안(운영자 보장 명시 + 재기동 후 `generationOf` 검증)도 함께 기재. **§10 #16 신설**: 패키징(권고 `packages/plugin`), 엔트리포인트(매니페스트에 서브커맨드 자리가 없으므로 독립 스크립트), tuple 좌표 전달 방식과 오지정 위험, 탐지 수단 선택, 사후 검증. |
| P1-C | P1 | 온라인 설계 잔여물 3곳: `:341`(§3.2, **Track B 범위를 정의하는 절**이 "in-memory session 교체, history drop"을 산출물로 열거하고 offline CLI 도구는 누락), `:1328`(§6.5.1 항목 5의 규범적 계약이 "in-memory 세션도 교체하지 않는다"), `:1529`(§7 T6이 세션 없는 `conversation-key-store.test.ts`에서 "세션 미교체" 검증을 약속 — 단언 불가). 추가로 `:1125`가 "§6.6.5의 rotate 거부 게이트"를 참조하나 §6.6.5는 이제 재기동 부수효과 표다. | 네 곳 모두 수정. §3.2 산출물을 **offline CLI 도구 + rotate API + 사이드카 + clientNonce 배선**으로 바꾸고 **철회된 산출물 목록을 명시적으로 병기**해 목록에서 읽는 사람이 철회분을 집지 않게 했다. §6.5.1 항목 5는 디스크 기준 fail-closed로 재작성(정정 각주 포함). T6은 "persist throw → 디스크 불변 → 캐시 Map 불변"으로 교체하고 gateway drain·client 재등록은 런북 담당임을 명시. `:1125`의 죽은 참조 제거. |
| P2-D | P2 | §5-bis ①이 "gateway 정지"라고만 해 구조적 차단이 **모든 replica** 정지를 요구한다는 점이 빠졌다. §2-bis·`CHANGELOG.md:21-22`·§7 T7은 모두 "every replica"를 쓴다. | ①을 "그 gateway의 **모든 프로세스·모든 replica** 정지"로 교체하고, 한 replica라도 살아 있으면 그것이 K_old를 계속 발급한다는 이유를 명시. §5-bis가 T7이 위임한 바로 그 런북 명세임을 밝힘. |
| P2-E | P2 | 새 경로별 사이드카 **쓰기** 정책에 테스트가 없다. 읽기(R-d)와 커밋 순서(R-e)는 고정되어 있는데, 정작 문서 자신이 "한쪽 정책을 다른 쪽에 복사"를 2개 라운드 연속 실패 모드로 지목해 놓고 그 비대칭을 고정하지 않았다. | 테스트 **R-p** 신설: 사이드카 경로를 쓰기 불가로 만든 뒤 `getOrCreate`는 성공(swallow+log), `rotate`는 throw. 정책 복사 mutation이 깨야 함을 명시. |
| P2-F | P2 | SPI 블록이 §5.1.1의 `Sec` 접미사 규칙을 위반한다 — 산문은 `now()`(`:652`)인데 선언은 `nowSec()`(`:681`), `markRevoked(userPubkey, revokedAt: number)`(`:691`)에는 접미사가 없다. 규칙 자체가 안전장치(ms 값이 키를 영구 브릭하고 `account-revocation.ts:72-76`에 상한이 없다)인데 규범 블록 안에서 어겨졌다. | 산문을 `nowSec()`로, `revokedAt` → `revokedAtSec`으로 수정하고 **"SPI의 모든 시각 인자·반환에 접미사를 붙인다, 예외 없음"** 을 §5.1.1에 규칙으로 승격. |
| (미명명 의존) | — | `clientNonce` 재시도 의미론이 성립하는 이유가 문서에 없다. | §6.3.5에 명시: agent가 **매 호출마다 무조건 re-wrap**하기 때문(`packages/plugin/src/nats-register.ts:358-359`, 계약은 `:167-168`의 "re-wrap + re-snapshot on every call"). "등록된 peer면 wrap 생략" 최적화가 들어오면 재시도 클라이언트가 구 nonce 결박 wrap을 받아 열지 못한다 — 구현 시 그 docstring에 의존을 추가하도록 지시. |
| (로그 정정) | — | R3 로그가 "stale text를 남기지 않았다"고 적었으나 사실이 아니었다. | 해당 칸에 정정 문구 추가. 리뷰 로그의 정확성은 미래 독자가 신뢰하는 근거이므로 오기를 남기지 않는다. |


### R5 상세

**사용자 결정 3건**

| # | 결정 | 반영 |
|---|---|---|
| D1 | **resolver 운영 모드 = 옵션 2**(full/NATS resolver + `$SYS.REQ.CLAIMS.UPDATE`) | §10 #1을 미결에서 내리고 §5.6을 결정 서술로 재작성. **resolver 이전이 Track A의 첫 서브태스크**이며 e2e 5종 green 후에 원장·라우트를 얹는다고 명시(§5.6, §8.4). 옵션 2가 **"부수적 소켓 리셋"을 포기**한다는 trade-off를 추가하고(R5/P2-5) 그 결과 §5-bis ⑥이 무조건 필요해짐을 연결. |
| D2 | **Track B 연기**(취소 아님, 별도 이슈 없음, §6 설계는 보존) | §3.4 신설: 근거 3가지(봉쇄 가치 대부분이 A에 있다 — revoke 없이는 공격자가 관측·publish를 계속한다; B의 범위가 R2~R3에서 크게 축소; B는 여전히 breaking). **연기 중 남는 노출**(이미 유출된 K는 무력화 불가)을 정직하게 기록하고, §4.2 §5-ter의 "Track B 배포 후" 조항이 **아직 발효되지 않음**을 명시. §3.3 순서 요약 갱신. |
| D3 | **이슈 #81 등록됨** | §9 항목 7을 "제기할 것"에서 실제 교차 참조로 교체. §6.6.3 비용 4와 §5-bis ⑥이 **#81 해결에 의존**함을 명시하고, R5/P1-1의 발견(ack 정체가 이미 관측 가능)을 **#81의 수정 방향 입력**으로 기재 — 새 하트비트를 만들 필요가 없을 수 있다. |

**리뷰 지적**

| ID | 등급 | 지적 | 반영 |
|---|---|---|---|
| P1-3 | P1 | **`*` 광역 revoke가 agent credential을 함께 죽여 §5-bis ⑤가 실행 불가능하다.** agent creds는 브라우저와 **같은 `accountSeed`**에서 나오고(`packages/saas/src/device-flow-enrollment.ts:690-695` vs `packages/saas/src/nats-user-creds.ts:286-293`), `addRevocation("*")`은 `at` 이전 발급분을 전부 거부하며(`packages/saas/src/account-revocation.ts:4-7`), plugin은 **스스로 재발급하지 못한다**(`packages/plugin/src/nats-credential-source.ts:21-26`). 그리고 §4.2 §5가 `userPubkey`를 특정 못 하면 `*`로 보내고 §8.4에 따르면 그것은 **Track A 이전의 모든 배포** — Track C 출하 시점의 사실상 기본 경로다. | §5-bis에 **④-bis(agent credential 재발급/재-enrol)** 를 정식 단계로 신설하고, `enrolled`/`static` 각각의 절차와 "gateway 정지 상태에서 수행"을 명시. §4.2 §2의 사전 점검에 **"agent 재-enrol 경로가 존재하고 테스트되었는가"** 추가 — 사고 시점이 아니라 평시에 통과시켜 둘 것. §6.6.3에 **비용 5(가장 큰 비용)** 로 신설하고, 이것이 **Track A 원장을 정당화하는 가장 구체적 운영 근거**임을 명시. |
| P1-2 | P1 | 사후 `generationOf` 검증은 ①(모든 replica 정지) 준수 여부를 **원리적으로 관측하지 못한다** — 재기동된 새 프로세스가 디스크를 읽으므로 ① 준수 여부와 무관하게 동일하게 epoch N을 반환한다. 실제로 잡는 것은 tuple 오지정이나 무동작뿐. 한편 진짜 피해(rotate와 재기동 사이에 stale gateway에 등록해 K_old를 받는 브라우저 = R3/P1-1의 발급 창 부활)는 관측되지 않는다. | §6.5에서 **fail-closed 탐지를 권고 → 요구사항**으로 승격하고, `generationOf`가 대체재가 될 수 없는 이유를 논증으로 기재. 선택지를 **(a) 탐지 필수 구현** 또는 **(b) "사후 검증 수단 없음"을 명시**의 둘로 좁히고 "효과 없는 검사를 fallback으로 제시하는 세 번째 선택지는 없다"고 못 박음. `generationOf`는 tuple 오지정·무동작 보조 점검으로 강등. |
| P1-1 | P1 | "브라우저 쪽에 탐지 수단이 없다"는 **거짓**이다. `"accepted"`는 agent가 보낸 `ack`로만 도달하고(`packages/client/src/nats-client.ts:1535-1536` → `drainAcked` → `:1558`), 그 전이는 `onSendState`(`:1444`)·`getSendStateSnapshot`(`:1456`)로 공개되어 있으며 관련 타입도 public export다(`packages/client/src/index.ts:36-39`). 즉 **wire 변경 0**으로 고립을 탐지할 수 있는데 문서는 그 표면이 없다고 말하고 §9는 새 하트비트를 제안한다. 더 중요하게, §8.3 7단계 체크리스트는 `auth-rejected`만 다루는데 그것은 **부수 피해 peer에서 구조적으로 발화할 수 없다** — ⑥이 존재하는 이유인 집단을 하나도 커버하지 못한다. | §6.6.3 비용 4의 문장을 **"누락된 ack를 실패로 바꾸는 *타임아웃*이 없다"**로 정정하고 관측 표면 3단을 근거와 함께 기재. §8.3 7단계에 **ack 정체 감시** 항목을 추가하고, `auth-rejected`가 부수 피해 peer를 커버하지 못한다는 이유를 명시. §9 항목 7(#81)에 이것을 **수정 방향 입력**으로 기재. |
| P2-1 | P2 | `clientNonce` 검증 위치가 모호하다. "인증 뒤, PoP 전"이라는 창은 이미 `protocolVersion` 게이트(`packages/plugin/src/nats-register.ts:292-299`, 426 응답)가 차지하고 PoP는 `:301`부터다. `:292` 앞에 두면 구 v2 브라우저가 426 대신 **401**을 받아 `auth-rejected` → §8.3 재-로그인 → 같은 401 → **무한 재-로그인 루프**가 된다. | §6.3.4 함정 2를 정밀화: **버전 게이트 뒤, PoP 게이트 앞**으로 확정하고 루프 시나리오를 기재. R-l에 **"v2 요청은 401이 아니라 426"** 단언을 추가. |
| P2-2 | P2 | fail-closed 탐지에 오탐/미탐 의미론과 override가 없다. 특히 오탐이 위험하다 — ①은 흔히 SIGKILL로 수행되고 그러면 lock/pid가 stale하게 남아, 도구가 ④를 거부하면 운영자에게 남는 유일한 수단이 §5-ter가 은퇴시키려던 **계정 전체 파괴적 리셋**이다. | §10 #16에 오탐/미탐 절을 신설. 미탐은 P1-B 재현, 오탐은 더 위험한 조작으로의 강제 이동임을 명시. **런북 게이트 override**(긴 플래그 + 확인 + 로깅 + ① 재확인)를 요구하고, stale 상태가 남지 않는 **프로브 방식을 1차 수단으로 권고**(lock/pid는 보조). |
| P2-3 | P2 | dry-run 확인 토큰이 보안 통제인데 명세가 없다 — 저장소·만료·**검토된 집합과의 결박**이 모두 미정. 결박이 없으면 이전의 다른 범위 dry-run에서 복사 가능한 상수로 전락한다. | §5.5에 토큰 명세 추가: **(a) SPI 발급/검증** 또는 **(b) 무상태 MAC**(`HMAC(canonicalDigest(reviewedSet) ‖ expiresAtSec)`, 실행 시 대상 집합에서 digest 재계산 후 비교). 필수 성질 3가지(집합 결박·짧은 만료·재사용 불가)와 `canonicalDigest` 정의를 명시. **권고 (b)** — 새 SPI 없이 결박을 얻는다. |
| P2-4 | P2 | 잔여 stale text 4번째 사례, 이번엔 epoch 어휘: §7 T7의 대체안 (a)(b)가 "신 epoch 클라이언트"를 말한다 — 클라이언트는 epoch를 받지 않는다(§0.2 (d)). | T7 대체안을 "새 K를 얻는다"/"구 K를 캐시한 stale 프로세스"로 교체하고 정정 표시. **스캔 절차 자체를 교정**: 메커니즘 명사뿐 아니라 **`epoch`를 §0.2 (d) 기준으로** 훑는 것을 §11 리뷰 대상에 반영. |
| P2-5 | P2 | ⑥의 필요성이 ③에 조건부인데 옵션 2가 그것을 무조건으로 바꾼다. 옵션 2 이전에는 nats.conf **재기동**이 모든 연결을 끊어 소켓 리셋이 부수적으로 일어나지만, 옵션 2에서는 revoke된 연결만 끊긴다. 또한 `:446-447`과 `:1466-1469`가 `--signal reload`와 재기동을 혼동한다 — 연결을 끊는 것은 재기동뿐이다. | §5.6 옵션 2에 **"부수적 소켓 리셋을 포기한다"** trade-off를 신설하고 ⑥의 무조건 필요성과 연결. 두 곳의 reload/재기동 혼동을 정정하고, §6.6.3 비용 3에 "옵션 2 이전에는 ⑥이 부분적으로 자동 달성된다"는 역설적 부수효과를 기재. |
| P2-6 | P2 | T4의 `packages/client/src/e2e-crypto-browser.test.ts`와 T7/§7.2의 `packages/plugin/src/e2e-session.test.ts`가 **둘 다 존재하지 않는데** 신규 표시가 없다. T4는 나아가 첫 파일이 `wrapAad` byte-identity를 "고정하는 자리"라고 현재형으로 쓰지만 그 계약은 **오늘 어디에서도 단언되지 않는다**. | 두 파일에 **신규** 표시. T4에 "byte-identity는 오늘 단언되지 않으며 테스트에서 `wrapAad`를 잡는 유일한 파일(`packages/client/src/nats-client-wrapped-key.test.ts`)은 계약을 단언하는 대신 `wrapLikeAgent`로 **재구현**한다 — 두 구현을 붙들고 있는 것은 현재 R-o뿐"이라고 명시. |


## 13. 수용 근거 (v7에서 실제로 검증한 것)

리뷰 라운드와 별개로, v7에 대해 다음을 **직접 확인**했다. "리뷰했다"가 아니라 무엇을 어떻게
확인했는지 남기는 것이 목적이다.

| 항목 | 방법 | 결과 |
|---|---|---|
| `path:line` 인용 — 고유 **206건**(총 337회 등장) | 전수 스캔 — 각 참조의 파일 존재 여부와 줄 번호가 EOF를 넘지 않는지 기계 확인. 축약 참조(basename만 쓴 것)는 저장소 내 유일 경로로 해석해 동일 검사. *(팀리드가 v7에서 확인한 189건은 이번 최종 수정 이전 수치이며, §10 #17과 §13 추가로 늘었다.)* | 전건 통과. 존재하지 않는 파일은 **신규**로 표시된 것들뿐(§7의 `packages/client/src/e2e-crypto-browser.test.ts`, `packages/plugin/src/e2e-session.test.ts`) |
| §5-bis ④-bis의 인과 사슬 | 코드 직접 확인 — agent/browser가 같은 `accountSeed`를 쓰는지(`packages/saas/src/device-flow-enrollment.ts:690-695` vs `packages/saas/src/nats-user-creds.ts:286-293`), `*`가 시각 하한인지(`packages/saas/src/account-revocation.ts:4-7`), plugin이 재발급 불가인지(`packages/plugin/src/nats-credential-source.ts:21-26`) | 사슬 성립 확인. §5-bis에 ④-bis 신설 |
| 사용자 결정 3건 반영 | 문서 대조 | resolver 옵션 2 = §10 #1을 결정으로 이동 + §5.6에 trade-off와 **Track A 첫 서브태스크** 명시 / Track B 연기 = §3.4 신설 + 잔여 노출 서술 + §3.3 순서 갱신 / #81 = §9 항목 7 교차 참조 + §6.6.3·§5-bis ⑥ 의존 관계 명시 |
| 철회된 설계의 잔여 텍스트 | live 섹션(§12 리뷰 로그 **이전**)만 대상으로 어휘 스캔 — 메커니즘 명사(`세션 교체`, `history drop`, `유지보수 창`, `gateway-local`, `자명`)와 **개념 어휘**(`epoch`를 §0.2 (d) 기준으로, `reload`를 재기동과의 혼동 기준으로) 양쪽 | R5에서 `reload/재기동` 혼동 1건 추가 적발·수정(§4.2 §3). 그 외 잔여물 없음 — 모든 hit이 "철회됨"으로 표기되었거나 같은 단어의 정당한 다른 용법 |

**이 표가 주장하지 않는 것**: 설계의 정당성. 그것은 R1~R5의 적대적 리뷰가 담당하며, R6은 판정을
내지 않았다(§12). 위 항목은 **문서의 내적 정합성과 사실성**에 대한 확인이다.
