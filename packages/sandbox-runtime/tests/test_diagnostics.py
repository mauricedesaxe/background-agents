from pathlib import Path

from sandbox_runtime.diagnostics import read_cgroup_memory_diagnostics, read_process_tree_rss_bytes


def test_reads_cgroup_memory_diagnostics(tmp_path: Path) -> None:
    (tmp_path / "memory.current").write_text("1024\n")
    (tmp_path / "memory.max").write_text("4096\n")
    (tmp_path / "memory.events").write_text("low 0\nhigh 3\nmax 4\noom 2\noom_kill 1\n")

    result = read_cgroup_memory_diagnostics(tmp_path)

    assert result.memory_current_bytes == 1024
    assert result.memory_max_bytes == 4096
    assert result.high_count == 3
    assert result.max_count == 4
    assert result.oom_count == 2
    assert result.oom_kill_count == 1


def test_omits_unavailable_or_unbounded_values(tmp_path: Path) -> None:
    (tmp_path / "memory.max").write_text("max\n")
    (tmp_path / "memory.events").write_text("oom invalid\n")

    result = read_cgroup_memory_diagnostics(tmp_path)

    assert result.memory_current_bytes is None
    assert result.memory_max_bytes is None
    assert result.high_count is None
    assert result.max_count is None
    assert result.oom_count is None
    assert result.oom_kill_count is None


def test_reads_process_tree_rss_bytes(tmp_path: Path) -> None:
    for pid, parent_pid, rss_pages in ((10, 1, 2), (11, 10, 3), (12, 11, 4), (20, 1, 5)):
        process_dir = tmp_path / str(pid)
        process_dir.mkdir()
        (process_dir / "stat").write_text(
            f"{pid} (process {pid}) S {parent_pid} " + "0 " * 19 + f"{rss_pages} 0\n"
        )

    assert read_process_tree_rss_bytes(10, tmp_path) == 9 * 4096


def test_omits_process_tree_rss_when_root_is_unavailable(tmp_path: Path) -> None:
    assert read_process_tree_rss_bytes(10, tmp_path) is None
