// Extension entry point. Layout (Claude-Code-style):
//   - Sidebar "Sessions" tree = history / session management.
//   - Editor-area panel = the live chat (conversation + avatar + input).
// The engine's events flow to the chat panel only; the sidebar just lists
// on-disk sessions and resumes them into the panel.

import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as https from "https";
import { execFile, spawn } from "child_process";
import { KotoniaEngine } from "./engine";
import { ChatPanel } from "./panel";
import { AvatarPanel } from "./avatarPanel";
import { SessionTreeProvider } from "./sessionTree";
import { PanelAction } from "./webview";
import { EditorContext, Hello, Outbound } from "./protocol";

const SECRET_KOTONIA = "kotonia.apiKey";
const SECRET_DEEPSEEK = "kotonia.deepseekKey";
const SELECTION_CAP = 12_000;
const DIAGNOSTIC_CAP = 20;
const VISIBLE_FILE_CAP = 12;

interface EngineState {
  engine: KotoniaEngine;
  hello?: Hello;
  remembered: Set<string>;
  lastTurnId: number;
  greeted: boolean;
}

let chatPanel: ChatPanel | undefined;
let avatarPanel: AvatarPanel | undefined;
let engineState: EngineState | undefined;
let sessionTree: SessionTreeProvider;
let output: vscode.OutputChannel;
let extContext: vscode.ExtensionContext;
let speakAbort: AbortController | undefined;
let authKnownInvalid = false;

/** Post to the chat panel (the only chat surface). No-op if it's closed. */
const ui = {
  postEngineMessage(m: Outbound): void {
    chatPanel?.postEngineMessage(m);
  },
  note(text: string, turnId?: number): void {
    chatPanel?.note(text, turnId);
  },
  setBusy(busy: boolean): void {
    chatPanel?.setBusy(busy);
  },
  reset(): void {
    chatPanel?.reset();
  },
  avatarBegin(): void {
    ensureAvatarPanel();
    avatarPanel?.begin();
  },
  avatarChunk(chunkType: number, data: string): void {
    avatarPanel?.chunk(chunkType, data);
  },
  avatarEnd(): void {
    avatarPanel?.end();
  },
  avatarStop(): void {
    avatarPanel?.stop();
  },
};

let helpPanel: vscode.WebviewPanel | undefined;

/** Open a read-only help panel listing every toolbar button, … menu action,
 * and key setting, with what each does. */
function showHelp(): void {
  if (helpPanel) {
    helpPanel.reveal();
    return;
  }
  helpPanel = vscode.window.createWebviewPanel(
    "kotoniaHelp",
    "Kotonia ヘルプ",
    vscode.ViewColumn.Active,
    { enableScripts: false, retainContextWhenHidden: true },
  );
  helpPanel.iconPath = vscode.Uri.joinPath(extContext.extensionUri, "media", "icon.png");
  helpPanel.webview.html = HELP_HTML;
  helpPanel.onDidDispose(() => {
    helpPanel = undefined;
  });
}

