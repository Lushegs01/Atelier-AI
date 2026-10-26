# AI providers and durable execution

The default backend is the free Hugging Face Spaces provider. Operator-hosted `Qwen/Qwen-Image-Edit-2511` and FASHN remain selectable and are never an automatic fallback. Web adapter and Python contract tests are not proof of successful GPU inference. No real Qwen output, GPU deployment or paid FASHN prediction has been verified here. See the current [Qwen report](QWEN-VERIFICATION.md) and preserved [initial report](VERIFICATION.md).

## Capabilities

| Backend                   | Photographs                               | Customer visualization                                                             | Video                                   |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------- |
| Qwen Image Edit (default) | Experimental garment-guided image editing | Separately enabled experimental multi-image editing, not a validated fitting model | Unsupported regardless of feature flags |
| FASHN (optional)          | `product-to-model`, Preview               | `tryon-max`, Preview                                                               | `image-to-video`, Experimental          |
| Hugging Face (default)    | Experimental, Qwen-Image-Edit Space       | Experimental, Leffa Space                                                          | Experimental, 5-second Wan 2.2          |

All flags default false. A backend, its operation flag and its reviewed provider-specific price rule must be enabled before spending credits. New work follows `AI_PROVIDER=huggingface|qwen|fashn` (default `huggingface`); existing jobs and invitations preserve their selected provider/model. Missing Qwen credentials never route a photograph to FASHN. The UI identifies the actual pinned provider before customer consent.

Qwen is a general image editor, not a specialized garment-fitting system with demonstrated parity. It may alter construction, print, embellishment, body, pose or likeness. Compare every output with the original. Customer photographs cannot be used for campaign animation or unrelated reuse. No claim of accurate fit, exact identity preservation or measured fidelity is made.

