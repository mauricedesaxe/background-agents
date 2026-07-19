#!/usr/bin/env bash
set -euo pipefail

# Installs the agent harness into a sandbox image by running the harness's own install.sh, so a
# sandbox agent reads the same skills, agents and philosophy a laptop agent reads. Before this,
# the harness was copied into sandbox_runtime/ by hand and drifted: the sandbox's philosophy still
# carried §29, which the harness dropped, and its clarity-reviewer never got the OpenCode dialect.
#
# Every provider's image build calls this one script rather than open-coding the clone, so the pin
# and the surface are stated once. It is a real seam of its own: install.sh's own test covers what
# install.sh does with a source tree, and nothing there covers fetching the right pin, passing
# `sandbox`, or refusing to run somewhere it shouldn't.
HARNESS_REPO="${HARNESS_REPO:-https://github.com/mauricedesaxe/lazar-harness.git}"

# Pinned to a commit, not a branch: an image build that tracked main would install whatever the
# harness happened to be at that minute, and two builds of the same source would diverge. Bump it
# deliberately to take harness changes.
HARNESS_REF="${HARNESS_REF:-61d2d64e455ef295a127e33a15d9949b0b4ac690}"

die() {
  printf 'install-harness.sh: %s\n' "$1" >&2
  exit 1
}

APPLY=false
for arg in "$@"; do
  case "$arg" in
  --install) APPLY=true ;;
  *) die "$arg is not an argument this takes; it takes --install and nothing else" ;;
  esac
done

# Writing is opt-in, and the flag rides argv rather than the environment, for the reason install.sh
# says: a code-reviewer subagent once ran install.sh with no argument against a live
# CLAUDE_CONFIG_DIR and wiped 12 skills, 5 agents and a hand-written CLAUDE.md off the machine. The
# one thing that authorises a write has to be the one thing that cannot arrive by inheritance from
# whatever shell an agent is standing in.
[ "$APPLY" = true ] ||
  die "refusing to run without --install; this replaces the harness in \$HOME and writes nothing by default"

# This script is for image builds, where HOME is the image's own root and nothing else is on disk.
# A set CLAUDE_CONFIG_DIR means it is being run somewhere with a config dir worth naming — a
# laptop — and install.sh would resolve it and replace whatever is there.
[ -z "${CLAUDE_CONFIG_DIR:-}" ] ||
  die "CLAUDE_CONFIG_DIR is set, so this is not an image build; refusing to replace a live harness"

command -v git >/dev/null || die "git is needed to fetch the harness"
command -v jq >/dev/null || die "jq is needed by install.sh to merge OpenCode's instructions array"

checkout=$(mktemp -d)
trap 'rm -rf -- "$checkout"' EXIT

# Fetching the commit directly keeps the clone shallow without pinning to a branch tip the way
# `clone --depth 1` would.
git init -q -- "$checkout"
git -C "$checkout" fetch --depth 1 -q -- "$HARNESS_REPO" "$HARNESS_REF" ||
  die "could not fetch $HARNESS_REF from $HARNESS_REPO"
git -C "$checkout" checkout -q FETCH_HEAD

# The fetch resolves the ref server-side, so a ref that is not the commit it claims to be would
# otherwise install quietly. This is the line that makes the install reproducible rather than
# merely pinned-looking.
resolved=$(git -C "$checkout" rev-parse HEAD)
[ "$resolved" = "$HARNESS_REF" ] ||
  die "asked for $HARNESS_REF but got $resolved"

HARNESS_SURFACE=sandbox "$checkout/install.sh" --install

printf 'install-harness.sh: installed harness %s for the sandbox surface\n' "$HARNESS_REF"