const HELP_HTML = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); padding: 18px 24px; line-height: 1.7; }
  h1 { font-size: 1.4em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; }
  h2 { font-size: 1.12em; margin-top: 1.6em; color: var(--vscode-foreground); }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 4px; }
  th, td { text-align: left; vertical-align: top; padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border); }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; white-space: nowrap; }
  td.k { white-space: nowrap; font-weight: 600; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
  .dim { color: var(--vscode-descriptionForeground); }
  .icon { font-family: var(--vscode-editor-font-family, monospace); }
</style></head>
<body>
  <h1>🔥 Kotonia Agent — 機能ヘルプ</h1>
  <p class="dim">左サイドバー「セッション」ビューのタイトルバー（アイコンボタン）と「…」メニューの各機能です。</p>

  <h2>ツールバー（アイコンボタン・よく使う）</h2>
  <table>
    <tr><th>ボタン</th><th>できること</th></tr>
    <tr><td class="k"><span class="icon">＋</span> 新規チャット</td><td>新しいセッション（エンジン）を開始して中央のチャットを開く。</td></tr>
    <tr><td class="k"><span class="icon">⟳</span> 更新</td><td>左のセッション一覧を再読み込み。</td></tr>
    <tr><td class="k"><span class="icon">▷</span> モデルを選択</td><td>使う LLM を切替（<code>kotonia-gemma4-26b</code> / <code>deepseek-chat</code> / ローカル / カスタム）。反映は新規チャットから。</td></tr>
    <tr><td class="k"><span class="icon">☺</span> アバターを選択</td><td>ことな / ひなた を名前で選択すると、<b>表示・声・話し方</b>を一度に有効化。カスタムで任意の avatar_id も可。</td></tr>
    <tr><td class="k"><span class="icon">⇥</span> ログイン / ログアウト</td><td>kotonia.ai にデバイスログイン（ブラウザで承認）。ログイン中は「ログアウト」表示。ホストモデルはこれだけで使える。</td></tr>
  </table>

  <h2>「…」メニュー（あまり使わない）</h2>
  <table>
    <tr><th>項目</th><th>できること</th></tr>
    <tr><td class="k">ヘルプ（機能一覧）</td><td>この画面。</td></tr>
    <tr><td class="k">アバターパネルを表示</td><td>喋るアバターの専用パネルを開く。<b>ドラッグで移動・境界で拡縮</b>、タブ右クリック →「エディターを新しいウィンドウに移動」で<b>VS Code の外に浮かせられる</b>。通常は発話時に自動で開く。</td></tr>
    <tr><td class="k">アバターON/OFF</td><td>喋るリップシンクアバターの有効／無効。OFF でテキストのみ。</td></tr>
    <tr><td class="k">エージェントの変更を確認</td><td><code>worktree</code> モード時、エージェントが加えた変更の git 差分を表示。</td></tr>
    <tr><td class="k">変更をワークスペースに適用</td><td>worktree の変更を実際の作業コピーへ取り込む（確認あり）。</td></tr>
    <tr><td class="k">DeepSeek API キーを設定</td><td><code>deepseek-*</code> モデルを使う時の鍵を保存。Kotonia モデルはログインのみでOK。</td></tr>
  </table>

  <h2>入力欄</h2>
  <p><b>Enter</b> で送信 / <b>Shift+Enter</b> で改行（日本語変換中の Enter は確定のみで送信されません）。承認が必要なコマンドはチャット内にボタンで出ます（「remember」で同種を今セッション自動承認）。</p>

  <h2>主な設定（<code>settings.json</code> / 設定UI で <code>kotonia.</code> 検索）</h2>
  <table>
    <tr><th>設定</th><th>意味</th></tr>
    <tr><td class="k">kotonia.model</td><td>使用モデル。</td></tr>
    <tr><td class="k">kotonia.avatar.character</td><td>アバター（ことな / ひなた / 任意 avatar_id）。</td></tr>
    <tr><td class="k">kotonia.avatar.persona</td><td>Eve Codeの実装方針を保ったまま、選んだキャラの話し方を重ねるか（既定 ON）。</td></tr>
    <tr><td class="k">kotonia.avatar.enabled</td><td>喋るアバターの ON/OFF。</td></tr>
    <tr><td class="k">kotonia.language</td><td>既定の回答言語（<code>ja</code> など）。</td></tr>
    <tr><td class="k">kotonia.workspaceMode</td><td><code>in-place</code>（既定・直接編集）か、再起動後も保持される <code>worktree</code>（隔離・要レビュー）。</td></tr>
    <tr><td class="k">kotonia.approvalMode</td><td>コマンド承認の厳しさ（<code>all</code> / <code>allowlist</code> / <code>auto</code>）。</td></tr>
  </table>
</body></html>`;

/** Open the dedicated avatar panel if it isn't already up. It lives in the
 * editor area so the user can move / resize / float it (Move Editor into New
 * Window) independently of the chat. */
function ensureAvatarPanel(): void {
  if (avatarPanel) {
    return;
  }
  avatarPanel = new AvatarPanel(extContext.extensionUri, () => {
    avatarPanel = undefined;
  });
}

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  output = vscode.window.createOutputChannel("Kotonia Agent");
  context.subscriptions.push(output);

  sessionTree = new SessionTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("kotonia.sessions", sessionTree),
    vscode.commands.registerCommand("kotonia.start", () => newChat()),
    vscode.commands.registerCommand("kotonia.newChat", () => newChat()),
    vscode.commands.registerCommand("kotonia.openSession", (id: string) => openSession(id)),
    vscode.commands.registerCommand("kotonia.refreshSessions", () => sessionTree.refresh()),
    vscode.commands.registerCommand("kotonia.login", () => runLogin()),
    vscode.commands.registerCommand("kotonia.logout", () => logout()),
    vscode.commands.registerCommand("kotonia.selectModel", () => selectModel()),
    vscode.commands.registerCommand("kotonia.toggleAvatar", () => toggleAvatar()),
    vscode.commands.registerCommand("kotonia.selectAvatar", () => selectAvatar()),
    vscode.commands.registerCommand("kotonia.showAvatar", async () => {
      await vscode.workspace
        .getConfiguration("kotonia")
        .update("avatar.enabled", true, vscode.ConfigurationTarget.Workspace);
      ensureAvatarPanel();
      avatarPanel?.reveal();
    }),
    vscode.commands.registerCommand("kotonia.help", () => showHelp()),
    vscode.commands.registerCommand("kotonia.cancel", () => engineState?.engine.cancel()),
    vscode.commands.registerCommand("kotonia.reviewChanges", () => reviewChanges()),
    vscode.commands.registerCommand("kotonia.applyChanges", () => applyChanges()),
    vscode.commands.registerCommand("kotonia.setKotoniaApiKey", () =>
      promptSecret(SECRET_KOTONIA, "Kotonia API key (KOTONIA_API_KEY)"),
    ),
    vscode.commands.registerCommand("kotonia.setDeepSeekApiKey", () =>
      promptSecret(SECRET_DEEPSEEK, "DeepSeek API key (DEEPSEEK_API_KEY)"),
    ),
  );

  refreshLoginContext();
}

/** True when a device login (~/.kotonia/daemon.json) or KOTONIA_API_KEY is
 * present. Drives the login/logout toggle in the view toolbar. */
function isLoggedIn(): boolean {
  if (authKnownInvalid) {
    return false;
  }
  if (process.env.KOTONIA_API_KEY?.trim()) {
    return true;
  }
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".kotonia", "daemon.json"), "utf8");
    const cfg = JSON.parse(raw) as { server?: string; device_id?: string; device_token?: string };
    return Boolean(cfg.server?.trim() && cfg.device_id?.trim() && cfg.device_token?.trim());
  } catch {
    return false;
  }
}

function refreshLoginContext(): void {
  void vscode.commands.executeCommand("setContext", "kotonia.loggedIn", isLoggedIn());
}

/** Shown once (until re-login / new session) when the engine reports an auth
 * failure — usually an expired device token. The "logged in" toolbar state is
 * file-existence only, so a stale daemon.json still reads as logged in. */
let authPromptActive = false;
function maybePromptReLogin(message: string): void {
  const m = (message || "").toLowerCase();
  const isAuth =
    m.includes("401") ||
    m.includes("bearer token") ||
    m.includes("device token") ||
    m.includes("missing or invalid") ||
    m.includes("unauthorized");
  if (!isAuth || authPromptActive) {
    return;
  }
  authKnownInvalid = true;
  refreshLoginContext();
  authPromptActive = true;
  void vscode.window
    .showWarningMessage(
      "Kotonia: 認証エラー（デバイストークンの期限切れの可能性）。再ログインしてください。",
      "ログイン",
    )
    .then((choice) => {
      if (choice === "ログイン") {
        runLogin();
      }
    });
}

async function logout(): Promise<void> {
  const ok = await vscode.window.showWarningMessage(
    "Kotonia: ログアウトしますか？ デバイスの認証情報（~/.kotonia/daemon.json）を削除します。",
    { modal: true },
    "ログアウト",
  );
  if (ok !== "ログアウト") {
    return;
  }
  const folder = pickWorkspaceFolder();
  let removedByCli = false;
  if (folder) {
    try {
      const binary = await ensureEngine(folder);
      const result = await runExec(binary, ["logout", "--json"], folder.uri.fsPath);
      removedByCli = result.code === 0;
      if (!removedByCli) {
        output.appendLine(`[logout] CLI fallback: ${result.stderr.trim()}`);
      }
    } catch (e) {
      output.appendLine(`[logout] CLI failed: ${e}`);
    }
  }
  if (!removedByCli) {
    // Compatibility with the currently published v0.1.5 helper. Newer
    // engines own this operation through `kotonia-cli logout`.
    try {
      fs.unlinkSync(path.join(os.homedir(), ".kotonia", "daemon.json"));
    } catch {
      /* already gone */
    }
  }
  authKnownInvalid = false;
  authPromptActive = false;
  engineState?.engine.dispose();
  engineState = undefined;
  speakAbort?.abort();
  ui.reset();
  refreshLoginContext();
  vscode.window.showInformationMessage("Kotonia: ログアウトしました。");
}

export function deactivate(): void {
  engineState?.engine.dispose();
  engineState = undefined;
  avatarPanel?.dispose();
  avatarPanel = undefined;
}

// ---- chat panel + engine lifecycle -----------------------------------------

/** Create the center chat panel if needed, then reveal it. */
function ensureChatPanel(): void {
  if (chatPanel) {
    chatPanel.reveal();
    return;
  }
  chatPanel = new ChatPanel(
    extContext.extensionUri,
    (a) => handlePanelAction(a),
    () => {
      // Panel closed → end the session (it's saved to disk and resumable).
      chatPanel = undefined;
      engineState?.engine.dispose();
      engineState = undefined;
      speakAbort?.abort();
      sessionTree.refresh();
    },
  );
}

/** Start a brand-new chat session in the center panel. */
function newChat(): void {
  ensureChatPanel();
  restart();
}

/** Resume an existing session (by id) in the center panel. */
function openSession(id: string): void {
  ensureChatPanel();
  restart(id);
}

function restart(resumeSessionId?: string): void {
  engineState?.engine.dispose();
  engineState = undefined;
  speakAbort?.abort();
  authPromptActive = false;
  ui.reset();
  startEngine(resumeSessionId);
}

function startEngine(resumeSessionId?: string): void {
  const folder = pickWorkspaceFolder();
  if (!folder) {
    ui.note("open a folder first — the agent needs a workspace.");
    return;
  }
  const cfg = vscode.workspace.getConfiguration("kotonia");
  const model = cfg.get<string>("model", "kotonia-gemma4-26b");
  if (model === "claude-code") {
    ui.note(
      "Claude Code is not available through the current JSON engine protocol. Select a ReAct model; desktop/CLI can still use Claude Code directly.",
    );
    vscode.window.showWarningMessage(
      "Kotonia: VS Code版では現在 Claude Code を選択できません。ReActモデルへ切り替えてください。",
      "モデルを選択",
    ).then((choice) => {
      if (choice === "モデルを選択") {
        void selectModel();
      }
    });
    return;
  }

  void (async () => {
    const binary = await ensureEngine(folder);
    const env = await gatherEnv();
    if (model.startsWith("kotonia")) {
      const auth = await queryAuthStatus(binary, folder.uri.fsPath, env);
      if (auth?.valid === false) {
        authKnownInvalid = true;
        refreshLoginContext();
        ui.note("stored login is expired or invalid — run “Kotonia: Login” before starting.");
        return;
      }
      if (auth?.logged_in) {
        authKnownInvalid = false;
        refreshLoginContext();
      }
    }
    if (model.startsWith("kotonia") && !env.KOTONIA_API_KEY && !process.env.KOTONIA_API_KEY) {
      const daemonJson = path.join(os.homedir(), ".kotonia", "daemon.json");
      if (!fs.existsSync(daemonJson)) {
        ui.note("not signed in — run “Kotonia: Login” (device-code), then start a new chat.");
      }
    }
    const engine = new KotoniaEngine(
      {
        binary,
        cwd: folder.uri.fsPath,
        model,
        approvalMode: cfg.get<string>("approvalMode", "allowlist"),
        workspaceMode: cfg.get<"worktree" | "in-place">("workspaceMode", "in-place"),
        extraArgs: cfg.get<string[]>("extraArgs", []),
        resumeSessionId,
        env,
      },
      (msg: Outbound) => onEngineMessage(msg),
      output,
      (code) => onEngineExit(code),
    );
    engineState = { engine, remembered: new Set(), lastTurnId: 0, greeted: false };
    engine.start();
    setTimeout(() => sessionTree.refresh(), 800);
  })();
}

function handlePanelAction(a: PanelAction): void {
  switch (a.kind) {
    case "ready":
      // The chat webview (re)loaded — recover its status line if a session is
      // already live. Engine start is explicit (New Chat / open session).
      if (engineState?.hello) {
        ui.postEngineMessage(engineState.hello);
      }
      break;
    case "send": {
      if (!engineState) {
        ui.note("no active session — press New Chat (＋) in the Sessions sidebar.");
        break;
      }
      ui.setBusy(true);
      engineState.engine.sendUserTurn(a.text, currentEditorContext());
      break;
    }
    case "approval":
      if (a.remember && engineState) {
        engineState.remembered.add(leadingToken(a.command));
      }
      engineState?.engine.sendApproval(a.approvalId, a.approve, a.remember);
      break;
    case "cancel":
      engineState?.engine.cancel();
      break;
    case "openResource":
      void openResource(a.target, a.line);
      break;
    case "previewResource":
      void previewHtmlResource(a.target);
      break;
  }
}

function onEngineMessage(msg: Outbound): void {
  if (!engineState) {
    return;
  }
  if (msg.type === "hello") {
    engineState.hello = msg;
    if (!engineState.greeted) {
      engineState.greeted = true;
      ui.note("session ready — type your request below and press Enter (Shift+Enter for a newline).");
    }
  } else if ("turn_id" in msg && typeof msg.turn_id === "number") {
    engineState.lastTurnId = msg.turn_id;
  }

  if (msg.type === "final") {
    void speak(msg.answer);
  }
  if (msg.type === "done") {
    sessionTree.refresh();
  }
  if (msg.type === "error") {
    maybePromptReLogin(msg.message);
  }

  if (msg.type === "approval_request") {
    const tok = leadingToken(msg.command);
    if (engineState.remembered.has(tok)) {
      engineState.engine.sendApproval(msg.approval_id, true, true);
      ui.note(`auto-approved (remembered \`${tok}\`): ${msg.command}`, msg.turn_id);
      return;
    }
  }

  ui.postEngineMessage(msg);
}

