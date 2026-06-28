export default function About() {
  return (
    <>
      <header className="hero">
        <h1>About</h1>
        <p className="lede">What the <code>react-vite</code> template demonstrates.</p>
      </header>
      <section className="card">
        <ul>
          <li><strong>Hooks</strong> — <code>useState</code>, <code>useEffect</code>, <code>useReducer</code>, <code>useCallback</code>, <code>useContext</code>.</li>
          <li><strong>Context</strong> — a persisted light/dark theme via <code>ThemeProvider</code>.</li>
          <li><strong>Routing</strong> — React Router with a base-path-aware <code>basename</code>.</li>
          <li><strong>Code splitting</strong> — this page and the Form are <code>lazy()</code> + <code>Suspense</code>.</li>
          <li><strong>Data fetching</strong> — a loading/error/done state machine on the Data page.</li>
          <li><strong>GitHub Pages</strong> — <code>base</code> in <code>vite.config.js</code> + a <code>404.html</code> SPA fallback.</li>
        </ul>
        <p className="muted">Source: <a href="https://github.com/__REPO_SLUG__">github.com/__REPO_SLUG__</a></p>
      </section>
    </>
  );
}
