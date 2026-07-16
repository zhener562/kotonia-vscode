# Kotonia Agent — VS Code extension

## Install (direct download)

Until the Marketplace listing is live, install the VSIX directly.

1. Download `kotonia-agent.vsix` from the
   [latest build release](https://github.com/zhener562/kotonia-vscode/releases/download/latest/kotonia-agent.vsix).
2. In VS Code, open the **Extensions** view (`Cmd`/`Ctrl`+`Shift`+`X`) →
   `⋯` (More Actions) menu → **Install from VSIX…** → pick the file.
   No terminal needed — this works on macOS, Windows, and Linux.

If you have the `code` CLI on PATH (on macOS, enable it via Command Palette →
`Shell Command: Install 'code' command in PATH`), you can instead run:

```bash
code --install-extension kotonia-agent.vsix
```

The engine (`kotonia-cli`) is downloaded automatically on first use; no manual
binary setup is needed for the default (hosted) configuration.

A thin VS Code client over the [`kotonia-cli`](https://github.com/zhener562/kotonia-cli) Rust engine. The engine
does all the work (ReAct loop, tool execution, git-worktree isolation,
approval policy, history); this extension is just a UI that speaks the engine's
JSON stdio protocol (`kotonia-cli --serve`).

## Architecture

```
VS Code (extension host)                     kotonia-cli --serve (child)
┌───────────────────────────┐                ┌──────────────────────────┐
│ extension.ts  (lifecycle)  │ ── stdin ───▶  │ stdin reader → turn/appr │
│ engine.ts     (spawn+JSONL)│ ◀─ stdout ───  │ JsonSink (events)        │
│ panel.ts      (webview)    │                │ JsonApproval             │
│ React webview (render UI)  │                │ agent loop               │
└───────────────────────────┘                └──────────────────────────┘
```

Protocol wire types live in [`src/protocol.ts`](https://github.com/zhener562/kotonia-vscode/blob/main/src/protocol.ts),
mirroring the Rust side (`serve.rs` + the `Event` enum) in the separate
[`kotonia-cli`](https://github.com/zhener562/kotonia-cli) repository. Protocol
v2 adds history snapshots and typed editor context; incompatible engine
versions are rejected instead of partially working.

### Relationship to kotonia-desktop

`kotonia-desktop` links `kotonia-cli` as a Rust path dependency and drives
`DispatchAgent` in-process. VS Code extensions run on a TypeScript/Node
extension host, so this extension still needs a process boundary (`--serve`) or
a native addon. The target architecture is therefore:

- keep the ReAct engine, provider resolution, worktree setup, history, approval
  policy, and login helpers in the `kotonia-cli` library;
- keep `kotonia-cli --serve` as the thin helper binary for VS Code;
- avoid reimplementing engine assembly in TypeScript. The extension should only
  spawn/configure the helper and render the protocol.

If CLI and desktop drift, factor the shared setup into a library builder first,
then have `main.rs`, `kotonia-desktop`, and `serve` call that same builder.

## Where things run (important)

The engine needs `bash`, `git`, and (for local models) the LLM servers — all on
Linux. The Windows dev machine can't build native Rust (Smart App Control). So
run VS Code **connected to Linux**:

- **Remote-SSH** to the GPU box (production-like: local models reachable), or
- **Remote-WSL** locally (use a hosted model: `kotonia-gemma4-26b` + API key).

The extension host — and therefore the spawned engine — runs on that remote.
`kotonia.enginePath` resolves there.

## Setup

1. Build the engine on the target host: `cargo build` in the repo root →
   `target/debug/kotonia-cli`.
2. In this repository, run `npm ci && npm run compile`.
3. Point `kotonia.enginePath` at the binary (e.g.
   `${workspaceFolder}/target/debug/kotonia-cli`, or leave `kotonia-cli` if on PATH).
4. For hosted models, run **Kotonia: Login**. The shared
   `~/.kotonia/daemon.json` credential is also used by CLI and desktop.
5. **Kotonia: New Chat** — the panel starts the engine and shows the handshake.

Dev-run the extension: open this folder in VS Code and press **F5** (Extension
Development Host).

## Settings

| Setting | Default | Notes |
|---|---|---|
| `kotonia.enginePath` | `kotonia-cli` | Engine binary (supports `${workspaceFolder}`). |
| `kotonia.model` | `kotonia-gemma4-26b` | Hosted (GPU-free) default. |
| `kotonia.approvalMode` | `allowlist` | `all` / `allowlist` / `auto`. |
| `kotonia.workspaceMode` | `in-place` | `in-place` (live editor changes) or preserved isolated `worktree`. |
| `kotonia.extraArgs` | `[]` | Extra engine CLI args. |

## Current capabilities

- session list/resume with clean user/assistant history restoration;
- active file, selection, visible-file, and diagnostic context sent to CLI;
- in-place coding by default, or preserved/re-attached worktrees with
  diff review and apply actions;
- clickable Unicode/Windows paths, `file:line` jumps, URLs in VS Code's
  Simple Browser, and local HTML preview;
- collapsible long tool output and session-scoped remembered approvals;
- shared CLI login/logout validation and a dedicated Eve Code coding persona;
- optional talking avatar where one character-selection action enables the
  display, voice, and speaking style.
