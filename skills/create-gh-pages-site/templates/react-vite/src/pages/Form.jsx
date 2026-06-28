import { useState } from "react";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function Form() {
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const valid = EMAIL_RE.test(email);
  const showError = touched && !valid;

  function onSubmit(e) {
    e.preventDefault();
    setTouched(true);
    if (valid) setSubmitted(true);
  }

  return (
    <>
      <header className="hero">
        <h1>Controlled form</h1>
        <p className="lede">Controlled inputs with live validation — no form library.</p>
      </header>
      <section className="card">
        <form onSubmit={onSubmit} noValidate>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setSubmitted(false); }}
            onBlur={() => setTouched(true)}
            aria-invalid={showError || undefined}
            placeholder="you@example.com"
          />
          <p className="field-error" role="alert">
            {showError ? (email ? "That doesn't look like an email." : "Email is required.") : ""}
          </p>
          <button className="btn" type="submit">Subscribe</button>
          {submitted && valid && <p className="field-ok">Thanks — that's a valid email.</p>}
        </form>
      </section>
    </>
  );
}
