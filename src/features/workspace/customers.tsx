"use client";
import { useState } from "react";
import { Plus, Search, Users, Trash2 } from "lucide-react";
import { Button, Dialog, Empty, Input, Notice, useToast } from "@/components/ui";
import { PageHeading, SetupNotice } from "./common";
import { useWorkspace, apiRequest } from "./context";
import { dateLabel } from "@/lib/utils";
export default function CustomersPage() {
  const { data, refresh } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  const notify = useToast();
  const customers = data.customers.filter((c) =>
    `${c.name} ${c.email || ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeading
        title="The people behind the pieces."
        description="A small, thoughtful customer book for your workspace."
        action={
          <Button onClick={() => setOpen(true)}>
            <Plus size={14} />
            Add a customer
          </Button>
        }
      />
      <SetupNotice />
      <label className="search-box max-w-sm mb-6">
        <Search size={14} />
        <input
          aria-label="Search customers"
          placeholder="Find a customer…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className="panel">
        {customers.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Email</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.email || "Not provided"}</td>
                    <td>{dateLabel(c.created_at)}</td>
                    <td>
                      <Button
                        variant="ghost"
                        size="small"
                        onClick={() => setRemove(c.id)}
                        aria-label={`Remove ${c.name}`}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={search ? "No matching customers" : "Every piece has a person in mind"}
            description="Keep only the customer details you need. A try-on invitation doesn’t require a customer profile."
            icon={<Users size={24} strokeWidth={1.3} />}
            action={
              <Button onClick={() => setOpen(true)} variant="secondary">
                <Plus size={13} />
                Add a customer
              </Button>
            }
          />
        )}
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="A new face in your customer book."
        description="Add only information you have permission to keep. Photographs belong in a consented try-on session."
      >
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const form = new FormData(e.currentTarget);
            try {
              await apiRequest("/api/customers", "POST", {
                organizationId: data.organization?.id,
                name: form.get("name"),
                ...(form.get("email") ? { email: form.get("email") } : {}),
              });
              await refresh();
              setOpen(false);
              notify("Customer added to your workspace.");
            } catch (c) {
              notify(c instanceof Error ? c.message : "Could not save customer", true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input name="name" label="Customer name" required maxLength={120} />
          <Input name="email" label="Email (optional)" type="email" maxLength={254} />
          <Notice>
            Adding a customer does not grant consent to process their photograph or contact them for
            marketing.
          </Notice>
          <Button type="submit" busy={busy}>
            Save customer
          </Button>
        </form>
      </Dialog>
      <Dialog
        open={!!remove}
        onOpenChange={(v) => {
          if (!v) setRemove(null);
        }}
        title="Remove this customer record?"
        description="This removes the contact from your customer book. Use a privacy request to remove separately consented photographs."
      >
        <Button
          variant="danger"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await apiRequest(`/api/customers/${remove}`, "DELETE");
              await refresh();
              setRemove(null);
              notify("Customer removed.");
            } catch (c) {
              notify(c instanceof Error ? c.message : "Could not remove customer", true);
            } finally {
              setBusy(false);
            }
          }}
        >
          Remove customer
        </Button>
      </Dialog>
    </>
  );
}
