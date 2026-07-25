"""Shared test fixtures and utilities for sandbox-runtime tests."""

from pathlib import Path
from typing import Any

import httpx
import pytest


@pytest.fixture(autouse=True)
def isolate_runtime_file_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep tests from reading or modifying files owned by a live sandbox."""
    manifest_path = str(tmp_path / "oi-repo-manifest.json")
    boot_warnings_path = str(tmp_path / "oi-boot-warnings.jsonl")
    tunnel_env_path = str(tmp_path / ".tunnels.env")

    monkeypatch.setattr("sandbox_runtime.bridge.tempfile.tempdir", str(tmp_path))
    monkeypatch.setattr("sandbox_runtime.entrypoint.REPO_MANIFEST_FILE_PATH", manifest_path)
    monkeypatch.setattr("sandbox_runtime.bridge.REPO_MANIFEST_FILE_PATH", manifest_path)
    monkeypatch.setattr("sandbox_runtime.entrypoint.BOOT_WARNINGS_FILE_PATH", boot_warnings_path)
    monkeypatch.setattr("sandbox_runtime.bridge.BOOT_WARNINGS_FILE_PATH", boot_warnings_path)
    monkeypatch.setattr("sandbox_runtime.entrypoint.TUNNEL_ENV_FILE_PATH", tunnel_env_path)


class MockResponse:
    """Mock HTTP response for testing."""

    def __init__(self, status_code: int, json_data: Any = None, text: str = ""):
        self.status_code = status_code
        self._json_data = json_data
        self.text = text

    def json(self) -> Any:
        return self._json_data

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}",
                request=httpx.Request("GET", "http://test"),
                response=httpx.Response(self.status_code),
            )