function onEngineExit(code: number | null): void {
  if (!engineState) {
    return;
  }
  ui.postEngineMessage({
    type: "error",
    message: `engine exited (code ${code}). Press New Chat (＋) to restart.`,
    turn_id: 0,
  } as Outbound);
  engineState.engine.dispose();
  engineState = undefined;
  vscode.window.showWarningMessage("Kotonia engine exited.", "New Chat").then((choice) => {
    if (choice === "New Chat") {
      newChat();
    }
  });
}

// ---- talking avatar (#3) ---------------------------------------------------

function toggleAvatar(): void {
  const cfg = vscode.workspace.getConfiguration("kotonia");
  const next = !cfg.get<boolean>("avatar.enabled", false);
  void cfg.update("avatar.enabled", next, vscode.ConfigurationTarget.Workspace);
  if (next) {
    const name = cfg.get<string>("avatar.character", "ことな").trim();
    ensureAvatarPanel();
    ui.note(`talking avatar ON（${name}）.`);
  } else {
    ui.note("talking avatar OFF.");
  }
  if (!next) {
    speakAbort?.abort();
    ui.avatarStop();
  }
}

/** Named avatar characters. The user picks one by NAME
 * (`kotonia.avatar.character` = "ことな" / "ひなた"); each carries its
 * canonical avatar_id AND voice so the character sounds right. */
