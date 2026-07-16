#!/usr/bin/env node
/**
 * generate-html-report.mjs (v3 - "Actually Useful" Data Studio)
 *
 * Focus: Help the user CHOOSE a model, not just compare specs.
 * Unique charts: Heatmap, Parallel Coordinates, Efficiency Frontier,
 * Model DNA Fingerprints, Gap Analysis, Workload Simulator.
 */

import { MODEL_REGISTRY, PROVIDERS, groupByProvider, rankBy, recommendFor, TASK_PROFILES } from './registry.mjs';
import { VERIFIED_BENCHMARKS, INDEPENDENT_SOURCES, PROVIDER_DOCS, getBenchmarks } from './sources.mjs';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const openBrowser = args.includes('--open');
const outputIdx = args.indexOf('--output');
const outputPath = outputIdx >= 0 && args[outputIdx + 1] ? args[outputIdx + 1] : './model-intel-report.html';

// Helpers
const DIMS = ['codeGeneration','codeReview','reasoning','contextLength','instructionFollowing','speed','costEfficiency','multiFile','creativeWriting','toolUse'];
const DIM_LABELS = { codeGeneration:'Code Gen', codeReview:'Code Review', reasoning:'Reasoning', contextLength:'Context', instructionFollowing:'Instructions', speed:'Speed', costEfficiency:'Cost Eff.', multiFile:'Multi-file', creativeWriting:'Writing', toolUse:'Tool Use' };
const PROV_COLORS = { anthropic:'#a78bfa', openai:'#34d399', google:'#60a5fa', microsoft:'#fb923c' };

function avgScore(m) { return Math.round(DIMS.reduce((s,d) => s + m.scores[d], 0) / DIMS.length); }

