import { AppShell } from "@/components/app-shell";
export const dynamic = "force-dynamic";
export const metadata = { title: "Your studio", robots: { index: false, follow: false } };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