interface AvatarCharacter {
  label: string;
  /** Names/aliases that select this character. First entry is canonical. */
  keys: string[];
  id: string;
  ttsBackend: string;
  speaker: string;
  /** Voice/style overlay only. Coding policy comes from Eve Code so changing
   * the visual avatar cannot silently weaken the agent workflow. */
  persona: string;
}

const EVE_CODE_PERSONA =
  "あなたは「Eve Code」— VS Code上で実際のソフトウェア開発を完遂するための、経験豊富なコーディングエージェント。\n" +
  "最優先は、ユーザーの意図を満たす正確で保守可能な変更を、既存設計とローカル変更を尊重して実装・検証すること。" +
  "編集前に関連箇所を絞って読み、依存関係が必要な時だけ探索範囲を広げる。推測で大規模に読み漁らない。" +
  "変更後はリスクに応じたlint・型検査・テスト・buildを行い、失敗時は原因を特定して修正する。" +
  "パス、エラー、検証結果は具体的に示す。コードを回答欄へ大量に貼ること自体を成果とせず、実ファイルの変更を成果にする。" +
  "既存の未コミット変更、秘密情報、破壊的操作を慎重に扱い、必要な判断だけを短くユーザーへ確認する。" +
  "最終回答は最初に結果を述べ、重要な変更点と検証結果を簡潔に伝える。";

const KOTONA_PERSONA =
  "応答時のキャラクターは「ことな」。親しみやすく面倒見のよい先輩エンジニアの距離感で、明るく簡潔に話す。" +
  "技術用語は自然な英語のまま混ぜてよい。過剰な萌え・甘え・ご主人様呼び・長い芝居は避ける。";

const HINATA_PERSONA =
  "応答時のキャラクターは「ひなた」。一人称は「わたし」、明るくフレンドリーな相棒として話す。" +
  "少し感情を見せてもよいが、実装内容を曖昧にする長い芝居・過剰な甘え・ご主人様呼びは避ける。";

const AVATAR_CHARACTERS: AvatarCharacter[] = [
  { label: "ことな (Kotona)", keys: ["ことな", "kotona"], id: "kotona_v4", ttsBackend: "aivis", speaker: "888753762", persona: KOTONA_PERSONA },
  { label: "ひなた (Hinata)", keys: ["ひなた", "hinata"], id: "persona_media_45_ditto", ttsBackend: "irodori", speaker: "", persona: HINATA_PERSONA },
];

/** The selected character's persona system prompt, or undefined when disabled
 * or the character is a custom (unknown) id. */
function characterPersona(): string | undefined {
  const cfg = vscode.workspace.getConfiguration("kotonia");
  if (!cfg.get<boolean>("avatar.persona", true)) {
    return undefined;
  }
  const c = findCharacter(cfg.get<string>("avatar.character", "ことな").trim());
  return c?.persona;
}

function findCharacter(name: string): AvatarCharacter | undefined {
  const n = name.trim().toLowerCase();
  return AVATAR_CHARACTERS.find((c) => c.keys.some((k) => k.toLowerCase() === n));
}

/** Resolve the configured avatar to a concrete {id, ttsBackend, speaker}.
 * `kotonia.avatar.character` holds either a known name (ことな / ひなた →
 * preset voice) or a raw avatar_id (custom → voice from avatar.ttsBackend /
 * avatar.speaker). */
function resolveAvatar(cfg: vscode.WorkspaceConfiguration): {
  id: string;
  ttsBackend: string;
  speaker: string;
} {
  const character = cfg.get<string>("avatar.character", "ことな").trim();
  const c = findCharacter(character);
  if (c) {
    return { id: c.id, ttsBackend: c.ttsBackend, speaker: c.speaker };
  }
  return {
    id: character || cfg.get<string>("avatar.id", "").trim(),
    ttsBackend: cfg.get<string>("avatar.ttsBackend", "aivis"),
    speaker: cfg.get<string>("avatar.speaker", ""),
  };
}

/** Pick the talking avatar by name (ことな / ひなた) or a custom name/avatar_id. */
async function selectAvatar(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("kotonia");
  const current = cfg.get<string>("avatar.character", "ことな").trim();
  const currentChar = findCharacter(current);

  type Item = vscode.QuickPickItem & { character?: AvatarCharacter; custom?: boolean };
  const items: Item[] = AVATAR_CHARACTERS.map((c) => ({
    label: c.label,
    description: c.id,
    detail: currentChar?.label === c.label ? "現在選択中" : undefined,
    character: c,
  }));
  items.push({ label: "$(edit) カスタム（名前 / avatar_id を入力）…", custom: true });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "アバターを選択（ことな / ひなた / カスタム）",
  });
  if (!picked) {
    return;
  }

  const target = vscode.ConfigurationTarget.Workspace;
  if (picked.custom) {
    const value = await vscode.window.showInputBox({
      prompt: "キャラ名（ことな / ひなた）または avatar_id を入力",
      value: current,
      ignoreFocusOut: true,
    });
    if (!value || !value.trim()) {
      return;
    }
    await cfg.update("avatar.character", value.trim(), target);
    await cfg.update("avatar.enabled", true, target);
    ensureAvatarPanel();
    avatarPanel?.reveal();
    vscode.window.showInformationMessage(`Kotonia: アバターを「${value.trim()}」に設定しました。`);
  } else if (picked.character) {
    await cfg.update("avatar.character", picked.character.keys[0], target);
    await cfg.update("avatar.enabled", true, target);
    ensureAvatarPanel();
    avatarPanel?.reveal();
    vscode.window.showInformationMessage(
      `Kotonia: アバターを「${picked.character.label}」に設定して表示しました（声も次の発話から反映）。`,
    );
  }
}

