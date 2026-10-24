import { PublicShell } from "@/components/public-shell";
import { Button, Empty } from "@/components/ui";
export default function NotFound() {
  return (
    <PublicShell>
      <main id="main-content" className="py-20">
        <Empty
          title="A page out of place"
          description="This page could not be found. Let’s get you back to your workspace."
          action={<Button href="/app">Return to the studio</Button>}
        />
      </main>
    </PublicShell>
  );
}
