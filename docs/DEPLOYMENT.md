# Deployment guide

No deployment has been performed. Use a separate staging Supabase project, Paystack test account and non-production Inngest app first.

## Recommended runtime

Use a Node.js 24 compatible Next.js host (Vercel or the supplied Dockerfile), Supabase PostgreSQL/Auth/private Storage, managed Inngest, FASHN and Paystack. Native Sharp processing and server-only SDKs require the Node runtime. AI work is split into durable steps, not held inside a customer HTTP request.

For Vercel, connect a reviewed Git repository, use build command `npm run build`, and configure environment variables from `.env.example` in the hosting dashboard. This repository has not been pushed to a remote. The operator must authorize and perform the initial staging deployment after setup.

Vercel Functions have a documented [4.5 MB request/response body limit](https://vercel.com/docs/functions/limitations). The default app upload cap is **4 MiB**, leaving room for multipart overhead. On a Node/Docker host the server can be configured up to 30 MiB, but the initial UI intentionally retains the safe 4 MiB ceiling. Configure proxy body limits consistently. Do not claim a higher supported limit without changing and testing both UI and server.

For a container host:

```text
docker build -t atelier-ai:staging .
docker run --rm -p 3000:3000 --env-file .env.staging atelier-ai:staging
```

Keep `.env.staging` outside Git. Supabase public values must also be supplied to a build if you later introduce browser-side direct Supabase calls. Current authentication uses server endpoints. Place the container behind HTTPS with private server secrets injected by the host. Inspect the supplied Dockerfile before use.

## Ordered staging setup

1. Create separate service accounts/projects; copy `.env.example` to a secure staging environment. Set the exact HTTPS application URL.
2. Review and apply the migration to a new staging database. Verify RLS, grants and the `private-media` bucket. Enable Auth email confirmation, SMTP, bot protection, signup rate limits and exact auth redirects. Do not permit wildcard production callbacks.
3. Add a verified operator account to `platform_admins` through a trusted database administration session. Never expose this operation through the app.
4. Configure Inngest event and signing keys. Register the deployed `/api/inngest` endpoint. Verify the generation, recovery, outbox, maintenance and retention functions are active. Set `INNGEST_DEV=0` in staging/production.
5. Configure Paystack **test** credentials and `/api/payments/webhook`. Verify a test checkout, server verification, webhook replay, amount mismatch and exactly-once credits.
6. Configure a FASHN account, review terms/retention and fund a small test budget. Photo and try-on are Preview, video Experimental. Enable one flag at a time after real capability acceptance. Verify input URLs, output allowlist, copying, video playback and failures.
7. Review the draft retail catalog, current provider credit costs, account discount, FX, fees and margin. Add reviewed provider cost estimates and enable reviewed rules/packages only after acceptance. No seeded rate is a launch price.
8. Configure monitoring, alert routing, retention and recovery ownership. Supply legal identity, support email, required privacy disclosures and final terms after qualified review.
9. Require `/api/ready` to return 200, complete the release checklist and record signed-off staging evidence. Readiness checks configuration, schema reachability and bucket privacy; it is not a successful provider/payment smoke test.
10. Authorize a production release, repeat configuration using separate production credentials, enable live payments explicitly, and deploy a reviewed commit. No automated tool here has published a live app.

## Rollback

Disable the affected generation flags or payment checkout before investigating financial/provider incidents. Restore the prior tested application image/deployment. Migrations are forward-managed; do not drop financial or audit tables to match an older binary. For schema changes use expand/migrate/contract releases and verified backups. Reconcile existing provider predictions and payments before retrying them.
