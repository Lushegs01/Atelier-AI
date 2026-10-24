import AdminPage from "@/features/admin/admin-page";
export const metadata = {
  title: "Platform administration",
  robots: { index: false, follow: false },
};
export default function Page() {
  return <AdminPage resource="overview" />;
}
