#!/bin/bash
# Stand-in for ./build.sh: makes a placeholder build/Conn.app/Contents/MacOS/Conn in the current directory.
. "$(dirname "$0")/_common.sh"
if [ "$SC" = build-fails ]; then
  i=1; while [ $i -le 60 ]; do echo "stub build line $i"; i=$((i + 1)); done
  echo "error: stub build failed"
  exit 1
fi
mkdir -p build/Conn.app/Contents/MacOS
printf '#!/bin/sh\nexit 0\n' > build/Conn.app/Contents/MacOS/Conn
chmod +x build/Conn.app/Contents/MacOS/Conn
echo "built build/Conn.app"
