"""Tests for SandboxSupervisor._set_oom_score_adj OOM-killer biasing."""

from unittest.mock import MagicMock, patch

from sandbox_runtime.entrypoint import SandboxSupervisor


def _make_supervisor() -> SandboxSupervisor:
    """Create a SandboxSupervisor with minimal stub dependencies."""
    return SandboxSupervisor(
        config=MagicMock(),
        repository_boot=MagicMock(),
        opencode_server=MagicMock(),
        agent_bridge=MagicMock(),
        code_server=MagicMock(),
        web_terminal=MagicMock(),
        browser_desktop=MagicMock(),
        managed_skills=None,
        shutdown_event=MagicMock(),
        log=MagicMock(),
    )


class TestSetOomScoreAdj:
    def test_writes_score_to_proc(self):
        sup = _make_supervisor()
        with patch("sandbox_runtime.supervisor.Path") as MockPath:
            handle = MockPath.return_value
            sup._set_oom_score_adj(1234, sup.OPENCODE_OOM_SCORE_ADJ, name="opencode")

            MockPath.assert_called_once_with("/proc/1234/oom_score_adj")
            handle.write_text.assert_called_once_with(str(sup.OPENCODE_OOM_SCORE_ADJ))

    def test_swallows_oserror_when_unprivileged(self):
        sup = _make_supervisor()
        with patch("sandbox_runtime.supervisor.Path") as MockPath:
            MockPath.return_value.write_text.side_effect = PermissionError("EPERM")

            sup._set_oom_score_adj(1234, -500, name="opencode")

    def test_bias_ordering_protects_reporting_path_most(self):
        assert (
            SandboxSupervisor.SUPERVISOR_OOM_SCORE_ADJ
            < SandboxSupervisor.BRIDGE_OOM_SCORE_ADJ
            < SandboxSupervisor.OPENCODE_OOM_SCORE_ADJ
            < 0
        )
        # Never fully immune (-1000): a runaway build must still be killable.
        assert SandboxSupervisor.SUPERVISOR_OOM_SCORE_ADJ > -1000
