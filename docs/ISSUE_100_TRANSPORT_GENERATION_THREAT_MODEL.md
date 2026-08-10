# #100 — 승인 전달을 transport generation에 바인딩할 것인가

> 상태: **결정됨 — 구현하지 않는다(wontfix).** 재개 조건은 §7.
> 전제: #93 Phase 1(`docs/ISSUE_93_APPROVAL_ORIGIN_ROUTING_PLAN.md`)이 develop에 있다(`c002611`).

#100은 두 단계짜리 이슈였다. 먼저 **account runtime 교체(G1 → G2)를 origin 경계로 볼 것인지** 답하고,
답이 "그렇다"이면 격리를 구현한다. 이 문서는 앞 단계의 답이며, 답은 "아니다"다.

---

## 1. 결론

`(accountId, peerId)`는 이미 principal이고, transport 객체 identity는 그 principal을 더 좁히지 않는다.
generation을 origin 경계로 삼아도 **막히는 오배송이 없고**, 대신 정상 peer가 자기 승인을 되찾는 유일한
경로를 끊는다. 그래서 닫는다.

이 결론은 "위협이 없다"가 아니다. 실재하는 잔여 위협은 하나 있는데(§6), 그것은 transport 모양이 아니라
**verifier config 모양**이며, 이 계층에서 막을 수 있는 것도 아니다.

---

## 2. 확인한 사실

전부 우리 코드다. core 내부 번들은 근거로 쓰지 않았다(`bind-to-contract-not-version`).

1. **peerId는 검증된 JWT `sub`다.** 등록 identity는 subject segment가 아니라 verify된 토큰에서만 나오고,
   subject/JWT 불일치는 거부된다(`packages/plugin/src/nats-register.ts:17-24`, `:360-368`). PoP까지 요구한다.
2. **그 verify는 계정별 verifier가 한다.** register 핸들러는 `accountAuth.verifyIdentity`를 받는다
   (`nats-account-runtime.ts:1270`). 따라서 `(accountId, peerId)`는 그 계정의 verifier 설정 아래에서
   유일한 주체다.
3. **verifier는 generation마다 새로 만들어진다.** `prepareAccountAuth`는 attempt 클로저 안에 있고
   (`nats-account-runtime.ts:555`), `NatsChannel`도 같은 클로저에서 생성되어(`:819`)
   `accountRuntimes`에 게시된다(`:1421`). 즉 generation은 verifier 세대이기도 하다.
4. **generation 교체는 config 변경 없이도 일어난다.** transport 내부 재연결은 attempt를 끝내지 않는다
   (`nats-account-coordinator.ts:390` — `reconnect` 이벤트는 `restartPending`만 내린다). 새 generation은
   attempt 루프가 다시 도는 경우 — dial 실패, 회복되지 않은 소켓 종료, 재설정 — 에 생긴다.
   **평범한 운영 이벤트가 새 generation을 만든다.**
5. **peer의 inbound 구독은 register 시점에만 설치된다**(`nats-channel.ts:312`). 새 generation은
   `peerSubscriptions`가 빈 채로 시작하므로, 모든 peer는 다시 register해야 한다 — 이것이 #81의 뿌리다.
6. **register는 그 peer에게 세션 전체를 넘긴다.** 같은 핸들러가 conversation key를 그 기기용으로 wrap해
   주고(`nats-account-runtime.ts:1274`), history snapshot을 주고(`:1277`), **pending/resolved 승인
   snapshot을 준다**(`:1292`).
7. **그 승인 목록은 generation을 모른다.** `listPendingApprovalsForPeer`는 `(normalized accountKey,
   sessionKey=peerId)`로만 필터한다(`approvals.ts:261`).
8. **#93의 lease epoch은 transport 교체로 회전하지 않는다.** `start/stopAgentLifecycleSubscription`은
   plugin generation 수명에 걸려 있고(`inbound.ts:76`, `:113`; 호출부는 `nats-account-runtime.ts:1528`,
   `:1533`의 `registerFull`/runtime lifecycle), account attempt에 걸려 있지 않다.

---

## 3. 창은 실재하는가 — 그렇다

(8)에 의해, G1에서 시작된 run의 lease는 G2에서도 살아 있다. agent run은 채널 수명과 무관하므로
"G1에서 origin이 증명된 run이, G2가 현재일 때 승인 요청을 만든다"는 시퀀스는 기계적으로 가능하다.
그때 #93의 resolve는 peer `P`를 돌려주고, persisted stored target도 `P`이며, 전달은 G2의 채널로 나간다.

즉 #100이 가정한 창 자체는 실재한다. 문제는 그 창으로 **무엇이 통과하느냐**다.

---

## 4. 그 창으로 잘못 갈 수 있는 경우는 하나뿐이다

G2에서 문자열 `P`가 G1과 **다른 사람**을 가리켜야 한다. (1)(2)에 의해 그러려면 그 계정의 verifier 설정
— issuer / JWKS / audience — 이 G1과 G2 사이에 바뀌어서, 다른 자격증명 보유자가 `sub=P`를 받을 수
있어야 한다. 설정이 그대로면 `sub=P`는 같은 주체다. 그건 IdP의 주장이고, 이 플러그인 전체가 이미 그
주장 위에 서 있다 — 메시지 라우팅, history, conversation key, 승인 snapshot 어디에도 generation
한정자는 없다.

그래서 공격자는 하나로 좁혀진다: **계정의 verifier 설정을 바꿀 수 있는 운영자.**

---

## 5. 격리는 그 공격자를 막지 못한다 — 그리고 정상 경로를 끊는다

