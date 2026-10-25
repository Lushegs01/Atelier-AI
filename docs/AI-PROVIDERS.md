# AI provider and durable execution

`AI_PROVIDER` selects the image and video provider. The default, `huggingface`, calls free open-model demos on Hugging Face ZeroGPU Spaces with a free access token. `fashn` keeps the paid FASHN API adapter. Both implement the internal `FashionProvider` contract, so the queue, billing, consent and storage rules below apply to either. Browser clients never call a provider directly.

## Hugging Face Spaces (default, free)

Verified on 25 October 2026. A live Leffa try-on ran end to end from this environment: it was submitted, collected after a delay and its output downloaded without a redirect. The exact photo and video payloads the adapter sends passed each Space's input validation. Live photo and video generations were not run because the anonymous GPU quota was used up. Contract tests use HTTP test doubles built from the live response shape.

| Operation              | Default Space                                                                                                  | Licence                                          | Limits honoured by the adapter                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| Fashion photographs    | [`multimodalart/Qwen-Image-Edit-Fast`](https://huggingface.co/spaces/multimodalart/Qwen-Image-Edit-Fast)       | Qwen-Image-Edit Apache 2.0                       | 1k only; output follows the garment photo's shape |
| Customer visualization | [`franciszzj/Leffa`](https://huggingface.co/spaces/franciszzj/Leffa)                                           | MIT; bundles Stable Diffusion inpainting weights | 1k only (768 × 1024)                              |
| Fashion video          | [`zerogpu-aoti/wan2-2-fp8da-aoti-faster`](https://huggingface.co/spaces/zerogpu-aoti/wan2-2-fp8da-aoti-faster) | Wan 2.2 Apache 2.0                               | 5 seconds at 480p only                            |

Setup:

1. Create a free account and a **read** token at <https://huggingface.co/settings/tokens>. Set it as `HF_TOKEN`. Keep `AI_PROVIDER=huggingface`.
2. Enable `ENABLE_PHOTO_GENERATION`, `ENABLE_TRY_ON` and `ENABLE_VIDEO_GENERATION` individually. A flag without `HF_TOKEN` stays disabled.
3. Enable only reviewed price rules the provider can honour: photo and try-on `default`, video `5:480p`. The studio offers only supported video options, and the API rejects others before credits are reserved.

**Quota.** ZeroGPU gives a free account five GPU minutes a day; PRO gives 40 minutes and can buy more ([quotas](https://huggingface.co/docs/hub/spaces-zerogpu)). A Space reserves its declared GPU time before it runs: Leffa 120 seconds, the photo Space 60 and the video Space roughly 70–100. On a free account, expect roughly 10 try-ons, a few photos or two to three videos a day, shared across operations. This suits development and demos, not paying customers. A job whose quota ran out fails and releases the customer's credits. Spaces on Gradio 6 report this as `provider_quota_exceeded`. Older Spaces, including Leffa and the photo Space, report a generic `provider_failed`.

**Stability.** Community Spaces can change, sleep or disappear. For anything beyond experiments, open each Space and choose **Duplicate this Space** in your own account, keeping it private and on ZeroGPU hardware. Then point `HF_PHOTO_SPACE`, `HF_TRY_ON_SPACE` or `HF_VIDEO_SPACE` at the copy, for example `your-name/Leffa`. A free account can host two ZeroGPU Spaces; PRO can host ten. The adapter's requests are positional, so an override must keep the same Gradio API. Output downloads send `HF_TOKEN`, so private duplicates work.

**How a job runs.** Submission calls `POST /gradio_api/call/{endpoint}` and stores only the returned event id, prefixed with the operation. Gradio keeps running a job with no reader attached and holds its result for one reader. Gradio cancels a job whose result stream closes before it finishes. The status read therefore holds the stream open, for up to 85 seconds inside the 120-second step, until the Space sends `complete` or `error`. It does not poll. A job not finished by then fails with `provider_timeout` and releases its reservation. A result is delivered once. If the output transfer fails after collection, the retry cannot read the result again and the job fails rather than retrying forever. The output must come from the same Space host, over HTTPS, with no redirect.

**Ambiguity.** A free Space job costs no money, so a lost submission response is retried with backoff (`provider_unreachable`) instead of being held for manual reconciliation. A duplicate job costs only free quota.

**Behaviour differences from FASHN.** Photo prompts describe the model, pose and scene, but output dimensions follow the garment photo, so the chosen aspect ratio is not enforced. Try-on maps the garment category to Leffa's weights: `dress` uses DressCode dresses, `bottom` DressCode lower body, and everything else VITON-HD upper body. Accessories are not supported well. Photo prompts are sent without the Space's optional prompt rewriter, which would forward them to a further hosted model.

**Privacy.** A public Space runs code chosen by its owner, so customer photographs pass through that owner's application on Hugging Face infrastructure. Use private duplicates before processing real customer photographs, and review the [Hugging Face privacy policy](https://huggingface.co/privacy) and each model licence. The guest consent screen names the active provider. Its consent version includes the provider name (`2026-10-25-v2-huggingface`), so switching provider records a new disclosure version.

## FASHN (optional, paid)

Implementation reviewed against official documentation on 24 October 2026. **No FASHN account, paid prediction or managed Inngest run has been verified in this environment.** Contract tests use HTTP test doubles. These tests establish request and failure handling behavior, not visual fidelity or provider acceptance. Select it with `AI_PROVIDER=fashn` and `FASHN_API_KEY`.

| Operation              | FASHN model        | Documented lifecycle | Release controls                                        |
| ---------------------- | ------------------ | -------------------- | ------------------------------------------------------- |
| Fashion photographs    | `product-to-model` | Preview              | `ENABLE_PHOTO_GENERATION=true` after staging acceptance |
| Customer visualization | `tryon-max`        | Preview              | `ENABLE_TRY_ON=true` after consent/privacy acceptance   |
| Fashion video          | `image-to-video`   | Experimental         | `ENABLE_VIDEO_GENERATION=true` after video acceptance   |

All flags default false. A flag and the selected provider's credential are required. Enable each independently. These lifecycle labels mean the business must tolerate provider changes and possible withdrawal; they are not availability guarantees. Every Hugging Face capability is labelled Experimental.

The adapter uses fixed `https://api.fashn.ai/v1/run` and `/v1/status/{predictionId}` endpoints, Bearer authentication, nested `inputs`, and the documented prediction states.

The initial priced image workflows accept **one image at balanced quality and 1k resolution**. Photo controls describe an adult model, pose, scene, aspect ratio, image format and seed. They cannot add face-reference inputs, increase output count, change image quality or resolution through an unpriced option. Garment front, mannequin, hanger and flat-lay source views are accepted; detail-only, back and side views are not treated as interchangeable full-garment inputs. FASHN video accepts 5 or 10 seconds and 480p, 720p or 1080p. Its source must be at least 301 pixels in both dimensions. Motion text is optional and bounded; camera behavior, physical accuracy and garment preservation are not guaranteed.

## Pricing boundary

Hugging Face Spaces have no per-request charge; the cost is the daily GPU quota or a PRO subscription. Record a zero or subscription-derived provider cost in their price rules.

FASHN credits and Atelier customer credits are distinct units. For the fixed balanced/1k image configuration the documented provider cost is two FASHN credits per output. Five-second video costs one, three or six provider credits at 480p, 720p or 1080p; ten seconds doubles those values. The adapter's estimator expresses provider billing units. Monetary provider cost depends on the purchased provider plan and foreign-exchange assumptions and must be reviewed in the pricing table before enabling a rule. `provider_credits_milli` records integer thousandths; `provider_cost_microusd` is an integer cost estimate. Actual `x-fashn-credits-used` status headers replace the credit estimate when present. Missing headers are not treated as zero consumption.

## Durable lifecycle

1. The authenticated service validates membership, compatible sources, options and enabled capability.
2. A PostgreSQL transaction locks the credit account, reserves the immutable quote, creates the job and writes `job_outbox`. No event is sent before commit.
3. The API attempts an Inngest enqueue. The per-minute outbox dispatcher retries undelivered events; queue failure does not erase committed work.
4. Inngest's `generate-fashion-content` function uses a job idempotency expression, global step concurrency of three, and a per-organization step limit of one. A PostgreSQL advisory lock and claim/lease enforce persistent provider slots separately: at most three in-flight predictions globally and one per organization, including ambiguous submissions until reconciled. Jobs wait through durable 30-second sleeps for up to one hour when capacity is occupied; these waits do not issue a paid POST or consume retry attempts.
5. `submit-once` resolves short-lived private source URLs, calls the provider and returns only the prediction id to durable state. A separate retriable step persists that id. Subsequent polls read the existing prediction.
6. Durable sleeps begin at 15 seconds and then use 30-second intervals. They do not hold a serverless request open. Polling is bounded to 100 iterations, approximately 49 minutes. Each step has three infrastructure retries.
7. A completed response is downloaded from the active provider's allowed output origin, bounded by size and timeout, verified and copied to private storage. Deterministic asset ids, paths and output indices make transfer retries idempotent. Only verified recorded outputs permit successful credit settlement.
8. Provider failure, invalid input, exhausted delivery or the bounded processing timeout releases the customer's reservation exactly once. Costs incurred upstream by a result that could not be delivered remain a business reconciliation issue.

The rolling circuit breaker pauses fresh submissions when five provider 5xx errors were recorded in the previous two minutes. Safe API-level 429/5xx rejections use a bounded exponential delay with jitter and at most three resubmissions. The account's actual purchased provider concurrency limit must be verified; lower the database claim limit if necessary. Inngest step concurrency by itself would not bound predictions running while durable steps sleep.

## Ambiguous submissions and recovery

This section applies to FASHN. FASHN's reviewed documentation does not provide a client submission idempotency key. If a POST times out, a network response is lost, or a worker lease expires before the prediction id is durably known, the job becomes `retry_wait` with `submission_ambiguous`. **The application does not issue another paid POST.** Its reservation remains held and a structured alert identifies the job id. Operators must reconcile FASHN request history, attach the proven prediction id and replay the Inngest run, or perform an audited release after confirming no accepted prediction. Do not simply clear the ambiguity flag or click a new generation to recover the old one.

Known predictions resume after worker restarts. Inngest retries persisted steps. The administrative resume action emits a separate unique recovery event, handled by a per-job singleton workflow that only polls an existing prediction and cannot submit a new one; this avoids the initial job's 24-hour event-deduplication window. The five-minute maintenance function reports stuck jobs older than one hour and ambiguous leases through structured logs and Sentry when configured. Configure an operator alert rule for these events. Known unsubmitted jobs expire after 24 hours and release their reservations under a database lock; ambiguous submissions are excluded. A known prediction undelivered for 48 hours is refunded before the documented CDN retrieval window lapses. Lost Inngest runs can also be replayed in its dashboard; preserve completed `submit-once` results. Dashboard replay/retention limits depend on the configured Inngest plan and require a staging restart exercise.

## Media and privacy

- Uploads are server-authorized. File signatures and Sharp decoding validate JPEG, PNG or WebP. SVG and animated formats are rejected. The public upload request and UI cap default to 4 MiB for Vercel compatibility; the internal decoder also enforces its bounded normalization limit. Maximum decoded pixels default to 40 million. Images are re-encoded with orientation applied and EXIF/location metadata stripped.
- Originals and 640-by-800-bounded WebP previews are stored in the private `private-media` bucket under randomized, organization-prefixed paths. No storage path from a browser is accepted. Asset downloads are resolved from organization-scoped database ids and signed for 120 seconds by default (maximum 900 seconds, clipped to the asset's remaining retention period). Generated assets cannot be signed until their parent job is recorded as succeeded.
- Service-only upload intents are written before object writes. Hourly cleanup removes abandoned files after one hour, verifies every path stays beneath the intended organization/asset prefix, and preserves any committed active asset even if the process crashed before deleting its intent. Generated assets carry an explicit tenant-bound job foreign key, so cleanup and consent deletion do not depend on a later output-row insert succeeding.
- Provider source links last 900 seconds and are created within the submit step. They are not returned to browser clients or retained in Inngest step results. FASHN's request history retains submitted URL strings, so a short signature TTL reduces residual access.
- Output transfer permits only HTTPS on the active provider's origins: FASHN's documented `cdn.fashn.ai` and `media.fashn.ai`, or the configured Spaces' `*.hf.space` hosts. Credentials, alternate ports and redirects are rejected. Streaming transfers have hard bounds. Images undergo full decoding. Generated MP4s undergo bounded ISO BMFF box parsing and require movie/media boxes; this does not independently prove codec validity, so live video playback is a staging gate.
- Try-on consent, session expiry, revocation and deletion are checked before submission and before copying outputs. A second check after transfer deletes an output if consent was withdrawn during transfer. Private guest photos and their generated representations expire after 24 hours by default; hourly cleanup deletes stored originals/previews, removes assets from failed jobs and retries pending `delete_session` privacy requests. Account/export/report requests remain in the reviewed privacy queue and must be serviced operationally.
- Upstream processing cannot be cancelled by this application after the provider accepts a request. A revoked session is blocked locally, its outputs are discarded, and customer credits are released when the job fails. Never claim upstream deletion based solely on deleting local objects.
- Inngest receives job and organization ids and durable status, not customer image bytes. The active provider and its subprocessors process the photos. Configure processor contracts, access, retention and regional requirements before accepting customer data.

FASHN documents request records without automatic deletion, URL-output cleanup after three days, and different base64-output retention. The app uses URL outputs and copies them promptly. Local deletion does not demonstrate erasure of provider request metadata or subprocessor copies. Training is not enabled by this code; verify the actual provider account agreements and settings. Legal/privacy review remains required.

## Configuration and verification

Configure Supabase, its private bucket, the migration/seed, `AI_PROVIDER` with `HF_TOKEN` or `FASHN_API_KEY`, Inngest event/signing keys and exactly the desired feature flags. Serve `/api/inngest` over HTTPS and register that endpoint in Inngest. Use `INNGEST_DEV=1` only with the local development server; production must reject development queue mode. A Vercel plan supporting the configured 120-second step execution budget is required. The long workflow runs through durable callbacks, not a 120-second total request.

Staging acceptance must exercise all three actual provider models with authorized synthetic/test images, inspect garment fidelity and disclosures, confirm actual credit headers, verify official output hosts and codecs, interrupt workers after submission and transfer, simulate payment and provider failures, verify private signed URLs fail for unrelated tenants, revoke/withdraw consent during processing, and demonstrate cleanup plus cost reconciliation. Do not enable a capability merely because its adapter unit tests pass.

Sources: [Hugging Face ZeroGPU](https://huggingface.co/docs/hub/spaces-zerogpu), [Gradio API over HTTP](https://www.gradio.app/guides/querying-gradio-apps-with-curl), [FASHN fundamentals](https://docs.fashn.ai/api-overview/api-fundamentals), [Product to Model](https://docs.fashn.ai/api-reference/product-to-model), [Try-On Max](https://docs.fashn.ai/api-reference/tryon-max), [Image to Video](https://docs.fashn.ai/api-reference/image-to-video), [Error handling](https://docs.fashn.ai/api-overview/error-handling), [Data retention and privacy](https://docs.fashn.ai/api-overview/data-retention-privacy), [Inngest v4 functions](https://www.inngest.com/docs/reference/typescript/v4/functions/create), [Inngest HTTP serving](https://www.inngest.com/docs/learn/serving-inngest-functions).
