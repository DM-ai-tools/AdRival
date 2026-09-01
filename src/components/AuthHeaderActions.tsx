"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LogoutButton } from "@/components/LogoutButton";
import type { AppUserPublic } from "@/lib/types";

export function AuthHeaderActions() {
  const [user, setUser] = useState<AppUserPublic | null>(null);

  useEffect(() => {
    void fetch("/api/auth/status")
      .then((r) => r.json())
      .then((data: { authenticated?: boolean; user?: AppUserPublic | null }) => {
        setUser(data.authenticated && data.user ? data.user : null);
      })
      .catch(() => setUser(null));
  }, []);

  if (!user) return null;

  return (
    <div className="auth-header-actions">
      <Link href="/account" className="auth-user-link">
        {user.displayName}
      </Link>
      <LogoutButton />
    </div>
  );
}
