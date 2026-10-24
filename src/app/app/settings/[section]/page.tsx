import { notFound } from "next/navigation";
import SettingsPage from "@/features/workspace/settings";
export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!["profile", "organization", "brand", "security", "privacy"].includes(section)) notFound();
  return <SettingsPage section={section} />;
}
