#!/bin/bash
# Run Helm. Options go through the HELM_ARGS environment variable (AppKit treats stray argv words as files to open).
#   ./run.sh                      live: observe-only client of Herdr session "esim"
#   ./run.sh --session NAME       another Herdr session
#   ./run.sh --write NAME         allow the compose box to send to that session (default: none)
#   ./run.sh --fixture            a stand-in Herdr with invented agents, invented web pages; safe to screen-share,
#                                 and the one place the compose box is exercised
#   ./run.sh --renderer swiftterm SwiftTerm pane view (default: the cell-grid view, see the handoff)
#   ./run.sh --mode agent|editor|herdr   --web on|off   --select N   --dark   --privacy   --open FILE
#   ./run.sh --selftest 10 | --shot FILE | --tour DIR | --quit-after N
cd "$(dirname "$0")"
[ -d build/Helm.app ] || ./build.sh
ARGS="$*"
if [[ " $ARGS " == *" --fixture "* ]]; then
  # Short path: a Unix socket path is limited to 104 bytes.
  DIR=/tmp/helm-fixture-$UID
  mkdir -p "$DIR"
  printf '#!/bin/sh\nexec "%s/build/FakeHerdr" cli "$@"\n' "$PWD" > "$DIR/herdr"
  chmod +x "$DIR/herdr"
  build/FakeHerdr serve --dir "$DIR/s" --session fake --agents 24 >/dev/null 2>&1 &
  FAKE=$!
  trap 'kill $FAKE 2>/dev/null' EXIT
  sleep 0.8
  ARGS="--session fake --socket-dir $DIR/s --herdr-bin $DIR/herdr --write fake $ARGS"
fi
HELM_ARGS="$ARGS" build/Helm.app/Contents/MacOS/Helm
