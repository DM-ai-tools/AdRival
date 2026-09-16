"use client";

import Link from "next/link";
import { useState } from "react";
import AdminAlerts from "./AdminAlerts";
import AdminOverview from "./AdminOverview";
import AdminProjects from "./AdminProjects";
import AdminSettings from "./AdminSettings";
import AdminUsage from "./AdminUsage";
import AdminUsers from "./AdminUsers";

type Tab = "overview" | "alerts" | "users" | "usage" | "projects" | "settings";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "alerts", label: "Alerts" },
  { id: "users", label: "Users" },
  { id: "usage", label: "Usage" },
  { id: "projects", label: "Client spaces" },
  { id: "settings", label: "Settings" },
];

export default function AdminDashboard() {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <main className="page product-shell admin-page">
      <div className="atmosphere" aria-hidden />

      <header className="product-header account-header">
        <div className="product-brand-block">
          <p className="brand">AdRival</p>
          <h1>Administration</h1>
          <p className="lede">
            Accounts, credit allowances, usage, and client spaces.
          </p>
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
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? <AdminOverview /> : null}
      {tab === "alerts" ? <AdminAlerts /> : null}
      {tab === "users" ? <AdminUsers /> : null}
      {tab === "usage" ? <AdminUsage /> : null}
      {tab === "projects" ? <AdminProjects /> : null}
      {tab === "settings" ? <AdminSettings /> : null}
    </main>
  );
}
