"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Check,
  ShieldCheck,
  Download,
  Trash2,
  Plus,
  Users,
  LockKeyhole,
  ArrowUpRight,
} from "lucide-react";
import { Badge, Button, Dialog, Input, Notice, Select, useToast } from "@/components/ui";
import { PageHeading, SetupNotice, Onboarding } from "./common";
import { useWorkspace, apiRequest } from "./context";
const sections = ["profile", "organization", "brand", "security", "privacy"];
type Member = { user_id: string; role: string; email?: string; full_name?: string };
export default function SettingsPage({ section }: { section: string }) {
  const { data, refresh } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [addMember, setAddMember] = useState(false);
  const notify = useToast();
  const manage = ["owner", "admin"].includes(data.role || "");
  useEffect(() => {
    if (section !== "organization" || !manage) return;
    fetch("/api/organizations/members")
      .then((r) => r.json())
      .then((j) => setMembers(j.members || []))
      .catch(() => {});
  }, [section, manage]);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const form = new FormData(event.currentTarget);
    let values: Record<string, unknown> = Object.fromEntries(form);
    if (section === "organization")
      values = { ...values, dailySpendingLimit: Number(form.get("dailySpendingLimit")) };
    try {
      await apiRequest("/api/settings", "PATCH", {
        section,
        values,
        organizationId: data.organization?.id,
      });
      await refresh();
      notify("Your settings have been saved.");
    } catch (c) {
      notify(c instanceof Error ? c.message : "Could not save settings", true);
    } finally {
      setBusy(false);
    }
  }
  async function privacy(type: string) {
    setBusy(true);
    try {
      const response = await apiRequest<{ requestId?: string }>("/api/privacy", "POST", {
        type,
        organizationId: data.organization?.id,
      });
      notify(
        `Your ${type === "export_data" ? "export" : "deletion"} request is recorded${response.requestId ? `. Reference: ${response.requestId.slice(0, 8)}` : ""}.`,
      );
      setConfirmation("");
    } catch (c) {
      notify(c instanceof Error ? c.message : "Request failed", true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="Make yourself at home."
        description="The details, permissions and preferences behind your studio."
      />
      <SetupNotice />
      <Onboarding />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map((s) => (
            <Link key={s} href={`/app/settings/${s}`} className={s === section ? "active" : ""}>
              {s}
            </Link>
          ))}
        </nav>
        <div className="form-stack">
          <section className="panel panel-padded">
            <div className="panel-heading">
              <div>
                <h2 className="capitalize">
                  {section === "brand"
                    ? "Your brand, your signature"
                    : section === "privacy"
                      ? "Your data. Your choices."
                      : section === "security"
                        ? "Keep your studio secure"
                        : `${section} details`}
                </h2>
                <p>
                  {section === "brand"
                    ? "A considered identity for your customer invitations."
                    : "A little care for the things that matter."}
                </p>
              </div>
            </div>
            {["profile", "organization", "brand"].includes(section) ? (
              <form
                className="form-stack"
                onSubmit={save}
                key={`${section}-${data.organization?.id}-${data.user?.fullName}`}
              >
                {section === "profile" ? (
                  <>
                    <Input
                      label="Your name"
                      name="fullName"
                      defaultValue={data.user?.fullName || data.user?.name}
                      required
                      maxLength={120}
                    />
                    <Input
                      label="Email address"
                      value={data.user?.email || ""}
                      readOnly
                      hint="Email changes require a new verification flow. Contact support for account recovery."
                    />
                  </>
                ) : section === "organization" ? (
                  <>
                    <Input
                      label="Workspace name"
                      name="name"
                      defaultValue={data.organization?.name}
                      required
                      minLength={2}
                      maxLength={80}
                      disabled={!manage}
                    />
                    <Input
                      label="Daily generation spending limit (credits)"
                      type="number"
                      name="dailySpendingLimit"
                      min={0}
                      max={100000}
                      defaultValue={data.organization?.daily_spending_limit ?? 500}
                      disabled={!manage}
                      hint="A server-enforced cap across all generations in this workspace. Set 0 to pause new reservations."
                    />
                  </>
                ) : (
                  <>
                    <Input
                      label="Brand name"
                      name="brandName"
                      defaultValue={data.organization?.brand_name || data.organization?.name}
                      required
                      minLength={2}
                      maxLength={80}
                      disabled={!manage}
                    />
                    <Input
                      type="color"
                      label="Brand accent"
                      name="brandColor"
                      defaultValue={data.organization?.brand_color || "#183952"}
                      disabled={!manage}
                      className="!h-12 !p-1.5 max-w-24"
                      hint="Used on your private customer invitations."
                    />
                    <Notice>
                      Customer links show your permitted brand name and accent. Original customer
                      photographs stay private.
                    </Notice>
                  </>
                )}
                {section !== "profile" && !manage ? (
                  <Notice>Only workspace owners and admins can update these details.</Notice>
                ) : (
                  <div>
                    <Button type="submit" busy={busy}>
                      Save changes <Check size={14} />
                    </Button>
                  </div>
                )}
              </form>
            ) : section === "security" ? (
              <div className="form-stack">
                <div className="flex items-center gap-3">
                  <span className="mini-icon">
                    <LockKeyhole size={19} />
                  </span>
                  <div>
                    <h3 className="text-sm">A unique password, a secure account.</h3>
                    <p className="muted text-xs mt-1">
                      Reset your password using a verified email link.
                    </p>
                  </div>
                </div>
                <Button href="/forgot-password" variant="secondary" className="self-start">
                  Reset password <ArrowUpRight size={13} />
                </Button>
                <div className="border-t border-border pt-6">
                  <h3 className="text-sm mb-2">Other signed-in sessions</h3>
                  <p className="muted text-xs mb-4">
                    Sign out other refresh sessions. Existing access tokens expire according to the
                    configured authentication policy.
                  </p>
                  <Button
                    variant="secondary"
                    busy={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await apiRequest("/api/settings", "PATCH", {
                          section: "security",
                          values: { signOutOtherSessions: true },
                        });
                        notify("Other refresh sessions have been signed out.");
                      } catch (c) {
                        notify(
                          c instanceof Error ? c.message : "Could not sign out sessions",
                          true,
                        );
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Sign out other sessions
                  </Button>
                </div>
              </div>
            ) : (
              <div className="form-stack">
                <Notice>
                  <ShieldCheck size={14} className="inline mr-1" />
                  Customer-photo processing requires explicit, versioned consent. Private media is
                  never added to the service worker cache.
                </Notice>
                <div>
                  <h3 className="text-sm mb-2">Take your information with you</h3>
                  <p className="muted text-xs mb-4">
                    Request an export of your account and authorized workspace information. We
                    record the request for secure fulfillment.
                  </p>
                  <Button
                    variant="secondary"
                    busy={busy}
                    onClick={() => void privacy("export_data")}
                  >
                    <Download size={14} />
                    Request data export
                  </Button>
                </div>
                <div className="border-t border-border pt-6">
                  <h3 className="text-sm mb-2">Delete your account</h3>
                  <p className="muted text-xs mb-4">
                    Request account deletion. Workspace ownership, financial retention and upstream
                    processing are checked before completion.
                  </p>
                  <Button variant="danger" onClick={() => setConfirmation("delete_account")}>
                    <Trash2 size={14} />
                    Request account deletion
                  </Button>
                </div>
                <Link
                  href="/privacy"
                  className="text-xs text-secondary underline underline-offset-4"
                >
                  Read the privacy and retention disclosure
                </Link>
              </div>
            )}
          </section>
          {section === "organization" && manage && (
            <section className="panel panel-padded">
              <div className="panel-heading">
                <div>
                  <h2>Your studio team</h2>
                  <p>Give each collaborator the access their work needs.</p>
                </div>
                <Button variant="secondary" size="small" onClick={() => setAddMember(true)}>
                  <Plus size={13} />
                  Add member
                </Button>
              </div>
              {members.length ? (
                members.map((member) => (
                  <div className="job-item" key={member.user_id}>
                    <span className="mini-icon">
                      <Users size={15} />
                    </span>
                    <div>
                      <h3>
                        {member.full_name ||
                          member.email ||
                          (member.user_id === data.user?.id ? "You" : "Workspace member")}
                      </h3>
                      <p className="capitalize">{member.role}</p>
                    </div>
                    <Badge>{member.role}</Badge>
                    {member.role !== "owner" && member.user_id !== data.user?.id && (
                      <Button
                        variant="ghost"
                        size="small"
                        aria-label="Remove member"
                        onClick={async () => {
                          try {
                            await apiRequest("/api/organizations/members", "DELETE", {
                              userId: member.user_id,
                              organizationId: data.organization?.id,
                            });
                            setMembers(members.filter((m) => m.user_id !== member.user_id));
                            notify("Member access removed.");
                          } catch (c) {
                            notify(
                              c instanceof Error ? c.message : "Could not remove access",
                              true,
                            );
                          }
                        }}
                      >
                        <Trash2 size={13} />
                      </Button>
                    )}
                  </div>
                ))
              ) : (
                <p className="muted text-xs">
                  Your workspace membership is shown here after connection.
                </p>
              )}
              <p className="muted text-[10px] mt-5">
                Owners manage the business. Admins manage the team and billing. Designers create.
                Assistants can view and organize permitted work.
              </p>
            </section>
          )}
        </div>
      </div>
      <Dialog
        open={!!confirmation}
        onOpenChange={(v) => {
          if (!v) setConfirmation("");
        }}
        title="Request account deletion?"
        description="This records a privacy request for secure review and deletion. It does not immediately erase financial records, backups or provider copies."
      >
        <Button variant="danger" busy={busy} onClick={() => void privacy(confirmation)}>
          Record my deletion request
        </Button>
      </Dialog>
      <Dialog
        open={addMember}
        onOpenChange={setAddMember}
        title="Make room for a collaborator."
        description="They must already have a verified Atelier AI account. This grants access to this workspace; no invitation email is sent."
      >
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const values = Object.fromEntries(new FormData(e.currentTarget));
            try {
              await apiRequest("/api/organizations/members", "POST", {
                ...values,
                organizationId: data.organization?.id,
              });
              setAddMember(false);
              const res = await fetch("/api/organizations/members");
              const j = await res.json();
              setMembers(j.members || []);
              notify("Collaborator added to your workspace.");
            } catch (c) {
              notify(c instanceof Error ? c.message : "Could not add collaborator", true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input name="email" label="Collaborator’s account email" type="email" required />
          <Select name="role" label="Role" defaultValue="designer">
            <option value="designer">Designer — create campaigns</option>
            <option value="assistant">Assistant — view the collection</option>
            {data.role === "owner" && (
              <option value="admin">Admin — manage team and billing</option>
            )}
          </Select>
          <Button type="submit" busy={busy}>
            Add collaborator
          </Button>
        </form>
      </Dialog>
    </>
  );
}
