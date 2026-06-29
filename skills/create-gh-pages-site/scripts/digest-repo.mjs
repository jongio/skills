#!/usr/bin/env node
// digest-repo.mjs — read a repository and emit a structured "digest" the site
// author uses to build a site that's actually ABOUT the repo (not template
// defaults).
//
//   node scripts/digest-repo.mjs [--dir <path>] [--json]
//
// It collects deterministic signals — manifests, entry points, README headings
// and code fences, docs, existing images, badges, languages, sub-projects — and
// classifies the repo (cli | library | app | action | collection | docs | site)
// so the author knows WHICH kind of content to write: a CLI reference, an API /
// usage reference, a feature tour, a catalog of parts, etc.
//
// Pure helpers are exported for tests. No dependencies — runs on bare node 18+.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename, extname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Dirs we never descend into when scanning a target repo.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "_site", ".cache", ".astro", ".jekyll-cache",
  ".next", ".svelte-kit", "vendor", "target", "__pycache__", ".venv", "venv",
  "coverage", ".turbo", "out",
]);

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".ico"]);
const CODE_EXTS = {
  ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript",
  ".ts": "TypeScript", ".tsx": "TypeScript", ".py": "Python", ".rb": "Ruby",
  ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".cs": "C#",
  ".php": "PHP", ".swift": "Swift", ".c": "C", ".cpp": "C++", ".sh": "Shell",
  ".astro": "Astro", ".vue": "Vue", ".svelte": "Svelte",
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Parse JSON without throwing; returns null on any error. */
export function readJsonSafe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Pull the first H1 and the first non-empty, non-badge paragraph from Markdown. */
export function firstHeadingAndPara(md) {
  if (!md) return { title: null, description: null };
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let title = null;
  let description = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!title) {
      const h1 = line.match(/^#\s+(.*\S)\s*$/);
      if (h1) { title = h1[1].trim(); continue; }
    }
    if (title && !description) {
      if (!line) continue;
      if (line.startsWith("#")) continue;            // another heading
      if (/^[!\[]/.test(line)) continue;             // image/badge line
      if (/^<.*>$/.test(line)) continue;             // raw HTML line
      if (/^\[!\[/.test(line)) continue;             // linked badge
      description = line.replace(/\s+/g, " ").trim();
      break;
    }
  }
  return { title, description };
}

/** Extract fenced code blocks: returns [{ lang, code }]. */
export function extractFences(md) {
  if (!md) return [];
  const out = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md))) {
    out.push({ lang: (m[1] || "").trim().toLowerCase(), code: m[2].replace(/\s+$/, "") });
  }
  return out;
}

/** Find shields/badge image references in Markdown: [![alt](img)](link) or ![alt](img). */
export function extractBadges(md) {
  if (!md) return [];
  const out = [];
  const linked = /\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g;
  let m;
  while ((m = linked.exec(md))) out.push({ alt: m[1], image: m[2], link: m[3] });
  const bare = /(?<!\[)!\[([^\]]*)\]\(([^)]+)\)/g;
  while ((m = bare.exec(md))) {
    const image = m[2];
    if (/badge|shields\.io|img\.shields|\.svg($|\?)/i.test(image)) {
      if (!out.some((b) => b.image === image)) out.push({ alt: m[1], image, link: null });
    }
  }
  return out;
}

/** Classify an image by its filename into a role hint. */
export function detectImageRole(name) {
  const n = String(name).toLowerCase();
  if (/(^|[-_./])(logo|wordmark|brand)([-_.]|$)/.test(n)) return "logo";
  if (/(^|[-_./])(hero|banner|cover|header)([-_.]|$)/.test(n)) return "hero";
  if (/(^|[-_./])(og|social|opengraph|twitter|card)([-_.]|$)/.test(n)) return "og";
  if (/(^|[-_./])(icon|favicon|avatar)([-_.]|$)/.test(n)) return "icon";
  if (/(screenshot|screen|demo|preview|invoke|usage|example|gif)/.test(n)) return "screenshot";
  return "other";
}

/**
 * Score and rank repo types from collected signals.
 * @returns {{ primary: string, ranked: {type:string, score:number, reasons:string[]}[] }}
 */
