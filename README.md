# Kotonia Agent — VS Code extension

## Install (direct download)

Until the Marketplace listing is live, install the VSIX directly:

1. Download `kotonia-agent.vsix` from the
   [latest release](https://github.com/zhener562/kotonia-vscode/releases/latest).
2. Install it, either from the command line:
   ```bash
   code --install-extension kotonia-agent.vsix
   ```
   or in VS Code: **Extensions** view → `⋯` menu → **Install from VSIX…**.

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
│ media/main.js (render UI)  │                │ agent loop (untouched)   │
└───────────────────────────┘                └──────────────────────────┘
```

Protocol wire types live in [`src/protocol.ts`](https://github.com/zhener562/kotonia-vscode/blob/main/src/protocol.ts),
mirroring the Rust side (`serve.rs` + the `Event` enum) in the
[`kotonia-cli`](https://github.com/zhener562/kotonia-cli) monorepo, which keeps
both in lockstep.

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
2. `cd vscode-extension && npm install && npm run compile`.
3. Point `kotonia.enginePath` at the binary (e.g.
   `${workspaceFolder}/target/debug/kotonia-cli`, or leave `kotonia-cli` if on PATH).
4. For hosted models, run **Kotonia: Set Kotonia API Key** (stored in
   VS Code SecretStorage, injected as `KOTONIA_API_KEY` into the engine).
5. **Kotonia: Open Agent** — the panel starts the engine and shows the handshake.

Dev-run the extension: open this folder in VS Code and press **F5** (Extension
Development Host).

## Settings

| Setting | Default | Notes |
|---|---|---|
| `kotonia.enginePath` | `kotonia-cli` | Engine binary (supports `${workspaceFolder}`). |
| `kotonia.model` | `kotonia-gemma4-26b` | Hosted (GPU-free) default. |
| `kotonia.approvalMode` | `allowlist` | `all` / `allowlist` / `auto`. |
| `kotonia.workspaceMode` | `worktree` | `worktree` (isolated) or `in-place`. |
| `kotonia.extraArgs` | `[]` | Extra engine CLI args. |

## Status (Phase 2)

Done: engine spawn + env injection, JSONL parsing, event rendering, inline
approval UI, cancel, editor-selection context in `user_turn`, protocol-version
check, crash → restart.

Not yet (Phase 3): worktree diff view + Merge button, `file:line` jump, session
list / resume UI, token streaming. The `remember` approval flag is sent but
session-scoped auto-approve memory is not yet applied on the extension side.
