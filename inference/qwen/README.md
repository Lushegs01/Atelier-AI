# Private Qwen image service

This is Atelier AI's self-hosted inference service for **`Qwen/Qwen-Image-Edit-2511`**. It uses the Apache-2.0 checkpoint with `QwenImageEditPlusPipeline`. It is separate from the Next.js web server and must run on suitable NVIDIA GPU hardware. No paid FASHN key is needed for Qwen. The model weights are free to download; hardware, electricity, storage and hosted compute may cost money.

The checkpoint revision is pinned to `6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9`, obtained from the official model metadata on 25 October 2026. The code does not select the differently licensed Qwen-Image-2.1 model. Dependencies are pinned in `requirements-*.txt`; GPU compatibility still requires a real host acceptance test.

## What has been verified

The authenticated HTTP control plane, SQLite persistence, bounded image validation, idempotency, restart handling, private output delivery, consent deletion races and cleanup retries have CPU tests using an explicitly injected synthetic test engine. There is **no production mock mode**. No Torch package, checkpoint or GPU was installed or invoked during those tests. A real generation, fidelity, GPU memory requirement, throughput and container startup have **not** been verified on this computer. An Intel Iris Xe is not a CUDA host for this service.

## Host requirements

- Linux, Docker and NVIDIA Container Toolkit, or Python 3.12 with a compatible NVIDIA CUDA setup.
- A GPU supporting bfloat16 (Ampere or newer) and sufficient GPU/CPU memory for the chosen offloading strategy. No universal minimum VRAM has been validated here. The 20B image-editing family requires substantial model storage and memory; do not assume a small consumer GPU can fit the complete pipeline.
- The pinned PyPI Linux `torch==2.14.1` wheel installs CUDA 13.0 runtime dependencies. The host driver must support that runtime. Inspect the official PyTorch installation guidance for the host before building.
- Separate durable private `/data/qwen` storage and a persistent Hugging Face model cache. Use an encrypted volume and access restricted to the service operator. Container user ID is `10001`; bind mounts must be writable by that user.
- A private HTTPS endpoint reachable by the Atelier application server. Terminate TLS at a reverse proxy and expose neither the data volume nor Hugging Face cache as static web content. The API has no browser CORS access.

## Configure and run

Create the service environment from `.env.example` outside source control. Generate your own long random `QWEN_API_KEY`, then configure the **same** value in the Next.js host and GPU service. This is your private-service bearer credential, not a Hugging Face paid API key. `QWEN_PUBLIC_URL` on the GPU service must equal `QWEN_API_URL` in Next.js.

From this directory on the GPU host:

```text
docker build -t atelier-qwen:staging .
docker run --rm --gpus all --env-file /secure/atelier-qwen.env \
  -p 127.0.0.1:8000:8000 \
  -v atelier-qwen-data:/data/qwen \
  -v atelier-qwen-cache:/cache/huggingface \
  atelier-qwen:staging
```

The startup worker checks CUDA support before downloading model weights. If supported, it loads the pinned checkpoint. Loading can take a considerable amount of time on the first run. `/health` reports only process liveness. Authenticated `/ready` returns 503 until the actual engine loads; neither health endpoint performs inference or causes a download.

Alternatively, in a GPU-host Python virtual environment:

```text
python -m venv .venv
# Activate .venv using the host shell, then:
python -m pip install -r requirements-gpu.txt
uvicorn app:create_app --factory --host 127.0.0.1 --port 8000 --workers 1 --no-access-log
```

Use **one process / one replica per data volume**. SQLite and an OS file lock protect the durable queue; a second process cannot take over an active worker. Do not increase Uvicorn worker count. A path prefix in `QWEN_PUBLIC_URL`, such as `https://gpu.example/qwen`, requires the reverse proxy to strip that prefix before forwarding to Uvicorn.

Next.js configuration:

```dotenv
AI_PROVIDER=qwen
QWEN_API_URL=https://YOUR-PRIVATE-GPU-HOST
QWEN_API_KEY=
QWEN_ALLOW_INSECURE_LOCAL=false
ENABLE_PHOTO_GENERATION=false
ENABLE_TRY_ON=false
ENABLE_VIDEO_GENERATION=false
```

