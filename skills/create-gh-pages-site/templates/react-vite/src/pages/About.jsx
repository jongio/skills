export default function About() {
  return (
    <section className="prose">
      <h1>About</h1>
      <p>
        This route lives at <code>/about</code> on a user site and
        <code> /REPO/about</code> on a project site. Refreshing it works because
        the build copies <code>index.html</code> to <code>404.html</code>, so
        GitHub Pages serves the SPA for unknown paths and React Router takes over.
      </p>
      <p>Edit <code>src/pages/</code> and add routes in <code>src/App.jsx</code>.</p>
    </section>
  );
}
