# The Tasks board (reader side)

One board of open items and captain calls for each Firstmate session (big-boss, every leader, and the workers you drive), built from what
Firstmate already records. The design, the three review rounds and the calls (R1 to R8) are in the Firstmate home's
`data/task-board-prototype/report.md` and `decisions.md`; this folder is slices 1, 2 and 4 to 7 of its section 7: the data layer, the lifecycle
config, the reader half of reply marks, the shared tagger and thread builder, the page with answering on a card, and worker boards.

**Read only by default.** The routes are off unless the reader runs with `PMOS_READER_BOARD=1`, and they are never served on the tailnet listener
(the phone's copy is its own decision, with its own sealing). Two writes into Firstmate homes exist, each behind a flag of its own that is off:

| Flag | What it turns on | What it runs |
| --- | --- | --- |
| `PMOS_READER_BOARD_MARKS=1` | the page's "Yes, this task" / "Not this task" / "Belongs to task..." | `bin/fm-reply-mark.sh <task> in\|out\|clear <turn> --source card`, one line on `data/<task>/reply-marks.jsonl` |
| `PMOS_READER_BOARD_ANSWER=1` | "Record this answer" on a call | the one Firstmate command that owns that kind of call (`answer.py`) |

With a flag off the route answers 404 and the page hides that control (answers then offer "Copy answer for chat", `<task>#<call> = <answer>`).
The reader's own switch for worker boards is a small file of the reader's (`board-workers.json`), never a Firstmate home.

```
GET  /setup/transcript-reader/board/                                        the Tasks page (open it in a tab; #s=<session>&t=<task>[/<call>] opens a card)
POST /api/transcript-reader/board-mark    { session, task, turn, mark }     flagged
POST /api/transcript-reader/board-answer  { session, task, call, src, ... } flagged
POST /api/transcript-reader/board-worker  { leader, task, enabled }         a worker board on or off
```

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

## Reply threads (`transcripts.py`, `tagger.py`, `threads.py`)

The thread of a card is the supervisor's replies about that task with your messages attached, oldest first, plus the reply that asked each call and
the request that started the task. They are read from **the shadow store's versioned views** (`v1_sessions`, `v1_turns`), opened read only; the board
never parses a session log (plan S1/S8: one store, one API, many clients). When the store is missing, locked or of a schema this code does not know,
the board still builds and says so (`threads.status`, a banner on the page); nothing is guessed from another source. A lab store is made with
`board/tests/labstore.py` (the S1 ingest over synthetic logs); no test reads the real store.

| Piece | Rule |
| --- | --- |
| Which sessions | sessions whose working folder is one of the board session's `cwds` (a leader: its home; big-boss: the main home and the pmos checkout), main sessions only, not started as a worker brief, 3+ replies addressed to you in the window (30 days). A worker board reads the worker's worktree and keeps every reply. |
| Which reply is about which task (`tagger.py`) | sure: the task id in the reply, a wake-up the reader tied to it, the wake text naming it, data/ or fm/ pointers, its branch, PR or own review-board link, a task id in the turn's tool calls; possible: three rare id words; weak (never shown): one shared key, title words. A reply naming 4+ tasks, or a wake listing 4+, is a roundup. |
| Your marks | `data/<task>/reply-marks.jsonl` is folded per task (last line per turn wins) after the rules: `in` adds a reply (or a message of yours) to the card, `out` takes it off and leaves it struck through with "Put it back". |
| Asking reply (R2) | a typed ask: the reply that carries its `ask-...` id; a hold: the reply in the same turn as the hold time that the rules tied to the task, else the nearest in 40 minutes (labelled); a worker's own question: a task-matched reply within 6 hours. |
| Request that started a task (R5) | a message of yours of 25+ characters with no reply above it, linked to the task that started up to 45 minutes after it (creation time, else spawn time), shown dashed with Yes / Not this task. |
| Fleet upkeep, No task found (R6) | replies no card shows: short or routine wording is upkeep, the rest is No task; each row has Open and (with marks on) "Belongs to task...". |

**What the store views cannot give, and the one place the board reads a table.** Version 1 has no tool text, so the strongest rule of the prototype (a
task id in the turn's own tool calls, `fm-send.sh <id>`: 127 of about 220 exact links in one home) needs more than `v1_turns`. Measured on the real
store, a board on the views alone linked 31 of 357 replies exactly (16 of 67 cards with a thread in workspaceOS); with tool text it links 91 and 42 of
67 (eSIM 41 of 99 replies and 13 of 64 cards; NIP 49 of 98 and 15 of 26). So the board asks for it, in order: the store's own `v1_turn_tools` view if a store
version has one, else the same definition (`store/PROPOSED-v1-turn-tools.sql`, tested against the real schema) as a **per-connection TEMP view over the
schema-1 tables**. A temp view lives in the board's own read-only connection: nothing is written to the store file (a test compares the file byte for
byte), and a store whose tables differ just loses that signal. That is the one read of a table rather than a view; `PMOS_READER_BOARD_TOOL_TEXT=0`
turns it off. Making `v1_turn_tools` a real versioned view is an S2 migration and is not done here (S1's soak is untouched).

## Answering a call (`answer.py`)

A live write into a Firstmate home, behind `PMOS_READER_BOARD_ANSWER=1`. Each kind of call goes to the command that already owns it, run with that
home's `FM_HOME`; nothing is sent unless the command accepts it, and its own sentence is what the page shows. The page asks for a second click that
shows the exact command first.

| Call | Command |
| --- | --- |
| typed card (`src: ask`) | `fm-captain-ask.sh answered <ask-id>` with `KEY=value` on stdin; the option's words come from the record, never the page; `;`, newlines, `\|` and `KEY=` in free text are rewritten so text cannot answer another card; `later` keeps it held |
| the only call of a prose hold (`src: hold`) | `fm-captain-hold.sh answers --any-origin --source reader-board`, mode `done`, or `release` for a go |
| a prose hold with several calls | refused: Firstmate closes such a hold only whole, so answering one call would close the others unseen. Answer in chat, or have the calls re-asked as cards. |
| a worker's keyed question / a worker that waits | `fm-send.sh <task> --resolve-key <key> <text>` / `fm-send.sh <task> <text>` |
| a review-board call | answered on its own board |

Tested with fake commands (argv, stdin, refusals) and with the real scripts against a scratch home made by the test; never against a real home.

## Worker boards (`workers.py`)

A worker a leader marked captain-driven gets a board of its own (W1 = a), on by default with an on/off switch ("Workers you drive" on the page).
It shows the cards that worker raised (its task, calls whose origin is that task, tasks it blocks), inherits the leader's lifecycle and home, and
reads the worker's own worktree transcript, where every reply is on its own card. Which workers exist comes from the leaders' last board builds
(`board-cache/drivers/<leader>.json`, the reader's cache), so a worker appears after its leader's board has been read once.

## Sessions (`homes.py`)

Defaults come from the machine, never from a path in this repository: big-boss is `FM_MAIN_HOME` (else `~/fm-homes/pmos`), a leader's home is
the `(home: ...)` its line names in the main home's `data/secondmates.md`, and the Firstmate scripts are found from `FM_ROOT` or the installed
`fm-ask` link. Only `workspaceos`, `esim` and `nip` are leaders by default. `~/.config/pmos-transcript-reader/board.json`
(`PMOS_READER_BOARD_CONFIG` moves it) replaces the sessions (each may list `cwds`, the folders whose sessions are its supervisor), names another
scripts checkout, or names the folder of the store (`store`; else `PMOS_READER_STORE_DIR`, else `~/.config/pmos-transcript-reader/store`).

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
python3 -I -m unittest discover -s setup/transcript-reader/board/tests     # the data layer (fixtures, scratch homes, a lab store, real scratch git repos, real Firstmate scripts on scratch homes)
node --test setup/transcript-reader/board.test.js                          # board.js: cache, stale-while-revalidate, failures, the flagged writes, the page source
node --test setup/transcript-reader/api.test.js                            # the routes (flags off by default, guard, loopback only, the page's token)
node setup/transcript-reader/e2e/board-check.js                            # by hand: the page in a real browser against a scratch home and a lab store (24 checks; needs chrome-devtools-axi)
```

`RealScripts` in `test_collect.py` runs the real snapshot and ask scripts against a scratch home when a Firstmate checkout is installed, and
skips otherwise. No test touches a real Firstmate home, port 8768 or a pane.
