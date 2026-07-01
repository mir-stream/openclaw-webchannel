# WebChannel — 신뢰 결합 & 온보딩 (E2E NATS relay)

> 4주체(브라우저 / OpenClaw plugin / NATS / SaaS)가 서로 무엇을 알아야 하고,
> 그걸 언제·어떻게 주고받는지의 한 장짜리 그림.
> 전제: 에이전트(plugin)는 **고객 인프라**에서 ingress-free로 돌고, 콘텐츠는 **E2E**라
> NATS·SaaS 어느 인프라도 평문을 못 본다. 단일 신뢰 앵커 = **SaaS**.

> ✅ **라이브 검증됨 (live-proven).** 아래 신뢰 모델(§1–4)은 권위 있고, 온보딩 / 기동 순서는
> 이제 **실제 하드웨어에서 end-to-end로 돌아간다**: 실제 브라우저가 device-flow로 enroll된
> 플러그인 + 실제 openclaw 게이트웨이와 실제 JWT-auth `nats-server`를 거쳐 실제 LLM 응답까지
> 왕복한다(브라우저→NATS→플러그인→에이전트→응답, 전 구간 E2E 암호화). 현재 무엇이 되고 안
> 되는지의 **단일 진실원은 [`STATUS.md`](STATUS.md)**; 분할 호스트/컨테이너 재현은
> [`SPLIT_DEMO.md`](SPLIT_DEMO.md). 이 문서는 신뢰 결합·온보딩의 *구현/설계 레퍼런스*로 읽을 것.

```
[브라우저]──┐                          ┌──[OpenClaw plugin = 에이전트]
            │   (가운데 untrusted)      │   고객 인프라, outbound dial만
            └────────→ [ NATS ] ←──────┘   inbound 포트 0
                     암호문만 통과
                        ▲
            모든 신원/키 진위의 기준점
                     [ SaaS ]   서명/attest만, 콘텐츠 도청 X
```

---

## 결합 4종 (+ 빠지기 쉬운 1개)

| # | 무엇 | 방향 | 성격 |
|---|---|---|---|
| 1 | NATS ← SaaS **account 공개키**(operator/account JWT + resolver) | config | 정적, 버스당 1회 |
| 2 | plugin ← **SaaS URL**(→ JWKS 자동 pull) | config | 배포 시 값 1개(비밀 아님) |
| 3 | plugin ↔ SaaS: **NATS user creds 수령** + **에이전트 공개키 등록** | 페어링 | per-agent, 사람 1클릭 |
| 4 | web ← SaaS bootstrap: NATS url+토큰 + **에이전트키 핀** + 자기 JWT/cnf | 동적 | per-session, 자동 |

> **#3에 숨은 절반**: 브라우저가 #4에서 에이전트 공개키를 핀하려면 SaaS가 그 키를 알아야 함.
> → plugin이 자기 X25519 신원키를 만들어 **공개키를 #3 페어링 교환에 얹어 SaaS에 등록**한다.
> (creds는 나가고, 에이전트 공개키는 들어온다.)

---

> **Tenancy**
>
> Architecture 강제:
> - **Channel(플러그인 인스턴스) × 1 ↔ SaaS × 1 친화성.** plugin = 한 trust anchor.
>   다중 SaaS 필요 시 plugin 인스턴스 여러 개 + 상위 layer에서 routing.
> - **Bus(NATS account) × 1 ↔ tenant × 1.** tenant 격리의 단위.
> - **setupTrustChain은 bus 단위로 1회**, SaaS 운영팀이 실행.
> - **승인은 tenant 스코프** — 운영자는 자기 tenant의 Channel만 보고 승인.
>
> "테넌트"의 구체적 의미(조직 / 워크스페이스 / ...)는 **SaaS 책임**.
> 본 doc은 각 tenant가 자기 bus를 가진다는 사실만 가정.

---

## 누가 무엇을 쥐나

| 주체 | 보유 | 출처 |
|---|---|---|
| SaaS | RS256 개인키, **NATS account signing seed** | 자기 생성(`setupTrustChain`) |
| NATS | operator/account **JWT(공개)** + resolver config | SaaS가 emit |
| plugin | NATS URL, **NATS user creds**, **SaaS JWKS**, 자기 X25519 키 | #2 config + #3 페어링 |
| 브라우저 | bootstrap JWT(+cnf), 에이전트키 핀, NATS creds | #4 bootstrap |

> account 키페어는 SaaS가 **한 번 생성해 반으로 쪼갠 것**: private→SaaS 보관, public→NATS config.
> SaaS가 NATS에게서 받는 게 아니므로 **SaaS↔NATS 상호의존 없음**.

---

## 의존 DAG — 순환 0, 루트 = SaaS

```
[keygen: SaaS setupTrustChain]      ← 오프라인 1회 (루트)
      │ public                      │ signing seed (보관)
      ▼                             ▼
  [NATS config]               [SaaS service: JWKS + enrollment]
      └─────────────┬──────────────┘
                    ▼
                 [plugin]   (creds + JWKS + URL 다 받은 뒤 NATS 연결)
```
모든 화살표 단방향. 전부 **setup-time 정적 아티팩트(키/config/JWKS)** 의존 — 런타임 상호의존 아님.

---

## 온보딩 / 기동 순서

```
#1  버스 세울 때 1회 : setupTrustChain 산출물(config)을 NATS에 꽂기   (운영자, once-ever, per-customer 아님)
#2  plugin 배포 시   : SAAS_URL 설정 (기본: wizard, 대안: 환경변수) → JWKS 자동 pull    (비밀 아님)
#3  plugin 첫 부팅   : 로그에 verify_url + user_code 표시
                       → 운영자: 클릭(권장) / 수동 입력 / pending 목록 중 하나로 승인 1번
                       → NATS creds 수령 + 에이전트키 등록 → 로컬 영속 (재시작 시 재페어링 X)
#4  브라우저 접속    : SaaS bootstrap 자동                            (per-session)
```