Fill the secret privately. Enable photo or experimental try-on only after a real acceptance test and a reviewed price rule. Qwen generates still images; video is unsupported. The initial service supports one balanced 1K PNG per request with 40 inference steps. `QWEN_OFFLOAD=model` is the default; `sequential` uses more CPU transfers and is slower, while `none` requires the whole pipeline on the GPU. Benchmark the selected setting before choosing a launch host. Only verified 40-character checkpoint revisions may override the pin.

For an explicitly local development connection, both processes must use `NODE_ENV=development`, `QWEN_ALLOW_INSECURE_LOCAL=true`, and a loopback HTTP URL such as `http://127.0.0.1:8000`. Plain HTTP to a remote hostname is rejected. Production always requires HTTPS.

## API and privacy behavior

All routes except `/health` require `Authorization: Bearer QWEN_API_KEY`. Access logs are disabled in the launch command. API errors return safe codes; prompts, image bytes, credentials and raw inference exceptions are not echoed.

| Route                      | Contract                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`              | Minimal liveness `{status:"ok"}`; no engine work                                                                                                                                        |
| `GET /ready`               | Authenticated engine readiness, exact model and revision; 200 ready / 503 unavailable                                                                                                   |
| `POST /v1/jobs`            | Stable `request_id` UUID, operation `photo` or `try_on`, one or two bounded JPEG/PNG data URIs, prompt, dimensions, seed and fixed inference settings; returns 202 with the same job id |
| `GET /v1/jobs/{id}`        | `in_queue`, `processing`, `completed` or `failed`; successful output is an authenticated URL on this exact service                                                                      |
| `GET /v1/jobs/{id}/output` | Private PNG bytes with `Cache-Control: private, no-store`                                                                                                                               |
| `DELETE /v1/jobs/{id}`     | Revokes the job and removes private inputs/output; creates a tombstone even if DELETE races an uncommitted POST                                                                         |

The server accepts **image bytes only**, never arbitrary input URLs. Next.js fetches an authorized private Supabase source using its exact configured origin/path, fully decodes it with Sharp, then sends a data URI. Python fully decodes and strips metadata again. Bounds are 4 MiB per image, 40 million decoded input pixels, at most two inputs, a 13 MiB JSON request, and about 1.5 million output pixels. It rejects SVG, animations, corrupt images and unsupported dimensions. The GPU credential is never sent to Supabase or a substituted output origin.

Jobs, request fingerprints and states are transactional in SQLite; private input JSON and outputs are persisted in private job directories. Replaying the same UUID/settings returns the existing job. Changed settings conflict. Expired/deleted UUIDs are never generated again, even after files are removed. Minimal UUID/fingerprint/status tombstones are retained to protect idempotency; they contain no photo bytes or prompt. Input JSON is deleted immediately after success or failure. Output retention defaults to 24 hours and can be shortened to 1–24 hours. Cleanup runs independently every minute even if model initialization fails, and failed deletion stays retryable.

CUDA work cannot be reliably cancelled halfway through a kernel. A deletion marks the job revoked immediately, removes files and discards any late output. On process restart, previously processing jobs are marked failed/interrupted instead of being silently generated twice. Queued jobs can resume if they remain unexpired. Application credit settlement remains in the Next.js/PostgreSQL workflow, after output has been transferred to authorized private storage.

## CPU-only verification

These commands do not install Torch or download a checkpoint:

```text
python -m venv .venv-test
# Activate the test virtual environment, then from the repository root:
python -m pip install -r inference/qwen/requirements-test.txt
python -m pip check
python -m ruff format --check inference/qwen
python -m ruff check inference/qwen
python -m unittest discover -s inference/qwen/tests -v
npx vitest run tests/ai/qwen.test.ts
```

Before launch, use a small authorized synthetic garment to verify real model loading, accepted image/pose inputs, actual output dimensions and garment details, measured latency/memory, restart behavior, missing/expired inputs, authenticated output transfer, revoked consent and customer-photo retention. Never count the injected engine tests as successful real inference.

Sources: [official model card and license](https://huggingface.co/Qwen/Qwen-Image-Edit-2511), [Diffusers Qwen pipeline](https://huggingface.co/docs/diffusers/api/pipelines/qwenimage), [memory/offloading guidance](https://huggingface.co/docs/diffusers/optimization/memory), [PyTorch installation](https://pytorch.org/get-started/locally/).
