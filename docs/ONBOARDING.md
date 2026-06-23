# WebChannel — 신뢰 결합 & 온보딩 (E2E NATS relay)

> 4주체(브라우저 / OpenClaw plugin / NATS / SaaS)가 서로 무엇을 알아야 하고,
> 그걸 언제·어떻게 주고받는지의 한 장짜리 그림.
> 전제: 에이전트(plugin)는 **고객 인프라**에서 ingress-free로 돌고, 콘텐츠는 **E2E**라
> NATS·SaaS 어느 인프라도 평문을 못 본다. 단일 신뢰 앵커 = **SaaS**.

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
#2  plugin 배포 시   : SAAS_URL 환경변수 1개 → JWKS 자동 pull         (비밀 아님)
#3  plugin 첫 부팅   : 로그에 verification_uri_complete 표시
                       → 운영자 대시보드에서 클릭 승인 1번
                       → NATS creds 수령 + 에이전트키 등록 → 로컬 영속 (재시작 시 재페어링 X)
#4  브라우저 접속    : SaaS bootstrap 자동                            (per-session)
```

서비스 기동: **keygen(SaaS) → {NATS, SaaS-svc} (병렬) → plugin(마지막)**.

> **사람이 하는 일은 셋뿐 — 그나마 per-agent는 하나**:
> #1 버스당 1회, #2 URL 한 줄, **#3 페어링 클릭 한 번**. 비밀 붙여넣기는 어디에도 없다.

---

## 페어링이 device flow인 이유 (RFC 8628)

- plugin은 ingress-free → 자격을 **push 불가** → 부팅 때 **pull(enroll)**.
- enrollment에선 plugin = **신청자**, SaaS/운영자 = **권한자** (런타임의 plugin=문지기와 반대).
- **발급=SaaS**(짧은 user_code + 비밀 device_code 분리 필요), **표시=plugin**(로그), **승인=운영자**(대시보드 로그인=테넌트 권한).
- `verification_uri_complete`(`saas.com/pair?code=…`)로 **타이핑 없이 클릭 한 번**.

---

## 범위 밖 / 미해결

- E2E crypto 세부(cnf 검증·키핀·핸드셰이크·키 wrap)는 `AUTH.md`/seed 참조. 본 문서는 **결합·온보딩**만.
- 현재 갭: ① 에이전트측 cnf 검증 wiring, ② 브라우저 NATS dial(아직 게이트웨이 WS), ③ allowlist 인가(코어 위임 stub).
- 키 로테이션/revocation은 enrollment 엔드포인트 재호출로 흡수 예정(deferred).
