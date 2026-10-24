"use client";
import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ShieldCheck,
  ScanFace,
  Download,
  Trash2,
  Check,
  AlertCircle,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { Badge, Button, Dialog, FileUpload, Notice, Empty, useToast } from "@/components/ui";
import { apiRequest } from "@/features/workspace/context";
import { downloadMedia } from "@/features/workspace/gallery";
type SessionData = {
  session: { id: string; expiresAt: string; completed: boolean };
  brand: { name: string; color?: string };
  garment: { name: string; description?: string; imageUrl?: string };
  job?: { id: string; status: string };
  outputs: { id: string; url: string }[];
  consentVersion: string;
  available: boolean;
};
export default function GuestTryOn({ token }: { token: string }) {
  const [data, setData] = useState<SessionData | null>(null);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [consent, setConsent] = useState(false);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [deletion, setDeletion] = useState(false);
  const notify = useToast();
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch(`/api/try-on/${encodeURIComponent(token)}`, { cache: "no-store" });
        const next = await res.json();
        if (!res.ok) throw new Error(next.error);
        if (active) {
          setData(next);
          setError("");
        }
      } catch (c) {
        if (active) setError(c instanceof Error ? c.message : "This invitation is unavailable.");
      }
    }
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 8000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [token]);
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);
  function chooseFile(nextFile: File) {
    setFile(nextFile);
    setPreview(URL.createObjectURL(nextFile));
  }
  async function submit() {
    if (!file || !consent || !data) return;
    setBusy(true);
    const form = new FormData();
    form.set("file", file);
    form.set("consent", "true");
    form.set("consentVersion", data.consentVersion);
    try {
      const result = await apiRequest<{ job: { id: string; status: string } }>(
        `/api/try-on/${token}`,
        "POST",
        form,
      );
      setData({ ...data, job: result.job, session: { ...data.session, completed: true } });
      setReview(false);
      setFile(null);
      setPreview("");
      notify("Your private try-on has started.");
    } catch (c) {
      notify(c instanceof Error ? c.message : "Could not start try-on", true);
    } finally {
      setBusy(false);
    }
  }
  if (deleted)
    return (
      <main id="main-content" className="guest-shell">
        <Logo />
        <Empty
          icon={<Check size={25} />}
          title="Your request is recorded."
          description="Your invitation has been revoked. We’ll remove your photos from our storage. Upstream provider and backup retention follow the privacy disclosure."
          action={
            <Button href="/privacy" variant="secondary">
              Read the privacy notice
            </Button>
          }
        />
      </main>
    );
  return (
    <main
      id="main-content"
      className="guest-shell"
      style={
        {
          "--primary":
            data?.brand.color && /^#[a-fA-F0-9]{6}$/.test(data.brand.color)
              ? data.brand.color
              : "#183952",
        } as CSSProperties
      }
    >
      <Logo />
      <div className="text-center">
        <Badge>
          <ShieldCheck size={11} />A private invitation
        </Badge>
        <h1>{data ? `A new way to see ${data.garment.name}.` : "Your personal fitting room."}</h1>
        <p className="muted text-sm">
          {data
            ? `An invitation from ${data.brand.name}. Just for you.`
            : "Your designer’s collection, with a personal perspective."}
        </p>
      </div>
      {error ? (
        <section className="panel">
          <Empty
            icon={<AlertCircle size={24} />}
            title="This invitation is unavailable"
            description={error}
          />
          <p className="text-xs muted px-6 pb-6">
            Ask your designer for a new link if this one has expired, was revoked, or has already
            been used.
          </p>
        </section>
      ) : !data ? (
        <div className="skeleton h-96 mt-6" />
      ) : (
        <>
          {data.garment.imageUrl && (
            <section className="panel overflow-hidden">
              <div className="asset-image !aspect-[4/3]">
                <img
                  src={data.garment.imageUrl}
                  alt={`Original ${data.garment.name}`}
                  className="!object-contain"
                />
              </div>
              <div className="p-4">
                <span className="eyebrow">Selected for your try-on</span>
                <h2 className="text-xl mt-2">{data.garment.name}</h2>
              </div>
            </section>
          )}
          {data.job ? (
            <section className="panel panel-padded">
              <h2 className="text-2xl mb-3">
                {data.job.status === "succeeded"
                  ? "Your new perspective."
                  : data.job.status === "failed"
                    ? "We couldn’t finish this try-on."
                    : "A little creative work is happening."}
              </h2>
              {["queued", "submitting", "processing", "retry_wait"].includes(data.job.status) ? (
                <>
                  <p className="muted text-xs">
                    You can leave this page and return using the same private link.
                  </p>
                  <div className="progress-track">
                    <span />
                  </div>
                  <Badge>{data.job.status.replaceAll("_", " ")}</Badge>
                </>
              ) : data.job.status === "failed" ? (
                <Notice tone="warning">
                  Please contact your designer for a new invitation. No successful-generation charge
                  is due for a failed job.
                </Notice>
              ) : (
                data.outputs.map((o) => (
                  <div key={o.id}>
                    <img
                      className="rounded-xl w-full mb-4"
                      src={o.url}
                      alt="Your private AI virtual try-on result"
                    />
                    <Button
                      className="w-full"
                      onClick={async () => {
                        try {
                          await downloadMedia(o.url, "my-atelier-try-on.png");
                        } catch (c) {
                          notify(c instanceof Error ? c.message : "Download failed", true);
                        }
                      }}
                    >
                      <Download size={15} />
                      Download your result
                    </Button>
                  </div>
                ))
              )}
            </section>
          ) : (
            <section className="panel panel-padded">
              <span className="eyebrow mb-4">Your photograph. Your permission.</span>
              <h2 className="text-2xl mb-4">Let’s see it on you.</h2>
              <p className="muted text-xs mb-5">
                Use a clear, fully clothed photograph of yourself. Stand naturally with your whole
                outfit visible. Avoid photos of children or anyone who hasn’t agreed to take part.
              </p>
              <div className="mb-5">
                <Notice>
                  Your photograph will be sent to FASHN for an AI fashion visualization. It is not a
                  guarantee of fit or accurate body measurements. The source photo is retained for
                  up to 24 hours by default. Your result stays private within this session.
                </Notice>
              </div>
              <label className="check-label mb-5">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  I am an adult, have permission to use this photograph, and agree to its processing
                  for this try-on. I have read the{" "}
                  <Link href="/privacy" className="underline" target="_blank" rel="noreferrer">
                    privacy disclosure
                  </Link>
                  . This does not give promotional permission.
                </span>
              </label>
              {consent ? (
                <FileUpload onFile={chooseFile} preview={preview} label="Choose your photograph" />
              ) : (
                <div className="upload-zone !cursor-default">
                  <ScanFace size={27} strokeWidth={1.2} />
                  <strong>Your permission comes first.</strong>
                  <small>Read the disclosure and check the consent box to continue.</small>
                </div>
              )}
              <Button
                disabled={!consent || !file || !data.available}
                className="w-full mt-5"
                onClick={() => setReview(true)}
              >
                Review my photograph <ArrowRight size={15} />
              </Button>
              {!data.available && (
                <p className="muted text-xs mt-3">
                  This studio’s try-on service is not enabled. Please contact your designer.
                </p>
              )}
            </section>
          )}
          <p className="muted text-[10px] text-center mt-5">
            Your photo is not automatically published or reused for promotion.
          </p>
          <div className="flex justify-center gap-5 mt-5">
            <Button variant="ghost" size="small" onClick={() => setDeletion(true)}>
              <Trash2 size={12} />
              Request photo deletion
            </Button>
            <Button href="/privacy" variant="ghost" size="small">
              Privacy details
            </Button>
          </div>
        </>
      )}
      <Dialog
        open={review}
        onOpenChange={setReview}
        title="A final look before we begin."
        description="Confirm this is the photograph you want to process with the selected garment."
      >
        {preview && (
          <img
            className="rounded-xl max-h-80 mx-auto object-contain mb-5"
            src={preview}
            alt="Your photograph for final review"
          />
        )}
        <Notice>
          Your designer pays for this generation. Your permission applies only to this private
          try-on.
        </Notice>
        <Button className="w-full mt-5" busy={busy} onClick={submit}>
          <ShieldCheck size={15} />I agree — start my private try-on
        </Button>
      </Dialog>
      <Dialog
        open={deletion}
        onOpenChange={setDeletion}
        title="Request removal of your photos?"
        description="Your link will be revoked immediately. A durable request removes our stored photos and results, with retries if needed. Provider and backup retention is described in the privacy notice."
      >
        <Button
          variant="danger"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await apiRequest(`/api/try-on/${token}`, "DELETE", {});
              setDeleted(true);
              setDeletion(false);
            } catch (c) {
              notify(c instanceof Error ? c.message : "Could not record request", true);
            } finally {
              setBusy(false);
            }
          }}
        >
          Revoke link and request deletion
        </Button>
      </Dialog>
    </main>
  );
}
