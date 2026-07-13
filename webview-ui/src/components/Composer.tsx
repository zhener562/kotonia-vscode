import { useRef, useState } from "react";

export function Composer({
  busy,
  onSend,
  onCancel,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    onSend(trimmed);
    setText("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline. Guard against the IME
    // composition Enter (confirming a Japanese/CJK candidate) so it doesn't
    // fire a send.
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    if (e.key === "Enter" && !e.shiftKey && !composing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={taRef}
        rows={2}
        value={text}
        disabled={busy}
        placeholder="Ask the agent to do something…  (Enter to send · Shift+Enter for newline)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-buttons">
        <button id="send" title="Send (Enter)" disabled={busy} onClick={submit}>
          Send
        </button>
        <button className="secondary" disabled={!busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