The [official model card](https://huggingface.co/Qwen/Qwen-Image-Edit-2511) publishes Apache-2.0 weights and multi-image editing through `QwenImageEditPlusPipeline`. That license does not include GPU compute, hosting, storage or model-quality guarantees. Review model/dependency licenses, input rights and infrastructure terms for release.

## Free Hugging Face Spaces

`AI_PROVIDER=huggingface` (the default) runs jobs on public ZeroGPU Spaces with a free Hugging Face **read** token, without a GPU of your own. It suits development, demos and low volume. The exact contracts were re-verified on 26 October 2026; see [Hugging Face verification](HUGGINGFACE-VERIFICATION.md).

| Operation                     | Default Space                           | Pinned model             | What it accepts and returns                                                                  |
| ----------------------------- | --------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| Fashion photographs           | `multimodalart/Qwen-Image-Edit-Fast`    | `Qwen/Qwen-Image-Edit`   | One garment photo + a written direction; about 1 megapixel, same shape as the input photo    |
| Virtual try-on                | `franciszzj/Leffa`                      | `franciszzj/Leffa`       | Person photo + garment photo, no text prompt; both letterboxed (never cropped) to 768 × 1024 |
| Fashion video (from an image) | `zerogpu-aoti/wan2-2-fp8da-aoti-faster` | `Wan-AI/Wan2.2-I2V-A14B` | One approved image + a motion preset; 5 s, 16 fps MP4, 480–832 px per side                   |

### Set it up

1. Use a **free** Hugging Face account. Create a **read-only** token at <https://huggingface.co/settings/tokens>. Hugging Face bills PRO, Team and Enterprise accounts with pre-paid credits automatically once their daily quota runs out, so do not use an account with a credit balance if the workflow must stay free. The token is sent to every Space the app calls; never use a write token.
2. Put it on the server only: `HF_TOKEN` in `.env.local` locally, and as an encrypted environment variable on the web host (Vercel → Project → Settings → Environment Variables). Never prefix it with `NEXT_PUBLIC_`; the browser never talks to Hugging Face.
3. Keep `AI_PROVIDER=huggingface` and enable only the flags you have accepted: `ENABLE_PHOTO_GENERATION`, `ENABLE_TRY_ON`, `ENABLE_VIDEO_GENERATION`.
4. Apply migrations `202610250002_huggingface_provider.sql` and `202610260001_huggingface_spaces_hardening.sql` to staging first (`npx supabase db push --dry-run`, then `npm run db:migrate`).
5. Review and enable the three disabled price rows in **Admin → Pricing**. Their FASHN-credit and GPU-cost fields are zero because the provider bills nothing; the customer credit price is your decision and is not set to zero automatically.
6. Optionally point `HF_PHOTO_SPACE`, `HF_TRY_ON_SPACE` and `HF_VIDEO_SPACE` at duplicates of the Spaces in your own account (same API). Only operator configuration chooses Spaces; browsers cannot supply a Space or URL.

### How a job runs

1. The designer reviews a quote and, for this provider, ticks the third-party processing notice (version `2026-10-26-hf-spaces-v1`). The server and the reservation SQL both refuse a Hugging Face job without it, and the version is stored on the job and in the audit log. Customers give their own versioned consent (`2026-10-26-huggingface-v2`) on the invitation page.
2. Credits are reserved, the job is pinned to provider and model, and Inngest picks it up. One organization runs one job at a time; at most three Hugging Face jobs run at once across the deployment.
3. Before sending, the worker reads the Space's runtime stage. A sleeping or starting Space is woken and retried later (bounded, three attempts); a paused or broken Space is never sent work.
4. The worker records a deterministic receipt (the Gradio session hash, derived from the job id and attempt) **before** the POST, then calls `/gradio_api/call/<endpoint>` with that session hash.
5. After a delay (15 s photo, 30 s try-on, 45 s video), the worker opens `/gradio_api/queue/data?session_hash=…` once and holds it until the final message, for up to `HF_RESULT_WAIT_SECONDS` (default 240 s). The Space buffers results while nobody is reading, but closing a stream before completion cancels the job, so the stream is never used for polling.
6. A completed result's URL (on the same Space host only) is recorded in a service-only table, then the bytes are downloaded with the token, size-bounded, decoded (images) or checked for a browser-playable H.264/AV1/VP9 track with a positive duration (video), and stored privately. Only then is the job marked succeeded and the credit settled. The temporary URL is deleted when the job finishes.

### Duplicate requests and recovery

- One idempotency key per reviewed quote: double clicks, refreshes and repeated submissions return the same job. The studio also blocks a second request while a job from the same garment or image is running, and every confirmed request carries its own seed so "create another version" really is a new image.
- An unconfirmed POST (network error, gateway 5xx) is **not** resent. The receipt is read: if the Space has the job, its result is collected; if Gradio answers `session_not_found`, the job fails as not returned and its credits are released. A definite rejection (429, 503) withdraws the receipt and retries under a new one, at most three times.
- If an output copy fails, only the copy is retried from the recorded URL; inference is never repeated. An output the Space no longer serves (404/410), an untrusted host or an unplayable video fails the job and releases credits.
- If a worker dies, the maintenance sweep recovers jobs with a receipt that have been idle for 30 minutes by reading the receipt again (never by submitting). Two readers on one Space session would cancel the job, which is why that threshold exceeds a worker's bounded reads.

### Quota and availability

Daily ZeroGPU quota per account (from the [ZeroGPU documentation](https://huggingface.co/docs/hub/spaces-zerogpu)): unauthenticated 2 minutes, free account 5 minutes, PRO 40 minutes. It resets 24 hours after the first GPU use. A Space reserves GPU time before it runs (Qwen 60 s, Leffa 120 s, Wan about 100 s at 5 s and 624 × 832), so a job is refused if less than that remains even though the time actually consumed is usually smaller. All tenants share the deployment's one token.

When a Space reports `ZeroGPU quota exceeded`, the job fails with `provider_quota_exceeded` and its credits are released. For the next 10 minutes new Hugging Face requests are refused before any credit is reserved, and queued jobs fail fast with `provider_quota_cooldown` without contacting the Space (a separate code, so local refusals never extend the cooldown). This is a cooldown after an observed refusal, not a remaining-quota estimate; Hugging Face does not expose one. Queue timeouts (`No GPU was available`) map to `provider_busy`. Users see "Free AI quota exhausted" or "Provider temporarily unavailable" with a manual "try again" link, never a placeholder result.

### Fidelity

- Photo directions (`faithful`, `editorial`, `lifestyle`, `product`) are written prompt presets for the same model. Every one ends with an instruction to keep colours, texture, print, embroidery, embellishments, seams, closures, logos and silhouette unchanged. Text cannot force that; review every output against the original, which the review page shows beside it.
- The Space downloads each source through a private signed URL valid for at most 15 minutes. If a busy Space queues a job longer than that, the download fails and the job is released as `provider_failed`.
- The Space's own prompt rewriter (which would send the image to a further hosted language model) is switched off.
- Video uses only server-owned presets (subtle movement, fabric in motion, slow push-in) with a consistency clause and a negative prompt against outfit changes, turns and fast motion. Free-text motion is refused for this provider. Temporal garment consistency has not been evaluated.
- Sources are refused rather than cropped: Wan centre-crops images narrower than about 9:16 or wider than about 16:9, so those are rejected; video sources need 480 px per side; try-on person photos must be portrait or square; photo and try-on garment images need 256 px per side.

### Privacy

Public Spaces run code chosen by their owners on Hugging Face infrastructure and are not private or isolated environments. The Qwen Space prints prompts to its logs. Neither Hugging Face nor the Space owner offers this application a deletion API, so the app does not promise remote deletion; it deletes its own copies. Before real customer photographs, duplicate the Spaces privately into your own account and review the [Hugging Face privacy policy](https://huggingface.co/privacy) and [terms](https://huggingface.co/terms-of-service). Logs record job ids and error codes only, never tokens, signed URLs, prompts with customer data or upstream error text.

### Diagnosing errors without exposing secrets

| Job `error_code`                                             | Meaning                                                     | What to do                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| `provider_quota_exceeded`                                    | ZeroGPU daily quota used up                                 | Wait for the reset; check the account's usage page                        |
| `provider_busy`, `provider_unavailable`, `provider_starting` | Space busy, sleeping, paused or full                        | Check the Space page; retry later                                         |
| `provider_auth_failed`                                       | Token rejected                                              | Recreate the read token; check it is set on the server                    |
| `provider_endpoint_missing`                                  | The Space no longer offers the expected API                 | Re-verify the contract (`/gradio_api/info`) before changing the adapter   |
| `provider_timeout`, `provider_result_unavailable`            | No result within the read window, or the Space lost the job | Retry; lower load or raise `HF_RESULT_WAIT_SECONDS` within the host limit |
| `provider_invalid_output`, `provider_output_expired`         | Output untrusted, undecodable, unplayable or gone           | Retry; inspect with the live smoke test                                   |

Inspect a Space's contract without credentials or GPU use: `curl https://<space-host>.hf.space/gradio_api/info` and `curl https://huggingface.co/api/spaces/<owner>/<name>/runtime`.

### Testing

- `npm test` covers the adapter, worker and request paths with HTTP and database test doubles; it never contacts Hugging Face.
- `npm run test:e2e` drives the real pages with intercepted API responses; it proves wiring and honest states, not model output.
- `HF_LIVE_SMOKE=1 HF_TOKEN=hf_... npm run smoke:hf -- photo` (or `try_on`, `video`, `all`) runs the real Spaces through the application adapter with the public MIT-licensed Leffa example images, validates the returned bytes as the worker does, and writes them to `smoke-output/`. It spends real quota and is never part of CI. Passing it is live provider evidence; production acceptance still needs a staged end-to-end run with Supabase, Inngest and storage.

## Provision Qwen

The authenticated Python inference service is in `inference/qwen/`. Its [README](../inference/qwen/README.md) contains exact dependencies, model revision, environment, CUDA/Docker startup and CPU test commands. A compatible CUDA GPU runtime is required. This PC has Intel Iris Xe and has not performed model inference. Memory, offload, cold start, throughput and safe concurrency must be measured on the chosen host; no hardware sizing benchmark is claimed.

Set these web-app server values:

```dotenv
AI_PROVIDER=qwen
QWEN_API_URL=https://YOUR_PRIVATE_GPU_HOST
QWEN_API_KEY=
QWEN_ALLOW_INSECURE_LOCAL=false
ENABLE_PHOTO_GENERATION=false
ENABLE_TRY_ON=false
ENABLE_VIDEO_GENERATION=false
```

Generate a random shared token of at least32 characters and inject the same value into the GPU service. This is your service secret, not a purchased vendor API account. Never commit it. The endpoint stays server-only; browsers cannot select arbitrary inference hosts. Production requires HTTPS. The explicit insecure-local exception permits development localhost only.

The GPU service needs separate private persistent job/output storage, a bounded queue, a stable model revision and exclusive inference-worker ownership. Its `QWEN_PUBLIC_URL` must match the reachable configured endpoint; `QWEN_DATA_DIR`, retention, queue and offload values belong to that service, not Vercel. Protect its logs, disks, caches, snapshots and access as customer-data systems.

1. Choose an operator-controlled compatible GPU machine/host. No hardware purchase, hosting account or deployment has been made here.
2. Build/run the service using its README, private durable volumes and a secret manager.
3. Expose authenticated HTTPS to the Next.js worker and verify authenticated readiness. Health is not an image-generation test.
4. Configure the endpoint/shared token on Next.js and apply the provider-aware migration before new work.
5. Run authorized synthetic garment images through actual GPU editing, restart/replay, private output transfer and deletion.
6. Measure processing cost, review/enable the Qwen photo price rule, then enable photographs. Keep customer visualization disabled until its separate privacy/fidelity assessment passes. Video stays unavailable for Qwen.

## Costs and settings

Atelier credits are commercial prepaid units. Qwen does not consume FASHN billing credits; this does not mean zero infrastructure cost. Measure GPU processing and idle capacity, storage/network, failed work, payment fees and margin. Record cost estimates in integer monetary units and keep unknown costs unknown. Do not advertise free hosted inference or automatically grant free credits.

The initial image workflow requests one image with a roughly1K target. Qwen applies its own image-edit pipeline; optional FASHN uses the documented balanced1k envelope. Settings and pricing variants are server-owned, so a client cannot increase output count or choose unpriced expensive modes. Accepted full-garment views are front, mannequin, hanger and flat-lay. Back/side/detail views remain library references.

For optional FASHN, documented balanced1k image output uses two provider credits. Its5sec video uses1/3/6 provider credits at480p/720p/1080p, doubled at10sec. Account discounts and FX require a current cost review before enabling rules. A provider change never rewrites historical costs or ledger entries.

## Durable lifecycle

1. Verify actor or guest, tenant permission, source ownership, compatible settings and selected backend capability.
2. Return a signed ten-minute quote bound to actor, organization, operation, inputs, settings and price. SQL repeats the price check atomically. Guest links preserve their approved price/provider.
3. In one transaction, reserve credits, create the provider-pinned job and write the outbox. No provider submission precedes commit.
4. Inngest delivers events, claims persistent capacity and uses durable sleeps to poll. Browser closure does not lose the job.
5. Qwen uses the stable application job UUID for idempotent private-service submission; conflicting repeated inputs are rejected. FASHN retains its documented prediction lifecycle.
6. Persist provider references and resume existing work. Unknown acceptance is reconciled before unsafe resubmission; never duplicate a potentially paid operation.
7. Fetch real output bytes, validate and copy into private storage under deterministic retry-safe identifiers. Generated assets cannot be signed until their parent job succeeds. Only verified recorded output can settle the charge.
8. Eligible failed or unrecoverable delivery releases reservations exactly once. Reconcile incurred GPU/provider costs separately from the customer's successful-delivery charge.

FASHN's safe API-level rejection retries and circuit breaker remain. A lost submission response or expired submission lease without a prediction ID becomes `submission_ambiguous`; reconcile provider history before attaching a proven reference or releasing held credits. Do not clear ambiguity to force another request. Existing jobs do not switch provider when configuration changes.

Managed workflow concurrency, database slots and GPU inference concurrency are separate. The selected GPU may require one inference at a time. Verify queue age, stuck-job alerts, restart handling, output expiry and failed-job settlement on the actual deployed systems.

## Media privacy and retention

Uploads are byte/pixel-bounded, decoded/re-encoded by Sharp and stripped of metadata. Originals and safe thumbnails stay private. Object keys are generated server-side. Browser signatures default120sec and are clipped by retention. Worker-created source links are not returned to clients or durable step results.

Qwen receives photographs at the configured operator-hosted GPU endpoint. Its service uses temporary private inputs and expiring outputs. Confirm cleanup/deletion behavior against the service README and test the host's disks, logs and backups. Deleting an application object does not prove GPU-host or backup erasure.

Try-on consent is provider-specific and versioned. Qwen uses `2026-10-25-qwen-v1`; existing FASHN invitations retain their own version. Session expiry, revocation and withdrawal are checked during work and after output copy; withdrawn output is discarded. Customer originals/results default24h app retention. Cleanup retries session-deletion requests. Account/export/report requests require staffed privacy review.

Optional FASHN jobs send short-lived URLs to FASHN and its subprocessors. Its reviewed policy keeps request metadata without automatic deletion and schedules URL output removal after three days. No request-record deletion API is documented; use its current legal-request process. Those conditions do not describe a self-hosted Qwen job. [FASHN retention](https://docs.fashn.ai/api-overview/data-retention-privacy).

## Staging acceptance

Real GPU photo acceptance must inspect garment details, likeness, unsupported inputs, memory, duration, cost, private transfer, restart/idempotency and cleanup. Separately assess customer multi-image visualization with adults' authorized synthetic/test images; disable it if unacceptable. Qwen has no video test because it has no video engine.

Optional FASHN acceptance covers only configured enabled models, output hosts, playback where relevant, cost and retention. Hosted Auth/RLS/storage, Inngest registration, withdrawal during processing and Paystack test settlement remain independent launch gates. Unit/CPU tests must never be reported as real model output.
