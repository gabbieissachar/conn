#!/bin/bash
# Fetch the pinned third-party sources listed in tools/deps.lock into .deps/ and verify each revision.
#
# Why not a plain SwiftPM URL dependency: SwiftPM keeps dependency clones as bare repositories, and a git
# configuration with safe.bareRepository=explicit (this Mac's) refuses to run inside them, so `swift build` cannot
# resolve a URL dependency (or SwiftTerm's own manifest dependencies). A normal clone in .deps/, compiled as a plain
# target through the Sources/SwiftTermVendored/Upstream symlink, has the same pin and needs no git configuration
# change. If that setting is ever relaxed, Package.swift can go back to a URL dependency.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .deps
while read -r name url rev tag; do
  [[ -z "${name:-}" || "$name" == \#* ]] && continue
  dir=".deps/$name"
  if [ ! -d "$dir/.git" ]; then
    git clone --quiet "$url" "$dir"
  fi
  head=$(git -C "$dir" rev-parse HEAD)
  if [ "$head" != "$rev" ]; then
    git -C "$dir" cat-file -e "$rev^{commit}" 2>/dev/null || git -C "$dir" fetch --quiet --tags origin
    git -C "$dir" checkout --quiet "$rev"
  fi
  head=$(git -C "$dir" rev-parse HEAD)
  [ "$head" = "$rev" ] || { echo "fetch-deps: $name is at $head, expected $rev ($tag)" >&2; exit 1; }
done < tools/deps.lock
echo "fetch-deps: dependencies at pinned revisions"
