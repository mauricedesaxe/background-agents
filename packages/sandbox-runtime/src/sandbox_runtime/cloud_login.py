"""Sandbox login for Cloudflare Wrangler and Railway.

Browser OAuth cannot finish on the user's machine: Wrangler listens on
localhost inside this sandbox, and Railway device-code output is lost if the
CLI is left in a buffered foreground shell. This module is the login path.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, Sequence

CLOUDFLARE_ENV_KEYS = ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")
PLACEHOLDER_CHARS = frozenset("$#*")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
WRANGLER_AUTH_URL_RE = re.compile(r"https://dash\.cloudflare\.com/oauth2/auth[^\s]+")
RAILWAY_URL_RE = re.compile(
    r"(?:Sign in with one click:|Sign in at:)\s+(\S+)",
    re.IGNORECASE,
)
RAILWAY_CODE_RE = re.compile(r"(?:Enter this code:|code:)\s+([A-Z0-9-]+)", re.IGNORECASE)
DEFAULT_STATE_DIR = Path("/tmp/oi-cloud-login")
WRANGLER_CALLBACK_PORT = 8976
USAGE = """\
Usage:
  oi-cloud-login status
  oi-cloud-login cloudflare start
  oi-cloud-login cloudflare complete <callback-url>
  oi-cloud-login railway start
  oi-cloud-login railway wait
