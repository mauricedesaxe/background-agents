"""Tests for SandboxSupervisor._set_oom_score_adj OOM-killer biasing."""

from unittest.mock import patch

from sandbox_runtime.entrypoint import SandboxSupervisor


def _make_supervisor() -> SandboxSupervisor:
    """Create a SandboxSupervisor with env vars stubbed out."""
    with patch.dict(
        "os.environ",
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        },
    ):
        return SandboxSupervisor()


class TestSetOomScoreAdj:
    def test_writes_score_to_proc(self):
        sup = _make_supervisor()
        with patch("sandbox_runtime.entrypoint.Path") as MockPath:
            handle = MockPath.return_value
            sup._set_oom_score_adj(1234, sup.OPENCODE_OOM_SCORE_ADJ, name="opencode")

            MockPath.assert_called_once_with("/proc/1234/oom_score_adj")
            handle.write_text.assert_called_once_with(str(sup.OPENCODE_OOM_SCORE_ADJ))

    def test_swallows_oserror_when_unprivileged(self):
        sup = _make_supervisor()
        with patch("sandbox_runtime.entrypoint.Path") as MockPath:
            MockPath.return_value.write_text.side_effect = PermissionError("EPERM")

            # Must not raise: protection is best-effort, boot must continue.
            sup._set_oom_score_adj(1234, -500, name="opencode")

    def test_bias_ordering_protects_reporting_path_most(self):
        # The reporting/restart path (supervisor, then bridge) must be biased
        # below OpenCode so it is the last thing the OOM killer takes.
        assert (
            SandboxSupervisor.SUPERVISOR_OOM_SCORE_ADJ
            < SandboxSupervisor.BRIDGE_OOM_SCORE_ADJ
            < SandboxSupervisor.OPENCODE_OOM_SCORE_ADJ
            < 0
        )
        # Never fully immune (-1000): a runaway build must still be killable.
        assert SandboxSupervisor.SUPERVISOR_OOM_SCORE_ADJ > -1000
