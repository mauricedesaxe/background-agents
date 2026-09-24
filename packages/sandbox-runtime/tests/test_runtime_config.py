import json
from types import MappingProxyType

import pytest
from pydantic import ValidationError

from sandbox_runtime.runtime_config import BootMode, RuntimeConfig
from sandbox_runtime.types import SessionConfig


def test_session_config_defaults_beads_authority_to_off():
    assert SessionConfig(session_id="session-1").beads_authority == "off"


def test_session_config_rejects_invalid_beads_authority():
    with pytest.raises(ValidationError):
        SessionConfig(session_id="session-1", beads_authority="admin")


@pytest.mark.parametrize(
    ("environment", "expected"),
    [
        ({}, BootMode.FRESH),
        ({"FROM_REPO_IMAGE": "true"}, BootMode.REPO_IMAGE),
        ({"RESTORED_FROM_SNAPSHOT": "true"}, BootMode.SNAPSHOT_RESTORE),
        (
            {"IMAGE_BUILD_MODE": "true", "RESTORED_FROM_SNAPSHOT": "true"},
            BootMode.BUILD,
        ),
    ],
)
def test_boot_mode_precedence(environment, expected):
    assert BootMode.from_env(environment, resume_marker_files=()) is expected


@pytest.mark.parametrize("marker_name", ["agent-session-id", "opencode-session-id"])
def test_persisted_agent_session_selects_persistent_resume(tmp_path, marker_name):
    marker = tmp_path / marker_name
    marker.write_text("agent-session-1\n")

    assert BootMode.from_env({}, resume_marker_files=(marker,)) is BootMode.PERSISTENT_RESUME


@pytest.mark.parametrize(
    ("environment", "expected"),
    [
        ({"RESTORED_FROM_SNAPSHOT": "true"}, BootMode.SNAPSHOT_RESTORE),
        (
            {"IMAGE_BUILD_MODE": "true", "RESTORED_FROM_SNAPSHOT": "true"},
            BootMode.BUILD,
        ),
    ],
)
def test_explicit_boot_mode_takes_precedence_over_persisted_agent_session(
    tmp_path, environment, expected
):
    marker = tmp_path / "agent-session-id"
    marker.write_text("agent-session-1\n")

    assert BootMode.from_env(environment, resume_marker_files=(marker,)) is expected


def test_persisted_agent_session_overrides_repo_image_first_boot(tmp_path):
    marker = tmp_path / "agent-session-id"
    marker.write_text("agent-session-1\n")

    assert (
        BootMode.from_env({"FROM_REPO_IMAGE": "true"}, resume_marker_files=(marker,))
        is BootMode.PERSISTENT_RESUME
    )


@pytest.mark.parametrize("marker_contents", ["", "  \n"])
def test_empty_agent_session_marker_remains_fresh(tmp_path, marker_contents):
    marker = tmp_path / "agent-session-id"
    marker.write_text(marker_contents)

    assert BootMode.from_env({}, resume_marker_files=(marker,)) is BootMode.FRESH


def test_runtime_config_parses_frozen_values_without_environment_patching(tmp_path):
    config = RuntimeConfig.from_env(
        {
            "SANDBOX_ID": "sandbox-1",
            "CONTROL_PLANE_URL": "https://control.example",
            "SANDBOX_AUTH_TOKEN": "token",
            "REPO_OWNER": "group/subgroup",
            "REPO_NAME": "repo",
            "VCS_HOST": "gitlab.example",
            "SESSION_CONFIG": json.dumps({"session_id": "session-1", "branch": "develop"}),
        },
        workspace_path=tmp_path,
    )

    assert config.repo_path == tmp_path / "repo"
    assert config.session_id == "session-1"
    assert config.base_branch == "develop"
    assert config.has_repository is True


def test_runtime_config_rejects_non_object_session_config():
    with pytest.raises(ValueError, match="JSON object"):
        RuntimeConfig.from_env({"SESSION_CONFIG": "[]"})


@pytest.mark.parametrize(
    "url", ["http://control.example", "ftp://control.example", "control.example"]
)
def test_runtime_config_rejects_insecure_control_plane_url(url):
    with pytest.raises(ValueError, match="must use HTTPS"):
        RuntimeConfig.from_env({"CONTROL_PLANE_URL": url})


@pytest.mark.parametrize(
    "url",
    ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"],
)
def test_runtime_config_allows_loopback_http_control_plane_url(url):
    assert RuntimeConfig.from_env({"CONTROL_PLANE_URL": url}).control_plane_url == url


def test_session_config_is_recursively_immutable():
    config = RuntimeConfig.from_env(
        {
            "SESSION_CONFIG": json.dumps(
                {"repositories": [{"repo_owner": "acme", "repo_name": "app"}]}
            )
        }
    )

    assert isinstance(config.session_config, MappingProxyType)
    repositories = config.session_config["repositories"]
    assert isinstance(repositories, tuple)
    assert isinstance(repositories[0], MappingProxyType)
    with pytest.raises(TypeError):
        repositories[0]["repo_name"] = "changed"
