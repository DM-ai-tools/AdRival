"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LogoutButton } from "@/components/LogoutButton";
import { formatCredits } from "@/lib/accounting/units";
import { useCredits } from "@/lib/credits/useCredits";
import type { AppUserPublic } from "@/lib/types";

export function AuthHeaderActions() {
  const [user, setUser] = useState<AppUserPublic | null>(null);
  const credits = useCredits(30_000);

  useEffect(() => {
    void fetch("/api/auth/status")
      .then((r) => r.json())
      .then((data: { authenticated?: boolean; user?: AppUserPublic | null }) => {
        setUser(data.authenticated && data.user ? data.user : null);
      })
      .catch(() => setUser(null));
  }, []);

  if (!user) return null;

  const summary = credits.data?.credits ?? null;

  return (
    <div className="auth-header-actions">
      <Link
        href="/credits"
        className={
          summary?.lowCredit && !summary.unlimited
            ? "auth-credit-chip is-low"
            : "auth-credit-chip"
        }
        title="Credits & usage"
      >
        {summary
          ? summary.unlimited
            ? "Unlimited"
            : `${formatCredits(summary.availableSubunits)} credits`
          : "Credits"}
      </Link>
      {user.role === "admin" ? (
        <Link href="/admin" className="auth-user-link">
          Admin
        </Link>
      ) : null}
      <Link href="/account" className="auth-user-link">
        {user.displayName}
      </Link>
      <LogoutButton />
    </div>
  );
}
