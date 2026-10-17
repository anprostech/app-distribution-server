import io
import json
import unittest
import zipfile
from uuid import uuid4

from fastapi.testclient import TestClient
from fs.memoryfs import MemoryFS
from test_dashboard import make_ipa

from app_distribution_server import storage
from app_distribution_server.app import app
from app_distribution_server.routers import transfer_router as transfers


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.previous_fs = storage.filesystem
        storage.filesystem = MemoryFS()
        self.client = TestClient(app, raise_server_exceptions=False)
        self.headers = {"X-Auth-Token": "dashboard-test-token"}

    def tearDown(self):
        self.client.close()
        storage.filesystem.close()
        storage.filesystem = self.previous_fs

    def create(self, content, filename="app.ipa"):
        response = self.client.post(
            "/api/transfers",
            json={"filename": filename, "size": len(content)},
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 201, response.text)
        return f"/api/transfers/{response.json()['session_id']}"

    def part(self, url, index, content):
        return self.client.put(f"{url}/parts/{index}", content=content, headers=self.headers)

    def test_all_transfer_operations_require_authentication(self):
        url = self.create(make_ipa())
        responses = [
            self.client.post("/api/transfers", json={"filename": "a.apk", "size": 10}),
            self.client.get(url),
            self.client.put(f"{url}/parts/0", content=b"test"),
            self.client.post(f"{url}/complete"),
        ]
        for response in responses:
            self.assertEqual(response.status_code, 403)

    def test_resume_out_of_order_parts_and_idempotent_completion(self):
        archive = io.BytesIO(make_ipa())
        with zipfile.ZipFile(archive, "a") as package:
            package.writestr("Payload/Test.app/padding", b"x" * transfers.CHUNK_SIZE * 2)
        content = archive.getvalue()
        url = self.create(content)
        size = transfers.CHUNK_SIZE
        for index in [1, 1, 0]:
            self.assertEqual(
                self.part(url, index, content[index * size : (index + 1) * size]).status_code, 204
            )
        status = self.client.get(url, headers=self.headers)
        self.assertEqual(status.json()["received"], [0, 1])
        self.assertEqual(status.headers["Cache-Control"], "no-store")
        self.assertEqual(self.client.post(f"{url}/complete", headers=self.headers).status_code, 409)
        self.assertEqual(self.part(url, 2, content[2 * size :]).status_code, 204)
        self.assertEqual(self.client.post(f"{url}/complete", headers=self.headers).status_code, 202)
        result = self.client.get(url, headers=self.headers).json()
        self.assertEqual(result["status"], "complete")
        upload_id = result["build"]["upload_id"]
        self.assertEqual(self.client.get(f"/get/{upload_id}/app.ipa").content, content)
        repeated = self.client.post(f"{url}/complete", headers=self.headers).json()
        self.assertEqual(repeated["build"]["upload_id"], upload_id)
        self.assertEqual(len(self.client.get("/api/builds", headers=self.headers).json()), 1)
        self.assertFalse(
            any(
                name.endswith(".part")
                for name in storage.filesystem.listdir(f"_transfers/{url.rsplit('/', 1)[1]}")
            )
        )

    def test_invalid_or_oversized_parts_do_not_count_as_progress(self):
        content = make_ipa()
        url = self.create(content)
        for index, body, expected in [
            (0, b"short", 400),
            (-1, content, 400),
            (5, content, 400),
            (0, b"x" * (transfers.CHUNK_SIZE + 1), 413),
        ]:
            self.assertEqual(self.part(url, index, body).status_code, expected)
        self.assertEqual(self.client.get(url, headers=self.headers).json()["received"], [])

    def test_restart_preserves_parts_and_recovers_processing(self):
        content = make_ipa()
        url = self.create(content)
        self.part(url, 0, content)
        session_id = url.rsplit("/", 1)[1]
        data = transfers.read_session(session_id)
        data["status"] = "processing"
        transfers.save_session(session_id, data)
        resumed = self.client.get(url, headers=self.headers).json()
        self.assertEqual(resumed["status"], "uploading")
        self.assertEqual(resumed["received"], [0])
        self.client.post(f"{url}/complete", headers=self.headers)
        self.assertEqual(self.client.get(url, headers=self.headers).json()["status"], "complete")

    def test_invalid_apk_reports_failure_and_cleans_parts(self):
        content = b"not an apk"
        url = self.create(content, "bad.apk")
        self.part(url, 0, content)
        self.client.post(f"{url}/complete", headers=self.headers)
        result = self.client.get(url, headers=self.headers).json()
        self.assertEqual(result["status"], "error")
        self.assertIn("valid .ipa or .apk", result["error"])
        self.assertEqual(self.client.get("/api/builds", headers=self.headers).json(), [])

    def test_expiration_and_input_bounds(self):
        url = self.create(make_ipa())
        session_id = url.rsplit("/", 1)[1]
        filename = f"_transfers/{session_id}/session.json"
        data = json.loads(storage.filesystem.readtext(filename))
        data["updated"] = 0
        storage.filesystem.writetext(filename, json.dumps(data))
        self.assertEqual(self.client.get(url, headers=self.headers).status_code, 404)
        self.create(make_ipa())
        self.assertFalse(storage.filesystem.exists(f"_transfers/{session_id}"))
        self.assertEqual(
            self.client.get(f"/api/transfers/{uuid4()}", headers=self.headers).status_code, 404
        )
        for filename, size in [("x.txt", 3), ("x.apk", 0), ("x.apk", transfers.MAX_FILE_SIZE + 1)]:
            response = self.client.post(
                "/api/transfers", json={"filename": filename, "size": size}, headers=self.headers
            )
            self.assertEqual(response.status_code, 422)
