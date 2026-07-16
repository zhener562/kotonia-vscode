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

export function getState<T>(): T | undefined {
  return vscode.getState() as T | undefined;
}

export function setState<T>(state: T): void {
  vscode.setState(state);
}
