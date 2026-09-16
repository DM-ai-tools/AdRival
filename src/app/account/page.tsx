import { Suspense } from "react";
import AccountSettings from "./AccountSettings";

export default function AccountPage() {
  return (
    <Suspense
      fallback={
        <main className="page product-shell login-page">
          <div className="atmosphere" aria-hidden />
          <section className="login-card panel glow-panel">
            <p className="muted">Loading account…</p>
          </section>
        </main>
      }
    >
      <AccountSettings />
    </Suspense>
  );
}
