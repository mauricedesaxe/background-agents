"""Tests for scripts/install-harness.sh, the script every provider's image build calls.

The ticket claimed the image build "is not a separate seam, because it runs the same script the
installer test already covers". It isn't the same script: install.sh's own test covers what
install.sh does given a source tree and a HOME, and nothing in it covers fetching the right pin,
passing `sandbox` rather than `local`, or refusing to run against a live config dir. Those are
this script's job, so they are tested here.

Every test runs the script with `env -i` and a HOME under tmp_path. Nothing here may touch a real
~/.claude, ~/.config/opencode, or $CLAUDE_CONFIG_DIR.
"""

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "sandbox_runtime"
    / "scripts"
    / "install-harness.sh"
)


def _script_default(name: str) -> str:
    """Read a `NAME="${NAME:-default}"` default out of the script.

    Read rather than restated, so changing the default ref cannot leave a test asserting against
    a ref nobody installs any more.
    """
    match = re.search(
        rf'^{name}="\$\{{{name}:-(?P<value>[^}}]+)\}}"$',
        SCRIPT.read_text(),
        re.MULTILINE,
    )
    assert match, f"{name} default not found in {SCRIPT}"
    return match.group("value")


DEFAULT_REPO = _script_default("HARNESS_REPO")
DEFAULT_REF = _script_default("HARNESS_REF")

SHA_PATTERN = re.compile(r"\b[0-9a-f]{40}\b")


