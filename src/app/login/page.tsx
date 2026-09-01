import { Suspense } from "react";
import LoginForm from "./LoginForm";

export default function LoginPage() {
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
      <LoginForm />
    </Suspense>
  );
}