서비스 기동: **keygen(SaaS) → {NATS, SaaS-svc} (병렬) → plugin(마지막)**.

> **사람이 하는 일은 셋뿐 — 그나마 per-agent는 하나**:
> #1 버스당 1회, #2 URL 한 줄, **#3 페어링 클릭 한 번**. 비밀 붙여넣기는 어디에도 없다.

---

## 운영자 walkthrough — "그래서 내가 뭘 하면 돼?"

> 위 결합은 시스템 관점. 여기선 **사람이 보고·클릭·입력하는 일**만 시간순.
> 비밀 옮겨적기는 어디에도 없음 — 모든 키/creds는 시스템이 만들고 시스템이 보관.

### 0회: 버스 세울 때 (SaaS 운영팀, per-tenant 아님)

NATS config에 SaaS의 account 공개키 박기. 1회, 끝.

### 1회: 플러그인 첫 배포 (그 테넌트 운영자)

**SAAS_URL 설정** — 둘 다 지원, **wizard가 기본**:

| 경로 | 언제 |
|---|---|
| **interactive wizard** (기본) | 첫 배포, 1회성. setup이 URL을 물어봄. |
| **환경변수 / config 파일** (대안) | CI/CD, IaC, 동일 URL 재사용, 비-대화형 부팅 |

플러그인 동작: 환경변수가 있으면 그걸로, 없으면 wizard로 → 어느 쪽이든 같은 JWKS pull. 자동화 친화 순서(환경변수 우선).

플러그인이 JWKS 자동 pull. 끝.

### 1회: 플러그인 첫 부팅

**플러그인이 자동으로 (사람 안 봄):**

1. X25519 신원 키페어 생성 (priv는 디스크, pub는 곧 SaaS로)
2. enroll 요청 (agent_pub 첨부) → user_code + verify_url + device_code 수령
3. 로그 출력:
   ```
   🔗 saas.com/pair?code=ABCD-1234   ← 클릭 1번 (권장)
      fallback code: ABCD-1234       ← URL 깨질 때
   ```
4. 백그라운드 폴링 시작 (device_code로 /poll, 승인될 때까지)

**운영자가 한다 (1 클릭):**

- SaaS 대시보드 로그인 (이미 로그인돼있을 수 있음 — **테넌트 권한 확인**)
- **권장:** 로그의 `saas.com/pair?code=ABCD-1234` 클릭 → user_code 자동 채움 → 승인
- **fallback:** `saas.com/pair`에서 `ABCD-1234` 수동 입력 → 승인 (URL 깨졌을 때)
- **대안:** SaaS 대시보드의 "Pending enrollments" 목록에서 본인 코드 클릭
- **한 번의 승인이 atomic하게 두 가지를 처리:**
  - agent X25519 공개키 **등록** (들어옴) — #4의 키핀 재료
  - NATS user creds **발급** (나감)

**플러그인이 자동으로 (계속):**

5. 폴링 응답 → approved + creds 수령
6. 디스크 영속 저장: `creds.jwt` + `identity.key`
7. NATS 연결
8. 로그:
   ```
   ✅ Pairing complete
      creds:    /var/lib/webchannel/creds.jwt
      identity: /var/lib/webchannel/identity.key
      nats:     connected as user_xxx
   ```

**소요:** 운영자 클릭 1번 + 1–2분.

### N회: 플러그인 재시작

디스크에서 creds + X25519 키페어 로드 → NATS 연결. **페어링 다시 안 함.**

### per-session: 브라우저 (#4, 후술)

---

> **verify_url 클릭 vs 수동 입력 — Scope 노트**
>
> - **plugin scope (이 문서):** user_code를 verify_url과 raw code **둘 다** 표시. URL 깨질 때의 fallback 보장.
> - **SaaS UI scope (이 문서 밖):** 자동 추출 / 수동 폼 / pending 목록 중 어떤 입력 경로를 제공할지.
>
> 어느 쪽이 표준이냐는 운영자 UX 결정. 본질은 "user_code 한 문자열이 plugin→SaaS로 전달" — 전달 매체 디테일은 양단 UI 책임.

---

## 페어링이 device flow인 이유 (RFC 8628)

- plugin은 ingress-free → 자격을 **push 불가** → 부팅 때 **pull(enroll)**.
- enrollment에선 plugin = **신청자**, SaaS/운영자 = **권한자** (런타임의 plugin=문지기와 반대).
- **발급=SaaS**(짧은 user_code + 비밀 device_code 분리 필요), **표시=plugin**(로그), **승인=운영자**(대시보드 로그인=테넌트 권한).
- `verification_uri_complete`(`saas.com/pair?code=…`)로 **타이핑 없이 클릭 1번 (권장)**.
  URL 깨질 때 fallback으로 plugin은 user_code를 raw로도 표시 (수동 입력 경로).

---

## 범위 밖 / 미해결

- E2E crypto 세부(cnf 검증·키핀·핸드셰이크·키 wrap)는 `AUTH.md`/seed 참조. 본 문서는 **결합·온보딩**만.
- 브라우저 NATS dial + cnf 검증 wiring + allowlist 인가는 모두 **구현·라이브 검증됨** (production
  `WebChannelNatsClient`가 직접 NATS를 dial하고 X25519 핸드셰이크·PoP register hop을 수행; `auto`
  admission + `dmSecurity` allowlist가 실제로 게이트한다). 더는 갭 아님 — `STATUS.md` 참조.
- 키 로테이션/revocation은 enrollment 엔드포인트 재호출로 흡수 예정(deferred).
