# Atelier AI implementation checklist

Target: a locally verified release candidate. Live deployment, provider acceptance and financial settlement require configured staging accounts; they are not inferred from mocked tests.

- [x] A: initialized Next.js / React / strict TypeScript, reusable design system and routes; local build/checks pass
- [x] B: editorial public site, authentication forms, studio and responsive workspace; local browser smoke passes
- [ ] C: implemented Supabase schema/policies/roles/private-media API; 47 SQL checks pass; hosted Supabase acceptance remains
- [ ] D: implemented provider registry, default operator-hosted Qwen image-edit path, optional FASHN adapter and durable jobs; actual GPU/provider/managed-queue acceptance remains. See QWEN-VERIFICATION.md for current evidence; the initial FASHN report remains historical.
- [ ] E: implemented transactional credits, signed quotes, Paystack verification/reconciliation; local tests pass; real test-account acceptance remains
- [ ] F: local isolation/consent/token/file/payment tests pass; hosted storage/auth and independent-connection security tests remain
- [ ] G: PWA shell and responsive Chromium checks pass; actual HTTPS device installation and broader accessibility review remain
- [x] H (local): checks, production build, operational docs and evidence-based report completed; external release checklist remains open

## Ownership and contracts

- Root: project setup, `src/components`, `src/features`, UI routes, shared environment and final assembly.
- Database agent: `supabase`, `src/server/billing`, billing/payment tests, database/payment documentation.
- Provider agent: `src/server/ai`, `src/server/storage`, `src/workers`, `/api/inngest`, AI/storage tests and provider documentation.
- API agent: `src/lib/supabase`, `src/server/auth`, `src/server/services`, `/api` except Inngest and payment handlers, auth callback, proxy, security/API tests and documentation.

Shared stack: Next.js App Router, React, strict TypeScript, Tailwind 4, Supabase SSR, Zod, Inngest, Sharp, Vitest, Playwright. Import alias `@/*` = `src/*`. `server-only` protects elevated modules. No credentials currently provided. All mutations fail closed unless configured. Demo mode is explicit, development-only and does not issue real value or claim generation.

Database naming: snake_case. Organization roles `owner | admin | designer | assistant`. Operation `photo | video | try_on`. Job states `queued | submitting | processing | retry_wait | succeeded | failed | cancelled`. Storage bucket `private-media`. Assets `id, organization_id, garment_id?, kind, storage_path, mime_type, byte_size, width, height, created_by, created_at`. Each service must scope records to organization_id and use trusted membership. API JSON errors `{ error: string, code?: string }` with non-2xx status. Mutations require same-origin checks and Zod validation.

Frontend contract: `/api/workspace` returns `{ configured, organization, role, garments, jobs, outputs, balance, ledger, payments, customers, tryOnSessions, packages }`. `/api/organizations` POST `{name}`; `/api/garments` POST multipart `{name,category,description,view,file}`; PATCH/DELETE `/api/garments/[id]`; POST `/api/generations/quote` and `/api/generations` `{organizationId,operation,garmentId?,sourceAssetId?,options,idempotencyKey}`. POST `/api/try-on` `{organizationId,garmentId,expiresInHours}`; GET/POST `/api/try-on/[token]` for guest info/consented upload; DELETE for consented deletion. POST `/api/payments/initialize` `{organizationId,packageId}` returns `{authorizationUrl}`; POST `/api/payments/verify` `{reference}`. POST `/api/auth/[action]` for login/signup/forgot-password/reset-password/logout. `/api/settings` PATCH `{section,values}`. POST `/api/privacy` `{type,reason?}`. `/api/admin/[resource]` authenticated platform allowlist.

## Visual foundation

Reference: https://dribbble.com/shots/27634034-AI-Fashion-App-Outfit-Style-Exploration (UIX Habib). Inspect actual shot before committing visual decisions. Restrained navy, blue-grey, cool white surfaces, generous spacing, rounded selectors and dominant editorial fashion imagery. Original garments remain the source of truth; scene/model options are explicitly separate. Empty accounts show real empty states. Illustrative images are labeled.
