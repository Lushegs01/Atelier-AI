"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, CreditCard, Download, Wallet, Clock3, RefreshCw } from "lucide-react";
import { Badge, Button, Empty, Notice, useToast } from "@/components/ui";
import { Pricing } from "@/features/public/pricing";
import { useWorkspace, apiRequest } from "./context";
import { PageHeading, SetupNotice } from "./common";
import { currency, dateLabel } from "@/lib/utils";
export default function BillingPage({ credits = false }: { credits?: boolean }) {
  const { data, refresh } = useWorkspace();
  const params = useSearchParams();
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [verification, setVerification] = useState("");
  const reference = params.get("reference") || params.get("trxref");
  useEffect(() => {
    if (!reference) return;
    let current = true;
    apiRequest<{ status: string; credits: number }>("/api/payments/verify", "POST", { reference })
      .then((result) => {
        if (current) {
          setVerification(
            `Payment verified. ${result.credits} credits issued or previously recorded.`,
          );
          void refresh();
        }
      })
      .catch((c) => {
        if (current) setVerification(c.message);
      });
    return () => {
      current = false;
    };
  }, [reference, refresh]);
  async function buy(packageId: string) {
    setBusy(true);
    try {
      const result = await apiRequest<{ authorizationUrl: string }>(
        "/api/payments/initialize",
        "POST",
        { organizationId: data.organization?.id, packageId },
      );
      const url = new URL(result.authorizationUrl);
      if (
        url.protocol !== "https:" ||
        !["checkout.paystack.com", "paystack.com"].includes(url.hostname)
      )
        throw new Error("An unexpected checkout URL was rejected.");
      window.location.assign(url.toString());
    } catch (c) {
      notify(c instanceof Error ? c.message : "Checkout unavailable", true);
      setBusy(false);
    }
  }
  function receipt(id: string) {
    const payment = data.payments.find((p) => p.id === id);
    if (!payment) return;
    const text = [
      "ATELIER AI — PAYMENT RECORD",
      `Reference: ${payment.reference}`,
      `Date: ${dateLabel(payment.created_at)}`,
      `Workspace: ${data.organization?.name || ""}`,
      `Amount: ${currency(payment.amount_kobo)}`,
      `Credits: ${payment.credits}`,
      `Status: ${payment.status}`,
      "This is a payment record. For a tax invoice, contact the operator.",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `atelier-payment-${payment.reference}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <PageHeading
        title={credits ? "A little fuel for your ideas." : "Your billing, kept clear."}
        description={
          credits
            ? "Prepaid credits. No subscription. Create whenever inspiration arrives."
            : "Every purchase, every reference, all in one place."
        }
        action={
          <Button variant="secondary" onClick={() => void refresh()} busy={busy}>
            <RefreshCw size={14} />
            Refresh
          </Button>
        }
      />
      <SetupNotice />
      {verification && (
        <div className="mb-6">
          <Notice>{verification}</Notice>
        </div>
      )}
      <section className="balance-panel">
        <div>
          <span className="eyebrow">
            <Wallet size={12} />
            Your creative balance
          </span>
          <div className="balance-number">
            {data.balance.available.toLocaleString()}
            <small>credits available</small>
          </div>
        </div>
        <div>
          <p className="text-xs text-secondary flex items-center gap-2">
            <Clock3 size={14} />
            {data.balance.reserved.toLocaleString()} credits reserved
          </p>
          <p className="muted text-[10px] mt-2 max-w-60">
            Reservations are charged after the result is stored. Failed generations release their
            reserved credits.
          </p>
        </div>
      </section>
      {credits && (
        <section className="mb-8">
          <div className="panel-heading">
            <div>
              <h2>More room to create</h2>
              <p>Choose a credit bundle. Checkout is handled securely by Paystack.</p>
            </div>
            <Badge>NGN</Badge>
          </div>
          <Pricing packages={data.packages} onBuy={buy} />
          {busy && (
            <p className="muted text-xs mt-3" role="status">
              Opening secure checkout…
            </p>
          )}
        </section>
      )}
      <section className="panel">
        <div className="panel-heading p-6 !mb-0">
          <div>
            <h2>{credits ? "Your credit journal" : "Payment history"}</h2>
            <p>
              {credits
                ? "An append-only record of purchases, reservations and charges."
                : "Verified transactions and pending checkout attempts."}
            </p>
          </div>
          {!credits && (
            <Button href="/app/credits" variant="secondary" size="small">
              Buy credits <ArrowUpRight size={13} />
            </Button>
          )}
        </div>
        {credits ? (
          data.ledger.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Entry</th>
                    <th>Available change</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ledger.map((entry) => (
                    <tr key={entry.id}>
                      <td>{dateLabel(entry.created_at)}</td>
                      <td className="capitalize">
                        {entry.entry_type ||
                          entry.kind ||
                          (entry as typeof entry & { type?: string }).type ||
                          "Entry"}
                      </td>
                      <td>
                        {(entry.amount ?? entry.available_delta ?? 0) > 0 ? "+" : ""}
                        {entry.amount ?? entry.available_delta ?? 0}
                      </td>
                      <td>{entry.description || "Accounting event"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="A fresh page in your credit journal"
              description="Purchases, reservations, charges and releases appear here as they happen."
              icon={<Wallet size={23} strokeWidth={1.3} />}
            />
          )
        ) : data.payments.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Reference</th>
                  <th>Amount</th>
                  <th>Credits</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>{dateLabel(payment.created_at)}</td>
                    <td className="max-w-44 truncate" title={payment.reference}>
                      {payment.reference}
                    </td>
                    <td>{currency(payment.amount_kobo)}</td>
                    <td>{payment.credits}</td>
                    <td>
                      <Badge tone={payment.status === "success" ? "success" : "default"}>
                        {payment.status}
                      </Badge>
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        size="small"
                        onClick={() => receipt(payment.id)}
                        aria-label="Download payment record"
                      >
                        <Download size={14} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="Everything in its place"
            description="Your payment history will appear here after your first checkout. A checkout redirect alone never issues credits."
            icon={<CreditCard size={23} strokeWidth={1.3} />}
          />
        )}
      </section>
      <p className="muted text-[10px] mt-4">
        All charges are confirmed by the server. A completed creative result isn’t automatically
        refunded for aesthetic preference. Contact support if something seems incorrect.
      </p>
    </>
  );
}
