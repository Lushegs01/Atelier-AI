# API and application contracts

All API records come from Supabase. There is no simulated authentication, purchase settlement or AI output endpoint. In an unconfigured local environment, `GET /api/workspace` and `GET /api/pricing` return `configured:false` and empty records. Protected mutations fail closed.

Responses use JSON and `Cache-Control: private, no-store`. Errors are non-2xx `{error,code}`; validation may include field names. Every browser mutation requires an exact `Origin` matching `NEXT_PUBLIC_APP_URL` (or the current request origin in local configuration). The Paystack webhook instead authenticates its raw body cryptographically. Body streams are bounded independently of Content-Length.

## Authentication and workspace

| Endpoint                                        | Request / behavior                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST `/api/auth/signup`                         | `{email,password,name?,captchaToken?}`; password 12–128 chars; verification email uses Supabase                                                                          |
| POST `/api/auth/login`                          | `{email,password,captchaToken?}`; cookie session                                                                                                                         |
| POST `/api/auth/forgot-password`                | `{email,captchaToken?}`; generic response avoids account enumeration                                                                                                     |
| POST `/api/auth/reset-password`                 | `{password}` in a verified authenticated recovery session                                                                                                                |
| POST `/api/auth/logout`                         | Revoke refresh session and clear cookies                                                                                                                                 |
| GET `/auth/callback`                            | PKCE code or supported token hash; relative redirects only                                                                                                               |
| POST `/api/organizations`                       | `{name}`; authenticated transactional organization/owner/credit-account creation                                                                                         |
| GET `/api/workspace?organizationId=UUID&page=1` | Membership verified, page size24; organization, user, role, garments, jobs, outputs, available/reserved balance, ledger, payments, customers, sessions, enabled packages |
| GET `/api/organizations/members`                | Owner/admin only; registered user IDs and roles                                                                                                                          |
| POST `/api/organizations/members`               | `{organizationId?,userId,role}`; add/change an existing verified account; no email sent; only owners may appoint admins                                                  |
| DELETE `/api/organizations/members`             | `{organizationId?,userId}`; cannot remove owners or self; admins cannot remove other admins                                                                              |

Supabase Auth validates sessions on the server with `getUser()`. Browser metadata is never a permission source. `src/proxy.ts` refreshes cookies and protects workspace/admin navigation. An organization can be created after verified signup; interrupted onboarding resumes naturally from the absence of membership. Platform admin APIs additionally require `platform_admins.active` in the protected database table.

## Garments, media and generations

| Endpoint                              | Request / behavior                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST `/api/garments`                  | Multipart `file,name,category,description?,collection?,view?,organizationId?`; genuine decoding and normalization before private persistence                    |
| GET/PATCH/DELETE `/api/garments/[id]` | Scoped read; edit/archive; authorized deletion of source assets and garment soft deletion                                                                       |
| POST `/api/garments/[id]`             | Multipart `file,view`; add another source view                                                                                                                  |
| GET `/api/assets/[id]`                | `{url}` signed for120sec after membership+asset ownership checks; no browser storage path accepted                                                              |
| DELETE `/api/assets/[id]`             | Owner/admin authorized object removal and soft deletion                                                                                                         |
| POST `/api/generations/quote`         | `{organizationId?,operation,garmentId?,sourceAssetId?,options}` -> `{quote,quoteToken,capabilities}`                                                            |
| POST `/api/generations`               | Same settings plus `{idempotencyKey,quoteToken}`; signed10min confirmation binds actor, organization, inputs and options; SQL rejects changed prices atomically |
| GET `/api/generations/[id]`           | Sanitized job and completed authorized outputs; browser polling never submits work                                                                              |
| PATCH `/api/generations/[id]`         | `{outputId,approved}`; approval required before animating generated images                                                                                      |
| DELETE `/api/generations/[id]`        | Delete completed output assets; never cancels a submitted provider operation                                                                                    |

Categories: `dress,top,bottom,outerwear,accessory,other`. Views: `front,back,side,detail,mannequin,hanger,flat-lay`; full-garment workflows accept front/mannequin/hanger/flat-lay only. Photo options describe the adult model, pose and scene separately from the garment. Pricing currently permits one balanced1k image per request. Video options support5/10sec and480p/720p/1080p. Generated video sources require an approved photo; originals must be compatible images at least301×301px.

