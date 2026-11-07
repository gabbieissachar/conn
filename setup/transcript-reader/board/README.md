# The Tasks board (reader side)

One board of open items and captain calls for each Firstmate session (big-boss and every leader), built from what Firstmate already
records. The design, the three review rounds and the calls (R1 to R8) are in the Firstmate home's `data/task-board-prototype/report.md` and
`decisions.md`; this folder is slices 1 and 2 of its section 7 (data layer and lifecycle config). The page, the reply threads and answering a
call on its card are later slices and are not here yet.

**Read only.** Nothing here writes to a Firstmate home or a project. The routes are off unless the reader runs with `PMOS_READER_BOARD=1`, and
they are never served on the tailnet listener (the phone's copy is its own decision, with its own sealing).

```
python3 -I setup/transcript-reader/board_cli.py sessions                    # which sessions have a board
python3 -I setup/transcript-reader/board_cli.py board --session leader-esim # one board, JSON on stdout (what the route runs)
python3 -I setup/transcript-reader/board_cli.py check-config --session leader-esim   # is that home's config/task-board.json usable?
GET /api/transcript-reader/board?session=leader-esim[&fresh=1]              # { status, board, cached_at, stale }
GET /api/transcript-reader/board-sessions
```

## Where the facts come from (`collect.py`)

| Fact | Source |
| --- | --- |
| Every open task, its hold (kind, reason, date, bucket), blockers, done date | `bin/fm-fleet-snapshot.sh --json` run with `FM_HOME=<the session's home>` |
| Structured calls: question, choices, recommended choice, report link, per card | `bin/fm-captain-ask.sh list --open --resolve --json` (typed `fm-ask.v1` records, a card gated on the task) |
| The worker's own lines, `[on=...]` tag, open decisions, ready and merged | the task's `state/<id>.status` (last 64 KB), and the snapshot's `hints.open_decisions` |
| Branch against main | `git rev-parse`, `git rev-list --count main..<branch>` in the project's clone: `merged` (nothing main lacks), `ahead n`, `missing`, `unknown` |
| Report presence and a one-paragraph summary | `data/<id>/report.md`, else the first `data/*.md` the task's own text names |
| Task creation time | the `Created:` line Firstmate puts first in a new task's body; none for older tasks |

The snapshot takes about 15 s for a home (it asks every worker), so the route keeps an answer for 20 s and sends a stale one at once while a new
one builds (`stale: true`); `fresh=1` waits for a new build. The snapshot's one side effect (a cache of other homes' summaries) is pointed at
`~/.config/pmos-transcript-reader/board-cache/` (`PMOS_READER_BOARD_CACHE` moves it), so no Firstmate home's state is written. Scripts run with a
small environment of their own (the target `FM_HOME`, `PATH`, nothing else the caller set) and a timeout.

A call with a typed card shows the card (`src: ask`). A hold written before typed records exists is split into calls by the prototype's text
rules (`hold_parse.py`, `src: hold`), so old calls stay readable and new ones are exact. Keyed open decisions in a worker's status lines are
`src: status`, and a paused line that says the worker waits for the owner is `src: wait`.

## Sessions (`homes.py`)

Defaults come from the machine, never from a path in this repository: big-boss is `FM_MAIN_HOME` (else `~/fm-homes/pmos`), a leader's home is
the `(home: ...)` its line names in the main home's `data/secondmates.md`, and the Firstmate scripts are found from `FM_ROOT` or the installed
`fm-ask` link. Only `workspaceos`, `esim` and `nip` are leaders by default. `~/.config/pmos-transcript-reader/board.json`
(`PMOS_READER_BOARD_CONFIG` moves it) replaces the sessions or names another scripts checkout.

## Lifecycles (`lifecycles.py`)

A card's stage (`needs`, `done`, `parked`, `queued`, or active) is the same in every home. Active tasks are placed by the session's lifecycle:
columns plus ordered `place` rules over named facts. Built in: **software** (landing is a state), **pm** (drafts are plain files: *Draft ready
for you* and *Legacy draft branches*, nothing to land), **integration** (in review, standing crews, waiting on a partner) and **fleet**.

A home can carry `config/task-board.json` (the reader reads it and never writes it):

```json
{"schema": "task-board.v1", "lifecycle": "pm"}
{"schema": "task-board.v1", "lifecycle": {"extends": "pm", "name": "eSIM", "place": [{"col": "waiting", "when": {"waiting_on": true}}]}}
```

`lifecycle` is a built-in name or an object (`extends` copies a built-in, each key given replaces that key whole; `columns` need `needs` and
`done`; `default` and every `place` column must be declared; facts are the names in `lifecycles.FACTS`). A file that cannot be used is ignored,
the built-in default stands, and the reason is on the board (`config.error`). Writing this schema into Firstmate's `docs/configuration.md` is
follow-up work in the Firstmate repository.

Placement details (report sections 3, 5 and R7, R8): a go-only hold waits in **Queued** with a label; a record whose branch is already in main
(or whose status says merged) is a stale record with a chip, never a draft; a task is **Waiting on others** only when its paused line carries
`[on=stakeholder|partner|system|date]`; a quiet running record (14+ days) gets a chip, not a column.

## Tests

```
python3 -I -m unittest discover -s setup/transcript-reader/board/tests     # the data layer (fixtures, scratch homes, real scratch git repos)
node --test setup/transcript-reader/board.test.js                          # board.js: cache, stale-while-revalidate, failures
node --test setup/transcript-reader/api.test.js                            # the routes (flag off by default, guard, loopback only)
```

`RealScripts` in `test_collect.py` runs the real snapshot and ask scripts against a scratch home when a Firstmate checkout is installed, and
skips otherwise. No test touches a real Firstmate home, port 8768 or a pane.
