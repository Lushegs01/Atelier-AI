"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, ArrowLeft, RefreshCw, Settings2 } from "lucide-react";
import { Logo } from "@/components/logo";
import { Badge, Button, Dialog, Empty, Input, Notice, Select, useToast } from "@/components/ui";
import { apiRequest } from "@/features/workspace/context";
const resources = [
  "overview",
  "users",
  "organizations",
  "jobs",
  "payments",
  "providers",
  "pricing",
  "audit",
];
export default function AdminPage({ resource }: { resource: string }) {
  const [data, setData] = useState<Record<string, unknown>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [actionOpen, setActionOpen] = useState(false);
  const [action, setAction] = useState("");
  const [actionKey, setActionKey] = useState("");
  const notify = useToast();
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/${resource}?page=${page}`, { cache: "no-store" });
      const next = await res.json();
      if (!res.ok) throw new Error(next.error);
      setData(next);
      setError("");
    } catch (c) {
      setError(c instanceof Error ? c.message : "Administration unavailable.");
    } finally {
      setBusy(false);
    }
  }, [resource, page]);
  useEffect(() => {
    const bootstrap = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(bootstrap);
  }, [load]);
  const records = (Array.isArray(data.records) ? data.records : []) as Record<string, unknown>[];
  const keys = records.length
    ? Object.keys(records[0]).filter((k) => !k.includes("secret") && !k.includes("token_hash"))
    : [];
  const actions: Record<string, [string, string][]> = {
    users: [
      ["suspend", "Suspend an account"],
      ["unsuspend", "Restore an account"],
    ],
    organizations: [
      ["set_spending_limit", "Update spending limit"],
      ["adjust", "Adjust credits"],
    ],
    jobs: [["resume", "Resume an existing provider prediction"]],
    payments: [
      ["reconcile", "Reconcile pending payments"],
      ["request_refund", "Request full payment refund"],
      ["reconcile_refund", "Reconcile a pending refund"],
    ],
    pricing: [["update", "Review and update a price"]],
  };
  return (
    <div className="min-h-screen">
      <header className="public-nav border-b border-border">
        <Logo href="/app" />
        <div className="button-row">
          <Badge>
            <ShieldCheck size={12} />
            Platform administration
          </Badge>
          <Button href="/app" variant="ghost" size="small">
            <ArrowLeft size={13} />
            Workspace
          </Button>
        </div>
      </header>
      <main id="main-content" className="max-w-[1400px] mx-auto p-5 md:p-10">
        <nav className="chip-list mb-8" aria-label="Administrative navigation">
          {resources.map((r) => (
            <Link
              href={r === "overview" ? "/admin" : `/admin/${r}`}
              key={r}
              className={`chip capitalize ${resource === r ? "active" : ""}`}
            >
              {r}
            </Link>
          ))}
        </nav>
        <div className="page-heading">
          <div>
            <span className="eyebrow mb-3">Operations / trusted access</span>
            <h1 className="capitalize">
              {resource === "overview" ? "A clear view of the platform." : resource}
            </h1>
            <p>Access is verified against the server-managed platform administrator registry.</p>
          </div>
          <div className="button-row">
            <Button variant="secondary" onClick={() => void load()} busy={busy}>
              <RefreshCw size={14} />
              Refresh
            </Button>
            {actions[resource] && (
              <Button
                onClick={() => {
                  setAction(actions[resource][0][0]);
                  setActionKey(crypto.randomUUID());
                  setActionOpen(true);
                }}
              >
                <Settings2 size={14} />
                Actions
              </Button>
            )}
          </div>
        </div>
        {error ? (
          <Notice tone="error">{error}</Notice>
        ) : resource === "overview" ? (
          <>
            <div className="stats-grid">
              {[
                ["Organizations", data.organizations],
                ["Active jobs", data.activeJobs],
                ["Failed jobs", data.failedJobs],
                ["Pending payments", data.pendingPayments],
                ["Privacy requests", data.privacyRequests],
              ].map(([label, value]) => (
                <div className="panel panel-padded" key={String(label)}>
                  <span className="eyebrow">{String(label)}</span>
                  <p className="stat-value">{value === undefined ? "—" : String(value)}</p>
                </div>
              ))}
            </div>
            <Notice>
              Monitor queue age, stuck-job alerts, provider availability and privacy requests with
              your configured monitoring service. Statistics above are queried from stored records.
            </Notice>
          </>
        ) : records.length ? (
          <div className="panel table-scroll">
            <table>
              <thead>
                <tr>
                  {keys.map((key) => (
                    <th key={key}>{key.replaceAll("_", " ")}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map((record, i) => (
                  <tr key={String(record.id || i)}>
                    {keys.map((key) => (
                      <td key={key} className="!whitespace-normal min-w-24 max-w-80 break-words">
                        {typeof record[key] === "boolean" ? (
                          <Badge tone={record[key] ? "success" : "warning"}>
                            {record[key] ? "Yes" : "No"}
                          </Badge>
                        ) : record[key] === null ? (
                          "—"
                        ) : typeof record[key] === "object" ? (
                          <details>
                            <summary className="cursor-pointer text-secondary">Details</summary>
                            <pre className="text-[10px] mt-2 whitespace-pre-wrap">
                              {JSON.stringify(record[key], null, 2)}
                            </pre>
                          </details>
                        ) : (
                          String(record[key])
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="panel">
            <Empty
              title={busy ? "Loading records…" : "No records on this page"}
              description="Operational records appear as the configured platform is used."
              icon={<ShieldCheck size={24} />}
            />
          </div>
        )}
        {resource !== "overview" && (
          <div className="button-row mt-5 justify-end">
            <Button
              variant="secondary"
              size="small"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <span className="text-xs muted">Page {page}</span>
            <Button
              variant="secondary"
              size="small"
              disabled={records.length < 50}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        )}
        {resource === "providers" && (
          <div className="mt-6">
            <Notice>
              Provider availability is controlled through typed deployment environment flags. Photo
              and try-on are Preview; video is Experimental. Change flags through a reviewed
              deployment, then verify readiness.
            </Notice>
          </div>
        )}
        <Dialog
          open={actionOpen}
          onOpenChange={setActionOpen}
          title="An accountable operation."
          description="Administrative changes require a reason and are recorded in the audit log. Financial actions use transaction and idempotency safeguards."
        >
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const values: Record<string, unknown> = Object.fromEntries(form);
              for (const key of ["limit", "delta", "credits", "estimatedProviderCostMicrousd"])
                if (values[key] !== undefined) values[key] = Number(values[key]);
              if (action === "update") {
                values.enabled = values.enabled === "true";
                values.reviewed = true;
              }
              values.action = action;
              values.idempotencyKey = actionKey;
              setBusy(true);
              try {
                await apiRequest(
                  `/api/admin/${action === "adjust" ? "credits" : resource}`,
                  "POST",
                  values,
                );
                setActionOpen(false);
                notify("Administrative action recorded.");
                await load();
              } catch (c) {
                notify(c instanceof Error ? c.message : "Action failed", true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Select label="Action" value={action} onChange={(e) => setAction(e.target.value)}>
              {actions[resource]?.map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </Select>
            {["suspend", "unsuspend"].includes(action) && (
              <Input name="userId" label="Account ID" required />
            )}
            {["set_spending_limit", "adjust"].includes(action) && (
              <Input name="organizationId" label="Organization ID" required />
            )}
            {action === "set_spending_limit" && (
              <Input
                name="limit"
                type="number"
                min={0}
                max={100000}
                label="Daily credit limit"
                required
              />
            )}
            {action === "adjust" && (
              <Input
                name="delta"
                type="number"
                min={-100000}
                max={100000}
                label="Credit adjustment (signed integer)"
                required
              />
            )}
            {action === "resume" && <Input name="jobId" label="Existing job ID" required />}
            {["request_refund", "reconcile_refund"].includes(action) && (
              <Input name="reference" label="Payment reference" required />
            )}
            {action === "update" && (
              <>
                <Input name="id" label="Pricing rule ID" required />
                <Input
                  name="credits"
                  label="Customer price (integer credits)"
                  type="number"
                  min={1}
                  max={100000}
                  required
                />
                <Input
                  name="estimatedProviderCostMicrousd"
                  label="Provider cost estimate (integer micro-USD)"
                  type="number"
                  min={0}
                  required
                />
                <Select name="enabled" label="Availability">
                  <option value="false">Keep disabled</option>
                  <option value="true">Enable this reviewed price</option>
                </Select>
                <label className="check-label">
                  <input required type="checkbox" />I have reviewed provider cost, exchange rate,
                  margin and customer price.
                </label>
              </>
            )}
            <label className="field">
              Reason
              <textarea className="input" name="reason" minLength={10} maxLength={1000} required />
            </label>
            <Button busy={busy} type="submit">
              Record and apply action
            </Button>
          </form>
        </Dialog>
      </main>
    </div>
  );
}
