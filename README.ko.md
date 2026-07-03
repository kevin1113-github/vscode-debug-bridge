# VSCode Debug Bridge

[English](README.md) | 한국어

AI 에이전트(Claude Code / Codex / Cline / MCP 클라이언트)가 **VSCode 단계별 디버깅을 직접 조작**할 수 있게 해주는 브리지입니다. 브레이크포인트 설정, attach, step, 콜스택 확인, 변수 읽기, 표현식 평가를 MCP 도구 호출로 수행할 수 있습니다.

이 브리지는 **디버거에 종속되지 않습니다**. VSCode에서 이미 활성화된 디버그 어댑터로 명령을 전달하므로 Unity(`vstuc`), Python(`debugpy`), Node, C++(`cppdbg`), Go(`dlv`) 등에서 동작합니다. 브리지는 디버그 프로토콜을 다시 구현하지 않습니다.

> Unity C# 디버깅 중심의 상세 사용법, 개념 정리, FAQ는 [`사용법.md`](사용법.md)를 참고하세요.

```text
에이전트 ──MCP(stdio)──> mcp/server.js ──HTTP(127.0.0.1:39517)──> extension ──vscode.debug──> 활성 DAP 세션
```

## 여러 프로젝트에서 동작하는 이유

- **확장은 워크스페이스와 언어에 독립적입니다.** 모든 디버그 세션(`registerDebugAdapterTrackerFactory("*")`)과 실행 중인 VSCode 창의 기본 워크스페이스 폴더를 추적합니다. 한 번 전역 설치하면 각 프로젝트와 창에서 브리지를 노출합니다.
- **MCP 서버는 표준 MCP stdio 서버입니다.** MCP를 지원하는 모든 에이전트가 등록할 수 있습니다. MCP를 쓰지 않는 도구는 HTTP API를 직접 호출할 수 있습니다.

## 설치

> 구성 요소는 두 가지입니다. **VSCode 확장**은 머신당 한 번 설치하고, **MCP 서버**는 프로젝트별로 등록하며 GitHub에서 `npx`로 바로 실행합니다.

### 1. VSCode 확장 설치

**옵션 A — 릴리스 `.vsix`에서 설치**:

- 저장소의 **Releases**에서 `vscode-debug-bridge-X.Y.Z.vsix`를 내려받은 뒤 실행합니다.

```bash
code --install-extension vscode-debug-bridge-X.Y.Z.vsix
```

**옵션 B — 소스에서 빌드**:

```bash
git clone https://github.com/kevin1113-github/vscode-debug-bridge
cd vscode-debug-bridge/extension
npx --yes @vscode/vsce package
code --install-extension vscode-debug-bridge-*.vsix
```

VSCode를 다시 로드한 뒤 명령 팔레트에서 **"Debug Bridge: Show Status"**를 실행해 확인합니다. 확장은 워크스페이스에 독립적이므로 모든 창에서 브리지를 노출합니다.

### 2. MCP 서버 등록

저장소 루트는 `npx`로 실행 가능한 패키지입니다. 에이전트는 GitHub에서 바로 실행할 수 있으므로 로컬 clone이나 절대 경로가 필요 없습니다.

**Claude Code** (프로젝트별 등록, 멀티 창에 권장):

```bash
claude mcp add --scope project vscode-debug-bridge \
  --env DEBUG_BRIDGE_PORT=39517 \
  -- npx -y github:kevin1113-github/vscode-debug-bridge
```

전역 단일 등록만 필요하면 `--scope user`를 사용할 수 있습니다. 단, 한 포트만 사용합니다.

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.vscode-debug-bridge]
command = "npx"
args = ["-y", "github:kevin1113-github/vscode-debug-bridge"]
env = { DEBUG_BRIDGE_PORT = "39517" }
```

**그 밖의 MCP 클라이언트**는 같은 `npx -y github:kevin1113-github/vscode-debug-bridge` 명령을 사용합니다.

**MCP를 쓰지 않는 스크립트**는 HTTP API를 직접 호출할 수 있습니다.

```bash
curl -X POST 127.0.0.1:39517/control -d '{"command":"stepOver"}'
```

> 버전을 고정하려면 `github:kevin1113-github/vscode-debug-bridge#v0.1.0`처럼 태그를 붙이세요. 나중에 npm에 배포한다면 `npx -y vscode-debug-bridge-mcp`처럼 GitHub prefix 없이 사용할 수 있습니다.

