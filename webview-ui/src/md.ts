// Minimal, safe markdown → HTML and file:line linkifier, ported verbatim from
// the previous framework-free media/main.js. Input is HTML-escaped before any
// markup is applied, so the resulting string is safe to inject.

export function esc(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

const RESOURCE_PREFIX = "\uE000KOTONIA_RESOURCE_";
const RESOURCE_SUFFIX = "_\uE001";
const URL_RE = /https?:\/\/[^\s<>()\[\]{}"'`]+/gu;
const WINDOWS_FILE_LINE_RE =
  /(?<![\p{L}\p{N}_])([A-Za-z]:\\[^\s'"`<>()\[\]{}]+):(\d+)(?::(\d+))?/gu;
const FILE_LINE_RE =
  /(?<![\p{L}\p{N}_:/.])((?:(?:~|\.)\/|\.\.\/|\/)?(?:[\p{L}\p{N}_.@+-]+\/)*[\p{L}\p{N}_.@+-]+\.[\p{L}\p{N}]+):(\d+)(?::(\d+))?/gu;
const WINDOWS_PATH_RE = /(?<![\p{L}\p{N}_])[A-Za-z]:\\[^\s'"`<>()\[\]{}]+/gu;
const EXPLICIT_PATH_RE =
  /(?<![\p{L}\p{N}_:/.])(?:~\/|\.{1,2}\/|\/)[^\s'"`<>()\\[\]{}]+/gu;
const BARE_PATH_RE =
  /(?<![\p{L}\p{N}_:/.])(?:[\p{L}\p{N}_.@+-]+\/)+[\p{L}\p{N}_.@+-]+\.[\p{L}\p{N}]+/gu;
const TRAILING_PUNCT_RE = /[.,:;!?、。)\]'"`]+$/u;

interface ExtractedResources {
  text: string;
  html: string[];
}

function resourceAnchor(target: string, label: string, line?: number): string {
  const lineAttr = line ? ` data-line="${line}"` : "";
  const title = /^https?:\/\//i.test(target)
    ? "ブラウザで開く"
    : "VS Codeで開く（Ctrl/Cmdクリックにも対応）";
  const anchor =
    `<a href="#" class="resource-link" data-target="${escAttr(target)}"${lineAttr}` +
    ` title="${title}">${esc(label)}</a>`;
  const preview =
    !/^https?:\/\//i.test(target) && /\.html?$/i.test(target)
      ? ` <button type="button" class="resource-preview" data-target="${escAttr(target)}"` +
        ` title="VS Code内でHTMLをプレビュー">▶ preview</button>`
      : "";
  return anchor + preview;
}

function extractResources(raw: string, markdownLinks: boolean): ExtractedResources {
  const html: string[] = [];
  const put = (value: string) => {
    const index = html.push(value) - 1;
    return `${RESOURCE_PREFIX}${index}${RESOURCE_SUFFIX}`;
  };
  const splitTail = (value: string): [string, string] => {
    const trailing = value.match(TRAILING_PUNCT_RE)?.[0] ?? "";
    return trailing
      ? [value.slice(0, -trailing.length), trailing]
      : [value, ""];
  };

  let text = raw;
  if (markdownLinks) {
    text = text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu,
      (_match, label: string, target: string) => put(resourceAnchor(target, label)),
    );
  }
  text = text.replace(URL_RE, (match) => {
    const [target, tail] = splitTail(match);
    return target ? put(resourceAnchor(target, target)) + tail : match;
  });
  text = text.replace(
    WINDOWS_FILE_LINE_RE,
    (match, target: string, line: string) =>
      put(resourceAnchor(target, match, Number.parseInt(line, 10))),
  );
  text = text.replace(
    FILE_LINE_RE,
    (match, target: string, line: string) =>
      put(resourceAnchor(target, match, Number.parseInt(line, 10))),
  );
  text = text.replace(WINDOWS_PATH_RE, (match) => {
    const [target, tail] = splitTail(match);
    return target ? put(resourceAnchor(target, target)) + tail : match;
  });
  text = text.replace(EXPLICIT_PATH_RE, (match) => {
    const [target, tail] = splitTail(match);
    return target ? put(resourceAnchor(target, target)) + tail : match;
  });
  text = text.replace(BARE_PATH_RE, (match) => put(resourceAnchor(match, match)));
  return { text, html };
}

function restoreResources(text: string, resources: string[]): string {
  const re = new RegExp(`${RESOURCE_PREFIX}(\\d+)${RESOURCE_SUFFIX}`, "gu");
  return text.replace(re, (_match, index: string) => resources[Number.parseInt(index, 10)] ?? "");
}

/** Handles fenced code, inline code, bold, italic, headings, lists, links. */
export function mdToHtml(raw: string): string {
  const fences: string[] = [];
  // Pull fenced code blocks out first so their contents aren't marked up.
  let text = String(raw).replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => {
    fences.push(code);
    return `__KOTONIA_FENCE_${fences.length - 1}__`;
  });
  const resources = extractResources(text, true);
  text = esc(resources.text);
  // inline code
  text = text.replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  // bold / italic (bold first)
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
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
  return restoreResources(text, resources.html);
}

/** Escape plain command/output text and make URLs and project paths clickable. */
export function linkifyPlainText(raw: string): string {
  const resources = extractResources(String(raw), false);
  return restoreResources(esc(resources.text), resources.html);
}