// ---- model selection -------------------------------------------------------

/** Curated model list — the same range kotonia-cli's provider registry (and
 * kotonia-desktop) resolves. Custom entry covers ~/.kotonia/providers.json. */
const MODELS: { label: string; id: string; detail: string }[] = [
  { label: "Kotonia Gemma4 26B（hosted・既定）", id: "kotonia-gemma4-26b", detail: "kotonia.ai /api/v1・device_token" },
  { label: "Kotonia ThinkCap 27B（hosted・reasoning）", id: "kotonia-thinkcap-27b", detail: "kotonia.ai /api/v1・device_token" },
  { label: "Kotonia ThinkCap 27B :nothink", id: "kotonia-thinkcap-27b:nothink", detail: "reasoning無効・低遅延" },
  { label: "DeepSeek Chat（API）", id: "deepseek-chat", detail: "要 DEEPSEEK_API_KEY" },
  { label: "DeepSeek Reasoner（API）", id: "deepseek-reasoner", detail: "推論・要 DEEPSEEK_API_KEY" },
  { label: "DeepSeek Reasoner :thinking", id: "deepseek-reasoner:thinking", detail: "推論モード" },
];

/** Pick the agent model. The model is fixed at engine start, so a running
 * session is offered a restart to apply. */
async function selectModel(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("kotonia");
  const current = cfg.get<string>("model", "kotonia-gemma4-26b").trim();

  type Item = vscode.QuickPickItem & { modelId?: string; custom?: boolean };
  const items: Item[] = MODELS.map((m) => ({
    label: m.label,
    description: m.id,
    detail: m.id === current ? "現在選択中" : m.detail,
    modelId: m.id,
  }));
  items.push({ label: "$(edit) カスタム（provider.json のモデル等）…", custom: true });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "モデルを選択（kotonia-cli / kotonia-desktop と同じ範囲）",
  });
  if (!picked) {
    return;
  }

  let id: string | undefined;
  if (picked.custom) {
    id = await vscode.window.showInputBox({
      prompt: "model id を入力（例: kotonia-gemma4-26b / deepseek-chat / providers.json のモデル）",
      value: current,
      ignoreFocusOut: true,
    });
  } else {
    id = picked.modelId;
  }
  if (!id || !id.trim()) {
    return;
  }
  await cfg.update("model", id.trim(), vscode.ConfigurationTarget.Workspace);
  if (engineState) {
    const choice = await vscode.window.showInformationMessage(
      `Kotonia: モデルを ${id.trim()} に設定しました。反映するには新しいチャットを開始します。`,
      "新規チャット",
      "後で",
    );
    if (choice === "新規チャット") {
      restart();
    }
  } else {
    vscode.window.showInformationMessage(
      `Kotonia: モデルを ${id.trim()} に設定しました（新規チャットで反映）。`,
    );
  }
}

function readAvatarAuth(cfg: vscode.WorkspaceConfiguration): { base: string; token: string } | undefined {
  let token: string | undefined;
  let base: string | undefined;
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".kotonia", "daemon.json"), "utf8");
    const dj = JSON.parse(raw) as { server?: string; device_token?: string };
    token = dj.device_token;
    base = dj.server;
  } catch {
    /* not logged in */
  }
  if (!token && process.env.KOTONIA_API_KEY) {
    token = process.env.KOTONIA_API_KEY;
  }
  const override = cfg.get<string>("avatar.apiBase", "").trim();
  base = (override || base || "https://kotonia.ai").replace(/\/+$/, "");
  return token ? { base, token } : undefined;
}

