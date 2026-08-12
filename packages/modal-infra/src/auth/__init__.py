"""Authentication utilities for Open-Inspect.

Re-exports from sandbox_runtime.auth for backward compatibility.
"""

from sandbox_runtime.auth import (
    AuthConfigurationError,
    generate_installation_token,
    generate_internal_token,
    require_secret,
    verify_internal_token,
)

__all__ = [
    "AuthConfigurationError",
    "generate_installation_token",
    "generate_internal_token",
    "require_secret",
    "verify_internal_token",
]
