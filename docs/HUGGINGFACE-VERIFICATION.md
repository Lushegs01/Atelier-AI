# Hugging Face Spaces verification

## Contract re-verification — 26 October 2026

Performed from the development container against the live Hub and Spaces, **without an HF token and without any GPU inference**. Sources: each Space's `/gradio_api/info` and `/config`, its `app.py` at the commit below, the Hub runtime API, the Gradio 5.38.2 and 6.1.0 source, and the `spaces` 0.51.3 ZeroGPU client source.

| Item                | Photo                                                                                                    | Try-on                                                                                                                                                                                          | Video                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Space               | `multimodalart/Qwen-Image-Edit-Fast` @ `821f1c9`                                                         | `franciszzj/Leffa` @ `b4f9d0e`                                                                                                                                                                  | `zerogpu-aoti/wan2-2-fp8da-aoti-faster` @ `1ff7432`                                                                  |
| Runtime (26 Oct)    | RUNNING, `zero-a10g`, Gradio 5.42.0                                                                      | RUNNING, `zero-a10g`, Gradio 5.38.2                                                                                                                                                             | RUNNING, `zero-a10g`, 4 replicas, Gradio 6.1.0                                                                       |
| Endpoint            | `/infer`                                                                                                 | `/leffa_predict_vt`                                                                                                                                                                             | `/generate_video`                                                                                                    |
| Inputs, in order    | image; prompt; seed 0–2147483647; randomize_seed; true_guidance_scale 1–10; steps 4–28; rewrite_prompt   | person image; garment image; ref_acceleration (bool); steps 30–100; scale 0.1–5; seed −1–2147483647; model `viton_hd`/`dress_code`; garment `upper_body`/`lower_body`/`dresses`; repaint (bool) | image; prompt; steps 1–30; negative prompt; duration 0.5–5.0 s; guidance 0–10; guidance 2 0–10; seed; randomize_seed |
| Values sent         | seed from job; false; 1; 8; **false**                                                                    | false; 30 or 50; 2.5; seed from job; by category; false                                                                                                                                         | preset prompt; 6; English negative prompt; 5; 1; 1; seed from job; false                                             |
| Preprocessing       | Any shape; pipeline targets about 1 MP                                                                   | Both images letterboxed to 768 × 1024 on white (no crop)                                                                                                                                        | Resized to 480–832 px per side; **centre-crops** beyond 480:832 or 832:480                                           |
| Output              | `[image (webp FileData), seed]`                                                                          | `[image, mask, densepose]` (webp FileData)                                                                                                                                                      | `[video FileData (mp4), seed]`; Gradio re-encodes to H.264 when ffmpeg exists                                        |
| ZeroGPU reservation | 60 s                                                                                                     | 120 s                                                                                                                                                                                           | `10 + steps × 15 × factor^1.5` s (about 100 s for 5 s at 624 × 832)                                                  |
| Model licence       | `Qwen/Qwen-Image-Edit` Apache-2.0; Lightning LoRA Apache-2.0                                             | `franciszzj/Leffa` MIT                                                                                                                                                                          | `Wan-AI/Wan2.2-I2V-A14B` Apache-2.0; `Kijai/WanVideo_comfy` LoRA declares none                                       |
| Space licence       | not declared                                                                                             | MIT                                                                                                                                                                                             | not declared                                                                                                         |
| Notes               | `rewrite_prompt=true` would send the image to a further hosted LLM; prompts are printed to the Space log | VITON-HD weights cover tops only                                                                                                                                                                | Space README examples encourage dramatic motion; the app uses restrained presets                                     |

### Asynchronous behaviour (Gradio 5.38.2 and 6.1.0 source)

- `POST /gradio_api/call/<api>` accepts an optional `session_hash`. The job is queued and runs whether or not anyone is reading. Its messages are buffered under the session hash (or under the event id when none is given).
- `GET /gradio_api/queue/data?session_hash=…` streams `estimation`, `process_starts`, `progress`, `heartbeat`, then `process_completed` with `success`, `output.data` or `output.error`, and `title`. An unknown session yields `unexpected_error` with `session_not_found: true`.
- Disconnecting a reader calls `clean_events`, which cancels a queued or running job. Reading is therefore done once per job and held to completion.
- On the `/call/<api>/<event_id>` GET used previously, an error event carries `data: null`: the error text and title are not exposed, so quota exhaustion could not be recognised. This is why reads moved to `/queue/data`.
- ZeroGPU raises titled errors: `ZeroGPU quota exceeded`, `ZeroGPU pending credits exceeded`, `ZeroGPU queue timeout` (`No GPU was available after 60s`), `ZeroGPU client error`, `ZeroGPU illegal duration`.

### Live protocol probe (no GPU, no images)

One request was sent to the photo Space with an unresolvable image URL, so Gradio failed during input preprocessing, before the `@spaces.GPU` function was called. It confirmed that `/call/infer` accepts a caller-chosen `session_hash` (returned `event_id`); that `/queue/data` delivered the buffered `estimation`, `process_starts`, `process_completed {success:false, title:"Error"}` and `close_stream` messages to a reader that connected afterwards; and that an unknown session returns `unexpected_error` with `session_not_found: true` over HTTP 200.

### Not verified

- **No inference was run.** No HF token was available and live generation was not authorised. Photo, try-on and video outputs, their quality and garment fidelity, real latency, actual quota consumption, output codecs, and the token-authenticated quota path are unverified. Run `HF_LIVE_SMOKE=1 HF_TOKEN=… npm run smoke:hf -- all` to collect that evidence.
- Hosted Supabase, Inngest Cloud, the Vercel 300-second function limit and production deployment were not exercised.
- The Spaces' data retention is not documented by their owners; no remote deletion is available to this app.

---

