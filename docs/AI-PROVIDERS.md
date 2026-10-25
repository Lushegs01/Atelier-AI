# AI providers and durable execution

The default backend is operator-hosted `Qwen/Qwen-Image-Edit-2511`. FASHN remains optional and is never an automatic fallback. Web adapter and Python contract tests are not proof of successful GPU inference. No real Qwen output, GPU deployment or paid FASHN prediction has been verified here. See the current [Qwen report](QWEN-VERIFICATION.md) and preserved [initial report](VERIFICATION.md).

## Capabilities

| Backend                   | Photographs                               | Customer visualization                                                             | Video                                   |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------- |
| Qwen Image Edit (default) | Experimental garment-guided image editing | Separately enabled experimental multi-image editing, not a validated fitting model | Unsupported regardless of feature flags |
| FASHN (optional)          | `product-to-model`, Preview               | `tryon-max`, Preview                                                               | `image-to-video`, Experimental          |

All flags default false. A backend, its operation flag and its reviewed provider-specific price rule must be enabled before spending credits. New work follows `AI_PROVIDER=qwen|fashn`; existing jobs and invitations preserve their selected provider/model. Missing Qwen credentials never route a photograph to FASHN. The UI identifies the actual pinned provider before customer consent.

Qwen is a general image editor, not a specialized garment-fitting system with demonstrated parity. It may alter construction, print, embellishment, body, pose or likeness. Compare every output with the original. Customer photographs cannot be used for campaign animation or unrelated reuse. No claim of accurate fit, exact identity preservation or measured fidelity is made.

The [official model card](https://huggingface.co/Qwen/Qwen-Image-Edit-2511) publishes Apache-2.0 weights and multi-image editing through `QwenImageEditPlusPipeline`. That license does not include GPU compute, hosting, storage or model-quality guarantees. Review model/dependency licenses, input rights and infrastructure terms for release.

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
