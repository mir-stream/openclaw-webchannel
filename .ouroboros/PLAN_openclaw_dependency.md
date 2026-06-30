# Plan — webchannel을 OpenClaw 플러그인 정석 구조로 전환

> 목표: `references/openclaw` vendored 복사본에 대한 webchannel의 의존을 끊고,
> npm `openclaw` 패키지를 peer/devDependency로 받는 **공식 정석 구조**로 전환한다.
> 그러면 `references/openclaw`는 자유롭게 옮기거나 삭제할 수 있고, `npm install`이
> 더 이상 심볼릭 링크/dist를 깨지 않는다.

## 배경 (리서치로 확정된 사실)

- 공식 docs + npm 검증 결과, OpenClaw 플러그인의 정석은:
  ```json
  "peerDependencies":     { "openclaw": ">=2026.6.10" },
  "peerDependenciesMeta": { "openclaw": { "optional": true } },
  "devDependencies":      { "openclaw": "2026.6.10" }
  ```
- `openclaw`는 **npm 공개 패키지** (`2026.6.10`, ~87MB unpacked)이고, webchannel이
  쓰는 **10개 `plugin-sdk/*` subpath 전부 export**한다 (검증 완료):
  channel-core, channel-outbound, channel-runtime, approval-runtime,
  approval-auth-runtime, approval-native-runtime, approval-handler-runtime,
  approval-handler-adapter-runtime, approval-delivery-runtime, approval-client-runtime
- 공식 외부 플러그인 `@openclaw/brave-plugin`이 정확히 `peerDependencies: { openclaw: ">=2026.6.10" }` 사용.
- `@openclaw/plugin-sdk`는 npm에 **없음(404)** — SDK 별도 패키지가 아니라 `openclaw` 본체를 받는 게 정석.
- webchannel의 `openclaw.plugin.json` 매니페스트는 **이미 존재**.

## 현재 상태 (비표준)

| 항목 | 현재 | 문제 |
|---|---|---|
| openclaw 의존 | `packages/plugin/package.json`에 **선언 없음** | `node_modules/openclaw → references/openclaw` 수동 심볼릭 링크에 의존 |
| import 경로 | `openclaw/plugin-sdk/channel-core` 등 | ✅ 이미 정석, 변경 불필요 |
| 테스트 격리 | `approvals.test.ts`가 `vi.mock(..., importOriginal)`로 **진짜 모듈 로드** | OpenClaw 내부 그래프 전체(→ json5/chalk/typebox/matrix-crypto) 로드 → 로드 실패 |
| `history.test.ts` | `import type`만 사용 | npm openclaw 설치되면 자동 해결 |
| `compat`/`build` 버전 | 없음 | ClawHub 배포 대비 추가 권장 |

현재 git: HEAD `187f58e` (jwks). `references/openclaw`는 untracked (npm install이 재clone).
Phase B 코드 자체는 typecheck clean + 691 테스트 통과 (이 2개 제외).

## 무게 트레이드오프 (사용자 승인 필요)

`openclaw` devDep = ~87MB. 이게 정석이지만 용량이 크다. 대안:
- **A. 정석 (openclaw devDep 설치)** — 가장 표준, 타입/테스트가 진짜 SDK로 검증됨. 87MB.
- **B. 경량 (타입 stub 직접 작성)** — webchannel이 쓰는 타입/함수 시그니처만 자체 `.d.ts`로 선언. 가볍지만 SDK 변경 시 수동 동기화 필요, 비표준.

→ **추천: A (정석).** 단 설치 용량은 사용자 확인.

> **사용자 승인됨 (2026-06-25): A 정석 방향 + openclaw 87MB devDep 설치 동의.** 실행 진행.

## 실행 단계

### Step 0 — 안전망
- [ ] 현재 상태 커밋 확인 (HEAD `187f58e`, working tree 깨끗하게)
- [ ] `references/openclaw`는 건드리지 않음 (사용자가 나중에 옮김)

### Step 1 — openclaw를 정식 의존성으로 선언
- [ ] `packages/plugin/package.json`에 추가:
  ```json
  "peerDependencies":     { "openclaw": ">=2026.6.10" },
  "peerDependenciesMeta": { "openclaw": { "optional": true } },
  "devDependencies":      { ..., "openclaw": "2026.6.10" }
  ```
- [ ] `npm install` → npm `openclaw`가 `node_modules/openclaw`에 설치됨
      (수동 심볼릭 링크 대체). install이 `@types/node` 호이스팅을 또 건드리면 복원.

### Step 2 — 수동 심볼릭 링크 제거
- [ ] npm openclaw 설치로 `node_modules/openclaw`가 **진짜 패키지**가 되므로,
      `references/openclaw`로의 수동 심볼릭 링크는 불필요해짐
- [ ] resolve 경로가 npm 패키지를 가리키는지 확인:
      `node -e "require.resolve('openclaw/plugin-sdk/channel-core')"`

### Step 3 — plugin typecheck 검증
- [ ] `cd packages/plugin && npx tsc --noEmit` → npm openclaw의 `.d.ts`로 resolve되어 통과해야 함
- [ ] 통과하면 vendored dist 불필요 입증

### Step 4 — 테스트 격리 (approvals.test.ts)
- [ ] `vi.mock(..., importOriginal)` → 순수 stub으로 전환
      (실제 함수 동작이 필요하면 npm openclaw에서 import; 안 되면 가짜 구현 주입)
- [ ] 공식 패턴: `plugin-test-api` / per-instance 스텁 참고
- [ ] `history.test.ts`는 타입만이라 별도 작업 불필요 (Step 1으로 해결될 것)

### Step 5 — 전체 검증
- [ ] `npm run typecheck` (saas+plugin+client) clean
- [ ] `npm test` → **693개 (691 + approvals + channel) 전부 통과** 목표
- [ ] AC5 cutover, AC6 device-flow E2E, AC3 realserver 회귀 없음 확인 (sandbox 풀고)

### Step 6 — compat/build 필드 (선택)
- [ ] `package.json` `openclaw` 필드에 `compat`/`build` 추가 (ClawHub 배포 대비)

### Step 7 — references/openclaw 분리 가능 확인
- [ ] `node_modules/openclaw` 심볼릭 링크 없이도 모든 게 통과하면,
      `references/openclaw`는 webchannel과 무관 → 사용자가 옮기거나 삭제 가능

## 리스크 / 주의

1. **npm install이 매번 openclaw 심볼릭 링크 + @types/node 호이스팅을 건드림** — Step 1 이후엔
   openclaw가 정식 의존성이라 링크 문제는 사라져야 함. @types/node는 재설치로 복원.
2. **테스트가 진짜 SDK 함수 동작에 의존** — `approvals.test.ts`의 `importOriginal`이 실제
   `resolveApprovalApprovers` 등을 호출하면, npm openclaw에서 그게 무거운 걸 안 타는지 확인 필요.
   안 타면 그대로 import, 타면 stub.
3. **87MB devDep** — 사용자 승인 받고 진행.
4. **AC1-6 회귀** — 모든 단계 후 전체 테스트로 확인. Phase B 코드는 안 건드림.

## 완료 기준

- [ ] `packages/plugin/package.json`이 openclaw를 peer+devDep로 선언
- [ ] `node_modules/openclaw` 수동 심볼릭 링크 불필요 (npm 패키지로 대체)
- [ ] typecheck clean, 전체 테스트 통과 (approvals/channel 포함)
- [ ] `references/openclaw` 제거해도 webchannel 빌드/테스트 무관함 입증
- [ ] 커밋 + 메모리 갱신
