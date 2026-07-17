"""What sandbox_runtime still ships after the harness moved to the installer.

The package used to carry 42 skills, 8 reviewer agents and a 952-line PHILOSOPHY.md, all
hand-copied from the harness and drifting. install-harness.sh installs those at image build now,
so the copies are gone. What is left is Open-Inspect's own product skills: they drive a session
surface (the whiteboard canvas, the browser, artifact upload), the harness does not ship them,
and nothing would restore them if they went.
"""

from pathlib import Path

RUNTIME = Path(__file__).resolve().parents[1] / "src" / "sandbox_runtime"
SKILLS = RUNTIME / "skills"

# Pinned as an exact set rather than a "no matt-* left" check: the risk runs both ways. A harness
# skill creeping back in is drift returning, and a product skill quietly disappearing is a feature
# deleted. Only an equality assertion catches both.
PRODUCT_SKILLS = [
    "agent-browser",
    "record-video",
    "upload-screenshot",
    "visual-verification",
    "whiteboard",
]


class TestPackagedSkills:
    def test_only_product_skills_remain(self):
        """Exactly the product skills, no more and no fewer."""
        shipped = sorted(p.name for p in SKILLS.iterdir() if p.is_dir())

        assert shipped == PRODUCT_SKILLS

    def test_every_product_skill_is_loadable(self):
        """A skill directory with no SKILL.md is not a skill.

        entrypoint's _install_skills skips any directory without one, so an assertion about the
        directory names alone would pass for a skill the sandbox silently never installs.
        """
        for name in PRODUCT_SKILLS:
            assert (SKILLS / name / "SKILL.md").is_file(), f"{name} has no SKILL.md"

    def test_no_forked_harness_copies_remain(self):
        """A copy that comes back is the drift coming back."""
        assert not (RUNTIME / "agents").exists()
        assert not (SKILLS / "philosophy").exists()
        assert not any(p.name.startswith("matt-") for p in SKILLS.iterdir())

    def test_the_harness_workflow_skills_are_gone(self):
        """The forks that shadowed the harness under shorter names.

        `commit`, `review`, `ship` and `research` were the harness's lazar-* skills under
        different names with different content; `work` and `capture` are deleted outright by the
        parent spec, with capture's felt-outcome gate relocated into philosophy §30.
        """
        for name in ("commit", "review", "ship", "research", "work", "capture", "philosophy"):
            assert not (SKILLS / name).exists(), f"{name} is the harness's job now"
