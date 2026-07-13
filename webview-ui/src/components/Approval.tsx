import { useState } from "react";
import { postAction } from "../vscodeApi";
import { esc } from "../md";

export interface ApprovalData {
  approvalId: number;
  command: string;
  reason: string;
}

export function Approval({ data }: { data: ApprovalData }) {
  const [remember, setRemember] = useState(false);
  const [decided, setDecided] = useState<null | { approve: boolean; remember: boolean }>(null);

  const finish = (approve: boolean) => {
    if (decided) return;
    setDecided({ approve, remember });
    postAction({
      kind: "approval",
      approvalId: data.approvalId,
      approve,
      remember,
      command: data.command,
    });
  };

  return (
    <div className="row approval">
      <div className="approval-head">
        <span className="badge warn">approval</span> <span dangerouslySetInnerHTML={{ __html: esc(data.reason) }} />
      </div>
      <code dangerouslySetInnerHTML={{ __html: esc(data.command) }} />
      <div className="approval-actions">
        <label className="remember">
          <input
            type="checkbox"
            className="remember-cb"
            checked={remember}
            disabled={!!decided}
            onChange={(e) => setRemember(e.target.checked)}
          />{" "}
          remember for session
        </label>
        <button className="approve" disabled={!!decided} onClick={() => finish(true)}>
          Approve
        </button>
        <button className="deny secondary" disabled={!!decided} onClick={() => finish(false)}>
          Deny
        </button>
        {decided && (
          <span className="dim decided">
            {decided.approve ? "approved" : "denied"}
            {decided.remember ? " (remembered)" : ""}
          </span>
        )}
      </div>
    </div>
  );
}
