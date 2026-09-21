"""Pin the Daytona base-snapshot sizing budget (card 01)."""

from pathlib import Path
from unittest.mock import MagicMock

from daytona import CreateSnapshotParams, Image
from src.toolchain import (
    SNAPSHOT_CPU,
    SNAPSHOT_DISK_GIB,
    SNAPSHOT_MEMORY_GIB,
    create_base_snapshot,
)


def test_base_snapshot_pins_cpu_memory_and_disk(monkeypatch):
    monkeypatch.setattr("src.toolchain.build_base_image", lambda repo_root: Image.base("debian:12"))
    daytona = MagicMock()

    create_base_snapshot(daytona, Path("/repo"), "snapshot-name")

    daytona.snapshot.create.assert_called_once()
    (params,) = daytona.snapshot.create.call_args.args
    assert isinstance(params, CreateSnapshotParams)
    assert params.name == "snapshot-name"
    assert params.resources.cpu == SNAPSHOT_CPU == 2
    assert params.resources.memory == SNAPSHOT_MEMORY_GIB == 8
    assert params.resources.disk == SNAPSHOT_DISK_GIB == 30
