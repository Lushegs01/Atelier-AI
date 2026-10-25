# Qwen transition verification — 25 October 2026

The application now defaults to a private, operator-hosted `Qwen/Qwen-Image-Edit-2511` service. Photographs and separately enabled experimental customer visualizations are supported by the code. Qwen video is unavailable. Historical FASHN jobs, invitations, quoted models and prices remain pinned to FASHN; no automatic provider fallback is used.

## Local evidence

| Check                                   | Result                                                          |
| --------------------------------------- | --------------------------------------------------------------- |
| `npm test`                              | 222 tests passed across 22 files, including SQL tests           |
| `npm run db:validate`                   | 62 SQL tests passed; included in the full test total above      |
| `npm run test:e2e -- --workers=1`       | 20 desktop/mobile Chromium tests passed                         |
| Python service `unittest discover`      | 20 CPU control-plane tests passed using an injected test engine |
| Qwen TypeScript adapter tests           | 18 passed; included in the full test total above                |
| TypeScript, ESLint, Prettier            | Passed                                                          |
| Python Ruff format/lint and `pip check` | Passed                                                          |
| `npm audit --audit-level=high`          | Zero reported vulnerabilities                                   |
| `npm run scan:secrets`                  | Passed; heuristic scan only                                     |
| Production build                        | Passed                                                          |

Tests cover provider/model pinning, reviewed provider-specific prices, immutable financial reservations, tenant boundaries, source validation, private credential forwarding, durable receipt recovery, consent revocation, deletion races and cleanup continuing during individual failures. Database tests execute SQL in PGlite with substituted Supabase auth/storage schemas. Browser provider scenarios use explicitly synthetic API fixtures; they are interface contract tests.

The GPU service's test engine is injected only by CPU tests. There is no production fake-result mode. CPU tests do not install Torch or download model weights. The Next.js development filesystem cache was disabled after it caused a reproducible HMR reload loop during browser checks; CSP protections were retained. A transient Windows file-open failure affected the first production build attempt; the repeat completed compilation, TypeScript and static generation successfully.

The built production server was started locally: homepage and health returned 200, readiness returned 503, and the workspace API returned only the explicit unconfigured empty state. The Inngest endpoint returned 500 with the SDK's missing-signing-key diagnostic, as expected without production credentials; this is not a successful cloud sync. The endpoint must be configured and redeployed before registration. Both owned preview servers were stopped after verification.

## Outstanding acceptance

No NVIDIA GPU, Docker image startup, real model generation, garment fidelity, latency, throughput or GPU-memory requirement has been verified. This PC has Intel Iris Xe and cannot run the supplied CUDA inference engine. No hosting was purchased, no remote GPU was provisioned and no app deployment was performed.

The operator still needs a compatible GPU machine, private HTTPS endpoint, matching random service credentials, persistent private storage and a real-output acceptance run. Configure `AI_PROVIDER=qwen`, `QWEN_API_URL` and `QWEN_API_KEY` on the web host; set the corresponding service environment using [the inference guide](../inference/qwen/README.md). Generation flags and catalog rules remain disabled until explicitly reviewed and enabled. Qwen rules require a measured GPU cost; open weights do not make hosting or processing free.

Apply the provider upgrade migration after the initial schema. It preserves old FASHN records and introduces provider-pinned jobs/pricing plus durable inference-deletion markers. Use separate staging service credentials and verify hosted Supabase, Inngest delivery, Paystack test payments, real private output transfer and cleanup before release. See [deployment and Inngest registration](DEPLOYMENT.md) and [release acceptance](RELEASE-CHECKLIST.md).

The earlier [verification report](VERIFICATION.md) remains historical evidence for the original implementation, not proof of Qwen inference or a production launch.
