# Deployment guide

No deployment has been performed. Use a separate staging Supabase project, Paystack test account and non-production Inngest app first.

## Recommended runtime

Use a Node.js24 compatible Next.js host (Vercel or the supplied Dockerfile), Supabase PostgreSQL/Auth/private Storage, managed Inngest, an operator-hosted Qwen GPU service and Paystack. Native Sharp processing and server-only SDKs require the Node runtime. AI work is split into durable steps, not held inside a customer HTTP request. FASHN is an optional explicit backend, not a requirement for the Qwen path.

**The Next.js host does not run the Qwen model.** Provision the separate CUDA inference service from [inference/qwen/README.md](../inference/qwen/README.md). Open weights do not supply compute or free hosting. The available PC has Intel Iris Xe and has not performed model inference. Choose GPU hardware, memory/offload and queue settings through measured acceptance on your own host; no rental/purchase/deployment has been made here.

For Vercel, connect [Lushegs01/Atelier-AI](https://github.com/Lushegs01/Atelier-AI), use build command `npm run build`, and configure environment variables from `.env.example` in the hosting dashboard. The initial staging deployment still needs to be performed after setup.

Vercel Functions have a documented [4.5 MB request/response body limit](https://vercel.com/docs/functions/limitations). The default app upload cap is **4 MiB**, leaving room for multipart overhead. On a Node/Docker host the server can be configured up to 30 MiB, but the initial UI intentionally retains the safe 4 MiB ceiling. Configure proxy body limits consistently. Do not claim a higher supported limit without changing and testing both UI and server.

For a container host:

```text
docker build -t atelier-ai:staging .
docker run --rm -p 3000:3000 --env-file .env.staging atelier-ai:staging
```

Keep `.env.staging` outside Git. Supabase public values must also be supplied to a build if you later introduce browser-side direct Supabase calls. Current authentication uses server endpoints. Place the container behind HTTPS with private server secrets injected by the host. Inspect the supplied Dockerfile before use.

## Ordered staging setup

1. Create separate service accounts/projects; copy `.env.example` to a secure staging environment. Set the exact HTTPS application URL.
2. Review and apply both migrations in filename order to a new staging database. For an existing database with the initial migration, apply only the new provider-pinning upgrade. Verify RLS, grants and the `private-media` bucket. Enable Auth email confirmation, SMTP, bot protection, signup rate limits and exact auth redirects. Do not permit wildcard production callbacks.
3. Add a verified operator account to `platform_admins` through a trusted database administration session. Never expose this operation through the app.
4. Configure Inngest event and signing keys. Register the deployed `/api/inngest` endpoint. Verify the generation, recovery, outbox, maintenance and retention functions are active. Set `INNGEST_DEV=0` in staging/production.
5. Configure Paystack **test** credentials and `/api/payments/webhook`. Verify a test checkout, server verification, webhook replay, amount mismatch and exactly-once credits.
6. Provision the private Qwen CUDA service, set `AI_PROVIDER=qwen`, `QWEN_API_URL` and a matching random32+character `QWEN_API_KEY` on both service and web host. Use HTTPS and a private durable service volume. Verify actual model load, photo output, restart/idempotency, transfer and cleanup before enabling photographs. Qwen customer visualization is separately experimental; keep it disabled until assessed. Qwen has no video. Optional FASHN requires its own separately selected account/key, lifecycle/retention review and acceptance budget. The default free path needs only `AI_PROVIDER=huggingface` and a read-only `HF_TOKEN` from a free account, set as a server-side environment variable on the host; see [free Hugging Face Spaces](AI-PROVIDERS.md#free-hugging-face-spaces). The Inngest route declares `maxDuration = 300` so a Space result read (default 240 s) fits one invocation; on a host with a lower limit, set `HF_RESULT_WAIT_SECONDS` below it.
7. Review the provider-specific draft retail catalog. For Qwen, measure GPU processing/idle capacity, storage/network and failure costs; do not substitute FASHN credit rates or assume free compute. For optional FASHN review its purchased plan and FX. Include payment fees/margin, then enable reviewed rules/packages only after acceptance. No seeded rate is a launch price.
8. Configure monitoring, alert routing, retention and recovery ownership. Supply legal identity, support email, required privacy disclosures and final terms after qualified review.
9. Require `/api/ready` to return 200, complete the release checklist and record signed-off staging evidence. Readiness checks configuration, schema reachability and bucket privacy; it is not a successful provider/payment smoke test.
10. Authorize a production release, repeat configuration using separate production credentials, enable live payments explicitly, and deploy a reviewed commit. No automated tool here has published a live app.

## Register the Inngest endpoint

`YOUR-DOMAIN` means the HTTPS address where the Next.js application is deployed. A Vercel address such as `https://atelier-ai.vercel.app` works; the GitHub repository URL does not. Do not paste the literal placeholder.

1. Open the [Inngest dashboard](https://app.inngest.com) and select your intended staging or production environment.
2. Copy that environment's event key and signing key to the web host as `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`. Set `INNGEST_DEV=0`. Keep these values private.
3. Deploy/redeploy the web application so the endpoint and keys are live. If the deployment is protected, allow Inngest to reach this endpoint using the host's supported protection bypass setup.
4. In Inngest choose **Apps → Sync new app** and paste the deployed URL, for example `https://atelier-ai.vercel.app/api/inngest`.
5. Confirm app ID `atelier-ai` and five functions: generation, known-prediction recovery, outbox dispatch, stuck-job recovery and private-media cleanup.
6. Resync after function changes, or configure Inngest's Vercel integration to sync deployments automatically. A failed sync can be inspected under Unattached Syncs/App Diagnostics. Check that the signing key belongs to the intended environment.

See [Inngest's apps and syncs guide](https://www.inngest.com/docs/platform-and-operations/apps-and-syncs). Syncing schedules background work; it does not configure Supabase, payments or the Qwen GPU host.

## Rollback

Disable the affected generation flags or payment checkout before investigating financial/provider incidents. Restore the prior tested application image/deployment. Migrations are forward-managed; do not drop financial or audit tables to match an older binary. For schema changes use expand/migrate/contract releases and verified backups. Reconcile existing provider predictions and payments before retrying them.
