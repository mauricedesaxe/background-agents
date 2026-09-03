"""Contracts for tools baked into the Daytona sandbox image."""

from pathlib import Path

TOOLCHAIN = Path(__file__).resolve().parents[2] / "daytona-infra" / "src" / "toolchain.py"


def test_daytona_image_installs_pinned_beads() -> None:
    source = TOOLCHAIN.read_text()

    assert 'BD_VERSION = "1.2.2"' in source
    assert (
        'BD_SHA256 = "8140098a51d3b81d5548d1c5e6db1a2d9930e5d141efe2a4bff7d079c4d321e8"' in source
    )
    assert "beads_{BD_VERSION}_linux_amd64.tar.gz" in source
    assert source.index("sha256sum -c -") < source.index("tar -xzf /tmp/beads.tar.gz")
    assert "install /tmp/beads/bd /usr/local/bin/bd" in source
    assert '"bd --version"' in source
    assert '"daytona-v13-8gb-jj-bd-vnc-opencode-1-18-18"' in source
