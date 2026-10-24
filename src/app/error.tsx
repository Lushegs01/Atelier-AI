"use client";
import { Button, Empty } from "@/components/ui";
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main-content" className="max-w-xl mx-auto py-20">
      <Empty
        title="The studio needs a moment"
        description="We couldn’t load this page. Please try again. Your saved work is kept on the server."
        action={<Button onClick={reset}>Try again</Button>}
      />
    </main>
  );
}
