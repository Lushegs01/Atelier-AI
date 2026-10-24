import GuestTryOn from "@/features/try-on/guest-page";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "Your private try-on",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <GuestTryOn token={token} />;
}
