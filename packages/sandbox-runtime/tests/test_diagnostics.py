from pathlib import Path

from sandbox_runtime.diagnostics import read_cgroup_memory_diagnostics


def test_reads_cgroup_memory_diagnostics(tmp_path: Path) -> None:
    (tmp_path / "memory.current").write_text("1024\n")
    (tmp_path / "memory.max").write_text("4096\n")
    (tmp_path / "memory.events").write_text("low 0\noom 2\noom_kill 1\n")

    result = read_cgroup_memory_diagnostics(tmp_path)

    assert result.memory_current_bytes == 1024
    assert result.memory_max_bytes == 4096
    assert result.oom_count == 2
    assert result.oom_kill_count == 1


def test_omits_unavailable_or_unbounded_values(tmp_path: Path) -> None:
    (tmp_path / "memory.max").write_text("max\n")
    (tmp_path / "memory.events").write_text("oom invalid\n")

    result = read_cgroup_memory_diagnostics(tmp_path)

    assert result.memory_current_bytes is None
    assert result.memory_max_bytes is None
    assert result.oom_count is None
    assert result.oom_kill_count is None
