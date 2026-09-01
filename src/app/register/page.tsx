import { Suspense } from "react";
import RegisterForm from "./RegisterForm";

export default function RegisterPage() {
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
      <RegisterForm />
    </Suspense>
  );
}
