"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

interface Status {
  configured: boolean;
  needsBootstrap: boolean;
}

/**
 * First-admin setup. The token itself lives only in the server environment
 * (ADMIN_BOOTSTRAP_TOKEN); this page just carries it to the API once.
 */
export default function BootstrapForm() {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    message: string;
    temporaryPassword?: string;
  } | null>(null);

  useEffect(() => {
    void fetch("/api/admin/bootstrap", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: Status) => setStatus(data))
      .catch(() => setStatus({ configured: false, needsBootstrap: false }));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const res = await fetch("/api/admin/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.message || data.error || "Bootstrap failed");
      }
      setResult({
        message: data.message,
        temporaryPassword: data.temporaryPassword,
      });
      setToken("");
      setStatus({ configured: true, needsBootstrap: false });
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
          <h1>First-admin setup</h1>
          <p className="lede">
            Runs once, before any administrator exists. Set{" "}
            <code>ADMIN_BOOTSTRAP_TOKEN</code> and{" "}
            <code>ADMIN_BOOTSTRAP_USERNAME</code> on the server, then paste the
            token here.
          </p>
        </header>

        {status === null ? (
          <p className="muted">Checking setup state…</p>
        ) : !status.needsBootstrap ? (
          <>
            <p className="form-hint">
              An administrator already exists, so bootstrap is disabled. Remove{" "}
              <code>ADMIN_BOOTSTRAP_TOKEN</code> from the environment.
            </p>
            {result ? (
              <>
                <p className="credits-pending">{result.message}</p>
                {result.temporaryPassword ? (
                  <p className="admin-secret-note">
                    Temporary password: {result.temporaryPassword}
                    <br />
                    Shown once. Sign in and change it immediately.
                  </p>
                ) : null}
              </>
            ) : null}
            <p className="form-hint login-switch">
              <Link href="/login" className="login-switch-link">
                Go to sign in
              </Link>
            </p>
          </>
        ) : !status.configured ? (
          <p className="credits-warning" role="alert">
            Bootstrap is not configured on this deployment. Set{" "}
            <code>ADMIN_BOOTSTRAP_TOKEN</code> and{" "}
            <code>ADMIN_BOOTSTRAP_USERNAME</code>, restart, then reload this
            page.
          </p>
        ) : (
          <form
            className="search-form login-form"
            onSubmit={(e) => void submit(e)}
          >
            <label htmlFor="token" className="search-label">
              Bootstrap token
            </label>
            <input
              id="token"
              type="password"
              className="search-input"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
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
                disabled={loading || !token.trim()}
              >
                {loading ? "Creating administrator…" : "Create administrator"}
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