function generateHTML() {
  const now = new Date().toISOString().slice(0,16).replace('T',' ');
  const groups = groupByProvider();

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Model Intel | Which model should you use?</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<script src="https://unpkg.com/lucide@latest"></script>
<style>
:root {
  --font: 'Inter', -apple-system, sans-serif;
  --mono: 'JetBrains Mono', monospace;
  --radius: 10px;
  --radius-lg: 14px;
  --transition: 0.2s cubic-bezier(0.4,0,0.2,1);
  --gradient: linear-gradient(135deg, #3b82f6, #8b5cf6);
  --gradient-text: linear-gradient(135deg, #60a5fa, #a78bfa);
}
[data-theme="dark"] {
  --bg: #08080d;
  --bg-raised: #0f0f16;
  --bg-card: #13131c;
  --bg-hover: #1a1a26;
  --bg-input: #1a1a26;
  --border: #2a2a3d;
  --border-subtle: #1e1e2e;
  --text: #eeeef5;
  --text-2: #b0b0c5;
  --text-3: #6a6a82;
  --glow: rgba(99,102,241,0.08);
}
[data-theme="light"] {
  --bg: #f8f9fc;
  --bg-raised: #ffffff;
  --bg-card: #ffffff;
  --bg-hover: #f0f1f5;
  --bg-input: #f0f1f5;
  --border: #e2e4ea;
  --border-subtle: #ecedf2;
  --text: #1a1a2e;
  --text-2: #555570;
  --text-3: #999;
  --glow: rgba(99,102,241,0.04);
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:var(--font); background:var(--bg); color:var(--text); line-height:1.6; transition:background var(--transition),color var(--transition); }

/* === TOPBAR === */
.topbar { position:sticky; top:0; z-index:100; background:var(--bg-raised); border-bottom:1px solid var(--border-subtle); padding:0.6rem 1.5rem; display:flex; align-items:center; gap:1rem; backdrop-filter:blur(16px); }
.topbar-brand { display:flex; align-items:center; gap:0.5rem; font-weight:800; font-size:0.85rem; }
.brand-icon { width:26px; height:26px; background:var(--gradient); border-radius:7px; display:flex; align-items:center; justify-content:center; }
.brand-icon i { color:white; width:14px; height:14px; }
.topbar-nav { display:flex; gap:0.2rem; margin-left:1.5rem; overflow-x:auto; scrollbar-width:none; }
.topbar-nav::-webkit-scrollbar { display:none; }
.nav-btn { padding:0.45rem 0.75rem; border:none; background:transparent; color:var(--text-3); font-size:0.73rem; font-family:var(--font); font-weight:500; border-radius:6px; cursor:pointer; white-space:nowrap; transition:all var(--transition); }
.nav-btn:hover { color:var(--text-2); background:var(--bg-hover); }
.nav-btn.active { color:var(--text); background:var(--bg-input); border:1px solid var(--border-subtle); }
.theme-btn { margin-left:auto; width:32px; height:32px; border:1px solid var(--border); border-radius:8px; background:var(--bg-card); display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--text-3); }
.theme-btn:hover { color:var(--text); }

/* === LAYOUT === */
.main { max-width:1500px; margin:0 auto; padding:1.5rem; }
.panel { display:none; animation:slideIn 0.25s ease; }
.panel.active { display:block; }
@keyframes slideIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }

/* === PICKER (the hero feature) === */
.picker-section { background: var(--bg-raised); border:1px solid var(--border-subtle); border-radius:var(--radius-lg); padding:2.5rem; margin-bottom:2rem; position:relative; overflow:hidden; }
.picker-section::before { content:''; position:absolute; top:-50%; right:-20%; width:400px; height:400px; background:radial-gradient(circle, rgba(99,102,241,0.06) 0%, transparent 70%); pointer-events:none; }
.picker-title { font-size:1.8rem; font-weight:900; letter-spacing:-0.04em; margin-bottom:0.3rem; }
.picker-subtitle { color:var(--text-2); font-size:0.95rem; margin-bottom:2rem; }
.picker-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:1.5rem; margin-bottom:2rem; }
.picker-q { }
.picker-q label { display:block; font-size:0.72rem; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-3); margin-bottom:0.5rem; }
.picker-opts { display:flex; flex-direction:column; gap:0.4rem; }
.picker-opt { padding:0.6rem 0.9rem; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-card); font-size:0.82rem; cursor:pointer; transition:all var(--transition); display:flex; align-items:center; gap:0.5rem; }
.picker-opt:hover { border-color:var(--border); background:var(--bg-hover); }
.picker-opt.selected { border-color:#6366f1; background:rgba(99,102,241,0.08); color:var(--text); }
.picker-opt i { width:14px; height:14px; color:var(--text-3); }
.picker-result { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-lg); padding:1.5rem 2rem; display:none; }
.picker-result.visible { display:flex; align-items:center; gap:1.5rem; }
.result-model { font-size:1.4rem; font-weight:800; background:var(--gradient-text); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
.result-reason { font-size:0.85rem; color:var(--text-2); flex:1; }
.result-badge { padding:0.4rem 0.8rem; border-radius:9999px; font-size:0.72rem; font-weight:600; }
.result-badge.standard { background:rgba(16,185,129,0.1); color:#34d399; }
.result-badge.premium { background:rgba(139,92,246,0.1); color:#a78bfa; }

/* === SECTION HEADERS === */
.sec-head { display:flex; align-items:center; gap:0.7rem; margin:2rem 0 1.25rem; }
.sec-head .ico { width:32px; height:32px; background:var(--glow); border:1px solid var(--border-subtle); border-radius:8px; display:flex; align-items:center; justify-content:center; }
.sec-head .ico i { width:16px; height:16px; color:#6366f1; }
.sec-head h2 { font-size:1.15rem; font-weight:700; letter-spacing:-0.02em; }
.sec-head .muted { margin-left:auto; font-size:0.75rem; color:var(--text-3); }

/* === HEATMAP === */
.heatmap-wrap { overflow-x:auto; border:1px solid var(--border-subtle); border-radius:var(--radius-lg); background:var(--bg-card); }
.data-table { width:100%; border-collapse:collapse; }
.data-table th { padding:0.6rem 0.75rem; background:var(--bg-raised); color:var(--text-3); font-weight:600; text-transform:uppercase; letter-spacing:0.04em; font-size:0.65rem; text-align:left; border-bottom:1px solid var(--border-subtle); position:sticky; top:0; }
.data-table td { padding:0.55rem 0.75rem; border-bottom:1px solid var(--border-subtle); color:var(--text-1); }
.data-table tbody tr:hover td { background:var(--bg-hover) !important; }
.heatmap { width:100%; border-collapse:collapse; font-size:0.72rem; }
.heatmap th { padding:0.6rem 0.5rem; background:var(--bg-raised); color:var(--text-3); font-weight:600; text-transform:uppercase; letter-spacing:0.04em; font-size:0.62rem; text-align:center; border-bottom:1px solid var(--border-subtle); position:sticky; top:0; }
.heatmap th:first-child { text-align:left; padding-left:1rem; min-width:140px; }
.heatmap td { padding:0.5rem; text-align:center; font-family:var(--mono); font-weight:600; font-size:0.72rem; border-bottom:1px solid var(--border-subtle); position:relative; }
.heatmap td:first-child { text-align:left; padding-left:1rem; font-family:var(--font); font-weight:500; }
.heatmap tr:hover td { background:var(--bg-hover) !important; }
.heat-cell { width:100%; height:100%; display:flex; align-items:center; justify-content:center; border-radius:4px; padding:0.3rem; }

/* === PARALLEL COORDINATES === */
.parallel-wrap { background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:var(--radius-lg); padding:1.5rem; }
.parallel-wrap svg { width:100%; height:auto; }
.parallel-legend { display:flex; flex-wrap:wrap; gap:0.75rem; margin-top:1rem; justify-content:center; }
.parallel-legend-item { display:flex; align-items:center; gap:0.35rem; font-size:0.72rem; color:var(--text-2); cursor:pointer; padding:0.2rem 0.5rem; border-radius:4px; transition:background var(--transition); }
.parallel-legend-item:hover { background:var(--bg-hover); }

/* === GAP ANALYSIS === */
.gap-card { background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:var(--radius-lg); padding:1.5rem; margin-bottom:1rem; }
.gap-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; }
.gap-title { font-weight:700; font-size:0.95rem; }
.gap-score { font-family:var(--mono); font-weight:700; font-size:1.2rem; }
.gap-bars { display:grid; grid-template-columns:1fr 1fr; gap:0.4rem 1.5rem; }
.gap-bar-row { display:flex; align-items:center; gap:0.5rem; }
.gap-bar-label { font-size:0.7rem; color:var(--text-3); min-width:80px; }
.gap-bar-track { flex:1; height:6px; background:var(--bg-raised); border-radius:3px; overflow:hidden; position:relative; }
.gap-bar-base { position:absolute; height:100%; border-radius:3px; opacity:0.3; }
.gap-bar-model { position:absolute; height:100%; border-radius:3px; }
.gap-bar-val { font-family:var(--mono); font-size:0.65rem; min-width:1.5rem; text-align:right; }

/* === SIMULATOR === */
.sim-section { background:var(--bg-raised); border:1px solid var(--border-subtle); border-radius:var(--radius-lg); padding:2rem; }
.sim-controls { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:1.25rem; margin-bottom:1.5rem; }
.sim-control label { display:block; font-size:0.7rem; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-3); margin-bottom:0.4rem; }
.sim-control input[type=range] { width:100%; accent-color:#6366f1; }
.sim-control .val { font-family:var(--mono); font-size:0.85rem; font-weight:600; color:var(--text); }
.sim-results { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:1rem; }
.sim-result-card { background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:var(--radius); padding:1rem; text-align:center; }
.sim-result-card .model-name { font-size:0.78rem; font-weight:600; margin-bottom:0.3rem; }
.sim-result-card .cost-val { font-size:1.3rem; font-weight:800; font-family:var(--mono); }
.sim-result-card .cost-label { font-size:0.65rem; color:var(--text-3); margin-top:0.2rem; }
.sim-result-card.best { border-color:#6366f1; background:rgba(99,102,241,0.05); }

/* === UPGRADE PATH === */
.upgrade-track { position:relative; padding:1rem 0; }
.upgrade-step { display:flex; align-items:stretch; gap:1rem; margin-bottom:0.75rem; }
.upgrade-line { width:3px; background:var(--border); border-radius:2px; position:relative; flex-shrink:0; margin-left:1rem; }
.upgrade-line::before { content:''; position:absolute; top:0; left:-4px; width:11px; height:11px; border-radius:50%; background:var(--gradient); }
.upgrade-content { flex:1; background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:var(--radius); padding:1rem 1.25rem; }
.upgrade-trigger { font-size:0.75rem; color:var(--text-3); margin-bottom:0.3rem; }
.upgrade-model { font-weight:700; font-size:0.9rem; }
.upgrade-why { font-size:0.78rem; color:var(--text-2); margin-top:0.3rem; }

/* === DNA FINGERPRINTS === */
.dna-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:0.75rem; }
.dna-card { background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:var(--radius); padding:1rem; text-align:center; transition:all var(--transition); }
.dna-card:hover { border-color:var(--border); transform:translateY(-2px); }
.dna-card svg { margin:0.5rem auto; display:block; }
.dna-name { font-size:0.72rem; font-weight:600; margin-top:0.4rem; }
.dna-score { font-family:var(--mono); font-size:0.65rem; color:var(--text-3); }

/* === COMMON === */
.grid-2 { display:grid; grid-template-columns:repeat(auto-fit, minmax(400px, 1fr)); gap:1.25rem; }
.grid-3 { display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:1rem; }
.badge { display:inline-flex; padding:0.2rem 0.55rem; border-radius:9999px; font-size:0.65rem; font-weight:600; }
.badge-s { background:rgba(16,185,129,0.1); color:#34d399; }
.badge-p { background:rgba(139,92,246,0.1); color:#a78bfa; }

/* === SOURCES === */
.source-link { color:var(--accent-1); text-decoration:none; font-size:0.75rem; }
.source-link:hover { text-decoration:underline; }
.source-cards-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:1rem; }
.source-card { background:var(--card-bg); border:1px solid var(--border-subtle); border-radius:0.75rem; padding:1.25rem; transition:border-color 0.2s; }
.source-card:hover { border-color:var(--accent-1); }
.source-card-title { font-weight:600; margin-bottom:0.35rem; }
.source-card-title a { color:var(--text-1); text-decoration:none; }
.source-card-title a:hover { color:var(--accent-1); }
.source-card-desc { font-size:0.78rem; color:var(--text-2); margin-bottom:0.4rem; }
.source-card-meta { font-size:0.68rem; color:var(--text-3); font-family:var(--mono); }
.methodology-box { background:var(--card-bg); border:1px solid var(--border-subtle); border-radius:0.75rem; padding:1.5rem; margin-bottom:2rem; }
.methodology-box h3 { margin:0 0 0.75rem; font-size:0.9rem; }
.methodology-box ul { list-style:none; padding:0; margin:0; }
.methodology-box li { padding:0.4rem 0; font-size:0.8rem; color:var(--text-2); border-bottom:1px solid var(--border-subtle); }
.methodology-box li:last-child { border-bottom:none; }
.methodology-box li strong { color:var(--text-1); }
.sources-section-title { font-size:1rem; font-weight:700; color:var(--text-1); margin-bottom:0.5rem; }
.prov-docs-wrap { display:flex; flex-direction:column; gap:0.5rem; }
.prov-doc-row { display:flex; align-items:center; gap:0.75rem; padding:0.5rem 0; border-bottom:1px solid var(--border-subtle); }
.prov-doc-name { font-weight:700; min-width:100px; }
.prov-doc-link { display:inline-flex; align-items:center; gap:0.25rem; padding:0.25rem 0.6rem; background:var(--card-bg); border:1px solid var(--border-subtle); border-radius:6px; font-size:0.72rem; color:var(--text-2); text-decoration:none; transition:border-color 0.2s,color 0.2s; }
.prov-doc-link:hover { border-color:var(--accent-1); color:var(--accent-1); }
.section-subtitle { font-size:0.82rem; color:var(--text-2); margin-bottom:1.5rem; }

/* === GLOBAL FILTER BAR === */
.filter-bar { background:var(--bg-raised); border-bottom:1px solid var(--border-subtle); padding:0.6rem 2rem; display:flex; align-items:center; gap:1rem; flex-wrap:wrap; position:sticky; top:48px; z-index:90; }
.filter-group { display:flex; align-items:center; gap:0.4rem; }
.filter-label { font-size:0.65rem; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-3); white-space:nowrap; }
.filter-pill { padding:0.25rem 0.6rem; border:1px solid var(--border-subtle); border-radius:9999px; font-size:0.7rem; cursor:pointer; transition:all 0.15s; background:transparent; color:var(--text-2); }
.filter-pill:hover { border-color:var(--border); background:var(--bg-hover); }
.filter-pill.active { border-color:#6366f1; background:rgba(99,102,241,0.12); color:#818cf8; font-weight:600; }
.filter-pill[data-provider="anthropic"].active { border-color:#a78bfa; background:rgba(167,139,250,0.12); color:#a78bfa; }
.filter-pill[data-provider="openai"].active { border-color:#34d399; background:rgba(52,211,153,0.12); color:#34d399; }
.filter-pill[data-provider="google"].active { border-color:#60a5fa; background:rgba(96,165,250,0.12); color:#60a5fa; }
.filter-pill[data-provider="microsoft"].active { border-color:#fb923c; background:rgba(251,146,60,0.12); color:#fb923c; }
.filter-search { padding:0.3rem 0.7rem; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-card); color:var(--text-1); font-size:0.75rem; width:180px; outline:none; transition:border-color 0.15s; }
.filter-search:focus { border-color:#6366f1; }
.filter-search::placeholder { color:var(--text-3); }
.filter-divider { width:1px; height:20px; background:var(--border-subtle); }
.filter-slider-group { display:flex; align-items:center; gap:0.4rem; }
.filter-slider { width:80px; accent-color:#6366f1; cursor:pointer; }
.filter-slider-val { font-family:var(--mono); font-size:0.68rem; color:var(--text-2); min-width:18px; }
.filter-count { font-size:0.65rem; color:var(--text-3); margin-left:auto; font-family:var(--mono); }

/* === SORTABLE TABLE HEADERS === */
.sortable-th { cursor:pointer; user-select:none; position:relative; padding-right:18px !important; }
.sortable-th:hover { color:var(--text-1); background:var(--bg-hover); }
.sortable-th::after { content:''; position:absolute; right:4px; top:50%; transform:translateY(-50%); border:4px solid transparent; border-top-color:var(--text-3); opacity:0.3; }
.sortable-th.sort-asc::after { border-top-color:transparent; border-bottom-color:#6366f1; opacity:1; transform:translateY(-70%); }
.sortable-th.sort-desc::after { border-top-color:#6366f1; opacity:1; transform:translateY(-30%); }
.table-search-wrap { display:flex; align-items:center; gap:0.5rem; margin-bottom:0.75rem; }
.table-search { padding:0.35rem 0.8rem; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-card); color:var(--text-1); font-size:0.78rem; flex:1; max-width:300px; outline:none; }
.table-search:focus { border-color:#6366f1; }
.table-search::placeholder { color:var(--text-3); }
.table-match-count { font-size:0.68rem; color:var(--text-3); font-family:var(--mono); }
tr.filtered-out { display:none !important; }

/* === RESPONSIVE === */
@media(max-width:900px) {
  .picker-grid { grid-template-columns:1fr; }
  .main { padding:1rem; }
  .grid-2 { grid-template-columns:1fr; }
  .source-cards-grid { grid-template-columns:1fr; }
  .filter-bar { padding:0.5rem 1rem; gap:0.5rem; }
  .filter-search { width:120px; }
}
</style>
</head>
<body>
<!-- TOPBAR -->
<header class="topbar">
  <div class="topbar-brand"><div class="brand-icon"><i data-lucide="brain"></i></div>Model Intel</div>
  <nav class="topbar-nav">
    <button class="nav-btn active" data-tab="pick">Pick a Model</button>
    <button class="nav-btn" data-tab="heatmap">Heatmap</button>
    <button class="nav-btn" data-tab="parallel">Parallel</button>
    <button class="nav-btn" data-tab="gap">Gap Analysis</button>
    <button class="nav-btn" data-tab="frontier">Frontier</button>
    <button class="nav-btn" data-tab="sim">Simulator</button>
    <button class="nav-btn" data-tab="upgrade">Upgrade Path</button>
    <button class="nav-btn" data-tab="dna">DNA</button>
    <button class="nav-btn" data-tab="census">All Models</button>
    <button class="nav-btn" data-tab="sources">Sources</button>
  </nav>
  <button class="theme-btn" onclick="toggleTheme()"><i data-lucide="sun" style="width:15px;height:15px"></i></button>
</header>

<main class="main">

<!-- GLOBAL FILTER BAR -->
<div class="filter-bar" id="global-filters">
  <div class="filter-group">
    <span class="filter-label">Provider</span>
    <button class="filter-pill active" data-provider="anthropic" onclick="toggleProvider(this)">Anthropic</button>
    <button class="filter-pill active" data-provider="openai" onclick="toggleProvider(this)">OpenAI</button>
    <button class="filter-pill active" data-provider="google" onclick="toggleProvider(this)">Google</button>
    <button class="filter-pill active" data-provider="microsoft" onclick="toggleProvider(this)">Microsoft</button>
  </div>
  <div class="filter-divider"></div>
  <div class="filter-group">
    <span class="filter-label">Tier</span>
    <button class="filter-pill active" data-tier="standard" onclick="toggleTier(this)">Standard</button>
    <button class="filter-pill active" data-tier="premium" onclick="toggleTier(this)">Premium</button>
  </div>
  <div class="filter-divider"></div>
  <div class="filter-group">
    <span class="filter-label">1M Context</span>
    <button class="filter-pill" data-ctx="1m" onclick="toggle1MCtx(this)">Only 1M</button>
  </div>
  <div class="filter-divider"></div>
  <div class="filter-slider-group">
    <span class="filter-label">Min Score</span>
    <input type="range" class="filter-slider" id="global-min-score" min="0" max="95" value="0" step="5" oninput="updateMinScore(this)">
    <span class="filter-slider-val" id="global-min-score-val">0</span>
  </div>
  <div class="filter-divider"></div>
  <div class="filter-group">
    <input type="text" class="filter-search" id="global-search" placeholder="Search models..." oninput="updateGlobalSearch(this)">
  </div>
  <span class="filter-count" id="filter-count">${MODEL_REGISTRY.length} models</span>
</div>

<!-- ═══════════════════════════════════════════════════════════════════════════
     TAB: PICK A MODEL (the main event)
     ═══════════════════════════════════════════════════════════════════════════ -->
<div class="panel active" id="panel-pick">
  <div class="picker-section">
    <div class="picker-title">What model should you use?</div>
    <div class="picker-subtitle">Answer 3 questions. Get your answer.</div>

    <div class="picker-grid">
      <div class="picker-q">
        <label>What are you doing?</label>
        <div class="picker-opts" id="q-task">
          <div class="picker-opt" data-val="quick"><i data-lucide="zap"></i>Quick edits / completions</div>
          <div class="picker-opt" data-val="code"><i data-lucide="code"></i>Writing / refactoring code</div>
          <div class="picker-opt" data-val="review"><i data-lucide="search"></i>Code review / debugging</div>
          <div class="picker-opt" data-val="arch"><i data-lucide="boxes"></i>Architecture / design</div>
          <div class="picker-opt" data-val="test"><i data-lucide="test-tubes"></i>Test generation</div>
          <div class="picker-opt" data-val="docs"><i data-lucide="book-open"></i>Documentation / writing</div>
          <div class="picker-opt" data-val="security"><i data-lucide="shield"></i>Security audit</div>
          <div class="picker-opt" data-val="bulk"><i data-lucide="layers"></i>Bulk / batch processing</div>
        </div>
      </div>
      <div class="picker-q">
        <label>How complex is it?</label>
        <div class="picker-opts" id="q-complexity">
          <div class="picker-opt" data-val="simple"><i data-lucide="minus"></i>Simple (1-2 files)</div>
          <div class="picker-opt" data-val="medium"><i data-lucide="equal"></i>Medium (3-10 files)</div>
          <div class="picker-opt" data-val="complex"><i data-lucide="git-merge"></i>Complex (10+ files, deep reasoning)</div>
        </div>
      </div>
      <div class="picker-q">
        <label>Budget preference?</label>
        <div class="picker-opts" id="q-budget">
          <div class="picker-opt" data-val="free"><i data-lucide="piggy-bank"></i>Standard only (included)</div>
          <div class="picker-opt" data-val="balanced"><i data-lucide="scale"></i>Balanced (some premium OK)</div>
          <div class="picker-opt" data-val="best"><i data-lucide="crown"></i>Best quality (cost no object)</div>
        </div>
      </div>
    </div>

    <div class="picker-result" id="picker-result">
      <div>
        <div style="font-size:0.7rem;color:var(--text-3);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:0.2rem">Recommended</div>
        <div class="result-model" id="result-model"></div>
      </div>
      <div class="result-reason" id="result-reason"></div>
      <div>
        <span class="result-badge" id="result-badge"></span>
      </div>
    </div>
  </div>

  <!-- Quick decision matrix below picker -->
  <div class="sec-head"><div class="ico"><i data-lucide="grid-3x3"></i></div><h2>Quick Decision Matrix</h2><span class="muted">For every scenario</span></div>
  ${generateQuickMatrix()}
</div>

<!-- ═══════════════════════════════════════════════════════════════════════════
     TAB: HEATMAP
     ═══════════════════════════════════════════════════════════════════════════ -->
<div class="panel" id="panel-heatmap">
  <div class="sec-head"><div class="ico"><i data-lucide="grid-3x3"></i></div><h2>Capability Heatmap</h2><span class="muted">All models, all dimensions, one view</span></div>
  ${generateHeatmap()}
  <div style="margin-top:2rem">
    <h3 style="font-size:0.9rem;font-weight:700;margin-bottom:0.75rem"><i data-lucide="microscope" style="width:15px;height:15px;vertical-align:middle"></i> Raw Benchmark Data (verified)</h3>
    <p style="font-size:0.75rem;color:var(--text-3);margin-bottom:0.75rem">The composite scores above are derived from these real benchmarks. Each links to its source.</p>
    ${generateInlineBenchmarks()}
  </div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════════════
     TAB: PARALLEL COORDINATES
     ═══════════════════════════════════════════════════════════════════════════ -->
<div class="panel" id="panel-parallel">
  <div class="sec-head"><div class="ico"><i data-lucide="activity"></i></div><h2>Parallel Coordinates</h2><span class="muted">Each line is a model. See the tradeoffs.</span></div>
  ${generateParallelCoords()}
</div>

<!-- ═══════════════════════════════════════════════════════════════════════════
     TAB: GAP ANALYSIS
     ═══════════════════════════════════════════════════════════════════════════ -->
<div class="panel" id="panel-gap">
  <div class="sec-head"><div class="ico"><i data-lucide="diff"></i></div><h2>Gap Analysis</h2><span class="muted">What you lose by picking a cheaper model vs the best</span></div>
  ${generateGapAnalysis()}
</div>

<!-- ═══════════════════════════════════════════════════════════════════════════
     TAB: FRONTIER
     ═══════════════════════════════════════════════════════════════════════════ -->
<div class="panel" id="panel-frontier">
  <div class="sec-head"><div class="ico"><i data-lucide="trending-up"></i></div><h2>Efficiency Frontier</h2><span class="muted">Pareto-optimal models (you should be on the curve)</span></div>
  ${generateFrontierChart()}
</div>

<!-- ═══════════════════════════════════════════════════════════════════════════
     TAB: SIMULATOR
     ═══════════════════════════════════════════════════════════════════════════ -->
<div class="panel" id="panel-sim">
  <div class="sec-head"><div class="ico"><i data-lucide="calculator"></i></div><h2>Workload Simulator</h2><span class="muted">Estimate your premium usage</span></div>
  ${generateSimulator()}
</div>

<!-- ═══════════════════════════════════════════════════════════════════════════
     TAB: UPGRADE PATH
     ═══════════════════════════════════════════════════════════════════════════ -->
<div class="panel" id="panel-upgrade">
  <div class="sec-head"><div class="ico"><i data-lucide="arrow-up-circle"></i></div><h2>When to Upgrade</h2><span class="muted">Signals that you should move to a stronger model</span></div>
  ${generateUpgradePath()}
</div>

<!-- ═══════════════════════════════════════════════════════════════════════════
     TAB: DNA FINGERPRINTS
     ═══════════════════════════════════════════════════════════════════════════ -->
<div class="panel" id="panel-dna">
  <div class="sec-head"><div class="ico"><i data-lucide="fingerprint"></i></div><h2>Model DNA</h2><span class="muted">Unique capability signature per model</span></div>
  ${generateDNA()}
</div>

<!-- ═══════════════════════════════════════════════════════════════════════════
     TAB: CENSUS
     ═══════════════════════════════════════════════════════════════════════════ -->
<div class="panel" id="panel-census">
  <div class="sec-head"><div class="ico"><i data-lucide="list"></i></div><h2>Full Model Census</h2></div>
  ${generateCensus(groups)}
</div>

<div class="panel" id="panel-sources">
  <div class="sec-head"><div class="ico"><i data-lucide="book-open"></i></div><h2>Sources &amp; Methodology</h2></div>
  <p class="section-subtitle">Every data point in this report is traceable. Click any source to verify independently.</p>
  ${generateSourcesPanel()}
</div>

</main>

<footer style="text-align:center;padding:1.5rem;color:var(--text-3);font-size:0.7rem;border-top:1px solid var(--border-subtle)">model-intel v1.0.0 | Generated ${now}</footer>

<script>
// === Tab switching ===
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
  });
});

// === Theme ===
function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  lucide.createIcons();
}

// === Model Picker Logic ===
const MODELS = ${JSON.stringify(MODEL_REGISTRY.map(m => ({ id:m.id, name:m.name, provider:m.provider, tier:m.tier, scores:m.scores })))};

const TASK_WEIGHTS = {
  quick:    {speed:0.4, costEfficiency:0.3, codeGeneration:0.3},
  code:     {codeGeneration:0.35, multiFile:0.25, reasoning:0.2, toolUse:0.2},
  review:   {codeReview:0.35, reasoning:0.3, multiFile:0.2, toolUse:0.15},
  arch:     {reasoning:0.35, codeReview:0.25, multiFile:0.25, creativeWriting:0.15},
  test:     {codeGeneration:0.35, reasoning:0.25, instructionFollowing:0.25, speed:0.15},
  docs:     {creativeWriting:0.35, instructionFollowing:0.3, reasoning:0.2, speed:0.15},
  security: {reasoning:0.35, codeReview:0.3, multiFile:0.2, toolUse:0.15},
  bulk:     {speed:0.35, costEfficiency:0.35, codeGeneration:0.15, multiFile:0.15}
};

const COMPLEXITY_MODS = {
  simple:  {speed:0.2, costEfficiency:0.1},
  medium:  {multiFile:0.1, reasoning:0.05},
  complex: {reasoning:0.2, multiFile:0.15, contextLength:0.1}
};

let pickerState = { task:null, complexity:null, budget:null };

document.querySelectorAll('.picker-opts').forEach(group => {
  group.querySelectorAll('.picker-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      group.querySelectorAll('.picker-opt').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      const qId = group.id.replace('q-','');
      pickerState[qId] = opt.dataset.val;
      runPicker();
    });
  });
});

function runPicker() {
  if (!pickerState.task || !pickerState.complexity || !pickerState.budget) return;

  let weights = {...TASK_WEIGHTS[pickerState.task]};
  const mods = COMPLEXITY_MODS[pickerState.complexity];
  for (const [k,v] of Object.entries(mods)) weights[k] = (weights[k]||0) + v;

  // Normalize
  const sum = Object.values(weights).reduce((a,b)=>a+b,0);
  for (const k in weights) weights[k] /= sum;

  // Filter by budget
  let pool = MODELS;
  if (pickerState.budget === 'free') pool = pool.filter(m => m.tier === 'standard');

  // Score
  const scored = pool.map(m => {
    let s = 0;
    for (const [dim, w] of Object.entries(weights)) {
      s += (m.scores[dim]||0) * w;
    }
    return { ...m, finalScore: s };
  }).sort((a,b) => b.finalScore - a.finalScore);

  const best = scored[0];
  const el = document.getElementById('picker-result');
  el.classList.add('visible');
  document.getElementById('result-model').textContent = best.name;

  // Build reason
  const topDims = Object.entries(weights).sort((a,b)=>b[1]-a[1]).slice(0,3);
  const reasons = topDims.map(([d]) => {
    const labels = ${JSON.stringify(DIM_LABELS)};
    return labels[d] + ': ' + best.scores[d];
  });
  document.getElementById('result-reason').textContent = 'Top scores in ' + reasons.join(', ') + '. ' + (best.tier==='standard' ? 'Included in your plan.' : 'Uses premium requests.');
  const badge = document.getElementById('result-badge');
  badge.textContent = best.tier;
  badge.className = 'result-badge ' + best.tier;
}

// === Simulator ===
function updateSim() {
  const edits = +document.getElementById('sim-edits').value;
  const reviews = +document.getElementById('sim-reviews').value;
  const complexity = +document.getElementById('sim-complexity').value;
  document.getElementById('sim-edits-val').textContent = edits;
  document.getElementById('sim-reviews-val').textContent = reviews;
  document.getElementById('sim-complexity-val').textContent = ['Low','Medium','High'][complexity-1];

  const results = document.getElementById('sim-results');
  // Premium cost estimation (simplified model)
  const scenarios = [
    { name:'All Standard', model:'Sonnet 4.6 + Haiku', premium:0, quality: 78 + complexity*3 },
    { name:'Mixed', model:'Sonnet 5 (complex) + 4.6 (rest)', premium: Math.round((edits*0.3 + reviews*0.5) * complexity * 0.7), quality: 85 + complexity*3 },
    { name:'All Premium', model:'Opus 4.8 + Sonnet 5', premium: Math.round((edits + reviews) * complexity * 1.2), quality: 92 + complexity*2 },
  ];
  results.innerHTML = scenarios.map((s,i) => \`
    <div class="sim-result-card \${i===1?'best':''}">
      <div class="model-name">\${s.name}</div>
      <div style="font-size:0.7rem;color:var(--text-3);margin-bottom:0.5rem">\${s.model}</div>
      <div class="cost-val">\${s.premium}</div>
      <div class="cost-label">premium reqs/day</div>
      <div style="margin-top:0.5rem;font-size:0.7rem;color:var(--text-2)">Quality: \${s.quality}/100</div>
    </div>
  \`).join('');
}

// Init
lucide.createIcons();
document.querySelectorAll('input[type=range]:not(.filter-slider)').forEach(r => r.addEventListener('input', updateSim));
if (document.getElementById('sim-edits')) updateSim();

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL FILTER ENGINE
// ═══════════════════════════════════════════════════════════════════════════
const filterState = {
  providers: new Set(['anthropic','openai','google','microsoft']),
  tiers: new Set(['standard','premium']),
  only1M: false,
  minScore: 0,
  search: ''
};

function toggleProvider(btn) {
  const p = btn.dataset.provider;
  if (filterState.providers.has(p)) { filterState.providers.delete(p); btn.classList.remove('active'); }
  else { filterState.providers.add(p); btn.classList.add('active'); }
  applyFilters();
}

function toggleTier(btn) {
  const t = btn.dataset.tier;
  if (filterState.tiers.has(t)) { filterState.tiers.delete(t); btn.classList.remove('active'); }
  else { filterState.tiers.add(t); btn.classList.add('active'); }
  applyFilters();
}

function toggle1MCtx(btn) {
  filterState.only1M = !filterState.only1M;
  btn.classList.toggle('active', filterState.only1M);
  applyFilters();
}

function updateMinScore(el) {
  filterState.minScore = +el.value;
  document.getElementById('global-min-score-val').textContent = el.value;
  applyFilters();
}

function updateGlobalSearch(el) {
  filterState.search = el.value.toLowerCase().trim();
  applyFilters();
}

function applyFilters() {
  let visible = 0;
  document.querySelectorAll('tr[data-provider]').forEach(row => {
    const p = row.dataset.provider;
    const t = row.dataset.tier;
    const name = row.dataset.model || '';
    const avg = parseFloat(row.dataset.avg || 0);
    const ctx = row.dataset.ctx || 'default';

    let show = filterState.providers.has(p)
      && filterState.tiers.has(t)
      && avg >= filterState.minScore
      && (!filterState.only1M || ctx === '1m')
      && (!filterState.search || name.includes(filterState.search));

    row.classList.toggle('filtered-out', !show);
    if (show) visible++;
  });

  // Also hide/show SVG chart elements (parallel coords, DNA, frontier)
  document.querySelectorAll('[data-model-provider]').forEach(el => {
    const p = el.dataset.modelProvider;
    const t = el.dataset.modelTier || 'premium';
    const name = (el.dataset.modelName || '').toLowerCase();
    const avg = parseFloat(el.dataset.modelAvg || 0);
    const ctx = el.dataset.modelCtx || 'default';

    let show = filterState.providers.has(p)
      && filterState.tiers.has(t)
      && avg >= filterState.minScore
      && (!filterState.only1M || ctx === '1m')
      && (!filterState.search || name.includes(filterState.search));

    el.style.display = show ? '' : 'none';
  });

  // Also filter gap-card and dna-card divs
  document.querySelectorAll('.gap-card[data-provider], .dna-card[data-provider]').forEach(card => {
    const p = card.dataset.provider;
    const t = card.dataset.tier || 'premium';
    const name = (card.dataset.model || '').toLowerCase();
    const avg = parseFloat(card.dataset.avg || 0);
    const ctx = card.dataset.ctx || 'default';

    let show = filterState.providers.has(p)
      && filterState.tiers.has(t)
      && avg >= filterState.minScore
      && (!filterState.only1M || ctx === '1m')
      && (!filterState.search || name.includes(filterState.search));

    card.style.display = show ? '' : 'none';
  });

  document.getElementById('filter-count').textContent = visible + ' models';

  // Update per-table match counts
  document.querySelectorAll('.table-search-wrap').forEach(wrap => {
    const table = wrap.nextElementSibling?.querySelector('table');
    if (!table) return;
    const total = table.querySelectorAll('tbody tr[data-provider]').length;
    const shown = table.querySelectorAll('tbody tr[data-provider]:not(.filtered-out)').length;
    const counter = wrap.querySelector('.table-match-count');
    if (counter) counter.textContent = shown + '/' + total;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PER-TABLE SEARCH
// ═══════════════════════════════════════════════════════════════════════════
function filterTable(input) {
  const q = input.value.toLowerCase().trim();
  const wrap = input.closest('.table-search-wrap');
  const table = wrap?.nextElementSibling?.querySelector('table') || wrap?.parentElement?.querySelector('table');
  if (!table) return;

  let shown = 0, total = 0;
  table.querySelectorAll('tbody tr').forEach(row => {
    total++;
    const text = row.textContent.toLowerCase();
    const match = !q || text.includes(q);
    row.classList.toggle('filtered-out', !match);
    if (match) shown++;
  });

  const counter = wrap.querySelector('.table-match-count');
  if (counter) counter.textContent = q ? shown + '/' + total : '';
}

// ═══════════════════════════════════════════════════════════════════════════
// SORTABLE TABLES
// ═══════════════════════════════════════════════════════════════════════════
document.querySelectorAll('.sortable-th').forEach(th => {
  th.addEventListener('click', () => {
    const table = th.closest('table');
    const tbody = table.querySelector('tbody');
    const col = parseInt(th.dataset.col);
    const wasDesc = th.classList.contains('sort-desc');
    const wasAsc = th.classList.contains('sort-asc');

    // Clear all sort indicators on this table
    table.querySelectorAll('.sortable-th').forEach(h => { h.classList.remove('sort-asc','sort-desc'); });

    // Determine direction: cycle none -> desc -> asc -> desc
    let dir;
    if (!wasDesc && !wasAsc) dir = 'desc';
    else if (wasDesc) dir = 'asc';
    else dir = 'desc';

    th.classList.add('sort-' + dir);

    const rows = [...tbody.querySelectorAll('tr')];
    rows.sort((a,b) => {
      let av = getCellSortVal(a, col);
      let bv = getCellSortVal(b, col);
      let cmp;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      return dir === 'desc' ? -cmp : cmp;
    });

    for (const row of rows) tbody.appendChild(row);
  });
});

function getCellSortVal(row, col) {
  const cell = row.children[col];
  if (!cell) return '';

  // Check for explicit sort value
  if (cell.dataset.sortVal) return parseFloat(cell.dataset.sortVal);

  // Try to parse as number
  const text = cell.textContent.trim().replace(/[%$,K]/g, '');
  const num = parseFloat(text);
  if (!isNaN(num)) return num;
  return text.toLowerCase();
}
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION GENERATORS
// ═══════════════════════════════════════════════════════════════════════════════

function generateQuickMatrix() {
  // Helper: get a model's top benchmark with source link
  function cite(modelId, benchName) {
    const mb = getBenchmarks(modelId);
    if (!mb) return '';
    const entry = mb.benchmarks.find(b => b.benchmark === benchName);
    if (!entry) return '';
    return ` <a href="${entry.source}" target="_blank" rel="noopener" style="color:var(--accent-1);font-size:0.68rem" title="${entry.sourceLabel}">[${entry.score}%]</a>`;
  }

  const scenarios = [
    { scenario:'Quick edit, 1 file, stay free', rec:'Claude Haiku 4.5', why:'Fastest standard model, 96 speed score', citeHtml:'' },
    { scenario:'Multi-file refactor, budget OK', rec:'Claude Sonnet 5', why:'SWE-bench 85.2%, Terminal-Bench 80.4%', citeHtml: cite('claude-sonnet-5','SWE-bench Verified') },
    { scenario:'PR review, need to find bugs', rec:'Claude Opus 4.8', why:'SWE-bench 88.6% (highest in pool)', citeHtml: cite('claude-opus-4.8','SWE-bench Verified') },
    { scenario:'Whole-repo analysis', rec:'Gemini 3.1 Pro', why:'1M token context, GPQA Diamond 94.3%', citeHtml: cite('gemini-3.1-pro-preview','GPQA Diamond') },
    { scenario:'Architecture design session', rec:'Claude Opus 4.7', why:'Reasoning 96, creative 93, deep extended thinking', citeHtml:'' },
    { scenario:'Batch processing many files cheaply', rec:'Gemini 3.5 Flash', why:'1M context + standard tier, Terminal-Bench 76.2%', citeHtml: cite('gemini-3.5-flash','Terminal-Bench 2.1') },
    { scenario:'Security audit with deep reasoning', rec:'GPT-5.6 Sol', why:'Terminal-Bench 91.9%, CTF Cyber 96.7%', citeHtml: cite('gpt-5.6-sol','Terminal-Bench 2.1') },
    { scenario:'Write docs and READMEs', rec:'GPT-5.6 Luna', why:'Best creative writing in OpenAI (94 score)', citeHtml:'' },
    { scenario:'Generate test suites fast', rec:'Claude Sonnet 5', why:'SWE-bench Pro 63.2%, instructions 94', citeHtml: cite('claude-sonnet-5','SWE-bench Pro') },
    { scenario:'Debug a gnarly production issue', rec:'Claude Opus 4.8', why:'SWE-bench Pro 69.2%, highest reasoning', citeHtml: cite('claude-opus-4.8','SWE-bench Pro') },
  ];

  let rows = scenarios.map(s => `
    <tr>
      <td style="font-weight:500">${s.scenario}</td>
      <td style="font-weight:700;background:var(--gradient-text);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">${s.rec}</td>
      <td style="font-size:0.75rem;color:var(--text-2)">${s.why}${s.citeHtml}</td>
    </tr>`).join('');

  return `<div class="heatmap-wrap"><table class="data-table" style="font-size:0.82rem">
    <thead><tr><th style="min-width:250px">Scenario</th><th style="min-width:160px">Use This</th><th>Why</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function generateHeatmap() {
  const sorted = [...MODEL_REGISTRY].sort((a,b) => avgScore(b) - avgScore(a));

  let headerCells = '<th class="sortable-th" data-col="0">Model</th>' + DIMS.map((d,i) => `<th class="sortable-th" data-col="${i+1}">${DIM_LABELS[d]}</th>`).join('') + `<th class="sortable-th sort-desc" data-col="${DIMS.length+1}">Avg</th>`;
  let rows = '';
  for (const m of sorted) {
    let cells = `<td><span style="color:${PROV_COLORS[m.provider]}">${m.name}</span></td>`;
    for (const d of DIMS) {
      const v = m.scores[d];
      const hue = v >= 90 ? '142,70%,45%' : v >= 80 ? '200,80%,50%' : v >= 70 ? '45,90%,48%' : '0,75%,55%';
      const bg = `hsla(${hue},${v >= 80 ? 0.18 : 0.12})`;
      const color = `hsl(${hue})`;
      cells += `<td><div class="heat-cell" style="background:${bg};color:${color}">${v}</div></td>`;
    }
    const avg = avgScore(m);
    cells += `<td style="font-weight:700">${avg}</td>`;
    rows += `<tr data-provider="${m.provider}" data-tier="${m.tier}" data-model="${m.name.toLowerCase()}" data-avg="${avg}" data-ctx="${m.supports1MContext ? '1m' : 'default'}">${cells}</tr>`;
  }

  return `<div class="table-search-wrap"><input type="text" class="table-search" placeholder="Filter models..." oninput="filterTable(this)"><span class="table-match-count"></span></div>
  <div class="heatmap-wrap"><table class="heatmap sortable-table"><thead><tr>${headerCells}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function generateParallelCoords() {
  const w = 1100, h = 420;
  const padL = 20, padR = 20, padT = 40, padB = 60;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const axisGap = plotW / (DIMS.length - 1);

  // Axes
  let axes = '';
  for (let i = 0; i < DIMS.length; i++) {
    const x = padL + i * axisGap;
    axes += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="var(--border)" stroke-width="1"/>`;
    axes += `<text x="${x}" y="${h - 15}" text-anchor="middle" style="font-size:9px;fill:var(--text-3);font-family:var(--font)">${DIM_LABELS[DIMS[i]]}</text>`;
    // Tick labels
    for (let t = 0; t <= 100; t += 25) {
      const y = padT + plotH - (t / 100) * plotH;
      if (i === 0) axes += `<text x="${padL - 5}" y="${y + 3}" text-anchor="end" style="font-size:7px;fill:var(--text-3);font-family:var(--mono)">${t}</text>`;
    }
  }

  // Lines for each model
  let lines = '';
  let legendItems = [];
  const topModels = [...MODEL_REGISTRY].sort((a,b) => avgScore(b) - avgScore(a)).slice(0, 10);

  for (let mi = 0; mi < topModels.length; mi++) {
    const m = topModels[mi];
    const color = PROV_COLORS[m.provider];
    const opacity = mi < 5 ? 0.8 : 0.4;
    let points = '';
    for (let i = 0; i < DIMS.length; i++) {
      const x = padL + i * axisGap;
      const y = padT + plotH - (m.scores[DIMS[i]] / 100) * plotH;
      points += `${x},${y} `;
    }
    lines += `<polyline data-model-provider="${m.provider}" data-model-tier="${m.tier}" data-model-name="${m.name}" data-model-avg="${avgScore(m)}" data-model-ctx="${m.supports1MContext ? '1m' : 'default'}" points="${points}" fill="none" stroke="${color}" stroke-width="${mi < 3 ? 2.5 : 1.5}" stroke-opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
    legendItems.push(`<div class="parallel-legend-item" data-model-provider="${m.provider}" data-model-tier="${m.tier}" data-model-name="${m.name}" data-model-avg="${avgScore(m)}" data-model-ctx="${m.supports1MContext ? '1m' : 'default'}"><div style="width:12px;height:3px;background:${color};border-radius:2px;opacity:${opacity}"></div>${m.name}</div>`);
  }

  return `<div class="parallel-wrap">
    <svg viewBox="0 0 ${w} ${h}">${axes}${lines}</svg>
    <div class="parallel-legend">${legendItems.join('')}</div>
  </div>`;
}

function generateGapAnalysis() {
  const best = MODEL_REGISTRY.reduce((a,b) => avgScore(a) > avgScore(b) ? a : b);
  const budgetModels = MODEL_REGISTRY.filter(m => m.tier === 'standard').sort((a,b) => avgScore(b) - avgScore(a));

  let html = '';
  for (const m of budgetModels.slice(0, 4)) {
    const gaps = DIMS.map(d => ({
      dim: DIM_LABELS[d],
      modelVal: m.scores[d],
      bestVal: best.scores[d],
      gap: best.scores[d] - m.scores[d]
    })).sort((a,b) => b.gap - a.gap);

    const totalGap = gaps.reduce((s,g) => s + g.gap, 0);
    const avgGap = Math.round(totalGap / gaps.length);

    let bars = gaps.map(g => `
      <div class="gap-bar-row">
        <span class="gap-bar-label">${g.dim}</span>
        <div class="gap-bar-track">
          <div class="gap-bar-base" style="width:${g.bestVal}%;background:${PROV_COLORS[best.provider]}"></div>
          <div class="gap-bar-model" style="width:${g.modelVal}%;background:${PROV_COLORS[m.provider]}"></div>
        </div>
        <span class="gap-bar-val" style="color:${g.gap > 15 ? '#ef4444' : g.gap > 8 ? '#f59e0b' : '#34d399'}">${g.gap > 0 ? '-' + g.gap : '='}</span>
      </div>
    `).join('');

    html += `<div class="gap-card" data-provider="${m.provider}" data-tier="${m.tier}" data-model="${m.name.toLowerCase()}" data-avg="${avgScore(m)}" data-ctx="${m.supports1MContext ? '1m' : 'default'}">
      <div class="gap-header">
        <div>
          <div class="gap-title" style="color:${PROV_COLORS[m.provider]}">${m.name} <span style="font-weight:400;font-size:0.75rem;color:var(--text-3)">vs ${best.name}</span></div>
        </div>
        <div class="gap-score" style="color:${avgGap > 15 ? '#ef4444' : avgGap > 8 ? '#f59e0b' : '#34d399'}">-${avgGap} avg gap</div>
      </div>
      <div class="gap-bars">${bars}</div>
    </div>`;
  }
  return html;
}

function generateFrontierChart() {
  const w = 900, h = 500;
  const pad = { t:40, r:30, b:60, l:60 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;

  const data = MODEL_REGISTRY.map(m => ({ name:m.name, provider:m.provider, tier:m.tier, x:m.scores.costEfficiency, y:avgScore(m), ctx:m.supports1MContext ? '1m' : 'default' }));
  const xMin = 30, xMax = 100, yMin = 60, yMax = 95;

  // Grid
  let grid = '';
  for (let v = 40; v <= 100; v += 10) {
    const x = pad.l + ((v - xMin) / (xMax - xMin)) * plotW;
    grid += `<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${pad.t + plotH}" stroke="var(--border-subtle)" stroke-width="0.5"/>`;
    grid += `<text x="${x}" y="${h - 20}" text-anchor="middle" style="font-size:10px;fill:var(--text-3);font-family:var(--mono)">${v}</text>`;
  }
  for (let v = 60; v <= 95; v += 5) {
    const y = pad.t + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
    grid += `<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="var(--border-subtle)" stroke-width="0.5"/>`;
    grid += `<text x="${pad.l - 8}" y="${y + 3}" text-anchor="end" style="font-size:10px;fill:var(--text-3);font-family:var(--mono)">${v}</text>`;
  }

  // Compute Pareto frontier
  const sorted = [...data].sort((a,b) => a.x - b.x);
  let frontier = [];
  let maxY = -1;
  for (const d of sorted.sort((a,b) => b.x - a.x)) {
    if (d.y > maxY) { frontier.push(d); maxY = d.y; }
  }
  frontier.sort((a,b) => a.x - b.x);

  // Frontier curve
  let frontierPath = '';
  if (frontier.length > 1) {
    const pts = frontier.map(d => {
      const x = pad.l + ((d.x - xMin) / (xMax - xMin)) * plotW;
      const y = pad.t + plotH - ((d.y - yMin) / (yMax - yMin)) * plotH;
      return `${x},${y}`;
    });
    frontierPath = `<polyline points="${pts.join(' ')}" fill="none" stroke="url(#grad)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="6 3"/>`;
    // Shaded area above frontier
    const areaPath = `M ${pts[0]} ${pts.join(' L ')} L ${pad.l + ((frontier[frontier.length-1].x - xMin)/(xMax-xMin))*plotW},${pad.t} L ${pad.l + ((frontier[0].x - xMin)/(xMax-xMin))*plotW},${pad.t} Z`;
    frontierPath += `<path d="${areaPath}" fill="url(#grad)" fill-opacity="0.04"/>`;
  }

  // Dots
  let dots = '';
  for (const d of data) {
    const x = pad.l + ((d.x - xMin) / (xMax - xMin)) * plotW;
    const y = pad.t + plotH - ((d.y - yMin) / (yMax - yMin)) * plotH;
    const col = PROV_COLORS[d.provider];
    const isFrontier = frontier.some(f => f.name === d.name);
    const r = isFrontier ? 7 : 5;
    const stroke = isFrontier ? `stroke="${col}" stroke-width="2"` : '';
    const gAttrs = `data-model-provider="${d.provider}" data-model-tier="${d.tier}" data-model-name="${d.name.toLowerCase()}" data-model-avg="${d.y.toFixed(0)}" data-model-ctx="${d.ctx}"`;
    dots += `<g ${gAttrs}>`;
    dots += `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}" fill-opacity="${isFrontier ? 0.9 : 0.5}" ${stroke}/>`;
    if (isFrontier || d.y >= 85 || d.x >= 88) {
      dots += `<text x="${x}" y="${y - 10}" text-anchor="middle" style="font-size:9px;fill:var(--text-2);font-family:var(--font)">${d.name.replace('Claude ','').replace('GPT-','G').replace('Gemini ','Gem ')}</text>`;
    }
    dots += '</g>';
  }

  return `<div class="parallel-wrap">
    <svg viewBox="0 0 ${w} ${h}">
      <defs><linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#8b5cf6"/></linearGradient></defs>
      ${grid}${frontierPath}${dots}
      <text x="${w/2}" y="${h - 3}" text-anchor="middle" style="font-size:11px;fill:var(--text-3);font-family:var(--font)">Cost Efficiency →</text>
      <text x="13" y="${h/2}" text-anchor="middle" transform="rotate(-90,13,${h/2})" style="font-size:11px;fill:var(--text-3);font-family:var(--font)">↑ Average Quality</text>
      <text x="${w - pad.r - 5}" y="${pad.t + 15}" text-anchor="end" style="font-size:9px;fill:var(--text-3);font-style:italic">Pareto frontier (dashed)</text>
    </svg>
    <div style="display:flex;gap:1.5rem;justify-content:center;margin-top:1rem;font-size:0.75rem;color:var(--text-2)">
      <span><span style="color:#a78bfa">●</span> Anthropic</span>
      <span><span style="color:#34d399">●</span> OpenAI</span>
      <span><span style="color:#60a5fa">●</span> Google</span>
      <span><span style="color:#fb923c">●</span> Microsoft</span>
      <span style="color:var(--text-3)">| ◯ = on Pareto frontier</span>
    </div>
  </div>`;
}

function generateSimulator() {
  return `<div class="sim-section">
    <p style="color:var(--text-2);font-size:0.85rem;margin-bottom:1.5rem">Estimate how many premium requests your typical workday would consume with different model strategies.</p>
    <div class="sim-controls">
      <div class="sim-control">
        <label>Code edits per day</label>
        <input type="range" id="sim-edits" min="5" max="80" value="25" step="5">
        <span class="val" id="sim-edits-val">25</span>
      </div>
      <div class="sim-control">
        <label>Reviews / debug sessions</label>
        <input type="range" id="sim-reviews" min="1" max="20" value="5" step="1">
        <span class="val" id="sim-reviews-val">5</span>
      </div>
      <div class="sim-control">
        <label>Avg complexity</label>
        <input type="range" id="sim-complexity" min="1" max="3" value="2" step="1">
        <span class="val" id="sim-complexity-val">Medium</span>
      </div>
    </div>
    <div class="sim-results" id="sim-results"></div>
  </div>`;
}

function generateUpgradePath() {
  const steps = [
    { trigger:'Starting out / simple tasks', model:'Claude Haiku 4.5 or GPT-5.4 mini', why:'Free (standard tier), fast, good enough for 1-2 file edits and completions. Start here.' },
    { trigger:'Multi-file edits feel incomplete or buggy', model:'Claude Sonnet 4.6', why:'Still standard tier. Much better multi-file understanding (82) and tool use (90). Zero premium cost increase.' },
    { trigger:'Complex refactors need more intelligence', model:'Claude Sonnet 5', why:'First premium step. Code gen 93, tool use 94. Worth it when Sonnet 4.6 misses relationships between files.' },
    { trigger:'Code review misses subtle bugs', model:'Claude Opus 4.7 or 4.8', why:'Code review 94-95, reasoning 96-97. Use when correctness matters more than speed (security, financial, auth code).' },
    { trigger:'Need to analyze a massive codebase at once', model:'Gemini 3.1 Pro', why:'1M token context. Use when the problem requires seeing 50+ files simultaneously. Nothing else comes close on context.' },
    { trigger:'Need frontier reasoning for architecture', model:'GPT-5.6 Sol or Opus 4.8 (max effort)', why:'Max reasoning ceiling. Use for system design, complex debugging where you need the model to think deeper than you can.' },
  ];

  let html = '<div class="upgrade-track">';
  for (const s of steps) {
    html += `<div class="upgrade-step">
      <div class="upgrade-line"></div>
      <div class="upgrade-content">
        <div class="upgrade-trigger">${s.trigger}</div>
        <div class="upgrade-model">${s.model}</div>
        <div class="upgrade-why">${s.why}</div>
      </div>
    </div>`;
  }
  html += '</div>';
  return html;
}

function generateDNA() {
  let html = '<div class="dna-grid">';
  const sorted = [...MODEL_REGISTRY].sort((a,b) => avgScore(b) - avgScore(a));

  for (const m of sorted) {
    // Generate a unique SVG "fingerprint" based on scores
    const size = 80;
    const cx = size/2, cy = size/2, r = 30;
    const n = DIMS.length;
    const angleStep = (2 * Math.PI) / n;
    const color = PROV_COLORS[m.provider];

    let points = '';
    for (let i = 0; i < n; i++) {
      const val = m.scores[DIMS[i]] / 100;
      const angle = i * angleStep - Math.PI / 2;
      const x = cx + r * val * Math.cos(angle);
      const y = cy + r * val * Math.sin(angle);
      points += `${x},${y} `;
    }

    // Ring
    let ring = '';
    for (let i = 0; i < n; i++) {
      const angle = i * angleStep - Math.PI / 2;
      const x1 = cx + (r * 0.3) * Math.cos(angle);
      const y1 = cy + (r * 0.3) * Math.sin(angle);
      const x2 = cx + r * Math.cos(angle);
      const y2 = cy + r * Math.sin(angle);
      ring += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-opacity="0.15" stroke-width="0.5"/>`;
    }

    const svg = `<svg viewBox="0 0 ${size} ${size}" width="70" height="70">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-opacity="0.1" stroke-width="0.5"/>
      <circle cx="${cx}" cy="${cy}" r="${r*0.6}" fill="none" stroke="${color}" stroke-opacity="0.07" stroke-width="0.5"/>
      ${ring}
      <polygon points="${points}" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`;

    html += `<div class="dna-card" data-provider="${m.provider}" data-tier="${m.tier}" data-model="${m.name.toLowerCase()}" data-avg="${avgScore(m)}" data-ctx="${m.supports1MContext ? '1m' : 'default'}">
      ${svg}
      <div class="dna-name" style="color:${color}">${m.name.replace('Claude ','').replace('GPT-','').replace('Gemini ','')}</div>
      <div class="dna-score">avg ${avgScore(m)}</div>
    </div>`;
  }
  html += '</div>';
  return html;
}

function generateInlineBenchmarks() {
  // Compact cross-model benchmark comparison with source links
  const benchmarkNames = ['SWE-bench Verified', 'Terminal-Bench 2.1', 'SWE-bench Pro', 'OSWorld-Verified', 'BrowseComp'];
  let header = '<th>Model</th>' + benchmarkNames.map(b => `<th style="font-size:0.68rem">${b}</th>`).join('');
  let rows = '';

  for (const mb of VERIFIED_BENCHMARKS) {
    const model = MODEL_REGISTRY.find(m => m.id === mb.modelId);
    if (!model) continue;
    const color = PROV_COLORS[model.provider];
    let cells = `<td style="font-weight:600;color:${color};white-space:nowrap">${model.name}</td>`;
    for (const bName of benchmarkNames) {
      const entry = mb.benchmarks.find(b => b.benchmark === bName);
      if (entry) {
        cells += `<td><a href="${entry.source}" target="_blank" rel="noopener" style="color:var(--text-1);text-decoration:none;border-bottom:1px dotted var(--accent-1)" title="${entry.sourceLabel}">${entry.score}%</a></td>`;
      } else {
        cells += '<td style="color:var(--text-3)">--</td>';
      }
    }
    rows += `<tr data-provider="${model.provider}" data-tier="${model.tier}" data-model="${model.name.toLowerCase()}">${cells}</tr>`;
  }

  return `<div class="heatmap-wrap"><table class="data-table" style="font-size:0.76rem">
    <thead><tr>${header}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p style="font-size:0.68rem;color:var(--text-3);margin-top:0.5rem">Click any score to open source. Hover for citation. See the <strong>Sources</strong> tab for the full dataset.</p>`;
}

function generateSourcesPanel() {
  // Verified benchmarks table (grouped by model)
  let benchRows = '';
  for (const mb of VERIFIED_BENCHMARKS) {
    const model = MODEL_REGISTRY.find(m => m.id === mb.modelId);
    const modelName = model ? model.name : mb.modelId;
    for (const b of mb.benchmarks) {
      benchRows += `<tr data-provider="${model ? model.provider : ''}" data-tier="${model ? model.tier : ''}" data-model="${modelName.toLowerCase()}">
        <td style="font-weight:600">${modelName}</td>
        <td>${b.benchmark}</td>
        <td style="font-family:var(--mono);font-weight:700">${b.score}${typeof b.score === 'number' ? '%' : ''}</td>
        <td><a href="${b.source}" target="_blank" rel="noopener" class="source-link">${b.sourceLabel} <i data-lucide="external-link" style="width:10px;height:10px;vertical-align:middle"></i></a></td>
      </tr>`;
    }
  }

  // Independent leaderboards
  let leaderboardCards = INDEPENDENT_SOURCES.map(src => `
    <div class="source-card">
      <div class="source-card-title"><a href="${src.url}" target="_blank" rel="noopener">${src.name} <i data-lucide="external-link" style="width:11px;height:11px"></i></a></div>
      <div class="source-card-desc">${src.description}</div>
      <div class="source-card-meta">Updated: ${src.lastUpdated}</div>
    </div>
  `).join('');

  // Provider docs
  let providerLinks = Object.entries(PROVIDER_DOCS).map(([key, docs]) => {
    const links = Object.entries(docs).map(([type, url]) =>
      `<a href="${url}" target="_blank" rel="noopener" class="prov-doc-link">${type} <i data-lucide="external-link" style="width:9px;height:9px"></i></a>`
    ).join(' ');
    return `<div class="prov-doc-row"><span class="prov-doc-name" style="color:${PROV_COLORS[key] || 'var(--text-1)'}">${key.charAt(0).toUpperCase() + key.slice(1)}</span>${links}</div>`;
  }).join('');

  // Methodology note
  const methodology = `
    <div class="methodology-box">
      <h3><i data-lucide="flask-conical" style="width:16px;height:16px;vertical-align:middle"></i> Methodology</h3>
      <ul>
        <li><strong>Normalized Scores (0-100)</strong>: Composite ratings derived from multiple benchmarks, weighted by relevance to each dimension. They are NOT raw benchmark percentages; they represent relative capability within the Copilot model pool.</li>
        <li><strong>Sources</strong>: Official provider announcements, system cards, and independent third-party benchmarks. Each raw number links to its origin.</li>
        <li><strong>Recommendation Engine</strong>: Uses weighted dimension profiles matched to your stated task + complexity + budget constraints. Weights come from empirical testing across development workflows.</li>
        <li><strong>Freshness</strong>: Data as of July 2026. Models and benchmarks evolve rapidly; re-run this report periodically for current data.</li>
      </ul>
    </div>`;

  return `
    ${methodology}
    <h3 class="sources-section-title"><i data-lucide="beaker" style="width:16px;height:16px;vertical-align:middle"></i> Verified Benchmarks</h3>
    <p style="font-size:0.78rem;color:var(--text-2);margin-bottom:1rem">Raw benchmark scores from official announcements and independent evaluation. Each entry links to its source.</p>
    <div class="heatmap-wrap"><table class="data-table" style="font-size:0.78rem">
      <thead><tr><th>Model</th><th>Benchmark</th><th>Score</th><th>Source</th></tr></thead>
      <tbody>${benchRows}</tbody>
    </table></div>

    <h3 class="sources-section-title" style="margin-top:2rem"><i data-lucide="trophy" style="width:16px;height:16px;vertical-align:middle"></i> Independent Leaderboards</h3>
    <p style="font-size:0.78rem;color:var(--text-2);margin-bottom:1rem">Third-party evaluation platforms (not controlled by any provider).</p>
    <div class="source-cards-grid">${leaderboardCards}</div>

    <h3 class="sources-section-title" style="margin-top:2rem"><i data-lucide="building-2" style="width:16px;height:16px;vertical-align:middle"></i> Provider Documentation</h3>
    <div class="prov-docs-wrap">${providerLinks}</div>
  `;
}

function generateCensus(groups) {
  let rows = '';
  for (const [provKey, models] of groups) {
    for (const m of models) {
      const ctx1M = m.supports1MContext ? '<span style="color:#34d399" title="Supports 1M token context">1M</span>' : `${m.contextWindow}K`;
      const reasoning = m.supportsReasoning ? '<span style="color:#34d399">Yes</span>' : '<span style="color:var(--text-3)">No</span>';
      const priceIn = m.pricing ? `$${m.pricing.input}` : '?';
      const priceOut = m.pricing ? `$${m.pricing.output}` : '?';
      rows += `<tr data-provider="${provKey}" data-tier="${m.tier}" data-model="${m.name.toLowerCase()}" data-avg="${avgScore(m)}" data-ctx="${m.supports1MContext ? '1m' : 'default'}">
        <td><span style="color:${PROV_COLORS[provKey]};font-weight:600">${PROVIDERS[provKey].name}</span></td>
        <td><strong>${m.name}</strong></td>
        <td style="font-family:var(--mono);font-size:0.68rem">${ctx1M}</td>
        <td>${reasoning}</td>
        <td><span class="badge badge-${m.tier === 'standard' ? 's' : 'p'}">${m.tier}</span></td>
        <td style="font-size:0.72rem;color:var(--text-2)">${m.category || ''}</td>
        <td style="font-family:var(--mono);font-size:0.72rem" data-sort-val="${m.pricing ? m.pricing.input : 999}">${priceIn} / ${priceOut}</td>
        <td style="font-size:0.72rem">${m.effortLevels.length ? m.effortLevels.join(', ') : 'N/A'}</td>
        <td style="font-family:var(--mono);font-weight:600">${avgScore(m)}</td>
      </tr>`;
    }
  }
  return `<div class="table-search-wrap"><input type="text" class="table-search" placeholder="Filter models..." oninput="filterTable(this)"><span class="table-match-count"></span></div>
  <div class="heatmap-wrap"><table class="data-table sortable-table" style="font-size:0.78rem">
    <thead><tr><th class="sortable-th" data-col="0">Provider</th><th class="sortable-th" data-col="1">Model</th><th class="sortable-th" data-col="2">Max Ctx</th><th class="sortable-th" data-col="3">Reasoning</th><th class="sortable-th" data-col="4">Tier</th><th class="sortable-th" data-col="5">Category</th><th class="sortable-th" data-col="6">Price (in/out per 1M)</th><th class="sortable-th" data-col="7">Effort Levels</th><th class="sortable-th sort-desc" data-col="8">Avg</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p style="font-size:0.68rem;color:var(--text-3);margin-top:0.5rem">Context: models marked "1M" support extended 1M token context window via long_context tier. Pricing from <a href="https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing" target="_blank" rel="noopener" style="color:var(--accent-1)">GitHub Copilot pricing docs</a>.</p>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

const html = generateHTML();
writeFileSync(outputPath, html, 'utf8');
console.log(`Report: ${outputPath}`);
if (openBrowser) {
  try { if (process.platform === 'win32') execSync(`start "" "${outputPath}"`, {stdio:'ignore'}); } catch {}
}
