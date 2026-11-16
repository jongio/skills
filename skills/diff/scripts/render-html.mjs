import { randomBytes } from "node:crypto";
import { parseUnifiedDiff } from "./diff-spec.mjs";

export const CDN_ASSETS = Object.freeze({
  diff2htmlCss: {
    url: "https://cdn.jsdelivr.net/npm/diff2html@3.4.56/bundles/css/diff2html.min.css",
    integrity: "sha384-PdRCG/+r1waybtXfuDB9Kmv2h7AGoN6WaTZ5OF+ctPeR9BGne0FaKRQnUeGV4nDL",
  },
  highlightCss: {
    url: "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.12.0/build/styles/github.min.css",
    integrity: "sha384-eFTL69TLRZTkNfYZOLM+G04821K1qZao/4QLJbet1pP4tcF+fdXq/9CdqAbWRl/L",
  },
  diff2htmlJs: {
    url: "https://cdn.jsdelivr.net/npm/diff2html@3.4.56/bundles/js/diff2html.min.js",
    integrity: "sha384-X6/ZXflvpFfCMcPkCC2/ydjb6KJqTsoQq2eGjzB5LfWgXs3VsjbfaEKKVWsfQIAy",
  },
  highlightJs: {
    url: "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.12.0/build/highlight.min.js",
    integrity: "sha384-wjfDDhOPPdjtva8vWBhWeVprSpmxisEu5aYT3q1JyACqXpdKpo3PWZTMVq24MBix",
  },
  diff2htmlUiJs: {
    url: "https://cdn.jsdelivr.net/npm/diff2html@3.4.56/bundles/js/diff2html-ui.min.js",
    integrity: "sha384-NRd5i/CwvZ20mJEQt3yaDU1LeU+tu0bqyVYojXi8d7Lf1B0/TIs2K3FTvlf8aO7p",
  },
});

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
    "style-src 'unsafe-inline' https://cdn.jsdelivr.net",
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
  const needsDiffParse =
    additions === undefined ||
    deletions === undefined ||
    fileCount === undefined ||
    !Array.isArray(explicitCanonicalFiles);
  const parsedStats = needsDiffParse ? parseUnifiedDiff(diff) : null;
  const safeAdds = additions === undefined ? parsedStats.additions : coerceNonNegativeInt(additions);
  const safeDels = deletions === undefined ? parsedStats.deletions : coerceNonNegativeInt(deletions);
  const safeFiles = fileCount === undefined ? parsedStats.fileCount : coerceNonNegativeInt(fileCount);
  const canonicalFiles = Array.isArray(explicitCanonicalFiles)
    ? explicitCanonicalFiles.map((item) => String(item ?? ""))
    : parsedStats.files.map((f) => f.canonicalPath);

  const nonce = typeof explicitNonce === "string" && /^[A-Za-z0-9+/=_-]{16,64}$/.test(explicitNonce)
    ? explicitNonce
    : randomBytes(16).toString("base64");
  const { metaCsp, headerCsp } = buildCspDirectives({ nonce, serveMode: Boolean(serveMode) });

  const safeTitle = escapeHtml(title);
  const safeNonceAttr = escapeHtml(nonce);
  const diffJson = serializeJsonForScript(String(diff));
  const csrfJson = serializeJsonForScript(serveMode ? String(csrfToken) : "");
  const canonicalFilesJson = serializeJsonForScript(canonicalFiles);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="referrer" content="no-referrer" />
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(metaCsp)}" />
  <title>Diff: ${safeTitle}</title>
  <link rel="stylesheet" href="${CDN_ASSETS.diff2htmlCss.url}" integrity="${CDN_ASSETS.diff2htmlCss.integrity}" crossorigin="anonymous" referrerpolicy="no-referrer" />
  <link rel="stylesheet" href="${CDN_ASSETS.highlightCss.url}" integrity="${CDN_ASSETS.highlightCss.integrity}" crossorigin="anonymous" referrerpolicy="no-referrer" />
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{
      --color-fg-default:#1f2328;
      --color-fg-muted:#636c76;
      --color-fg-subtle:#6e7781;
      --color-fg-accent:#0969da;
      --color-fg-success:#1a7f37;
      --color-fg-danger:#d1242f;
      --color-bg-default:#ffffff;
      --color-bg-subtle:#f6f8fa;
      --color-bg-inset:#eff2f5;
      --color-border-default:#d1d9e0;
      --color-border-muted:#d8dee4;
      --color-neutral-muted:rgba(175,184,193,0.2);
      --color-accent-subtle:rgba(9,105,218,0.1);
      --diffBlob-addition-bgColor-line:#e6ffec;
      --diffBlob-addition-bgColor-num:#ccffd8;
      --diffBlob-addition-bgColor-word:#abf2bc;
      --diffBlob-deletion-bgColor-line:#ffebe9;
      --diffBlob-deletion-bgColor-num:#ffd7d5;
      --diffBlob-deletion-bgColor-word:#ffcecb;
      --diffBlob-hunk-bgColor:#f1f8ff;
      --diffBlob-hunk-fgColor:#54aeff;
      --diffBlob-expander-hoverBgColor:#ddf4ff;
    }
    body{
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji";
      font-size:14px;
      line-height:1.5;
      color:var(--color-fg-default);
      background:var(--color-bg-default);
    }
    .diff-header{
      position:sticky;top:0;z-index:100;
      background:var(--color-bg-default);
      border-bottom:1px solid var(--color-border-default);
      padding:6px 16px;
      display:flex;align-items:center;gap:12px;
      min-height:40px;
    }
    .diff-header-title{
      font-size:14px;font-weight:400;color:var(--color-fg-default);
      display:flex;align-items:center;gap:6px;
    }
    .diff-header-title strong{font-weight:600}
    .diff-stat-add{color:var(--color-fg-success);font-weight:600}
    .diff-stat-del{color:var(--color-fg-danger);font-weight:600}
    .diff-stat-bar{display:flex;gap:1px;align-items:center;margin-left:4px}
    .diff-stat-block{width:8px;height:8px;border-radius:2px}
    .diff-stat-block.add{background:#2da44e}
    .diff-stat-block.del{background:#cf222e}
    .segmented-control{
      display:inline-flex;border:1px solid var(--color-border-default);border-radius:6px;
      overflow:hidden;
    }
    .segmented-control.push-right{margin-left:auto}
    .segmented-control button{
      background:var(--color-bg-subtle);color:var(--color-fg-default);
      border:none;border-right:1px solid var(--color-border-default);
      padding:5px 12px;font-size:12px;font-weight:500;
      cursor:pointer;font-family:inherit;line-height:1;
      transition:background .1s;
    }
    .segmented-control button:last-child{border-right:none}
    .segmented-control button:hover{background:var(--color-bg-inset)}
    .segmented-control button.active{
      background:var(--color-bg-default);
      box-shadow:inset 0 0 0 1px var(--color-border-default);
      font-weight:600;
    }
    .btn-review-done{
      background:#1a7f37;color:#fff;border:none;border-radius:6px;
      padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;
      font-family:inherit;transition:background .15s;
    }
    .btn-review-done:hover{background:#15803d}
    .btn-review-done.done{background:var(--color-fg-muted);cursor:default}
    .btn-review-done:disabled{opacity:0.65;cursor:default}
    .comment-badge{
      display:inline-flex;align-items:center;gap:4px;
      font-size:12px;font-weight:600;color:var(--color-fg-accent);
      background:var(--color-accent-subtle);border-radius:10px;
      padding:2px 8px;
    }
    .diff-layout{display:flex;min-height:calc(100vh - 40px)}
    .resize-handle{
      width:5px;min-width:5px;flex-shrink:0;
      cursor:col-resize;
      background:var(--color-border-default);
      transition:background .15s;
      position:relative;z-index:5;
    }
    .resize-handle:hover,.resize-handle.dragging{background:var(--color-fg-accent)}
    .file-tree{
      width:260px;min-width:100px;max-width:50vw;
      background:var(--color-bg-default);
      overflow-y:auto;position:sticky;top:40px;
      height:calc(100vh - 40px);
      font-size:12px;
    }
    .file-tree-header{
      padding:12px 16px 8px;font-size:12px;font-weight:600;
      color:var(--color-fg-default);
      border-bottom:1px solid var(--color-border-default);
      display:flex;align-items:center;justify-content:space-between;
    }
    .file-tree-list{list-style:none;padding:4px 0}
    .file-tree-item{
      display:flex;align-items:center;gap:4px;
      padding:2px 8px;cursor:pointer;color:var(--color-fg-default);
      text-decoration:none;border-radius:0;
      transition:background .1s;font-size:12px;line-height:20px;
    }
    .file-tree-item:hover{background:var(--color-neutral-muted)}
    .file-tree-item.active{background:var(--color-accent-subtle);color:var(--color-fg-accent)}
    .file-tree-icon{flex-shrink:0;width:16px;height:16px;fill:var(--color-fg-muted)}
    .file-tree-name{
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      flex:1;min-width:0;
    }
    .file-tree-dir{list-style:none;padding:0;margin:0}
    .file-tree-dir-header{
      display:flex;align-items:center;gap:4px;
      padding:2px 8px;cursor:pointer;color:var(--color-fg-default);
      font-size:12px;line-height:20px;user-select:none;
      transition:background .1s;
    }
    .file-tree-dir-header:hover{background:var(--color-neutral-muted)}
    .file-tree-chevron{
      flex-shrink:0;width:16px;height:16px;
      fill:var(--color-fg-muted);
      transition:transform .1s;
    }
    .file-tree-dir.collapsed > .file-tree-dir-children{display:none}
    .file-tree-dir.collapsed > .file-tree-dir-header .file-tree-chevron{transform:rotate(-90deg)}
    .file-tree-dir-children{list-style:none;padding:0;margin:0}
    .file-tree-dir-name{font-weight:600;color:var(--color-fg-default)}
    .toggle-tree-btn{
      background:none;border:1px solid var(--color-border-default);
      border-radius:6px;padding:4px 8px;cursor:pointer;
      color:var(--color-fg-muted);font-size:12px;
      display:flex;align-items:center;gap:4px;
    }
    .toggle-tree-btn:hover{background:var(--color-bg-subtle)}
    .file-tree.hidden{display:none}
    .diff-pane{flex:1;min-width:0;overflow-x:auto;padding:0}
    .d2h-wrapper{background:transparent!important;border:none!important;margin:0!important}
    .d2h-file-wrapper{
      border:1px solid var(--color-border-default)!important;
      border-radius:0!important;
      margin-bottom:0!important;
      overflow:hidden!important;
      background:var(--color-bg-default)!important;
      border-top:none!important;
    }
    .d2h-file-wrapper:first-child{border-top:1px solid var(--color-border-default)!important}
    .d2h-file-header{
      position:sticky!important;top:40px!important;z-index:10!important;
      background:var(--color-bg-subtle)!important;
      border-bottom:1px solid var(--color-border-default)!important;
      padding:5px 10px!important;
      display:flex!important;align-items:center!important;
    }
    .d2h-file-name-wrapper{display:flex!important;align-items:center!important;gap:8px!important}
    .d2h-file-name{
      color:var(--color-fg-default)!important;
      font-weight:600!important;
      font-size:12px!important;
      font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace!important;
    }
    .d2h-tag{
      font-size:11px!important;
      padding:1px 6px!important;
      border-radius:6px!important;
      font-weight:600!important;
      border:none!important;
    }
    .d2h-tag.d2h-moved{background:var(--color-accent-subtle)!important;color:var(--color-fg-accent)!important}
    .d2h-tag.d2h-changed{background:#fff8c5!important;color:#9a6700!important}
    .d2h-tag.d2h-added{background:var(--diffBlob-addition-bgColor-num)!important;color:var(--color-fg-success)!important}
    .d2h-tag.d2h-deleted{background:var(--diffBlob-deletion-bgColor-num)!important;color:var(--color-fg-danger)!important}
    .d2h-tag.d2h-renamed{background:var(--color-accent-subtle)!important;color:var(--color-fg-accent)!important}
    .d2h-file-stats{margin-left:auto!important}
    .d2h-lines-added{color:var(--color-fg-success)!important;font-size:12px!important;font-weight:600!important}
    .d2h-lines-deleted{color:var(--color-fg-danger)!important;font-size:12px!important;font-weight:600!important}
    .d2h-diff-table{
      width:100%!important;
      border-collapse:collapse!important;
      border-spacing:0!important;
      font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace!important;
      font-size:12px!important;
      line-height:20px!important;
      table-layout:fixed!important;
    }
    .d2h-file-diff{border:none!important;overflow-x:auto!important;overflow-y:hidden!important}
    .d2h-diff-tbody tr{border:none!important;height:20px!important}
    .d2h-diff-tbody tr td{border:none!important;vertical-align:top!important;padding:0!important;height:20px!important}
    .d2h-code-linenumber,
    .d2h-code-side-linenumber{
      background:var(--color-bg-subtle)!important;
      color:var(--color-fg-muted)!important;
      font-size:12px!important;
      line-height:20px!important;
      height:20px!important;
      width:56px!important;
      min-width:56px!important;
      max-width:56px!important;
      text-align:right!important;
      padding:0 5px!important;
      border-right:1px solid var(--color-border-default)!important;
      border-left:none!important;
      border-top:none!important;
      border-bottom:none!important;
      user-select:none!important;
      vertical-align:top!important;
      position:static!important;
      display:table-cell!important;
      direction:ltr!important;
      overflow:hidden!important;
    }
    .d2h-code-side-linenumber{width:44px!important;min-width:44px!important;max-width:44px!important}
    .d2h-code-linenumber .line-num1,
    .d2h-code-linenumber .line-num2{
      display:inline-block!important;
      width:46%!important;
      text-align:right!important;
    }
    .d2h-code-linenumber::after,
    .d2h-code-side-linenumber::after{content:none!important}
    .d2h-code-line,.d2h-code-side-line{
      background:var(--color-bg-default)!important;
      color:var(--color-fg-default)!important;
      font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace!important;
      font-size:12px!important;
      line-height:20px!important;
      height:20px!important;
      padding:0 0 0 10px!important;
      width:auto!important;
      display:table-cell!important;
      position:static!important;
      overflow:hidden!important;
    }
    .d2h-code-line-ctn{
      font-size:12px!important;
      line-height:20px!important;
      padding:0!important;
      white-space:pre!important;
      display:inline!important;
    }
    .d2h-code-line-prefix{
      display:inline!important;
      user-select:none!important;
      color:var(--color-fg-muted)!important;
      width:20px!important;
      min-width:20px!important;
    }
    .d2h-ins .d2h-code-line,
    .d2h-ins .d2h-code-side-line,
    .d2h-code-line.d2h-ins,
    .d2h-code-side-line.d2h-ins,
    tr.d2h-ins td.d2h-code-line-ctn,
    .d2h-ins{
      background:var(--diffBlob-addition-bgColor-line)!important;
    }
    .d2h-ins .d2h-code-linenumber,
    .d2h-ins .d2h-code-side-linenumber,
    .d2h-code-linenumber.d2h-ins,
    .d2h-code-side-linenumber.d2h-ins{
      background:var(--diffBlob-addition-bgColor-num)!important;
    }
    .d2h-ins .d2h-code-line-ctn,
    .d2h-code-line.d2h-ins .d2h-code-line-ctn,
    .d2h-code-side-line.d2h-ins .d2h-code-line-ctn{
      background:var(--diffBlob-addition-bgColor-line)!important;
    }
    .d2h-ins ins,.d2h-code-line.d2h-ins ins,.d2h-code-side-line.d2h-ins ins{
      background:var(--diffBlob-addition-bgColor-word)!important;
      text-decoration:none!important;
      border-radius:3px;
      padding:1px 0;
    }
    .d2h-del .d2h-code-line,
    .d2h-del .d2h-code-side-line,
    .d2h-code-line.d2h-del,
    .d2h-code-side-line.d2h-del,
    tr.d2h-del td.d2h-code-line-ctn,
    .d2h-del{
      background:var(--diffBlob-deletion-bgColor-line)!important;
    }
    .d2h-del .d2h-code-linenumber,
    .d2h-del .d2h-code-side-linenumber,
    .d2h-code-linenumber.d2h-del,
    .d2h-code-side-linenumber.d2h-del{
      background:var(--diffBlob-deletion-bgColor-num)!important;
    }
    .d2h-del .d2h-code-line-ctn,
    .d2h-code-line.d2h-del .d2h-code-line-ctn,
    .d2h-code-side-line.d2h-del .d2h-code-line-ctn{
      background:var(--diffBlob-deletion-bgColor-line)!important;
    }
    .d2h-del del,.d2h-code-line.d2h-del del,.d2h-code-side-line.d2h-del del{
      background:var(--diffBlob-deletion-bgColor-word)!important;
      text-decoration:none!important;
      border-radius:3px;
      padding:1px 0;
    }
    .d2h-info{
      background:var(--diffBlob-hunk-bgColor)!important;
      color:var(--diffBlob-hunk-fgColor)!important;
      border-top:1px solid var(--color-border-default)!important;
      border-bottom:none!important;
      font-size:12px!important;
      line-height:20px!important;
      padding:4px 16px!important;
    }
    .d2h-info .d2h-code-line-ctn{
      background:var(--diffBlob-hunk-bgColor)!important;
      color:var(--color-fg-muted)!important;
    }
    .d2h-emptyplaceholder,
    .d2h-code-side-emptyplaceholder{
      background:var(--color-bg-subtle)!important;
      border:none!important;
      height:20px!important;
      line-height:20px!important;
      padding:0!important;
    }
    .d2h-file-list-wrapper{display:none!important}
    .d2h-files-diff{display:flex!important;width:100%!important;position:relative!important}
    .d2h-file-side-diff{
      border:none!important;
      flex:1!important;
      min-width:0!important;
      vertical-align:top!important;
      display:block!important;
      overflow-x:auto!important;
      overflow-y:hidden!important;
      width:auto!important;
    }
    .d2h-file-side-diff + .d2h-file-side-diff{border-left:none!important}
    .diff-pane-handle{
      width:5px;min-width:5px;flex-shrink:0;
      cursor:col-resize;
      background:var(--color-border-default);
      transition:background .15s;
      z-index:5;
    }
    .diff-pane-handle:hover,.diff-pane-handle.dragging{background:var(--color-fg-accent)}
    pre code.hljs{background:transparent!important;padding:0!important}
    .hljs{background:transparent!important}
    .wrap-on .d2h-code-line-ctn{white-space:pre-wrap!important;word-break:break-all!important}
    .wrap-on .d2h-code-line,.wrap-on .d2h-code-side-line{overflow:hidden!important}
    .serve-mode .d2h-code-linenumber:not(.d2h-info):not(.d2h-emptyplaceholder),
    .serve-mode .d2h-code-side-linenumber:not(.d2h-info):not(.d2h-code-side-emptyplaceholder){
      cursor:pointer;transition:background .1s;
    }
    .serve-mode .d2h-code-linenumber:not(.d2h-info):not(.d2h-emptyplaceholder):hover,
    .serve-mode .d2h-code-side-linenumber:not(.d2h-info):not(.d2h-code-side-emptyplaceholder):hover{
      background:var(--diffBlob-expander-hoverBgColor)!important;
    }
    .comment-form-cell{padding:0!important;background:var(--color-bg-default)!important;border:none!important}
    .comment-form{
      background:var(--color-bg-default);
      border:1px solid var(--color-border-default);
      border-radius:6px;
      padding:12px;margin:8px 16px;
      box-shadow:0 1px 3px rgba(31,35,40,0.04);
    }
    .comment-textarea{
      width:100%;resize:vertical;
      border:1px solid var(--color-border-default);border-radius:6px;
      padding:8px 12px;
      font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
      font-size:12px;line-height:1.5;
      background:var(--color-bg-default);color:var(--color-fg-default);
      transition:border-color .15s,box-shadow .15s;
    }
    .comment-textarea:focus{
      outline:none;border-color:var(--color-fg-accent);
      box-shadow:0 0 0 3px rgba(9,105,218,0.3);
    }
    .comment-form-actions{display:flex;gap:8px;margin-top:8px;justify-content:flex-end}
    .btn-submit-comment{
      background:var(--color-fg-accent);color:#fff;border:none;border-radius:6px;
      padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;
      font-family:inherit;transition:background .15s;
    }
    .btn-submit-comment:hover{background:#0860ca}
    .btn-cancel-comment{
      background:transparent;color:var(--color-fg-muted);
      border:1px solid var(--color-border-default);border-radius:6px;
      padding:5px 12px;font-size:12px;font-weight:500;cursor:pointer;
      font-family:inherit;transition:background .15s;
    }
    .btn-cancel-comment:hover{background:var(--color-bg-subtle)}
    .comment-bubble-cell{padding:0!important;background:var(--color-bg-default)!important;border:none!important}
    .comment-bubble-inner{
      background:var(--color-bg-default);
      border:1px solid var(--color-border-default);
      border-radius:6px;
      padding:12px 32px 12px 16px;margin:8px 16px;font-size:13px;
      color:var(--color-fg-default);line-height:1.5;
      position:relative;animation:slideIn .15s ease;
    }
    .comment-bubble-meta{
      font-size:11px;color:var(--color-fg-muted);margin-bottom:4px;
      font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
    }
    .comment-bubble-body{white-space:pre-wrap;word-wrap:break-word}
    .btn-delete-comment{
      position:absolute;top:8px;right:8px;
      background:none;border:none;color:var(--color-fg-muted);cursor:pointer;
      font-size:16px;line-height:1;padding:2px 4px;border-radius:3px;
      transition:color .15s,background .15s;
    }
    .btn-delete-comment:hover{color:var(--color-fg-danger);background:rgba(209,36,47,0.08)}
    .comment-indicator{
      position:absolute;left:2px;top:50%;transform:translateY(-50%);
      width:6px;height:6px;border-radius:50%;background:var(--color-fg-accent);
      pointer-events:none;
    }
    @keyframes slideIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
    @media(max-width:768px){
      .file-tree,.resize-handle{display:none}
      .diff-header{flex-wrap:wrap;gap:8px}
    }
    .file-tree.hidden + .resize-handle{display:none}
  </style>
</head>
<body class="${serveMode ? "serve-mode" : ""}">
  <div class="diff-header">
    <div class="diff-header-title">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8.75 1.75V5a.75.75 0 0 1-1.5 0V1.75a.75.75 0 0 1 1.5 0ZM8.75 14.25V11a.75.75 0 0 1 1.5 0v3.25a.75.75 0 0 1-1.5 0Z"/><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/></svg>
      <span>Showing <strong>${safeFiles} changed files</strong> with <span class="diff-stat-add">+${safeAdds}</span> additions and <span class="diff-stat-del">-${safeDels}</span> deletions</span>
    </div>
    <div class="diff-stat-bar" id="stat-bar"></div>
    ${serveMode ? '<span class="comment-badge" id="comment-badge" style="display:none">0 comments</span>' : ""}
    <div class="segmented-control push-right" role="tablist" aria-label="Diff view mode">
      <button type="button" id="btn-split" class="active" role="tab" aria-selected="true">Split</button>
      <button type="button" id="btn-unified" role="tab" aria-selected="false">Unified</button>
    </div>
    <div class="segmented-control" role="tablist" aria-label="Line wrapping">
      <button type="button" id="btn-wrap-off" class="active" role="tab" aria-selected="true">No wrap</button>
      <button type="button" id="btn-wrap-on" role="tab" aria-selected="false">Wrap</button>
    </div>
    <button type="button" class="toggle-tree-btn" id="btn-toggle-tree" title="Toggle file tree">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75ZM1.5 2.75a.25.25 0 0 1 .25-.25H5c.09 0 .16.04.2.1l.9 1.2c.33.44.85.7 1.4.7h6.75a.25.25 0 0 1 .25.25v8.5a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25V2.75Z"/></svg>
    </button>
    ${serveMode ? '<button type="button" class="btn-review-done" id="btn-done">Submit Review</button>' : ""}
  </div>

  <div class="diff-layout">
    <nav class="file-tree" id="file-tree" aria-label="Changed files">
      <div class="file-tree-header">
        <span>Files</span>
        <span style="color:var(--color-fg-muted);font-weight:400">${safeFiles}</span>
      </div>
      <ul class="file-tree-list" id="file-tree-list"></ul>
    </nav>
    <div class="resize-handle" id="resize-handle"></div>
    <main class="diff-pane" id="diff-container"></main>
  </div>

  <script nonce="${safeNonceAttr}" src="${CDN_ASSETS.diff2htmlJs.url}" integrity="${CDN_ASSETS.diff2htmlJs.integrity}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
  <script nonce="${safeNonceAttr}" src="${CDN_ASSETS.highlightJs.url}" integrity="${CDN_ASSETS.highlightJs.integrity}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
  <script nonce="${safeNonceAttr}" src="${CDN_ASSETS.diff2htmlUiJs.url}" integrity="${CDN_ASSETS.diff2htmlUiJs.integrity}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
  <script nonce="${safeNonceAttr}">
    (function() {
      "use strict";
      var SERVE_MODE = ${Boolean(serveMode)};
      var CSRF_TOKEN = ${csrfJson};
      var diffString = ${diffJson};
      var canonicalFiles = ${canonicalFilesJson};
      var currentView = "side-by-side";
      var comments = [];
      var reviewDone = false;
      var totalAdds = ${safeAdds};
      var totalDels = ${safeDels};
      var SVG_NS = "http://www.w3.org/2000/svg";
      var POSITIVE_LINE_RE = /^[1-9][0-9]*$/;

      function createSvgIcon(className, pathD) {
        var svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", className);
        svg.setAttribute("viewBox", "0 0 16 16");
        svg.setAttribute("fill", "currentColor");
        svg.setAttribute("aria-hidden", "true");
        var p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", pathD);
        svg.appendChild(p);
        return svg;
      }

      function normalizeFilePath(raw) {
        if (typeof raw !== "string" || raw.length > 4096) return "";
        var text = raw.trim();
        if (!text || text === "/dev/null") return "";
        if (text.indexOf("{") !== -1 && text.indexOf("}") !== -1) {
          var braceRe = /\\{([^{}]{0,1024}) (?:->|=>|\\u2192) ([^{}]{0,1024})\\}/g;
          if (braceRe.test(text)) {
            text = text.replace(braceRe, function(_m, _o, n) { return n.trim(); });
          }
        } else if (text.indexOf(" -> ") !== -1 || text.indexOf(" => ") !== -1 || text.indexOf(" \\u2192 ") !== -1) {
          var parts = text.split(/ (?:->|=>|\\u2192) /);
          if (parts.length === 2 && parts[1].trim()) text = parts[1].trim();
        }
        text = text.replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");
        if (text.indexOf("./") === 0) text = text.slice(2);
        if (text.indexOf("/") === 0) text = text.slice(1);
        return text;
      }

      (function buildStatBar() {
        var bar = document.getElementById("stat-bar");
        if (!bar) return;
        var total = totalAdds + totalDels;
        if (total === 0) return;
        var blocks = 5;
        var addBlocks = Math.round((totalAdds / total) * blocks);
        var delBlocks = blocks - addBlocks;
        for (var i = 0; i < addBlocks; i++) {
          var b = document.createElement("span");
          b.className = "diff-stat-block add";
          bar.appendChild(b);
        }
        for (var j = 0; j < delBlocks; j++) {
          var d = document.createElement("span");
          d.className = "diff-stat-block del";
          bar.appendChild(d);
        }
      })();

      function assignCanonicalFiles() {
        var wrappers = document.querySelectorAll(".d2h-file-wrapper");
        wrappers.forEach(function(w, idx) {
          var nameEl = w.querySelector(".d2h-file-name");
          var fallback = nameEl ? normalizeFilePath(nameEl.textContent) : "";
          w.dataset.canonicalFile = canonicalFiles[idx] || fallback;
        });
      }

      function render(fmt) {
        var c = document.getElementById("diff-container");
        c.replaceChildren();
        var ui = new Diff2HtmlUI(c, diffString, {
          inputFormat: "diff",
          outputFormat: fmt,
          drawFileList: false,
          matching: "lines",
          highlight: true,
          diffStyle: "word",
          fileContentToggle: true,
          synchronisedScroll: true,
          renderNothingWhenEmpty: false
        });
        ui.draw();
        ui.highlightCode();
        assignCanonicalFiles();
        buildFileTree();
        if (fmt === "side-by-side") injectPaneHandles();
        if (SERVE_MODE) renderAllComments();
      }

      function setView(mode) {
        currentView = mode;
        var splitBtn = document.getElementById("btn-split");
        var unifiedBtn = document.getElementById("btn-unified");
        splitBtn.classList.toggle("active", mode === "side-by-side");
        unifiedBtn.classList.toggle("active", mode === "line-by-line");
        splitBtn.setAttribute("aria-selected", String(mode === "side-by-side"));
        unifiedBtn.setAttribute("aria-selected", String(mode === "line-by-line"));
        render(mode);
      }

      function toggleTree() {
        var tree = document.getElementById("file-tree");
        var handle = document.getElementById("resize-handle");
        var hidden = tree.classList.toggle("hidden");
        if (handle) handle.style.display = hidden ? "none" : "";
      }

      function setWrap(on) {
        document.body.classList.toggle("wrap-on", on);
        var wrapOn = document.getElementById("btn-wrap-on");
        var wrapOff = document.getElementById("btn-wrap-off");
        wrapOn.classList.toggle("active", on);
        wrapOff.classList.toggle("active", !on);
        wrapOn.setAttribute("aria-selected", String(on));
        wrapOff.setAttribute("aria-selected", String(!on));
      }

      document.getElementById("btn-split").addEventListener("click", function() { setView("side-by-side"); });
      document.getElementById("btn-unified").addEventListener("click", function() { setView("line-by-line"); });
      document.getElementById("btn-wrap-off").addEventListener("click", function() { setWrap(false); });
      document.getElementById("btn-wrap-on").addEventListener("click", function() { setWrap(true); });
      document.getElementById("btn-toggle-tree").addEventListener("click", toggleTree);

      (function initResize() {
        var handle = document.getElementById("resize-handle");
        var tree = document.getElementById("file-tree");
        if (!handle || !tree) return;
        var dragging = false;
        var startX = 0;
        var startWidth = 0;

        handle.addEventListener("mousedown", function(e) {
          e.preventDefault();
          dragging = true;
          startX = e.clientX;
          startWidth = tree.offsetWidth;
          handle.classList.add("dragging");
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        });

        document.addEventListener("mousemove", function(e) {
          if (!dragging) return;
          var newWidth = startWidth + (e.clientX - startX);
          if (newWidth < 100) newWidth = 100;
          if (newWidth > window.innerWidth * 0.5) newWidth = window.innerWidth * 0.5;
          tree.style.width = newWidth + "px";
        });

        document.addEventListener("mouseup", function() {
          if (!dragging) return;
          dragging = false;
          handle.classList.remove("dragging");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        });
      })();

      function injectPaneHandles() {
        var containers = document.querySelectorAll(".d2h-files-diff");
        containers.forEach(function(container) {
          var sides = container.querySelectorAll(":scope > .d2h-file-side-diff");
          if (sides.length < 2) return;
          if (container.querySelector(".diff-pane-handle")) return;

          var left = sides[0];
          var right = sides[1];
          left.style.flex = "1 1 50%";
          right.style.flex = "1 1 50%";

          var handle = document.createElement("div");
          handle.className = "diff-pane-handle";
          container.insertBefore(handle, right);

          var dragging = false;
          var startX = 0;
          var startLeftWidth = 0;
          var totalWidth = 0;

          handle.addEventListener("mousedown", function(e) {
            e.preventDefault();
            dragging = true;
            startX = e.clientX;
            startLeftWidth = left.offsetWidth;
            totalWidth = container.offsetWidth - handle.offsetWidth;
            handle.classList.add("dragging");
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          });

          document.addEventListener("mousemove", function(e) {
            if (!dragging || totalWidth <= 0) return;
            var dx = e.clientX - startX;
            var newLeftWidth = startLeftWidth + dx;
            var minW = 100;
            if (newLeftWidth < minW) newLeftWidth = minW;
            if (newLeftWidth > totalWidth - minW) newLeftWidth = totalWidth - minW;
            var leftPct = (newLeftWidth / totalWidth) * 100;
            left.style.flex = "0 0 " + leftPct + "%";
            right.style.flex = "0 0 " + (100 - leftPct) + "%";
          });

          document.addEventListener("mouseup", function() {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove("dragging");
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
          });
        });
      }

      function buildFileTree() {
        var list = document.getElementById("file-tree-list");
        list.replaceChildren();
        var wrappers = document.querySelectorAll(".d2h-file-wrapper");

        var root = new Map();
        wrappers.forEach(function(w) {
          var pathText = w.dataset.canonicalFile || "";
          if (!pathText) {
            var nameEl = w.querySelector(".d2h-file-name");
            pathText = nameEl ? normalizeFilePath(nameEl.textContent) : "";
          }
          if (!pathText) return;
          var parts = pathText.split("/").filter(Boolean);
          var node = root;
          for (var i = 0; i < parts.length - 1; i++) {
            var dirPart = parts[i];
            if (!node.has(dirPart) || !node.get(dirPart).children) {
              node.set(dirPart, { children: new Map(), file: null });
            }
            node = node.get(dirPart).children;
          }
          var fileName = parts[parts.length - 1];
          node.set(fileName, { children: null, file: { path: pathText, wrapper: w } });
        });

        function renderTree(treeMap, container, depth) {
          var entries = Array.from(treeMap.entries()).sort(function(a, b) {
            var aIsDir = Boolean(a[1].children);
            var bIsDir = Boolean(b[1].children);
            if (aIsDir && !bIsDir) return -1;
            if (!aIsDir && bIsDir) return 1;
            return a[0].localeCompare(b[0]);
          });

          entries.forEach(function(pair) {
            var key = pair[0];
            var entry = pair[1];
            var indent = (depth * 16) + "px";

            if (entry.children) {
              var dirLi = document.createElement("li");
              dirLi.className = "file-tree-dir";

              var header = document.createElement("div");
              header.className = "file-tree-dir-header";
              header.style.paddingLeft = "calc(8px + " + indent + ")";
              header.appendChild(createSvgIcon("file-tree-chevron", "M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"));
              header.appendChild(createSvgIcon("file-tree-icon", "M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"));

              var dirLabel = document.createElement("span");
              dirLabel.className = "file-tree-dir-name";
              dirLabel.textContent = key;
              header.appendChild(dirLabel);
              header.addEventListener("click", function() { dirLi.classList.toggle("collapsed"); });

              var childrenUl = document.createElement("ul");
              childrenUl.className = "file-tree-dir-children";
              renderTree(entry.children, childrenUl, depth + 1);

              dirLi.appendChild(header);
              dirLi.appendChild(childrenUl);
              container.appendChild(dirLi);
            } else if (entry.file) {
              var li = document.createElement("li");
              var a = document.createElement("a");
              a.className = "file-tree-item";
              a.href = "#";
              a.style.paddingLeft = "calc(8px + " + indent + ")";
              a.title = entry.file.path;
              a.appendChild(createSvgIcon("file-tree-icon", "M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"));

              var fileSpan = document.createElement("span");
              fileSpan.className = "file-tree-name";
              fileSpan.textContent = key;
              a.appendChild(fileSpan);

              var targetWrapper = entry.file.wrapper;
              a.addEventListener("click", function(e) {
                e.preventDefault();
                targetWrapper.scrollIntoView({ behavior: "smooth", block: "start" });
                document.querySelectorAll(".file-tree-item").forEach(function(el) { el.classList.remove("active"); });
                a.classList.add("active");
              });
              li.appendChild(a);
              container.appendChild(li);
            }
          });
        }

        renderTree(root, list, 0);
      }

      render(currentView);

      if (SERVE_MODE) initCommentUI();

      function apiFetch(url, options) {
        var opts = options ? Object.assign({}, options) : {};
        var headers = Object.assign({}, opts.headers || {});
        headers["X-Diff-Token"] = CSRF_TOKEN;
        opts.headers = headers;
        opts.credentials = "same-origin";
        return fetch(url, opts);
      }

      function initCommentUI() {
        fetchComments();
        var heartbeatTimer = setInterval(function() {
          if (reviewDone) {
            clearInterval(heartbeatTimer);
            return;
          }
          apiFetch("/api/heartbeat", { method: "POST", keepalive: true }).catch(function() {});
        }, 15000);

        document.addEventListener("click", function(e) {
          var target = e.target;
          if (!(target instanceof Element)) return;

          var lineCell = target.closest(".d2h-code-side-linenumber, .d2h-code-linenumber");
          if (lineCell && !reviewDone && !target.closest(".comment-form-row") && !target.closest(".comment-bubble")) {
            var anchor = resolveClickedAnchor(target, lineCell);
            if (anchor) {
              e.preventDefault();
              openCommentForm(anchor);
            }
            return;
          }
          if (target.closest(".btn-cancel-comment")) { closeCommentForm(); return; }
          if (target.closest(".btn-submit-comment")) { submitComment(); return; }
          var delBtn = target.closest(".btn-delete-comment");
          if (delBtn && delBtn.dataset.id) { deleteComment(delBtn.dataset.id); return; }
          if (target.id === "btn-done") { doneReview(); return; }
        });
      }

      function getCanonicalFileFromElement(el) {
        var w = el.closest(".d2h-file-wrapper");
        if (!w) return "";
        if (w.dataset.canonicalFile) return w.dataset.canonicalFile;
        var n = w.querySelector(".d2h-file-name");
        return n ? normalizeFilePath(n.textContent) : "";
      }

      function resolveClickedAnchor(clickTarget, lineCell) {
        if (
          lineCell.classList.contains("d2h-info") ||
          lineCell.classList.contains("d2h-emptyplaceholder") ||
          lineCell.classList.contains("d2h-code-side-emptyplaceholder")
        ) {
          return null;
        }
        var tr = lineCell.closest("tr");
        if (!tr) return null;
        var file = getCanonicalFileFromElement(lineCell);
        if (!file) return null;

        var sideDiff = lineCell.closest(".d2h-file-side-diff");
        if (sideDiff) {
          var parentSides = sideDiff.parentElement
            ? sideDiff.parentElement.querySelectorAll(":scope > .d2h-file-side-diff")
            : [];
          var side = parentSides.length > 1 && sideDiff === parentSides[1] ? "right" : "left";
          var sideLine = lineCell.textContent.trim();
          if (!POSITIVE_LINE_RE.test(sideLine)) return null;
          return { tr: tr, file: file, line: sideLine, side: side };
        }

        // Unified mode: .d2h-code-linenumber contains .line-num1 (left) and .line-num2 (right)
        var num1El = lineCell.querySelector(".line-num1");
        var num2El = lineCell.querySelector(".line-num2");
        var oldNum = num1El ? num1El.textContent.trim() : "";
        var newNum = num2El ? num2El.textContent.trim() : "";

        if (clickTarget.closest(".line-num1") && POSITIVE_LINE_RE.test(oldNum)) {
          return { tr: tr, file: file, line: oldNum, side: "left" };
        }
        if (clickTarget.closest(".line-num2") && POSITIVE_LINE_RE.test(newNum)) {
          return { tr: tr, file: file, line: newNum, side: "right" };
        }
        if (POSITIVE_LINE_RE.test(newNum)) {
          return { tr: tr, file: file, line: newNum, side: "right" };
        }
        if (POSITIVE_LINE_RE.test(oldNum)) {
          return { tr: tr, file: file, line: oldNum, side: "left" };
        }
        return null;
      }

      function fetchComments() {
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
      }

      function openCommentForm(anchor) {
        closeCommentForm();
        var cols = Math.max(1, anchor.tr.querySelectorAll("td").length);

        var formRow = document.createElement("tr");
        formRow.className = "comment-form-row";

        var td = document.createElement("td");
        td.colSpan = cols;
        td.className = "comment-form-cell";

        var formDiv = document.createElement("div");
        formDiv.className = "comment-form";

        var textarea = document.createElement("textarea");
        textarea.className = "comment-textarea";
        textarea.placeholder = "Leave a comment on " + anchor.file + ":" + anchor.line + " (" + anchor.side + ")";
        textarea.rows = 3;

        var actions = document.createElement("div");
        actions.className = "comment-form-actions";

        var cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "btn-cancel-comment";
        cancelBtn.textContent = "Cancel";

        var submitBtn = document.createElement("button");
        submitBtn.type = "button";
        submitBtn.className = "btn-submit-comment";
        submitBtn.dataset.file = anchor.file;
        submitBtn.dataset.line = anchor.line;
        submitBtn.dataset.side = anchor.side;
        submitBtn.textContent = "Add comment";

        actions.appendChild(cancelBtn);
        actions.appendChild(submitBtn);
        formDiv.appendChild(textarea);
        formDiv.appendChild(actions);
        td.appendChild(formDiv);
        formRow.appendChild(td);

        anchor.tr.after(formRow);
        textarea.focus();
      }

      function closeCommentForm() {
        var existing = document.querySelector(".comment-form-row");
        if (existing) existing.remove();
      }

      function submitComment() {
        var btn = document.querySelector(".btn-submit-comment");
        if (!btn) return;
        var ta = document.querySelector(".comment-textarea");
        var body = ta ? ta.value.trim() : "";
        if (!body) return;
        btn.disabled = true;
        apiFetch("/api/comments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file: btn.dataset.file,
            line: btn.dataset.line,
            side: btn.dataset.side,
            body: body
          })
        })
          .then(function(r) {
            if (!r.ok) throw new Error("Failed to save comment");
            return r.json();
          })
          .then(function(saved) {
            comments.push(saved);
            closeCommentForm();
            renderAllComments();
            updateBadge();
          })
          .catch(function() {
            btn.disabled = false;
          });
      }

      function deleteComment(id) {
        apiFetch("/api/comments/" + encodeURIComponent(id), { method: "DELETE" })
          .then(function(r) {
            if (!r.ok) throw new Error("Failed to delete comment");
            return r.json();
          })
          .then(function(data) {
            if (Array.isArray(data)) {
              comments = data;
              renderAllComments();
              updateBadge();
            }
          })
          .catch(function() {});
      }

      function doneReview() {
        var btn = document.getElementById("btn-done");
        if (btn) btn.disabled = true;
        apiFetch("/api/done", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        })
          .then(function(r) {
            if (!r.ok) throw new Error("Failed to submit review");
            reviewDone = true;
            if (btn) {
              btn.textContent = "Review Submitted";
              btn.classList.add("done");
            }
            closeCommentForm();
            document.querySelectorAll(".btn-delete-comment").forEach(function(b) { b.remove(); });
          })
          .catch(function() {
            if (btn) btn.disabled = false;
          });
      }

      function renderAllComments() {
        document.querySelectorAll(".comment-indicator,.comment-bubble").forEach(function(el) { el.remove(); });
        comments.forEach(function(c) {
          var match = findLineTarget(c.file, String(c.line), c.side);
          if (!match) return;
          if (match.lineCell && !match.lineCell.querySelector(".comment-indicator")) {
            var dot = document.createElement("span");
            dot.className = "comment-indicator";
            match.lineCell.style.position = "relative";
            match.lineCell.appendChild(dot);
          }
          var cols = Math.max(1, match.row.querySelectorAll("td").length);
          var bRow = document.createElement("tr");
          bRow.className = "comment-bubble";
          bRow.dataset.commentId = String(c.id || "");

          var td = document.createElement("td");
          td.colSpan = cols;
          td.className = "comment-bubble-cell";

          var inner = document.createElement("div");
          inner.className = "comment-bubble-inner";

          var meta = document.createElement("div");
          meta.className = "comment-bubble-meta";
          meta.textContent = String(c.file || "") + ":" + String(c.line || "") + " (" + String(c.side || "right") + ")";
          inner.appendChild(meta);

          var bodyEl = document.createElement("div");
          bodyEl.className = "comment-bubble-body";
          bodyEl.textContent = String(c.body || "");
          inner.appendChild(bodyEl);

          if (!reviewDone && c.id) {
            var delBtn = document.createElement("button");
            delBtn.type = "button";
            delBtn.className = "btn-delete-comment";
            delBtn.dataset.id = String(c.id);
            delBtn.title = "Delete comment";
            delBtn.textContent = "\\u00D7";
            inner.appendChild(delBtn);
          }

          td.appendChild(inner);
          bRow.appendChild(td);
          match.row.after(bRow);
        });
      }

      function findLineTarget(file, line, side) {
        var exactTarget = typeof file === "string" ? file : "";
        var normalizedTarget = normalizeFilePath(exactTarget);
        var wrappers = document.querySelectorAll(".d2h-file-wrapper");
        for (var i = 0; i < wrappers.length; i++) {
          var w = wrappers[i];
          var wFile = w.dataset.canonicalFile || "";
          var matchedFile = false;
          if (wFile) {
            matchedFile = wFile === exactTarget;
          } else {
            var n = w.querySelector(".d2h-file-name");
            var fallbackFile = n ? normalizeFilePath(n.textContent) : "";
            matchedFile = Boolean(fallbackFile) && fallbackFile === normalizedTarget;
          }
          if (!matchedFile) continue;

          if (currentView === "side-by-side") {
            var sides = w.querySelectorAll(".d2h-file-side-diff");
            var sidePane = side === "left" ? sides[0] : (sides[1] || sides[0]);
            if (!sidePane) continue;
            var sideCells = sidePane.querySelectorAll(".d2h-code-side-linenumber, .d2h-code-linenumber");
            for (var j = 0; j < sideCells.length; j++) {
              if (sideCells[j].textContent.trim() === line) {
                var sRow = sideCells[j].closest("tr");
                if (sRow) return { row: sRow, lineCell: sideCells[j] };
              }
            }
          } else {
            var unifiedCells = w.querySelectorAll(".d2h-code-linenumber");
            for (var k = 0; k < unifiedCells.length; k++) {
              var cell = unifiedCells[k];
              var selector = side === "left" ? ".line-num1" : ".line-num2";
              var sub = cell.querySelector(selector);
              if (sub && sub.textContent.trim() === line) {
                var uRow = cell.closest("tr");
                if (uRow) return { row: uRow, lineCell: cell };
              }
            }
          }
        }
        return null;
      }

      function updateBadge() {
        var badge = document.getElementById("comment-badge");
        if (!badge) return;
        badge.style.display = comments.length > 0 ? "inline-flex" : "none";
        badge.textContent = comments.length + (comments.length === 1 ? " comment" : " comments");
      }
    })();
  </script>
</body>
</html>
`;

  return {
    html,
    nonce,
    metaCsp,
    headerCsp,
    stats: {
      fileCount: safeFiles,
      additions: safeAdds,
      deletions: safeDels,
    },
  };
}