"""


def is_placeholder_secret(value: str | None) -> bool:
    if not value:
        return True
    return any(char in value for char in PLACEHOLDER_CHARS)


def scrub_cloudflare_env(environment: Mapping[str, str]) -> dict[str, str]:
    env = dict(environment)
    for key in CLOUDFLARE_ENV_KEYS:
        if is_placeholder_secret(env.get(key)):
            env.pop(key, None)
    return env


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


def parse_wrangler_auth_url(text: str) -> str | None:
    match = WRANGLER_AUTH_URL_RE.search(strip_ansi(text))
    if match is None:
        return None
    return match.group(0).rstrip(").,]'\"")


def parse_railway_device(text: str) -> tuple[str | None, str | None]:
    clean = strip_ansi(text)
    url_match = RAILWAY_URL_RE.search(clean)
    code_match = RAILWAY_CODE_RE.search(clean)
    url = url_match.group(1).rstrip(").,]'\"") if url_match else None
    code = code_match.group(1) if code_match else None
    return url, code


def allowed_callback_url(url: str, *, port: int = WRANGLER_CALLBACK_PORT) -> str:
    parsed = urlparse(url.strip())
    if parsed.scheme != "http":
        raise CloudLoginError("callback URL must be http://localhost")
    if parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise CloudLoginError("callback URL must be http://localhost")
    actual_port = parsed.port if parsed.port is not None else 80
    if actual_port != port:
        raise CloudLoginError("callback URL port does not match the login listener")
    if parsed.path != "/oauth/callback":
        raise CloudLoginError("callback URL path must be /oauth/callback")
    if not parsed.query:
        raise CloudLoginError("callback URL is missing query parameters")
    return f"http://127.0.0.1:{port}/oauth/callback?{parsed.query}"


class CloudLoginError(RuntimeError):
    """Login helper failure with a user-safe message."""


def format_cloudflare_waiting(url: str) -> str:
    return (
        "STATUS waiting\n"
        f"Open: {url}\n"
        "\n"
        "The browser will fail to load localhost:8976. Paste the full address-bar URL, then run:\n"
        "oi-cloud-login cloudflare complete '<url>'\n"
    )


def format_railway_waiting(url: str, code: str | None) -> str:
    lines = ["STATUS waiting", f"Open: {url}"]
    if code:
        lines.append(f"Code: {code}")
    lines.extend(
        [
            "",
            "After the user finishes, run:",
            "oi-cloud-login railway wait",
            "",
        ]
    )
    return "\n".join(lines)


def format_ready(provider: str, detail: str) -> str:
    return f"STATUS ready\n{provider}: {detail}\n"


def state_path(state_dir: Path, provider: str) -> Path:
    return state_dir / f"{provider}.json"


def read_state(state_dir: Path, provider: str) -> dict[str, Any] | None:
    path = state_path(state_dir, provider)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def write_state(state_dir: Path, provider: str, payload: Mapping[str, Any]) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_path(state_dir, provider)
    path.write_text(json.dumps(dict(payload)))


def clear_state(state_dir: Path, provider: str) -> None:
    path = state_path(state_dir, provider)
    path.unlink(missing_ok=True)


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def stop_pid(pid: int) -> None:
    if not pid_alive(pid):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return


def run_command(
    argv: Sequence[str],
    env: Mapping[str, str],
    *,
    timeout_seconds: float = 30,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(argv),
        env=dict(env),
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )


def wrangler_argv() -> list[str]:
    return ["npx", "--yes", "wrangler"]


def railway_argv() -> list[str]:
    return ["railway"]


def cloudflare_logged_in(env: Mapping[str, str]) -> bool:
    try:
        result = run_command([*wrangler_argv(), "whoami"], env, timeout_seconds=45)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def railway_logged_in(env: Mapping[str, str]) -> bool:
    try:
        result = run_command([*railway_argv(), "whoami", "--json"], env, timeout_seconds=30)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def login_env(environment: Mapping[str, str]) -> dict[str, str]:
    env = scrub_cloudflare_env(environment)
    if cloudflare_logged_in(env):
        return env
    for key in CLOUDFLARE_ENV_KEYS:
        env.pop(key, None)
    return env


def start_cloudflare(
    environment: Mapping[str, str],
    *,
    state_dir: Path = DEFAULT_STATE_DIR,
) -> str:
    env = login_env(environment)
    if cloudflare_logged_in(env):
        return format_ready("cloudflare", "logged in")
    existing = read_state(state_dir, "cloudflare")
    if existing and pid_alive(int(existing.get("pid") or 0)) and existing.get("url"):
        return format_cloudflare_waiting(str(existing["url"]))
    if existing and existing.get("pid"):
        stop_pid(int(existing["pid"]))
    log_path = state_dir / "cloudflare.log"
    state_dir.mkdir(parents=True, exist_ok=True)
    handle = subprocess.Popen(
        [*wrangler_argv(), "login", "--browser", "false"],
        env=env,
        stdout=log_path.open("w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    url = _wait_for_pattern(log_path, parse_wrangler_auth_url, timeout_seconds=20)
    if url is None:
        stop_pid(handle.pid)
        tail = log_path.read_text()[-800:] if log_path.is_file() else ""
        raise CloudLoginError(f"wrangler login did not print an auth URL\n{tail}")
    write_state(
        state_dir,
        "cloudflare",
        {"pid": handle.pid, "url": url, "port": WRANGLER_CALLBACK_PORT},
    )
    return format_cloudflare_waiting(url)


def complete_cloudflare(
    callback_url: str,
    environment: Mapping[str, str],
    *,
    state_dir: Path = DEFAULT_STATE_DIR,
) -> str:
    state = read_state(state_dir, "cloudflare")
    if state is None:
        raise CloudLoginError("no login in progress; run oi-cloud-login cloudflare start")
    port = int(state.get("port") or WRANGLER_CALLBACK_PORT)
    target = allowed_callback_url(callback_url, port=port)
    try:
        _http_get(target)
    except CloudLoginError:
        raise
    except Exception as error:
        raise CloudLoginError(
            "login listener did not accept the callback; run start again"
        ) from error
    pid = int(state.get("pid") or 0)
    _wait_pid_exit(pid, timeout_seconds=30)
    env = login_env(environment)
    if not cloudflare_logged_in(env):
        raise CloudLoginError("callback accepted but wrangler whoami still failed")
    clear_state(state_dir, "cloudflare")
    return format_ready("cloudflare", "logged in")


def start_railway(
    environment: Mapping[str, str],
    *,
    state_dir: Path = DEFAULT_STATE_DIR,
) -> str:
    env = dict(environment)
    if railway_logged_in(env):
        return format_ready("railway", "logged in")
    existing = read_state(state_dir, "railway")
    if existing and pid_alive(int(existing.get("pid") or 0)) and existing.get("url"):
        return format_railway_waiting(str(existing["url"]), existing.get("code"))
    if existing and existing.get("pid"):
        stop_pid(int(existing["pid"]))
    log_path = state_dir / "railway.log"
    state_dir.mkdir(parents=True, exist_ok=True)
    argv = [*railway_argv(), "login", "--browserless"]
    handle = subprocess.Popen(
        argv,
        env=env,
        stdout=log_path.open("w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    url, code = _wait_for_railway(log_path, timeout_seconds=20)
    if url is None:
        stop_pid(handle.pid)
        tail = log_path.read_text()[-800:] if log_path.is_file() else ""
        raise CloudLoginError(f"railway login did not print a sign-in URL\n{tail}")
    write_state(
        state_dir,
        "railway",
        {"pid": handle.pid, "url": url, "code": code},
    )
    return format_railway_waiting(url, code)


def wait_railway(
    environment: Mapping[str, str],
    *,
    state_dir: Path = DEFAULT_STATE_DIR,
    timeout_seconds: float = 600,
) -> str:
    env = dict(environment)
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if railway_logged_in(env):
            state = read_state(state_dir, "railway")
            if state and state.get("pid"):
                stop_pid(int(state["pid"]))
            clear_state(state_dir, "railway")
            return format_ready("railway", "logged in")
        time.sleep(2)
    raise CloudLoginError("railway login timed out")


def status_text(environment: Mapping[str, str]) -> str:
    env = login_env(environment)
    cf = "logged in" if cloudflare_logged_in(env) else "needs login"
    rw = "logged in" if railway_logged_in(dict(environment)) else "needs login"
    placeholders = [
        key for key in CLOUDFLARE_ENV_KEYS if is_placeholder_secret(environment.get(key))
    ]
    lines = [f"cloudflare: {cf}", f"railway: {rw}"]
    if placeholders and cf != "logged in":
        lines.append("cloudflare env looks like a placeholder; start will ignore it")
    return "\n".join(lines) + "\n"


def _wait_for_pattern(
    log_path: Path, parse: Callable[[str], str | None], *, timeout_seconds: float
) -> str | None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if log_path.is_file():
            found = parse(log_path.read_text())
            if found:
                return found
        time.sleep(0.2)
    return None


def _wait_for_railway(log_path: Path, *, timeout_seconds: float) -> tuple[str | None, str | None]:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if log_path.is_file():
            url, code = parse_railway_device(log_path.read_text())
            if url:
                return url, code
        time.sleep(0.2)
    return None, None


def _wait_pid_exit(pid: int, *, timeout_seconds: float) -> None:
    if pid <= 0:
        return
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if not pid_alive(pid):
            return
        time.sleep(0.2)


def _http_get(url: str) -> None:
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            response.read(256)
    except urllib.error.URLError as error:
        raise CloudLoginError(
            "login listener did not accept the callback; run start again"
        ) from error


def main(argv: Sequence[str] | None = None, environment: Mapping[str, str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    env = os.environ if environment is None else environment
    if not args or args[0] in {"-h", "--help", "help"}:
        sys.stdout.write(USAGE)
        return 0
    try:
        return _dispatch(args, env)
    except CloudLoginError as error:
        sys.stderr.write(f"STATUS error\n{error}\n")
        return 1
    except subprocess.TimeoutExpired:
        sys.stderr.write("STATUS error\ncommand timed out\n")
        return 1


def _dispatch(args: Sequence[str], env: Mapping[str, str]) -> int:
    command = args[0]
    if command == "status":
        sys.stdout.write(status_text(env))
        return 0
    if command == "cloudflare":
        return _dispatch_cloudflare(args[1:], env)
    if command == "railway":
        return _dispatch_railway(args[1:], env)
    raise CloudLoginError(USAGE.strip())


def _dispatch_cloudflare(args: Sequence[str], env: Mapping[str, str]) -> int:
    if not args or args[0] == "start":
        sys.stdout.write(start_cloudflare(env))
        return 0
    if args[0] == "complete":
        if len(args) < 2:
            raise CloudLoginError("cloudflare complete needs the callback URL")
        sys.stdout.write(complete_cloudflare(args[1], env))
        return 0
    raise CloudLoginError("cloudflare commands: start | complete <url>")


def _dispatch_railway(args: Sequence[str], env: Mapping[str, str]) -> int:
    if not args or args[0] == "start":
        sys.stdout.write(start_railway(env))
        return 0
    if args[0] == "wait":
        sys.stdout.write(wait_railway(env))
        return 0
    raise CloudLoginError("railway commands: start | wait")


if __name__ == "__main__":
    raise SystemExit(main())
