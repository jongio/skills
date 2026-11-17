import {
  Component,
  html,
  mountCanvas,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useCallback,
  relativeTime,
} from "/kit/core-client.mjs";
import { Icon } from "/kit/icons.mjs";
import {
  pairSplitRows,
  tokenizeCodeLine,
  buildFileTree,
} from "./diff-view-model.mjs";

const EMPTY_ARRAY = Object.freeze([]);

function createNullMap() {
  return Object.create(null);
}

function cloneNullMap(src) {
  return Object.assign(Object.create(null), src || null);
}

function hasOwnKey(obj, key) {
  return Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

function statusBadgeMeta(status) {
  if (status === "pending") {
    return { label: "Pending Review", cls: "ck-badge ck-badge-attention", icon: "circle-dot" };
  }
  if (status === "addressed") {
    return { label: "Addressed", cls: "ck-badge ck-badge-success", icon: "circle-check" };
  }
  return { label: "Draft", cls: "ck-badge ck-badge-accent", icon: "message-square" };
}

function fileIconName(status) {
  if (status === "added") return "file-plus";
  if (status === "deleted") return "file-minus";
  return "file-code";
}

export const LARGE_FILE_CHANGED_LINES_THRESHOLD = 600;

const LOCKFILE_BASENAME_RE =
  /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock|gemfile\.lock|poetry\.lock|uv\.lock|pipfile\.lock|composer\.lock|go\.sum|packages\.lock\.json|paket\.lock|flake\.lock)$/i;

export function getAutoCollapseReason(file) {
  const pathText = String(file?.canonicalPath || file?.displayPath || "").trim();
  const base = pathText.split("/").pop() || "";
  if (base && LOCKFILE_BASENAME_RE.test(base)) {
    return "Lockfile diff collapsed by default";
  }
  const changedLines = (Number(file?.additions) || 0) + (Number(file?.deletions) || 0);
  if (changedLines > LARGE_FILE_CHANGED_LINES_THRESHOLD) {
    return "Large file diff collapsed by default";
  }
  return null;
}

function renderTokenSpans(text, language, keyPrefix = "t") {
  const tokens = tokenizeCodeLine(text, language);
  return tokens.map((tok, idx) =>
    tok.kind === "plain"
      ? tok.text
      : html`<span key=${`${keyPrefix}:${idx}`} class=${`tok-${tok.kind}`}>${tok.text}</span>`,
  );
}

function CodeTokens({ text, language, segments, highlightClass }) {
  if (Array.isArray(segments) && segments.length > 0) {
    return segments.flatMap((seg, idx) =>
      seg.changed
        ? [
            html`<span key=${`s:${idx}`} class=${highlightClass}>${renderTokenSpans(seg.text, language, `s${idx}`)}</span>`,
          ]
        : renderTokenSpans(seg.text, language, `u${idx}`),
    );
  }
  return renderTokenSpans(text, language);
}

function commentableCellProps(enabled, onActivate, label) {
  if (!enabled) return {};
  return {
    tabIndex: 0,
    role: "button",
    "aria-label": label,
    onClick: onActivate,
    onKeyDown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    },
  };
}

function FileTreeNodes({
  nodes,
  depth,
  collapsedDirs,
  onToggleDir,
  selectedFile,
  onSelectFile,
  viewedSet,
  commentsByFile,
}) {
  return html`
    <ul class="dv-tree-list">
      ${nodes.map((node) => {
        const padLeft = `${8 + depth * 14}px`;
        if (node.kind === "dir") {
          const isCollapsed =
            hasOwnKey(collapsedDirs, node.path) && Boolean(collapsedDirs[node.path]);
          return html`
            <li key=${`dir:${node.path}`}>
              <button
                type="button"
                class="dv-tree-row"
                style=${{ paddingLeft: padLeft }}
                onClick=${() => onToggleDir(node.path)}
              >
                <span class="dv-tree-icon">
                  <${Icon} name=${isCollapsed ? "chevron-right" : "chevron-down"} size=${12} />
                </span>
                <span class="dv-tree-icon">
                  <${Icon} name=${isCollapsed ? "folder" : "folder-open"} size=${14} />
                </span>
                <span class="dv-tree-label" title=${node.path}>${node.name}</span>
              </button>
              ${!isCollapsed
                ? html`
                    <${FileTreeNodes}
                      nodes=${node.children}
                      depth=${depth + 1}
                      collapsedDirs=${collapsedDirs}
                      onToggleDir=${onToggleDir}
                      selectedFile=${selectedFile}
                      onSelectFile=${onSelectFile}
                      viewedSet=${viewedSet}
                      commentsByFile=${commentsByFile}
                    />
                  `
                : null}
            </li>
          `;
        }

        const file = node.file;
        const canonical = file.canonicalPath || node.path;
        const isViewed = viewedSet.has(canonical);
        const isActive = selectedFile === canonical;
        const fileCommentCount = commentsByFile.get(canonical) || 0;

        return html`
          <li key=${`file:${canonical}:${file.index}`}>
            <button
              type="button"
              class=${`dv-tree-row${isActive ? " active" : ""}${isViewed ? " viewed" : ""}`}
              style=${{ paddingLeft: padLeft }}
              title=${file.displayPath || canonical}
              onClick=${() => onSelectFile(canonical)}
            >
              <span class="dv-tree-icon">
                <${Icon} name=${isViewed ? "check" : fileIconName(file.status)} size=${14} />
              </span>
              <span class="dv-tree-label">${node.name}</span>
              <span class="dv-tree-meta">
                ${fileCommentCount > 0
                  ? html`
                      <span class="dv-comment-pill" title=${`${fileCommentCount} comments`}>
                        <${Icon} name="message-square" size=${12} />
                        ${fileCommentCount}
                      </span>
                    `
                  : null}
                ${file.additions > 0 ? html`<span class="dv-add">+${file.additions}</span>` : null}
                ${file.deletions > 0 ? html`<span class="dv-del">-${file.deletions}</span>` : null}
              </span>
            </button>
          </li>
        `;
      })}
    </ul>
  `;
}

function CommentComposer({ activeComposer, onSaveComment, onCancelComposer, busyAction }) {
  const [draftBody, setDraftBody] = useState("");
  const trimmed = draftBody.trim();

  const submit = async () => {
    if (!trimmed) return;
    const ok = await onSaveComment(activeComposer, trimmed);
    if (ok) {
      setDraftBody("");
    }
  };

  return html`
    <div class="dv-composer">
      <div class="dv-composer-label">
        Commenting on ${activeComposer.file}:${activeComposer.line} (${activeComposer.side})
      </div>
      <textarea
        class="ck-input"
        placeholder="Write an inline review comment..."
        value=${draftBody}
        onInput=${(e) => setDraftBody(e.currentTarget.value)}
        onKeyDown=${(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancelComposer();
          }
        }}
      ></textarea>
      <div class="dv-composer-actions">
        <button
          type="button"
          class="ck-btn"
          disabled=${busyAction}
          onClick=${onCancelComposer}
        >
          Cancel
        </button>
        <button
          type="button"
          class="ck-btn ck-btn-primary"
          disabled=${busyAction || !trimmed}
          onClick=${submit}
        >
          <${Icon} name="message-square-plus" size=${14} />
          Add comment
        </button>
      </div>
    </div>
  `;
}