### Maintainer — 릴리스 만들기

1. 루트 `package.json`과 `extension/package.json`의 `version`을 올립니다.
2. 확장을 빌드합니다: `cd extension && npx --yes @vscode/vsce package`
3. 커밋에 태그를 붙이고 GitHub **Release**에 `.vsix`를 첨부합니다.
4. `npx github:kevin1113-github/vscode-debug-bridge`는 기본 브랜치의 HEAD를 실행합니다. 사용자가 버전을 고정할 수 있도록 태그를 제공합니다.

## 프로젝트별 사용

확장을 전역 설치했다면 프로젝트별 추가 설정은 필요 없습니다. 각 프로젝트에서는 해당 프로젝트의 launch 설정 이름만 `debug_attach`에 넘기면 됩니다.

- Unity: `debug_attach { config: "Attach to Unity" }`
- Python: `debug_attach { config: "Python: Current File" }`

## 일반적인 에이전트 루프

1. `debug_attach { config }` — 세션 시작
2. `debug_set_breakpoint { file, line }` — 절대 경로로 브레이크포인트 설정
3. 코드 경로 트리거(예: Unity Play 모드)
4. `debug_status` — `stopped: true`가 될 때까지 확인
5. `debug_stack` / `debug_variables` / `debug_evaluate` — 상태 검사
6. `debug_step_over` / `debug_step_in` / `debug_step_out` / `debug_continue` — 실행 제어
7. 완료 후 `debug_detach`

## 도구

| 도구 | 목적 |
|------|------|
| `debug_status` | 세션, 정지 상태, 스레드, 브레이크포인트 요약 |
| `debug_attach` | 이름으로 launch 설정 실행 |
| `debug_detach` | 세션 종료 |
| `debug_set_breakpoint` | 브레이크포인트 추가, 조건식 선택 가능 |
| `debug_list_breakpoints` | 브레이크포인트 목록 조회 |
| `debug_clear_breakpoints` | 특정 파일 또는 전체 브레이크포인트 제거 |
| `debug_continue` / `debug_step_over` / `debug_step_in` / `debug_step_out` / `debug_pause` | 실행 제어 |
| `debug_stack` | 현재 콜스택, 정지 상태에서 사용 |
| `debug_variables` | 프레임의 로컬 변수와 스코프 조회 |
| `debug_expand` | 구조화된 변수 펼치기 |
| `debug_evaluate` | 프레임에서 표현식 평가 |

## 여러 프로젝트를 동시에 사용할 때

HTTP 서버는 단일 포트에 바인딩합니다. 기본 포트는 `39517`입니다. 여러 VSCode 창을 동시에 열면 먼저 열린 창만 해당 포트를 차지합니다. 동시에 여러 프로젝트를 디버깅하려면 프로젝트마다 포트를 다르게 지정하세요.

- VSCode 워크스페이스 설정(`.vscode/settings.json`): `"debugBridge.port": 39518`
- 해당 프로젝트의 MCP 환경 변수도 동일하게 설정: `DEBUG_BRIDGE_PORT=39518`

한 번에 한 프로젝트만 디버깅한다면 기본 포트로 충분합니다.

## 제한 사항

- 브리지는 대상 프로그램을 직접 실행 상태로 만들 수 없습니다. 예를 들어 Unity Play 모드는 직접 켜거나 UnityMCP `manage_editor`로 켜야 합니다.
- step 명령은 `stopped: true`일 때만 동작합니다. 먼저 `debug_status`를 확인하세요.
- `127.0.0.1`에만 바인딩하며 외부에 노출하지 않습니다.
- 한 번에 하나의 활성 세션만 추적합니다. VSCode의 `activeDebugSession`을 사용합니다.
