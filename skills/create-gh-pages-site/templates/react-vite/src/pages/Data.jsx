import { useReducer, useEffect, useCallback } from "react";

// A loading/error/done state machine with useReducer — the idiomatic way to
// model async data in React without a library.
const initial = { status: "idle", items: [], error: null };

function reducer(state, action) {
  switch (action.type) {
    case "load":
      return { ...state, status: "loading", error: null };
    case "ok":
      return { status: "done", items: action.items, error: null };
    case "err":
      return { ...state, status: "error", error: action.error };
    default:
      return state;
  }
}

export default function Data() {
  const [state, dispatch] = useReducer(reducer, initial);

  const load = useCallback(async (url) => {
    dispatch({ type: "load" });
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      dispatch({ type: "ok", items: data.features || [] });
    } catch (err) {
      dispatch({ type: "err", error: err.message });
    }
  }, []);

  // `BASE_URL` resolves the public asset under the project base path.
  const dataUrl = `${import.meta.env.BASE_URL}data.json`;
  const badUrl = `${import.meta.env.BASE_URL}does-not-exist.json`;

  useEffect(() => {
    load(dataUrl);
  }, [load, dataUrl]);

  return (
    <>
      <header className="hero">
        <h1>Data fetching</h1>
        <p className="lede">A <code>useReducer</code> state machine over <code>fetch</code>.</p>
      </header>
      <section className="card">
        <div className="row">
          <button className="btn" onClick={() => load(dataUrl)}>Reload</button>
          <button className="btn btn-ghost" onClick={() => load(badUrl)}>Simulate error</button>
          <span className="muted">status: {state.status}</span>
        </div>

        {state.status === "loading" && (
          <div className="states">
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        )}
        {state.status === "error" && (
          <p className="callout-err">Couldn't load: {state.error}</p>
        )}
        {state.status === "done" && (
          <ul className="list">
            {state.items.map((f) => (
              <li key={f.name}>
                <b>{f.name}</b>
                {f.detail}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
