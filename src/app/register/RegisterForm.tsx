"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

export default function RegisterForm() {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signupEnabled, setSignupEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    void fetch("/api/auth/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { publicSignupEnabled?: boolean }) =>
        setSignupEnabled(Boolean(data.publicSignupEnabled)),
      )
      .catch(() => setSignupEnabled(false));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          username,
          password,
          confirmPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Registration failed");
      }
      // Hard navigation so no state from a previous account survives.
      window.location.replace("/");
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <main className="page product-shell login-page">
      <div className="atmosphere" aria-hidden />

      <section className="login-card panel glow-panel">
        <header className="login-card-head">
          <p className="brand">AdRival</p>
          <h1>Create account</h1>
          <p className="lede">
            Choose a display name, username, and password. Your account is
            stored securely in the app database.
          </p>
        </header>

        {signupEnabled === false ? (
          <p className="credits-warning" role="alert">
            Public signup is currently disabled. Ask your administrator to
            create an account for you.
          </p>
        ) : null}

        <form
          className="search-form login-form"
          onSubmit={(e) => void handleSubmit(e)}
        >
          <label htmlFor="displayName" className="search-label">
            Your name
          </label>
          <input
            id="displayName"
            type="text"
            className="search-input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Rithin"
            autoComplete="name"
            autoFocus
            required
            disabled={loading}
          />

          <label htmlFor="username" className="search-label">
            Username
          </label>
          <input
            id="username"
            type="text"
            className="search-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="letters, numbers, underscores"
            autoComplete="username"
            required
            disabled={loading}
          />

          <label htmlFor="password" className="search-label">
            Password
          </label>
          <input
            id="password"
            type="password"
            className="search-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            required
            disabled={loading}
          />

          <label htmlFor="confirmPassword" className="search-label">
            Confirm password
          </label>
          <input
            id="confirmPassword"
            type="password"
            className="search-input"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Repeat password"
            autoComplete="new-password"
            required
            disabled={loading}
          />

          {error ? (
            <p className="error-text" role="alert">
              {error}
            </p>
          ) : null}

          <div className="search-row" style={{ marginTop: 12 }}>
            <button
              type="submit"
              className="search-btn login-submit"
              disabled={
                loading ||
                signupEnabled === false ||
                !displayName.trim() ||
                !username.trim() ||
                !password ||
                !confirmPassword
              }
            >
              {loading ? "Creating account…" : "Create account"}
            </button>
          </div>
        </form>

        <p className="form-hint login-switch">
          Already have an account?{" "}
          <Link href="/login" className="login-switch-link">
            Sign in
          </Link>
        </p>
      </section>
    </main>
  );
}
