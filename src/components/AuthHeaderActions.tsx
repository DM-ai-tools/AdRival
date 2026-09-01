"use client";

import { useEffect, useState } from "react";
import { LogoutButton } from "@/components/LogoutButton";

export function AuthHeaderActions() {
  const [showLogout, setShowLogout] = useState(false);

  useEffect(() => {
    void fetch("/api/auth/status")
      .then((r) => r.json())
      .then((data: { enabled?: boolean; authenticated?: boolean }) => {
        setShowLogout(Boolean(data.enabled && data.authenticated));
      })
      .catch(() => setShowLogout(false));
  }, []);

  if (!showLogout) return null;
  return <LogoutButton />;
}