function CommentCard({
  comment,
  canEditComments,
  busyAction,
  onEditComment,
  onDeleteComment,
  onEditOpenChange,
}) {
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(comment.body || "");

  useEffect(() => {
    if (!editing) {
      setEditDraft(comment.body || "");
    }
  }, [comment.body, editing]);

  useEffect(() => {
    if (!canEditComments && editing) {
      setEditing(false);
    }
  }, [canEditComments, editing]);

  useEffect(() => {
    if (!editing || typeof onEditOpenChange !== "function") return undefined;
    onEditOpenChange(1);
    return () => onEditOpenChange(-1);
  }, [editing, onEditOpenChange]);

  const trimmed = editDraft.trim();
  const saveEdit = async () => {
    if (!trimmed) return;
    const ok = await onEditComment(comment.id, trimmed);
    if (ok) {
      setEditing(false);
    }
  };

  return html`
    <div class="dv-comment-card">
      <div class="dv-comment-head">
        <span class="ck-mono">
          ${comment.file}:${comment.line} (${comment.side}) - ${comment.createdAt ? relativeTime(comment.createdAt) : "saved"}
        </span>
        <div class="ck-row">
          ${comment.stale
            ? html`<span class="ck-badge ck-badge-muted" title="Diff changed at this line since comment was added">Stale</span>`
            : null}
          ${canEditComments && !editing
            ? html`
                <button
                  type="button"
                  class="ck-btn"
                  title="Edit comment"
                  disabled=${busyAction}
                  onClick=${() => {
                    setEditDraft(comment.body || "");
                    setEditing(true);
                  }}
                >
                  Edit
                </button>
              `
            : null}
          ${canEditComments
            ? html`
                <button
                  type="button"
                  class="ck-btn dv-icon-btn"
                  title="Delete comment"
                  disabled=${busyAction}
                  onClick=${() => onDeleteComment(comment.id)}
                >
                  <${Icon} name="trash-2" size=${12} />
                </button>
              `
            : null}
        </div>
      </div>
      ${editing
        ? html`
            <div class="dv-composer">
              <textarea
                class="ck-input"
                aria-label="Edit review comment"
                value=${editDraft}
                onInput=${(e) => setEditDraft(e.currentTarget.value)}
                onKeyDown=${(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    saveEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditing(false);
                    setEditDraft(comment.body || "");
                  }
                }}
              ></textarea>
              <div class="dv-composer-actions">
                <button
                  type="button"
                  class="ck-btn"
                  disabled=${busyAction}
                  onClick=${() => {
                    setEditing(false);
                    setEditDraft(comment.body || "");
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="ck-btn ck-btn-primary"
                  disabled=${busyAction || !trimmed}
                  onClick=${saveEdit}
                >
                  Save
                </button>
              </div>
            </div>
          `
        : html`<div class="dv-comment-body">${comment.body}</div>`}
    </div>
  `;
}

function ThreadRows({
  colSpan,
  rowComments,
  composerHere,
  activeComposer,
  onSaveComment,
  onCancelComposer,
  onEditComment,
  onDeleteComment,
  onEditOpenChange,
  canEditComments,
  busyAction,
}) {
  if (rowComments.length === 0 && !composerHere) return null;

  return html`
    <tr>
      <td colSpan=${colSpan} class="dv-thread-cell">
        ${rowComments.map(
          (c) => html`
            <${CommentCard}
              key=${c.id}
              comment=${c}
              canEditComments=${canEditComments}
              busyAction=${busyAction}
              onEditComment=${onEditComment}
              onDeleteComment=${onDeleteComment}
              onEditOpenChange=${onEditOpenChange}
            />
          `,
        )}
        ${composerHere && activeComposer
          ? html`
              <${CommentComposer}
                key=${`${activeComposer.file}:${activeComposer.side}:${activeComposer.line}`}
                activeComposer=${activeComposer}
                onSaveComment=${onSaveComment}
                onCancelComposer=${onCancelComposer}
                busyAction=${busyAction}
              />
            `
          : null}
      </td>
    </tr>
  `;
}

function FileDiffCardInner({
  file,
  viewMode,
  splitLeftPct,
  onStartSplitResize,
  isViewed,
  isCollapsed,
  autoCollapseReason,
  isFocusedFile,
  focusedLine,
  onToggleCollapse,
  onToggleViewed,
  commentsForFile,
  canEditComments,
  activeComposerForFile,
  onOpenComposer,
  onSaveComment,
  onCancelComposer,
  onEditComment,
  onDeleteComment,
  onEditOpenChange,
  busyAction,
}) {
  const canonical = file.canonicalPath || "";
  const collapseKey = canonical || String(file.index);
  const leftCodeWidth = `calc((100% - 96px) * ${splitLeftPct / 100})`;
  const rightCodeWidth = `calc((100% - 96px) * ${(100 - splitLeftPct) / 100})`;
  const showCollapsedCta = Boolean(isCollapsed && autoCollapseReason && !isViewed);

  const visibleAnchors = useMemo(() => {
    const anchors = new Set();
    if (file.isBinary || !Array.isArray(file.hunks)) return anchors;
    for (const hunk of file.hunks) {
      for (const ln of hunk.lines) {
        if (ln.type === "meta") continue;
        if (ln.type !== "add" && ln.oldLine !== null) {
          anchors.add(`left:${ln.oldLine}`);
        }
        if (ln.type !== "del" && ln.newLine !== null) {
          anchors.add(`right:${ln.newLine}`);
        }
      }
    }
    return anchors;
  }, [file.hunks, file.isBinary]);

  const { commentLookup, unanchoredComments } = useMemo(() => {
    const byAnchor = new Map();
    const unanchored = [];
    for (const c of commentsForFile) {
      const key = `${c.side}:${c.line}`;
      if (!visibleAnchors.has(key)) {
        unanchored.push(c);
        continue;
      }
      if (!byAnchor.has(key)) byAnchor.set(key, []);
      byAnchor.get(key).push(c);
    }
    return { commentLookup: byAnchor, unanchoredComments: unanchored };
  }, [commentsForFile, visibleAnchors]);

  const splitHunks = useMemo(() => {
    if (viewMode !== "split" || file.isBinary) return [];
    return file.hunks.map((hunk) => ({
      hunk,
      rows: pairSplitRows(hunk.lines),
    }));
  }, [file.hunks, file.isBinary, viewMode]);

  return html`
    <section
      id=${`dv-file-${file.index}`}
      data-canonical-file=${canonical}
      class=${`dv-file-card${isCollapsed ? " collapsed" : ""}${showCollapsedCta ? " has-collapsed-cta" : ""}${isFocusedFile ? " focused" : ""}`}
    >
      <header class="dv-file-header">
        <button
          type="button"
          class="dv-collapse-btn"
          title=${isCollapsed ? "Expand file" : "Collapse file"}
          onClick=${() => onToggleCollapse(collapseKey, !isCollapsed)}
        >
          <${Icon} name=${isCollapsed ? "chevron-right" : "chevron-down"} size=${14} />
        </button>
        <${Icon} name=${fileIconName(file.status)} size=${14} />
        <span class="dv-file-path" title=${file.displayPath || canonical}>${file.displayPath || canonical}</span>
        ${file.status && file.status !== "modified"
          ? html`<span class="ck-badge ck-badge-muted">${file.status}</span>`
          : null}
        <div class="dv-file-actions">
          <span class="dv-stats">
            <span class="dv-add">+${file.additions}</span>
            <span class="dv-del">-${file.deletions}</span>
          </span>
          ${canonical
            ? html`
                <label class="dv-viewed-toggle">
                  <input
                    type="checkbox"
                    checked=${isViewed}
                    onChange=${() => onToggleViewed(canonical, !isViewed)}
                  />
                  <span>Viewed</span>
                </label>
              `
            : null}
        </div>
      </header>

      ${unanchoredComments.length > 0
        ? html`
            <div class="dv-unanchored-threads">
              <div class="dv-unanchored-label">Outdated / file-level comments</div>
              ${unanchoredComments.map(
                (c) => html`
                  <${CommentCard}
                    key=${c.id}
                    comment=${c}
                    canEditComments=${canEditComments}
                    busyAction=${busyAction}
                    onEditComment=${onEditComment}
                    onDeleteComment=${onDeleteComment}
                    onEditOpenChange=${onEditOpenChange}
                  />
                `,
              )}
            </div>
          `
        : null}

      ${!isCollapsed
        ? html`
            <div class="dv-file-body">
              ${file.truncated
                ? html`
                    <div class="ck-callout dv-file-truncation-notice">
                      <${Icon} name="circle-dot" size=${14} />
                      <span>This file diff was truncated because it exceeded the per-file line or size limit.</span>
                    </div>
                  `
                : null}
              ${file.isBinary
                ? html`<div class="dv-hunk-header">Binary file changed</div>`
                : viewMode === "split"
                  ? splitHunks.map(({ hunk, rows }, hunkIdx) => html`
                      <div key=${hunkIdx} class="dv-split-wrap">
                        <div class="dv-hunk-header">
                          <span>${hunk.header}</span>
                          ${hunk.section ? html`<span class="dv-hunk-section">${hunk.section}</span>` : null}
                        </div>
                        <div
                          class="dv-col-resizer"
                          style=${{ left: `calc(48px + (100% - 96px) * ${splitLeftPct / 100})` }}
                          title="Drag to resize Split columns"
                          onMouseDown=${onStartSplitResize}
                        ></div>
                        <table class="dv-table dv-table-split">
                          <colgroup>
                            <col style="width: 48px" />
                            <col style=${{ width: leftCodeWidth }} />
                            <col style="width: 48px" />
                            <col style=${{ width: rightCodeWidth }} />
                          </colgroup>
                          <tbody>
                            ${rows.flatMap((row, rowIdx) => {
                              if (row.kind === "meta") {
                                return [
                                  html`
                                    <tr key=${`meta:${rowIdx}`}>
                                      <td colSpan=${4} class="dv-code dv-cell-empty ck-muted">${row.text}</td>
                                    </tr>
                                  `,
                                ];
                              }
                              const l = row.left;
                              const r = row.right;
                              const leftLine = l?.oldLine ?? null;
                              const rightLine = r?.newLine ?? null;
                              const isContextPair = l && r && l === r;

                              const leftComments = leftLine !== null ? commentLookup.get(`left:${leftLine}`) || EMPTY_ARRAY : EMPTY_ARRAY;
                              const rightComments = rightLine !== null ? commentLookup.get(`right:${rightLine}`) || EMPTY_ARRAY : EMPTY_ARRAY;
                              const rowComments =
                                leftComments.length === 0
                                  ? rightComments
                                  : rightComments.length === 0
                                    ? leftComments
                                    : [...leftComments, ...rightComments];

                              const composerOnLeft =
                                activeComposerForFile &&
                                activeComposerForFile.side === "left" &&
                                activeComposerForFile.line === leftLine;
                              const composerOnRight =
                                activeComposerForFile &&
                                activeComposerForFile.side === "right" &&
                                activeComposerForFile.line === rightLine;
                              const composerHere = Boolean(composerOnLeft || composerOnRight);

                              const lineFocused =
                                isFocusedFile &&
                                focusedLine !== null &&
                                (leftLine === focusedLine || rightLine === focusedLine);

                              const canCommentLeft = Boolean(canEditComments && canonical && leftLine !== null);
                              const canCommentRight = Boolean(canEditComments && canonical && rightLine !== null);

                              const mainRow = html`
                                <tr
                                  key=${`r:${rowIdx}`}
                                  data-line=${rightLine ?? leftLine ?? undefined}
                                  data-old-line=${leftLine ?? undefined}
                                  data-new-line=${rightLine ?? undefined}
                                  class=${lineFocused ? "dv-line-focused" : ""}
                                >
                                  <td
                                    class=${`dv-ln${l ? (l.type === "del" ? " dv-cell-del" : "") : " dv-cell-empty"}${canCommentLeft ? " commentable" : ""}`}
                                    ...${commentableCellProps(
                                      canCommentLeft,
                                      () => onOpenComposer(canonical, leftLine, "left"),
                                      `Comment on ${canonical} old line ${leftLine}`,
                                    )}
                                  >
                                    ${canCommentLeft
                                      ? html`<span class="dv-ln-plus" aria-hidden="true">+</span>`
                                      : null}
                                    ${leftLine !== null ? leftLine : ""}
                                  </td>
                                  <td class=${`dv-code${l ? (l.type === "del" ? " dv-cell-del" : "") : " dv-cell-empty"}`}>
                                    ${l
                                      ? html`
                                          <span class="dv-prefix">${l.type === "del" ? "-" : " "}</span>
                                          <${CodeTokens}
                                            text=${l.text}
                                            language=${file.language}
                                            segments=${row.leftSegments}
                                            highlightClass="dv-word-del"
                                          />
                                        `
                                      : ""}
                                  </td>
                                  <td
                                    class=${`dv-ln${r ? (r.type === "add" ? " dv-cell-add" : "") : " dv-cell-empty"}${canCommentRight ? " commentable" : ""}`}
                                    ...${commentableCellProps(
                                      canCommentRight,
                                      () => onOpenComposer(canonical, rightLine, "right"),
                                      `Comment on ${canonical} new line ${rightLine}`,
                                    )}
                                  >
                                    ${canCommentRight
                                      ? html`<span class="dv-ln-plus" aria-hidden="true">+</span>`
                                      : null}
                                    ${rightLine !== null ? rightLine : ""}
                                  </td>
                                  <td class=${`dv-code${r ? (r.type === "add" ? " dv-cell-add" : "") : " dv-cell-empty"}`}>
                                    ${r
                                      ? html`
                                          <span class="dv-prefix">${isContextPair ? " " : r.type === "add" ? "+" : " "}</span>
                                          <${CodeTokens}
                                            text=${r.text}
                                            language=${file.language}
                                            segments=${row.rightSegments}
                                            highlightClass="dv-word-add"
                                          />
                                        `
                                      : ""}
                                  </td>
                                </tr>
                              `;

                              if (rowComments.length === 0 && !composerHere) {
                                return [mainRow];
                              }

                              return [
                                mainRow,
                                html`
                                  <${ThreadRows}
                                    key=${`rt:${rowIdx}`}
                                    colSpan=${4}
                                    rowComments=${rowComments}
                                    composerHere=${composerHere}
                                    activeComposer=${activeComposerForFile}
                                    onSaveComment=${onSaveComment}
                                    onCancelComposer=${onCancelComposer}
                                    onEditComment=${onEditComment}
                                    onDeleteComment=${onDeleteComment}
                                    onEditOpenChange=${onEditOpenChange}
                                    canEditComments=${canEditComments}
                                    busyAction=${busyAction}
                                  />
                                `,
                              ];
                            })}
                          </tbody>
                        </table>
                      </div>
                    `)
                  : file.hunks.map((hunk, hunkIdx) => html`
                      <div key=${hunkIdx}>
                        <div class="dv-hunk-header">
                          <span>${hunk.header}</span>
                          ${hunk.section ? html`<span class="dv-hunk-section">${hunk.section}</span>` : null}
                        </div>
                        <table class="dv-table dv-table-unified">
                          <colgroup>
                            <col style="width: 44px" />
                            <col style="width: 44px" />
                            <col />
                          </colgroup>
                          <tbody>
                            ${hunk.lines.flatMap((ln, lineIdx) => {
                              if (ln.type === "meta") {
                                return [
                                  html`
                                    <tr key=${`meta:${lineIdx}`}>
                                      <td colSpan=${3} class="dv-code dv-cell-empty ck-muted">${ln.text}</td>
                                    </tr>
                                  `,
                                ];
                              }
                              const oldLine = ln.oldLine;
                              const newLine = ln.newLine;
                              const rowCls = ln.type === "add" ? "dv-row-add" : ln.type === "del" ? "dv-row-del" : "";

                              const leftComments =
                                ln.type !== "add" && oldLine !== null
                                  ? commentLookup.get(`left:${oldLine}`) || EMPTY_ARRAY
                                  : EMPTY_ARRAY;
                              const rightComments =
                                ln.type !== "del" && newLine !== null
                                  ? commentLookup.get(`right:${newLine}`) || EMPTY_ARRAY
                                  : EMPTY_ARRAY;
                              const rowComments =
                                leftComments.length === 0
                                  ? rightComments
                                  : rightComments.length === 0
                                    ? leftComments
                                    : [...leftComments, ...rightComments];

                              const composerHere = Boolean(
                                activeComposerForFile &&
                                  ((activeComposerForFile.side === "left" && ln.type !== "add" && activeComposerForFile.line === oldLine) ||
                                    (activeComposerForFile.side === "right" && ln.type !== "del" && activeComposerForFile.line === newLine)),
                              );

                              const lineFocused =
                                isFocusedFile &&
                                focusedLine !== null &&
                                (oldLine === focusedLine || newLine === focusedLine);

                              const canCommentLeft = Boolean(canEditComments && canonical && oldLine !== null);
                              const canCommentRight = Boolean(canEditComments && canonical && newLine !== null);

                              const mainRow = html`
                                <tr
                                  key=${`u:${lineIdx}`}
                                  data-line=${newLine ?? oldLine ?? undefined}
                                  data-old-line=${oldLine ?? undefined}
                                  data-new-line=${newLine ?? undefined}
                                  class=${`${rowCls}${lineFocused ? " dv-line-focused" : ""}`}
                                >
                                  <td
                                    class=${`dv-ln dv-ln-unified${canCommentLeft ? " commentable" : ""}`}
                                    ...${commentableCellProps(
                                      canCommentLeft,
                                      () => onOpenComposer(canonical, oldLine, "left"),
                                      `Comment on ${canonical} old line ${oldLine}`,
                                    )}
                                  >
                                    ${canCommentLeft
                                      ? html`<span class="dv-ln-plus" aria-hidden="true">+</span>`
                                      : null}
                                    ${oldLine !== null ? oldLine : ""}
                                  </td>
                                  <td
                                    class=${`dv-ln dv-ln-unified${canCommentRight ? " commentable" : ""}`}
                                    ...${commentableCellProps(
                                      canCommentRight,
                                      () => onOpenComposer(canonical, newLine, "right"),
                                      `Comment on ${canonical} new line ${newLine}`,
                                    )}
                                  >
                                    ${canCommentRight
                                      ? html`<span class="dv-ln-plus" aria-hidden="true">+</span>`
                                      : null}
                                    ${newLine !== null ? newLine : ""}
                                  </td>
                                  <td class="dv-code">
                                    <span class="dv-prefix">${ln.type === "add" ? "+" : ln.type === "del" ? "-" : " "}</span>
                                    <${CodeTokens} text=${ln.text} language=${file.language} />
                                  </td>
                                </tr>
                              `;

                              if (rowComments.length === 0 && !composerHere) {
                                return [mainRow];
                              }

                              return [
                                mainRow,
                                html`
                                  <${ThreadRows}
                                    key=${`ut:${lineIdx}`}
                                    colSpan=${3}
                                    rowComments=${rowComments}
                                    composerHere=${composerHere}
                                    activeComposer=${activeComposerForFile}
                                    onSaveComment=${onSaveComment}
                                    onCancelComposer=${onCancelComposer}
                                    onEditComment=${onEditComment}
                                    onDeleteComment=${onDeleteComment}
                                    onEditOpenChange=${onEditOpenChange}
                                    canEditComments=${canEditComments}
                                    busyAction=${busyAction}
                                  />
                                `,
                              ];
                            })}
                          </tbody>
                        </table>
                      </div>
                    `)}
            </div>
          `
        : showCollapsedCta
          ? html`
              <div class="dv-collapsed-notice">
                <span class="ck-muted">${autoCollapseReason}</span>
                <button
                  type="button"
                  class="ck-btn"
                  onClick=${() => onToggleCollapse(collapseKey, false)}
                >
                  Show diff (+${file.additions} / -${file.deletions})
                </button>
              </div>
            `
          : null}
    </section>
  `;
}

function areCommentsArrayEqual(prevList, nextList) {
  if (prevList === nextList) return true;
  if (!Array.isArray(prevList) || !Array.isArray(nextList)) return false;
  if (prevList.length !== nextList.length) return false;
  for (let i = 0; i < prevList.length; i += 1) {
    const a = prevList[i];
    const b = nextList[i];
    if (
      a !== b &&
      (a?.id !== b?.id ||
        a?.body !== b?.body ||
        a?.stale !== b?.stale ||
        a?.line !== b?.line ||
        a?.side !== b?.side ||
        a?.updatedAt !== b?.updatedAt)
    ) {
      return false;
    }
  }
  return true;
}

function areComposerTargetsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.file === b.file && a.line === b.line && a.side === b.side;
}

