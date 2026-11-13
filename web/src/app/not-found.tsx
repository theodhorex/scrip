import Link from "next/link";
import { DashShell } from "@/components/DashShell";

export default function NotFound() {
  return (
    <DashShell center>
      <p className="nl-idx"><span>404</span><span>NOT_FOUND</span></p>
      <h1 className="nl-dash-h1">This page isn&apos;t in the mandate.</h1>
      <p className="nl-lede">The page you asked for does not exist or has moved.</p>
      <div className="nl-dash-actions">
        <Link href="/" className="bp-btn bp-btn-primary">Back to the landing</Link>
        <Link href="/overview" className="bp-btn bp-btn-secondary">Open the dashboard</Link>
      </div>
    </DashShell>
  );
}
