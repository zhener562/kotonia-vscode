// Message contracts between the extension host (panel.ts) and this webview.
// Mirrors src/protocol.ts (engine events) and src/webview.ts (PanelAction).
// Kept as a local copy so the webview build stays independent of the extension
// tsconfig; keep the two in lockstep.

export interface ExecutionResult {
  exit_code: number;
  timed_out: boolean;
  truncated: boolean;
  combined: string;
}

interface WithTurn {
  turn_id: number;
}

export type EngineMessage =
  | {
      type: "hello";
      model: string;
      backend: string;
      tool_mode: string;
      approval_mode: string;
      is_worktree: boolean;
      session_id: string | null;
    }
  | {
      type: "history_snapshot";
      session_id: string | null;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }
  | ({ type: "iteration_start"; iteration: number; max: number } & WithTurn)
  | ({ type: "llm_thinking" } & WithTurn)
  | ({ type: "text"; text: string } & WithTurn)
  | ({ type: "bash"; command: string } & WithTurn)
  | ({ type: "bash_skipped"; command: string; reason: string } & WithTurn)
  | ({ type: "observation"; result: ExecutionResult } & WithTurn)
  | ({ type: "inspect_image"; path: string; size_bytes: number; error?: string | null } & WithTurn)
  | ({ type: "final"; answer: string } & WithTurn)
  | ({ type: "malformed"; excerpt: string } & WithTurn)
  | ({ type: "error"; message: string } & WithTurn)
  | ({ type: "done"; iterations: number; success: boolean } & WithTurn)
  | ({ type: "approval_request"; approval_id: number; command: string; reason: string } & WithTurn);

/** Messages the host posts down to the webview. */
export type HostMessage =
  | { kind: "engine"; msg: EngineMessage }
  | { kind: "busy"; busy: boolean }
  | { kind: "note"; text: string; turnId?: number }
  | { kind: "reset" };

/** Actions the webview posts up to the host (matches PanelAction). */
export type PanelAction =
  | { kind: "send"; text: string }
  | { kind: "approval"; approvalId: number; approve: boolean; remember: boolean; command: string }
  | { kind: "cancel" }
  | { kind: "openResource"; target: string; line?: number }
  | { kind: "previewResource"; target: string }
  | { kind: "ready" };