**막지 못하는 이유.** (6)에 의해, 그 운영자가 IdP를 갈아끼운 뒤 새 `P`가 register하면 그 자리에서
conversation key와 history와 pending 승인 목록을 통째로 받는다. 승인 *전달* 한 건을 generation으로
막아도, 같은 승인이 다음 register snapshot으로 나간다. 문을 떼어낸 벽에 열쇠구멍을 잠그는 일이다.
(#100 초안은 snapshot 저장소 키에 generation을 넣자고까지 제안했지만, 그러면 아래 비용이 그대로 커진다.)

**끊는 것.** (4)(5)(6)을 합치면: config가 그대로인 평범한 재시작으로 새 generation이 생기고, 그 뒤
**정상** peer `P`가 다시 register하는 것이 세션을 되살리는 유일한 경로이며, 그때 받는 snapshot이 중단
중에 떠 있던 승인을 되찾는 유일한 경로다. generation 바인딩은 정확히 그 경로를 지운다 — `P`는 자기
승인이 목록에서 사라진 채, 아무 신호 없이, 영구히 기다린다. 이건 #81이 이미 열려 있는 실패 유형
(조용한 영구 뮤트)을 **의도적으로 하나 더 만드는** 것이다.

**추가로, 제안된 구현 방식 자체의 문제.** #100 초안의 resolve→prepare provenance store는 consume-once
설계이고, 그 정확성은 `resolveOriginTarget` 1회 : `prepareTarget` 1회라는 **관찰된** 호출 순서에 걸려
있다. 이슈 본문도 "계약 아님"이라고 적어두었다. 계약이 아닌 호출 순서에 정확성을 거는 것은
`bind-to-contract-not-version`이 금지하는 바로 그 패턴이다.

**일관성 문제.** 이 격리는 fallback 경로에만 적용된다. #93 §9대로 core가 `turnSourceChannel` +
`turnSourceTo`를 채우면 fast path가 지배적이 되고, 그때 일관성을 지키려면 **core가 준 target**을
generation으로 검증해야 하는데 core는 generation을 모델링하지 않는다. 즉 곧 vestigial이 될 경로에만
남는 보호다.

---

## 6. 그래서 남는 진짜 잔여물

닫으면서도 기록해 둘 것 두 가지. 둘 다 transport generation 모양이 아니다.

- **verifier config 교체 = 세션 인계.** §4의 운영자 시나리오는 실재하고, 그 결과는 승인 오배송이
  아니라 **conversation key와 history를 포함한 세션 전체의 인계**다. 이걸 다루려면 transport 객체
  identity가 아니라 verifier config fingerprint(issuer/audience/JWKS)를 대상으로 삼아야 하고,
  자리는 승인 라우팅이 아니라 자격증명·키 격리(#72 계열)다. 지금 열 이슈는 아니다 — 이 인계는 현재
  운영자 권한 모델에서 *의도된* 동작으로도 읽히며, 그 판단이 먼저다.
- **peerId가 principal이 아닌 배포.** 익명 단일 세션 배포에서 `wsKey`는 `web-anon`으로 접힌다
  (`inbound.ts:196`). 두 브라우저가 같은 `web-anon`을 쓰면 #93의 poison도 둘을 구분하지 못한다.
  이건 generation과 무관하게 **한 generation 안에서** 이미 성립하므로, generation 바인딩으로는
  손도 못 댄다. register-hop admission 아래에서는 peerId가 항상 검증된 `sub`이므로 실배포 경로는
  아니지만, 전제가 깨지면 여기가 먼저 깨진다는 것을 적어 둔다.

---

## 7. 재개 조건

다음 중 하나가 생기면 이 결정을 다시 연다.

1. **verifier 설정을 바꾸지 않고** 같은 `(account, peerId)`가 다른 주체가 되는 경로가 발견된 경우.
   그러면 §4의 유일한 전제가 깨진다.
2. register가 더 이상 세션을 통째로 넘기지 않게 된 경우 — 즉 conversation key/history/승인 snapshot이
   재-register만으로는 넘어가지 않도록 바뀐 경우. 그러면 §5의 "이미 문이 떼어져 있다" 논거가 사라진다.
3. #81이 재-register가 **아닌** 방식으로 세션 생존성을 해결한 경우. 그러면 §5의 비용(정상 복구 경로
   단절)이 줄어든다.

재개하더라도 바인딩 대상은 transport 객체 identity가 아니라 **verifier config fingerprint**여야 한다.
평범한 재연결을 origin 경계로 오인하지 않는 유일한 신호다.

---

## 8. 하지 않기로 한 것 (이슈 본문 범위 대조)

- lease claim의 `transportGeneration` 토큰과 `(rawAccountId, transportGeneration, peerId)` poison 확장 — **하지 않음**
- `approvals.ts`의 resolve→prepare consume-once provenance store — **하지 않음** (§5)
- `prepareTarget`의 current-transport `===` 재확인, captured-transport delivery — **하지 않음**
- pending/resolved snapshot 저장소의 generation 키잉과 `list*ForPeer` 시그니처 변경 — **하지 않음** (§5)
- explicit fast path로의 확장 — **하지 않음** (§5)
- `deliveredApprovalAccounts` / `handleApprovalDecision`의 위젯 클릭 역경로: **generation-agnostic으로
  유지한다.** 근거는 위와 같다 — 결정을 보내는 주체도 검증된 `sub`이고, generation은 그 주체를 더
  좁히지 않는다.
- `__pendingApprovalsTestHook` 시그니처 변경 — 불필요

Phase 1의 `transportFor` 배선이 계속 `(account, peer)` 단위로 전달을 담당한다. 코드 변경 없음.
