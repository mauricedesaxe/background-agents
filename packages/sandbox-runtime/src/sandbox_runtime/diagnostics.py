"""Allowlisted process and cgroup diagnostics for supervisor heartbeats."""

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class CgroupMemoryDiagnostics:
    memory_current_bytes: int | None
    memory_max_bytes: int | None
    high_count: int | None
    max_count: int | None
    oom_count: int | None
    oom_kill_count: int | None


def read_cgroup_memory_diagnostics(
    cgroup_root: Path = Path("/sys/fs/cgroup"),
) -> CgroupMemoryDiagnostics:
    events = _read_keyed_ints(cgroup_root / "memory.events")
    return CgroupMemoryDiagnostics(
        memory_current_bytes=_read_int(cgroup_root / "memory.current"),
        memory_max_bytes=_read_int(cgroup_root / "memory.max"),
        high_count=events.get("high"),
        max_count=events.get("max"),
        oom_count=events.get("oom"),
        oom_kill_count=events.get("oom_kill"),
    )


def read_process_tree_rss_bytes(
    root_pid: int | None,
    proc_root: Path = Path("/proc"),
) -> int | None:
    if root_pid is None:
        return None

    processes: dict[int, tuple[int, int]] = {}
    try:
        process_dirs = list(proc_root.iterdir())
    except OSError:
        return None
    for process_dir in process_dirs:
        if not process_dir.name.isdigit():
            continue
        try:
            processes[int(process_dir.name)] = _parse_process_stat(
                (process_dir / "stat").read_text()
            )
        except (OSError, ValueError, IndexError):
            continue

    if root_pid not in processes:
        return None

    tree = {root_pid}
    while True:
        descendants = {pid for pid, (parent_pid, _) in processes.items() if parent_pid in tree}
        updated = tree | descendants
        if updated == tree:
            break
        tree = updated
    return sum(processes[pid][1] for pid in tree) * os.sysconf("SC_PAGE_SIZE")


def _parse_process_stat(stat: str) -> tuple[int, int]:
    fields_after_command = stat[stat.rfind(")") + 2 :].split()
    parent_pid = int(fields_after_command[1])
    rss_pages = int(fields_after_command[21])
    return parent_pid, rss_pages


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
