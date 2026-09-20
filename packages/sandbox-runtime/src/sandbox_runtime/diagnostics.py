from __future__ import annotations

import re

OPERATOR_DIAGNOSTIC_MAX_CHARS = 500

_ANSI_ESCAPE_RE = re.compile(
    r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)|[@-_])"
)
_UNSAFE_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def sanitize_diagnostic_text(value: bytes | str) -> str:
    text = value.decode(errors="replace") if isinstance(value, bytes) else value
    text = _ANSI_ESCAPE_RE.sub("", text)
    text = _UNSAFE_CONTROL_RE.sub("", text)
    text = re.sub(r"(https?://)([^/\s@]+)@", r"\1***@", text)
    text = re.sub(
        r"(?i)(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+|token\s+)?[^\s,;]+",
        r"\1***",
        text,
    )
    text = re.sub(r"\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+", "***", text)
    text = re.sub(r"\bglpat-[A-Za-z0-9_-]+", "***", text)
    text = re.sub(r"(?i)(private-token\s*[:=]\s*)[^\s,;]+", r"\1***", text)
    text = re.sub(
        r"(?i)([?&][^=&#\s]*(?:token|auth|password|secret|api[_-]?key)[^=&#\s]*=)[^&#\s]+",
        r"\1***",
        text,
    )
    text = re.sub(
        r"(?i)(\b[A-Za-z0-9_]*(?:token|password|secret|api[_-]?key)[A-Za-z0-9_-]*\s*=\s*)"
        r'(?:"[^"\r\n]*"|\'[^\'\r\n]*\'|[^\s,;]+)',
        r"\1***",
        text,
    )
    return text.strip()


def operator_diagnostic(
    value: object,
    *,
    fallback: str = "Unknown error",
    max_chars: int = OPERATOR_DIAGNOSTIC_MAX_CHARS,
) -> str:
    raw = value if isinstance(value, bytes | str) else "" if value is None else str(value)
    diagnostic = sanitize_diagnostic_text(raw) or sanitize_diagnostic_text(fallback)
    return (diagnostic or "Unknown error")[:max_chars]
