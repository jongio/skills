// Minimal progressive enhancement: stamp the current year in the footer.
// No framework, no build — this file is served as-is.
const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = String(new Date().getFullYear());
