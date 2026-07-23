import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page product-shell" style={{ paddingTop: 80 }}>
      <h1>Page not found</h1>
      <p className="lede">
        That route does not exist. <Link href="/">Return to AdRival</Link>
      </p>
    </main>
  );
}