export function classifyRepo(s = {}) {
  const score = {};
  const reasons = {};
  const add = (type, n, why) => {
    score[type] = (score[type] || 0) + n;
    (reasons[type] || (reasons[type] = [])).push(why);
  };

  if (s.hasBin) add("cli", 3, "package.json has a `bin` entry");
  if (s.hasPyScripts) add("cli", 3, "Python console_scripts / [project.scripts]");
  if (s.hasCargoBin) add("cli", 3, "Cargo [[bin]] target");
  if (s.hasGoMain) add("cli", 2, "Go `package main`");
  if (s.hasCommandsDir) add("cli", 1, "commands/ or cmd/ directory");
  if (s.readmeHasCliUsage) add("cli", 1, "README shows CLI usage (--help / Usage: / $ prompt)");

  if (s.hasLibEntry) add("library", 2, "package.json `main`/`exports` without a bin");
  if (s.hasCargoLib) add("library", 2, "Cargo [lib] target");
  if (s.hasPyPackages && !s.hasPyScripts) add("library", 2, "importable Python package, no console scripts");
  if (s.readmeHasImportExample) add("library", 1, "README shows import/require usage");

  if (s.hasFrameworkDep) add("app", 2, `web framework dependency (${s.frameworkName || "detected"})`);
  if (s.hasIndexHtml) add("app", 1, "index.html entry");
  if (s.hasSrcDir && s.hasFrameworkDep) add("app", 1, "src/ with a framework");

  if (s.hasActionYml) add("action", 4, "action.yml / action.yaml (GitHub Action)");

  if (s.hasPluginManifest && s.hasSkillsDir) add("collection", 3, "plugin.json/marketplace.json + skills/");
  if (s.hasWorkspaces) add("collection", 2, "package.json workspaces");
  if (s.hasPackagesDir) add("collection", 2, "packages/ or apps/ directory");
  if ((s.subProjectCount || 0) >= 2) add("collection", 1, `${s.subProjectCount} sub-projects`);

  if (s.docHeavy) add("docs", 2, "many Markdown docs, few source files");

  const ranked = Object.keys(score)
    .map((type) => ({ type, score: score[type], reasons: reasons[type] }))
    .sort((a, b) => b.score - a.score || a.type.localeCompare(b.type));

  const primary = ranked.length ? ranked[0].type : "site";
  return { primary, ranked };
}

/** Build a tally of source languages from a list of relative file paths. */
export function languageHistogram(files) {
  const tally = {};
  for (const f of files) {
    const lang = CODE_EXTS[extname(f).toLowerCase()];
    if (lang) tally[lang] = (tally[lang] || 0) + 1;
  }
  return Object.entries(tally)
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count || a.language.localeCompare(b.language));
}

/** Suggest install/usage commands from signals + slug. */
export function deriveInstall(s = {}, slug = null) {
  const cmds = [];
  const pkg = s.pkgName;
  if (s.hasBin && pkg) cmds.push(`npx ${s.binName || pkg}`, `npm install -g ${pkg}`);
  else if (s.hasLibEntry && pkg) cmds.push(`npm install ${pkg}`);
  if (s.hasPyScripts && s.pyName) cmds.push(`pipx install ${s.pyName}`);
  else if (s.hasPyPackages && s.pyName) cmds.push(`pip install ${s.pyName}`);
  if (s.hasCargoBin && s.crateName) cmds.push(`cargo install ${s.crateName}`);
  if (s.hasGoMain && s.goModule) cmds.push(`go install ${s.goModule}@latest`);
  if (s.hasActionYml && slug) cmds.push(`# .github/workflows/*.yml\n      - uses: ${slug}@v1`);
  if (s.hasPluginManifest && slug) cmds.push(`copilot plugin install ${slug}`);
  if (s.hasSkillMd && slug) cmds.push(`npx skills add ${slug} --all`);
  return [...new Set(cmds)];
}

// ---------------------------------------------------------------------------
// Filesystem scanning
// ---------------------------------------------------------------------------

function walk(dir, { maxEntries = 4000 } = {}) {
  const files = [];
  const stack = [dir];
  while (stack.length && files.length < maxEntries) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".github") {
        // skip dotfiles/dirs except .github
        if (e.isDirectory()) continue;
      }
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        files.push(relative(dir, full).split(sep).join("/"));
      }
    }
  }
  return files;
}

function read(dir, rel) {
  try { return readFileSync(join(dir, rel), "utf8"); } catch { return null; }
}

function hasDir(dir, name) {
  try { return statSync(join(dir, name)).isDirectory(); } catch { return false; }
}