Generation reservation creates a job, immutable ledger entry and outbox in one transaction. HTTP dispatch may fail after commit without losing the job. Retrying the same request must use the same idempotency key and same inputs. A changed payload requires a new quote/key. Unsupported or disabled provider capabilities return503 before credit reservation.

## Guest try-on

| Endpoint                           | Request / behavior                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST `/api/try-on`                 | `{organizationId?,garmentId,expiresInHours?}` -> one-time displayed `{url,token,session,estimatedCredits}`; expiry1–168h, default72h                        |
| DELETE `/api/try-on/sessions/[id]` | Designer revocation; organization scoped                                                                                                                    |
| GET `/api/try-on/[token]`          | Only permitted brand/garment, this session's job/results and consent version; no tenant IDs, token hash, billing or other sessions                          |
| POST `/api/try-on/[token]`         | Multipart `file,consent=true,consentVersion=2026-10-24-v1`; accepted consent recorded before storage; session use+credit reservation atomic                 |
| DELETE `/api/try-on/[token]`       | JSON `{reason?}`; valid bearer token can request deletion even after natural expiry; access revoked, consent withdrawn and durable privacy cleanup recorded |

Tokens are32 random bytes, only SHA-256 hashes are persisted. A completed session can view its own result until expiry/revocation; it cannot submit again. The link stores the designer-approved credit price and rejects changes before spending. Input and resulting customer images expire after24h by default (configuration bounded1–720h). There is no public result publishing or promotional reuse consent. See `AI-PROVIDERS.md` for upstream retention limits.

## Billing, settings and administration

| Endpoint                           | Request / behavior                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET `/api/pricing`                 | Public sanitized catalog; disabled/unreviewed rules labeled provisional; no internal costs                                                                                                                                                             |
| POST `/api/payments/initialize`    | `{organizationId?,packageId}`; owner/admin; returns trusted checkout URL/reference                                                                                                                                                                     |
| POST `/api/payments/verify`        | `{organizationId?,reference}`; verifies scoped transaction with Paystack before exactly-once credit settlement                                                                                                                                         |
| POST `/api/payments/webhook`       | Raw signed Paystack event; reference/amount/currency/domain/customer independently verified                                                                                                                                                            |
| POST `/api/customers`              | `{organizationId?,name,email?,notes?}`; minimal tenant-owned records                                                                                                                                                                                   |
| PATCH/DELETE `/api/customers/[id]` | Scoped update/removal                                                                                                                                                                                                                                  |
| GET `/api/settings`                | Own profile/email                                                                                                                                                                                                                                      |
| PATCH `/api/settings`              | `{section,organizationId?,values}`; profile `{fullName}`; organization `{name,dailySpendingLimit?}`; brand `{brandName,brandColor}`; security `{signOutOtherSessions:true}`                                                                            |
| POST `/api/privacy`                | `{type,organizationId?,reason?}`; types `export_data,delete_account,delete_customer_data,report_problem` (`export` alias accepted); durable reviewed request                                                                                           |
| GET `/api/admin/[resource]`        | Protected resources `overview,users,organizations,jobs,payments,providers,pricing,audit,privacy`; page size50                                                                                                                                          |
| POST `/api/admin/[resource]`       | Reason min10 chars mandatory. Credits `adjust`; payments `reconcile,request_refund,reconcile_refund`; pricing `update` with explicit reviewed flag; organizations `set_spending_limit`; users `suspend,unsuspend`; jobs `resume` known prediction only |
| GET `/api/health`                  | Process liveness, no external dependencies                                                                                                                                                                                                             |
| GET `/api/ready`                   | Configuration, database schema and private bucket checks;503 until ready                                                                                                                                                                               |

See source route schemas for exact administrative action fields. Full refunds require all purchased credits to be unspent, reserve their reversal transactionally, and never repeat an ambiguous external submission. Platform configuration flags are server environment settings; pricing rules can disable individual operations without publishing an unrelated change. See `PAYMENTS.md`.

## Verification boundary

API unit tests use clearly identified synthetic users, mocked transport and test doubles. Database tests execute actual PostgreSQL policies/functions in PGlite with auth/storage harness schemas. Neither is evidence of Supabase Auth emails, live PostgREST, hosted storage signing, Inngest delivery or Paystack/FASHN acceptance. The staged browser workflows require configured test accounts and must pass before release.
