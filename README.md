# Atelier AI

A modular Next.js fashion-content application with Supabase authentication, PostgreSQL tenant isolation, private media, operator-hosted Qwen Image Edit, durable Inngest jobs and Paystack prepaid credits. FASHN remains an optional separately configured adapter.

**Status:** implemented for local verification and controlled staging setup. No external credentials were supplied. No live payment, AI generation or deployment has been verified. All model capabilities and draft price rules are disabled by default. Do not launch until the [release checklist](docs/RELEASE-CHECKLIST.md) passes.

## Run locally

Prerequisites: Node.js 24 LTS, npm and Git. Docker is needed only for a local Supabase stack; SQL tests use embedded PostgreSQL through PGlite without Docker.

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Open the Local URL printed by Next.js. If port 3000 is occupied, Next chooses the next port. Set `NEXT_PUBLIC_APP_URL` to that exact origin for authenticated mutations and callback URLs. With no Supabase configuration, development shows an explicitly unconfigured empty workspace; mutations fail closed. Production rejects protected workspace pages without authentication configuration. No fake credits, purchases or completed generations are created.

## Database and external services

```powershell
npx supabase start
npx supabase db reset
```

These commands need Docker and apply the migration plus disabled seed catalog to the **local** database. For a reviewed staging project:

```powershell
npx supabase login
npx supabase link --project-ref YOUR_STAGING_PROJECT_REF
npx supabase db push --dry-run
npm run db:migrate
```

Never point a reset command at production. The remote migration creates tables and catalog rows; local `seed.sql` is for CLI resets. Configure Supabase email verification, SMTP, redirect allowlists and abuse controls. Add the Supabase URL, public key and server-only service credential to `.env.local` using `.env.example`. See [database setup](docs/DATABASE.md).

The default `AI_PROVIDER=qwen` uses `Qwen/Qwen-Image-Edit-2511` through a separate GPU inference service. Its [Apache-2.0 weights](https://huggingface.co/Qwen/Qwen-Image-Edit-2511) do not include free compute or hosting. No paid model-provider account is required for this path; you must supply a compatible GPU host or GPU machine. This PC’s Intel Iris Xe is not the CUDA GPU runtime required by the supplied service. No actual model inference has been performed here.

Provision the service using [the inference guide](inference/qwen/README.md), protect it with a random shared token, and set `QWEN_API_URL` plus `QWEN_API_KEY` in the web app. The same token must be injected into the GPU service. `QWEN_API_KEY` is your own service credential, not a purchased vendor API key. Use HTTPS; the explicit insecure-local exception is development-only. Enable photographs only after an authorized real-output acceptance test. Customer visualization has a separate experimental flag and is not a validated fitting model. **Qwen cannot generate video.**

**Free option without a GPU:** set `AI_PROVIDER=huggingface` and a free Hugging Face read token as `HF_TOKEN`. Jobs then run on public ZeroGPU Spaces within that account's daily GPU quota: photos, customer try-on and 5-second 480p video. Run `npm run db:migrate` so the database accepts the provider, then enable its reviewed prices. See [AI providers](docs/AI-PROVIDERS.md#free-hugging-face-spaces). The [imported branch report](docs/HUGGINGFACE-VERIFICATION.md) records the original live check.

Configure Inngest credentials, then run the official Inngest dev server:

```powershell
npx inngest-cli@latest dev -u http://localhost:3000/api/inngest
```

Set `INNGEST_DEV=1` only for that local runtime. Review GPU-host privacy, measured processing costs and image quality, then enable each generation flag and its reviewed price rule independently. Credits remain prepaid commercial accounting; an open model does not issue free credits. For the optional FASHN path, explicitly set `AI_PROVIDER=fashn` and supply its key; historical jobs stay pinned to their original backend. Payment test credentials must be Paystack test keys. Live keys are rejected unless explicitly enabled. Detailed setup: [AI](docs/AI-PROVIDERS.md), [payments](docs/PAYMENTS.md), [deployment](docs/DEPLOYMENT.md).

## Verification

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run db:validate
npx playwright install chromium
npm run test:e2e
npm run scan:secrets
npm audit --audit-level=high
npm run build
npm start
```

Playwright starts or reuses an **unconfigured development server on port 3001**. Do not run it against a configured customer workspace. Browser smoke tests cover the real local interface, denial states and PWA shell; they do not pretend to verify external integrations. PGlite executes actual SQL policies and RPCs with substituted Supabase auth/storage schemas. Independent database connections, hosted auth and storage, provider requests and payment delivery still need staging acceptance.

## Project map

```text
src/app/                 public, designer, guest and admin routes; server API
src/components/          shared accessible controls, shells and PWA handling
src/features/            authentication, studio, library, billing and guest UI
src/lib/                 environment, SSR clients, utility and monitoring configuration
src/server/auth/         verified identities, roles, origin checks and CSP
src/server/billing/      pricing, ledger services, Paystack and margin calculations
src/server/ai/           provider registry, Qwen and optional FASHN adapters
src/server/storage/      bounded decoding, private media and signed authorization
src/server/services/     tenant-scoped application services
src/workers/             durable generation, outbox, recovery and privacy cleanup
supabase/                SQL migration, policies, functions and disabled seed catalog
tests/                   SQL, domain, adapter, service, security and browser tests
docs/                    operational guides and release evidence
inference/qwen/          separate authenticated Python GPU inference service
```

The interface follows the supplied Dribbble reference: cool whites, navy and blue-grey, rounded photographic cards, restrained selectors and editorial serif accents. Public imagery is clearly labeled illustrative stock photography. Attribution and design mapping are in [design notes](docs/DESIGN.md).

## Release documentation

- [Architecture](docs/ARCHITECTURE.md), [API](docs/API.md), [database](docs/DATABASE.md)
- [Security and privacy](docs/SECURITY.md), [payments and reconciliation](docs/PAYMENTS.md)
- [AI provider lifecycle and recovery](docs/AI-PROVIDERS.md)
- [Deployment](docs/DEPLOYMENT.md), [backup and recovery](docs/RECOVERY.md)
- [External requirements](docs/EXTERNAL-REQUIREMENTS.md), [release checklist](docs/RELEASE-CHECKLIST.md)
- [Verification report](docs/VERIFICATION.md)
- [Qwen transition verification](docs/QWEN-VERIFICATION.md); historical FASHN evidence above is not proof of Qwen inference
