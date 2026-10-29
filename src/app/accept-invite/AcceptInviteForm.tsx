"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

export default function AcceptInviteForm() {
  const token = useSearchParams().get("token") ?? "";
  const [who, setWho] = useState<{ displayName: string; username: string } | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    void fetch(`/api/auth/accept-invite?token=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "This invitation link is not valid.");
        setWho(data);
      })
      .catch((err) => setInvalid((err as Error).message));
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/accept-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password, confirmPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not accept the invitation");
      setDone(true);
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
          <h1>{done ? "You're all set" : "Accept your invitation"}</h1>
          {who && !done ? (
            <p className="lede">
              Welcome, {who.displayName}. Choose a password for your account. Your username is{" "}
              <strong>{who.username}</strong>.
            </p>
          ) : null}
        </header>

        {invalid ? (
          <p className="credits-warning" role="alert">
            {invalid}
          </p>
        ) : done ? (
          <>
            <p className="lede">Your password is saved. Sign in as {who?.username} to get started.</p>
            <Link href="/login" className="search-btn">
              Go to sign in
            </Link>
          </>
        ) : who ? (
          <form className="search-form login-form" onSubmit={(e) => void handleSubmit(e)}>
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
              autoFocus
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
              autoComplete="new-password"
              required
              disabled={loading}
            />
            {error ? (
              <p className="error-text" role="alert">
                {error}
              </p>
            ) : null}
            <button type="submit" className="search-btn" disabled={loading}>
              {loading ? "Saving…" : "Accept and set password"}
            </button>
          </form>
        ) : (
          <p className="muted">Checking your invitation…</p>
        )}
      </section>
    </main>
  );
}
