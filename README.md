# ⬢ HiveDesk

**내 PC에 설치된 AI 코딩 CLI 여러 개를 하나의 팀처럼 돌리는 데스크톱 앱.**
Claude Code · OpenAI Codex · Antigravity(agy) · Gemini CLI를 각자 **자기 계정(무료·구독)** 으로 연결해서
칸반 보드로 일을 나누고, 공유 메모리와 메시지함으로 서로 맥락을 넘기고, 위험한 작업은 사람이 승인해요.

> API 키를 쓰지 않아요. HiveDesk는 이미 로그인된 CLI를 대신 실행할 뿐이라 **추가 API 요금이 나가지 않아요.**

[Munder Difflin](https://github.com/HarnessMD/munder-difflin)의 아이디어에서 영감을 받아, 작은 팀이 쓰기 쉬운 크기로 새로 만든 프로젝트예요.

---

## 주요 기능

| 기능 | 설명 |
|---|---|
| **여러 에이전트** | 에이전트마다 사용할 AI, 역할, 작업 폴더, 모델을 정해요. 한 사람이 여러 개를 둘 수 있어요. |
| **칸반 태스크 보드** | 할 일 → 승인 대기 → 실행 중 → 완료 / 실패. 선행 태스크를 지정하면 앞 태스크 결과가 다음 에이전트에게 넘어가요. |
| **자동 실행** | 켜 두면 내 에이전트에게 배정된 준비된 태스크를 차례로 실행해요 (동시 실행 수 제한). |
| **메시지함** | 사람이나 에이전트가 특정 에이전트에게 메시지를 남기면, 그 에이전트의 다음 실행 때 전달돼요. |
| **공유 메모리** | "패키지 매니저는 pnpm" 같은 팀 규칙을 적어 두면 모든 에이전트가 매번 함께 읽어요. 에이전트도 스스로 기록해요. |
| **승인 큐** | 위험 표시된 태스크, 예산 초과, 에이전트가 직접 멈추고 물어본 일은 사람이 승인/거절해요. |
| **예산 제한** | 에이전트별 하루 실행 횟수·실행 시간·1회 제한 시간. 구독 사용량을 순식간에 다 써 버리는 걸 막아요. |
| **팀 공유 (선택)** | 작업공간을 GitHub 비공개 저장소로 동기화하면 팀원끼리 같은 보드를 봐요. 서버가 필요 없어요. |

## 어떻게 동작하나요?

```
 [태스크 보드] ──배정──▶ [에이전트: 백엔드 (Claude Code)]
       ▲                         │  claude -p  ← 프롬프트(역할+태스크+메모리+메시지)를 stdin으로
       │                         ▼
   결과·메모리·메시지 ◀── 출력 파싱: [[MEMORY: …]] [[MSG to=…: …]] [[APPROVAL: …]]
```

- 작업공간(hive)은 평범한 폴더예요. 태스크·메시지·메모리·승인이 **항목당 JSON 파일 하나**로 저장돼서 git으로 합칠 때 충돌이 적어요.
- 에이전트는 실행할 때마다 역할, 태스크 내용, 선행 태스크 결과, 최근 공유 메모리, 안 읽은 메시지를 받아요.
- 에이전트가 답 끝에 아래 줄을 쓰면 HiveDesk가 알아서 처리해요.
  - `[[MEMORY: 팀이 기억할 사실]]` → 공유 메모리에 기록
  - `[[MSG to=팀원에이전트ID: 내용]]` → 그 에이전트의 메시지함으로
  - `[[APPROVAL: 이유]]` → 작업을 멈추고 승인 큐로

## 설치

1. [Releases](https://github.com/TatoGames/Hive-Desk/releases)에서 운영체제에 맞는 파일을 받아요.
   - macOS: `.dmg` (Apple Silicon은 arm64, Intel은 x64)
   - Windows: `.exe`
   - Linux: `.AppImage`
2. 아래 AI CLI 중 **쓰고 싶은 것만** 설치하고 한 번 로그인해 두세요.

| AI | 설치 | 로그인 (API 키 없이) |
|---|---|---|
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude` 실행 → Claude Pro/Max 계정 로그인 |
| OpenAI Codex | `npm i -g @openai/codex` | `codex login` → *Sign in with ChatGPT* |
| Antigravity (agy) | Antigravity CLI 설치 안내 참고 | `agy` 실행 → Google 계정 로그인 (무료 계정 가능) |
| Gemini CLI | `npm i -g @google/gemini-cli` | Google 로그인. **2026-06-18부터 무료·AI Pro·Ultra 개인 계정은 agy로 이전**되어, Gemini CLI는 Code Assist 라이선스·Vertex·API 키가 있을 때만 써요 |
| 기타 | 직접 지정 | stdin으로 프롬프트를 받아 stdout으로 답하는 CLI면 무엇이든 (예: `ollama run llama3`) |

> **API 요금 방지:** 설정의 *API 키 환경변수 숨기기*(기본 켜짐)는 `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` 등을
> CLI 실행 환경에서 빼서, CLI가 API 과금 대신 로그인한 계정을 쓰게 해요.
> Claude Code의 추가 인자에 `--bare`를 넣지 마세요. bare 모드는 구독 로그인을 무시해요.

### macOS에서 '손상된 앱' 경고가 뜰 때

아직 Apple 코드 서명을 하지 않아서 생기는 경고예요. 앱을 `응용 프로그램` 폴더로 옮긴 뒤 터미널에서 한 번 실행하세요.

```bash
xattr -cr /Applications/HiveDesk.app
```

Windows에서 SmartScreen 경고가 뜨면 *추가 정보 → 실행*을 누르세요.

## 처음 사용하기

1. 앱을 열고 **이름**과 **작업공간 폴더**를 정해요.
2. **에이전트** 탭에서 *이 PC에 설치된 AI CLI* 목록을 확인하고 *+ 에이전트 추가*를 눌러요.
   역할(예: "Unity C# 게임플레이 담당")과 작업 폴더(프로젝트 폴더)를 지정해요.
3. *테스트* 버튼으로 연결을 확인해요. 보드에 `연결 테스트` 태스크가 생기고 결과가 나와요.
4. **태스크 보드**에서 태스크를 만들고 담당 에이전트를 고른 뒤 *실행*하거나, *자동 실행*을 켜요.

### 권한 기본값

| AI | 기본 추가 인자 | 의미 |
|---|---|---|
| Claude Code | `--permission-mode acceptEdits` | 작업 폴더 안 파일 수정은 허용, 그 밖의 셸 명령 등은 거부 |
| Codex | `--sandbox workspace-write` | 작업 폴더 안에서만 쓰기 허용 |

더 넓은 권한이 필요하면 에이전트 설정의 *추가 인자*에서 바꿀 수 있어요. 그럴 때는 *모든 태스크 실행 전 승인 받기*를 함께 켜 두는 걸 권해요.

## 팀으로 쓰기

각자 **자기 PC에서 자기 AI 계정**으로 에이전트를 돌리고, 보드·메시지·메모리만 GitHub 비공개 저장소로 공유해요.

1. 팀장이 GitHub에 **비공개** 저장소를 하나 만들어요 (예: `our-hive`). 팀원을 collaborator로 초대해요.
2. 각자 설정 → *팀 공유*에 같은 저장소 주소를 넣고 *공유 켜기* → *지금 동기화*.
   (PC에 git이 설치되어 있고, GitHub 로그인(credential)이 되어 있어야 해요.)
3. 이제 팀원의 에이전트가 담당자 목록에 보여요. 팀원 에이전트에게 배정한 태스크는 **그 팀원의 PC에서** 실행돼요.
4. *자동 동기화 간격*을 정하면 주기적으로 주고받아요.

공유되지 않는 것: 각자의 에이전트 설정(작업 폴더, 인자), AI 계정, 오늘 사용량(`.local/` 폴더).

두 사람이 같은 태스크를 동시에 고치면 충돌이 날 수 있어요. 이때 HiveDesk는 동기화를 취소하고 알려 주니, 작업공간 폴더에서 git으로 해결한 뒤 다시 동기화하세요.

## 개발

```bash
git clone https://github.com/TatoGames/Hive-Desk.git
cd Hive-Desk
npm install
npm run dev        # 개발 모드로 실행
npm test           # 핵심 로직 테스트 (가짜 CLI 사용)
npm run typecheck
npm run dist       # 내 OS용 설치 파일을 release/ 폴더에 생성
```

필요: Node.js 18 이상(권장 22), git.

### 폴더 구조

```
src/
  main/        Electron 메인 프로세스
    hive.ts      작업공간 파일 저장소 (태스크/승인/메시지/메모리/사용량)
    adapters.ts  AI CLI 어댑터 (명령 구성, 실행, 설치 확인, API 키 제거)
    runner.ts    태스크 1건 실행: 승인 → 예산 → CLI → 출력 파싱 → 기록
    engine.ts    설정, 자동 실행, 동기화 타이머
    sync.ts      git 기반 팀 공유
  preload/     렌더러에 안전한 API(window.hive)만 노출
  renderer/    React UI (보드, 에이전트, 메시지·메모리, 승인, 설정)
  shared/      공용 타입
test/          vitest 테스트 + 가짜 CLI
```

### 새 버전 배포하기

1. `package.json`의 `version`을 올려요 (예: `0.2.0`).
2. 커밋 후 같은 버전의 태그를 푸시해요.
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
3. GitHub Actions(`Release` 워크플로)가 macOS·Windows·Linux 설치 파일을 만들어 Releases에 올려요.

## 한계와 계획

- 에이전트는 태스크마다 한 번 실행되는 비대화형 모드로 돌아가요. 실행 중 대화형 입력은 아직 지원하지 않아요.
- 앱 자동 업데이트, 코드 서명, 영어 UI는 아직 없어요.
- 구독 요금제의 사용량 한도는 각 서비스가 관리해요. HiveDesk 예산은 그 위에 거는 추가 안전장치예요.

## 라이선스

[MIT](LICENSE)