async function speak(text: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("kotonia");
  if (!cfg.get<boolean>("avatar.enabled", false)) {
    return;
  }
  const resolved = resolveAvatar(cfg);
  if (!resolved.id || !text.trim()) {
    return;
  }
  const auth = readAvatarAuth(cfg);
  if (!auth) {
    ui.note("avatar: not signed in — run “Kotonia: Login”.");
    return;
  }

  speakAbort?.abort();
  const abort = new AbortController();
  speakAbort = abort;

  // Numeric speaker ids (AivisSpeech / VoiceVox style) must go over the wire
  // as numbers — the ditto→TTS proxy forwards `speaker` verbatim and the
  // engine expects an int for those backends.
  const speakerStr = String(resolved.speaker ?? "").trim();
  const speaker: string | number | undefined = speakerStr
    ? /^\d+$/.test(speakerStr)
      ? Number(speakerStr)
      : speakerStr
    : undefined;
  const body = {
    text,
    avatar_id: resolved.id,
    tts_backend: resolved.ttsBackend,
    language: cfg.get<string>("avatar.language", "ja"),
    speaker,
    speed: cfg.get<number>("avatar.speed", 1.2),
    fps: 25,
  };

  try {
    const res = await fetch(`${auth.base}/api/voice/ditto/tts/stream/avatar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) {
      ui.note(`avatar: HTTP ${res.status} from ditto stream`);
      return;
    }
    ui.avatarBegin();
    const reader = res.body.getReader();
    let acc = new Uint8Array(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.length) {
        const merged = new Uint8Array(acc.length + value.length);
        merged.set(acc);
        merged.set(value, acc.length);
        acc = merged;
      }
      while (acc.length >= 5) {
        const type = acc[0];
        const len = acc[1] * 16777216 + acc[2] * 65536 + acc[3] * 256 + acc[4];
        if (acc.length < 5 + len) {
          break;
        }
        const payload = acc.subarray(5, 5 + len);
        acc = acc.slice(5 + len);
        ui.avatarChunk(type, Buffer.from(payload).toString("base64"));
      }
    }
    ui.avatarEnd();
  } catch (e) {
    const err = e as { name?: string; message?: string };
    if (err?.name !== "AbortError") {
      ui.note(`avatar error: ${err?.message ?? String(e)}`);
    }
  }
}

// ---- worktree review / apply (#13) -----------------------------------------

function worktreePath(): string | undefined {
  if (!engineState) {
    vscode.window.showWarningMessage("Kotonia: no active session.");
    return undefined;
  }
  if (!engineState.hello?.is_worktree) {
    vscode.window.showInformationMessage(
      "Kotonia: in-place mode — the agent's edits are already in your workspace (nothing to merge).",
    );
    return undefined;
  }
  return engineState.hello.workspace_root;
}

async function reviewChanges(): Promise<void> {
  const wt = worktreePath();
  if (!wt) {
    return;
  }
  await runExec("git", ["add", "-A", "-N"], wt);
  const { stdout } = await runExec("git", ["diff", "HEAD"], wt);
  if (!stdout.trim()) {
    vscode.window.showInformationMessage("Kotonia: the agent hasn't changed any files yet.");
    return;
  }
  const doc = await vscode.workspace.openTextDocument({ content: stdout, language: "diff" });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function applyChanges(): Promise<void> {
  const wt = worktreePath();
  if (!wt) {
    return;
  }
  const folder = pickWorkspaceFolder();
  if (!folder) {
    vscode.window.showErrorMessage("Kotonia: no workspace folder to apply into.");
    return;
  }
  await runExec("git", ["add", "-A", "-N"], wt);
  const { stdout: patch } = await runExec("git", ["diff", "HEAD", "--binary"], wt);
  if (!patch.trim()) {
    vscode.window.showInformationMessage("Kotonia: no agent changes to apply.");
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    "Apply the agent's changes to your working copy? Review the diff first (Kotonia: Review Agent Changes).",
    { modal: true },
    "Apply",
  );
  if (confirm !== "Apply") {
    return;
  }
  const tmp = path.join(os.tmpdir(), `kotonia-apply-${Date.now()}.patch`);
  fs.writeFileSync(tmp, patch);
  const { code, stderr } = await runExec("git", ["apply", "--3way", tmp], folder.uri.fsPath);
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  if (code === 0) {
    vscode.window.showInformationMessage(
      "Kotonia: applied the agent's changes to your workspace. Review & commit as usual.",
    );
    ui.note("applied agent changes to workspace", engineState?.lastTurnId);
  } else {
    vscode.window.showErrorMessage(`Kotonia: git apply failed — ${stderr.trim() || "conflict"}`);
  }
}

// ---- login (device-code) ---------------------------------------------------

function runLogin(): void {
  const folder = pickWorkspaceFolder();
  if (!folder) {
    vscode.window.showErrorMessage("Kotonia: open a folder first.");
    return;
  }
  output.appendLine("[login] starting device-code flow");

  void (async () => {
  const binary = await ensureEngine(folder);
  const child = spawn(binary, ["login"], { cwd: folder.uri.fsPath, env: process.env });
  let verifyUri: string | undefined;
  let sawCodeLabel = false;
  let buf = "";

  const handleLine = (line: string): void => {
    output.appendLine(`[login] ${line}`);
    const url = line.match(/https?:\/\/\S+/);
    if (!verifyUri && url) {
      // Hold the verification URL until we also have the code, then open the
      // page with the code prefilled (`?code=…`) so the user just clicks
      // Approve — no manual typing.
      verifyUri = url[0];
      return;
    }
    if (/enter this code/i.test(line)) {
      sawCodeLabel = true;
      return;
    }
    if (sawCodeLabel && line.trim()) {
      const code = line.trim();
      sawCodeLabel = false;
      const openUrl = verifyUri
        ? `${verifyUri}${verifyUri.includes("?") ? "&" : "?"}code=${encodeURIComponent(code)}`
        : undefined;
      void vscode.env.clipboard.writeText(code);
      if (openUrl) {
        void vscode.env.openExternal(vscode.Uri.parse(openUrl));
      }
      promptLoginApproval(code, openUrl);
    }
  };

  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      handleLine(line);
    }
  });
  child.stderr.on("data", (d: Buffer) => output.append(d.toString()));
  child.on("error", (e) =>
    vscode.window.showErrorMessage(`Kotonia: login failed to start — ${e.message}`),
  );
  child.on("exit", (code) => {
    if (code === 0) {
      authKnownInvalid = false;
      authPromptActive = false;
      refreshLoginContext();
      // The engine reads the device token once at startup, so a session that
      // was running with the old/expired token must be restarted to pick up
      // the fresh one.
      if (engineState) {
        vscode.window.showInformationMessage("Kotonia: ログインしました。新しいトークンでセッションを再起動します。");
        restart();
      } else {
        vscode.window.showInformationMessage("Kotonia: ログインしました。新規チャット（＋）で開始できます。");
      }
    } else {
      vscode.window.showErrorMessage(
        "Kotonia: login did not complete. See the “Kotonia Agent” output channel.",
      );
    }
  });
  })();
}

/** A sticky (button-bearing) notification showing the login code, so it stays
 * put while the user switches to the browser. With the prefilled URL the user
 * usually only needs to click Approve; the buttons are a fallback. */
function promptLoginApproval(code: string, url?: string): void {
  void vscode.window
    .showInformationMessage(
      `Kotonia ログイン: ブラウザで「Approve」を押すとサインイン完了です。コード ${code} は自動入力＆クリップボードにコピー済み（未対応環境では貼り付けてください）。`,
      "コードをコピー",
      "ログインページを開く",
    )
    .then((choice) => {
      if (choice === "コードをコピー") {
        void vscode.env.clipboard.writeText(code);
      } else if (choice === "ログインページを開く" && url) {
        void vscode.env.openExternal(vscode.Uri.parse(url));
      }
    });
}

// ---- helpers ---------------------------------------------------------------

function codingPersonaPrefix(): string {
  const blocks = [EVE_CODE_PERSONA];
  const character = characterPersona();
  if (character) {
    blocks.push(character);
  }
  return blocks.join("\n\n");
}

function leadingToken(command: string): string {
  const toks = command.trim().split(/\s+/);
  for (const t of toks) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      continue;
    }
    return t;
  }
  return toks[0] || "";
}

async function openResource(target: string, line?: number): Promise<void> {
  const value = target.trim();
  if (!value) {
    return;
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      await vscode.commands.executeCommand("simpleBrowser.show", value);
    } catch {
      try {
        await vscode.env.openExternal(vscode.Uri.parse(value, true));
      } catch {
        vscode.window.showWarningMessage(`Kotonia: could not open ${value}`);
      }
    }
    return;
  }

  const folder = pickWorkspaceFolder();
  const expanded =
    value === "~"
      ? os.homedir()
      : value.startsWith("~/")
        ? path.join(os.homedir(), value.slice(2))
        : value;
  const candidates = path.isAbsolute(expanded)
    ? [expanded]
    : Array.from(
        new Set(
          [
            engineState?.hello?.workspace_root,
            folder?.uri.fsPath,
          ]
            .filter((root): root is string => Boolean(root))
            .map((root) => path.resolve(root, expanded)),
        ),
      );
  const file = candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
  if (!file) {
    vscode.window.showWarningMessage(`Kotonia: could not resolve ${value}`);
    return;
  }

  const uri = vscode.Uri.file(file);
  try {
    const stat = await fs.promises.stat(file);
    if (stat.isDirectory()) {
      await vscode.commands.executeCommand("revealInExplorer", uri);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (line) {
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  } catch {
    vscode.window.showWarningMessage(`Kotonia: could not open ${value}`);
  }
}

async function previewHtmlResource(target: string): Promise<void> {
  const value = target.trim();
  if (!value) {
    return;
  }
  const folder = pickWorkspaceFolder();
  const expanded = value.startsWith("~/")
    ? path.join(os.homedir(), value.slice(2))
    : value;
  const candidates = path.isAbsolute(expanded)
    ? [expanded]
    : Array.from(
        new Set(
          [engineState?.hello?.workspace_root, folder?.uri.fsPath]
            .filter((root): root is string => Boolean(root))
            .map((root) => path.resolve(root, expanded)),
        ),
      );
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file || !/\.html?$/i.test(file)) {
    vscode.window.showWarningMessage(`Kotonia: HTML preview could not resolve ${value}`);
    return;
  }

  try {
    const html = await fs.promises.readFile(file, "utf8");
    const root = vscode.Uri.file(path.dirname(file));
    const panel = vscode.window.createWebviewPanel(
      "kotoniaHtmlPreview",
      `Preview: ${path.basename(file)}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [root],
      },
    );
    const base = panel.webview.asWebviewUri(root).toString().replace(/\/?$/, "/");
    const baseTag = `<base href="${base}">`;
    panel.webview.html = /<head[\s>]/i.test(html)
      ? html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
      : `${baseTag}${html}`;
  } catch (e) {
    vscode.window.showWarningMessage(`Kotonia: HTML preview failed — ${e}`);
  }
}

