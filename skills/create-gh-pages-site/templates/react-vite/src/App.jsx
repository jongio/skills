import { Routes, Route, Link } from "react-router-dom";
import Home from "./pages/Home.jsx";
import About from "./pages/About.jsx";

export default function App() {
  return (
    <div className="wrap">
      <nav>
        <Link to="/">Home</Link>
        <Link to="/about">About</Link>
      </nav>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
        {/* Unknown client routes fall back to Home. The 404.html copy
            (see copy-404.mjs) lets GitHub Pages hand deep links to the SPA. */}
        <Route path="*" element={<Home />} />
      </Routes>
    </div>
  );
}
