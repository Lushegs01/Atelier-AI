import { notFound } from "next/navigation";
import AdminPage from "@/features/admin/admin-page";
export const metadata = {
  title: "Platform administration",
  robots: { index: false, follow: false },
};
export default async function Page({ params }: { params: Promise<{ resource: string }> }) {
  const { resource } = await params;
  if (
    !["users", "organizations", "jobs", "payments", "providers", "pricing", "audit"].includes(
      resource,
    )
  )
    notFound();
  return <AdminPage resource={resource} />;
}
