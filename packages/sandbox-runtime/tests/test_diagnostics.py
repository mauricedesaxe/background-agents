from sandbox_runtime.diagnostics import OPERATOR_DIAGNOSTIC_MAX_CHARS, operator_diagnostic


def test_operator_diagnostic_decodes_strips_redacts_and_bounds() -> None:
    diagnostic = operator_diagnostic(
        b"\x1b[31m/workspace/acme/app.py\x1b[0m: failed\x00 with "
        b"Authorization: Bearer ghp_supersecret " + b"x" * 800
    )

    assert len(diagnostic) == OPERATOR_DIAGNOSTIC_MAX_CHARS
    assert "\x1b" not in diagnostic
    assert "\x00" not in diagnostic
    assert "ghp_supersecret" not in diagnostic
    assert "Authorization: ***" in diagnostic


def test_operator_diagnostic_preserves_paths_and_prose_and_is_never_empty() -> None:
    assert operator_diagnostic("Failed to read /workspace/acme/app.py") == (
        "Failed to read /workspace/acme/app.py"
    )
    assert operator_diagnostic(b"Failed at /workspace/app.py: \xff") == (
        "Failed at /workspace/app.py: �"
    )
    assert operator_diagnostic(b"\x00\x1b[2J") == "Unknown error"
