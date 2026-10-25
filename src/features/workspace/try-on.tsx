"use client";
import { useState } from "react";
import { Plus, Link2, Copy, Check, ShieldCheck, ScanFace, Ban, ArrowUpRight } from "lucide-react";
import { Badge, Button, Dialog, Empty, Input, Notice, Select, useToast } from "@/components/ui";
import { PageHeading, SetupNotice } from "./common";
import { useWorkspace, apiRequest } from "./context";
import { dateLabel } from "@/lib/utils";
export default function TryOnPage() {
  const { data, refresh } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [cost, setCost] = useState(0);
  const notify = useToast();
  const [now] = useState(() => Date.now());
  return (
    <>
      <PageHeading
        title="A fitting room, made personal."
        description="Invite a customer to see your piece in a private, consent-led experience."
        action={
          <Button
            onClick={() => {
              setUrl("");
              setOpen(true);
            }}
          >
            <Plus size={15} />
            Create a try-on link
          </Button>
        }
      />
      <SetupNotice />
      <div className="dashboard-hero !min-h-60 mb-7 !grid-cols-1 md:!grid-cols-[1.5fr_1fr]">
        <div className="dashboard-hero-copy">
          <span className="eyebrow">
            <ShieldCheck size={13} />
            Personal by invitation
          </span>
          <h2 className="!text-3xl">
            Their photograph.
            <br />
            <span className="serif italic">Your thoughtful design.</span>
          </h2>
          <p className="!max-w-md">
            Choose a garment and share a secure, time-limited link. Your customer reviews the
            disclosure and gives consent before uploading.
          </p>
        </div>
        <div className="hidden md:flex items-center justify-center">
          <div className="w-28 h-28 border border-secondary/20 rounded-[30px] flex items-center justify-center bg-white/50">
            <ScanFace size={55} strokeWidth={0.8} className="text-secondary" />
          </div>
        </div>
      </div>
      <div className="panel panel-padded">
        <div className="panel-heading">
          <div>
            <h2>Your customer invitations</h2>
            <p>Links are shown once when created. Only their secure hashes are stored.</p>
          </div>
          <Badge>Private by design</Badge>
        </div>
        {data.tryOnSessions.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Garment</th>
                  <th>Expires</th>
                  <th>Usage</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.tryOnSessions.map((s) => {
                  const expired = new Date(s.expires_at).getTime() < now;
                  return (
                    <tr key={s.id}>
                      <td>{data.garments.find((g) => g.id === s.garment_id)?.name || "Garment"}</td>
                      <td>{dateLabel(s.expires_at)}</td>
                      <td>
                        {s.uses || 0} / {s.max_uses || 1}
                      </td>
                      <td>
                        <Badge tone={s.revoked_at || expired ? "warning" : "success"}>
                          {s.revoked_at
                            ? "Revoked"
                            : expired
                              ? "Expired"
                              : s.uses
                                ? "Used"
                                : "Available"}
                        </Badge>
                      </td>
                      <td>
                        <Button
                          size="small"
                          variant="ghost"
                          disabled={!!s.revoked_at}
                          onClick={async () => {
                            try {
                              await apiRequest(`/api/try-on/sessions/${s.id}`, "DELETE");
                              await refresh();
                              notify("The invitation has been revoked.");
                            } catch (c) {
                              notify(c instanceof Error ? c.message : "Revocation failed", true);
                            }
                          }}
                        >
                          <Ban size={13} />
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="Make room for a personal experience"
            description="Choose a garment from your library and create your first customer invitation. Each link is private, expires automatically and can be revoked."
            icon={<Link2 size={23} strokeWidth={1.3} />}
            action={
              <Button variant="secondary" onClick={() => setOpen(true)}>
                <Plus size={14} />
                Create a customer invitation
              </Button>
            }
          />
        )}
      </div>
      <div className="mt-6">
        <Notice>
          Virtual try-on is an AI visualization, not a guarantee of accurate fit, body measurements
          or real-world appearance. Customers’ photographs are sent to the configured AI provider
          only after explicit consent.
        </Notice>
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={url ? "Your private invitation is ready." : "A fitting room for one."}
        description={
          url
            ? "Copy this link now. We store only its hash and cannot show it again."
            : "Choose the piece and how long the customer has to use their link."
        }
      >
        {url ? (
          <div className="form-stack">
            <Input label="Secure customer link" readOnly value={url} />
            <Notice>
              Up to {cost} credits are charged to your workspace when the customer submits and the
              generation succeeds. Creating the link does not reserve credits.
            </Notice>
            <div className="button-row">
              <Button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(url);
                    setCopied(true);
                  } catch {
                    notify("Select and copy the link from the field above.");
                  }
                }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy invitation"}
              </Button>
              <Button href={url} variant="secondary">
                Preview <ArrowUpRight size={14} />
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              setBusy(true);
              try {
                const result = await apiRequest<{ url: string; estimatedCredits: number }>(
                  "/api/try-on",
                  "POST",
                  {
                    organizationId: data.organization?.id,
                    garmentId: form.get("garmentId"),
                    expiresInHours: Number(form.get("expiresInHours")),
                  },
                );
                setUrl(result.url);
                setCost(result.estimatedCredits);
                await refresh();
              } catch (c) {
                notify(c instanceof Error ? c.message : "Could not create invitation", true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Select name="garmentId" label="Garment" required>
              <option value="">Choose a garment</option>
              {data.garments
                .filter((g) => !g.archived_at)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </Select>
            <Select name="expiresInHours" label="Link expires after" defaultValue="72">
              <option value="24">24 hours</option>
              <option value="72">3 days</option>
              <option value="168">7 days</option>
            </Select>
            <Notice>
              One customer, one generation. Consent is collected from the customer, never assumed.
              The original customer photo is retained for up to 24 hours by default.
            </Notice>
            <Button type="submit" busy={busy}>
              Create private link <Link2 size={14} />
            </Button>
          </form>
        )}
      </Dialog>
    </>
  );
}
