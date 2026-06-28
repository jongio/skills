import { Suspense, lazy } from "react";
import { Routes, Route } from "react-router-dom";
import TopBar from "./components/TopBar.jsx";
import Home from "./pages/Home.jsx";
import Data from "./pages/Data.jsx";

// Code-split routes: these chunks load on demand (watch the Network tab).
const Form = lazy(() => import("./pages/Form.jsx"));
const About = lazy(() => import("./pages/About.jsx"));

export default function App() {
  return (
    <>
      <TopBar />
      <main className="wrap">
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/data" element={<Data />} />
            <Route path="/form" element={<Form />} />
            <Route path="/about" element={<About />} />
            {/* Unknown client routes fall back to Home. The 404.html copy lets
                GitHub Pages hand deep links to the SPA. */}
            <Route path="*" element={<Home />} />
          </Routes>
        </Suspense>
      </main>
    </>
  );
}
