# #100 — 승인 상태를 무엇에 바인딩할 것인가 (authorization scope)

> 상태: **결정 수정 — #100을 구현 대상으로 유지한다(닫혔다면 재개한다).**
> 전제: #93 Phase 1(`docs/ISSUE_93_APPROVAL_ORIGIN_ROUTING_PLAN.md`)이 develop에 있다(`c002611`).
> 범위: 이 문서는 위협 모델과 구현 경계를 정한다. 아직 production 격리가 구현됐다는 뜻은 아니다.
> 파일명의 `TRANSPORT_GENERATION`은 이 문서가 처음 답하려 한 질문의 잔재다. §6이 정리하듯 채택된
> 경계는 transport generation이 **아니다**.

#100은 **승인의 생성·전달·결정 수명 전체를 어떤 경계에 묶을 것인지** 정하고, 그 경계를
fallback·fast path·snapshot·결정 역경로에 일관되게 적용한다. 최초의 질문은 "account runtime 교체
(G1 → G2)를 승인 origin 경계로 볼 것인가"였으나, §6이 보이듯 그 축은 경계와 일치하지 않는다.

초기 결론은 raw transport 객체 identity와 인가 경계를 같은 것으로 보고 “구현하지 않는다”였다. 그 결론은
tenant를 principal에서 빠뜨렸고, #100이 제안한 generation-scoped pending/resolved snapshot까지 적용한 경우를
평가하지 않았다. 수정된 답은 다음과 같다.

---

## 1. 결론

`(accountId, peerId)`만으로는 승인 principal이 완성되지 않는다. 등록된 `peerId`는 검증된 JWT `sub`지만,
JWT의 signed `tenant`도 별도로 검증되며 tenant는 account lifecycle 사이에 바뀔 수 있는 인가 namespace다.
따라서 최소 경계는 다음 모양이어야 한다. 아래 목록은 완결된 allowlist가 아니라 **하한**이다.

```text
authorizationScope = fingerprint(
  exact tenant,
  account identity,
  effective issuer,
  effective audience,
  configured JWKS trust source/material identity,
  requirePoP policy
)

approvalPrincipal = (authorizationScope, verified peerId)
```

구현 전에는 “누가 등록하고, 승인 prompt를 받고, 결정을 내릴 수 있는가”를 바꾸는 effective input을 전수
감사해야 한다. 최소한 account의 `dmSecurity`/`allowFrom`, effective `execApprovals`의 enabled/approvers와
`commands.ownerAllowFrom` fallback, session의 `identityLinks`와 agent bindings 같은 routing identity 입력이
대상이다. 각 입력은 scope token에 포함하거나, old approval을 current policy 아래에서 어떻게 다시 인가할지
명시적이고 테스트된 reauthorization semantics를 가져야 한다. 어느 정책 변경을 scope 단절로 볼지는 제품
결정이므로 이 문서에서 암묵적으로 정하지 않고 #100 구현 전에 기록한다.

반대로 `NatsChannel` 객체 identity나 startup-attempt 번호는 너무 좁다. 설정이 같은 정상 reload까지 다른
principal로 만들면, 정상 peer가 재-register로 pending 승인을 복구하는 경로를 불필요하게 끊는다.

그러므로 #100의 구현 원칙은 **raw transport-generation 격리**가 아니라 **authorization-scope 격리**다.

- 같은 fingerprint의 G1 → G2는 정의된 current-policy reauthorization까지 통과하면 승인과 pending/resolved
  snapshot을 명시적으로 handoff할 수 있다.
- fingerprint가 달라지거나 required reauthorization이 실패한 G1 → G2는 live fallback, explicit fast path,
  pending/resolved snapshot, widget 결정 역경로를 모두 fail-closed 해야 한다.
- scope mismatch는 승인 payload/ID를 새 scope에 노출하지 않으면서, 요청을 조용히 영구 대기시키지 않는
  명시적 terminal 결과와 stable diagnostic을 남겨야 한다.

