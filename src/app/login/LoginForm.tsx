"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      router.replace(nextPath.startsWith("/") ? nextPath : "/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
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

        <p className="form-hint login-switch">
          No account yet?{" "}
          <Link href="/register" className="login-switch-link">
            Create an account
          </Link>
        </p>
      </section>
    </main>
  );
}
