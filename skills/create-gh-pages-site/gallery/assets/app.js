// Renders the template catalog from ./templates.json (built by build-site.mjs),
// with search, type filters, a decision wizard, and live previews. No build.

const TIER_LABEL = { static: "Static", ssg: "SSG", spa: "SPA", data: "Data", native: "Native" };

const SKILL_PROMPT = {
  "static-html": "a static HTML site",
  "astro": "an Astro site",
  "react-vite": "a React (Vite) app",
  "eleventy": "an Eleventy site",
  "jekyll": "a Jekyll site",
};
const promptFor = (t) => `/create-gh-pages-site ${SKILL_PROMPT[t.name] || `a ${t.framework} site`} for owner/repo`;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "href") node.href = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

let ALL = [];
const state = { query: "", tier: "all" };

// ---- filtering ------------------------------------------------------------
function matches(t) {
  if (state.tier !== "all" && t.tier !== state.tier) return false;
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    t.title, t.tagline, t.description, t.framework,
    (t.tags || []).join(" "), (t.features || []).join(" "),
  ].join(" ").toLowerCase();
  return hay.includes(q);
}

// ---- card -----------------------------------------------------------------
function card(t) {
  const head = el("div", { class: "card-head" },
    el("h3", { text: t.title }),
    el("span", { class: `badge badge-${t.tier}`, text: TIER_LABEL[t.tier] || t.tier }),
  );

  const meta = el("dl", { class: "meta" },
    el("dt", { text: "Framework" }), el("dd", { text: t.framework }),
    el("dt", { text: "Base path" }), el("dd", { text: t.basePathMechanism }),
  );

  const features = (t.features && t.features.length)
    ? el("ul", { class: "features" }, ...t.features.map((f) => el("li", { text: f })))
    : null;

  const tags = el("div", { class: "tags" }, ...(t.tags || []).map((tag) => el("span", { class: "tag", text: tag })));

  const actions = el("div", { class: "actions" },
    el("a", { class: "btn btn-sm", href: `https://jongio.github.io/gh-pages-templates/preview/${t.name}/`, target: "_blank", rel: "noopener" }, "Live preview ↗"),
    el("a", { class: "btn btn-sm btn-ghost", href: `https://github.com/jongio/gh-pages-templates/tree/main/templates/${t.name}`, target: "_blank", rel: "noopener" }, "Source ↗"),
  );

  const use = el("div", { class: "use" },
    el("span", { class: "use-label", text: "Ask Copilot" }),
    el("code", { class: "cmd", text: promptFor(t) }),
    el("span", { class: "use-label", text: "Or the CLI" }),
    el("code", { class: "cmd", text: `new-site.mjs ${t.name} --repo owner/name` }),
  );

  return el("article", { class: "card", "data-template": t.name },
    head,
    el("p", { class: "tagline", text: t.tagline }),
    el("p", { class: "desc", text: t.description }),
    meta,
    features,
    tags,
    actions,
    use,
  );
}

function renderGrid() {
  const host = document.getElementById("templates");
  if (!host) return;
  const list = ALL.filter(matches);
  host.innerHTML = "";
  if (!list.length) {
    host.append(el("p", { class: "muted", text: "No templates match your search." }));
    return;
  }
  host.append(el("div", { class: "grid" }, ...list.map(card)));
}

function renderFilters() {
  const wrap = document.getElementById("tier-filters");
  if (!wrap) return;
  const tiers = ["all", ...Array.from(new Set(ALL.map((t) => t.tier)))];
  wrap.innerHTML = "";
  for (const tier of tiers) {
    const b = el("button", {
      class: "chip" + (state.tier === tier ? " chip-on" : ""),
      type: "button",
      "aria-pressed": String(state.tier === tier),
    }, tier === "all" ? "All" : (TIER_LABEL[tier] || tier));
    b.addEventListener("click", () => { state.tier = tier; renderFilters(); renderGrid(); });
    wrap.append(b);
  }
}

// ---- wizard ---------------------------------------------------------------
const WIZARD = [
  {
    q: "What are you building?",
    a: [
      { label: "An interactive app or dashboard", pick: "react-vite" },
      { label: "A content site, blog, or docs", next: 1 },
      { label: "Just a few simple pages", pick: "static-html" },
    ],
  },
  {
    q: "How do you want to author content?",
    a: [
      { label: "Components + Markdown, fast by default", pick: "astro" },
      { label: "Markdown + data files (SSG)", pick: "eleventy" },
      { label: "The GitHub-native way (Jekyll)", pick: "jekyll" },
      { label: "Hand-written HTML, no tooling", pick: "static-html" },
    ],
  },
];

function renderWizardStep(i) {
  const body = document.getElementById("wizard-body");
  const step = WIZARD[i];
  body.innerHTML = "";
  body.append(el("p", { class: "wizard-step", text: `Step ${i + 1} of ${WIZARD.length}` }));
  body.append(el("h3", { text: step.q }));
  const opts = el("div", { class: "wizard-opts" });
  for (const opt of step.a) {
    const b = el("button", { class: "btn btn-ghost wizard-opt", type: "button" }, opt.label);
    b.addEventListener("click", () => (opt.pick ? finishWizard(opt.pick) : renderWizardStep(opt.next)));
    opts.append(b);
  }
  body.append(opts);
  const cancel = el("button", { class: "wizard-cancel", type: "button" }, "Cancel");
  cancel.addEventListener("click", () => document.getElementById("wizard").close());
  body.append(cancel);
}

function finishWizard(name) {
  document.getElementById("wizard").close();
  state.tier = "all";
  state.query = "";
  const search = document.getElementById("search");
  if (search) search.value = "";
  renderFilters();
  renderGrid();
  requestAnimationFrame(() => {
    const cardEl = document.querySelector(`[data-template="${name}"]`);
    if (cardEl) {
      cardEl.classList.add("recommended");
      cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => cardEl.classList.remove("recommended"), 4000);
    }
  });
}

// ---- wiring ---------------------------------------------------------------
document.getElementById("search")?.addEventListener("input", (e) => {
  state.query = e.target.value;
  renderGrid();
});
document.getElementById("wizard-open")?.addEventListener("click", () => {
  renderWizardStep(0);
  document.getElementById("wizard").showModal();
});

// ---- Theme toggle (same UX the templates ship) ----------------------------
const SUN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const themeBtn = document.getElementById("theme-toggle");
function renderThemeIcon() {
  if (themeBtn) themeBtn.innerHTML = document.documentElement.getAttribute("data-theme") === "dark" ? SUN : MOON;
}
renderThemeIcon();
themeBtn?.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("theme", next); } catch (e) {}
  renderThemeIcon();
});

const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = String(new Date().getFullYear());

async function load() {
  const host = document.getElementById("templates");
  try {
    const res = await fetch("./templates.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ALL = await res.json();
    host.setAttribute("aria-busy", "false");
    renderFilters();
    renderGrid();
  } catch (err) {
    host.innerHTML = "";
    host.append(el("p", { class: "error", text: `Couldn't load templates: ${err.message}` }));
    host.setAttribute("aria-busy", "false");
  }
}

load();
