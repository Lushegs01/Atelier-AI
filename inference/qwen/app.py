"""Private, durable, bounded Qwen image-editing worker.

The HTTP API accepts image bytes, never input URLs. A single CUDA worker owns a
private SQLite queue. Inference dependencies are imported only in the real engine.
Test generators are injected by unit tests; no environment flag enables fake AI.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import io
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import warnings
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, ValidationError

MODEL_ID = "Qwen/Qwen-Image-Edit-2511"
# Official Hugging Face model metadata verified 25 October 2026.
MODEL_REVISION = "6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9"
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_BODY_BYTES = 13 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
UUID_PATTERN = re.compile(r"^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$")
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


class ServiceError(Exception):
    def __init__(self, status: int, code: str):
        self.status = status
        self.code = code


class Settings:
    def __init__(
        self,
        api_key: str,
        public_url: str,
        data_dir: Path,
        retention_hours: int = 24,
        max_queue: int = 20,
        offload: str = "model",
        revision: str = MODEL_REVISION,
        allow_local: bool = False,
        production: bool = True,
    ):
        parsed = urlsplit(public_url)
        local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if (
            (
                parsed.scheme != "https"
                and not (
                    parsed.scheme == "http" and local and allow_local and not production
                )
            )
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(
                "QWEN_PUBLIC_URL must be HTTPS; explicit development loopback is the only HTTP exception"
            )
        if len(api_key) < 32 or api_key.strip() != api_key or not api_key.isascii():
            raise ValueError(
                "QWEN_API_KEY must be a random ASCII secret of at least 32 characters"
            )
        if not 1 <= retention_hours <= 24 or not 1 <= max_queue <= 100:
            raise ValueError("Invalid retention or queue bound")
        if offload not in {"none", "model", "sequential"} or not re.fullmatch(
            r"[a-f0-9]{40}", revision
        ):
            raise ValueError("Invalid model/offload configuration")
        self.api_key = api_key
        self.public_url = public_url.rstrip("/")
        self.data_dir = data_dir.resolve()
        self.retention_seconds = retention_hours * 3600
        self.max_queue = max_queue
        self.offload = offload
        self.revision = revision

    @classmethod
    def from_environment(cls) -> Settings:
        return cls(
            api_key=os.environ.get("QWEN_API_KEY", ""),
            public_url=os.environ.get("QWEN_PUBLIC_URL", ""),
            data_dir=Path(os.environ.get("QWEN_DATA_DIR", "/data/qwen")),
            retention_hours=int(os.environ.get("QWEN_RETENTION_HOURS", "24")),
            max_queue=int(os.environ.get("QWEN_MAX_QUEUE", "20")),
            offload=os.environ.get("QWEN_OFFLOAD", "model"),
            revision=os.environ.get("QWEN_MODEL_REVISION", MODEL_REVISION),
            allow_local=os.environ.get("QWEN_ALLOW_INSECURE_LOCAL") == "true",
            production=os.environ.get("NODE_ENV", "production") == "production",
        )


class Submission(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    request_id: str = Field(pattern=r"^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$")
    operation: Literal["photo", "try_on"]
    images: list[str] = Field(min_length=1, max_length=2)
    prompt: str = Field(min_length=1, max_length=2200)
    width: int = Field(ge=256, le=1536)
    height: int = Field(ge=256, le=1536)
    seed: int = Field(ge=0, le=4_294_967_295)
    output_format: Literal["png"] = "png"
    num_inference_steps: Literal[40] = 40
    true_cfg_scale: Literal[4.0] = 4.0


def canonical_id(value: str) -> str:
    if not UUID_PATTERN.fullmatch(value):
        raise ServiceError(404, "job_not_found")
    return str(UUID(value))


def decode_image(value: str) -> Image.Image:
    if not isinstance(value, str) or len(value) > MAX_IMAGE_BYTES * 4 // 3 + 128:
        raise ServiceError(422, "invalid_image")
    match = re.fullmatch(r"data:image/(png|jpeg);base64,([A-Za-z0-9+/]*={0,2})", value)
    if not match:
        raise ServiceError(422, "invalid_image")
    try:
        raw = base64.b64decode(match[2], validate=True)
        if not raw or len(raw) > MAX_IMAGE_BYTES:
            raise ServiceError(422, "invalid_image")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as original:
                actual = (
                    "jpeg"
                    if original.format == "JPEG"
                    else "png"
                    if original.format == "PNG"
                    else ""
                )
                if actual != match[1] or getattr(original, "n_frames", 1) != 1:
                    raise ServiceError(422, "invalid_image")
                if (
                    min(original.size) < 256
                    or original.width * original.height > MAX_IMAGE_PIXELS
                ):
                    raise ServiceError(422, "invalid_image")
                original.load()
                # Fully decode and strip EXIF/metadata before a private queue entry is saved.
                return ImageOps.exif_transpose(original).convert("RGB")
    except (
        ValueError,
        UnidentifiedImageError,
        OSError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ):
        raise ServiceError(422, "invalid_image") from None


def normalized_payload(raw: Any) -> dict[str, Any]:
    try:
        payload = Submission.model_validate(raw)
    except ValidationError:
        # Never return Pydantic error input: it may contain a private photo or prompt.
        raise ServiceError(422, "invalid_request") from None
    if (
        payload.width % 16
        or payload.height % 16
        or payload.width * payload.height > 1_500_000
    ):
        raise ServiceError(422, "invalid_dimensions")
    if len(payload.images) != (1 if payload.operation == "photo" else 2):
        raise ServiceError(422, "invalid_image_count")
    data = payload.model_dump()
    safe_images = []
    for value in payload.images:
        image = decode_image(value)
        output = io.BytesIO()
        image.save(output, format="PNG", optimize=False)
        image.close()
        if output.tell() > MAX_IMAGE_BYTES:
            raise ServiceError(422, "normalized_image_too_large")
        safe_images.append(
            "data:image/png;base64,"
            + base64.b64encode(output.getvalue()).decode("ascii")
        )
    data["images"] = safe_images
    return data


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.root = settings.data_dir
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.files = self.root / "jobs"
        self.files.mkdir(exist_ok=True, mode=0o700)
        self.database = self.root / "queue.sqlite3"
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('in_queue','processing','completed','failed')),
                created_at REAL NOT NULL, expires_at REAL NOT NULL,
                error_code TEXT, deleted INTEGER NOT NULL DEFAULT 0,
                cleanup_pending INTEGER NOT NULL DEFAULT 0
            )""")
            db.execute(
                "CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state,created_at)"
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs(expires_at) WHERE deleted=0"
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS jobs_cleanup ON jobs(cleanup_pending) WHERE cleanup_pending>0"
            )
        os.chmod(self.database, 0o600)

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def job_dir(self, identifier: str) -> Path:
        identifier = canonical_id(identifier)
        path = self.files / identifier
        if path.resolve().parent != self.files.resolve() or path.is_symlink():
            raise ServiceError(500, "invalid_storage_path")
        return path

    def cleanup_files(self, identifier: str, include_output: bool = True):
        directory = self.job_dir(identifier)
        names = ["input.json", "input.tmp", "output.tmp"] + (
            ["output.png"] if include_output else []
        )
        for name in names:
            try:
                (directory / name).unlink(missing_ok=True)
            except OSError:
                # Cleanup failure is surfaced to the caller and retried by maintenance.
                raise ServiceError(503, "cleanup_retry_required") from None
        try:
            directory.rmdir()
        except (FileNotFoundError, OSError):
            pass  # A retained output or concurrent in-flight writer can keep the directory alive.

    def get(self, identifier: str) -> dict[str, Any]:
        identifier = canonical_id(identifier)
        self.expire()
        with self.connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise ServiceError(404, "job_not_found")
        return dict(row)

    def submit(self, payload: dict[str, Any]) -> dict[str, Any]:
        identifier = canonical_id(payload["request_id"])
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
        fingerprint = hashlib.sha256(encoded).hexdigest()
        self.expire()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                "SELECT * FROM jobs WHERE id=?", (identifier,)
            ).fetchone()
            if existing:
                if existing["deleted"]:
                    return dict(
                        existing
                    )  # Privacy tombstone wins even if DELETE arrived before POST.
                if not secrets.compare_digest(existing["fingerprint"], fingerprint):
                    raise ServiceError(409, "idempotency_conflict")
                return dict(existing)
            count = db.execute(
                "SELECT count(*) FROM jobs WHERE state IN ('in_queue','processing')"
            ).fetchone()[0]
            if count >= self.settings.max_queue:
                raise ServiceError(429, "queue_full")
            directory = self.job_dir(identifier)
            directory.mkdir(exist_ok=True, mode=0o700)
            temporary = directory / "input.tmp"
            try:
                with temporary.open("wb") as file:
                    file.write(encoded)
                    file.flush()
                    os.fsync(file.fileno())
                os.chmod(temporary, 0o600)
                temporary.replace(directory / "input.json")
                now = time.time()
                db.execute(
                    "INSERT INTO jobs(id,fingerprint,state,created_at,expires_at) VALUES(?,?,?,?,?)",
                    (
                        identifier,
                        fingerprint,
                        "in_queue",
                        now,
                        now + self.settings.retention_seconds,
                    ),
                )
                db.commit()
            except Exception:
                self.cleanup_files(identifier)
                raise
        return self.get(identifier)

    def recover_interrupted(self):
        with self.connect() as db:
            db.execute(
                "UPDATE jobs SET state='failed',error_code='worker_interrupted',cleanup_pending=1 WHERE state='processing'"
            )
        self.expire()

    def claim(self) -> dict[str, Any] | None:
        self.expire()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM jobs WHERE state='in_queue' AND deleted=0 ORDER BY created_at,id LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            db.execute(
                "UPDATE jobs SET state='processing' WHERE id=? AND state='in_queue'",
                (row["id"],),
            )
            return dict(row)

    def complete(self, identifier: str, image: Image.Image) -> bool:
        directory = self.job_dir(identifier)
        directory.mkdir(exist_ok=True, mode=0o700)
        temporary = directory / "output.tmp"
        try:
            if image.width * image.height > 1_500_000 or min(image.size) < 256:
                raise ServiceError(500, "invalid_model_output")
            # Serialize as a fresh RGB PNG; never retain input metadata.
            image.convert("RGB").save(temporary, format="PNG")
            os.chmod(temporary, 0o600)
            if temporary.stat().st_size > MAX_IMAGE_BYTES:
                raise ServiceError(500, "invalid_model_output")
            with self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute(
                    "SELECT * FROM jobs WHERE id=?", (identifier,)
                ).fetchone()
                if (
                    not row
                    or row["state"] != "processing"
                    or row["deleted"]
                    or row["expires_at"] <= time.time()
                ):
                    temporary.unlink(missing_ok=True)
                    self.cleanup_files(identifier)
                    return False
                temporary.replace(directory / "output.png")
                db.execute(
                    "UPDATE jobs SET state='completed',error_code=NULL,cleanup_pending=2 WHERE id=?",
                    (identifier,),
                )
            try:
                self.cleanup_files(identifier, include_output=False)
                with self.connect() as db:
                    db.execute(
                        "UPDATE jobs SET cleanup_pending=0 WHERE id=? AND cleanup_pending=2",
                        (identifier,),
                    )
            except ServiceError:
                pass  # Keep completed output, retry input-only cleanup in maintenance.
            return True
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

    def fail(self, identifier: str, code: str):
        with self.connect() as db:
            db.execute(
                "UPDATE jobs SET state='failed',error_code=?,cleanup_pending=1 WHERE id=? AND state NOT IN ('completed','failed')",
                (code, identifier),
            )
            row = db.execute(
                "SELECT state FROM jobs WHERE id=?", (identifier,)
            ).fetchone()
        if row and row["state"] != "completed":
            self.cleanup_files(identifier)
            with self.connect() as db:
                db.execute(
                    "UPDATE jobs SET cleanup_pending=0 WHERE id=? AND state='failed'",
                    (identifier,),
                )

    def delete(self, identifier: str):
        identifier = canonical_id(identifier)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            now = time.time()
            # A revoke can race a still-normalizing POST. A missing id must also be tombstoned.
            db.execute(
                """INSERT INTO jobs(id,fingerprint,state,created_at,expires_at,error_code,deleted,cleanup_pending)
                          VALUES(?,'','failed',?,?,'deleted',1,1)
                          ON CONFLICT(id) DO UPDATE SET state='failed',error_code='deleted',deleted=1,cleanup_pending=1""",
                (identifier, now, now + self.settings.retention_seconds),
            )
        self.cleanup_files(identifier)
        with self.connect() as db:
            db.execute(
                "UPDATE jobs SET cleanup_pending=0 WHERE id=? AND state='failed'",
                (identifier,),
            )

    def expire(self, orphans: bool = False):
        now = time.time()
        with self.connect() as db:
            expired = db.execute(
                "SELECT id FROM jobs WHERE expires_at<=? AND deleted=0 LIMIT 100",
                (now,),
            ).fetchall()
            for row in expired:
                db.execute(
                    "UPDATE jobs SET state='failed',error_code='expired',deleted=1,cleanup_pending=1 WHERE id=?",
                    (row["id"],),
                )
            rows = db.execute(
                "SELECT id,cleanup_pending,state FROM jobs WHERE cleanup_pending>0 LIMIT 100"
            ).fetchall()
        for row in rows:
            self.cleanup_files(
                row["id"],
                include_output=row["cleanup_pending"] != 2
                or row["state"] != "completed",
            )
            with self.connect() as db:
                db.execute(
                    "UPDATE jobs SET cleanup_pending=0 WHERE id=? AND cleanup_pending=?",
                    (row["id"], row["cleanup_pending"]),
                )
        # Remove abandoned files after a crash between disk persistence and the SQLite commit.
        if not orphans:
            return
        for directory in self.files.iterdir():
            if (
                not UUID_PATTERN.fullmatch(directory.name)
                or directory.is_symlink()
                or not directory.is_dir()
            ):
                continue
            with self.connect() as db:
                known = db.execute(
                    "SELECT 1 FROM jobs WHERE id=?", (directory.name,)
                ).fetchone()
            if known is None and directory.stat().st_mtime < now - 3600:
                self.cleanup_files(directory.name)


