"""Tests for isolation from mutable files owned by a live sandbox runtime."""

from pathlib import Path

from sandbox_runtime import bridge, constants, entrypoint


def test_runtime_file_paths_resolve_under_each_test_directory(tmp_path):
    isolated_paths = {
        Path(entrypoint.REPO_MANIFEST_FILE_PATH),
        Path(bridge.REPO_MANIFEST_FILE_PATH),
        Path(entrypoint.BOOT_WARNINGS_FILE_PATH),
        Path(bridge.BOOT_WARNINGS_FILE_PATH),
        Path(entrypoint.TUNNEL_ENV_FILE_PATH),
    }
    live_paths = {
        Path(constants.REPO_MANIFEST_FILE_PATH),
        Path(constants.BOOT_WARNINGS_FILE_PATH),
        Path(constants.TUNNEL_ENV_FILE_PATH),
    }

    assert all(path.parent == tmp_path for path in isolated_paths)
    assert isolated_paths.isdisjoint(live_paths)
