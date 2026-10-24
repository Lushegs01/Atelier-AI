import { Suspense } from "react";
import Studio from "@/features/workspace/studio";
export default function Page() {
  return (
    <Suspense fallback={<div className="skeleton h-96" />}>
      <Studio />
    </Suspense>
  );
}
