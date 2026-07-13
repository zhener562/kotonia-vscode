// Dedicated talking-avatar webview panel. Lives in the editor area so the user
// can move / resize it freely and even "Move Editor into New Window" to float
// it outside the main VS Code window. Hosts only the Ditto frame+audio player.

import * as vscode from "vscode";
import { getNonce } from "./webview";

export class AvatarPanel {
  private readonly panel: vscode.WebviewPanel;

  constructor(extensionUri: vscode.Uri, onDispose: () => void) {
    this.panel = vscode.window.createWebviewPanel(
      "kotoniaAvatar",
      "Kotonia アバター",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html(extensionUri, this.panel.webview);
    this.panel.onDidDispose(() => onDispose());
  }

  begin(): void {
    this.panel.webview.postMessage({ kind: "avatarBegin" });
  }
  chunk(chunkType: number, data: string): void {
    this.panel.webview.postMessage({ kind: "avatarChunk", chunkType, data });
  }
  end(): void {
    this.panel.webview.postMessage({ kind: "avatarEnd" });
  }
  stop(): void {
    this.panel.webview.postMessage({ kind: "avatarStop" });
  }
  reveal(): void {
    this.panel.reveal(undefined, true);
  }
  dispose(): void {
    this.panel.dispose();
  }

  private html(extensionUri: vscode.Uri, webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "avatar.js"));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} blob:`,
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
      "media-src blob:",
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    html, body { margin: 0; height: 100%; background: var(--vscode-editor-background); overflow: hidden; }
    #placeholder {
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-font-family);
      font-size: 0.85em; line-height: 1.6; text-align: center; padding: 2em 1.5em;
    }
    #avatar { display: none; width: 100%; height: 100vh; object-fit: contain; }
    #unmute {
      display: none; position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);
      z-index: 10; cursor: pointer; user-select: none;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      font-family: var(--vscode-font-family); font-size: 0.85em;
      padding: 7px 14px; border-radius: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.4);
    }
    #unmute:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div id="placeholder">アバター待機中… 発話すると表示されます。<br />このパネルはドラッグで移動・リサイズでき、タブ右クリック →「エディターを新しいウィンドウに移動」で VS Code の外に浮かせられます。</div>
  <canvas id="avatar"></canvas>
  <div id="unmute">🔊 クリックで音声を有効化</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
