import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen blueprint-grid text-bp-ink flex items-center justify-center px-6 text-center">
      <div>
        <p className="font-mono text-xs uppercase tracking-wider text-bp-reject">404 · NOT_FOUND</p>
        <h1 className="mt-4 font-serif text-5xl md:text-6xl tracking-tight">This page isn&apos;t in the mandate.</h1>
        <p className="mt-4 font-mono text-sm text-bp-muted">The page you asked for does not exist or has moved.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-4">
          <Link href="/" className="bp-btn bp-btn-primary">Back to the landing</Link>
          <Link href="/overview" className="bp-btn bp-btn-secondary">Open the dashboard</Link>
        </div>
      </div>
    </main>
  );
}
