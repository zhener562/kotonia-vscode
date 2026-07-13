import type { PanelAction } from "./types";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// acquireVsCodeApi() may only be called once per webview document.
const vscode = acquireVsCodeApi();

export function postAction(action: PanelAction): void {
  vscode.postMessage(action);
}
