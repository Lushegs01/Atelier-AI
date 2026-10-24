import { Suspense } from "react";
import { GarmentsPage } from "@/features/workspace/garments";
export default function Page() {
  return (
    <Suspense fallback={<div className="skeleton h-96" />}>
      <GarmentsPage />
    </Suspense>
  );
}
