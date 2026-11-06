# shellcheck shell=bash disable=SC2034
# Shared by the stand-in commands. The scenario comes from the stub_scenario workflow input
# (INPUTS_STUB_SCENARIO); state between stand-ins is kept under $ARTIFACTS_DIR/stub-state.
#
#   running            Conn runs (pid 4242), started with no CONN_ARGS; quit then launch work
#   running-args       as running, started with CONN_ARGS="--session fake --write fake"
#   running-argv       as running, started with the argument --dark and no CONN_ARGS
#   env-hidden         as running, but the process environment cannot be read
#   not-running        Conn is not running; launch works
#   running-no-actions as running, and a quit or a launch fails the run (used for the reject answer)
#   quit-stuck         the quit request is accepted but Conn never exits
#   two-running        two Conn processes run from this build
#   dirty | wrong-branch | head-moves | build-fails   preflight and build failures, Conn running
SC="${INPUTS_STUB_SCENARIO:-running}"
STATE="${ARTIFACTS_DIR:?}/stub-state"
mkdir -p "$STATE"
EXE="$(pwd -P)/build/Conn.app/Contents/MacOS/Conn"
OLD_PID=4242
NEW_PID=4343
