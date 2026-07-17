"""Tests for the harness pointer in the generated /workspace/AGENTS.md.

The sandbox used to carry its own 952-line PHILOSOPHY.md inside a `philosophy` skill and reach it
by a relative path between sibling skills. The harness installs it globally now, so the workspace
manifest has to point at where it actually landed — a pointer to the old path would resolve
nowhere, and a subagent inherits neither the global AGENTS.md nor the rules, so it has nothing
else to go on.
"""

from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from sandbox_runtime.entrypoint import SandboxSupervisor


@contextmanager
def _home(path: Path, xdg: Path | None = None):
    """Point HOME (and optionally XDG_CONFIG_HOME) at a throwaway dir."""
    env = {"HOME": str(path)}
    if xdg is not None:
        env["XDG_CONFIG_HOME"] = str(xdg)
    with patch.dict("os.environ", env, clear=False):
        if xdg is None:
            with patch.dict("os.environ", {}, clear=False):
                import os

                os.environ.pop("XDG_CONFIG_HOME", None)
                with patch("pathlib.Path.home", return_value=path):
                    yield
        else:
            with patch("pathlib.Path.home", return_value=path):
                yield


def _write_philosophy(root: Path) -> Path:
    """Put a philosophy where install-harness.sh would have left it."""
    philosophy = root / "opencode" / "rules" / "PHILOSOPHY.md"
    philosophy.parent.mkdir(parents=True, exist_ok=True)
    philosophy.write_text("## §30. Felt outcome and writing\n")
    return philosophy


class TestInstalledPhilosophyPath:
    """The path has to resolve the way the harness's install.sh resolves it, or it points nowhere."""

    def test_defaults_to_home_config(self, tmp_path):
        """With no XDG_CONFIG_HOME, install.sh uses $HOME/.config — so this must too."""
        with _home(tmp_path):
            assert SandboxSupervisor.installed_philosophy_path() == (
                tmp_path / ".config" / "opencode" / "rules" / "PHILOSOPHY.md"
            )

    def test_honours_xdg_config_home(self, tmp_path):
        """opencomputer sets XDG_CONFIG_HOME explicitly, and install.sh honours it.

        Resolving from HOME here instead would name a file that is not there on that provider.
        """
        xdg = tmp_path / "custom-config"
        with _home(tmp_path, xdg=xdg):
            assert SandboxSupervisor.installed_philosophy_path() == (
                xdg / "opencode" / "rules" / "PHILOSOPHY.md"
            )


class TestHarnessManifestLines:
    """What the workspace AGENTS.md tells the agent about the installed harness."""

    def test_points_at_the_installed_philosophy(self, tmp_path):
        """The absolute path of the philosophy that is actually on disk."""
        philosophy = _write_philosophy(tmp_path / ".config")

        with _home(tmp_path):
            lines = SandboxSupervisor._harness_manifest_lines()

        assert any(str(philosophy) in line for line in lines)
        assert any("Subagents inherit neither" in line for line in lines)

    def test_routes_through_ask_matt_without_paraphrasing_it(self, tmp_path):
        """The router is named; the skill list is not restated.

        The previous version named six matt-* skills and said when to reach for each. That is a
        paraphrase of /matt-ask-matt, and paraphrasing it is how iconic-work happened.
        """
        _write_philosophy(tmp_path / ".config")

        with _home(tmp_path):
            body = "\n".join(SandboxSupervisor._harness_manifest_lines())

        assert "/matt-ask-matt" in body
        for paraphrased in ("/matt-wayfinder", "/matt-tdd", "/matt-grilling", "/matt-to-spec"):
            assert paraphrased not in body

    def test_silent_when_no_philosophy_is_installed(self, tmp_path):
        """An image built without the harness must not advertise a file that isn't there.

        Pointing a subagent at a missing path is worse than saying nothing: it reads as an
        instruction it cannot follow.
        """
        with _home(tmp_path):
            assert SandboxSupervisor._harness_manifest_lines() == []

    def test_no_stale_bundled_philosophy_pointer(self, tmp_path):
        """The old relative path between sibling skills must not survive anywhere in the text."""
        _write_philosophy(tmp_path / ".config")

        with _home(tmp_path):
            body = "\n".join(SandboxSupervisor._harness_manifest_lines())

        assert "../philosophy/PHILOSOPHY.md" not in body
        assert ".opencode/skills/philosophy" not in body
