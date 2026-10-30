// Route group layout for the dashboard (/overview, /mandates, /attack)
// Source: https://nextjs.org/docs/app/api-reference/file-conventions/route-groups
import { Suspense } from "react";
import { Nav } from "@/components/Nav";

export default function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="blueprint-grid bp-app-shell">
      <Suspense fallback={<header className="bp-app-nav" style={{ height: "3.75rem" }} />}>
        <Nav />
      </Suspense>
      <main className="bp-app-main">{children}</main>
    </div>
  );
}
