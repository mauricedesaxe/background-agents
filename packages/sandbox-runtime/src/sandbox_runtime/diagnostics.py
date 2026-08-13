"""Allowlisted process and cgroup diagnostics for supervisor heartbeats."""

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class CgroupMemoryDiagnostics:
    memory_current_bytes: int | None
    memory_max_bytes: int | None
    oom_count: int | None
    oom_kill_count: int | None


def read_cgroup_memory_diagnostics(
    cgroup_root: Path = Path("/sys/fs/cgroup"),
) -> CgroupMemoryDiagnostics:
    events = _read_keyed_ints(cgroup_root / "memory.events")
    return CgroupMemoryDiagnostics(
        memory_current_bytes=_read_int(cgroup_root / "memory.current"),
        memory_max_bytes=_read_int(cgroup_root / "memory.max"),
        oom_count=events.get("oom"),
        oom_kill_count=events.get("oom_kill"),
    )


def _read_int(path: Path) -> int | None:
    try:
        value = path.read_text().strip()
        if value == "max":
            return None
        parsed = int(value)
        return parsed if parsed >= 0 else None
    except (OSError, ValueError):
        return None


def _read_keyed_ints(path: Path) -> dict[str, int]:
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return {}

    values: dict[str, int] = {}
    for line in lines:
        parts = line.split()
        if len(parts) != 2:
            continue
        try:
            value = int(parts[1])
        except ValueError:
            continue
        if value >= 0:
            values[parts[0]] = value
    return values
