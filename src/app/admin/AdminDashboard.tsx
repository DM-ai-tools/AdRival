"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AdminAlerts from "./AdminAlerts";
import AdminAudit from "./AdminAudit";
import AdminOverview from "./AdminOverview";
import AdminProjects from "./AdminProjects";
import AdminRuns from "./AdminRuns";
import AdminSettings from "./AdminSettings";
import AdminUsage from "./AdminUsage";
import AdminUsers from "./AdminUsers";
import { adminFetch } from "./adminUi";

type Tab = "overview" | "alerts" | "users" | "runs" | "usage" | "projects" | "audit" | "settings";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "alerts", label: "Alerts" },
  { id: "users", label: "Users" },
  { id: "runs", label: "Runs" },
  { id: "usage", label: "Usage" },
  { id: "projects", label: "Client spaces" },
  { id: "audit", label: "Audit log" },
  { id: "settings", label: "Settings" },
];

function readUrl(): { tab: Tab; user: string | null } {
  if (typeof window === "undefined") return { tab: "overview", user: null };
  const p = new URLSearchParams(window.location.search);
  const tab = p.get("tab") as Tab | null;
  return {
    tab: tab && TABS.some((t) => t.id === tab) ? tab : "overview",
    user: p.get("user"),
  };
}

export default function AdminDashboard() {
  const [tab, setTab] = useState<Tab>("overview");
  const [openUser, setOpenUser] = useState<string | null>(null);
  const [alertCount, setAlertCount] = useState<number | null>(null);

  // The tab (and an open user) live in the address, so refresh, Back and
  // shared links return to the same place.
  useEffect(() => {
    const apply = () => {
      const { tab: t, user } = readUrl();
      setTab(t);
      setOpenUser(user);
    };
    apply();
    window.addEventListener("popstate", apply);
    return () => window.removeEventListener("popstate", apply);
  }, []);

  const go = useCallback((next: Tab, user: string | null = null) => {
    setTab(next);
    setOpenUser(user);
    const p = new URLSearchParams({ tab: next });
    if (user) p.set("user", user);
    window.history.pushState(null, "", `?${p}`);
  }, []);

  const refreshAlerts = useCallback(() => {
    void adminFetch<{ counts?: { open: number } }>("/api/admin/alerts")
      .then((d) => setAlertCount(d.counts?.open ?? null))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshAlerts();
    const t = setInterval(refreshAlerts, 60_000);
    return () => clearInterval(t);
  }, [refreshAlerts]);

  const showUser = useCallback((userId: string) => go("users", userId), [go]);

  return (
    <main className="page product-shell admin-page">
      <div className="atmosphere" aria-hidden />

      <header className="product-header account-header">
        <div className="product-brand-block">
          <p className="brand">AdRival</p>
          <h1>Administration</h1>
          <p className="lede">Accounts, credit allowances, runs, usage, and client spaces.</p>
        </div>
        <div className="header-link-row">
          <Link href="/credits" className="ghost-btn">
            My credits
          </Link>
          <Link href="/" className="ghost-btn">
            Back to app
          </Link>
        </div>
      </header>

      <div className="tab-bar tab-bar-wide admin-tab-bar" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab-btn ${tab === t.id ? "active" : ""}`}
            onClick={() => go(t.id)}
          >
            {t.label}
            {t.id === "alerts" && alertCount ? (
              <span className="admin-tab-badge" aria-label={`${alertCount} open`}>
                {alertCount}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "overview" ? <AdminOverview onOpenUser={showUser} /> : null}
      {tab === "alerts" ? <AdminAlerts onOpenUser={showUser} onChanged={refreshAlerts} /> : null}
      {tab === "users" ? <AdminUsers key={openUser ?? "list"} initialUserId={openUser} /> : null}
      {tab === "runs" ? <AdminRuns onOpenUser={showUser} /> : null}
      {tab === "usage" ? <AdminUsage onOpenUser={showUser} /> : null}
      {tab === "projects" ? <AdminProjects /> : null}
      {tab === "audit" ? <AdminAudit onOpenUser={showUser} /> : null}
      {tab === "settings" ? <AdminSettings /> : null}
    </main>
  );
}
