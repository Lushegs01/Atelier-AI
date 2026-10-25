"""CPU-only control-plane tests. No Torch, CUDA, downloaded weights or live AI."""

import base64
import io
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import (
    MAX_BODY_BYTES,
    MODEL_ID,
    QwenEngine,
    ServiceError,
    Settings,
    Store,
    WorkerLock,
    create_app,
    normalized_payload,
)

IDENTIFIER = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
KEY = "synthetic-private-service-test-credential-12345"


def source_image():
    target = io.BytesIO()
    Image.new("RGB", (256, 256), "blue").save(target, format="PNG")
    return "data:image/png;base64," + base64.b64encode(target.getvalue()).decode(
        "ascii"
    )


def payload(identifier=IDENTIFIER):
    return {
        "request_id": identifier,
        "operation": "photo",
        "images": [source_image()],
        "prompt": "Synthetic fully clothed fashion example",
        "width": 864,
        "height": 1152,
        "seed": 42,
        "output_format": "png",
        "num_inference_steps": 40,
        "true_cfg_scale": 4.0,
    }


class FakeEngine:
    ready = True
    calls = 0

    def load(self):
        self.ready = True

    def generate(self, _payload):
        self.calls += 1
        return Image.new("RGB", (864, 1152), "green")


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.settings = Settings(
            KEY,
            "https://private-gpu.example/qwen",
            Path(self.directory.name),
            max_queue=2,
        )
        self.engine = FakeEngine()
        self.app = create_app(self.settings, self.engine, start_worker=False)
        self.client = TestClient(self.app)
        self.headers = {"Authorization": f"Bearer {KEY}"}
        self.service = self.app.state.service

    def tearDown(self):
        self.client.close()
        self.directory.cleanup()

    def post(self, data=None):
        return self.client.post(
            "/v1/jobs", headers=self.headers, json=data or payload()
        )

    def test_health_is_minimal_and_all_other_routes_require_bearer(self):
        self.assertEqual(self.client.get("/health").json(), {"status": "ok"})
        self.assertEqual(self.client.get("/ready").status_code, 401)
        self.assertEqual(
            self.client.get(f"/v1/jobs/{IDENTIFIER}/output").status_code, 401
        )
        self.assertEqual(self.client.delete(f"/v1/jobs/{IDENTIFIER}").status_code, 401)
        ready = self.client.get("/ready", headers=self.headers).json()
        self.assertEqual(ready["status"], "ready")
        self.assertEqual(ready["model"], MODEL_ID)
        self.assertEqual(len(ready["revision"]), 40)

    def test_missing_gpu_is_not_ready_and_never_fakes_a_result(self):
        self.engine.ready = False
        self.assertEqual(
            self.client.get("/ready", headers=self.headers).status_code, 503
        )
        self.assertEqual(self.post().status_code, 503)
        self.assertEqual(self.engine.calls, 0)

    def test_idempotent_submission_survives_new_store_and_rejects_changed_input(self):
        self.assertEqual(self.post().status_code, 202)
        self.assertEqual(self.post().json()["id"], IDENTIFIER)
        different = payload()
        different["prompt"] = "Different settings"
        self.assertEqual(self.post(different).status_code, 409)
        reopened = Store(self.settings)
        self.assertEqual(reopened.get(IDENTIFIER)["state"], "in_queue")
        self.assertEqual(
            reopened.submit(normalized_payload(payload()))["state"], "in_queue"
        )

    def test_queue_is_bounded_and_replays_remain_possible_when_full(self):
        self.post()
        self.post(payload(OTHER))
        third = payload("33333333-3333-4333-8333-333333333333")
        self.assertEqual(self.post(third).status_code, 429)
        self.assertEqual(self.post().status_code, 202)

    def test_real_control_plane_copies_completed_bytes_and_removes_inputs(self):
        self.post()
        self.assertTrue(self.service.process_one())
        status = self.client.get(f"/v1/jobs/{IDENTIFIER}", headers=self.headers)
        self.assertEqual(status.json()["status"], "completed")
        self.assertEqual(
            status.json()["output"],
            [f"https://private-gpu.example/qwen/v1/jobs/{IDENTIFIER}/output"],
        )
        result = self.client.get(f"/v1/jobs/{IDENTIFIER}/output", headers=self.headers)
        self.assertEqual(result.headers["content-type"], "image/png")
        self.assertEqual(result.headers["cache-control"], "private, no-store")
        self.assertFalse(
            (self.service.store.job_dir(IDENTIFIER) / "input.json").exists()
        )
        self.assertEqual(self.post().json()["status"], "completed")
        self.assertEqual(self.engine.calls, 1)

    def test_restart_fails_interrupted_work_without_regenerating(self):
        self.post()
        self.service.store.claim()
        reopened = Store(self.settings)
        reopened.recover_interrupted()
        status = reopened.get(IDENTIFIER)
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["error_code"], "worker_interrupted")
        self.assertFalse(reopened.job_dir(IDENTIFIER).exists())
        self.assertEqual(self.post().json()["status"], "failed")
        self.assertEqual(self.engine.calls, 0)

    def test_rejects_arbitrary_urls_invalid_bytes_wrong_count_and_excessive_dimensions(
        self,
    ):
        examples = []
        for image in [
            "https://169.254.169.254/latest/meta-data/",
            "data:image/png;base64,ZmFrZQ==",
            "data:image/svg+xml;base64,PHN2Zz4=",
        ]:
            request = payload()
            request["images"] = [image]
            examples.append(request)
        request = payload()
        request["operation"] = "try_on"
        examples.append(request)
        request = payload()
        request["width"] = 1536
        request["height"] = 1536
        examples.append(request)
        request = payload()
        request["width"] = 865
        examples.append(request)
        request = payload()
        request["unexpected"] = "secret"
        examples.append(request)
        for request in examples:
            result = self.post(request)
            self.assertEqual(result.status_code, 422)
            self.assertNotIn(request["images"][0], result.text)
        self.assertEqual(self.engine.calls, 0)

    def test_body_bound_is_enforced_before_json_decode(self):
        result = self.client.post(
            "/v1/jobs",
            headers={
                **self.headers,
                "Content-Type": "application/json",
                "Content-Length": str(MAX_BODY_BYTES + 1),
            },
            content="{}",
        )
        self.assertEqual(result.status_code, 413)

    def test_deletion_revokes_bytes_and_retains_idempotency_tombstone(self):
        self.post()
        self.service.process_one()
        result = self.client.delete(f"/v1/jobs/{IDENTIFIER}", headers=self.headers)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(
            self.client.get(
                f"/v1/jobs/{IDENTIFIER}/output", headers=self.headers
            ).status_code,
            409,
        )
        self.assertFalse(self.service.store.job_dir(IDENTIFIER).exists())
        self.assertEqual(self.post().json()["status"], "failed")
        self.assertEqual(self.engine.calls, 1)
        self.assertEqual(
            self.client.delete(
                f"/v1/jobs/{IDENTIFIER}", headers=self.headers
            ).status_code,
            200,
        )

    def test_deletion_during_inference_discards_late_output(self):
        started = threading.Event()
        release = threading.Event()

        def generate(_payload):
            started.set()
            release.wait(5)
            return Image.new("RGB", (864, 1152), "red")

        self.engine.generate = generate
        self.post()
        thread = threading.Thread(target=self.service.process_one)
        thread.start()
        self.assertTrue(started.wait(5))
        self.client.delete(f"/v1/jobs/{IDENTIFIER}", headers=self.headers)
        release.set()
        thread.join(5)
        status = self.service.store.get(IDENTIFIER)
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["error_code"], "deleted")
        self.assertFalse(self.service.store.job_dir(IDENTIFIER).exists())

    def test_delete_before_a_delayed_submission_creates_a_privacy_tombstone(self):
        result = self.client.delete(f"/v1/jobs/{IDENTIFIER}", headers=self.headers)
        self.assertEqual(result.status_code, 200)
        result = self.post()
        self.assertEqual(result.json()["status"], "failed")
        self.assertEqual(result.json()["error_code"], "deleted")
        self.assertFalse(self.service.store.job_dir(IDENTIFIER).exists())
        self.assertFalse(self.service.process_one())
        self.assertEqual(self.engine.calls, 0)

    def test_expiry_deletes_media_but_stale_replay_never_reexecutes(self):
        self.post()
        self.service.process_one()
        with self.service.store.connect() as db:
            db.execute(
                "UPDATE jobs SET expires_at=? WHERE id=?", (time.time() - 1, IDENTIFIER)
            )
        self.service.store.expire()
        self.assertFalse(self.service.store.job_dir(IDENTIFIER).exists())
        self.assertEqual(self.post().json()["error_code"], "expired")
        self.assertEqual(self.engine.calls, 1)

    def test_cleanup_failure_is_retryable_without_losing_tombstone(self):
        self.post()
        original = self.service.store.cleanup_files
        with patch.object(
            self.service.store,
            "cleanup_files",
            side_effect=ServiceError(503, "cleanup_retry_required"),
        ):
            self.assertEqual(
                self.client.delete(
                    f"/v1/jobs/{IDENTIFIER}", headers=self.headers
                ).status_code,
                503,
            )
        original(IDENTIFIER)
        self.service.store.expire()
        self.assertFalse(self.service.store.job_dir(IDENTIFIER).exists())
        self.assertEqual(self.post().json()["status"], "failed")

    def test_completed_input_cleanup_failure_preserves_authorized_output(self):
        self.post()
        original = self.service.store.cleanup_files
        calls = 0

        def cleanup(identifier, include_output=True):
            nonlocal calls
            if not include_output and calls == 0:
                calls += 1
                raise ServiceError(503, "cleanup_retry_required")
            return original(identifier, include_output)

        with patch.object(self.service.store, "cleanup_files", side_effect=cleanup):
            self.service.process_one()
        self.assertEqual(self.service.store.get(IDENTIFIER)["state"], "completed")
        self.assertTrue(
            (self.service.store.job_dir(IDENTIFIER) / "output.png").exists()
        )
        self.assertFalse(
            (self.service.store.job_dir(IDENTIFIER) / "input.json").exists()
        )

    def test_metadata_is_removed_before_durable_storage(self):
        request = payload()
        self.post(request)
        saved = json.loads(
            (self.service.store.job_dir(IDENTIFIER) / "input.json").read_text()
        )
        image = Image.open(
            io.BytesIO(base64.b64decode(saved["images"][0].split(",")[1]))
        )
        self.assertFalse(image.getexif())
        image.close()

    def test_inference_failure_removes_private_input_and_never_echoes_raw_error(self):
        def fail(_payload):
            raise RuntimeError("private prompt and customer photo must not be logged")

        self.engine.generate = fail
        self.post()
        self.service.process_one()
        result = self.client.get(f"/v1/jobs/{IDENTIFIER}", headers=self.headers)
        self.assertEqual(result.json()["error_code"], "inference_failed")
        self.assertNotIn("customer photo", result.text)
        self.assertFalse(self.service.store.job_dir(IDENTIFIER).exists())

    def test_readiness_never_loads_the_model_or_downloads_weights(self):
        app = create_app(self.settings, start_worker=False)
        with (
            patch.object(
                QwenEngine,
                "load",
                side_effect=AssertionError("Model loading must not happen in health"),
            ) as load,
            TestClient(app) as client,
        ):
            self.assertEqual(client.get("/health").status_code, 200)
            self.assertEqual(
                client.get("/ready", headers=self.headers).status_code, 503
            )
            load.assert_not_called()

    def test_settings_reject_remote_http_weak_tokens_and_arbitrary_revision(self):
        with self.assertRaises(ValueError):
            Settings(KEY, "http://gpu.example", Path(self.directory.name))
        with self.assertRaises(ValueError):
            Settings("short", "https://gpu.example", Path(self.directory.name))
        with self.assertRaises(ValueError):
            Settings(
                KEY, "https://gpu.example", Path(self.directory.name), revision="main"
            )
        Settings(
            KEY,
            "http://127.0.0.1:8000",
            Path(self.directory.name),
            production=False,
            allow_local=True,
        )

    def test_second_process_lock_cannot_recover_an_active_queue(self):
        first = WorkerLock(Path(self.directory.name) / "worker.lock")
        try:
            with self.assertRaises(RuntimeError):
                WorkerLock(Path(self.directory.name) / "worker.lock")
        finally:
            first.close()

    def test_http_lifespan_runs_the_durable_background_worker(self):
        engine = FakeEngine()
        app = create_app(self.settings, engine, start_worker=True)
        with TestClient(app) as client:
            response = client.post("/v1/jobs", headers=self.headers, json=payload())
            self.assertEqual(response.status_code, 202)
            for _ in range(100):
                state = client.get(
                    f"/v1/jobs/{IDENTIFIER}", headers=self.headers
                ).json()["status"]
                if state == "completed":
                    break
                time.sleep(0.02)
            self.assertEqual(state, "completed")
            self.assertEqual(engine.calls, 1)


if __name__ == "__main__":
    unittest.main()