# Imported Hugging Face branch report — 24 October 2026

This historical report was preserved from remote commit `f9a213c`, merged through `3cb07e0`. Its Hugging Face generation claim was not rerun during the Qwen work and is not evidence of Qwen inference. Since 26 October 2026 Hugging Face is the default provider; see the re-verification above, which supersedes this report's protocol details. Use [Qwen verification](QWEN-VERIFICATION.md) for the current integration and [deployment](DEPLOYMENT.md) for configuration. The original branch report follows below.

This report records local checks performed for the initial implementation. The application has not been deployed. Real AI predictions, payment settlement, hosted Supabase authentication/storage and managed Inngest execution remain unverified because external accounts/credentials were not supplied.

Final command results are recorded at the end of this document after verification. Database tests use actual embedded PostgreSQL with substituted Supabase schemas; provider/payment tests use controlled test doubles. Browser smoke tests use the real unconfigured local application on desktop and mobile Chromium. None are described as passing live-integration tests.

See EXTERNAL-REQUIREMENTS.md and RELEASE-CHECKLIST.md for the exact remaining launch gates. The source includes all principal public/designer/customer/admin routes, transactional database/services, provider adapters, jobs, payments, secure media and consent. The production build and unit tests do not establish commercial production readiness by themselves.

## Executed checks

| Command                                   | Final local result                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm install` / lockfile                  | Dependencies installed; npm lockfile retained                                                 |
| `npm run format` / `npm run format:check` | Formatted repository; final check passed                                                      |
| `npm run lint`                            | Passed; private-media optimizer lint exemption documented in configuration                    |
| `npm run typecheck`                       | Passed with strict TypeScript                                                                 |
| `npm test`                                | 14 test files, **139 tests passed**                                                           |
| `npm run db:validate`                     | **47 actual SQL/RLS tests passed**, included in the 139 above                                 |
| `npx playwright install chromium`         | Installed official Playwright Chromium and headless runtime                                   |
| `npm run test:e2e`                        | **14 passed** across desktop and mobile Chromium, final run about 1.5 minutes                 |
| `npm run scan:secrets`                    | Passed heuristic source scan; no secret contents printed                                      |
| `npm audit --audit-level=high`            | **0 known vulnerabilities** in installed dependency graph                                     |
| `npm run build`                           | Passed optimized Next.js build, static generation and build-time TypeScript                   |
| Browser visual inspection                 | Actual Dribbble shot, local landing page and workspace inspected; studio screenshots retained |

Earlier browser attempts failed while Chromium was still installing and because multi-page smoke tests exceeded the default 30-second whole-test timeout during first development compilations. After installation, the multi-route timeout was set to 120 seconds and async assertions to 15 seconds; the complete rerun passed. No failing external test was relabeled as a passing smoke test.

The Inngest SDK originally brought a Zod version affected by the current audit advisory. Its `zod/v3` imports remain compatible with the maintained package's compatibility entry point; an explicit dependency override to Zod 4.6.7 removes the advisory. All adapter/orchestration tests and builds passed with that override.

## External verification status

| Area                    | Implemented                            | Local evidence                                                            | Real/staging/production                                                                                |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Auth, tenants and roles | Yes                                    | Policy/service tests, SQL and denial smoke                                | Hosted Auth/RLS not exercised                                                                          |
| Private uploads/media   | Yes                                    | Actual Sharp decoding + authorization tests                               | Supabase Storage API not exercised                                                                     |
| Photo/video/try-on      | Hugging Face and FASHN adapters and UI | Contract, failure and orchestration doubles; one live Hugging Face try-on | Photo/video payloads validated by the Spaces but not generated; no FASHN predictions; flags remain off |
| Durable jobs/outbox     | Inngest functions and SQL              | Crash/resume/ambiguity/capacity tests                                     | Managed scheduler not registered or exercised                                                          |
| Credits/payments        | Transactions and Paystack adapter      | Ledger/RLS/idempotency/signature tests                                    | No actual checkout, webhook delivery or refund                                                         |
| PWA                     | Manifest/icons/worker/offline document | Manifest/asset checks, responsive Chromium                                | HTTPS installation and Safari/Android device acceptance pending                                        |
| Account export/deletion | Request/review workflow                | Authorization and durable request paths                                   | Staffed fulfillment and legal retention decisions required                                             |
| Deployment              | CI, Docker and guides                  | Local production build                                                    | Not deployed; CI workflow has not run on a remote host                                                 |

No Docker runtime was available, so `supabase start`, a full local Supabase stack, the container build and managed migration application were not run. No independent-connection PostgreSQL race test, production load test, device installability audit or formal accessibility certification was performed.

The final production server was started locally on port 3002: `/` and `/api/health` returned 200; `/api/ready`, `/app` and `/admin` returned the expected 503 with integrations unconfigured. Both owned preview servers were stopped after verification. After the mobile navigation accessibility polish, the production build and two focused mobile route checks also passed. Final source commit: `7dd19d9` (the verification-note commit may follow it).

## Exact next actions

1. Create an isolated Supabase staging project, apply the reviewed migration and configure email confirmation, SMTP, redirect origins and private storage.
2. Supply server secrets and the exact application origin from `.env.example`. Configure the AI provider (`HF_TOKEN`, or FASHN), Inngest and Paystack test accounts.
3. Deploy an explicitly authorized staging revision, register Inngest functions and the Paystack webhook, then run every acceptance item in RELEASE-CHECKLIST.md using two organizations and synthetic images.
4. Review model lifecycle, retail catalog/provider costs, privacy terms, support identity, backup restore and operational responsibilities. Enable only accepted capabilities and reviewed prices.
5. Obtain production-release authorization, configure separate production credentials, deploy the reviewed revision, and record real production smoke evidence.
