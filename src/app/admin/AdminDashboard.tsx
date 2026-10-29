"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AdminAlerts from "./AdminAlerts";
import AdminAudit from "./AdminAudit";
import AdminOrgs from "./AdminOrgs";
import AdminOverview from "./AdminOverview";
import AdminProjects from "./AdminProjects";
import AdminRuns from "./AdminRuns";
import AdminSettings from "./AdminSettings";
import AdminUsage from "./AdminUsage";
import AdminUsers from "./AdminUsers";
import { adminFetch } from "./adminUi";

type Tab = "overview" | "alerts" | "users" | "runs" | "usage" | "projects" | "audit" | "orgs" | "settings";

/** platformOnly views are hidden from a client organisation's admins. */
const VIEWS: Array<{ id: Tab; label: string; platformOnly?: boolean }> = [
  { id: "overview", label: "Overview" },
  { id: "alerts", label: "Alerts" },
  { id: "users", label: "Users" },
  { id: "orgs", label: "Organisations", platformOnly: true },
  { id: "runs", label: "Runs" },
  { id: "usage", label: "Usage" },
  { id: "audit", label: "Audit log" },
  { id: "projects", label: "Client spaces" },
  { id: "settings", label: "Settings", platformOnly: true },
];

/** The top bar: related views share one entry and switch with the small pills under it. */
const NAV: Array<{ label: string; views: Tab[] }> = [
  { label: "Overview", views: ["overview"] },
  { label: "Alerts", views: ["alerts"] },
  { label: "People", views: ["users", "orgs"] },
  { label: "Activity", views: ["runs", "usage", "audit"] },
  { label: "Client spaces", views: ["projects"] },
  { label: "Settings", views: ["settings"] },
];

function readUrl(): { tab: Tab; user: string | null } {
  if (typeof window === "undefined") return { tab: "overview", user: null };
  const p = new URLSearchParams(window.location.search);
  const tab = p.get("tab") as Tab | null;
  return {
    tab: tab && VIEWS.some((t) => t.id === tab) ? tab : "overview",
    user: p.get("user"),
  };
}

export default function AdminDashboard() {
  const [tab, setTab] = useState<Tab>("overview");
  const [openUser, setOpenUser] = useState<string | null>(null);
  const [alertCount, setAlertCount] = useState<number | null>(null);
  // Until we know, show only the tabs every admin has.
  const [me, setMe] = useState<{ platformAdmin: boolean; orgName: string | null } | null>(null);

  useEffect(() => {
    void adminFetch<{ platformAdmin?: boolean; orgName?: string | null }>("/api/auth/me")
      .then((d) => setMe({ platformAdmin: Boolean(d.platformAdmin), orgName: d.orgName ?? null }))
      .catch(() => setMe({ platformAdmin: false, orgName: null }));
  }, []);
  const visible = new Set(VIEWS.filter((v) => !v.platformOnly || me?.platformAdmin).map((v) => v.id));
  const nav = NAV.map((n) => ({ ...n, views: n.views.filter((v) => visible.has(v)) })).filter((n) => n.views.length);
  const group = nav.find((n) => n.views.includes(tab));

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
          <h1>Administration{me?.orgName ? ` · ${me.orgName}` : ""}</h1>
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
        {nav.map((n) => (
          <button
            key={n.label}
            type="button"
            role="tab"
            aria-selected={group === n}
            className={`tab-btn ${group === n ? "active" : ""}`}
            onClick={() => go(group === n ? tab : n.views[0])}
          >
            {n.label}
            {n.views.includes("alerts") && alertCount ? (
              <span className="admin-tab-badge" aria-label={`${alertCount} open`}>
                {alertCount}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {group && group.views.length > 1 ? (
        <div className="admin-subnav" role="tablist" aria-label={group.label}>
          {group.views.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={tab === v}
              className={`chip-btn ${tab === v ? "active" : ""}`}
              onClick={() => go(v)}
            >
              {VIEWS.find((x) => x.id === v)?.label}
            </button>
          ))}
        </div>
      ) : null}

      {tab === "overview" ? <AdminOverview onOpenUser={showUser} /> : null}
      {tab === "alerts" ? <AdminAlerts onOpenUser={showUser} onChanged={refreshAlerts} /> : null}
      {tab === "users" ? <AdminUsers key={openUser ?? "list"} initialUserId={openUser} /> : null}
      {tab === "runs" ? <AdminRuns onOpenUser={showUser} /> : null}
      {tab === "usage" ? <AdminUsage onOpenUser={showUser} /> : null}
      {tab === "projects" ? <AdminProjects /> : null}
      {tab === "audit" ? <AdminAudit onOpenUser={showUser} /> : null}
      {tab === "orgs" && me?.platformAdmin ? <AdminOrgs onOpenUser={showUser} /> : null}
      {tab === "settings" && me?.platformAdmin ? <AdminSettings /> : null}
    </main>
  );
}