export class FileDiffCard extends Component {
  shouldComponentUpdate(nextProps) {
    const prev = this.props;
    return !(
      prev.file === nextProps.file &&
      prev.viewMode === nextProps.viewMode &&
      prev.splitLeftPct === nextProps.splitLeftPct &&
      prev.isViewed === nextProps.isViewed &&
      prev.isCollapsed === nextProps.isCollapsed &&
      prev.autoCollapseReason === nextProps.autoCollapseReason &&
      prev.isFocusedFile === nextProps.isFocusedFile &&
      prev.focusedLine === nextProps.focusedLine &&
      prev.canEditComments === nextProps.canEditComments &&
      prev.busyAction === nextProps.busyAction &&
      areComposerTargetsEqual(prev.activeComposerForFile, nextProps.activeComposerForFile) &&
      areCommentsArrayEqual(prev.commentsForFile, nextProps.commentsForFile)
    );
  }

  render(props) {
    return html`<${FileDiffCardInner} ...${props} />`;
  }
}

export function DiffCanvasApp({ state, invoke }) {
  // Local UI state strictly separated from SSE domain state so live updates
  // never overwrite focus, filter queries, or in-progress comment text.
  const [viewMode, setViewMode] = useState("split");
  const [wrapLines, setWrapLines] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [splitLeftPct, setSplitLeftPct] = useState(50);
  const [fileQuery, setFileQuery] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [collapsedDirs, setCollapsedDirs] = useState(() => createNullMap());
  const [collapsedFiles, setCollapsedFiles] = useState(() => createNullMap());
  const [activeComposer, setActiveComposer] = useState(null);
  const [activeEditCount, setActiveEditCount] = useState(0);
  const [actionError, setActionError] = useState(null);
  const [manualHandoffNeeded, setManualHandoffNeeded] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasContextUpdates, setHasContextUpdates] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshFeedback, setRefreshFeedback] = useState(null);

  const mainPaneRef = useRef(null);
  const activeDragCleanupRef = useRef(null);
  const refreshInFlightRef = useRef(false);
  const probeInFlightRef = useRef(false);
  const probeEpochRef = useRef(0);
  const pendingScrollRestoreRef = useRef(null);
  const refreshToastTimerRef = useRef(null);
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;
  const busyActionRef = useRef(busyAction);
  busyActionRef.current = busyAction;
  const domainRef = useRef(state?.domain ?? null);
  domainRef.current = state?.domain ?? null;
  const diffRevRef = useRef(typeof state?.diffRev === "number" ? state.diffRev : 0);
  diffRevRef.current = typeof state?.diffRev === "number" ? state.diffRev : 0;
  const contextSigRef = useRef(state?.contextSignature || null);
  contextSigRef.current = state?.contextSignature || null;
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const splitLeftPctRef = useRef(splitLeftPct);
  splitLeftPctRef.current = splitLeftPct;

  const stableFilesRef = useRef({ domain: null, diffRev: -1, files: EMPTY_ARRAY });
  const rawFiles = state?.files || EMPTY_ARRAY;
  const currentDomain = state?.domain ?? null;
  const currentDiffRev = typeof state?.diffRev === "number" ? state.diffRev : 0;
  if (
    stableFilesRef.current.domain !== currentDomain ||
    stableFilesRef.current.diffRev !== currentDiffRev ||
    (currentDiffRev === 0 && stableFilesRef.current.files !== rawFiles)
  ) {
    stableFilesRef.current = {
      domain: currentDomain,
      diffRev: currentDiffRev,
      files: rawFiles,
    };
  }
  const files = stableFilesRef.current.files;

  const comments = state?.comments || EMPTY_ARRAY;
  const viewedFiles = state?.viewedFiles || EMPTY_ARRAY;

  const viewedSet = useMemo(() => new Set(viewedFiles), [viewedFiles]);

  const prevCommentsByFileRef = useRef(new Map());
  const commentsByFileMap = useMemo(() => {
    const grouped = new Map();
    for (const c of comments) {
      if (!grouped.has(c.file)) grouped.set(c.file, []);
      grouped.get(c.file).push(c);
    }
    const stabilized = new Map();
    const prevMap = prevCommentsByFileRef.current;
    for (const [f, list] of grouped.entries()) {
      const prevList = prevMap.get(f);
      stabilized.set(f, prevList && areCommentsArrayEqual(prevList, list) ? prevList : list);
    }
    prevCommentsByFileRef.current = stabilized;
    return stabilized;
  }, [comments]);

  const commentCountsByFile = useMemo(() => {
    const counts = new Map();
    for (const [f, list] of commentsByFileMap.entries()) {
      counts.set(f, list.length);
    }
    return counts;
  }, [commentsByFileMap]);

  const knownFileSet = useMemo(
    () => new Set(files.map((f) => f.canonicalPath).filter(Boolean)),
    [files],
  );

  const orphanComments = useMemo(
    () => comments.filter((c) => !knownFileSet.has(c.file)),
    [comments, knownFileSet],
  );

  const filteredFiles = useMemo(() => {
    const q = fileQuery.trim().toLowerCase();
    if (!q) return files;
    return files.filter(
      (f) =>
        (f.canonicalPath || "").toLowerCase().includes(q) ||
        (f.displayPath || "").toLowerCase().includes(q),
    );
  }, [files, fileQuery]);

  const viewedFilteredCount = useMemo(
    () =>
      filteredFiles.reduce(
        (acc, f) =>
          acc + (f.canonicalPath && viewedSet.has(f.canonicalPath) ? 1 : 0),
        0,
      ),
    [filteredFiles, viewedSet],
  );

  const fileTree = useMemo(() => buildFileTree(filteredFiles), [filteredFiles]);

  const scrollToFile = useCallback((canonicalPath, line = null) => {
    setSelectedFile(canonicalPath);
    setCollapsedFiles((prev) => {
      if (hasOwnKey(prev, canonicalPath) && prev[canonicalPath] === false) {
        return prev;
      }
      const next = cloneNullMap(prev);
      next[canonicalPath] = false;
      return next;
    });
    const schedule =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (fn) => setTimeout(fn, 0);
    schedule(() => {
      const root = mainPaneRef.current || (typeof document !== "undefined" ? document : null);
      if (!root?.querySelectorAll) return;
      const cards = root.querySelectorAll("[data-canonical-file]");
      for (const card of cards) {
        if (card.getAttribute("data-canonical-file") !== canonicalPath) continue;
        if (line !== null) {
          const parsedLine = Number.parseInt(String(line), 10);
          if (Number.isInteger(parsedLine) && parsedLine > 0) {
            const lineStr = String(parsedLine);
            const lineRow =
              card.querySelector(`tr[data-new-line="${lineStr}"]`) ||
              card.querySelector(
                `tr[data-old-line="${lineStr}"], tr[data-line="${lineStr}"]`,
              );
            if (lineRow?.scrollIntoView) {
              lineRow.scrollIntoView({ behavior: "smooth", block: "center" });
              return;
            }
          }
        }
        if (card.scrollIntoView) {
          card.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
      }
    });
  }, []);

  const prevDomainRef = useRef(state?.domain);
  useEffect(() => {
    if (prevDomainRef.current !== state?.domain) {
      prevDomainRef.current = state?.domain;
      probeEpochRef.current += 1;
      pendingScrollRestoreRef.current = null;
      setCollapsedFiles(createNullMap());
      setCollapsedDirs(createNullMap());
      setFileQuery("");
      setActionError(null);
      setManualHandoffNeeded(false);
      setSelectedFile(null);
      setActiveComposer(null);
      setHasContextUpdates(false);
      setRefreshFeedback(null);
      if (refreshToastTimerRef.current) {
        clearTimeout(refreshToastTimerRef.current);
        refreshToastTimerRef.current = null;
      }
    }
  }, [state?.domain]);

  useEffect(() => {
    probeEpochRef.current += 1;
    setHasContextUpdates(false);
  }, [state?.domain, state?.diffRev, state?.contextSignature]);

  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current;
    if (!pending) return;
    if (pending.domain !== currentDomain) {
      pendingScrollRestoreRef.current = null;
      return;
    }
    if (currentDiffRev > pending.prevRev) {
      pendingScrollRestoreRef.current = null;
      if (mainPaneRef.current) {
        mainPaneRef.current.scrollTop = pending.scrollTop;
      }
    }
  }, [currentDomain, currentDiffRev]);

  const prevViewedSnapshotRef = useRef({
    domain: null,
    diffRev: 0,
    viewedSet: new Set(),
  });
  useEffect(() => {
    const prevSnap = prevViewedSnapshotRef.current;
    if (prevSnap.domain !== currentDomain) {
      prevViewedSnapshotRef.current = {
        domain: currentDomain,
        diffRev: currentDiffRev,
        viewedSet,
      };
      return;
    }
    if (currentDiffRev > prevSnap.diffRev && prevSnap.viewedSet.size > 0) {
      const unviewedOnRefresh = files.filter(
        (f) =>
          f.canonicalPath &&
          prevSnap.viewedSet.has(f.canonicalPath) &&
          !viewedSet.has(f.canonicalPath),
      );
      if (unviewedOnRefresh.length > 0) {
        setCollapsedFiles((prev) => {
          let next = null;
          for (const f of unviewedOnRefresh) {
            const p = f.canonicalPath;
            if (!p || !hasOwnKey(prev, p) || prev[p] !== true) continue;
            if (!next) next = cloneNullMap(prev);
            if (getAutoCollapseReason(f)) {
              delete next[p];
            } else {
              next[p] = false;
            }
          }
          return next || prev;
        });
      }
    }
    prevViewedSnapshotRef.current = {
      domain: currentDomain,
      diffRev: currentDiffRev,
      viewedSet,
    };
  }, [currentDomain, currentDiffRev, viewedSet, files]);

  useEffect(() => {
    if (state?.status && state.status !== "pending") {
      setManualHandoffNeeded(false);
    }
  }, [state?.status]);

  useEffect(() => {
    if (state?.focusSeq && state?.focusedFile) {
      scrollToFile(state.focusedFile, state.focusedLine ?? null);
    }
  }, [state?.domain, state?.focusSeq, state?.focusedFile, state?.focusedLine, scrollToFile]);

  useEffect(
    () => () => {
      activeDragCleanupRef.current?.();
      if (refreshToastTimerRef.current) {
        clearTimeout(refreshToastTimerRef.current);
        refreshToastTimerRef.current = null;
      }
    },
    [],
  );

  const beginWindowDrag = useCallback((onMove) => {
    activeDragCleanupRef.current?.();
    const bodyStyle = typeof document !== "undefined" ? document.body?.style : null;
    const prevUserSelect = bodyStyle?.userSelect || "";
    if (bodyStyle) {
      bodyStyle.userSelect = "none";
    }
    const cleanup = () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", cleanup);
      }
      if (bodyStyle) {
        bodyStyle.userSelect = prevUserSelect;
      }
      if (activeDragCleanupRef.current === cleanup) {
        activeDragCleanupRef.current = null;
      }
    };
    activeDragCleanupRef.current = cleanup;
    if (typeof window !== "undefined") {
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", cleanup);
    }
  }, []);

  const startSidebarResize = useCallback(
    (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidthRef.current;
      beginWindowDrag((ev) => {
        const viewportW = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1200;
        const next = Math.max(150, Math.min(viewportW * 0.55, startWidth + (ev.clientX - startX)));
        setSidebarWidth(Math.round(next));
      });
    },
    [beginWindowDrag],
  );

  const startSplitResize = useCallback(
    (e) => {
      e.preventDefault();
      const wrapEl = e.currentTarget?.parentElement;
      if (!wrapEl) return;
      const rect = wrapEl.getBoundingClientRect();
      const codeWidth = Math.max(200, rect.width - 96);
      const startX = e.clientX;
      const startPct = splitLeftPctRef.current;
      beginWindowDrag((ev) => {
        const deltaPct = ((ev.clientX - startX) / codeWidth) * 100;
        const clamped = Math.max(20, Math.min(80, startPct + deltaPct));
        setSplitLeftPct(Math.round(clamped * 10) / 10);
      });
    },
    [beginWindowDrag],
  );

  const runAction = useCallback(
    async (name, payload = {}) => {
      setActionError(null);
      setBusyAction(true);
      try {
        return await invoke(name, payload);
      } catch (err) {
        setActionError(String(err?.message ?? err));
        return null;
      } finally {
        setBusyAction(false);
      }
    },
    [invoke],
  );

  const handleToggleCollapse = useCallback((key, nextCollapsed) => {
    setCollapsedFiles((prev) => {
      const val = Boolean(nextCollapsed);
      if (hasOwnKey(prev, key) && prev[key] === val) return prev;
      const next = cloneNullMap(prev);
      next[key] = val;
      return next;
    });
  }, []);

  const handleCommentEditOpenChange = useCallback((delta) => {
    setActiveEditCount((n) => Math.max(0, n + delta));
  }, []);

  const handleRefresh = useCallback(async ({ manual = false } = {}) => {
    if (refreshInFlightRef.current || busyActionRef.current) return null;
    const startDomain = domainRef.current;
    const startRev = diffRevRef.current;
    const savedScrollTop = mainPaneRef.current
      ? mainPaneRef.current.scrollTop
      : null;
    if (savedScrollTop !== null) {
      pendingScrollRestoreRef.current = {
        domain: startDomain,
        scrollTop: savedScrollTop,
        prevRev: startRev,
      };
    }
    probeEpochRef.current += 1;
    refreshInFlightRef.current = true;
    setIsRefreshing(true);
    if (manual) {
      setActionError(null);
    }
    try {
      const res = await invokeRef.current("refresh", {});
      if (domainRef.current !== startDomain) {
        if (pendingScrollRestoreRef.current?.domain === startDomain) {
          pendingScrollRestoreRef.current = null;
        }
        return res;
      }
      if (res && res.ok === false) {
        if (pendingScrollRestoreRef.current?.domain === startDomain) {
          pendingScrollRestoreRef.current = null;
        }
        if (manual && res.error) {
          setActionError(String(res.error));
        }
        return res;
      }
      probeEpochRef.current += 1;
      setHasContextUpdates(false);
      if (savedScrollTop !== null) {
        const schedule =
          typeof requestAnimationFrame === "function"
            ? requestAnimationFrame
            : (fn) => setTimeout(fn, 0);
        schedule(() => {
          const pending = pendingScrollRestoreRef.current;
          if (pending && pending.domain === startDomain) {
            pendingScrollRestoreRef.current = null;
            if (mainPaneRef.current) {
              mainPaneRef.current.scrollTop = savedScrollTop;
            }
          }
        });
      }
      if (manual) {
        const msg = res?.changed ? "Diff updated" : "Already up to date";
        setRefreshFeedback(msg);
        if (refreshToastTimerRef.current) {
          clearTimeout(refreshToastTimerRef.current);
        }
        const toastTimer = setTimeout(() => {
          refreshToastTimerRef.current = null;
          setRefreshFeedback(null);
        }, 2500);
        if (typeof toastTimer === "object" && typeof toastTimer?.unref === "function") {
          toastTimer.unref();
        }
        refreshToastTimerRef.current = toastTimer;
      }
      return res;
    } catch (err) {
      if (pendingScrollRestoreRef.current?.domain === startDomain) {
        pendingScrollRestoreRef.current = null;
      }
      if (manual && domainRef.current === startDomain) {
        setActionError(String(err?.message ?? err));
      }
      return null;
    } finally {
      refreshInFlightRef.current = false;
      setIsRefreshing(false);
    }
  }, []);

  const handleRefreshRef = useRef(handleRefresh);
  handleRefreshRef.current = handleRefresh;

  useEffect(() => {
    if (!state?.loaded || !state?.source?.mode) return undefined;
    const pollMs = state.source.mode === "pr" ? 20_000 : 5_000;
    let disposed = false;

    const runProbe = async () => {
      if (disposed || refreshInFlightRef.current || probeInFlightRef.current) {
        return;
      }
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      const startEpoch = probeEpochRef.current;
      probeInFlightRef.current = true;
      try {
        const res = await invokeRef.current("check_updates", {});
        if (
          disposed ||
          refreshInFlightRef.current ||
          probeEpochRef.current !== startEpoch ||
          res?.transientError
        ) {
          return;
        }
        if (res?.contextSignature && contextSigRef.current) {
          setHasContextUpdates(res.contextSignature !== contextSigRef.current);
        } else if (typeof res?.changed === "boolean") {
          setHasContextUpdates(res.changed);
        }
      } catch {
        // Ignore transient probe errors
      } finally {
        probeInFlightRef.current = false;
      }
    };

    const timerId = setInterval(runProbe, pollMs);
    if (typeof timerId === "object" && typeof timerId?.unref === "function") {
      timerId.unref();
    }
    const onFocus = () => {
      runProbe();
    };
    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        runProbe();
      }
    };

    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("focus", onFocus);
    }
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      disposed = true;
      clearInterval(timerId);
      if (typeof window !== "undefined" && window.removeEventListener) {
        window.removeEventListener("focus", onFocus);
      }
      if (typeof document !== "undefined" && document.removeEventListener) {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [state?.loaded, state?.domain, state?.source?.mode]);

  const hasActiveDraft = activeComposer !== null || activeEditCount > 0;

  useEffect(() => {
    if (
      hasContextUpdates &&
      autoRefresh &&
      !hasActiveDraft &&
      !isRefreshing &&
      !busyAction
    ) {
      handleRefresh({ manual: false });
    }
  }, [hasContextUpdates, autoRefresh, hasActiveDraft, isRefreshing, busyAction, handleRefresh]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.addEventListener) return undefined;
    const isEditableElement = (el) => {
      if (!el || typeof el !== "object") return false;
      const tag = String(el.tagName || el.localName || el.nodeName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return true;
      }
      if (el.isContentEditable) return true;
      if (typeof el.getAttribute === "function") {
        const ce = el.getAttribute("contenteditable");
        if (ce === "" || ce === "true") return true;
      }
      if (typeof el.closest === "function") {
        if (el.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']")) {
          return true;
        }
      }
      return false;
    };
    const onKeyDown = (e) => {
      if (!e || e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (busyActionRef.current || refreshInFlightRef.current) return;
      if (String(e.key || "").toLowerCase() !== "r") return;
      if (isEditableElement(e.target)) return;
      if (typeof document !== "undefined" && isEditableElement(document.activeElement)) {
        return;
      }
      e.preventDefault();
      handleRefreshRef.current({ manual: true });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleToggleViewed = useCallback(
    async (filePath, nextViewed) => {
      const res = await runAction("toggle_viewed", { file: filePath });
      if (!res) return;
      const targetFile = files.find((f) => f.canonicalPath === filePath) || null;
      setCollapsedFiles((prev) => {
        const wantCollapsed = Boolean(
          nextViewed || (targetFile && getAutoCollapseReason(targetFile)),
        );
        if (hasOwnKey(prev, filePath) && prev[filePath] === wantCollapsed) {
          return prev;
        }
        const next = cloneNullMap(prev);
        next[filePath] = wantCollapsed;
        return next;
      });
    },
    [files, runAction],
  );

  const handleOpenComposer = useCallback((file, line, side) => {
    setActiveComposer((prev) =>
      prev && prev.file === file && prev.line === line && prev.side === side
        ? prev
        : { file, line, side },
    );
  }, []);

  const handleCancelComposer = useCallback(() => {
    setActiveComposer(null);
  }, []);

  const handleSaveComment = useCallback(
    async (composerTarget, trimmedBody) => {
      if (!composerTarget || !trimmedBody) return false;
      const res = await runAction("add_comment", {
        file: composerTarget.file,
        line: composerTarget.line,
        side: composerTarget.side,
        body: trimmedBody,
      });
      if (res) {
        setActiveComposer(null);
        return true;
      }
      return false;
    },
    [runAction],
  );

  const handleEditComment = useCallback(
    async (commentId, trimmedBody) => {
      if (!commentId || !trimmedBody) return false;
      const res = await runAction("edit_comment", {
        commentId,
        body: trimmedBody,
      });
      return Boolean(res);
    },
    [runAction],
  );

  const handleDeleteComment = useCallback(
    async (id) => {
      await runAction("delete_comment", { id });
    },
    [runAction],
  );

  const handleSubmitReview = useCallback(async () => {
    const res = await runAction("submit_review", { notifyAgent: true });
    if (res) {
      setActiveComposer(null);
      setManualHandoffNeeded(
        res.status === "pending" && res.notifiedAgent === false,
      );
    }
  }, [runAction]);

  const handleReopenReview = useCallback(async () => {
    const res = await runAction("reopen_review", { clearComments: false });
    if (res) {
      setManualHandoffNeeded(false);
    }
  }, [runAction]);

  const computeEffectiveCollapsed = useCallback(
    (file) => {
      const canonical = file.canonicalPath || "";
      const collapseKey = canonical || String(file.index);
      const autoCollapseReason = getAutoCollapseReason(file);
      const hasExplicitCollapse = hasOwnKey(collapsedFiles, collapseKey);
      const targetedByFocus = Boolean(
        canonical && (selectedFile === canonical || state?.focusedFile === canonical),
      );
      const isCollapsed = hasExplicitCollapse
        ? Boolean(collapsedFiles[collapseKey])
        : Boolean(autoCollapseReason) && !targetedByFocus;
      return { collapseKey, autoCollapseReason, isCollapsed };
    },
    [collapsedFiles, selectedFile, state?.focusedFile],
  );

  const allFilteredExpanded = useMemo(
    () =>
      filteredFiles.length > 0 &&
      filteredFiles.every((f) => !computeEffectiveCollapsed(f).isCollapsed),
    [filteredFiles, computeEffectiveCollapsed],
  );

  const handleToggleAllFiles = useCallback(() => {
    const nextCollapsed = allFilteredExpanded;
    setCollapsedFiles((prev) => {
      const next = cloneNullMap(prev);
      for (const f of filteredFiles) {
        const key = f.canonicalPath || String(f.index);
        next[key] = nextCollapsed;
      }
      return next;
    });
  }, [allFilteredExpanded, filteredFiles]);

  if (!state) {
    return html`
      <div class="dv-shell">
        <div class="dv-empty-wrap ck-empty">
          <${Icon} name="loader-circle" size=${24} class="ck-spinner" />
          <p>Loading diff canvas...</p>
        </div>
      </div>
    `;
  }

  if (!state.loaded) {
    const unloadedRetryLabel = state.error ? "Retry" : "Refresh";
    return html`
      <div class="dv-shell">
        <header class="dv-toolbar">
          <div class="dv-title-group">
            <${Icon} name="git-compare-arrows" size=${16} />
            <span class="dv-title">Diff Viewer</span>
          </div>
          <div class="dv-toolbar-actions">
            <button
              type="button"
              class="ck-btn dv-refresh-btn"
              title="Refresh diff from current context (R)"
              aria-label=${`${unloadedRetryLabel} diff`}
              disabled=${busyAction || isRefreshing}
              onClick=${() => handleRefresh({ manual: true })}
            >
              <${Icon} name="refresh-cw" size=${14} class=${isRefreshing ? "ck-spinner" : ""} />
              <span>${unloadedRetryLabel}</span>
            </button>
          </div>
        </header>
        <div class="dv-empty-wrap">
          <div class="ck-card ck-col">
            <div class="ck-row">
              <${Icon} name="file-diff" size=${20} />
              <strong>No diff loaded yet</strong>
            </div>
            <p class="ck-muted">
              Open this canvas from a Git workspace (<span class="ck-mono">cwd</span>,
              <span class="ck-mono">spec</span>) or target a GitHub pull request directly
              (<span class="ck-mono">repo</span>, <span class="ck-mono">pr</span>).
            </p>
            ${state.error || actionError
              ? html`
                  <div class="ck-callout ck-error">
                    <${Icon} name="circle-x" size=${16} />
                    <span>${state.error || actionError}</span>
                  </div>
                `
              : null}
            <div class="ck-row">
              <button
                type="button"
                class="ck-btn ck-btn-primary dv-unloaded-retry-btn"
                disabled=${busyAction || isRefreshing}
                onClick=${() => handleRefresh({ manual: true })}
              >
                <${Icon} name="refresh-cw" size=${14} class=${isRefreshing ? "ck-spinner" : ""} />
                <span>${unloadedRetryLabel}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  const badge = statusBadgeMeta(state.status);
  const canEditComments = state.status !== "addressed";
  const trimmedFilterQuery = fileQuery.trim();

  return html`
    <div class=${`dv-shell${wrapLines ? " wrap-lines" : ""}`}>
      <header class="dv-toolbar">
        <button
          type="button"
          class="ck-btn dv-icon-btn"
          title="Toggle file tree"
          onClick=${() => setSidebarOpen((v) => !v)}
        >
          <${Icon} name="panel-left" size=${14} />
        </button>

        <div class="dv-title-group">
          <${Icon} name="git-pull-request" size=${16} />
          <span class="dv-title" title=${state.title}>${state.title}</span>
          <span class="dv-stats">
            <span>${state.stats.fileCount} files</span>
            <span class="dv-add">+${state.stats.additions}</span>
            <span class="dv-del">-${state.stats.deletions}</span>
          </span>
        </div>

        <span class=${badge.cls}>
          <${Icon} name=${badge.icon} size=${12} />
          ${badge.label}
        </span>

        ${comments.length > 0
          ? html`
              <span class="ck-badge ck-badge-accent">
                <${Icon} name="message-square" size=${12} />
                ${comments.length} ${comments.length === 1 ? "comment" : "comments"}
              </span>
            `
          : null}

        <div class="dv-toolbar-actions">
          <div class="dv-search-wrap">
            <span class="dv-search-icon"><${Icon} name="search" size=${12} /></span>
            <input
              type="search"
              class="ck-input dv-search-input"
              placeholder="Filter files..."
              aria-label="Filter changed files"
              value=${fileQuery}
              onInput=${(e) => setFileQuery(e.currentTarget.value)}
            />
          </div>

          <div class="dv-seg" role="group" aria-label="Diff layout">
            <button
              type="button"
              aria-pressed=${viewMode === "split"}
              class=${`dv-seg-btn${viewMode === "split" ? " active" : ""}`}
              onClick=${() => setViewMode("split")}
            >
              <${Icon} name="columns-2" size=${14} />
              Split
            </button>
            <button
              type="button"
              aria-pressed=${viewMode === "unified"}
              class=${`dv-seg-btn${viewMode === "unified" ? " active" : ""}`}
              onClick=${() => setViewMode("unified")}
            >
              <${Icon} name="rows-2" size=${14} />
              Unified
            </button>
          </div>

          <div class="dv-seg" role="group" aria-label="Line wrapping">
            <button
              type="button"
              aria-pressed=${!wrapLines}
              class=${`dv-seg-btn${!wrapLines ? " active" : ""}`}
              onClick=${() => setWrapLines(false)}
            >
              No wrap
            </button>
            <button
              type="button"
              aria-pressed=${wrapLines}
              class=${`dv-seg-btn${wrapLines ? " active" : ""}`}
              onClick=${() => setWrapLines(true)}
            >
              <${Icon} name="wrap-text" size=${14} />
              Wrap
            </button>
          </div>

          ${refreshFeedback
            ? html`
                <span class="ck-badge ck-badge-muted dv-refresh-toast" role="status">
                  <${Icon} name="check" size=${12} />
                  ${refreshFeedback}
                </span>
              `
            : null}

          <button
            type="button"
            class=${`ck-btn dv-refresh-btn${hasContextUpdates ? " dv-refresh-has-updates" : ""}`}
            title="Refresh diff from current context (R)"
            aria-label="Refresh diff"
            disabled=${busyAction || isRefreshing}
            onClick=${() => handleRefresh({ manual: true })}
          >
            <${Icon} name="refresh-cw" size=${14} class=${isRefreshing ? "ck-spinner" : ""} />
            <span>Refresh</span>
            ${hasContextUpdates
              ? html`<span class="dv-update-dot" aria-hidden="true"></span>`
              : null}
          </button>

          ${state.status === "addressed"
            ? html`
                <button
                  type="button"
                  class="ck-btn"
                  disabled=${busyAction || isRefreshing}
                  onClick=${handleReopenReview}
                >
                  <${Icon} name="refresh-cw" size=${14} />
                  New Review Round
                </button>
              `
            : html`
                <button
                  type="button"
                  class="ck-btn ck-btn-primary"
                  disabled=${busyAction || isRefreshing}
                  onClick=${handleSubmitReview}
                >
                  <${Icon} name="circle-check" size=${14} />
                  ${state.status === "pending" ? "Resubmit Review" : "Submit Review"}
                </button>
              `}
        </div>
      </header>

      ${hasContextUpdates
        ? html`
            <div class="ck-callout dv-update-banner" role="status">
              <div class="dv-update-banner-msg">
                <${Icon} name="refresh-cw" size=${15} class=${isRefreshing ? "ck-spinner" : ""} />
                <span>
                  ${state.source?.mode === "pr"
                    ? "New changes detected in pull request"
                    : "Changes detected in Git context"}${autoRefresh && hasActiveDraft
                    ? " (Auto-refresh paused while editing comment)"
                    : ""}
                </span>
              </div>
              <div class="dv-update-banner-actions">
                <label class="dv-autorefresh-toggle">
                  <input
                    type="checkbox"
                    checked=${autoRefresh}
                    onChange=${(e) => setAutoRefresh(Boolean(e.currentTarget.checked))}
                  />
                  <span>Auto-refresh</span>
                </label>
                <button
                  type="button"
                  class="ck-btn ck-btn-primary dv-banner-refresh-btn"
                  disabled=${busyAction || isRefreshing}
                  onClick=${() => handleRefresh({ manual: true })}
                >
                  <${Icon} name="refresh-cw" size=${13} class=${isRefreshing ? "ck-spinner" : ""} />
                  <span>Refresh diff</span>
                </button>
              </div>
            </div>
          `
        : null}

      ${actionError || state.error
        ? html`
            <div class="ck-callout ck-error dv-error-banner">
              <${Icon} name="circle-x" size=${16} />
              <span>${actionError || state.error}</span>
            </div>
          `
        : null}

      ${manualHandoffNeeded && state.status === "pending"
        ? html`
            <div class="ck-callout dv-handoff-banner" role="status">
              <${Icon} name="circle-check" size=${16} />
              <span>Review saved locally. If your coding harness isn't waiting automatically, ask your agent to run /diff review.</span>
            </div>
          `
        : null}

      <div class="dv-workspace">
        ${sidebarOpen
          ? html`
              <aside class="dv-sidebar" style=${{ width: `${sidebarWidth}px` }} aria-label="Changed files">
                <div class="dv-sidebar-header">
                  <span>Files (${filteredFiles.length}/${files.length})</span>
                  <span class="dv-sidebar-meta">
                    <span>${viewedFilteredCount} viewed</span>
                    ${filteredFiles.length > 0
                      ? html`
                          <button
                            type="button"
                            class="dv-sidebar-toggle-btn"
                            onClick=${handleToggleAllFiles}
                          >
                            ${allFilteredExpanded ? "Collapse all" : "Expand all"}
                          </button>
                        `
                      : null}
                  </span>
                </div>
                <div class="dv-tree-scroll">
                  <${FileTreeNodes}
                    nodes=${fileTree}
                    depth=${0}
                    collapsedDirs=${collapsedDirs}
                    onToggleDir=${(dirPath) =>
                      setCollapsedDirs((prev) => {
                        const next = cloneNullMap(prev);
                        next[dirPath] = !(
                          hasOwnKey(prev, dirPath) && Boolean(prev[dirPath])
                        );
                        return next;
                      })}
                    selectedFile=${selectedFile}
                    onSelectFile=${(filePath) => scrollToFile(filePath)}
                    viewedSet=${viewedSet}
                    commentsByFile=${commentCountsByFile}
                  />
                </div>
              </aside>
              <div
                class="dv-resizer"
                title="Drag to resize file tree"
                onMouseDown=${startSidebarResize}
              ></div>
            `
          : null}

        <main class="dv-main" ref=${mainPaneRef}>
          ${state.truncatedFiles
            ? html`
                <div class="ck-callout dv-truncation-banner">
                  <${Icon} name="circle-dot" size=${16} />
                  <span>
                    Showing ${files.length}${state.stats?.totalFiles > files.length ? ` of ${state.stats.totalFiles}` : ""} changed files (diff truncated at size or file limit). Scope with file paths to inspect remaining files.
                  </span>
                </div>
              `
            : null}

          ${orphanComments.length > 0
            ? html`
                <section class="dv-orphan-comments-card" aria-label="Comments on files outside current diff">
                  <div class="dv-unanchored-label">Comments on files no longer in this diff</div>
                  ${orphanComments.map(
                    (c) => html`
                      <${CommentCard}
                        key=${c.id}
                        comment=${c}
                        canEditComments=${canEditComments}
                        busyAction=${busyAction}
                        onEditComment=${handleEditComment}
                        onDeleteComment=${handleDeleteComment}
                        onEditOpenChange=${handleCommentEditOpenChange}
                      />
                    `,
                  )}
                </section>
              `
            : null}

          ${files.length === 0
            ? html`
                <div class="ck-empty">
                  <p>Working tree is clean - no changes detected.</p>
                </div>
              `
            : filteredFiles.length === 0
              ? html`
                  <div class="ck-empty">
                    <p>No changed files match "${trimmedFilterQuery}".</p>
                  </div>
                `
              : filteredFiles.map((file) => {
                  const canonical = file.canonicalPath || "";
                  const { autoCollapseReason, isCollapsed } = computeEffectiveCollapsed(file);
                  const isFocusedFile = Boolean(canonical && state.focusedFile === canonical);
                  const fileComments = commentsByFileMap.get(canonical) || EMPTY_ARRAY;
                  const fileComposer =
                    activeComposer?.file === canonical ? activeComposer : null;
                  const cardBusyAction =
                    fileComments.length > 0 || fileComposer !== null
                      ? busyAction
                      : false;

                  return html`
                    <${FileDiffCard}
                      key=${`${canonical}:${file.index}`}
                      file=${file}
                      viewMode=${viewMode}
                      splitLeftPct=${splitLeftPct}
                      onStartSplitResize=${startSplitResize}
                      isViewed=${viewedSet.has(canonical)}
                      isCollapsed=${isCollapsed}
                      autoCollapseReason=${autoCollapseReason}
                      isFocusedFile=${isFocusedFile}
                      focusedLine=${isFocusedFile ? state.focusedLine : null}
                      onToggleCollapse=${handleToggleCollapse}
                      onToggleViewed=${handleToggleViewed}
                      commentsForFile=${fileComments}
                      canEditComments=${canEditComments}
                      activeComposerForFile=${fileComposer}
                      onOpenComposer=${handleOpenComposer}
                      onSaveComment=${handleSaveComment}
                      onCancelComposer=${handleCancelComposer}
                      onEditComment=${handleEditComment}
                      onDeleteComment=${handleDeleteComment}
                      onEditOpenChange=${handleCommentEditOpenChange}
                      busyAction=${cardBusyAction}
                    />
                  `;
                })}
        </main>
      </div>
    </div>
  `;
}

if (
  typeof document !== "undefined" &&
  !globalThis.__DIFF_SKIP_AUTO_MOUNT__ &&
  document.getElementById("app")
) {
  mountCanvas({
    view: ({ state, invoke }) => html`<${DiffCanvasApp} state=${state} invoke=${invoke} />`,
  });
}
