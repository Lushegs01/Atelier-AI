"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Camera,
  Film,
  Download,
  Check,
  X,
  ArrowUpRight,
  Sparkles,
  Trash2,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { Badge, Button, Dialog, Empty, Notice, useToast } from "@/components/ui";
import { useWorkspace, apiRequest, type Job, type Output } from "./context";
import { PageHeading, SetupNotice, AiDisclosure } from "./common";
import { dateLabel } from "@/lib/utils";
export async function downloadMedia(url: string, name: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("The download link expired. Refresh the page and try again.");
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
}
export function GalleryPage({ photos = false }: { photos?: boolean }) {
  const { data, loading } = useWorkspace();
  const [type, setType] = useState(photos ? "photo" : "all");
  const notify = useToast();
  const outputs = data.outputs.filter(
    (o) =>
      type === "all" ||
      (type === "video"
        ? o.asset?.kind === "generated_video"
        : o.asset?.kind !== "generated_video"),
  );
  return (
    <>
      <PageHeading
        title={photos ? "Your model photography" : "A collection of possibilities."}
        description={
          photos
            ? "Every angle, every setting. Your model photographs live here."
            : "The photographs and films you create, kept in one private place."
        }
        action={
          <Button href="/app/studio">
            <Camera size={15} />
            Create a photoshoot
          </Button>
        }
      />
      <SetupNotice />
      <div className="toolbar">
        <div className="chip-list">
          {(photos ? ["photo"] : ["all", "photo", "video"]).map((t) => (
            <button
              key={t}
              className="chip capitalize"
              aria-pressed={type === t}
              onClick={() => setType(t)}
            >
              {t === "all" ? "All content" : t === "photo" ? "Photographs" : "Fashion films"}
            </button>
          ))}
        </div>
        <p className="text-[10px] muted flex items-center gap-2">
          <SlidersHorizontal size={12} />
          Most recent first · {outputs.length} items on this page
        </p>
      </div>
      {loading ? (
        <div className="asset-grid">
          {[1, 2, 3].map((i) => (
            <div className="skeleton skeleton-card" key={i} />
          ))}
        </div>
      ) : outputs.length ? (
        <div className="asset-grid">
          {outputs.map((output, i) => (
            <article key={output.id} className="asset-card panel">
              <Link href={`/app/generations/${output.job_id}`} className="asset-image">
                {output.url ? (
                  output.asset?.kind === "generated_video" ? (
                    <video
                      src={output.url}
                      preload="metadata"
                      muted
                      playsInline
                      aria-label="Fashion film preview"
                    />
                  ) : (
                    <img
                      src={output.url}
                      alt={`Generated campaign photograph ${i + 1}`}
                      loading="lazy"
                    />
                  )
                ) : (
                  <Camera size={24} />
                )}
              </Link>
              <div className="asset-info">
                <h3>
                  {output.asset?.kind === "generated_video"
                    ? "Fashion film"
                    : "Campaign photograph"}
                </h3>
                <small>
                  {output.created_at ? dateLabel(output.created_at) : "Private campaign asset"}
                </small>
                <div className="button-row">
                  <Button
                    href={`/app/generations/${output.job_id}`}
                    variant="secondary"
                    size="small"
                  >
                    Review <ArrowUpRight size={12} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="small"
                    aria-label="Download output"
                    onClick={async () => {
                      try {
                        if (!output.url) throw new Error("Refresh to get a new download link.");
                        await downloadMedia(
                          output.url,
                          `atelier-${output.id}.${output.asset?.kind === "generated_video" ? "mp4" : "png"}`,
                        );
                      } catch (c) {
                        notify(c instanceof Error ? c.message : "Download failed", true);
                      }
                    }}
                  >
                    <Download size={14} />
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            title={photos ? "Your first shoot is waiting" : "Your work deserves a gallery"}
            description="Completed photographs and films appear here. Your original garment photos stay in the garment library."
            icon={
              type === "video" ? (
                <Film size={24} strokeWidth={1.3} />
              ) : (
                <Camera size={24} strokeWidth={1.3} />
              )
            }
            action={
              <Button href={type === "video" ? "/app/videos" : "/app/studio"} variant="secondary">
                {type === "video" ? "Create a fashion film" : "Create your first photoshoot"}
                <ArrowUpRight size={14} />
              </Button>
            }
          />
        </div>
      )}
      {data.jobs.length > 0 && (
        <section className="panel panel-padded mt-7">
          <div className="panel-heading">
            <h2>Generation history</h2>
            <span className="eyebrow">{data.jobs.length} recent jobs</span>
          </div>
          {data.jobs
            .filter((j) => !photos || j.operation === "photo")
            .map((job) => (
              <Link key={job.id} href={`/app/generations/${job.id}`} className="job-item">
                <span className="mini-icon">
                  {job.operation === "video" ? <Film size={15} /> : <Camera size={15} />}
                </span>
                <div>
                  <h3 className="capitalize">{job.operation.replaceAll("_", " ")} generation</h3>
                  <p>
                    {dateLabel(job.created_at)} · {job.estimated_credits || 0} credits reserved
                  </p>
                </div>
                <Badge
                  tone={
                    job.status === "succeeded"
                      ? "success"
                      : job.status === "failed"
                        ? "error"
                        : "default"
                  }
                >
                  {job.status.replaceAll("_", " ")}
                </Badge>
                <ArrowUpRight size={14} className="muted" />
              </Link>
            ))}
        </section>
      )}
    </>
  );
}
type DetailOutput = Output & { approved_at?: string; rejected_at?: string };
export function GenerationDetail({ id }: { id: string }) {
  const { data, refresh } = useWorkspace();
  const [job, setJob] = useState<Job | null>(null);
  const [outputs, setOutputs] = useState<DetailOutput[]>([]);
  const [error, setError] = useState("");
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const notify = useToast();
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/generations/${id}`, { cache: "no-store" });
        const next = await res.json();
        if (!res.ok) throw new Error(next.error);
        if (active) {
          setJob(next.job);
          setOutputs(next.outputs || []);
          setError("");
        }
      } catch (c) {
        if (active) setError(c instanceof Error ? c.message : "Could not load job.");
      }
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 8000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id]);
  const active = job && ["queued", "submitting", "processing", "retry_wait"].includes(job.status);
  const original = data.garments.find(
    (g) => g.id === data.jobs.find((j) => j.id === id)?.garment_id,
  );
  async function review(outputId: string, approved: boolean) {
    try {
      const result = await apiRequest<{ output: DetailOutput }>(`/api/generations/${id}`, "PATCH", {
        outputId,
        approved,
      });
      setOutputs(outputs.map((o) => (o.id === outputId ? { ...o, ...result.output } : o)));
      notify(
        approved
          ? "Photograph approved. It’s ready for your next campaign."
          : "Output marked for review. A new generation is charged separately.",
      );
      await refresh();
    } catch (c) {
      notify(c instanceof Error ? c.message : "Review failed", true);
    }
  }
  return (
    <>
      <PageHeading
        title={job?.operation === "video" ? "A collection, in motion." : "Your new perspective."}
        description={
          job
            ? `Created ${dateLabel(job.created_at)} · ${job.estimated_credits || 0} credits estimated`
            : "Loading generation details…"
        }
        action={
          job && (
            <Badge
              tone={
                job.status === "succeeded"
                  ? "success"
                  : job.status === "failed"
                    ? "error"
                    : "default"
              }
            >
              {job.status.replaceAll("_", " ")}
            </Badge>
          )
        }
      />
      {error && <Notice tone="error">{error}</Notice>}
      {active && (
        <div className="panel panel-padded mb-6">
          <div className="flex gap-4 items-center">
            <div className="mini-icon">
              <Sparkles size={21} />
            </div>
            <div>
              <h2 className="text-xl">
                {job.status === "queued"
                  ? "Your idea is in the queue."
                  : job.status === "retry_wait"
                    ? "We’re checking the provider’s progress."
                    : "A little creative work is happening."}
              </h2>
              <p className="muted text-xs mt-2">
                You can close this page. The generation continues securely on the server.
              </p>
            </div>
          </div>
          <div className="progress-track">
            <span />
          </div>
          <p className="muted text-[10px]">
            Current state: {job.status.replaceAll("_", " ")} · This page refreshes every eight
            seconds.
          </p>
        </div>
      )}
      {job?.status === "failed" && (
        <div className="mb-6">
          <Notice tone="error">
            This generation could not be completed. Eligible reserved credits are released
            automatically. <Link href="/app/credits">Review your credit ledger</Link>.
          </Notice>
        </div>
      )}
      {outputs.length ? (
        <>
          <div className="grid md:grid-cols-2 gap-6">
            {original?.imageUrl && (
              <div className="panel overflow-hidden">
                <div className="p-4 flex items-center justify-between">
                  <span className="eyebrow">Original garment</span>
                  <Badge>Source of truth</Badge>
                </div>
                <div className="asset-image !aspect-[3/4]">
                  <img src={original.imageUrl} alt="Original garment for comparison" />
                </div>
              </div>
            )}
            {outputs.map((output) => (
              <article className="panel overflow-hidden" key={output.id}>
                <div className="p-4 flex items-center justify-between">
                  <span className="eyebrow">Generated result</span>
                  {output.approved_at ? (
                    <Badge tone="success">Approved</Badge>
                  ) : output.rejected_at ? (
                    <Badge tone="warning">Needs review</Badge>
                  ) : (
                    <Badge>Awaiting your review</Badge>
                  )}
                </div>
                <div className="asset-image !aspect-[3/4]">
                  {output.url ? (
                    job?.operation === "video" ? (
                      <video
                        controls
                        playsInline
                        preload="metadata"
                        src={output.url}
                        className="w-full h-full"
                      />
                    ) : (
                      <img src={output.url} alt="AI generated result to compare with original" />
                    )
                  ) : (
                    <Camera size={35} />
                  )}
                </div>
                <div className="p-5">
                  <div className="button-row">
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => review(output.id, true)}
                    >
                      <Check size={14} />
                      Approve
                    </Button>
                    <Button variant="ghost" size="small" onClick={() => review(output.id, false)}>
                      <X size={14} />
                      Needs review
                    </Button>
                    <Button
                      variant="ghost"
                      size="small"
                      aria-label="Download result"
                      onClick={async () => {
                        try {
                          if (!output.url) throw new Error("Refresh to retrieve the output.");
                          await downloadMedia(
                            output.url,
                            `atelier-${output.id}.${job?.operation === "video" ? "mp4" : "png"}`,
                          );
                        } catch (c) {
                          notify(c instanceof Error ? c.message : "Download failed", true);
                        }
                      }}
                    >
                      <Download size={14} />
                    </Button>
                  </div>
                  {job?.operation !== "video" && output.approved_at && (
                    <Button
                      href={`/app/videos?source=${output.asset_id}`}
                      size="small"
                      className="mt-4 w-full"
                    >
                      <Film size={14} />
                      Animate this photograph
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
          <div className="mt-6">
            <AiDisclosure video={job?.operation === "video"} />
          </div>
          <div className="button-row mt-6">
            <Button variant="danger" size="small" onClick={() => setRemove(true)}>
              <Trash2 size={13} />
              Delete generated media
            </Button>
            <Button
              href={original ? `/app/studio?garment=${original.id}` : "/app/studio"}
              variant="secondary"
              size="small"
            >
              <RefreshCw size={13} />
              Create another version
            </Button>
          </div>
        </>
      ) : (
        !active &&
        !error && (
          <div className="panel">
            <Empty
              title={
                job?.status === "failed"
                  ? "A fresh direction is possible"
                  : "Your results will appear here"
              }
              description={
                job?.status === "failed"
                  ? "Return to the studio to review your source image and request a new quote."
                  : "The original garment and your finished output will be available for review when processing completes."
              }
              action={
                job?.status === "failed" ? (
                  <Button href="/app/studio">Return to the studio</Button>
                ) : undefined
              }
            />
          </div>
        )
      )}
      <Dialog
        open={remove}
        onOpenChange={setRemove}
        title="Remove the generated files?"
        description="This deletes the output media from private storage. Job and credit accounting records remain. This cannot be undone."
      >
        <Button
          variant="danger"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await apiRequest(`/api/generations/${id}`, "DELETE");
              await refresh();
              setOutputs([]);
              setRemove(false);
              notify("Generated media deleted.");
            } catch (c) {
              notify(c instanceof Error ? c.message : "Delete failed", true);
            } finally {
              setBusy(false);
            }
          }}
        >
          Delete generated media
        </Button>
      </Dialog>
    </>
  );
}
