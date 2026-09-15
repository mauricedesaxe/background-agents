"""The image build installs the harness through a pinned curl one-liner.

install.sh's own smoke suite (in the lazar-harness repo) owns what the
installer does. What this repo owns is the line itself: that it pins a
commit sha, passes the sandbox surface, actually applies, and removes the
skills directory the runtime owns. Read, not restated, so a bump that
breaks the shape fails here.
"""

import re
from pathlib import Path

TOOLCHAIN = Path(__file__).resolve().parents[2] / "daytona-infra" / "src" / "toolchain.py"


def toolchain_source() -> str:
    return TOOLCHAIN.read_text()


def test_pin_is_a_full_commit_sha() -> None:
    match = re.search(r'HARNESS_PIN = "([0-9a-f]{40})"', toolchain_source())
    assert match, "HARNESS_PIN must be a full 40-char commit sha"


def test_install_line_pins_the_same_sha_for_script_and_source() -> None:
    src = toolchain_source()
    pin = re.search(r'HARNESS_PIN = "([0-9a-f]{40})"', src).group(1)
    assert pin in src.split("HARNESS_PIN = ")[1], "the curl URL must carry the pin"
    assert "HARNESS_REF=$HARNESS_PIN" in src, "the source tarball must pin the same sha"


def test_install_line_uses_the_sandbox_surface_and_applies() -> None:
    src = toolchain_source()
    assert "HARNESS_SURFACE=sandbox" in src
    assert "bash -s -- --install" in src


def test_runtime_owned_skills_dir_is_removed() -> None:
    src = toolchain_source()
    assert "/root/.config/opencode/skills" in src
    assert ".managed-skills-swap" in src
