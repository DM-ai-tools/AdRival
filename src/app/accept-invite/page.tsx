import { Suspense } from "react";
import AcceptInviteForm from "./AcceptInviteForm";

export default function AcceptInvitePage() {
  return (
    <Suspense
      fallback={
        <main className="page product-shell login-page">
          <div className="atmosphere" aria-hidden />
          <section className="login-card panel glow-panel">
            <p className="muted">Loading…</p>
          </section>
        </main>
      }
    >
      <AcceptInviteForm />
    </Suspense>
  );
}
