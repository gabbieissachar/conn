#!/bin/bash
# Reviewer F9d: the whole app frozen for a while (the nearest thing to sleep that does not stop the machine), then resumed.
# Runs against the stand-in Herdr only. The sidebar must still be live and the pane must still be streaming afterwards.
cd "$(dirname "$0")/.."
PAUSE=${1:-20}
D=/tmp/conn-stall-$UID; S=$D/state; mkdir -p "$D" "$S"
printf '#!/bin/sh\nexec "%s/build/FakeHerdr" cli "$@"\n' "$PWD" > "$D/herdr"; chmod +x "$D/herdr"
build/FakeHerdr serve --dir "$D/s" --session fake --agents 12 >/dev/null 2>&1 &
FAKE=$!
trap 'kill $FAKE 2>/dev/null' EXIT
sleep 1
OUT=$D/out.txt
CONN_STATE_DIR="$S" CONN_ARGS="--session fake --socket-dir $D/s --herdr-bin $D/herdr --fixture --web off --background --selftest $((PAUSE + 22)) --quit-after $((PAUSE + 40))" build/Conn.app/Contents/MacOS/Conn > "$OUT" 2>&1 &
APP=$!
sleep 8
kill -STOP $APP; echo "app frozen for ${PAUSE}s"; sleep "$PAUSE"; kill -CONT $APP; echo "app resumed"
# a state change on the stand-in while the app was frozen would be invisible to it; make one now to prove events still flow
python3 - "$D/s/fake/herdr.sock" <<'PY'
import socket, json, sys
s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])
s.sendall((json.dumps({"id":"x","method":"fake.set_state","params":{"pane_id":"w01:p1","state":"blocked"}})+"\n").encode()); s.recv(4096)
PY
wait $APP 2>/dev/null
grep -E "link=|primary:|snapshot=" "$OUT"
grep -q "link=live" "$OUT" && grep -q "primary: state=live" "$OUT" && echo "PASS: sidebar live and pane streaming after a ${PAUSE}s freeze" || echo "FAIL"
