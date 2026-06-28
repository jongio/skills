import { useState } from "react";

export default function Home() {
  const [count, setCount] = useState(0);
  return (
    <>
      <header className="hero">
        <p className="eyebrow">GitHub Pages · React + Vite</p>
        <h1>__SITE_NAME__</h1>
        <p className="lede">
          A client-rendered React single-page app, wired for GitHub Pages with a
          base path and a 404 fallback so deep links survive a refresh.
        </p>
        <button className="btn" onClick={() => setCount((c) => c + 1)}>
          clicked {count} times
        </button>
      </header>
    </>
  );
}