def _run(
    *args: str,
    home: Path,
    repo: str | None = None,
    ref: str | None = None,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run install-harness.sh with a scrubbed environment and a throwaway HOME.

    `env -i` in spirit: the env is built from scratch rather than inherited, so an ambient
    CLAUDE_CONFIG_DIR on the machine running the tests cannot reach the script.
    """
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(home),
    }
    if repo is not None:
        env["HARNESS_REPO"] = repo
    if ref is not None:
        env["HARNESS_REF"] = ref
    env.update(extra_env or {})

    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


@pytest.fixture
def fake_harness(tmp_path: Path) -> tuple[str, str]:
    """A git repo standing in for the harness, so the fetch/pin logic is tested without network.

    Its install.sh records what it was called with, and the content of the commit it was called
    from, rather than installing anything. That is what lets these tests assert the contract this
    script owns (surface, argv, pin) separately from what install.sh does with it.

    Two commits, and the fixture pins the FIRST. `marker.txt` differs between them, so a run that
    installed the branch tip instead of the requested commit records the wrong marker and the
    test says so. With one commit the pin would be whatever the tip is anyway, and every
    assertion about pinning would pass without pinning anything.
    """
    repo = tmp_path / "fake-harness"
    repo.mkdir()
    (repo / "install.sh").write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        'here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"\n'
        'printf "surface=%s\\n" "${HARNESS_SURFACE:-unset}" > "$HOME/install-record.txt"\n'
        'printf "args=%s\\n" "$*" >> "$HOME/install-record.txt"\n'
        'printf "claude_home=%s\\n" "${CLAUDE_CONFIG_DIR:-unset}" >> "$HOME/install-record.txt"\n'
        'printf "marker=%s\\n" "$(cat "$here/marker.txt")" >> "$HOME/install-record.txt"\n'
    )
    (repo / "install.sh").chmod(0o755)
    (repo / "marker.txt").write_text("pinned-content\n")

    git = ["git", "-C", str(repo)]
    subprocess.run([*git, "init", "-q", "-b", "main"], check=True)
    subprocess.run([*git, "config", "user.email", "t@example.com"], check=True)
    subprocess.run([*git, "config", "user.name", "t"], check=True)
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "commit", "-qm", "harness"], check=True)
    pinned_sha = subprocess.run(
        [*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()

    # The tip the pin must NOT pick up.
    (repo / "marker.txt").write_text("newer-content\n")
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "commit", "-qm", "later harness"], check=True)

    # Fetching a bare SHA from a local path needs the server side to allow it.
    subprocess.run([*git, "config", "uploadpack.allowAnySHA1InWant", "true"], check=True)
    return str(repo), pinned_sha


class TestWriteGating:
    """The script writes nothing unless argv says so, and never against a live config dir."""

    def test_bare_run_writes_nothing(self, tmp_path, fake_harness):
        """A run with no --install must not fetch or install anything.

        This is the incident in test form: a subagent ran the installer with no argument against
        a live config dir and wiped it.
        """
        repo, sha = fake_harness
        home = tmp_path / "home"
        home.mkdir()

        result = _run(home=home, repo=repo, ref=sha)

        assert result.returncode != 0
        assert "refusing to run without --install" in result.stderr
        assert not (home / "install-record.txt").exists()

    def test_ambient_claude_config_dir_refuses(self, tmp_path, fake_harness):
        """A set CLAUDE_CONFIG_DIR means a laptop, not an image build, so it must refuse.

        install.sh would resolve CLAUDE_CONFIG_DIR and replace whatever is there, so the guard
        has to be here, before the fetch.
        """
        repo, sha = fake_harness
        home = tmp_path / "home"
        home.mkdir()
        live_config = tmp_path / "live-claude"
        live_config.mkdir()

        result = _run(
            "--install",
            home=home,
            repo=repo,
            ref=sha,
            extra_env={"CLAUDE_CONFIG_DIR": str(live_config)},
        )

        assert result.returncode != 0
        assert "not an image build" in result.stderr
        assert not (home / "install-record.txt").exists()

    def test_unknown_argument_refuses(self, tmp_path, fake_harness):
        """An unrecognised argument must fail rather than be ignored as a bare run would be."""
        repo, sha = fake_harness
        home = tmp_path / "home"
        home.mkdir()

        result = _run("--yolo", home=home, repo=repo, ref=sha)

        assert result.returncode != 0
        assert "not an argument this takes" in result.stderr


class TestInvocation:
    """What the script passes to install.sh, which is the whole reason it exists."""

    def test_install_runs_with_sandbox_surface(self, tmp_path, fake_harness):
        """The sandbox surface is this script's payload.

        `local` here would silently give sandbox agents the laptop's workspace default — cut a jj
        workspace per agent — which is the one thing the surface exists to decide.
        """
        repo, sha = fake_harness
        home = tmp_path / "home"
        home.mkdir()

        result = _run("--install", home=home, repo=repo, ref=sha)

        assert result.returncode == 0, result.stderr
        record = (home / "install-record.txt").read_text()
        assert "surface=sandbox" in record
        assert "args=--install" in record

    def test_explicit_sha_is_the_commit_that_installs(self, tmp_path, fake_harness):
        """An explicit SHA has to be the commit that gets installed, not merely the one requested.

        The fixture's pin is one commit behind the tip, so this fails if the script ever installs
        the branch tip when asked for a commit. That is the guarantee an explicit HARNESS_REF
        still buys now that the default tracks a branch.
        """
        repo, pinned_sha = fake_harness
        home = tmp_path / "home"
        home.mkdir()

        result = _run("--install", home=home, repo=repo, ref=pinned_sha)

        assert result.returncode == 0, result.stderr
        record = (home / "install-record.txt").read_text()
        assert "marker=pinned-content" in record
        assert "newer-content" not in record

    def test_branch_ref_installs_the_branch_tip(self, tmp_path, fake_harness):
        """A branch name installs whatever it points at, which is the point of tracking main.

        The fixture's tip is one commit ahead of its pin, so a script that still refused any ref
        it could not match against a SHA, or that resolved a branch to the wrong commit, fails
        here rather than only in an image build.
        """
        repo, _ = fake_harness
        home = tmp_path / "home"
        home.mkdir()

        result = _run("--install", home=home, repo=repo, ref="main")

        assert result.returncode == 0, result.stderr
        record = (home / "install-record.txt").read_text()
        assert "marker=newer-content" in record
        assert "pinned-content" not in record

    def test_installed_commit_is_logged(self, tmp_path, fake_harness):
        """With a moving ref the logged SHA is the only record of what an image got.

        So it has to be the resolved commit, not the ref that was asked for. Asserted against the
        tip rather than merely "some SHA", which `main` alone would satisfy.
        """
        repo, pinned_sha = fake_harness
        home = tmp_path / "home"
        home.mkdir()
        tip_sha = subprocess.run(
            ["git", "-C", repo, "rev-parse", "main"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

        result = _run("--install", home=home, repo=repo, ref="main")

        assert result.returncode == 0, result.stderr
        assert tip_sha in result.stdout
        assert pinned_sha not in result.stdout

    def test_ref_that_does_not_exist_fails(self, tmp_path, fake_harness):
        """A bad pin must fail the build rather than install something else."""
        repo, _ = fake_harness
        home = tmp_path / "home"
        home.mkdir()

        result = _run("--install", home=home, repo=repo, ref="0" * 40)

        assert result.returncode != 0
        assert "could not fetch" in result.stderr
        assert not (home / "install-record.txt").exists()


def _harness_remote_is_reachable() -> bool:
    """Whether the harness remote answers at all, independent of the ref.

    Separated from the install so that "the network is down" and "the default ref is gone" stay
    different outcomes. Deciding that from the install's own exit code would let a deleted branch
    skip the test rather than fail it, and a default that silently stops being installable is
    exactly what this test is here to catch.
    """
    probe = subprocess.run(
        ["git", "ls-remote", "--exit-code", DEFAULT_REPO, "HEAD"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    return probe.returncode == 0


class TestDefaultHarness:
    """The script's own default, against the real harness. Needs network."""

    @pytest.mark.skipif(
        os.environ.get("OPEN_INSPECT_SKIP_NETWORK_TESTS") == "1",
        reason="network tests disabled",
    )
    def test_default_ref_installs_the_expected_harness(self, tmp_path):
        """The default ref resolves upstream and yields the set the sandbox is supposed to get.

        A moving default makes this test do more work than it did against a pin: it is now the
        only thing standing between a harness change and a sandbox that installs it. It stays
        deliberately narrow, proving the resolved skill/agent/rules set on disk rather than that
        an agent behaves the same.
        """
        if not _harness_remote_is_reachable():
            pytest.skip("no network access to the harness remote")

        home = tmp_path / "home"
        home.mkdir()

        # No skip past this point: the remote answered, so anything that goes wrong now is the
        # default ref or the harness, and both are this test's subject.
        result = _run("--install", home=home)
        assert result.returncode == 0, result.stderr

        # What the default resolved to, which with a moving ref is the only record of it.
        logged = SHA_PATTERN.search(result.stdout)
        assert logged, f"no resolved commit logged in {result.stdout!r}"
        assert f"({DEFAULT_REF})" in result.stdout

        opencode = home / ".config" / "opencode"
        claude = home / ".claude"

        # The philosophy the sandbox's own copy had drifted from: it carried §29, which the
        # harness dropped, and never got §30, which now holds the felt-outcome gate.
        philosophy = (opencode / "rules" / "PHILOSOPHY.md").read_text()
        assert "## §30. Felt outcome and writing" in philosophy
        assert "## §29." not in philosophy

        # The skills the sandbox used to fork under different names.
        assert (opencode / "skills" / "lazar-review" / "SKILL.md").is_file()
        assert (opencode / "skills" / "matt-implement" / "SKILL.md").is_file()

        # The reviewer agents, in OpenCode's dialect. The sandbox's hand-copied clarity-reviewer
        # never had `mode:`, so OpenCode defaulted it to `all` and offered a reviewer as a
        # primary agent.
        clarity = (opencode / "agents" / "clarity-reviewer.md").read_text()
        assert "mode: subagent" in clarity

        # Claude Code's copy, which is what makes a sandbox and a laptop the same harness.
        assert (claude / "rules" / "PHILOSOPHY.md").is_file()
        assert (claude / "skills" / "lazar-review" / "SKILL.md").is_file()

        # The sandbox workspace default, generated from the surface rather than hand-kept.
        instructions = (opencode / "AGENTS.md").read_text()
        assert "Work the default workspace directly with `jj edit`" in instructions


class TestScriptIsExecutable:
    def test_script_has_execute_bit(self):
        """The Daytona and Vercel builds call it through bash, but Modal's build does not."""
        assert shutil.which("bash") is not None
        assert os.access(SCRIPT, os.X_OK)