class QwenEngine:
    """Real GPU pipeline. No other model or remote Python code can be selected."""

    ready = False

    def __init__(self, settings: Settings):
        self.settings = settings
        self.pipeline = None

    def load(self):
        import torch
        from diffusers import QwenImageEditPlusPipeline

        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise RuntimeError("cuda_bfloat16_required")
        self.pipeline = QwenImageEditPlusPipeline.from_pretrained(
            MODEL_ID,
            revision=self.settings.revision,
            torch_dtype=torch.bfloat16,
            use_safetensors=True,
            trust_remote_code=False,
        )
        if self.settings.offload == "model":
            self.pipeline.enable_model_cpu_offload()
        elif self.settings.offload == "sequential":
            self.pipeline.enable_sequential_cpu_offload()
        else:
            self.pipeline.to("cuda")
        self.pipeline.vae.enable_tiling()
        self.pipeline.set_progress_bar_config(disable=True)
        self.ready = True

    def generate(self, payload: dict[str, Any]) -> Image.Image:
        import torch

        images = [decode_image(value) for value in payload["images"]]
        try:
            with torch.inference_mode():
                result = self.pipeline(
                    image=images,
                    prompt=payload["prompt"],
                    negative_prompt=" ",
                    width=payload["width"],
                    height=payload["height"],
                    num_inference_steps=40,
                    true_cfg_scale=4.0,
                    guidance_scale=1.0,
                    generator=torch.Generator(device="cpu").manual_seed(
                        payload["seed"]
                    ),
                ).images[0]
            return result
        finally:
            for image in images:
                image.close()


