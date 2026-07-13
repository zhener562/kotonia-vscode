// Turn a single engine event into a rendered row (CSS class + inner HTML),
// ported from renderEngine() in the old media/main.js. Returns null for events
// handled specially by App (hello / done / approval_request).

import { esc, mdToHtml, linkifyFileRefs } from "./md";
import type { EngineMessage } from "./types";

export interface Row {
  cls: string;
  html: string;
}

export function engineToRow(msg: EngineMessage): Row | null {
  switch (msg.type) {
    case "iteration_start":
      return { cls: "iter", html: `<span class="dim">iter ${msg.iteration}/${msg.max}</span>` };
    case "llm_thinking":
      return { cls: "thinking", html: `<span class="dim">· thinking…</span>` };
    case "text":
      return { cls: "assistant-text", html: `<div class="assistant-answer">${mdToHtml(msg.text)}</div>` };
    case "bash":
      return { cls: "bash", html: `<span class="prompt">$</span> <code>${linkifyFileRefs(esc(msg.command))}</code>` };
    case "bash_skipped":
      return {
        cls: "skipped",
        html: `<span class="badge warn">skipped</span> ${esc(msg.reason)}<br/><code>${esc(msg.command)}</code>`,
      };
    case "observation": {
      const r = msg.result;
      const flags: string[] = [];
      if (r.timed_out) flags.push(`<span class="badge err">timed out</span>`);
      if (r.truncated) flags.push(`<span class="badge warn">truncated</span>`);
      const codeBadge = `<span class="badge ${r.exit_code === 0 ? "ok" : "err"}">exit ${r.exit_code}</span>`;
      const body = (r.combined || "").trim();
      const long = body.split("\n").length > 20;
      const pre = `<pre class="${long ? "collapsible" : ""}">${linkifyFileRefs(esc(body))}</pre>`;
      return { cls: "obs", html: `${codeBadge} ${flags.join(" ")}${body ? pre : ""}` };
    }
    case "inspect_image": {
      const ok = !msg.error;
      const title = ok ? "image attached" : "image error";
      const detail = ok
        ? `${esc(msg.path)} · ${Math.round((msg.size_bytes || 0) / 1024)} KB`
        : `${esc(msg.path || "(no path)")} · ${esc(msg.error || "unknown error")}`;
      return {
        cls: "inspect-image",
        html: `<span class="badge ${ok ? "ok" : "err"}">${title}</span> <span class="dim">${detail}</span>`,
      };
    }
    case "final":
      return { cls: "final", html: `<div class="final-answer">${mdToHtml(msg.answer)}</div>` };
    case "malformed":
      return { cls: "malformed", html: `<span class="dim">malformed output — retrying</span>` };
    case "error":
      return { cls: "error", html: `<span class="badge err">error</span> ${esc(msg.message)}` };
    default:
      // hello / done / approval_request are handled by App.
      return null;
  }
}
