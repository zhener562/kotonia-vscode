// Minimal, safe markdown → HTML and file:line linkifier, ported verbatim from
// the previous framework-free media/main.js. Input is HTML-escaped before any
// markup is applied, so the resulting string is safe to inject.

export function esc(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Handles fenced code, inline code, bold, italic, headings, lists, links. */
export function mdToHtml(raw: string): string {
  const fences: string[] = [];
  // Pull fenced code blocks out first so their contents aren't marked up.
  let text = String(raw).replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => {
    fences.push(code);
    return `__KOTONIA_FENCE_${fences.length - 1}__`;
  });
  text = esc(text);
  // inline code
  text = text.replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  // bold / italic (bold first)
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // links [text](url)
  text = text.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
  // headings
  text = text.replace(/^######\s+(.*)$/gm, "<h6>$1</h6>");
  text = text.replace(/^#####\s+(.*)$/gm, "<h5>$1</h5>");
  text = text.replace(/^####\s+(.*)$/gm, "<h4>$1</h4>");
  text = text.replace(/^###\s+(.*)$/gm, "<h3>$1</h3>");
  text = text.replace(/^##\s+(.*)$/gm, "<h2>$1</h2>");
  text = text.replace(/^#\s+(.*)$/gm, "<h1>$1</h1>");
  // unordered / ordered list items → wrap runs of <li> in <ul>
  text = text.replace(/^\s*[-*]\s+(.*)$/gm, "<li>$1</li>");
  text = text.replace(/^\s*\d+\.\s+(.*)$/gm, "<li>$1</li>");
  text = text.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>");
  // paragraphs / line breaks
  text = text.replace(/\n{2,}/g, "<br/><br/>").replace(/\n/g, "<br/>");
  // restore fenced code
  text = text.replace(/__KOTONIA_FENCE_(\d+)__/g, (_m, i: string) => `<pre>${esc(fences[+i])}</pre>`);
  return text;
}

// Clickable file:line references in shell output. The rendered <span> carries
// the file/line in data-* attributes; App wires the clicks via delegation.
const FILE_LINE_RE = /((?:[\w.\-]+\/)*[\w.\-]+\.[A-Za-z]\w*):(\d+)(?::(\d+))?/g;

export function linkifyFileRefs(escaped: string): string {
  return escaped.replace(FILE_LINE_RE, (m, file: string, line: string) => {
    return `<span class="filelink" data-file="${file}" data-line="${line}">${m}</span>`;
  });
}