class WorkerLock:
    """A process lock prevents a second GPU worker from recovering an active worker's jobs."""

    def __init__(self, path: Path):
        self.file = path.open("a+b")
        self.file.write(b"0")
        self.file.flush()
        try:
            if os.name == "nt":
                import msvcrt

                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            raise RuntimeError(
                "Only one Qwen service process may own this data volume"
            ) from None

    def close(self):
        if self.file.closed:
            return
        if os.name == "nt":
            import msvcrt

            self.file.seek(0)
            msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
        self.file.close()


class Service:
    def __init__(self, settings: Settings, engine=None):
        self.settings = settings
        self.store = Store(settings)
        self.engine = engine or QwenEngine(settings)
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.thread = None
        self.maintenance_thread = None
        self.cleanup_failure = False
        self.failure = None
        self.lock = None

    def start(self):
        self.lock = WorkerLock(self.settings.data_dir / "worker.lock")
        try:
            self.store.recover_interrupted()
        except Exception:
            self.lock.close()
            raise
        self.maintenance_thread = threading.Thread(
            target=self.maintenance, daemon=True, name="qwen-media-cleanup"
        )
        self.maintenance_thread.start()
        self.thread = threading.Thread(
            target=self.run, daemon=True, name="qwen-gpu-worker"
        )
        self.thread.start()

    def run(self):
        try:
            self.run_engine()
        finally:
            if self.stop.is_set() and self.lock:
                self.lock.close()

    def run_engine(self):
        try:
            self.engine.load()
        except Exception:  # noqa: BLE001 - GPU initialization errors must not expose private paths.
            self.failure = "gpu_or_model_unavailable"
            return
        while not self.stop.is_set():
            try:
                if not self.process_one():
                    self.wake.wait(5)
                    self.wake.clear()
            except Exception:  # noqa: BLE001 - worker boundary records a safe code, never raw input.
                # No raw exception text: it may include input paths or prompts.
                self.failure = "worker_control_error"
                self.wake.wait(5)
                self.wake.clear()

    def maintenance(self):
        # Retention cleanup must continue even if model loading or GPU initialization fails.
        while not self.stop.is_set():
            try:
                self.store.expire(orphans=True)
                self.cleanup_failure = False
            except Exception:  # noqa: BLE001 - durable cleanup must retry unknown storage failures.
                self.cleanup_failure = True
            self.stop.wait(60)

    def process_one(self) -> bool:
        row = self.store.claim()
        if row is None:
            return False
        identifier = row["id"]
        try:
            payload = json.loads(
                (self.store.job_dir(identifier) / "input.json").read_text("utf-8")
            )
            image = self.engine.generate(payload)
            try:
                self.store.complete(identifier, image)
            finally:
                image.close()
        except Exception:  # noqa: BLE001 - every engine failure must release private input files.
            self.store.fail(identifier, "inference_failed")
        return True

    def shutdown(self):
        self.stop.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=5)
        if self.maintenance_thread:
            self.maintenance_thread.join(timeout=5)
        if self.lock and (not self.thread or not self.thread.is_alive()):
            self.lock.close()

    def result(self, row: dict[str, Any]):
        return {
            "id": row["id"],
            "model": MODEL_ID,
            "status": row["state"],
            "output": [f"{self.settings.public_url}/v1/jobs/{row['id']}/output"]
            if row["state"] == "completed"
            else [],
            "error_code": row["error_code"],
        }


