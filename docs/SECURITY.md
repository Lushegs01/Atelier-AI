# Security, permissions and privacy

This is an implementation and verification record, not a guarantee of legal compliance or production security. Complete the staging release checks and qualified privacy/legal review before launch.

## Trust boundaries

The browser controls no trusted role, user ID, storage path, price or balance. Supabase Auth `getUser()` verifies the cookie session; tenant membership is read under RLS and checked on every protected request. Elevated modules import `server-only`. Public SSR configuration contains only Supabase's public URL/key. Service keys, Paystack secrets, AI keys and queue signing keys stay on the server.

| Role      | Read own workspace             | Upload/create/approve | Delete assets                | Buy credits | Manage brand/members               |
| --------- | ------------------------------ | --------------------- | ---------------------------- | ----------- | ---------------------------------- |
| Owner     | Yes                            | Yes                   | Yes                          | Yes         | Yes                                |
| Admin     | Yes                            | Yes                   | Yes                          | Yes         | Yes, excluding owners/other admins |
| Designer  | Yes                            | Yes                   | No                           | No          | No                                 |
| Assistant | Yes                            | No                    | No                           | No          | No                                 |
| Guest     | Only authorized try-on session | One consented try-on  | Own session deletion request | No          | No                                 |

Platform administrators require an active record in `platform_admins`; browser metadata and organization-owner status do not grant platform authority. Credit adjustment/refund SQL functions independently repeat this check. Bootstrap admins only from a trusted database console; there is no self-promotion endpoint.

Every tenant table has RLS. Normal clients have read-only tenant grants except their own selected profile fields and onboarding RPC. Financial/service RPCs are revoked from anon/authenticated. Composite foreign keys prevent cross-organization references, including garment/assets, jobs/outputs and guest sessions. Credit ledger rows cannot be updated/deleted, including by normal service code. Financial operations use account/job/payment locks and idempotent compensating entries.

## Request and file protection

- Browser mutations require exact same-origin requests; authentication cookies alone cannot authorize cross-origin forms.
- Zod validates IDs, enums, string lengths, integer money/credits and operation settings. JSON and multipart streams have byte bounds even when Content-Length is absent.
- Durable database rate-limit windows protect auth, uploads, generations, checkout, guest operations and administration. A failed limiter fails closed. Enable Supabase CAPTCHA, auth IP limits, verified email and production SMTP before public signup; application per-email limits alone cannot stop distributed account abuse.
- Upload authorization occurs before storage. Random keys are organization-prefixed; the client never supplies a storage path. Sharp checks magic bytes and genuinely decodes/re-encodes images, strips metadata, limits pixels/size, and generates private previews. No SVG, animated image or arbitrary remote image URL is accepted.
- Storage has no anonymous/authenticated object policies. Server helpers scope assets before issuing short-lived signed URLs. Generated outputs require their successful parent job before access. Deletion and expiry revoke subsequent signing; already issued links can remain usable for their short TTL if an object deletion is still pending.
- Provider outputs are fetched only from documented fixed HTTPS CDN hosts, without redirects, under size/time limits. Real output media is validated and copied into private storage before settlement. MP4 validation is a container/header bound check; staging playback remains required.

## Credits, payment and worker safety

Signed10min quote confirmations bind the authenticated actor, organization, selected assets, operation and options. The database compares the approved price/rule while reserving, preventing a stale quote from charging an increased price. Guest links persist the designer's quoted price. No purchase receives value on initialization or browser redirect. Paystack is independently verified, including domain/test mode, buyer, amount, currency and reference. Webhook HMAC-SHA512 covers the untouched raw body; duplicate events settle once.

Reservation, job creation and outbox insertion are one transaction. Workers use persistent provider identifiers, durable leases, bounded concurrency, retries and polling. A submission timeout with unknown outcome stays in a reconciliation state and is never automatically re-submitted. Ambiguous paid operations require an operator; this can intentionally retain a reservation until reviewed. Known failed/expired eligible work releases its reservation exactly once. Generated output bytes must exist before a job can be charged successfully.

## Customer photographs and deletion

Guest links contain256 bits of entropy; only their SHA-256 hash is stored. Each link has a bounded expiry, revocation and use limit. Guest routes return only the permitted branding/garment and the job for that exact session. Tokens must be treated as bearer credentials: share them only with the intended customer, never put them in analytics, support screenshots or application logs. Application error logs emit only a route group, error class and generic event.

Consent version `2026-10-24-v1` covers the requested visualization and third-party FASHN processing. Consent is recorded before private photo storage. Inputs and customer results default to24h retention. Consent is checked during queued/processing work and again after output transfer; raced revoked output is deleted. Session deletion records a durable privacy request before revoking access, withdrawing consent and attempting cleanup. Background cleanup retries session object deletion. Account deletion and exports enter an authorized review queue: owners, financial retention and backup obligations must be resolved before fulfilling them.

FASHN's documented policy retains request metadata (including input URL strings) until separately removed, while CDN outputs are scheduled for removal after three days. Input signed links expire quickly. No upstream deletion API is currently documented; do not claim upstream erasure from deleting our copy. Operators must contact FASHN's legal contact with relevant prediction IDs when fulfilling those requests. Provider subprocessors and terms require review for the launch jurisdiction. [FASHN retention documentation](https://docs.fashn.ai/api-overview/data-retention-privacy).

No customer image is publicly published, reused for promotion, or represented as a guaranteed fit/body measurement. Configure provider account agreements to prohibit unrelated training and verify their terms. Legal pages are initial drafts requiring business identity, contact details, processors, jurisdiction and qualified review.

## Required staging security checks

1. Use two real Supabase organizations plus owner/admin/designer/assistant, unauthenticated and guest sessions. Exercise direct REST reads/writes and every API boundary across tenants.
2. Verify Auth confirmation/recovery email links, refresh, expiry/logout, banned accounts, CAPTCHA and correct trusted redirects on the final HTTPS host.
3. Confirm the bucket is private and another tenant cannot fetch/sign its objects; expiry, deletion and service-worker offline behavior must hide customer photos and financial records.
4. Test concurrent reservation/purchases, duplicate webhook events, provider timeouts, transfer crashes, queue restarts, failed generations and consent withdrawal during transfer.
5. Run Paystack test checkout, verified callback, webhook retry and a full test refund. Confirm browser values never alter issued credits.
6. Run real FASHN jobs for each enabled Preview/Experimental model using authorized synthetic images and inspect fidelity, video playback, retention and price reconciliation.
7. Review admin audit trails, secret scanning, dependency audit, logging/Sentry redaction, backups and incident response before enabling live keys.

Local unit/database test evidence and actual commands are recorded in the release report. Live security behavior remains unverified until these staging checks pass.
