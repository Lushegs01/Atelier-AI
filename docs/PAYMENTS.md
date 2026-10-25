# Credits, Paystack and reconciliation

Payment integration code uses the official server-side initialize/verify APIs, raw-body HMAC SHA512 webhook verification, and refund APIs. No payment has been made or verified against Paystack in this workspace. HTTP tests use explicit test doubles; financial SQL is exercised locally with PostgreSQL.

## Configure staging

1. Create and verify a Paystack business account. Obtain test keys from the dashboard.
2. Set `PAYSTACK_SECRET_KEY`, `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY`, and an HTTPS `NEXT_PUBLIC_APP_URL`. Keep `ALLOW_LIVE_PAYMENTS=false`.
3. Apply the schema and draft seed in a staging Supabase project. Review the exact enabled credit packages, retail operation charges, provider plan costs, foreign exchange assumptions, payment fees, taxes and margin before enabling any catalog row.
4. Configure `https://YOUR_STAGING_HOST/api/payments/webhook` as the test webhook. Localhost cannot receive provider events without an authorized HTTPS tunnel.
5. Register a test workspace and purchase a package in test checkout. Confirm initialization alone changes no balance, a verified successful transaction adds value once, and callback/webhook duplicates do not duplicate credits.
6. Test amount/currency/email/environment mismatch, abandoned and delayed payments, webhook replay, out-of-order events, provider/network failure and controlled full refund.
7. Keep production keys separate. Live processing additionally requires `ALLOW_LIVE_PAYMENTS=true`. The implementation rejects an arbitrary key prefix and live credentials without that explicit flag.

## Purchase flow and trust boundaries

`POST /api/payments/initialize` derives the user email from verified Auth identity and reads the amount/currency/credits from an enabled server-owned package. Only a workspace owner or admin can purchase. A random unique reference and immutable expected purchase snapshot are recorded before contacting Paystack. Checkout URL validation permits only HTTPS `checkout.paystack.com` URLs. Secret keys stay in server-only modules.

The browser redirect is navigation only. `POST /api/payments/verify` authorizes the request against its owning workspace, calls Paystack verification from the server, and requires `data.status=success` plus exact reference, integer amount, currency, test/live domain and expected buyer email. The PostgreSQL settlement function repeats the checks under row locks and commits the payment state, account increment, append-only journal and audit together.

The webhook verifies `x-paystack-signature` over the **unmodified raw request body**, then records a SHA-256 deduplication key. `charge.success` is independently reverified through the Paystack API before settlement. A persisted event is marked processed only after processing succeeds. Duplicated/overlapping webhook and callback deliveries are safe because purchase settlement itself is atomic and idempotent. No card number, authorization token or raw card details are stored.

## Credits and invariants

All customer balances/charges are integer credits. NGN money is integer kobo. Provider cost estimates use integer micro USD; provider usage uses integer milli-credits. `calculateGenerationMargin` accepts explicit integer provider unit price and foreign exchange inputs, rounding cost conservatively; unknown inputs produce an unknown margin, never a zero-cost assumption. Actual contracted provider plan costs and exchange rates have not been supplied.

For every organization:

```text
credit_accounts.available = sum(credit_ledger.available_delta)
credit_accounts.reserved  = sum(credit_ledger.reserved_delta)
available >= 0; reserved >= 0
```

The initial account and journal are zero. Every normal balance mutation and matching journal insert occurs in one trusted transaction. Purchases add available credits. Reservations subtract available/add reserved. Success removes reserved and records spent credits; qualifying failure returns reserved to available. Adjustments and refund reversals append compensating entries. Historical ledger records cannot be edited/deleted by application code.

A generation is not dispatched before its reservation, job and durable outbox are committed. A success requires privately transferred generated output records. Output-transfer failure remains a retry/recovery concern before safe failure settlement. Failed jobs do not strand credits. A provider submission timeout that might have been accepted is held for reconciliation, because refunding or resubmitting prematurely can create duplicate cost. Confirmed price values are rechecked in the reservation transaction; a changed quote is rejected for fresh confirmation. Customer session quoted prices are stored on the session and also compared.

Seed retail prices are a draft commercial proposal, all `enabled=false`. Prices are provider-specific. The default Qwen image editor uses no FASHN billing credits; its GPU time, idle capacity, storage/network and failures still incur infrastructure cost. Measure those costs before approving retail rules. Qwen supports one still-image edit and separately assessed customer visualization; video is unavailable. Optional FASHN balanced1k images consume two documented provider credits, with distinct5/10sec video variants. No provider change rewrites historical cost/ledger entries. Unsupported/unpriced settings are rejected; enable only reviewed provider costs and customer charges after actual acceptance.

## Reconciliation procedure

Use the protected admin interface/API to reconcile pending payments (`reconcilePendingPayments` service). Inspect the exact reference and independently verified provider data. Never issue manual credits because a user shows a checkout screenshot or success redirect.

Daily checks:

- Sum journal deltas against account balances, compare successful purchases against one `purchase` entry each, and inspect orphan reservations.
- Review pending/initialized purchases older than the normal checkout window; reverify them. Pending/abandoned transactions do not get value.
- Review unsuccessful generation reservations, old safely unsubmitted jobs, ambiguous paid submissions, failed output transfers and undelivered outbox records.
- Reconcile Paystack settlement/fees/disputes/refunds against accounting exports and bank records. These external finance steps are not automated or claimed verified here.
- Watch signed webhook processing failures and provider verification failures. A non-2xx webhook response intentionally lets Paystack redeliver.

Dispute/refund events produce an operational audit alert. An automatically verified successful charge can be credited only once, even when events arrive out of order. Refunds and chargebacks require attention; consumed credits must not be silently deleted or rewritten. An operator can use a compensating administrative adjustment with a reason and unique idempotency key after investigation.

## Controlled refunds

The protected `requestPaymentRefund` service supports **full purchase refunds only**. It verifies platform administrator identity against `platform_admins` and requires enough available credits to remove the full package value before submitting one provider request. It records an audited `refund_pending` state and reversal entry before calling Paystack `/refund`. Duplicate requests never submit again. Creation means pending, not refunded.

`reconcilePaymentRefund` fetches the provider refund by ID, verifies original transaction ID, exact amount, currency and environment, then marks refunded only when the provider reports `processed`. A candidate refund ID can recover a lost create response, but the fetched record must match the original purchase. A timed-out/ambiguous request remains pending with removed credits and an audit trail; inspect the dashboard and reconcile the accepted refund before any next action. Do not automatically resubmit. Failed/needs-attention refunds require a controlled support review and, if appropriate, a compensating credit adjustment; collection of bank details/retry-with-customer-details is intentionally outside this initial UI. Partial cash refunds require a separate approved allocation policy and are not offered.

## Official references checked 24 October 2026

- [Accept payments](https://paystack.com/docs/payments/accept-payments/) — initialize on server, complete checkout, then verify.
- [Webhook verification](https://paystack.com/docs/payments/webhooks/) — HMAC SHA512 signature of raw payload, retry semantics.
- [Verify payments](https://paystack.com/docs/payments/verify-payments/) — transaction `data.status`, expected amount and duplicate fulfillment checks.
- [Refund API](https://paystack.com/docs/api/refund/) and [refund lifecycle](https://paystack.com/docs/payments/refunds/) — queued/processed status and reconciliation.

No real account secrets are committed. No live payment, refund, remote webhook delivery or bank reconciliation has been performed. These remain release-blocking staging checks.
