import io
import json
import os
import plistlib
import unittest
import zipfile

os.environ["STORAGE_URL"] = "mem://"
os.environ["UPLOADS_SECRET_AUTH_TOKEN"] = "dashboard-test-token"  # noqa: S105 - test-only fixture
os.environ["APP_BASE_URL"] = "https://distribution.example.test"

from fastapi.testclient import TestClient  # noqa: E402
from fs.memoryfs import MemoryFS  # noqa: E402

from app_distribution_server import storage  # noqa: E402
from app_distribution_server.app import app  # noqa: E402


def make_ipa(version="1.0", title="Anpros Test", nested=False):
    metadata = {
        "CFBundleIdentifier": "com.anpros.dashboard-test",
        "CFBundleName": title,
        "CFBundleShortVersionString": version,
    }
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as ipa:
        if nested:
            ipa.writestr(
                zipfile.ZipInfo("Payload/Test.app/Watch/Watch.app/Info.plist"),
                plistlib.dumps(dict(metadata, CFBundleIdentifier="com.anpros.watch")),
            )
        ipa.writestr(zipfile.ZipInfo("Payload/Test.app/Info.plist"), plistlib.dumps(metadata))
    return archive.getvalue()


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.previous_fs = storage.filesystem
        storage.filesystem = MemoryFS()
        self.client = TestClient(app, raise_server_exceptions=False)
        self.headers = {"X-Auth-Token": "dashboard-test-token"}

    def tearDown(self):
        self.client.close()
        storage.filesystem.close()
        storage.filesystem = self.previous_fs

    def upload(self, version="1.0", **kwargs):
        response = self.client.post(
            "/api/upload",
            headers=self.headers,
            files={"app_file": ("test.IPA", make_ipa(version, **kwargs))},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_dashboard_is_public_but_build_data_requires_authentication(self):
        self.upload(title="Private unreleased app")
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Upload build", response.text)
        self.assertNotIn("Private unreleased app", response.text)
        self.assertNotIn("dashboard-test-token", response.text)
        self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
        for headers in ({}, {"X-Auth-Token": "incorrect"}):
            response = self.client.get("/api/builds", headers=headers)
            self.assertEqual(response.status_code, 403)
            self.assertNotIn("Private unreleased app", response.text)

    def test_list_contains_uploaded_builds_newest_first_and_is_not_cached(self):
        first = self.upload("1.0")
        second = self.upload("2.0", nested=True)
        response = self.client.get("/api/builds", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(
            [item["upload_id"] for item in response.json()],
            [second["upload_id"], first["upload_id"]],
        )
        self.assertEqual(second["bundle_id"], "com.anpros.dashboard-test")
        self.assertEqual(second["app_title"], "Anpros Test")

    def test_delete_latest_restores_previous_and_last_delete_removes_index(self):
        first = self.upload("1.0")
        second = self.upload("2.0")
        endpoint = "/api/bundle/com.anpros.dashboard-test/latest_upload"
        self.assertEqual(
            self.client.get(endpoint, headers=self.headers).json()["upload_id"], second["upload_id"]
        )
        self.assertEqual(
            self.client.delete(
                f"/api/delete/{second['upload_id']}", headers=self.headers
            ).status_code,
            200,
        )
        self.assertEqual(
            self.client.get(endpoint, headers=self.headers).json()["upload_id"], first["upload_id"]
        )
        self.assertEqual(self.client.get(f"/get/{second['upload_id']}/app.ipa").status_code, 404)
        self.client.delete(f"/api/delete/{first['upload_id']}", headers=self.headers)
        self.assertEqual(self.client.get(endpoint, headers=self.headers).status_code, 404)
        self.assertEqual(self.client.get("/api/builds", headers=self.headers).json(), [])

    def test_delete_older_build_does_not_replace_latest(self):
        first = self.upload("1.0")
        second = self.upload("2.0")
        self.client.delete(f"/api/delete/{first['upload_id']}", headers=self.headers)
        self.assertEqual(
            storage.get_latest_upload_id_by_bundle_id("com.anpros.dashboard-test"),
            second["upload_id"],
        )

    def test_invalid_archives_are_client_errors(self):
        for filename in ("broken.ipa", "broken.apk", "unsupported.txt"):
            with self.subTest(filename=filename):
                response = self.client.post(
                    "/api/upload",
                    headers=self.headers,
                    files={"app_file": (filename, b"not an archive")},
                )
                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/api/builds", headers=self.headers).json(), [])

    def test_list_handles_legacy_and_incomplete_uploads(self):
        storage.filesystem.makedirs("legacy")
        storage.filesystem.writebytes("legacy/app.ipa", make_ipa())
        storage.filesystem.writetext(
            "legacy/app_info.json",
            json.dumps(
                {"app_title": "Legacy", "bundle_id": "com.anpros.legacy", "bundle_version": "1"}
            ),
        )
        storage.filesystem.makedirs("incomplete")
        storage.filesystem.writebytes("incomplete/app.ipa", b"partial")
        storage.filesystem.writetext("incomplete/build_info.json", "{broken")
        current = self.upload()
        listed = self.client.get("/api/builds", headers=self.headers).json()
        self.assertEqual([item["upload_id"] for item in listed], [current["upload_id"], "legacy"])
        self.assertIsNone(listed[1]["created_at"])

    def test_upload_installation_manifest_and_download(self):
        build = self.upload(title="QA & Review")
        prefix = f"/get/{build['upload_id']}"
        page = self.client.get(prefix)
        self.assertEqual(page.status_code, 200)
        self.assertIn("QA &amp; Review", page.text)
        self.assertIn("<svg", page.text)
        manifest = plistlib.loads(
            self.client.get(f"{prefix}/app.plist").content, fmt=plistlib.FMT_XML
        )
        self.assertEqual(
            manifest["items"][0]["assets"][0]["url"],
            f"https://distribution.example.test{prefix}/app.ipa",
        )
        self.assertEqual(
            self.client.get(f"{prefix}/app.ipa").content, make_ipa(title="QA & Review")
        )


if __name__ == "__main__":
    unittest.main()
