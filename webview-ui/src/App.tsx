import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getState, postAction, setState as persistState } from "./vscodeApi";
import { engineToRow } from "./rows";
import { esc, mdToHtml } from "./md";
import { Approval, type ApprovalData } from "./components/Approval";
import { Composer } from "./components/Composer";
import { AvatarStage, type AvatarEvent } from "./components/AvatarStage";
import type { HostMessage, ProfileState } from "./types";

type Entry =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "row"; turnId: number; cls: string; html: string }
  | { id: number; kind: "approval"; turnId: number; data: ApprovalData };

interface Status {
  text: string;
  ready: boolean;
}

interface PersistedState {
  entries: Entry[];
  busy: boolean;
  status: Status;
  lastTurn: number;
  profile?: ProfileState;
}

const defaultProfile: ProfileState = {
  name: "Eve",
  tagline: "coding partner",
  systemPrompt: "",
  persona: "",
  avatarImage: "",
  outputMode: "avatar",
};

export function App() {
  const initial = useRef(getState<PersistedState>()).current;
  const [entries, setEntries] = useState<Entry[]>(initial?.entries ?? []);
  const [busy, setBusy] = useState(initial?.busy ?? false);
  const [status, setStatus] = useState<Status>(
    initial?.status ?? { text: "engine starting…", ready: false },
  );
  const [profile, setProfile] = useState<ProfileState>(initial?.profile ?? defaultProfile);
  const [avatarEvent, setAvatarEvent] = useState<AvatarEvent>();
  const [profileOpen, setProfileOpen] = useState(false);
  const avatarSeqRef = useRef(0);

  const logRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(Math.max(0, ...(initial?.entries ?? []).map((entry) => entry.id)));
  const lastTurnRef = useRef(initial?.lastTurn ?? -1);
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
          } else if (msg.type === "history_snapshot") {
            let turnId = 0;
            const restored: Entry[] = [];
            for (const message of msg.messages) {
              if (message.role === "user") {
                turnId += 1;
                restored.push({ id: nextId(), kind: "user", text: message.content });
              } else {
                restored.push({
                  id: nextId(),
                  kind: "row",
                  turnId,
                  cls: "final history-final",
                  html: `<div class="final-answer">${mdToHtml(message.content)}</div>`,
                });
              }
            }
            lastTurnRef.current = turnId;
            setEntries(restored);
            setBusy(false);
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
        case "profile":
          setProfile(data.profile);
          break;
        case "avatarBegin":
          setAvatarEvent({ seq: ++avatarSeqRef.current, kind: "begin" });
          break;
        case "avatarChunk":
          setAvatarEvent({
            seq: ++avatarSeqRef.current,
            kind: "chunk",
            chunkType: data.chunkType,
            data: data.data,
          });
          break;
        case "avatarEnd":
          setAvatarEvent({ seq: ++avatarSeqRef.current, kind: "end" });
          break;
        case "avatarStop":
          setAvatarEvent({ seq: ++avatarSeqRef.current, kind: "stop" });
          break;
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

  useEffect(() => {
    persistState<PersistedState>({
      entries,
      busy,
      status,
      lastTurn: lastTurnRef.current,
      profile,
    });
  }, [entries, busy, status, profile]);

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

  // Delegated click for paths/URLs injected via dangerouslySetInnerHTML.
  const onLogClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const preview = (e.target as HTMLElement).closest<HTMLElement>(".resource-preview");
    if (preview) {
      e.preventDefault();
      postAction({
        kind: "previewResource",
        target: preview.getAttribute("data-target") || "",
      });
      return;
    }
    const link = (e.target as HTMLElement).closest<HTMLElement>(".resource-link");
    if (!link) return;
    e.preventDefault();
    postAction({
      kind: "openResource",
      target: link.getAttribute("data-target") || "",
      line: link.hasAttribute("data-line")
        ? parseInt(link.getAttribute("data-line") || "1", 10)
        : undefined,
    });
  };

  return (
    <>
      <header className="conversation-header">
        <div className="profile-summary">
          {profile.avatarImage ? <img src={profile.avatarImage} alt="" /> : null}
          <div>
            <strong>{profile.name || "Kotonia"}</strong>
            <span>{profile.tagline}</span>
          </div>
        </div>
        <div className="mode-switch" role="group" aria-label="output mode">
          {(["text", "voice", "avatar"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={profile.outputMode === mode ? "active" : ""}
              onClick={() => {
                setProfile((current) => ({ ...current, outputMode: mode }));
                postAction({ kind: "setOutputMode", mode });
              }}
            >
              {mode === "text" ? "Text" : mode === "voice" ? "Voice" : "Avatar"}
            </button>
          ))}
        </div>
        <button type="button" className="profile-settings-button" onClick={() => setProfileOpen(true)}>
          Profile
        </button>
      </header>
      <AvatarStage
        image={profile.avatarImage}
        name={profile.name}
        mode={profile.outputMode}
        event={avatarEvent}
      />
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
      {profileOpen ? (
        <ProfileEditor
          profile={profile}
          onClose={() => setProfileOpen(false)}
          onSave={(next) => {
            setProfile((current) => ({ ...current, ...next }));
            postAction({ kind: "saveProfile", profile: next });
            setProfileOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function ProfileEditor({
  profile,
  onClose,
  onSave,
}: {
  profile: ProfileState;
  onClose: () => void;
  onSave: (profile: Pick<ProfileState, "name" | "tagline" | "systemPrompt" | "persona">) => void;
}) {
  const [draft, setDraft] = useState(profile);
  return (
    <div className="profile-modal" role="dialog" aria-modal="true" aria-label="Profile settings">
      <form
        className="profile-editor"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(draft);
        }}
      >
        <h2>Profile</h2>
        <label>
          表示名
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label>
          肩書き
          <input value={draft.tagline} onChange={(e) => setDraft({ ...draft, tagline: e.target.value })} />
        </label>
        <label>
          追加システムプロンプト
          <textarea
            rows={6}
            value={draft.systemPrompt}
            onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
          />
        </label>
        <label>
          人格・話し方
          <textarea
            rows={6}
            value={draft.persona}
            onChange={(e) => setDraft({ ...draft, persona: e.target.value })}
          />
        </label>
        <div className="profile-image-row">
          {profile.avatarImage ? <img src={profile.avatarImage} alt="" /> : null}
          <button type="button" onClick={() => postAction({ kind: "pickProfileImage" })}>
            顔画像を選ぶ
          </button>
        </div>
        <p className="profile-hint">プロンプトの変更は次の新規チャットから反映されます。</p>
        <div className="profile-actions">
          <button type="button" onClick={onClose}>キャンセル</button>
          <button type="submit" className="primary">保存</button>
        </div>
      </form>
    </div>
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
