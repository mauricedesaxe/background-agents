#!/usr/bin/env bash
set -euo pipefail
source "$OI_INSTALL_DIR/common.sh"
harness_dir="$(mktemp -d /tmp/openinspect-harness.XXXXXX)"
trap 'rm -rf "$harness_dir"' EXIT
git init -q "$harness_dir/repo"
git -C "$harness_dir/repo" remote add origin "$OI_HARNESS_REPO"
git -C "$harness_dir/repo" fetch --depth 1 -q origin "$OI_HARNESS_REF"
git -C "$harness_dir/repo" checkout -q --detach FETCH_HEAD
resolved_ref="$(git -C "$harness_dir/repo" rev-parse HEAD)"
tree_sha256="$(git -C "$harness_dir/repo" archive HEAD | sha256sum | cut -d' ' -f1)"
if [[ "$tree_sha256" != "$OI_HARNESS_TREESHA" ]]; then
  echo "Harness tree digest mismatch: expected $OI_HARNESS_TREESHA, got $tree_sha256" >&2
  exit 1
fi
env HOME="$OI_RUNTIME_HOME" XDG_CONFIG_HOME="$OI_RUNTIME_HOME/.config" HARNESS_SURFACE=sandbox \
  "$harness_dir/repo/install.sh" --install
if [[ "$OI_RUNTIME_USER" != root ]]; then
  chown -R "$OI_RUNTIME_USER:$(id -gn "$OI_RUNTIME_USER")" \
    "$OI_RUNTIME_HOME/.claude" "$OI_RUNTIME_HOME/.config" "$OI_RUNTIME_HOME/.lazar-harness"
fi
OI_HARNESS_REF="$resolved_ref" /opt/openinspect/python/bin/python -c '
import json, os
from pathlib import Path
stamp = {
    "repo": os.environ["OI_HARNESS_REPO"],
    "ref": os.environ["OI_HARNESS_REF"],
    "treeSha256": os.environ["OI_HARNESS_TREESHA"],
}
Path("/app/openinspect-harness.json").write_text(json.dumps(stamp, indent=2) + "\n")
'
