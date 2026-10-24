import { GarmentDetail } from "@/features/workspace/garments";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GarmentDetail id={id} />;
}
