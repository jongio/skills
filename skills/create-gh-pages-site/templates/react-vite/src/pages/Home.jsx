import { useState } from "react";
import { Link } from "react-router-dom";

export default function Home() {
  const [count, setCount] = useState(0);
  return (
    <>
      <header className="hero">
        <p className="eyebrow">GitHub Pages · React + Vite</p>
        <h1>__SITE_NAME__</h1>
        <p className="lede">
          A client-rendered React SPA — wired for GitHub Pages and built as a
          reference for hooks, context, routing, code-splitting, and data fetching.
        </p>
        <button className="btn" onClick={() => setCount((c) => c + 1)}>
          useState · clicked {count} times
        </button>
      </header>

      <section className="card">
        <h2>What this template shows</h2>
        <ul>
          <li><strong>Context</strong> — the light/dark theme uses a <code>ThemeProvider</code> + <code>useTheme()</code>.</li>
          <li><strong>Routing</strong> — React Router with a base-path-aware <code>basename</code>.</li>
          <li><strong>Code splitting</strong> — the <Link to="/form">Form</Link> and <Link to="/about">About</Link> routes are <code>lazy()</code>-loaded.</li>
          <li><strong>Data fetching</strong> — the <Link to="/data">Data</Link> route uses <code>useReducer</code> for a loading/error/done state machine.</li>
          <li><strong>Deep links</strong> survive refresh via the <code>404.html</code> fallback.</li>
        </ul>
      </section>
    </>
  );
}
