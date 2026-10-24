import { GenerationDetail } from "@/features/workspace/gallery";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GenerationDetail id={id} />;
}
