# Release checklist

Local code and tests are not sufficient for a public launch. Check each item with actual staging evidence and record the reviewer, date, environment and reference. Never count a mock test as external acceptance.

- [ ] Formatting, lint, strict TypeScript, automated tests, SQL validation, secret scan, dependency audit and production build pass on the release commit.
- [ ] Hosted Supabase signup, email confirmation, reset, refresh, logout, onboarding and resumable organization creation verified.
- [ ] Two organizations/all roles/unauthenticated customer cannot cross-read, write, delete, sign or download records/media; no browser role escalation or admin access.
- [ ] Garment upload/front/back/detail/library/search/archive/deletion and hosted ownership checks verified with synthetic authorized images.
- [ ] Real operator-hosted Qwen photo editing verified on the selected CUDA host, with garment comparison/approval, restart/idempotency, output transfer, measured compute cost and private cleanup. Unit/CPU service tests are not GPU evidence.
- [ ] Qwen customer visualization separately assessed as experimental image editing; actual provider-specific consent/retention verified. Disable it if fidelity or privacy is unacceptable. Qwen video remains unavailable.
- [ ] If optional FASHN is selected, verify only its enabled photo/try-on/video models, lifecycle flags, private transfer, cost and video playback. Existing jobs/sessions stay pinned across provider changes.
- [ ] Inngest jobs survive browser closure/restarts, obey concurrency, recover outbox and stuck work; ambiguous accepted submissions reconcile without resubmission.
- [ ] Real Paystack test checkout/verify/webhook replay/delayed event/mismatch/refund tests complete; verified purchases issue credits once; ledger reconciles under independent database connections.
- [ ] Failure, output-transfer error, insufficient balance, duplicate submission, reservation expiry and simultaneous purchases/jobs tested against hosted infrastructure.
- [ ] Guest consent/review/use limits/expiry/revocation/deletion and signed URL expiration verified. Consent withdrawal during provider work cannot expose results.
- [ ] Desktop/tablet/mobile browser tests, keyboard focus, reduced motion, contrast and touch controls reviewed. Safari and Android installation tested over HTTPS.
- [ ] Service worker caches only public offline shell/icons; private photos, APIs, financial records and authenticated pages excluded.
- [ ] Current provider pricing/retention and terms reviewed; retail catalog approved and enabled; live checkout separately authorized.
- [ ] Legal/support details completed; account export/deletion operator process staffed; privacy cleanup/alerts verified.
- [ ] HTTPS host limits, exact redirect origins, Sentry scrubbing, readiness, backups/object recovery and rollback drill complete.
- [ ] Production deployment explicitly authorized and performed from a reviewed commit; live smoke evidence recorded separately.
