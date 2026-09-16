"use client";

import { useState } from "react";

export function LogoutButton() {
  const [loading, setLoading] = useState(false);

  async function logout() {
    setLoading(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      // Hard navigation, not router.replace: it discards the RSC cache and every
      // in-memory component state so the next account starts clean.
      window.location.replace("/login");
    }
  }

  return (
    <button
      type="button"
      className="ghost-btn logout-btn"
      disabled={loading}
      onClick={() => void logout()}
    >
      {loading ? "Signing out…" : "Sign out"}
    </button>
  );
}