function runExec(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as unknown as { code?: number }).code === "number"
          ? ((err as unknown as { code: number }).code as number)
          : err
            ? 1
            : 0;
      resolve({ code, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function pickWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const f = vscode.workspace.getWorkspaceFolder(active);
    if (f) {
      return f;
    }
  }
  return vscode.workspace.workspaceFolders?.[0];
}

// ---- engine resolution / download -----------------------------------------
//
// The engine binary is NOT bundled in the VSIX (a bundled unsigned native
// binary trips the Marketplace "suspicious content" scanner). Instead the
// pinned `kotonia-cli` release is downloaded on demand to globalStorage and
// cached per version — so after a one-time first-run fetch the UX is identical
// to a bundled binary. A user-set `kotonia.enginePath` (custom path or a plain
// `kotonia-cli` resolved via PATH on the remote) always wins.

const ENGINE_REPO = "zhener562/kotonia-cli";

/** Resolve the engine binary, downloading the pinned release on first use. */
async function ensureEngine(folder: vscode.WorkspaceFolder): Promise<string> {
  const raw = vscode.workspace.getConfiguration("kotonia").get<string>("enginePath", "kotonia-cli");
  const expanded = raw.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath).trim();
  // Explicit override (any custom path) → use as-is, no download.
  if (expanded && expanded !== "kotonia-cli") {
    return expanded;
  }
  // Managed engine: download-on-demand, cached in globalStorage.
  const managed = await ensureManagedEngine();
  return managed ?? "kotonia-cli"; // fall back to a PATH lookup on the host.
}

