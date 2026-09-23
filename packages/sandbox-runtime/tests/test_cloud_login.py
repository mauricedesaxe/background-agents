from pathlib import Path

import pytest

from sandbox_runtime.cloud_login import (
    CloudLoginError,
    allowed_callback_url,
    format_cloudflare_waiting,
    format_railway_waiting,
    is_placeholder_secret,
    main,
    parse_railway_device,
    parse_wrangler_auth_url,
    scrub_cloudflare_env,
)


def test_placeholder_secrets_match_the_dummy_sandbox_values() -> None:
    assert is_placeholder_secret("9PfV$9#Yz3Wi5oGv7G5hXNCD*ohWstNw")
    assert is_placeholder_secret("")
    assert is_placeholder_secret(None)
    assert not is_placeholder_secret("a" * 40)
    assert not is_placeholder_secret("0123456789abcdef0123456789abcdef")


def test_scrub_drops_placeholder_cloudflare_env() -> None:
    env = scrub_cloudflare_env(
        {
            "CLOUDFLARE_API_TOKEN": "9PfV$9#Y",
            "CLOUDFLARE_ACCOUNT_ID": "9PfV$9#Y",
            "PATH": "/usr/bin",
        }
    )
    assert "CLOUDFLARE_API_TOKEN" not in env
    assert "CLOUDFLARE_ACCOUNT_ID" not in env
    assert env["PATH"] == "/usr/bin"


def test_parse_wrangler_auth_url_strips_ansi() -> None:
    raw = (
        "Visit this link to authenticate: "
        "\x1b[4mhttps://dash.cloudflare.com/oauth2/auth?response_type=code&state=abc\x1b[0m"
    )
    assert (
        parse_wrangler_auth_url(raw)
        == "https://dash.cloudflare.com/oauth2/auth?response_type=code&state=abc"
    )


def test_parse_railway_device_code_and_one_click() -> None:
    url, code = parse_railway_device(
        "Sign in with one click: https://railway.com/cli-login?code=zz\nEnter this code: ABCD-1234\n"
    )
    assert url == "https://railway.com/cli-login?code=zz"
    assert code == "ABCD-1234"


def test_callback_url_must_be_local_oauth_callback() -> None:
    ok = "http://localhost:8976/oauth/callback?code=cfoac_x&state=s"
    assert allowed_callback_url(ok).startswith("http://127.0.0.1:8976/oauth/callback?")
    with pytest.raises(CloudLoginError):
        allowed_callback_url("https://evil.example/oauth/callback?code=x")
    with pytest.raises(CloudLoginError):
        allowed_callback_url("http://localhost:8976/steal?code=x")
    with pytest.raises(CloudLoginError):
        allowed_callback_url("http://localhost:80/oauth/callback?code=x")


def test_waiting_copy_tells_the_agent_exactly_what_to_run() -> None:
    cf = format_cloudflare_waiting("https://dash.cloudflare.com/oauth2/auth?x=1")
    assert cf.startswith("STATUS waiting\n")
    assert "oi-cloud-login cloudflare complete '<url>'" in cf
    rw = format_railway_waiting("https://railway.com/cli-login", "ABCD")
    assert "Code: ABCD" in rw
    assert "oi-cloud-login railway wait" in rw


def test_help_and_unknown_command(capsys) -> None:
    assert main(["--help"], environment={}) == 0
    assert "cloudflare start" in capsys.readouterr().out
    assert main(["nope"], environment={}) == 1
    assert "STATUS error" in capsys.readouterr().err


def test_bundled_launcher_and_skill_exist() -> None:
    root = Path(__file__).resolve().parents[1] / "src" / "sandbox_runtime"
    launcher = root / "bin" / "oi-cloud-login"
    skill = root / "skills" / "cloud-login" / "SKILL.md"
    assert launcher.is_file()
    assert "sandbox_runtime.cloud_login" in launcher.read_text()
    text = skill.read_text()
    assert "oi-cloud-login" in text
    assert "wrangler login" in text
    frontmatter = text.split("---", 2)[1]
    assert "Railway" in frontmatter
    assert "railway" in frontmatter
    assert "device-code" in frontmatter
    assert "cli-login" in frontmatter
