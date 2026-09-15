"""Image-contract checks that do not require a running provider sandbox."""

import runpy
import sys
from pathlib import Path
from unittest.mock import MagicMock, Mock

import pytest

verification = runpy.run_path(str(Path(__file__).parents[1] / "verify/smoke_test.py"))


@pytest.mark.parametrize("command", ["install", "verify"])
def test_smoke_test_uses_exit_status_without_success_report(monkeypatch, capsys, command):
    main = verification["main"]
    inspect = Mock()
    monkeypatch.setitem(main.__globals__, "inspect_image", inspect)
    monkeypatch.setattr(sys, "argv", ["smoke_test.py", command])
    monkeypatch.setattr(
        Path,
        "read_text",
        Mock(
            side_effect=[
                '{"runtimeEnv": {}}',
                "{}",
                "{}",
            ]
        ),
    )

    main()

    inspect.assert_called_once_with({"runtimeEnv": {}}, {}, services=command == "verify")
    assert capsys.readouterr().out == ""


def test_smoke_test_preserves_failures(monkeypatch):
    main = verification["main"]
    monkeypatch.setitem(
        main.__globals__,
        "inspect_image",
        Mock(side_effect=RuntimeError("Image service readiness timeout: opencode")),
    )
    monkeypatch.setattr(sys, "argv", ["smoke_test.py", "verify"])
    monkeypatch.setattr(
        Path,
        "read_text",
        Mock(
            side_effect=[
                '{"runtimeEnv": {}}',
                "{}",
                "{}",
            ]
        ),
    )

    with pytest.raises(RuntimeError, match="Image service readiness timeout: opencode"):
        main()


def _inspect_image_dependencies(monkeypatch, harness_stamp: str):
    """Drive inspect_image past every probe up to the harness stamp read.

    The probe outputs replay, in call order, the ten pinned tool versions,
    the runtime-manifest version, the SCM probes, and the credential-helper
    check, so the stamp comparison is the first thing that can fail.
    """
    plan = {
        "target": {"node": "22", "user": "openinspect", "home": "/nonexistent-home"},
        "runtimeEnv": {},
        "runtimeVersion": "9.9.9",
        "provider": "vercel",
    }
    tools = {
        "node": {"22": {"version": "22.23.2"}},
        "opencode": "1.0.0",
        "bun": "1.0.0",
        "pnpm": "9.0.0",
        "agentBrowser": "0.37.0",
        "jj": {"version": "0.1.0"},
        "bd": {"version": "0.1.0"},
        "codeServer": {"version": "4.109.5"},
        "ttyd": {"version": "1.7.7"},
        "chrome": {"version": "152.0.7977.82"},
        "harness": {"ref": "pinned-harness-ref"},
    }
    probe = Mock()
    probe.run.side_effect = [
        "v22.23.2",
        "1.0.0",
        "1.0.0",
        "9.0.0",
        "agent-browser 0.37.0",
        "jj 0.1.0",
        "bd version 0.1.0",
        "4.109.5",
        "ttyd version 1.7.7",
        "Google Chrome for Testing 152.0.7977.82",
        "9.9.9",
        "",
        "",
        "true",
    ]
    probe.options = {}
    monkeypatch.setitem(
        verification["inspect_image"].__globals__, "Probe", Mock(return_value=probe)
    )
    monkeypatch.setattr(Path, "read_text", Mock(return_value=harness_stamp))
    return plan, tools


def test_harness_stamp_mismatch_fails_the_smoke_verification(monkeypatch):
    plan, tools = _inspect_image_dependencies(
        monkeypatch, harness_stamp='{"ref": "drifted-harness-ref"}'
    )

    with pytest.raises(RuntimeError, match="does not match the pinned toolchain"):
        verification["inspect_image"](plan, tools, services=False)


@pytest.mark.parametrize(
    "command,output,expected",
    [
        ("node", "v22.23.2", "22.23.2"),
        ("agent-browser", "agent-browser 0.37.0", "0.37.0"),
        ("code-server", "4.109.5 commit with Code 1.109.0", "4.109.5"),
        (
            "code-server",
            "i18next: initialized {}\ninfo Wrote default config\n4.109.5 commit with Code 1.109.5",
            "4.109.5",
        ),
        ("ttyd", "ttyd version 1.7.7", "1.7.7"),
        ("ttyd", "ttyd version 1.7.7-40e79c7", "1.7.7"),
        ("google-chrome", "Google Chrome for Testing 152.0.7977.82", "152.0.7977.82"),
    ],
)
def test_records_normalized_observed_tool_versions(command, output, expected):
    assert verification["observed_tool_version"](command, expected, output) == expected


@pytest.mark.parametrize(
    "output", ["v22.23.20", "v22.23.2-rc1", "unexpected v22.23.2", "v22.23.2\nv22.23.20"]
)
def test_rejects_version_substrings_and_nonrelease_versions(output):
    with pytest.raises(RuntimeError, match="version mismatch"):
        verification["observed_tool_version"]("node", "22.23.2", output)


@pytest.mark.parametrize(
    "banner,security,valid",
    [
        (b"RFB 003.008\n", b"\x01\x01", True),
        (b"<html>noVNC</html>", b"\x01\x01", False),
        (b"RFB 003.008\n", b"\x00", False),
    ],
)
def test_desktop_requires_websocket_rfb_exchange(monkeypatch, banner, security, valid):
    connection = MagicMock()
    connection.recv.side_effect = [banner, security]
    connect = MagicMock()
    connect.return_value.__enter__.return_value = connection
    monkeypatch.setitem(sys.modules, "websockets.sync.client", Mock(connect=connect))
    if valid:
        verification["verify_rfb_proxy"](12345)
        connection.send.assert_called_once_with(banner)
        connect.assert_called_once_with(
            "ws://127.0.0.1:12345/websockify",
            subprotocols=["binary"],
            open_timeout=5,
            close_timeout=1,
            proxy=None,
        )
    else:
        with pytest.raises(RuntimeError, match="RFB"):
            verification["verify_rfb_proxy"](12345)


def test_harness_pin_is_a_full_sha_used_for_clone_and_stamp():
    """The image build installs the harness through a content-pinned ref.

    What this repo owns is the wiring: the pin is a full commit sha, and the
    same ref drives both the fetch and the stamp, so the smoke assertion
    (stamped == pinned) can never pass on a drift. Read, not restated.
    """
    import json
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    harness = json.loads((root / "toolchain.json").read_text())["harness"]
    assert re.fullmatch(r"[0-9a-f]{40}", harness["ref"]), "harness pin must be a full 40-char sha"

    installer = (root / "install" / "harness.sh").read_text()
    assert installer.count("OI_HARNESS_REF") >= 3, (
        "the pinned ref must drive both the fetch and the stamp; a drift between "
        "them lets the smoke assertion pass on the wrong build"
    )