/** The pinned engine release tag, read from the bundled `kotonia-cli.version`. */
function engineTag(): string {
  try {
    const p = path.join(extContext.extensionPath, "kotonia-cli.version");
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

interface EngineAsset {
  name: string;
  archive: "tar.gz" | "zip";
  executable: string;
}

/** Release asset details for the host platform/arch, or undefined if unpublished. */
function engineAsset(): EngineAsset | undefined {
  if (process.platform === "linux" && process.arch === "x64") {
    return { name: "kotonia-cli-linux-x64.tar.gz", archive: "tar.gz", executable: "kotonia-cli" };
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return { name: "kotonia-cli-linux-arm64.tar.gz", archive: "tar.gz", executable: "kotonia-cli" };
  }
  // Intel macOS is intentionally unsupported for the managed engine (no
  // x86_64-apple-darwin release asset): Apple Silicon uses the arm64 asset.
  // A genuine Intel Mac falls back to a `kotonia-cli` on PATH.
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { name: "kotonia-cli-darwin-arm64.tar.gz", archive: "tar.gz", executable: "kotonia-cli" };
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return { name: "kotonia-cli-windows-x64.zip", archive: "zip", executable: "kotonia-cli.exe" };
  }
  return undefined;
}

let engineDownload: Promise<string | undefined> | undefined;

/** Return the cached managed engine path, downloading it once if missing.
 * Returns undefined (→ PATH fallback) when the platform is unsupported or the
 * download fails. */
function ensureManagedEngine(): Promise<string | undefined> {
  const tag = engineTag();
  const asset = engineAsset();
  if (!tag || !asset) {
    return Promise.resolve(undefined);
  }
  const destDir = vscode.Uri.joinPath(extContext.globalStorageUri, "engine", tag).fsPath;
  const exe = path.join(destDir, asset.executable);
  if (fs.existsSync(exe)) {
    return Promise.resolve(exe);
  }
  if (!engineDownload) {
    engineDownload = downloadEngine(tag, asset, destDir, exe)
      .catch((e) => {
        output.appendLine(`[engine] download failed: ${e}`);
        vscode.window.showErrorMessage(
          `Kotonia: could not download the engine (${tag}). Falling back to \`kotonia-cli\` on PATH. ${e}`,
        );
        return undefined;
      })
      .finally(() => {
        engineDownload = undefined;
      });
  }
  return engineDownload;
}

async function downloadEngine(
  tag: string,
  asset: EngineAsset,
  destDir: string,
  exe: string,
): Promise<string> {
  const url = `https://github.com/${ENGINE_REPO}/releases/download/${tag}/${asset.name}`;
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Kotonia: エンジンを取得中 (${tag})…` },
    async () => {
      await fs.promises.mkdir(destDir, { recursive: true });
      const archive = path.join(destDir, asset.name);
      output.appendLine(`[engine] downloading ${url}`);
      await httpDownload(url, archive);
      if (asset.archive === "tar.gz") {
        await execFileP("tar", ["-xzf", archive, "-C", destDir]);
      } else {
        await execFileP("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
        ]);
      }
      await fs.promises.unlink(archive).catch(() => undefined);
      if (!fs.existsSync(exe)) {
        throw new Error(`engine binary missing after extract: ${exe}`);
      }
      await fs.promises.chmod(exe, 0o755);
      output.appendLine(`[engine] ready: ${exe}`);
      return exe;
    },
  );
}

/** Download a URL to a file, following redirects (GitHub → codeload/S3). */
function httpDownload(url: string, dest: string, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "kotonia-vscode" } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) {
          reject(new Error("too many redirects"));
          return;
        }
        httpDownload(res.headers.location, dest, redirects - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status} for ${url}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close((err) => (err ? reject(err) : resolve())));
      file.on("error", (err) => {
        fs.promises.unlink(dest).catch(() => undefined);
        reject(err);
      });
    });
    req.on("error", reject);
  });
}

function execFileP(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
  });
}

async function gatherEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  // Device login (~/.kotonia/daemon.json) is the primary auth for hosted
  // models. The engine PREFERS KOTONIA_API_KEY over the device token, so a
  // leftover/stale KOTONIA_API_KEY secret would silently override a valid
  // login and 401. Only inject the key when NOT device-logged-in.
  const daemonJson = path.join(os.homedir(), ".kotonia", "daemon.json");
  if (!fs.existsSync(daemonJson)) {
    const kotonia = await extContext.secrets.get(SECRET_KOTONIA);
    if (kotonia) {
      env.KOTONIA_API_KEY = kotonia;
    }
  }
  const deepseek = await extContext.secrets.get(SECRET_DEEPSEEK);
  if (deepseek) {
    env.DEEPSEEK_API_KEY = deepseek;
  }
  env.KOTONIA_PERSONA_PREFIX = codingPersonaPrefix();
  const language = vscode.workspace.getConfiguration("kotonia").get<string>("language", "ja").trim();
  if (language) {
    env.KOTONIA_REPLY_LANGUAGE = language;
  }
  return env;
}

function currentEditorContext(): EditorContext | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    return undefined;
  }
  const folder = vscode.workspace.getWorkspaceFolder(ed.document.uri);
  const activeFile = folder
    ? path.relative(folder.uri.fsPath, ed.document.uri.fsPath)
    : vscode.workspace.asRelativePath(ed.document.uri, false);
  const ctx: EditorContext = {
    active_file: activeFile,
    language_id: ed.document.languageId,
  };
  const sel = ed.selection;
  if (!sel.isEmpty) {
    ctx.selection = { start_line: sel.start.line + 1, end_line: sel.end.line + 1 };
    ctx.selection_text = ed.document.getText(sel).slice(0, SELECTION_CAP);
  }
  ctx.visible_files = Array.from(
    new Set(
      vscode.window.visibleTextEditors
        .filter((visible) => visible.document.uri.scheme === "file")
        .map((visible) => {
          const owner = vscode.workspace.getWorkspaceFolder(visible.document.uri);
          return owner
            ? path.relative(owner.uri.fsPath, visible.document.uri.fsPath)
            : vscode.workspace.asRelativePath(visible.document.uri, false);
        }),
    ),
  ).slice(0, VISIBLE_FILE_CAP);
  ctx.diagnostics = vscode.languages
    .getDiagnostics(ed.document.uri)
    .slice(0, DIAGNOSTIC_CAP)
    .map((diagnostic) => ({
      severity: diagnosticSeverity(diagnostic.severity),
      line: diagnostic.range.start.line + 1,
      message: diagnostic.message.slice(0, 500),
    }));
  return ctx;
}

function diagnosticSeverity(
  severity: vscode.DiagnosticSeverity,
): "error" | "warning" | "information" | "hint" {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    default:
      return "hint";
  }
}

interface CliAuthStatus {
  logged_in: boolean;
  valid: boolean | null;
  source: string;
  error?: string | null;
}

async function queryAuthStatus(
  binary: string,
  cwd: string,
  env: Record<string, string>,
): Promise<CliAuthStatus | undefined> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ["auth-status", "--json", "--validate"],
      {
        cwd,
        env: { ...process.env, ...env },
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
      (_err, stdout, stderr) => {
        const line = String(stdout || "")
          .trim()
          .split("\n")
          .reverse()
          .find((candidate) => candidate.trim().startsWith("{"));
        if (!line) {
          // The currently published v0.1.5 engine predates auth-status.
          // Treat this as "unknown" and keep the local credential fallback.
          if (stderr) {
            output.appendLine(`[auth] status unavailable: ${String(stderr).trim()}`);
          }
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(line) as CliAuthStatus);
        } catch (e) {
          output.appendLine(`[auth] malformed status: ${e}`);
          resolve(undefined);
        }
      },
    );
  });
}

async function promptSecret(key: string, label: string): Promise<void> {
  const value = await vscode.window.showInputBox({
    prompt: `Enter your ${label}`,
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return;
  }
  if (value === "") {
    await extContext.secrets.delete(key);
    vscode.window.showInformationMessage(`Kotonia: cleared ${label}.`);
  } else {
    await extContext.secrets.store(key, value);
    vscode.window.showInformationMessage(`Kotonia: stored ${label}. Start a new chat to apply.`);
  }
}