function listDirs(dir, rel) {
  try {
    return readdirSync(join(dir, rel), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch { return []; }
}

/** Read a slug ("owner/repo") from package.json.repository or .git/config. */
function detectSlug(dir, pkg) {
  const fromUrl = (u) => {
    if (!u) return null;
    const m = String(u).match(/github\.com[/:]([^/]+)\/([^/.\s]+)/i);
    return m ? `${m[1]}/${m[2]}` : null;
  };
  if (pkg?.repository) {
    const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository.url;
    const slug = fromUrl(url);
    if (slug) return slug;
  }
  const cfg = read(dir, join(".git", "config"));
  if (cfg) {
    const m = cfg.match(/url\s*=\s*(\S+)/);
    if (m) { const slug = fromUrl(m[1]); if (slug) return slug; }
  }
  return null;
}

function collectSubProjects(dir) {
  const subs = [];
  for (const parent of ["skills", "packages", "apps", "plugins"]) {
    if (!hasDir(dir, parent)) continue;
    for (const name of listDirs(dir, parent)) {
      const childRel = `${parent}/${name}`;
      const pkg = readJsonSafe(read(dir, `${childRel}/package.json`) || "");
      const skill = read(dir, `${childRel}/SKILL.md`);
      const readme = read(dir, `${childRel}/README.md`);
      // Prefer the SKILL.md pitch (the human-facing description) over a
      // package.json that often describes internal dev tooling.
      let description = null;
      if (skill) {
        const fm = skill.match(/description:\s*>-?\s*\n([\s\S]*?)\n---/);
        if (fm) description = fm[1].replace(/\s+/g, " ").trim();
        else {
          const inline = skill.match(/^description:\s*(.+)$/m);
          if (inline) description = inline[1].replace(/^["']|["']$/g, "").trim();
        }
      }
      if (!description) description = pkg?.description || null;
      if (!description && readme) description = firstHeadingAndPara(readme).description;
      subs.push({ path: childRel, name, description, hasSkill: !!skill });
    }
  }
  return subs;
}

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

export function digestRepo(dir) {
  const root = resolve(dir);
  const files = walk(root);
  const has = (rel) => existsSync(join(root, rel));

  const pkg = readJsonSafe(read(root, "package.json") || "");
  const readme = read(root, "README.md") || read(root, "readme.md") || "";
  const pyproject = read(root, "pyproject.toml") || "";
  const cargo = read(root, "Cargo.toml") || "";
  const goMod = read(root, "go.mod") || "";

  // Go: look for `package main` in a few likely files.
  const goMainFiles = files.filter((f) => f.endsWith(".go")).slice(0, 40);
  const hasGoMain = goMainFiles.some((f) => /(^|\n)package\s+main\b/.test(read(root, f) || ""));

  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const FRAMEWORKS = ["next", "astro", "react", "vue", "svelte", "@sveltejs/kit", "vite", "nuxt", "solid-js"];
  const frameworkName = FRAMEWORKS.find((d) => d in deps) || null;

  const subProjects = collectSubProjects(root);
  const mdDocs = files.filter((f) => /\.mdx?$/i.test(f) && (f.startsWith("docs/") || f.startsWith("content/")));
  const sourceCount = files.filter((f) => CODE_EXTS[extname(f).toLowerCase()]).length;

  const signals = {
    pkgName: pkg?.name || null,
    binName: pkg?.bin ? (typeof pkg.bin === "string" ? pkg.name : Object.keys(pkg.bin)[0]) : null,
    hasBin: !!pkg?.bin,
    hasLibEntry: !!(pkg && (pkg.main || pkg.exports) && !pkg.bin),
    hasFrameworkDep: !!frameworkName,
    frameworkName,
    hasIndexHtml: has("index.html") || has("public/index.html") || has("src/index.html"),
    hasSrcDir: hasDir(root, "src"),
    hasWorkspaces: !!pkg?.workspaces,
    hasActionYml: has("action.yml") || has("action.yaml"),
    hasPluginManifest: has("plugin.json") || has("marketplace.json"),
    hasSkillsDir: hasDir(root, "skills"),
    hasSkillMd: has("SKILL.md") || subProjects.some((s) => s.hasSkill),
    hasPackagesDir: hasDir(root, "packages") || hasDir(root, "apps"),
    hasCommandsDir: hasDir(root, "commands") || hasDir(root, "cmd"),
    subProjectCount: subProjects.length,
    docHeavy: mdDocs.length >= 4 && mdDocs.length > sourceCount,
    // Python
    pyName: (pyproject.match(/^\s*name\s*=\s*["']([^"']+)["']/m) || [])[1] || null,
    hasPyScripts: /\[project\.scripts\]/.test(pyproject) || /console_scripts/.test(read(root, "setup.cfg") || "") || /console_scripts/.test(read(root, "setup.py") || ""),
    hasPyPackages: !!pyproject || has("setup.py") || has("setup.cfg"),
    // Rust
    crateName: (cargo.match(/^\s*name\s*=\s*["']([^"']+)["']/m) || [])[1] || null,
    hasCargoBin: /\[\[bin\]\]/.test(cargo) || (!!cargo && has("src/main.rs")),
    hasCargoLib: /\[lib\]/.test(cargo) || (!!cargo && has("src/lib.rs")),
    // Go
    goModule: (goMod.match(/^module\s+(\S+)/m) || [])[1] || null,
    hasGoMain,
    // README heuristics
    readmeHasCliUsage: /(^|\n)\s*(usage:|\$\s|\w+\s+--help)/i.test(readme) || /```[a-z]*\n[^`]*--help/i.test(readme),
    readmeHasImportExample: /\b(import\s+.+\s+from|require\(|using\s+\w+;|^\s*from\s+\w+\s+import)/m.test(readme),
  };

  const { primary, ranked } = classifyRepo(signals);
  const slug = detectSlug(root, pkg);
  const head = firstHeadingAndPara(readme);

  const images = files
    .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
    .map((path) => ({ path, role: detectImageRole(path) }));

  const fences = extractFences(readme)
    .filter((f) => ["sh", "bash", "shell", "console", "zsh", "powershell", "ps1", "js", "javascript", "ts", "typescript", "json", "yaml", "yml", ""].includes(f.lang))
    .slice(0, 8);

  return {
    dir: root,
    name: pkg?.name || head.title || basename(root),
    title: head.title || pkg?.name || basename(root),
    description: pkg?.description || head.description || null,
    repoSlug: slug,
    license: pkg?.license || (read(root, "LICENSE") ? (read(root, "LICENSE").match(/(MIT|Apache|BSD|GPL|MPL|ISC)[^\n]*/i) || [])[0] : null) || null,
    type: { primary, ranked },
    install: deriveInstall(signals, slug),
    usageExamples: fences,
    badges: extractBadges(readme),
    docFiles: files.filter((f) => /\.mdx?$/i.test(f)).slice(0, 40),
    images,
    languages: languageHistogram(files),
    subProjects,
    signals,
    fileCount: files.length,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--json") a.json = true;
    else if (x === "--help" || x === "-h") a.help = true;
    else if (x.startsWith("--")) a[x.slice(2)] = argv[++i];
    else a._.push(x);
  }
  return a;
}

function printSummary(d) {
  const L = [];
  L.push(`\nRepo digest — ${d.title}`);
  L.push(`  dir:         ${d.dir}`);
  if (d.repoSlug) L.push(`  repo:        ${d.repoSlug}`);
  if (d.description) L.push(`  description: ${d.description}`);
  L.push(`  type:        ${d.type.primary}  (${d.type.ranked.map((r) => `${r.type}:${r.score}`).join(", ") || "n/a"})`);
  if (d.license) L.push(`  license:     ${d.license}`);
  if (d.languages.length) L.push(`  languages:   ${d.languages.slice(0, 5).map((l) => `${l.language}(${l.count})`).join(", ")}`);
  if (d.install.length) { L.push(`  install:`); for (const c of d.install) L.push(`    ${c.replace(/\n/g, "\n    ")}`); }
  if (d.subProjects.length) {
    L.push(`  sub-projects (${d.subProjects.length}):`);
    for (const s of d.subProjects) L.push(`    - ${s.name}: ${s.description ? s.description.slice(0, 90) : "(no description)"}`);
  }
  if (d.images.length) L.push(`  images:      ${d.images.length} (${[...new Set(d.images.map((i) => i.role))].join(", ")})`);
  if (d.badges.length) L.push(`  badges:      ${d.badges.length}`);
  L.push(`  usage code fences: ${d.usageExamples.length}`);
  L.push(`  reasons: ${d.type.ranked.map((r) => `[${r.type}] ${r.reasons.join("; ")}`).join("  |  ") || "none"}`);
  L.push("");
  return L.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`digest-repo — analyze a repo so the site author can tailor content.\n\nUsage:\n  node scripts/digest-repo.mjs [--dir <path>] [--json]\n`);
    return;
  }
  const d = digestRepo(args.dir || process.cwd());
  if (args.json) console.log(JSON.stringify(d, null, 2));
  else console.log(printSummary(d));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