fingerprint의 JWKS 항목은 **설정된 trust source와 정책**을 뜻한다. 같은 JWKS URL 뒤에서 일어나는 정상적인
live key rotation까지 매번 새 authorization scope로 취급하자는 뜻은 아니다. 반면 operator가 issuer,
audience, JWKS source/material configuration 또는 `requirePoP` 정책을 바꾼 경우에는 동일 scope라고 추측하지
않고 경계를 닫는다.

---

## 2. 코드에서 확인한 사실

전부 우리 코드다. core 내부 hash-named 번들은 근거로 쓰지 않았다(`bind-to-contract-not-version`).

1. **peerId는 검증된 JWT `sub`다.** 등록 identity는 subject segment가 아니라 검증된 토큰에서 나오고,
   subject/JWT 불일치는 거부된다(`packages/plugin/src/nats-register.ts:350-368`).
2. **tenant도 독립된 admission 조건이다.** JWT의 non-empty signed tenant가 현재 runtime의 exact tenant와
   같아야 한다(`nats-register.ts:183-185`, `:352-358`). 같은 issuer/audience/JWKS와 같은 `sub=P`라도
   `tenant=T1`과 `tenant=T2`는 같은 authorization scope라는 증거가 없다.
3. **PoP은 secure-by-default이지 불변식이 아니다.** `auth.requirePoP: false`면 `pop_jwk`가 없는 JWT도
   등록할 수 있다(`nats-register.ts:419-426`). `pop_jwk`가 있으면 nonce signature를 검증하지만
   (`:428-450`), conversation-key 전달용 X25519 `cnf` device key는 설정과 무관하게 필수다(`:452-462`).
4. **verifier와 transport attempt의 수명은 다르다.** `prepareAccountAuth`는
   `runAccountStartupLoop` 호출 전에 account lifecycle당 한 번 실행된다
   (`nats-account-runtime.ts:546-565`, `:652`). `NatsChannel`은 loop의 각 attempt 안에서 만들어진다
   (`:685-690`, `:814-830`). 따라서 pre-publication retry는 새 transport/channel을 만들 수 있지만 같은
   prepared verifier를 공유한다.
5. **게시된 runtime은 disconnect 때문에 새 attempt로 교체되지 않는다.** publication 뒤 runtime은
   `accountRuntimes`에 들어가고(`nats-account-runtime.ts:1402-1423`), host abort를 기다린다(`:1467`).
   live disconnect/reconnect는 같은 transport의 상태만 갱신한다(`:707-725`). 실제 live G1 → G2는
   config/host reload 같은 account lifecycle replacement가 있어야 한다. startup loop의 반복은 주로
   publication 전 실패를 복구한다(`nats-account-coordinator.ts:433-494`).