def create_app(
    settings: Settings | None = None, engine=None, start_worker: bool = True
) -> FastAPI:
    settings = settings or Settings.from_environment()
    service = Service(settings, engine)

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        if start_worker:
            service.start()
        try:
            yield
        finally:
            if start_worker:
                service.shutdown()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.service = service

    @app.exception_handler(ServiceError)
    async def service_error(_request, error: ServiceError):
        return JSONResponse(
            {"error": error.code},
            status_code=error.status,
            headers={"Cache-Control": "private, no-store"},
        )

    @app.middleware("http")
    async def security_headers(request: Request, next_handler):
        if request.url.path != "/health":
            authorization = request.headers.get("authorization", "")
            if not secrets.compare_digest(
                authorization.encode("utf-8"), f"Bearer {settings.api_key}".encode()
            ):
                return JSONResponse(
                    {"error": "unauthorized"},
                    status_code=401,
                    headers={"Cache-Control": "no-store"},
                )
        result = await next_handler(request)
        result.headers["Cache-Control"] = "private, no-store"
        result.headers["X-Content-Type-Options"] = "nosniff"
        return result

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/ready")
    async def ready():
        is_ready = bool(
            service.engine.ready and not service.failure and not service.cleanup_failure
        )
        return JSONResponse(
            {
                "status": "ready" if is_ready else "not_ready",
                "model": MODEL_ID,
                "revision": settings.revision,
                "ready": is_ready,
            },
            status_code=200 if is_ready else 503,
        )

    @app.post("/v1/jobs")
    async def submit(request: Request):
        if not service.engine.ready or service.failure or service.cleanup_failure:
            raise ServiceError(503, "gpu_or_model_unavailable")
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            raise ServiceError(415, "json_required")
        try:
            if int(request.headers.get("content-length", "0")) > MAX_BODY_BYTES:
                raise ServiceError(413, "request_too_large")
        except ValueError:
            raise ServiceError(400, "invalid_content_length") from None
        chunks = bytearray()
        async for chunk in request.stream():
            if len(chunks) + len(chunk) > MAX_BODY_BYTES:
                raise ServiceError(413, "request_too_large")
            chunks.extend(chunk)
        try:
            raw = json.loads(chunks)
        except (ValueError, UnicodeDecodeError):
            raise ServiceError(400, "invalid_json") from None
        # Decode off the ASGI loop; a bounded image cannot block status/deletion requests.
        payload = await asyncio.to_thread(normalized_payload, raw)
        row = await asyncio.to_thread(service.store.submit, payload)
        service.wake.set()
        return JSONResponse(service.result(row), status_code=202)

    @app.get("/v1/jobs/{identifier}")
    async def status(identifier: str):
        return service.result(await asyncio.to_thread(service.store.get, identifier))

    @app.get("/v1/jobs/{identifier}/output")
    async def output(identifier: str):
        row = await asyncio.to_thread(service.store.get, identifier)
        if row["state"] != "completed":
            raise ServiceError(409, "output_unavailable")
        path = service.store.job_dir(identifier) / "output.png"
        try:
            data = path.read_bytes()
        except OSError:
            raise ServiceError(503, "output_unavailable") from None
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise ServiceError(503, "output_unavailable")
        return Response(data, media_type="image/png")

    @app.delete("/v1/jobs/{identifier}")
    async def delete(identifier: str):
        await asyncio.to_thread(service.store.delete, identifier)
        return {"ok": True}

    return app
