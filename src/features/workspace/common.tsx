"use client";
import Link from "next/link";
import { useState } from "react";
import { Link2, ArrowUpRight, ShieldCheck, Sparkles, Shirt } from "lucide-react";
import { Button, Dialog, Empty, Input, Notice, useToast } from "@/components/ui";
import { useWorkspace, apiRequest } from "./context";
import { providerDisclosure, type PublicProvider } from "./provider";
export function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}
export function SetupNotice() {
  const { data, loading } = useWorkspace();
  if (loading || data.configured) return null;
  return (
    <div className="workspace-banner">
      <Notice>
        This local workspace is waiting for Supabase configuration. You can explore the interface;
        uploads, account data, payments and generation require connected services.{" "}
        <Link href="/how-it-works">See the workflow</Link>.
      </Notice>
    </div>
  );
}
export function Onboarding() {
  const { data, refresh, loading } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const notify = useToast();
  if (!data.configured || data.organization || loading) return null;
  return (
    <section className="panel panel-padded mb-6">
      <span className="eyebrow mb-3">Welcome to Atelier AI</span>
      <h2 className="mb-3">Make this space yours.</h2>
      <p className="muted text-sm mb-5">
        Give your workspace a name. Your collection and campaigns will live here.
      </p>
      <form
        className="flex flex-wrap items-end gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          const form = new FormData(event.currentTarget);
          try {
            await apiRequest("/api/organizations", "POST", { name: form.get("name") });
            await refresh();
            notify("Your workspace is ready. Let’s add your first garment.");
          } catch (cause) {
            notify(cause instanceof Error ? cause.message : "Could not create workspace", true);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Input
          label="Studio or business name"
          name="name"
          required
          maxLength={100}
          placeholder="Your studio name"
        />
        <Button type="submit" busy={busy}>
          Create workspace <ArrowUpRight size={14} />
        </Button>
      </form>
    </section>
  );
}
export function ProtectedEmpty({
  title = "Your collection starts here",
  description = "Add your first garment to begin creating a campaign.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <Empty
      icon={<Shirt size={23} strokeWidth={1.3} />}
      title={title}
      description={description}
      action={
        <Button href="/app/garments">
          <Link2 size={14} />
          Open garment library
        </Button>
      }
    />
  );
}
export function AiDisclosure({
  video = false,
  provider,
}: {
  video?: boolean;
  provider?: PublicProvider | null;
}) {
  const { data } = useWorkspace();
  return (
    <div className="notice text-[10px]">
      <ShieldCheck size={14} />
      <div>
        {video
          ? "Fashion video uses an Experimental model. Motion is illustrative and does not prove real fabric behaviour."
          : `${providerDisclosure(provider === undefined ? data.provider : provider)} Check every output against your original garment before using it.`}
      </div>
    </div>
  );
}
export function NewWorkspaceButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Sparkles size={14} />
        Workspace help
      </Button>
      <Dialog
        title="Your creative workspace"
        description="Your organization keeps garments, credits and customers together."
        open={open}
        onOpenChange={setOpen}
      >
        <p className="muted text-sm">
          You can create your workspace after verifying your email. Workspace owners manage
          organization details and membership in Settings.
        </p>
      </Dialog>
    </>
  );
}