6. **tenant는 현재 core session key에 없다.** webchannel route는 `accountId`와 `peerId`로 session key를
   다시 만들지만 tenant를 입력하지 않는다(`session-route.ts:74-97`). 따라서
   `T1/account/P → T2/account/P`가 같은 core session/history namespace를 재사용할 수 있다. 이 더 넓은
   문제는 [#112](https://github.com/mir-stream/openclaw-webchannel/issues/112)가 소유한다.
7. **#93 lease도 tenant/scope를 모른다.** claim은 exact raw account, session key, peer만 보존한다
   (`approval-origin.ts:107-125`). #267 이후 `startClawApprovalMonitor`가 approval-stream/channel-account 시작 시
   호출하는 `rotateEpoch()`은 replay barrier를 세우지만, 계속 실행 중인 handler의 active claim은 의도적으로 유지한다
   (`approval-origin.ts:350-365`; `inbound.ts:112-134`).
8. **승인 delivery와 snapshot도 tenant/scope를 모른다.** live transport lookup은 account ID로만 현재
   runtime을 찾고(`nats-account-runtime.ts:323-326`), pending/resolved store와 조회는 normalized account와
   approval ID 또는 peer로만 key/filter한다(`approvals.ts:193-265`, `:399-422`). 등록 성공 시 현재 runtime은
   그 두 조회 결과를 그대로 snapshot으로 보낸다(`nats-account-runtime.ts:1280-1297`).
9. **결정 역경로도 account까지만 묶인다.** `deliveredApprovalAccounts`는 approval ID를 normalized account에
   바인딩하고, `handleApprovalDecision`은 그 account와 현재 approver 여부를 검사한다
   (`approvals.ts:128-157`, `:1293-1330`). tenant나 verifier/admission scope는 비교하지 않는다.
10. **coordinator의 full-config hash는 경계를 대신하지 못한다.** `installFull`은 `api.config` 전체의 canonical
    JSON을 hash하므로 tenant도 이미 포함한다(`nats-account-coordinator.ts:625-630`). 그러나 그 fingerprint는
    approval lease, pending/resolved entry, prepared target, reverse binding으로 전달되지 않는다. 또한 인가와
    무관한 config 변경까지 포함하는 너무 넓은 값이라 그대로 scope token으로 쓰면 정상 handoff를 불필요하게
    끊는다. #100에는 full config가 아니라 감사된 authorization projection이 필요하다.

`ConversationKeyStore` 자체는 tenant와 account를 함께 받는다(`nats-account-runtime.ts:819-828`). 이 사실과
tenant 없는 core session/history, tenant 없는 approval state는 구분해야 한다.

---

## 3. 실제로 도달 가능한 경계 변경

다음 전이는 verifier 설정을 바꾸지 않고도 성립한다.

1. G1이 `(tenant=T1, account=A)`로 게시되고, T1 자격증명의 `sub=P`가 등록해 agent run을 시작한다.
2. 그 run의 #93 lease는 `(rawAccount=A, sessionKey, peer=P)`만 보존한다.
3. operator가 같은 account A의 tenant만 T2로 바꾸어 host/account lifecycle을 reload한다. issuer,
   audience, JWKS configuration과 `requirePoP`은 그대로 둘 수 있다.
4. #267 이후 G2의 approval-stream/channel-account 시작에서 `startClawApprovalMonitor`가 epoch를 rotate하지만
   아직 실행 중인 G1 handler의 active claim은 유지한다.
5. G2가 `(tenant=T2, account=A)`로 게시되고, T2가 서명된 자격증명의 `sub=P`가 정상적으로 등록한다.
6. retained G1 run이 approval을 만들면 fallback은 old lease에서 `P`를 얻고, account-only `transportFor(A)`는
   현재 G2 channel을 고른다. pending/resolved store도 tenant를 구별하지 않아 G2 register snapshot으로 같은
   승인 상태를 조회할 수 있다.

G2 admission은 이 시퀀스에서도 올바르게 T2를 검증한다. 문제는 인증 우회가 아니라, **T1에서 만들어진 승인
권한 상태를 T2가 현재인 runtime과 store에 인계한 것**이다. 같은 `sub`가 같은 사람을 뜻할 수 있다는
사실만으로 tenant 간 인가 상태 공유가 허용되지는 않는다.

따라서 초기 문서의 “다른 사람을 가리키려면 verifier config가 바뀌어야 한다”는 전제는 틀렸다. exact
tenant가 빠진 principal은 이 전이를 표현하지 못한다.

---

## 4. #100의 전체 snapshot 제안이 주는 효과

현재 구현에서는 G2 register가 account/peer만으로 G1의 pending/resolved 상태를 조회한다. 그러나 #100은
pending/resolved store와 조회 시그니처까지 generation-scoped로 바꾸자고 명시했다. 그 전체 제안 아래에서는
scope가 다른 G2 registration이 G1 approval snapshot을 받지 않는다.

conversation key나 같은 core history에 접근할 수 있다는 사실만으로는 특정 approval의 random ID를 알거나,
그 요청을 resolve할 capability가 자동으로 생기지 않는다. 현재 역경로도 approval ID, delivery account binding,
approver 검사를 요구한다. 그러므로 “register가 세션을 받으니 generation 격리로 막히는 오배송이 없다”는
주장은 성립하지 않는다. snapshot과 역경로까지 같은 경계로 닫으면 특정 승인 요청의 노출과 결정을 막는
실질적인 보안 효과가 있다.

다만 raw generation을 snapshot key에 그대로 넣으면 같은 auth 설정의 정상 reload에서도 G1 상태를 G2가
복구하지 못한다. 이는 #81과 같은 silent liveness failure를 만들 수 있다. 올바른 결론은 “효과 없음”이
아니라 다음 security/availability trade-off다.

| 전이 | 보안 판단 | 가용성 판단 |
| --- | --- | --- |
| fingerprint 동일 + required reauthorization 통과 | 같은 principal로 handoff 허용 | pending/resolved 복구 유지 |
| fingerprint 변경 또는 reauthorization 실패 | 다른/미인가 scope로 fail-closed | old request를 diagnosable terminal 상태로 종료 |

tenant 없는 core session/history 문제를 #112에서 고쳐도 #100은 남는다. 반대로 approval snapshot을 #100에서
격리해도 history namespace는 자동으로 고쳐지지 않는다. 두 이슈는 같은 tenant boundary를 공유하지만 소유하는
상태가 다르다.

---

## 5. 구현 경계

#100 구현은 하나의 scope token/fingerprint를 approval 생성·전달·결정 수명 전체에 보존해야 한다. 현재
config에서 나중에 다시 계산한 peer나 현재 channel 객체만 보는 것으로는 old request의 scope를 증명할 수 없다.

먼저 effective config의 authorization/routing projection을 표로 고정한다. tenant와 verifier/PoP 외에도
`dmSecurity`/`allowFrom`, effective `execApprovals` enabled/approvers(`ownerAllowFrom` fallback 포함),
`identityLinks`/bindings를
감사한다. 각 행은 (a) token에 넣어 변경 시 handoff를 끊거나, (b) old principal을 current policy로 다시
인가하는 명시적 semantics와 원자성/실패 동작을 정의해야 한다. 이 선택이 정해지기 전에는 full-config hash나
일부 필드 목록을 완성된 보안 경계로 간주하지 않는다.

1. **lease/fallback:** run claim이 activation 당시 authorization scope를 캡처하고, resolve 시 request scope와
   current delivery scope가 모두 일치할 때만 peer를 반환한다.
2. **explicit fast path:** core가 준 `turnSourceChannel` + `turnSourceTo`도 peer target만 증명할 뿐 tenant/scope를
   증명하지 않는다. fast path 역시 request에 캡처된 scope와 current runtime scope를 비교해야 한다.
3. **resolve → prepare → live delivery:** prepared target 또는 그와 동등한 provenance가 expected scope를
   보존하고, `transportFor`가 고른 current runtime과 마지막 순간에 일치해야 한다. mismatch 뒤 다른 channel로
   fallback하지 않는다.
4. **pending/resolved snapshot:** store key/entry와 register 조회에 scope를 포함한다. 같은 fingerprint이고
   required reauthorization을 통과한 reload만 old state를 handoff하고, 나머지에는 approval payload/ID와
   verdict를 내보내지 않는다.
5. **reverse decision:** `deliveredApprovalAccounts`의 account-only binding을 scope binding으로 확장하고,
   `handleApprovalDecision`은 frame이 들어온 current runtime scope까지 일치할 때만 gateway resolve를 호출한다.
6. **terminal/diagnostic:** scope change로 orphan된 approval은 무기한 pending으로 남기지 않는다. payload를 새
   scope에 공개하지 않는 terminal drop/deny 결과와 bounded reason code를 남겨 운영자가 scope mismatch와 단순
   disconnect를 구분할 수 있어야 한다.

#100 초안의 consume-once resolve→prepare provenance store에는 실제 제약이 있다. 그 정확성이
`resolveOriginTarget` 1회 : `prepareTarget` 1회라는 **관찰된** core 호출 순서에만 의존하면
`bind-to-contract-not-version`을 위반한다. 구현은 이 pairing을 public contract/테스트로 고정하거나,
approval/request ID에 멱등하게 묶인 provenance처럼 재호출에도 안전한 형태를 써야 한다. 이 제약은 설계를
다듬어야 할 이유이지, snapshot까지 포함한 격리의 보안 효과를 부정하는 근거가 아니다.

---

## 6. generation 용어를 분리한다

앞으로 문서와 테스트에서는 서로 다른 세 수명을 구분한다.

| 용어 | 생성/교체 시점 | #100 경계인가 |
| --- | --- | --- |
| startup attempt | publication 전 dial/wiring 재시도마다 | 아니오 |
| live runtime/channel instance | host/account lifecycle replacement 때 | 그 자체로는 아니오 |
| authorization scope generation | tenant 또는 verifier/admission fingerprint가 바뀔 때 | 예 |

NATS disconnect/reconnect는 게시된 runtime을 교체하지 않는다. pre-publication attempt의 `NatsChannel`은 아직
승인 delivery 대상으로 게시되지 않았다. #100이 막아야 할 것은 “객체가 새로 생김”이 아니라 old approval
provenance와 current authorization scope가 달라지는 순간이다.

---

## 7. 이슈 소유권과 결정

- [#100](https://github.com/mir-stream/openclaw-webchannel/issues/100)은 approval lease/provenance, live
  delivery, pending/resolved snapshot, reverse decision의 authorization-scope 바인딩을 구현한다. 닫지 않는다.
- [#112](https://github.com/mir-stream/openclaw-webchannel/issues/112)는 tenant가 빠진 core session/history
  namespace를 소유한다. #100의 승인 상태 격리로 흡수하지 않는다.
- raw transport identity를 boundary로 삼는 초안은 채택하지 않는다. 같은-scope handoff를 보존하는 stable
  fingerprint를 쓴다.

이 결정은 운영자가 config를 바꿀 권한이 없다는 가정에 기대지 않는다. 운영 변경은 정상 기능이지만, 그
변경이 authorization namespace를 바꾸면 이전 namespace의 승인 권한을 암묵적으로 넘기지 않는 것이
fail-closed 기본값이다.

---

## 8. 구현 완료 조건

아직 아래 항목은 production에 구현되지 않았다. #100은 최소한 다음 회귀를 고정한 뒤 닫는다.

- 같은 tenant/account/verifier/admission fingerprint의 host reload에서 정의된 required reauthorization까지
  통과하면 retained run의 post-barrier approval과 pending/resolved snapshot이 정상 peer에게 handoff된다.
- issuer/audience/JWKS configuration/`requirePoP`은 그대로 두고 tenant만 T1 → T2로 바꾸어도 G1 approval은
  G2 live delivery, register snapshot, resolve frame, widget decision 어디에도 나타나지 않는다.
- issuer, audience, configured JWKS trust source/material 또는 `requirePoP` 변경도 같은 fail-closed 경계를
  지난다. 같은 configured remote JWKS source의 live key rotation만으로 불필요하게 state를 끊지 않는다.
- explicit fast path와 #93 fallback이 같은 scope 검사를 통과한다. 한쪽만 보호되는 경우는 실패다.
- reverse decision은 유출되거나 replay된 approval ID가 있어도 다른 scope에서 gateway resolve를 호출하지 않는다.
- scope mismatch는 stable diagnostic과 terminal result를 남기고, silent permanent wait를 만들지 않는다.
- 단순 NATS disconnect/reconnect와 pre-publication retry는 authorization scope generation을 회전시키지 않는다.
- resolve/prepare가 재호출되거나 예상 순서가 달라져도 provenance가 잘못 consume되거나 다른 요청에 붙지 않는다.
- registration/delivery/decision 권한과 routing identity에 영향을 주는 effective input의 audit matrix가 있고,
  `dmSecurity`/`allowFrom`, effective `execApprovals` enabled/approvers(`ownerAllowFrom` fallback 포함),
  `identityLinks`/bindings 각각에 token 포함 또는 명시적 reauthorization semantics가 결정되어 있다.
- 위 정책 입력 각각을 변경하는 테스트가 선택한 handoff/reauthorization 동작을 고정하며, 실패 시 payload/ID
  노출이나 unauthorized decision 없이 terminal diagnostic으로 닫힌다.
- authorization과 무관한 config 변경은 coordinator full-config hash가 달라져도 scope token을 불필요하게
  회전시키지 않는다.

Phase 1의 account-only `transportFor` 배선과 tenant 없는 approval store는 이 문서의 목표 상태가 아니라
**현재 gap**이다. #100 구현 전까지 이 문서를 보안 불변식이 이미 충족됐다는 근거로 사용하면 안 된다.
