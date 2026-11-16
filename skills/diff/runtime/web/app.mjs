import {
  html,
  mountCanvas,
  useState,
  useEffect,
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

function CodeTokens({ text, language, segments, highlightClass }) {
  if (Array.isArray(segments) && segments.length > 0) {
    return html`<>${segments.map((seg, idx) =>
      seg.changed
        ? html`<span key=${idx} class=${highlightClass}>${seg.text}</span>`
        : seg.text,
    )}</>`;
  }
  const tokens = tokenizeCodeLine(text, language);
  return html`<>${tokens.map((tok, idx) =>
    tok.kind === "plain"
      ? tok.text
      : html`<span key=${idx} class=${`tok-${tok.kind}`}>${tok.text}</span>`,
  )}</>`;
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
          const isCollapsed = Boolean(collapsedDirs[node.path]);
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

function ThreadRows({
  colSpan,
  rowComments,
  composerHere,
  activeComposer,
  draftBody,
  setDraftBody,
  onSaveComment,
  onCancelComposer,
  onDeleteComment,
  canEditComments,
  busyAction,
}) {
  if (rowComments.length === 0 && !composerHere) return null;

  return html`
    <tr>
      <td colSpan=${colSpan} class="dv-thread-cell">
        ${rowComments.map(
          (c) => html`
            <div key=${c.id} class="dv-comment-card">
              <div class="dv-comment-head">
                <span class="ck-mono">${c.file}:${c.line} (${c.side}) · ${c.createdAt ? relativeTime(c.createdAt) : "saved"}</span>
                ${canEditComments
                  ? html`
                      <button
                        type="button"
                        class="ck-btn dv-icon-btn"
                        title="Delete comment"
                        disabled=${busyAction}
                        onClick=${() => onDeleteComment(c.id)}
                      >
                        <${Icon} name="trash-2" size=${12} />
                      </button>
                    `
                  : null}
              </div>
              <div class="dv-comment-body">${c.body}</div>
            </div>
          `,
        )}
        ${composerHere
          ? html`
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
                      onSaveComment();
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
                    disabled=${busyAction || !draftBody.trim()}
                    onClick=${onSaveComment}
                  >
                    <${Icon} name="message-square-plus" size=${14} />
                    Add comment
                  </button>
                </div>
              </div>
            `
          : null}
      </td>
    </tr>
  `;
}

function FileDiffCard({
  file,
  viewMode,
  splitLeftPct,
  onStartSplitResize,
  isViewed,
  isCollapsed,
  isFocusedFile,
  focusedLine,
  onToggleCollapse,
  onToggleViewed,
  commentsForFile,
  canEditComments,
  activeComposer,
  onOpenComposer,
  draftBody,
  setDraftBody,
  onSaveComment,
  onCancelComposer,
  onDeleteComment,
  busyAction,
}) {
  const canonical = file.canonicalPath || "";
  const leftCodePct = `${splitLeftPct}%`;
  const rightCodePct = `${100 - splitLeftPct}%`;

  const commentLookup = useMemo(() => {
    const byAnchor = new Map();
    for (const c of commentsForFile) {
      const key = `${c.side}:${c.line}`;
      if (!byAnchor.has(key)) byAnchor.set(key, []);
      byAnchor.get(key).push(c);
    }
    return byAnchor;
  }, [commentsForFile]);

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
      class=${`dv-file-card${isCollapsed ? " collapsed" : ""}${isFocusedFile ? " focused" : ""}`}
    >
      <header class="dv-file-header">
        <button
          type="button"
          class="dv-collapse-btn"
          title=${isCollapsed ? "Expand file" : "Collapse file"}
          onClick=${() => onToggleCollapse(canonical || String(file.index))}
        >
          <${Icon} name=${isCollapsed ? "chevron-right" : "chevron-down"} size=${14} />
        </button>
        <${Icon} name=${fileIconName(file.status)} size=${14} />
        <span class="dv-file-path">${file.displayPath || canonical}</span>
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

      ${!isCollapsed
        ? html`
            <div class="dv-file-body">
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
                        <table class="dv-table">
                          <colgroup>
                            <col style="width: 48px" />
                            <col style=${{ width: leftCodePct }} />
                            <col style="width: 48px" />
                            <col style=${{ width: rightCodePct }} />
                          </colgroup>
                          <tbody>
                            ${rows.map((row, rowIdx) => {
                              if (row.kind === "meta") {
                                return html`
                                  <tr key=${`meta:${rowIdx}`}>
                                    <td colSpan=${4} class="dv-code dv-cell-empty ck-muted">${row.text}</td>
                                  </tr>
                                `;
                              }
                              const l = row.left;
                              const r = row.right;
                              const leftLine = l?.oldLine ?? null;
                              const rightLine = r?.newLine ?? null;
                              const isContextPair = l && r && l === r;

                              const leftComments = leftLine !== null ? commentLookup.get(`left:${leftLine}`) || [] : [];
                              const rightComments = rightLine !== null ? commentLookup.get(`right:${rightLine}`) || [] : [];
                              const rowComments = [...leftComments, ...rightComments];

                              const composerOnLeft =
                                activeComposer &&
                                activeComposer.file === canonical &&
                                activeComposer.side === "left" &&
                                activeComposer.line === leftLine;
                              const composerOnRight =
                                activeComposer &&
                                activeComposer.file === canonical &&
                                activeComposer.side === "right" &&
                                activeComposer.line === rightLine;
                              const composerHere = Boolean(composerOnLeft || composerOnRight);

                              const lineFocused =
                                isFocusedFile &&
                                focusedLine !== null &&
                                (leftLine === focusedLine || rightLine === focusedLine);

                              return html`
                                <>
                                  <tr
                                    key=${`r:${rowIdx}`}
                                    data-line=${rightLine ?? leftLine ?? undefined}
                                    class=${lineFocused ? "dv-line-focused" : ""}
                                  >
                                    <td
                                      class=${`dv-ln${l ? (l.type === "del" ? " dv-cell-del" : "") : " dv-cell-empty"}${canEditComments && canonical && leftLine !== null ? " commentable" : ""}`}
                                      onClick=${() => {
                                        if (canEditComments && canonical && leftLine !== null) {
                                          onOpenComposer(canonical, leftLine, "left");
                                        }
                                      }}
                                    >
                                      ${canEditComments && canonical && leftLine !== null
                                        ? html`<span class="dv-ln-plus"><${Icon} name="message-square-plus" size=${12} /></span>`
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
                                      class=${`dv-ln${r ? (r.type === "add" ? " dv-cell-add" : "") : " dv-cell-empty"}${canEditComments && canonical && rightLine !== null ? " commentable" : ""}`}
                                      onClick=${() => {
                                        if (canEditComments && canonical && rightLine !== null) {
                                          onOpenComposer(canonical, rightLine, "right");
                                        }
                                      }}
                                    >
                                      ${canEditComments && canonical && rightLine !== null
                                        ? html`<span class="dv-ln-plus"><${Icon} name="message-square-plus" size=${12} /></span>`
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
                                  <${ThreadRows}
                                    colSpan=${4}
                                    rowComments=${rowComments}
                                    composerHere=${composerHere}
                                    activeComposer=${activeComposer}
                                    draftBody=${draftBody}
                                    setDraftBody=${setDraftBody}
                                    onSaveComment=${onSaveComment}
                                    onCancelComposer=${onCancelComposer}
                                    onDeleteComment=${onDeleteComment}
                                    canEditComments=${canEditComments}
                                    busyAction=${busyAction}
                                  />
                                </>
                              `;
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
                        <table class="dv-table">
                          <colgroup>
                            <col style="width: 44px" />
                            <col style="width: 44px" />
                            <col />
                          </colgroup>
                          <tbody>
                            ${hunk.lines.map((ln, lineIdx) => {
                              if (ln.type === "meta") {
                                return html`
                                  <tr key=${`meta:${lineIdx}`}>
                                    <td colSpan=${3} class="dv-code dv-cell-empty ck-muted">${ln.text}</td>
                                  </tr>
                                `;
                              }
                              const oldLine = ln.oldLine;
                              const newLine = ln.newLine;
                              const rowCls = ln.type === "add" ? "dv-row-add" : ln.type === "del" ? "dv-row-del" : "";

                              const leftComments =
                                ln.type !== "add" && oldLine !== null
                                  ? commentLookup.get(`left:${oldLine}`) || []
                                  : [];
                              const rightComments =
                                ln.type !== "del" && newLine !== null
                                  ? commentLookup.get(`right:${newLine}`) || []
                                  : [];
                              const rowComments = [...leftComments, ...rightComments];

                              const composerHere = Boolean(
                                activeComposer &&
                                  activeComposer.file === canonical &&
                                  ((activeComposer.side === "left" && ln.type !== "add" && activeComposer.line === oldLine) ||
                                    (activeComposer.side === "right" && ln.type !== "del" && activeComposer.line === newLine)),
                              );

                              const lineFocused =
                                isFocusedFile &&
                                focusedLine !== null &&
                                (oldLine === focusedLine || newLine === focusedLine);

                              return html`
                                <>
                                  <tr
                                    key=${`u:${lineIdx}`}
                                    data-line=${newLine ?? oldLine ?? undefined}
                                    class=${`${rowCls}${lineFocused ? " dv-line-focused" : ""}`}
                                  >
                                    <td
                                      class=${`dv-ln dv-ln-unified${canEditComments && canonical && oldLine !== null ? " commentable" : ""}`}
                                      onClick=${() => {
                                        if (canEditComments && canonical && oldLine !== null) {
                                          onOpenComposer(canonical, oldLine, "left");
                                        }
                                      }}
                                    >
                                      ${oldLine !== null ? oldLine : ""}
                                    </td>
                                    <td
                                      class=${`dv-ln dv-ln-unified${canEditComments && canonical && newLine !== null ? " commentable" : ""}`}
                                      onClick=${() => {
                                        if (canEditComments && canonical && newLine !== null) {
                                          onOpenComposer(canonical, newLine, "right");
                                        }
                                      }}
                                    >
                                      ${newLine !== null ? newLine : ""}
                                    </td>
                                    <td class="dv-code">
                                      <span class="dv-prefix">${ln.type === "add" ? "+" : ln.type === "del" ? "-" : " "}</span>
                                      <${CodeTokens} text=${ln.text} language=${file.language} />
                                    </td>
                                  </tr>
                                  <${ThreadRows}
                                    colSpan=${3}
                                    rowComments=${rowComments}
                                    composerHere=${composerHere}
                                    activeComposer=${activeComposer}
                                    draftBody=${draftBody}
                                    setDraftBody=${setDraftBody}
                                    onSaveComment=${onSaveComment}
                                    onCancelComposer=${onCancelComposer}
                                    onDeleteComment=${onDeleteComment}
                                    canEditComments=${canEditComments}
                                    busyAction=${busyAction}
                                  />
                                </>
                              `;
                            })}
                          </tbody>
                        </table>
                      </div>
                    `)}
            </div>
          `
        : null}
    </section>
  `;
}

function DiffCanvasApp({ state, invoke }) {
  // Local UI state strictly separated from SSE domain state so live updates
  // never overwrite focus, filter queries, or in-progress comment text.
  const [viewMode, setViewMode] = useState("split");
  const [wrapLines, setWrapLines] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [splitLeftPct, setSplitLeftPct] = useState(50);
  const [fileQuery, setFileQuery] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [collapsedDirs, setCollapsedDirs] = useState({});
  const [collapsedFiles, setCollapsedFiles] = useState({});
  const [activeComposer, setActiveComposer] = useState(null);
  const [draftBody, setDraftBody] = useState("");
  const [actionError, setActionError] = useState(null);
  const [busyAction, setBusyAction] = useState(false);

  const mainPaneRef = useRef(null);

  const files = state?.files || [];
  const comments = state?.comments || [];
  const viewedFiles = state?.viewedFiles || [];

  const viewedSet = useMemo(() => new Set(viewedFiles), [viewedFiles]);

  const commentsByFileMap = useMemo(() => {
    const map = new Map();
    for (const c of comments) {
      if (!map.has(c.file)) map.set(c.file, []);
      map.get(c.file).push(c);
    }
    return map;
  }, [comments]);

  const commentCountsByFile = useMemo(() => {
    const counts = new Map();
    for (const [f, list] of commentsByFileMap.entries()) {
      counts.set(f, list.length);
    }
    return counts;
  }, [commentsByFileMap]);

  const filteredFiles = useMemo(() => {
    const q = fileQuery.trim().toLowerCase();
    if (!q) return files;
    return files.filter(
      (f) =>
        (f.canonicalPath || "").toLowerCase().includes(q) ||
        (f.displayPath || "").toLowerCase().includes(q),
    );
  }, [files, fileQuery]);

  const fileTree = useMemo(() => buildFileTree(filteredFiles), [filteredFiles]);

  const scrollToFile = useCallback((canonicalPath, line = null) => {
    setSelectedFile(canonicalPath);
    setCollapsedFiles((prev) => {
      if (!prev[canonicalPath]) return prev;
      const next = { ...prev };
      delete next[canonicalPath];
      return next;
    });
    requestAnimationFrame(() => {
      const root = mainPaneRef.current || document;
      const cards = root.querySelectorAll("[data-canonical-file]");
      for (const card of cards) {
        if (card.getAttribute("data-canonical-file") !== canonicalPath) continue;
        if (line !== null) {
          const lineRow = card.querySelector(`tr[data-line="${CSS.escape(String(line))}"]`);
          if (lineRow) {
            lineRow.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
          }
        }
        card.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    });
  }, []);

  useEffect(() => {
    if (state?.focusSeq && state?.focusedFile) {
      scrollToFile(state.focusedFile, state.focusedLine ?? null);
    }
  }, [state?.focusSeq, state?.focusedFile, state?.focusedLine, scrollToFile]);

  const startSidebarResize = useCallback(
    (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      const onMove = (ev) => {
        const next = Math.max(150, Math.min(window.innerWidth * 0.55, startWidth + (ev.clientX - startX)));
        setSidebarWidth(Math.round(next));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );

  const startSplitResize = useCallback(
    (e) => {
      e.preventDefault();
      const wrapEl = e.currentTarget.parentElement;
      if (!wrapEl) return;
      const rect = wrapEl.getBoundingClientRect();
      const codeWidth = Math.max(200, rect.width - 96);
      const startX = e.clientX;
      const startPct = splitLeftPct;
      const onMove = (ev) => {
        const deltaPct = ((ev.clientX - startX) / codeWidth) * 100;
        const clamped = Math.max(20, Math.min(80, startPct + deltaPct));
        setSplitLeftPct(Math.round(clamped * 10) / 10);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [splitLeftPct],
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

  const handleToggleViewed = useCallback(
    async (filePath, nextViewed) => {
      setCollapsedFiles((prev) => ({ ...prev, [filePath]: nextViewed }));
      await runAction("toggle_viewed", { file: filePath });
    },
    [runAction],
  );

  const handleOpenComposer = useCallback((file, line, side) => {
    setActiveComposer((prev) => {
      if (prev && prev.file === file && prev.line === line && prev.side === side) {
        return prev;
      }
      setDraftBody("");
      return { file, line, side };
    });
  }, []);

  const handleSaveComment = useCallback(async () => {
    if (!activeComposer || !draftBody.trim()) return;
    const res = await runAction("add_comment", {
      file: activeComposer.file,
      line: activeComposer.line,
      side: activeComposer.side,
      body: draftBody.trim(),
    });
    if (res) {
      setDraftBody("");
      setActiveComposer(null);
    }
  }, [activeComposer, draftBody, runAction]);

  const handleDeleteComment = useCallback(
    async (id) => {
      await runAction("delete_comment", { id });
    },
    [runAction],
  );

  const handleSubmitReview = useCallback(async () => {
    const res = await runAction("submit_review", {});
    if (res) {
      setActiveComposer(null);
      setDraftBody("");
    }
  }, [runAction]);

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
    return html`
      <div class="dv-shell">
        <header class="dv-toolbar">
          <div class="dv-title-group">
            <${Icon} name="git-compare-arrows" size=${16} />
            <span class="dv-title">Diff Viewer</span>
          </div>
        </header>
        <div class="dv-empty-wrap">
          <div class="ck-card ck-col">
            <div class="ck-row">
              <${Icon} name="file-diff" size=${20} />
              <strong>No diff loaded yet</strong>
            </div>
            <p class="ck-muted">
              Open this canvas from a Git workspace or pass a prepared review payload
              (<span class="ck-mono">reviewId</span>, <span class="ck-mono">repoSlug</span>,
              <span class="ck-mono">branchSlug</span>) or <span class="ck-mono">cwd</span> + <span class="ck-mono">spec</span>.
            </p>
            ${state.error
              ? html`
                  <div class="ck-callout ck-error">
                    <${Icon} name="circle-x" size=${16} />
                    <span>${state.error}</span>
                  </div>
                `
              : null}
          </div>
        </div>
      </div>
    `;
  }

  const badge = statusBadgeMeta(state.status);
  const canEditComments = state.status === "draft";

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

        <div class="dv-spacer"></div>

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

        <div class="dv-seg" role="tablist" aria-label="Diff layout">
          <button
            type="button"
            role="tab"
            aria-selected=${viewMode === "split"}
            class=${`dv-seg-btn${viewMode === "split" ? " active" : ""}`}
            onClick=${() => setViewMode("split")}
          >
            <${Icon} name="columns-2" size=${14} />
            Split
          </button>
          <button
            type="button"
            role="tab"
            aria-selected=${viewMode === "unified"}
            class=${`dv-seg-btn${viewMode === "unified" ? " active" : ""}`}
            onClick=${() => setViewMode("unified")}
          >
            <${Icon} name="rows-2" size=${14} />
            Unified
          </button>
        </div>

        <div class="dv-seg" role="tablist" aria-label="Line wrapping">
          <button
            type="button"
            role="tab"
            aria-selected=${!wrapLines}
            class=${`dv-seg-btn${!wrapLines ? " active" : ""}`}
            onClick=${() => setWrapLines(false)}
          >
            No wrap
          </button>
          <button
            type="button"
            role="tab"
            aria-selected=${wrapLines}
            class=${`dv-seg-btn${wrapLines ? " active" : ""}`}
            onClick=${() => setWrapLines(true)}
          >
            <${Icon} name="wrap-text" size=${14} />
            Wrap
          </button>
        </div>

        <button
          type="button"
          class="ck-btn dv-icon-btn"
          title="Reload diff"
          disabled=${busyAction}
          onClick=${() => runAction("load_diff", {})}
        >
          <${Icon} name="refresh-cw" size=${14} />
        </button>

        <button
          type="button"
          class="ck-btn ck-btn-primary"
          disabled=${busyAction || state.status !== "draft"}
          onClick=${handleSubmitReview}
        >
          <${Icon} name="circle-check" size=${14} />
          ${state.status === "draft" ? "Submit Review" : "Review Submitted"}
        </button>
      </header>

      ${actionError
        ? html`
            <div class="ck-callout ck-error dv-error-banner">
              <${Icon} name="circle-x" size=${16} />
              <span>${actionError}</span>
            </div>
          `
        : null}

      <div class="dv-workspace">
        ${sidebarOpen
          ? html`
              <aside class="dv-sidebar" style=${{ width: `${sidebarWidth}px` }} aria-label="Changed files">
                <div class="dv-sidebar-header">
                  <span>Changed files (${filteredFiles.length}/${files.length})</span>
                  <span>${viewedSet.size} viewed</span>
                </div>
                <div class="dv-tree-scroll">
                  <${FileTreeNodes}
                    nodes=${fileTree}
                    depth=${0}
                    collapsedDirs=${collapsedDirs}
                    onToggleDir=${(dirPath) =>
                      setCollapsedDirs((prev) => ({ ...prev, [dirPath]: !prev[dirPath] }))}
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
          ${filteredFiles.length === 0
            ? html`
                <div class="ck-empty">
                  <p>No changed files match the current filter.</p>
                </div>
              `
            : filteredFiles.map((file) => {
                const canonical = file.canonicalPath || "";
                const collapseKey = canonical || String(file.index);
                return html`
                  <${FileDiffCard}
                    key=${`${canonical}:${file.index}`}
                    file=${file}
                    viewMode=${viewMode}
                    splitLeftPct=${splitLeftPct}
                    onStartSplitResize=${startSplitResize}
                    isViewed=${viewedSet.has(canonical)}
                    isCollapsed=${Boolean(collapsedFiles[collapseKey])}
                    isFocusedFile=${ Boolean(canonical && state.focusedFile === canonical) }
                    focusedLine=${state.focusedLine}
                    onToggleCollapse=${(key) =>
                      setCollapsedFiles((prev) => ({ ...prev, [key]: !prev[key] }))}
                    onToggleViewed=${handleToggleViewed}
                    commentsForFile=${commentsByFileMap.get(canonical) || []}
                    canEditComments=${canEditComments}
                    activeComposer=${activeComposer}
                    onOpenComposer=${handleOpenComposer}
                    draftBody=${draftBody}
                    setDraftBody=${setDraftBody}
                    onSaveComment=${handleSaveComment}
                    onCancelComposer=${() => {
                      setActiveComposer(null);
                      setDraftBody("");
                    }}
                    onDeleteComment=${handleDeleteComment}
                    busyAction=${busyAction}
                  />
                `;
              })}
        </main>
      </div>
    </div>
  `;
}

mountCanvas({
  view: ({ state, invoke }) => html`<${DiffCanvasApp} state=${state} invoke=${invoke} />`,
});
