# VSCode Debug Bridge

[English](README.md) | [한국어](README.ko.md)

Lets any AI agent (Claude Code / Codex / Cline / any MCP client) **drive VSCode
step debugging** — set breakpoints, attach, step, inspect the call stack, read
variables, evaluate expressions — through MCP tool calls.

It is **debugger-agnostic**: it forwards to whatever debug adapter VSCode already
has active, so it works for Unity (`vstuc`), Python (`debugpy`), Node, C++
(`cppdbg`), Go (`dlv`), etc. The bridge never reimplements a debug protocol.

> 🇰🇷 Korean README: [`README.ko.md`](README.ko.md). Unity-focused Korean usage guide / concepts / FAQ: [`사용법.md`](사용법.md).

```text
Agent ──MCP(stdio)──> mcp/server.js ──HTTP(127.0.0.1:39517)──> extension ──vscode.debug──> active DAP session
```

## Why it works across projects

- **The extension is workspace- and language-independent.** It hooks every debug
  session (`registerDebugAdapterTrackerFactory("*")`) and the primary workspace
  folder of whatever window it runs in. Install it **once, globally**, and every
  project/window gets it.
- **The MCP server is a standard MCP stdio server.** Any MCP-capable agent can
  register it. Non-MCP tools can hit the HTTP API directly.

## Install (public, from GitHub)

> Two pieces: the **VSCode extension** (install once per machine) and the
> **MCP server** (registered per project, runs straight from GitHub via `npx`).

### 1. Install the VSCode extension (once per machine)

**Option A — from a release `.vsix`** (no build):
- Download `vscode-debug-bridge-X.Y.Z.vsix` from the repo's **Releases**, then:
  ```bash
  code --install-extension vscode-debug-bridge-X.Y.Z.vsix
  ```

**Option B — build from source**:
```bash
git clone https://github.com/kevin1113-github/vscode-debug-bridge
cd vscode-debug-bridge/extension
npx --yes @vscode/vsce package
code --install-extension vscode-debug-bridge-*.vsix
```

Reload VSCode → command palette → **"Debug Bridge: Show Status"** to confirm.
The extension is workspace-independent: every window exposes the bridge.

### 2. Register the MCP server — no clone, no absolute path

The repo root is an `npx`-runnable package, so agents launch it **straight from
GitHub**. Nothing machine-specific:

**Claude Code** (per-project — recommended for multi-window safety):
```bash
claude mcp add --scope project vscode-debug-bridge \
  --env DEBUG_BRIDGE_PORT=39517 \
  -- npx -y github:kevin1113-github/vscode-debug-bridge
```
(or `--scope user` for a single global registration; one port only)

**Codex** — `~/.codex/config.toml`:
```toml
[mcp_servers.vscode-debug-bridge]
command = "npx"
args = ["-y", "github:kevin1113-github/vscode-debug-bridge"]
env = { DEBUG_BRIDGE_PORT = "39517" }
```

**Other MCP clients** — same `npx -y github:kevin1113-github/vscode-debug-bridge` command.

**Non-MCP / scripts** — call the HTTP API directly, e.g.
`curl -X POST 127.0.0.1:39517/control -d '{"command":"stepOver"}'`.

> Pin a version with `github:kevin1113-github/vscode-debug-bridge#v0.1.0`.
> If you later publish to npm, drop the prefix: `npx -y vscode-debug-bridge-mcp`.

### Maintainer — cutting a release

1. Bump `version` in root `package.json` and `extension/package.json`.
2. Build the extension: `cd extension && npx --yes @vscode/vsce package`.
3. Tag the commit and attach the `.vsix` to a GitHub **Release**.
4. `npx github:kevin1113-github/vscode-debug-bridge` runs the default branch HEAD; tags let users pin.

## Per-project use

Nothing project-specific is needed once installed globally. In each project you
only pass that project's launch-config name to `debug_attach`:

- Unity: `debug_attach { config: "Attach to Unity" }`
- Python: `debug_attach { config: "Python: Current File" }`

## Typical agent loop

1. `debug_attach { config }` — start the session.
2. `debug_set_breakpoint { file, line }` — absolute path.
3. Trigger the code path (e.g. Unity Play mode).
4. `debug_status` — poll until `stopped: true`.
5. `debug_stack` / `debug_variables` / `debug_evaluate` — inspect.
6. `debug_step_over` / `step_in` / `step_out` / `continue` — drive.
7. `debug_detach` when done.

## Tools

| Tool | Purpose |
|------|---------|
| `debug_status` | Session/stopped/thread/breakpoint summary |
| `debug_attach` | Launch a config by name |
| `debug_detach` | Stop the session |
| `debug_set_breakpoint` | Add a (optionally conditional) breakpoint |
| `debug_list_breakpoints` | List breakpoints |
| `debug_clear_breakpoints` | Clear one file's or all breakpoints |
| `debug_continue` / `step_over` / `step_in` / `step_out` / `pause` | Execution control |
| `debug_stack` | Current call stack (when stopped) |
| `debug_variables` | Locals/scopes for a frame |
| `debug_expand` | Expand a structured variable |
| `debug_evaluate` | Evaluate an expression in a frame |

## Multiple projects at once → use distinct ports

The HTTP server binds a single port (default `39517`). If you open **several VSCode
windows simultaneously**, only the first grabs the port. For concurrent debugging,
give each project a distinct port:

- VSCode setting (workspace `.vscode/settings.json`): `"debugBridge.port": 39518`
- And match the MCP env for that project: `DEBUG_BRIDGE_PORT=39518`

If you only debug one project at a time, the default is fine.

## Limitations

- The bridge cannot make the target program *start running* (e.g. enter Unity Play
  mode) — trigger that yourself, or via UnityMCP `manage_editor` for Unity.
- Stepping only works while `stopped: true`. Check `debug_status` first.
- Binds to `127.0.0.1` only; no external exposure.
- Tracks one active session at a time (VSCode `activeDebugSession`).
