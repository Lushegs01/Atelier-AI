import { Suspense } from "react";
import BillingPage from "@/features/workspace/billing";
export default function Page() {
  return (
    <Suspense fallback={<div className="skeleton h-96" />}>
      <BillingPage credits />
    </Suspense>
  );
}
