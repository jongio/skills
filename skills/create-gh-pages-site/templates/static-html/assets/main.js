// Zero-dependency interactivity for the static-html template:
// theme toggle, tabs, fetch states, form validation, and a native dialog.

const root = document.documentElement;

// ---- Theme toggle ---------------------------------------------------------
const SUN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const toggle = document.getElementById("theme-toggle");
function renderToggle() {
  if (toggle) toggle.innerHTML = root.getAttribute("data-theme") === "dark" ? SUN : MOON;
}
renderToggle();
toggle?.addEventListener("click", () => {
  const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", next);
  try { localStorage.setItem("theme", next); } catch (e) {}
  renderToggle();
});

// ---- Tabs (ARIA) ----------------------------------------------------------
const tablist = document.querySelector('[role="tablist"]');
if (tablist) {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    }
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      next.focus(); select(next);
    });
  });
}

// ---- Fetch with loading / error / data states -----------------------------
const esc = (s) => { const d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; };
const out = document.getElementById("fetch-out");
async function loadData(url) {
  if (!out) return;
  out.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const items = data.features || [];
    out.innerHTML = "<ul>" + items.map((f) => `<li><b>${esc(f.name)}</b>${esc(f.detail)}</li>`).join("") + "</ul>";
  } catch (err) {
    out.innerHTML = `<div class="callout-err">Couldn't load: ${esc(err.message)}</div>`;
  }
}
document.getElementById("load-btn")?.addEventListener("click", () => loadData("./assets/data.json"));
document.getElementById("fail-btn")?.addEventListener("click", () => loadData("./assets/does-not-exist.json"));

// ---- Form validation ------------------------------------------------------
const form = document.getElementById("demo-form");
if (form) {
  const email = document.getElementById("email");
  const error = document.getElementById("email-error");
  const ok = document.getElementById("form-ok");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (ok) ok.hidden = true;
    if (!email.checkValidity()) {
      email.setAttribute("aria-invalid", "true");
      error.textContent = email.value ? "That doesn't look like an email." : "Email is required.";
      email.focus();
      return;
    }
    email.removeAttribute("aria-invalid");
    error.textContent = "";
    if (ok) ok.hidden = false;
  });
  email.addEventListener("input", () => {
    if (email.getAttribute("aria-invalid")) { email.removeAttribute("aria-invalid"); error.textContent = ""; }
  });
}

// ---- Native <dialog> ------------------------------------------------------
const dlg = document.getElementById("demo-dialog");
document.getElementById("open-dialog")?.addEventListener("click", () => dlg?.showModal());

// ---- Footer year ----------------------------------------------------------
const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = String(new Date().getFullYear());
