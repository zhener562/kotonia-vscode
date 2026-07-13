import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { postAction } from "./vscodeApi";
import { engineToRow } from "./rows";
import { esc } from "./md";
import { Approval, type ApprovalData } from "./components/Approval";
import { Composer } from "./components/Composer";
import type { HostMessage } from "./types";

type Entry =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "row"; turnId: number; cls: string; html: string }
  | { id: number; kind: "approval"; turnId: number; data: ApprovalData };

interface Status {
  text: string;
  ready: boolean;
}

export function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ text: "engine starting…", ready: false });

  const logRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  const lastTurnRef = useRef(-1);
  const nextId = () => ++idRef.current;

  const addRow = (turnId: number, cls: string, html: string) =>
    setEntries((es) => [...es, { id: nextId(), kind: "row", turnId, cls, html }]);

  // ---- host → webview messages --------------------------------------------
  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>) => {
      const data = event.data;
      switch (data.kind) {
        case "engine": {
          const msg = data.msg;
          if ("turn_id" in msg) lastTurnRef.current = msg.turn_id;
          if (msg.type === "hello") {
            const tag = msg.is_worktree ? "worktree" : "in-place";
            setStatus({
              text:
                `${msg.model} · ${msg.backend} · ${msg.tool_mode} · ${msg.approval_mode} · ${tag}` +
                (msg.session_id ? ` · session ${msg.session_id}` : ""),
              ready: true,
            });
          } else if (msg.type === "approval_request") {
            setEntries((es) => [
              ...es,
              {
                id: nextId(),
                kind: "approval",
                turnId: msg.turn_id,
                data: { approvalId: msg.approval_id, command: msg.command, reason: msg.reason },
              },
            ]);
          } else if (msg.type === "done") {
            addRow(
              msg.turn_id,
              "done",
              `<span class="dim">— done after ${msg.iterations} iter · ${msg.success ? "✓" : "✗"}</span>`,
            );
            setBusy(false);
          } else {
            const row = engineToRow(msg);
            if (row) addRow(msg.turn_id, row.cls, row.html);
          }
          break;
        }
        case "busy":
          setBusy(data.busy);
          break;
        case "note": {
          const turnId = typeof data.turnId === "number" ? data.turnId : lastTurnRef.current;
          addRow(turnId, "note", `<span class="dim">ℹ ${esc(data.text)}</span>`);
          break;
        }
        case "reset":
          setEntries([]);
          setBusy(false);
          lastTurnRef.current = -1;
          break;
      }
    };
    window.addEventListener("message", onMessage);
    postAction({ kind: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Keep the log pinned to the newest content, matching the old scrollToEnd().
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const send = (text: string) => {
    setEntries((es) => [...es, { id: nextId(), kind: "user", text }]);
    setBusy(true);
    postAction({ kind: "send", text });
  };

  // Delegated click for the file:line spans injected via dangerouslySetInnerHTML.
  const onLogClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>(".filelink");
    if (!link) return;
    postAction({
      kind: "open",
      file: link.getAttribute("data-file") || "",
      line: parseInt(link.getAttribute("data-line") || "1", 10),
    });
  };

  return (
    <>
      <div className={status.ready ? "status ready" : "status"}>{status.text}</div>
      <div className="log" ref={logRef} onClick={onLogClick}>
        {groupTurns(entries).map((group) => (
          <div key={group.key} className={group.user ? "turn user-turn" : "turn"}>
            {group.items.map((entry) => (
              <EntryView key={entry.id} entry={entry} />
            ))}
          </div>
        ))}
      </div>
      <Composer busy={busy} onSend={send} onCancel={() => postAction({ kind: "cancel" })} />
    </>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  if (entry.kind === "user") {
    return <div className="row user">{entry.text}</div>;
  }
  if (entry.kind === "approval") {
    return <Approval data={entry.data} />;
  }
  return <div className={"row " + entry.cls} dangerouslySetInnerHTML={{ __html: entry.html }} />;
}

interface Group {
  user: boolean;
  key: number;
  items: Entry[];
}

// Group consecutive non-user entries that share a turn id into one .turn block;
// each user bubble is its own group and breaks the run (mirrors the old
// currentTurn logic).
function groupTurns(entries: Entry[]): Group[] {
  const groups: Group[] = [];
  let cur: Group | null = null;
  let curTurn = NaN;
  for (const e of entries) {
    if (e.kind === "user") {
      groups.push({ user: true, key: e.id, items: [e] });
      cur = null;
      continue;
    }
    if (!cur || e.turnId !== curTurn) {
      cur = { user: false, key: e.id, items: [] };
      curTurn = e.turnId;
      groups.push(cur);
    }
    cur.items.push(e);
  }
  return groups;
}
