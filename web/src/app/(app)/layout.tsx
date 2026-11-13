// Route group layout for the dashboard (/overview, /mandates, /attack)
// Source: https://nextjs.org/docs/app/api-reference/file-conventions/route-groups
import { DashShell } from "@/components/DashShell";

export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return <DashShell>{children}</DashShell>;
}
