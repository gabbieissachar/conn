#!/bin/bash
# Run the unit tests. The Command Line Tools ship Swift Testing but SwiftPM does not point at it on its own.
set -euo pipefail
cd "$(dirname "$0")"
CLT=/Library/Developer/CommandLineTools
exec swift test \
  -Xswiftc -F"$CLT/Library/Developer/Frameworks" -Xswiftc -plugin-path -Xswiftc "$CLT/usr/lib/swift/host/plugins/testing" \
  -Xlinker -F"$CLT/Library/Developer/Frameworks" -Xlinker -rpath -Xlinker "$CLT/Library/Developer/Frameworks" \
  -Xlinker -rpath -Xlinker "$CLT/Library/Developer/usr/lib" "$@"
