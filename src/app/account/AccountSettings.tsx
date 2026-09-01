"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AppUserPublic } from "@/lib/types";

export default function AccountSettings() {
  const router = useRouter();
  const [user, setUser] = useState<AppUserPublic | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/auth/me")
      .then((r) => r.json())
      .then((data: { user?: AppUserPublic }) => {
        if (!data.user) {
          router.replace("/login");
          return;
        }
        setUser(data.user);
        setDisplayName(data.user.displayName);
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setProfileError(null);
    setProfileSuccess(null);
    setProfileLoading(true);
    try {
      const res = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update profile");
      setUser(data.user);
      setProfileSuccess("Name updated.");
      router.refresh();
    } catch (err) {
      setProfileError((err as Error).message);
    } finally {
      setProfileLoading(false);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(null);
    setPasswordLoading(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          confirmPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to change password");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordSuccess("Password updated.");
    } catch (err) {
      setPasswordError((err as Error).message);
    } finally {
      setPasswordLoading(false);
    }
  }

  if (!user) {
    return (
      <main className="page product-shell login-page">
        <div className="atmosphere" aria-hidden />
        <section className="login-card panel glow-panel">
          <p className="muted">Loading account…</p>
        </section>
      </main>
    );
  }

  return (
    <main className="page product-shell account-page">
      <div className="atmosphere" aria-hidden />

      <header className="product-header account-header">
        <div className="product-brand-block">
          <p className="brand">AdRival</p>
          <h1>Account settings</h1>
          <p className="lede">
            Signed in as <strong>@{user.username}</strong>
          </p>
        </div>
        <Link href="/" className="ghost-btn">
          Back to app
        </Link>
      </header>

      <div className="account-grid">
        <section className="panel glow-panel account-panel">
          <h2>Profile</h2>
          <form className="search-form" onSubmit={(e) => void saveProfile(e)}>
            <label htmlFor="displayName" className="search-label">
              Display name
            </label>
            <input
              id="displayName"
              type="text"
              className="search-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              disabled={profileLoading}
            />
            {profileError ? (
              <p className="error-text" role="alert">
                {profileError}
              </p>
            ) : null}
            {profileSuccess ? (
              <p className="form-hint">{profileSuccess}</p>
            ) : null}
            <div className="search-row" style={{ marginTop: 12 }}>
              <button
                type="submit"
                className="search-btn"
                disabled={profileLoading || !displayName.trim()}
              >
                {profileLoading ? "Saving…" : "Save name"}
              </button>
            </div>
          </form>
        </section>

        <section className="panel glow-panel account-panel">
          <h2>Change password</h2>
          <form className="search-form" onSubmit={(e) => void changePassword(e)}>
            <label htmlFor="currentPassword" className="search-label">
              Current password
            </label>
            <input
              id="currentPassword"
              type="password"
              className="search-input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
              disabled={passwordLoading}
            />

            <label htmlFor="newPassword" className="search-label">
              New password
            </label>
            <input
              id="newPassword"
              type="password"
              className="search-input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
              disabled={passwordLoading}
            />

            <label htmlFor="confirmPassword" className="search-label">
              Confirm new password
            </label>
            <input
              id="confirmPassword"
              type="password"
              className="search-input"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
              disabled={passwordLoading}
            />

            {passwordError ? (
              <p className="error-text" role="alert">
                {passwordError}
              </p>
            ) : null}
            {passwordSuccess ? (
              <p className="form-hint">{passwordSuccess}</p>
            ) : null}

            <div className="search-row" style={{ marginTop: 12 }}>
              <button
                type="submit"
                className="search-btn"
                disabled={
                  passwordLoading ||
                  !currentPassword ||
                  !newPassword ||
                  !confirmPassword
                }
              >
                {passwordLoading ? "Updating…" : "Update password"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
