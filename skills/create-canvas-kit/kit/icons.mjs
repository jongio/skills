// canvas-kit/icons.mjs
//
// Lucide icons for canvases — the SAME icon set and version github-app uses
// (lucide-react@1.14.0, catalogued in github-app src/lib/icons.tsx). The full
// set is vendored offline in vendor/lucide.mjs (no CDN, no build) and rendered
// as inline SVG with stroke="currentColor", so icons inherit the surrounding
// theme-token text color automatically.
//
// Names are Lucide kebab-case (e.g. "circle-check", "trash-2", "plus") exactly
// as on lucide.dev. Deprecated/alternate names resolve via the alias map.
//
// Two entry points:
//   Icon({ name })     Preact component (htm/Preact canvases) — the default
//   lucideSVG(name)    SVG string (vanilla-JS canvases / innerHTML)

import { html } from "./vendor/preact-htm-standalone.mjs";
import LUCIDE, { aliases } from "./vendor/lucide.mjs";

// Lucide root-SVG defaults (identical to lucide-react/defaultAttributes).
// Stroke width is fixed at 2 on a 24x24 viewBox, so it auto-scales with size:
// at size N the rendered stroke is 2 * (N / 24). Don't override it.
const VIEWBOX = "0 0 24 24";
const STROKE_WIDTH = 2;

function resolve(name) {
  return LUCIDE[name] || LUCIDE[aliases[name]] || null;
}

function kebab(k) {
  return k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

function nodeToString(iconNode) {
  return iconNode
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .map(([k, v]) => `${kebab(k)}="${escapeAttr(v)}"`)
        .join(" ");
      return `<${tag} ${a} />`;
    })
    .join("");
}

/** True if an icon (or alias) with this name is available offline. */
export function hasIcon(name) {
  return resolve(name) != null;
}

/** All canonical icon names (sorted). */
export function iconNames() {
  return Object.keys(LUCIDE);
}

/**
 * Lucide icon as an SVG string (for vanilla canvases / template literals).
 * @param {string} name  Lucide name, e.g. "circle-check", "trash-2", "plus"
 * @param {object} [opts]
 * @param {number} [opts.size=16]
 * @param {string} [opts.className]
 * @param {string} [opts.label]  accessible label; omit for decorative icons
 */
export function lucideSVG(name, { size = 16, className = "", label } = {}) {
  const node = resolve(name);
  if (!node) return "";
  const a11y = label ? `role="img" aria-label="${escapeAttr(label)}"` : 'aria-hidden="true"';
  const cls = `lucide lucide-${name} ck-icon${className ? " " + className : ""}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="${cls}" ` +
    `width="${size}" height="${size}" viewBox="${VIEWBOX}" fill="none" ` +
    `stroke="currentColor" stroke-width="${STROKE_WIDTH}" ` +
    `stroke-linecap="round" stroke-linejoin="round" ${a11y}>` +
    `${nodeToString(node)}</svg>`
  );
}

/**
 * Lucide icon as a Preact vnode (the default for kit canvases).
 * Usage in an htm template:  html`<${Icon} name="plus" />`
 */
export function Icon({ name, size = 16, class: cls = "", label }) {
  const node = resolve(name);
  if (!node) return null;
  const props = {
    xmlns: "http://www.w3.org/2000/svg",
    class: `lucide lucide-${name} ck-icon${cls ? " " + cls : ""}`,
    width: size,
    height: size,
    viewBox: VIEWBOX,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": STROKE_WIDTH,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    dangerouslySetInnerHTML: { __html: nodeToString(node) },
  };
  if (label) {
    props.role = "img";
    props["aria-label"] = label;
  } else {
    props["aria-hidden"] = "true";
  }
  return html`<svg ...${props}></svg>`;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export { LUCIDE };
