import { useState } from "preact/hooks";

// A real Preact island. Astro ships its JS only when the component is hydrated
// (e.g. client:visible). Everything else on the page stays static HTML.
export default function Counter({ start = 0 }) {
  const [n, setN] = useState(start);
  return (
    <div style="display:flex;gap:.6rem;align-items:center;">
      <button class="btn" onClick={() => setN(n - 1)} aria-label="decrement">−</button>
      <strong style="min-width:2ch;text-align:center;font-variant-numeric:tabular-nums;">{n}</strong>
      <button class="btn" onClick={() => setN(n + 1)} aria-label="increment">+</button>
      <span class="muted">hydrated island</span>
    </div>
  );
}
