"""Every provider's image build must invoke the harness installer, and invoke it correctly.

The ticket said "the sandbox image build is not a separate seam, because it runs the same script
the installer test already covers". That is not true of this repo, on two counts:

  1. There is no Dockerfile. Four providers build a sandbox image four different ways — Modal and
     Daytona with SDK-declarative images, opencomputer with per-file adds, and Vercel by booting a
     sandbox and snapshotting it. Each invokes the installer itself.
  2. The harness's own install-smoke test covers install.sh given a source tree and a HOME. It
     cannot see this repo at all, so nothing in it notices a provider that drops `--install`
     (which makes the install a silent no-op that reports and exits 0), forgets the call, or is
     added later without one.

So this is a seam, and these are its tests. They read provider source rather than build images:
three of the four builds have no test at all and none can run in CI (each needs credentials and
a ~20 minute build). That is a real limit, stated in the PR — this catches a provider drifting
out of line, not a broken image.
"""

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]

# Each provider's image build, and the file that has to carry the invocation.
PROVIDER_BUILDS = {
    "modal": REPO_ROOT / "packages/modal-infra/src/images/base.py",
    "daytona": REPO_ROOT / "packages/daytona-infra/src/toolchain.py",
    "opencomputer": REPO_ROOT / "packages/opencomputer-infra/src/build-template.ts",
    "vercel": REPO_ROOT / "packages/control-plane/src/sandbox/providers/vercel/bootstrap.ts",
}

HARNESS_PIN_FINGERPRINTS = {
    "modal": REPO_ROOT / "terraform/environments/production/modal.tf",
    "vercel": REPO_ROOT / "terraform/environments/production/vercel.tf",
}


@pytest.mark.parametrize("provider", sorted(PROVIDER_BUILDS))
class TestProviderInvokesInstaller:
    def test_build_source_exists(self, provider):
        """A moved build file must fail loudly rather than vacuously pass the checks below."""
        assert PROVIDER_BUILDS[provider].is_file(), (
            f"{provider}'s image build is not where this test thinks it is; "
            "the assertions below would pass against nothing"
        )

    def test_invokes_the_shared_installer(self, provider):
        """The one script, not a reimplementation of it.

        Open-coding the clone per provider is how the versions already drifted: OPENCODE_VERSION
        is duplicated across all four builds with no shared source.
        """
        source = PROVIDER_BUILDS[provider].read_text()
        assert "install-harness.sh" in source

    def test_passes_install_flag(self, provider):
        """Without --install the script reports and exits 0, so the image would build clean and
        ship with no harness at all. That is the failure this whole test file exists for."""
        source = PROVIDER_BUILDS[provider].read_text()
        assert "install-harness.sh --install" in source


class TestNoProviderIsMissed:
    def test_every_runtime_copying_provider_installs_the_harness(self):
        """A provider that ships sandbox_runtime but no harness ships an agent with no skills.

        Pinned as a set: adding a fifth provider that copies the runtime and forgets the
        installer fails here rather than in production.
        """
        copying = set()
        for name, path in PROVIDER_BUILDS.items():
            if "sandbox_runtime" in path.read_text():
                copying.add(name)

        assert copying == set(PROVIDER_BUILDS), (
            "a provider stopped copying sandbox_runtime, or this list is stale"
        )


@pytest.mark.parametrize("provider", sorted(HARNESS_PIN_FINGERPRINTS))
def test_harness_pin_invalidates_provider_image(provider):
    # The installer is a .sh file under packages/sandbox-runtime/src; editing it must
    # invalidate the image. Upstream's fingerprint hashes every file under that directory
    # (a bare ``-type f`` with no name filter), which includes .sh. The fork named ``*.sh``
    # in a whitelist; either way the .sh installer participates in the hash.
    fingerprint = HARNESS_PIN_FINGERPRINTS[provider].read_text()
    assert "packages/sandbox-runtime/src" in fingerprint
    assert '-name "*.sh"' in fingerprint or "-type f" in fingerprint
