"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

export default function LoginForm() {
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signupEnabled, setSignupEnabled] = useState<boolean | null>(null);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);

  useEffect(() => {
    void fetch("/api/auth/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { publicSignupEnabled?: boolean; needsBootstrap?: boolean }) => {
        setSignupEnabled(Boolean(data.publicSignupEnabled));
        setNeedsBootstrap(Boolean(data.needsBootstrap));
      })
      .catch(() => setSignupEnabled(false));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Login failed");
      }
      const target = data.mustChangePassword
        ? "/account?mustChangePassword=1"
        : nextPath.startsWith("/")
          ? nextPath
          : "/";
      // Hard navigation so no state from a previously signed-in account survives.
      window.location.replace(target);
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
          <h1>Sign in</h1>
          <p className="lede">
            Sign in with your username and password to access competitive ad
            intelligence.
          </p>
        </header>

        <form
          className="search-form login-form"
          onSubmit={(e) => void handleSubmit(e)}
        >
          <label htmlFor="username" className="search-label">
            Username
          </label>
          <input
            id="username"
            type="text"
            className="search-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="your_username"
            autoComplete="username"
            autoFocus
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
            placeholder="Your password"
            autoComplete="current-password"
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
              disabled={loading || !username.trim() || !password}
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>

        {needsBootstrap ? (
          <p className="form-hint login-switch">
            No administrator exists yet.{" "}
            <Link href="/setup" className="login-switch-link">
              Run first-admin setup
            </Link>
          </p>
        ) : signupEnabled ? (
          <p className="form-hint login-switch">
            No account yet?{" "}
            <Link href="/register" className="login-switch-link">
              Create an account
            </Link>
          </p>
        ) : signupEnabled === false ? (
          <p className="form-hint login-switch">
            Public signup is disabled. Ask your administrator for an account.
          </p>
        ) : null}
      </section>
    </main>
  );
}
