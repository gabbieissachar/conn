#!/bin/bash
# Reviewer F4: an observer child must not outlive a killed app. Runs against the stand-in Herdr only.
#   1. start the app (fixture) and wait for its observer child, 2. kill -9 the app, 3. confirm the child is still there
#   with parent pid 1 (the leak), 4. start the app again and confirm the leftover child was ended.
cd "$(dirname "$0")/.."
D=/tmp/helm-kill9-$UID; S=$D/state; mkdir -p "$D" "$S"
printf '#!/bin/sh\nexec "%s/build/FakeHerdr" cli "$@"\n' "$PWD" > "$D/herdr"; chmod +x "$D/herdr"
build/FakeHerdr serve --dir "$D/s" --session fake --agents 6 >/dev/null 2>&1 &
FAKE=$!
trap 'kill $FAKE 2>/dev/null' EXIT
sleep 1
launch() { HELM_STATE_DIR="$S" HELM_ARGS="--session fake --socket-dir $D/s --herdr-bin $D/herdr --fixture --web off $1" build/Helm.app/Contents/MacOS/Helm >/dev/null 2>&1 & echo $!; }
child_of() { ps -axo pid=,ppid=,command= | awk -v p="$1" '$2==p && /terminal session observe/ {print $1}'; }
APP=$(launch ""); sleep 6
KID=$(child_of $APP)
echo "app=$APP observer child=$KID"
[ -n "$KID" ] || { echo "FAIL: no observer child"; kill $APP; exit 1; }
cat "$S/observers.json"; echo
kill -9 $APP; sleep 1
PPID_NOW=$(ps -o ppid= -p $KID 2>/dev/null | tr -d ' ')
echo "after kill -9: child $KID alive=$([ -n "$PPID_NOW" ] && echo yes || echo no) ppid=$PPID_NOW"
APP2=$(launch "--quit-after 8"); sleep 3
ALIVE=$(ps -o pid= -p $KID 2>/dev/null | tr -d ' ')
echo "after relaunch: old child $KID alive=$([ -n "$ALIVE" ] && echo yes || echo no)"
wait $APP2 2>/dev/null
[ -z "$ALIVE" ] && echo "PASS: the leftover observer was ended at the next launch" || { echo "FAIL: leftover observer still running"; kill $KID; }
