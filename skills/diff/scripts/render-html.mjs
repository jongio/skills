import { randomBytes } from "node:crypto";
import { parseDiffPatch } from "./parse-diff.mjs";

// Zero external CDNs: all parsing, syntax highlighting, and Split/Unified rendering
// run locally inside the self-contained script using safe DOM APIs.
export const CDN_ASSETS = Object.freeze({});

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function serializeJsonForScript(value) {
  const raw = JSON.stringify(value ?? null);
  return raw
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function coerceNonNegativeInt(value) {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

export function buildCspDirectives({ nonce, serveMode }) {
  const connectSrc = serveMode ? "'self'" : "'none'";
  const baseDirectives = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    `connect-src ${connectSrc}`,
    "img-src data:",
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  return {
    metaCsp: baseDirectives.join("; "),
    headerCsp: [...baseDirectives, "frame-ancestors 'none'"].join("; "),
  };
}

export function renderDiffHtml({
  diff = "",
  title = "Diff",
  additions,
  deletions,
  fileCount,
  canonicalFiles: explicitCanonicalFiles,
  serveMode = false,
  csrfToken = "",
  nonce: explicitNonce,
} = {}) {
  const parsedDiff = parseDiffPatch(String(diff ?? ""));
  const safeAdds = additions === undefined ? parsedDiff.additions : coerceNonNegativeInt(additions);
  const safeDels = deletions === undefined ? parsedDiff.deletions : coerceNonNegativeInt(deletions);
  const safeFiles = fileCount === undefined ? parsedDiff.fileCount : coerceNonNegativeInt(fileCount);

  if (Array.isArray(explicitCanonicalFiles)) {
    for (let i = 0; i < parsedDiff.files.length; i += 1) {
      if (typeof explicitCanonicalFiles[i] === "string" && explicitCanonicalFiles[i]) {
        parsedDiff.files[i].canonicalPath = explicitCanonicalFiles[i];
      }
    }
  }

  const nonce = typeof explicitNonce === "string" && /^[A-Za-z0-9+/=_-]{16,64}$/.test(explicitNonce)
    ? explicitNonce
    : randomBytes(16).toString("base64");
  const { metaCsp, headerCsp } = buildCspDirectives({ nonce, serveMode: Boolean(serveMode) });

  const safeTitle = escapeHtml(title);
  const safeNonceAttr = escapeHtml(nonce);
  const parsedJson = serializeJsonForScript(parsedDiff);
  const csrfJson = serializeJsonForScript(serveMode ? String(csrfToken) : "");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="referrer" content="no-referrer" />
  <meta name="color-scheme" content="light dark" />
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(metaCsp)}" />
  <title>Diff: ${safeTitle}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{
      --color-fg-default:#1f2328;
      --color-fg-muted:#59636e;
      --color-fg-accent:#0969da;
      --color-fg-success:#1a7f37;
      --color-fg-danger:#d1242f;
      --color-fg-attention:#9a6700;
      --color-bg-default:#ffffff;
      --color-bg-subtle:#f6f8fa;
      --color-bg-inset:#eff2f5;
      --color-border-default:#d1d9e0;
      --color-border-muted:#d8dee4;
      --color-neutral-muted:rgba(129,139,152,0.14);
      --color-accent-subtle:rgba(9,105,218,0.12);
      --diff-add-line:#dafbe1;
      --diff-add-num:#aceebb;
      --diff-add-word:#82e596;
      --diff-del-line:#ffebe9;
      --diff-del-num:#ffcecb;
      --diff-del-word:#ffaba8;
      --diff-hunk-bg:#ddf4ff;
      --diff-hunk-fg:#0969da;
      --diff-empty-bg:#f6f8fa;
      --tok-kw:#cf222e;
      --tok-str:#0a3069;
      --tok-cmt:#59636e;
      --tok-num:#0550ae;
      --tok-prop:#116329;
      --split-left-pct:50%;
      --split-right-pct:50%;
    }
    @media (prefers-color-scheme: dark){
      :root{
        --color-fg-default:#f0f6fc;
        --color-fg-muted:#8b949e;
        --color-fg-accent:#58a6ff;
        --color-fg-success:#3fb950;
        --color-fg-danger:#f85149;
        --color-fg-attention:#d29922;
        --color-bg-default:#0d1117;
        --color-bg-subtle:#161b22;
        --color-bg-inset:#21262d;
        --color-border-default:#30363d;
        --color-border-muted:#21262d;
        --color-neutral-muted:rgba(110,118,129,0.22);
        --color-accent-subtle:rgba(56,139,253,0.16);
        --diff-add-line:rgba(46,160,67,0.16);
        --diff-add-num:rgba(46,160,67,0.32);
        --diff-add-word:rgba(46,160,67,0.45);
        --diff-del-line:rgba(248,81,73,0.16);
        --diff-del-num:rgba(248,81,73,0.32);
        --diff-del-word:rgba(248,81,73,0.45);
        --diff-hunk-bg:rgba(56,139,253,0.14);
        --diff-hunk-fg:#58a6ff;
        --diff-empty-bg:#161b22;
        --tok-kw:#ff7b72;
        --tok-str:#a5d6ff;
        --tok-cmt:#8b949e;
        --tok-num:#79c0ff;
        --tok-prop:#7ee787;
      }
    }
    body{
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;
      font-size:13px;line-height:1.5;
      color:var(--color-fg-default);background:var(--color-bg-default);
    }
    .diff-header{
      position:sticky;top:0;z-index:100;
      background:var(--color-bg-subtle);
      border-bottom:1px solid var(--color-border-default);
      padding:8px 14px;display:flex;align-items:center;gap:10px;min-height:44px;flex-wrap:wrap;
    }
    .diff-header-title{display:flex;align-items:center;gap:8px;font-size:13px;min-width:0}
    .diff-header-title strong{font-weight:600}
    .diff-stat-add{color:var(--color-fg-success);font-weight:600}
    .diff-stat-del{color:var(--color-fg-danger);font-weight:600}
    .diff-stat-bar{display:flex;gap:2px;align-items:center}
    .diff-stat-block{width:8px;height:8px;border-radius:2px}
    .diff-stat-block.add{background:var(--color-fg-success)}
    .diff-stat-block.del{background:var(--color-fg-danger)}
    .comment-badge{
      display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;
      color:var(--color-fg-accent);background:var(--color-accent-subtle);
      border-radius:999px;padding:2px 9px;
    }
    .filter-input{
      font:inherit;font-size:12px;padding:4px 8px;border-radius:6px;
      border:1px solid var(--color-border-default);background:var(--color-bg-default);
      color:var(--color-fg-default);width:170px;
    }
    .segmented-control{
      display:inline-flex;border:1px solid var(--color-border-default);border-radius:6px;overflow:hidden;
    }
    .segmented-control.push-right{margin-left:auto}
    .segmented-control button{
      background:var(--color-bg-subtle);color:var(--color-fg-default);
      border:none;border-right:1px solid var(--color-border-default);
      padding:5px 11px;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;
    }
    .segmented-control button:last-child{border-right:none}
    .segmented-control button:hover{background:var(--color-bg-inset)}
    .segmented-control button.active{background:var(--color-bg-default);font-weight:600}
    .toggle-tree-btn{
      background:var(--color-bg-default);border:1px solid var(--color-border-default);
      border-radius:6px;padding:4px 9px;cursor:pointer;color:var(--color-fg-muted);font-size:12px;
    }
    .btn-review-done{
      background:#238636;color:#fff;border:none;border-radius:6px;
      padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;
    }
    .btn-review-done:hover{background:#2ea043}
    .btn-review-done.done{background:var(--color-fg-muted);cursor:default}
    .diff-layout{display:flex;min-height:calc(100vh - 44px)}
    .file-tree{
      width:260px;min-width:140px;max-width:50vw;flex-shrink:0;
      background:var(--color-bg-default);border-right:1px solid var(--color-border-default);
      overflow-y:auto;position:sticky;top:44px;height:calc(100vh - 44px);font-size:12px;
    }
    .file-tree.hidden{display:none}
    .file-tree-header{
      padding:8px 12px;font-weight:600;border-bottom:1px solid var(--color-border-default);
      display:flex;justify-content:space-between;align-items:center;
    }
    .file-tree-list,.file-tree-dir-children{list-style:none;padding:2px 0;margin:0}
    .file-tree-dir.collapsed > .file-tree-dir-children{display:none}
    .file-tree-dir-header,.file-tree-item{
      display:flex;align-items:center;gap:6px;padding:3px 10px;cursor:pointer;
      color:var(--color-fg-default);text-decoration:none;user-select:none;
    }
    .file-tree-dir-header:hover,.file-tree-item:hover{background:var(--color-neutral-muted)}
    .file-tree-item.active{background:var(--color-accent-subtle);color:var(--color-fg-accent)}
    .file-tree-item.viewed{opacity:0.65}
    .file-tree-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .resize-handle{
      width:5px;min-width:5px;flex-shrink:0;cursor:col-resize;background:transparent;
    }
    .resize-handle:hover,.resize-handle.dragging{background:var(--color-fg-accent)}
    .file-tree.hidden + .resize-handle{display:none}
    .diff-pane{flex:1;min-width:0;padding:12px;display:flex;flex-direction:column;gap:14px}
    .file-card{
      border:1px solid var(--color-border-default);border-radius:6px;overflow:hidden;
      background:var(--color-bg-default);
    }
    .file-card-header{
      background:var(--color-bg-subtle);border-bottom:1px solid var(--color-border-default);
      padding:6px 12px;display:flex;align-items:center;gap:8px;font-size:12px;
    }
    .file-card.collapsed .file-card-body{display:none}
    .file-path{
      font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
      font-weight:600;word-break:break-all;
    }
    .status-pill{
      font-size:11px;padding:1px 6px;border-radius:999px;font-weight:600;
      border:1px solid var(--color-border-default);color:var(--color-fg-muted);
    }
    .file-card-meta{margin-left:auto;display:flex;align-items:center;gap:10px}
    .viewed-label{display:inline-flex;align-items:center;gap:4px;cursor:pointer;color:var(--color-fg-muted)}
    .hunk-bar{
      background:var(--diff-hunk-bg);color:var(--diff-hunk-fg);
      font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
      font-size:12px;padding:4px 12px;border-top:1px solid var(--color-border-muted);
      border-bottom:1px solid var(--color-border-muted);
    }
    .diff-table{
      width:100%;border-collapse:collapse;table-layout:fixed;
      font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
      font-size:12px;line-height:20px;
    }
    .ln-cell{
      width:50px;min-width:50px;max-width:50px;text-align:right;padding:0 6px;
      color:var(--color-fg-muted);background:var(--color-bg-subtle);
      border-right:1px solid var(--color-border-muted);user-select:none;vertical-align:top;
      position:relative;
    }
    .serve-mode .ln-cell.commentable{cursor:pointer}
    .serve-mode .ln-cell.commentable:hover{color:var(--color-fg-accent);font-weight:600}
    .ln-unified{width:88px;min-width:88px;max-width:88px;display:table-cell}
    .ln-part{display:inline-block;width:48%;text-align:right}
    .code-cell{
      padding:0 10px;vertical-align:top;white-space:pre;overflow-x:auto;
      color:var(--color-fg-default);background:var(--color-bg-default);
    }
    body.wrap-on .code-cell{white-space:pre-wrap;word-break:break-word;overflow-x:visible}
    .row-add .code-cell,.cell-add.code-cell{background:var(--diff-add-line)}
    .row-add .ln-cell,.cell-add.ln-cell{background:var(--diff-add-num);color:var(--color-fg-default)}
    .row-del .code-cell,.cell-del.code-cell{background:var(--diff-del-line)}
    .row-del .ln-cell,.cell-del.ln-cell{background:var(--diff-del-num);color:var(--color-fg-default)}
    .cell-empty{background:var(--diff-empty-bg)}
    .word-add{background:var(--diff-add-word);border-radius:2px}
    .word-del{background:var(--diff-del-word);border-radius:2px}
    .tok-kw{color:var(--tok-kw);font-weight:500}
    .tok-str{color:var(--tok-str)}
    .tok-cmt{color:var(--tok-cmt);font-style:italic}
    .tok-num{color:var(--tok-num)}
    .tok-prop{color:var(--tok-prop)}
    .split-col-left{width:var(--split-left-pct)}
    .split-col-right{width:var(--split-right-pct)}
    .comment-form-cell,.comment-display-cell{
      background:var(--color-bg-subtle);padding:8px 12px;
      border-top:1px solid var(--color-border-default);border-bottom:1px solid var(--color-border-default);
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    }
    .comment-form,.comment-bubble{
      max-width:720px;background:var(--color-bg-default);
      border:1px solid var(--color-border-default);border-radius:6px;padding:10px 12px;position:relative;
    }
    .comment-bubble{border-left:3px solid var(--color-fg-accent);margin-bottom:6px}
    .comment-textarea{
      width:100%;min-height:68px;padding:8px;font:inherit;font-size:13px;
      border:1px solid var(--color-border-default);border-radius:6px;
      background:var(--color-bg-default);color:var(--color-fg-default);resize:vertical;
    }
    .comment-form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
    .btn-cancel-comment,.btn-submit-comment{
      padding:4px 12px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;font-family:inherit;
    }
    .btn-cancel-comment{background:var(--color-bg-subtle);border:1px solid var(--color-border-default);color:var(--color-fg-default)}
    .btn-submit-comment{background:#238636;border:none;color:#fff}
    .comment-bubble-meta{font-size:11px;color:var(--color-fg-muted);margin-bottom:4px}
    .comment-bubble-body{white-space:pre-wrap;word-break:break-word;font-size:13px}
    .btn-delete-comment{
      position:absolute;top:6px;right:8px;background:none;border:none;
      color:var(--color-fg-muted);cursor:pointer;font-size:15px;padding:2px 5px;
    }
    .btn-delete-comment:hover{color:var(--color-fg-danger)}
  </style>
</head>
<body class="${serveMode ? "serve-mode" : ""}">
  <header class="diff-header">
    <div class="diff-header-title">
      <strong>${safeTitle}</strong>
      <span>(${safeFiles} changed files, <span class="diff-stat-add">+${safeAdds}</span> / <span class="diff-stat-del">-${safeDels}</span>)</span>
    </div>
    <div class="diff-stat-bar" id="stat-bar"></div>
    ${serveMode ? '<span class="comment-badge" id="comment-badge" style="display:none">0 comments</span>' : ""}
    <input type="search" id="file-filter" class="filter-input push-right" placeholder="Filter files..." aria-label="Filter changed files" />
    <div class="segmented-control" role="tablist" aria-label="Diff view mode">
      <button type="button" id="btn-split" class="active" role="tab" aria-selected="true">Split</button>
      <button type="button" id="btn-unified" role="tab" aria-selected="false">Unified</button>
    </div>
    <div class="segmented-control" role="tablist" aria-label="Line wrapping">
      <button type="button" id="btn-wrap-off" class="active" role="tab" aria-selected="true">No wrap</button>
      <button type="button" id="btn-wrap-on" role="tab" aria-selected="false">Wrap</button>
    </div>
    <button type="button" class="toggle-tree-btn" id="btn-toggle-tree" title="Toggle file tree">Files</button>
    ${serveMode ? '<button type="button" class="btn-review-done" id="btn-done">Submit Review</button>' : ""}
  </header>

  <div class="diff-layout">
    <nav class="file-tree" id="file-tree" aria-label="Changed files">
      <div class="file-tree-header">
        <span>Files</span>
        <span id="file-tree-count">${safeFiles}</span>
      </div>
      <ul class="file-tree-list" id="file-tree-list"></ul>
    </nav>
    <div class="resize-handle" id="resize-handle" title="Drag to resize file tree"></div>
    <main class="diff-pane" id="diff-container"></main>
  </div>

  <script nonce="${safeNonceAttr}">
    (function() {
      "use strict";
      var SERVE_MODE = ${Boolean(serveMode)};
      var CSRF_TOKEN = ${csrfJson};
      if (SERVE_MODE && window.location.pathname.indexOf("/s/") === 0 && window.history && typeof window.history.replaceState === "function") {
        try {
          window.history.replaceState(null, "", "/");
        } catch (_e) {}
      }

      var PARSED = ${parsedJson};
      var currentView = "side-by-side";
      var filterQuery = "";
      var comments = [];
      var viewedSet = new Set();
      var collapsedSet = new Set();
      var reviewDone = false;

      var KEYWORDS = new Set([
        "async","await","break","case","catch","class","const","continue","def","default",
        "delete","do","elif","else","enum","export","extends","false","finally","fn","for",
        "from","func","function","if","impl","import","in","interface","let","match","mut",
        "new","nil","None","null","package","pub","return","self","static","struct","super",
        "switch","this","throw","true","True","False","try","type","typeof","undefined","use",
        "var","void","while","with","yield"
      ]);

      function tokenizeLine(str, lang) {
        if (!str || lang === "text" || str.length > 1000) return [{ k: "", v: str || "" }];
        var out = [];
        var plain = "";
        function flush() { if (plain) { out.push({ k: "", v: plain }); plain = ""; } }
        var i = 0;
        var len = str.length;
        while (i < len) {
          var ch = str[i];
          if ((lang === "js" || lang === "go" || lang === "rust" || lang === "css") && ch === "/" && str[i + 1] === "/") {
            flush(); out.push({ k: "tok-cmt", v: str.slice(i) }); break;
          }
          if ((lang === "py" || lang === "sh" || lang === "yaml") && ch === "#") {
            flush(); out.push({ k: "tok-cmt", v: str.slice(i) }); break;
          }
          if (ch === '"' || ch === "'" || (lang === "js" && ch === "\`")) {
            flush();
            var q = ch;
            var j = i + 1;
            while (j < len) {
              if (str[j] === "\\\\") { j += 2; continue; }
              if (str[j] === q) { j += 1; break; }
              j += 1;
            }
            out.push({ k: "tok-str", v: str.slice(i, j) });
            i = j;
            continue;
          }
          var c = str.charCodeAt(i);
          var isAlpha = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
          if (isAlpha) {
            var k = i + 1;
            while (k < len) {
              var cc = str.charCodeAt(k);
              if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 95 || cc === 36) k += 1;
              else break;
            }
            var word = str.slice(i, k);
            if (KEYWORDS.has(word)) { flush(); out.push({ k: "tok-kw", v: word }); }
            else { plain += word; }
            i = k;
            continue;
          }
          if (c >= 48 && c <= 57) {
            flush();
            var n = i + 1;
            while (n < len && /[0-9._xXa-fA-F]/.test(str[n])) n += 1;
            out.push({ k: "tok-num", v: str.slice(i, n) });
            i = n;
            continue;
          }
          plain += ch;
          i += 1;
        }
        flush();
        return out;
      }

      function appendTokens(container, text, lang) {
        var toks = tokenizeLine(text, lang);
        for (var i = 0; i < toks.length; i += 1) {
          if (toks[i].k) {
            var sp = document.createElement("span");
            sp.className = toks[i].k;
            sp.textContent = toks[i].v;
            container.appendChild(sp);
          } else {
            container.appendChild(document.createTextNode(toks[i].v));
          }
        }
      }

      function pairSplitRows(lines) {
        var rows = [];
        var i = 0;
        while (i < lines.length) {
          var item = lines[i];
          if (item.type === "context") {
            rows.push({ kind: "pair", left: item, right: item });
            i += 1;
            continue;
          }
          if (item.type === "meta") {
            rows.push({ kind: "meta", text: item.text });
            i += 1;
            continue;
          }
          var dels = [];
          var adds = [];
          while (i < lines.length && lines[i].type === "del") { dels.push(lines[i]); i += 1; }
          while (i < lines.length && lines[i].type === "add") { adds.push(lines[i]); i += 1; }
          var count = Math.max(dels.length, adds.length);
          for (var m = 0; m < count; m += 1) {
            rows.push({ kind: "pair", left: dels[m] || null, right: adds[m] || null });
          }
        }
        return rows;
      }

      (function buildStatBar() {
        var bar = document.getElementById("stat-bar");
        if (!bar) return;
        var total = (${safeAdds}) + (${safeDels});
        if (total <= 0) return;
        var addBlocks = Math.round(((${safeAdds}) / total) * 5);
        for (var i = 0; i < 5; i += 1) {
          var b = document.createElement("span");
          b.className = "diff-stat-block " + (i < addBlocks ? "add" : "del");
          bar.appendChild(b);
        }
      })();

      function filteredFiles() {
        var q = filterQuery.trim().toLowerCase();
        if (!q) return PARSED.files;
        return PARSED.files.filter(function(f) {
          return (f.canonicalPath || "").toLowerCase().indexOf(q) !== -1 ||
                 (f.displayPath || "").toLowerCase().indexOf(q) !== -1;
        });
      }

      function buildTree(files) {
        var list = document.getElementById("file-tree-list");
        var countEl = document.getElementById("file-tree-count");
        list.replaceChildren();
        if (countEl) countEl.textContent = String(files.length);

        var root = new Map();
        files.forEach(function(f) {
          var p = f.canonicalPath || f.displayPath || "";
          var parts = p.split("/").filter(Boolean);
          var cursor = root;
          for (var i = 0; i < parts.length - 1; i += 1) {
            var seg = parts[i];
            if (!cursor.has(seg) || !cursor.get(seg).children) {
              cursor.set(seg, { children: new Map(), file: null });
            }
            cursor = cursor.get(seg).children;
          }
          var leaf = parts[parts.length - 1] || p;
          cursor.set(leaf, { children: null, file: f });
        });

        function renderMap(mapNode, ul, depth) {
          var entries = Array.from(mapNode.entries()).sort(function(a, b) {
            var ad = Boolean(a[1].children);
            var bd = Boolean(b[1].children);
            if (ad !== bd) return ad ? -1 : 1;
            return a[0].localeCompare(b[0]);
          });
          entries.forEach(function(pair) {
            var name = pair[0];
            var val = pair[1];
            var pad = (8 + depth * 14) + "px";
            if (val.children) {
              var dirLi = document.createElement("li");
              dirLi.className = "file-tree-dir";
              var hdr = document.createElement("div");
              hdr.className = "file-tree-dir-header";
              hdr.style.paddingLeft = pad;
              hdr.textContent = name + "/";
              hdr.addEventListener("click", function() { dirLi.classList.toggle("collapsed"); });
              var subUl = document.createElement("ul");
              subUl.className = "file-tree-dir-children";
              renderMap(val.children, subUl, depth + 1);
              dirLi.appendChild(hdr);
              dirLi.appendChild(subUl);
              ul.appendChild(dirLi);
            } else if (val.file) {
              var li = document.createElement("li");
              var a = document.createElement("a");
              a.href = "#file-card-" + val.file.index;
              a.className = "file-tree-item" + (viewedSet.has(val.file.canonicalPath) ? " viewed" : "");
              a.style.paddingLeft = pad;
              var span = document.createElement("span");
              span.className = "file-tree-name";
              span.textContent = name;
              a.appendChild(span);
              a.addEventListener("click", function(e) {
                e.preventDefault();
                var card = document.getElementById("file-card-" + val.file.index);
                if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
              });
              li.appendChild(a);
              ul.appendChild(li);
            }
          });
        }

        renderMap(root, list, 0);
      }

      function createLineCell(filePath, lineNum, side, extraClass) {
        var td = document.createElement("td");
        td.className = "ln-cell" + (extraClass ? " " + extraClass : "");
        if (lineNum !== null && lineNum !== undefined) {
          td.textContent = String(lineNum);
          if (filePath) {
            td.classList.add("commentable");
            td.dataset.file = filePath;
            td.dataset.line = String(lineNum);
            td.dataset.side = side;
          }
        }
        return td;
      }

      function renderFiles() {
        var container = document.getElementById("diff-container");
        container.replaceChildren();
        var visible = filteredFiles();
        buildTree(visible);

        visible.forEach(function(file) {
          var card = document.createElement("section");
          card.className = "file-card" + (collapsedSet.has(file.canonicalPath) ? " collapsed" : "");
          card.id = "file-card-" + file.index;
          card.dataset.canonicalFile = file.canonicalPath || "";

          var hdr = document.createElement("div");
          hdr.className = "file-card-header";

          var pathEl = document.createElement("span");
          pathEl.className = "file-path";
          pathEl.textContent = file.displayPath || file.canonicalPath;
          hdr.appendChild(pathEl);

          if (file.status && file.status !== "modified") {
            var pill = document.createElement("span");
            pill.className = "status-pill";
            pill.textContent = file.status;
            hdr.appendChild(pill);
          }

          var meta = document.createElement("div");
          meta.className = "file-card-meta";

          var statSpan = document.createElement("span");
          var addS = document.createElement("span");
          addS.className = "diff-stat-add";
          addS.textContent = "+" + file.additions;
          var delS = document.createElement("span");
          delS.className = "diff-stat-del";
          delS.textContent = " -" + file.deletions;
          statSpan.appendChild(addS);
          statSpan.appendChild(delS);
          meta.appendChild(statSpan);

          if (file.canonicalPath) {
            var vLabel = document.createElement("label");
            vLabel.className = "viewed-label";
            var chk = document.createElement("input");
            chk.type = "checkbox";
            chk.checked = viewedSet.has(file.canonicalPath);
            chk.addEventListener("change", function() {
              if (chk.checked) {
                viewedSet.add(file.canonicalPath);
                collapsedSet.add(file.canonicalPath);
              } else {
                viewedSet.delete(file.canonicalPath);
                collapsedSet.delete(file.canonicalPath);
              }
              renderFiles();
            });
            vLabel.appendChild(chk);
            vLabel.appendChild(document.createTextNode("Viewed"));
            meta.appendChild(vLabel);
          }

          hdr.appendChild(meta);
          card.appendChild(hdr);

          var body = document.createElement("div");
          body.className = "file-card-body";

          if (file.isBinary) {
            var binMsg = document.createElement("div");
            binMsg.className = "hunk-bar";
            binMsg.textContent = "Binary file changed";
            body.appendChild(binMsg);
          } else {
            file.hunks.forEach(function(hunk) {
              var hBar = document.createElement("div");
              hBar.className = "hunk-bar";
              hBar.textContent = hunk.header + (hunk.section ? " " + hunk.section : "");
              body.appendChild(hBar);

              var tbl = document.createElement("table");
              tbl.className = "diff-table";
              var tbody = document.createElement("tbody");

              if (currentView === "side-by-side") {
                var colgroup = document.createElement("colgroup");
                var c1 = document.createElement("col"); c1.style.width = "50px";
                var c2 = document.createElement("col"); c2.className = "split-col-left";
                var c3 = document.createElement("col"); c3.style.width = "50px";
                var c4 = document.createElement("col"); c4.className = "split-col-right";
                colgroup.appendChild(c1); colgroup.appendChild(c2); colgroup.appendChild(c3); colgroup.appendChild(c4);
                tbl.appendChild(colgroup);

                pairSplitRows(hunk.lines).forEach(function(row) {
                  var tr = document.createElement("tr");
                  if (row.kind === "meta") {
                    var mtd = document.createElement("td");
                    mtd.colSpan = 4;
                    mtd.className = "code-cell cell-empty";
                    mtd.textContent = row.text;
                    tr.appendChild(mtd);
                    tbody.appendChild(tr);
                    return;
                  }
                  var l = row.left;
                  var r = row.right;
                  if (l && l.oldLine !== null) {
                    tr.dataset.leftLine = String(l.oldLine);
                  }
                  if (r && r.newLine !== null) {
                    tr.dataset.rightLine = String(r.newLine);
                  }

                  var lLn = createLineCell(file.canonicalPath, l ? l.oldLine : null, "left", l && l.type === "del" ? "cell-del" : (l ? "" : "cell-empty"));
                  var lCode = document.createElement("td");
                  lCode.className = "code-cell " + (l ? (l.type === "del" ? "cell-del" : "") : "cell-empty");
                  if (l) appendTokens(lCode, (l.type === "del" ? "-" : " ") + l.text, file.language);

                  var rLn = createLineCell(file.canonicalPath, r ? r.newLine : null, "right", r && r.type === "add" ? "cell-add" : (r ? "" : "cell-empty"));
                  var rCode = document.createElement("td");
                  rCode.className = "code-cell " + (r ? (r.type === "add" ? "cell-add" : "") : "cell-empty");
                  if (r) appendTokens(rCode, (r.type === "add" ? "+" : " ") + r.text, file.language);

                  tr.appendChild(lLn);
                  tr.appendChild(lCode);
                  tr.appendChild(rLn);
                  tr.appendChild(rCode);
                  tbody.appendChild(tr);
                });
              } else {
                hunk.lines.forEach(function(ln) {
                  var tr = document.createElement("tr");
                  if (ln.type === "add") tr.className = "row-add";
                  else if (ln.type === "del") tr.className = "row-del";

                  if (ln.oldLine !== null) tr.dataset.leftLine = String(ln.oldLine);
                  if (ln.newLine !== null) tr.dataset.rightLine = String(ln.newLine);

                  var lnTd = document.createElement("td");
                  lnTd.className = "ln-cell ln-unified";
                  var p1 = document.createElement("span");
                  p1.className = "ln-part";
                  if (ln.oldLine !== null) {
                    p1.textContent = String(ln.oldLine);
                    if (file.canonicalPath) {
                      p1.classList.add("commentable");
                      p1.dataset.file = file.canonicalPath;
                      p1.dataset.line = String(ln.oldLine);
                      p1.dataset.side = "left";
                    }
                  }
                  var p2 = document.createElement("span");
                  p2.className = "ln-part";
                  if (ln.newLine !== null) {
                    p2.textContent = String(ln.newLine);
                    if (file.canonicalPath) {
                      p2.classList.add("commentable");
                      p2.dataset.file = file.canonicalPath;
                      p2.dataset.line = String(ln.newLine);
                      p2.dataset.side = "right";
                    }
                  }
                  if (file.canonicalPath && (ln.newLine !== null || ln.oldLine !== null)) {
                    lnTd.classList.add("commentable");
                    lnTd.dataset.file = file.canonicalPath;
                    lnTd.dataset.line = String(ln.newLine !== null ? ln.newLine : ln.oldLine);
                    lnTd.dataset.side = ln.newLine !== null ? "right" : "left";
                  }
                  lnTd.appendChild(p1);
                  lnTd.appendChild(p2);

                  var codeTd = document.createElement("td");
                  codeTd.className = "code-cell";
                  var prefix = ln.type === "add" ? "+" : (ln.type === "del" ? "-" : (ln.type === "meta" ? "" : " "));
                  appendTokens(codeTd, prefix + ln.text, file.language);

                  tr.appendChild(lnTd);
                  tr.appendChild(codeTd);
                  tbody.appendChild(tr);
                });
              }

              tbl.appendChild(tbody);
              body.appendChild(tbl);
            });
          }

          card.appendChild(body);
          container.appendChild(card);
        });

        if (SERVE_MODE) renderAllComments();
      }

      document.getElementById("btn-split").addEventListener("click", function() {
        currentView = "side-by-side";
        document.getElementById("btn-split").classList.add("active");
        document.getElementById("btn-unified").classList.remove("active");
        renderFiles();
      });
      document.getElementById("btn-unified").addEventListener("click", function() {
        currentView = "line-by-line";
        document.getElementById("btn-unified").classList.add("active");
        document.getElementById("btn-split").classList.remove("active");
        renderFiles();
      });
      document.getElementById("btn-wrap-off").addEventListener("click", function() {
        document.body.classList.remove("wrap-on");
        document.getElementById("btn-wrap-off").classList.add("active");
        document.getElementById("btn-wrap-on").classList.remove("active");
      });
      document.getElementById("btn-wrap-on").addEventListener("click", function() {
        document.body.classList.add("wrap-on");
        document.getElementById("btn-wrap-on").classList.add("active");
        document.getElementById("btn-wrap-off").classList.remove("active");
      });
      document.getElementById("btn-toggle-tree").addEventListener("click", function() {
        document.getElementById("file-tree").classList.toggle("hidden");
      });
      document.getElementById("file-filter").addEventListener("input", function(e) {
        filterQuery = e.target.value || "";
        renderFiles();
      });

      (function initSidebarResize() {
        var handle = document.getElementById("resize-handle");
        var tree = document.getElementById("file-tree");
        if (!handle || !tree) return;
        var dragging = false;
        var startX = 0;
        var startW = 0;
        handle.addEventListener("mousedown", function(e) {
          e.preventDefault();
          dragging = true;
          startX = e.clientX;
          startW = tree.offsetWidth;
          handle.classList.add("dragging");
        });
        document.addEventListener("mousemove", function(e) {
          if (!dragging) return;
          var w = Math.max(140, Math.min(window.innerWidth * 0.5, startW + (e.clientX - startX)));
          tree.style.width = w + "px";
        });
        document.addEventListener("mouseup", function() {
          if (!dragging) return;
          dragging = false;
          handle.classList.remove("dragging");
        });
      })();

      function apiFetch(url, options) {
        var opts = options ? Object.assign({}, options) : {};
        var headers = Object.assign({}, opts.headers || {});
        headers["X-Diff-Token"] = CSRF_TOKEN;
        opts.headers = headers;
        opts.credentials = "same-origin";
        return fetch(url, opts);
      }

      function closeCommentForm() {
        var existing = document.querySelector(".comment-form-row");
        if (existing) existing.remove();
      }

      function openCommentForm(tr, file, line, side) {
        closeCommentForm();
        var cols = Math.max(1, tr.querySelectorAll("td").length);
        var formRow = document.createElement("tr");
        formRow.className = "comment-form-row";
        var td = document.createElement("td");
        td.colSpan = cols;
        td.className = "comment-form-cell";

        var wrap = document.createElement("div");
        wrap.className = "comment-form";
        var ta = document.createElement("textarea");
        ta.className = "comment-textarea";
        ta.placeholder = "Comment on " + file + ":" + line + " (" + side + ")";
        var actions = document.createElement("div");
        actions.className = "comment-form-actions";

        var cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "btn-cancel-comment";
        cancelBtn.textContent = "Cancel";

        var addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "btn-submit-comment";
        addBtn.dataset.file = file;
        addBtn.dataset.line = line;
        addBtn.dataset.side = side;
        addBtn.textContent = "Add comment";

        actions.appendChild(cancelBtn);
        actions.appendChild(addBtn);
        wrap.appendChild(ta);
        wrap.appendChild(actions);
        td.appendChild(wrap);
        formRow.appendChild(td);
        tr.insertAdjacentElement("afterend", formRow);
        ta.focus();
      }

      function findAnchorRow(file, line, side) {
        var cards = document.querySelectorAll(".file-card");
        for (var i = 0; i < cards.length; i += 1) {
          if (cards[i].dataset.canonicalFile !== file) continue;
          var attr = side === "left" ? "data-left-line" : "data-right-line";
          var match = cards[i].querySelector("tr[" + attr + '="' + CSS.escape(String(line)) + '"]');
          if (match) return match;
        }
        return null;
      }

      function updateBadge() {
        var badge = document.getElementById("comment-badge");
        if (!badge) return;
        if (comments.length === 0) {
          badge.style.display = "none";
        } else {
          badge.style.display = "inline-flex";
          badge.textContent = comments.length + (comments.length === 1 ? " comment" : " comments");
        }
      }

      function renderAllComments() {
        document.querySelectorAll(".comment-display-row").forEach(function(r) { r.remove(); });
        comments.forEach(function(c) {
          var anchorTr = findAnchorRow(c.file, c.line, c.side);
          if (!anchorTr) return;
          var cols = Math.max(1, anchorTr.querySelectorAll("td").length);
          var row = document.createElement("tr");
          row.className = "comment-display-row";
          var td = document.createElement("td");
          td.colSpan = cols;
          td.className = "comment-display-cell";

          var bubble = document.createElement("div");
          bubble.className = "comment-bubble";
          var meta = document.createElement("div");
          meta.className = "comment-bubble-meta";
          meta.textContent = c.file + ":" + c.line + " (" + c.side + ")";
          var body = document.createElement("div");
          body.className = "comment-bubble-body";
          body.textContent = c.body;
          bubble.appendChild(meta);
          bubble.appendChild(body);

          if (!reviewDone) {
            var del = document.createElement("button");
            del.type = "button";
            del.className = "btn-delete-comment";
            del.dataset.id = c.id;
            del.title = "Delete comment";
            del.textContent = "x";
            bubble.appendChild(del);
          }

          td.appendChild(bubble);
          row.appendChild(td);
          anchorTr.insertAdjacentElement("afterend", row);
        });
      }

      function submitComment(btn) {
        var formRow = btn.closest(".comment-form-row");
        if (!formRow) return;
        var ta = formRow.querySelector(".comment-textarea");
        var text = ta ? ta.value.trim() : "";
        if (!text) return;
        var payload = {
          file: btn.dataset.file,
          line: btn.dataset.line,
          side: btn.dataset.side,
          body: text
        };
        apiFetch("/api/comments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(saved) {
            if (saved && saved.id) {
              comments.push(saved);
              closeCommentForm();
              renderAllComments();
              updateBadge();
            }
          })
          .catch(function() {});
      }

      function deleteComment(id) {
        apiFetch("/api/comments/" + encodeURIComponent(id), { method: "DELETE" })
          .then(function(r) {
            if (r.ok) {
              comments = comments.filter(function(c) { return c.id !== id; });
              renderAllComments();
              updateBadge();
            }
          })
          .catch(function() {});
      }

      function finishReview() {
        if (reviewDone) return;
        apiFetch("/api/done", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        })
          .then(function(r) {
            if (!r.ok) return;
            reviewDone = true;
            closeCommentForm();
            var doneBtn = document.getElementById("btn-done");
            if (doneBtn) {
              doneBtn.textContent = "Review Submitted";
              doneBtn.classList.add("done");
              doneBtn.disabled = true;
            }
            renderAllComments();
          })
          .catch(function() {});
      }

      renderFiles();

      if (SERVE_MODE) {
        apiFetch("/api/comments")
          .then(function(r) { return r.ok ? r.json() : []; })
          .then(function(data) {
            if (Array.isArray(data)) {
              comments = data;
              renderAllComments();
              updateBadge();
            }
          })
          .catch(function() {});

        var hb = setInterval(function() {
          if (reviewDone) { clearInterval(hb); return; }
          apiFetch("/api/heartbeat", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: "{}" }).catch(function() {});
        }, 15000);

        document.addEventListener("click", function(e) {
          var target = e.target;
          if (!(target instanceof Element)) return;
          var anchor = target.closest(".commentable");
          if (anchor && !reviewDone && anchor.dataset.file && anchor.dataset.line && anchor.dataset.side) {
            var tr = anchor.closest("tr");
            if (tr) {
              e.preventDefault();
              openCommentForm(tr, anchor.dataset.file, anchor.dataset.line, anchor.dataset.side);
            }
            return;
          }
          if (target.closest(".btn-cancel-comment")) { closeCommentForm(); return; }
          var sub = target.closest(".btn-submit-comment");
          if (sub) { submitComment(sub); return; }
          var del = target.closest(".btn-delete-comment");
          if (del && del.dataset.id) { deleteComment(del.dataset.id); return; }
          if (target.id === "btn-done") { finishReview(); return; }
        });
      }
    })();
  </script>
</body>
</html>
`;

  return {
    html,
    headerCsp,
    metaCsp,
    nonce,
  };
}
