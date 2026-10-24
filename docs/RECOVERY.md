# Backup, recovery and privacy operations

## Database and media

Configure managed Supabase backups/PITR appropriate to the purchased plan. Export encrypted logical backups to an operator-controlled destination and separately back up private Storage objects; a database backup alone is not an object backup. Limit backup access, define retention and test a restore into an isolated project. Record measured recovery time and data loss only after a real drill.

```text
npx supabase db dump --linked --file backup-schema.sql
npx supabase db dump --linked --data-only --use-copy --file backup-data.sql
```

Review current CLI help before handling a real project. These outputs contain sensitive data and must not be committed. For a managed production incident prefer the provider’s supported restore/PITR workflow; verify account ownership, isolate traffic and use a separate restored project before changing production endpoints. Re-run tenant, ledger, job and storage checks before reopening traffic.

## Payments

Use `/admin/payments` to reconcile pending references against Paystack. Do not grant credits based on a browser redirect or initialization result. Verify amount, currency, buyer, reference and test/live domain. Replay notifications are safe only through the idempotent settlement function. Full refunds require remaining purchased credits and an audited reason. Ambiguous refund acceptance remains pending until provider reconciliation. See PAYMENTS.md.

## AI jobs

Review failed/stuck alerts in audit records and the configured monitoring sink. Known prediction IDs may be resumed through the protected jobs administration action. A provider POST timeout after potential acceptance must not be automatically resubmitted. Reconcile provider history, attach the verified existing reference through a controlled, audited operator procedure, and resume polling. Do not invent a prediction ID or charge twice. The database outbox recovers failed event delivery; leases and capacity limits are persistent. See AI-PROVIDERS.md for thresholds and SQL inspection.

## Deletion and exports

Customers can revoke a try-on link and record a durable deletion request. Cleanup checks consent/session state again before delivering generated outputs. Failed deletion stays pending for retry. Default customer source retention is 24 hours; output access also ends at the session/asset limit. Garment and campaign files remain until authorized deletion. Do not put private media in shared caches or logs.

Account exports and account-deletion requests are recorded in `privacy_requests` for **operator review and fulfillment**; the initial release does not automatically delete Auth accounts, transfer workspace ownership or generate a complete legal data export. Review ownership, third-party rights, outstanding financial obligations, consent and applicable legal retention first. Deliver exports through an authorized short-lived channel. Record fulfillment and residual backup/provider retention. These manual steps are a release staffing requirement.

Never claim every upstream copy has been erased merely because an application object was deleted. Verify FASHN’s current retention/account terms and complete available upstream deletion procedures before making that assertion.
