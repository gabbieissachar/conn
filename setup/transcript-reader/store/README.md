# Shadow store (S1)

One SQLite file that every harness's session log is ingested into, with the live identity of each Herdr pane, and the checks that
prove it against today's reader. **Nothing reads it yet.** The live reader (port 8768), its pages, its API and Conn are untouched:
this folder adds files and changes none. The plan is `data/reader-architecture-plan/plan.md` in the Firstmate home, slice S1, read
with the answers recorded in its header (W1 archive, W2 everything, W3 curated-only, W5 no limit, W6 Drive, W7 encrypt first).

```
logs (Claude x3 folders, Codex, Copilot, Pi) --> INGEST (Python, one writer) --> reader-store.sqlite (WAL, FTS5)
Herdr: events.subscribe + inventory reads  --->  IDENTITY (facts, bindings, events)        |
~/.claude*/sessions/<pid>.json (watched)  ---------^                                       +--> nightly: encrypted snapshot --> Drive folder
```

## Run it

```
python3 setup/transcript-reader/store/reader_store.py --help
python3 setup/transcript-reader/store/reader_store.py init       # the store and a default settings.json
python3 setup/transcript-reader/store/reader_store.py scan       # one pass over every log, with its CPU cost
python3 setup/transcript-reader/store/reader_store.py run        # the long-running ingest (what the LaunchAgent runs)
python3 setup/transcript-reader/store/reader_store.py status     # heartbeat, counts, skip and unknown-record counters
python3 setup/transcript-reader/store/reader_store.py search herdr events subscribe
```

The store lives in `~/.config/pmos-transcript-reader/store/` (outside the repository on purpose: under W1 it is the only copy of
a session once Claude deletes its log, so a recycled worktree or a rebuilt `out/` must not be able to take it). `PMOS_READER_STORE_DIR`
names another folder for a test or a lab. Every file is owner-only (0600 in 0700 folders). Settings are `settings.json` there
(`reader_store.py settings`); the defaults are right for W2 = everything.

Tests: `python3 -m unittest discover -s setup/transcript-reader/store/tests` (about 120 tests, a minute; synthetic logs, a fake Herdr, a fake
keychain, real gpg in a temporary keyring). `reader_store.py lab-run` runs them and keeps the result for the scorecard.

## What is stored

Tables are the store's own; **other repos read only the versioned views** (`v1_sessions`, `v1_turns`, `v1_live_bindings`,
`v1_ingest_status`; plan S8). `PRAGMA user_version` is the schema version (1); a reader refuses a version it does not know, and a
change to a view's columns is a new version with `v2_*` beside `v1_*`.

| Table | What it holds |
| --- | --- |
| `sources` | one row per log file generation: path, inode, **cursor** (bytes consumed), head and tail hashes, where the open turn starts, the derivation rules it was read under, state (`active`, `log_gone`, `replaced`, `skipped`) |
| `sessions` | one row per session: harness, home folder, owner account and organisation, scope label, folder, title, first and last time, `log_state` (`gone` once Claude deletes the log) |
| `events` | one row per kept record: raw identity fields (`uuid`, `parent_uuid`, `origin`, `is_meta`, `tool_use_id`, `absorbed`) as columns, the rest in `meta` JSON, a 400-character text excerpt; tool results are the reader's own bounded step output |
| `turns` | the reader's exchanges, derived by the reader's own rules (below); the whole text of every input and reply |
| `tool_calls` | each call's step (`tool_steps.make_step`), kept so a result that arrives later is bounded and hidden by the same rule |
| `search` | FTS5, one row per turn |
| `links` | `subagent` (from the path or a Codex parent thread), `clear` and `pane_successor` (inferred, labelled so) |
| `panes`, `facts`, `bindings`, `identity_events`, `herdr_lives` | live identity (below) |
| `counters`, `file_events` | skip, unknown and ignored record counters; truncation, replacement, deletion, rules-change events |
| `ingest_heartbeat`, `ingest_lag`, `rusage_samples` | "as of", lag samples, CPU samples |
| `parity_runs`, `parity_mismatches`, `builder_samples`, `builder_pane_map`, `disagreement_rows`, `send_checks`, `coverage_marks`, `backups` | the validation tooling |
| `forgotten` | tombstones: a session the owner forgot is never taken again |

### Ingest

`Ingester.scan` lists every log, compares each with its source row and ingests what changed. **A file is one transaction**: its events,
turns, search rows, tool steps, counters, session row and cursor commit together, so a process killed anywhere leaves the store as it was
before that file began and the next pass redoes it. An event is unique by (source, byte offset); nothing is ever taken twice.

- **Grown file**: the same source, from its cursor. Only the tail turn is derived again: `sources.turn_start_offset` is where the newest
  standing-alone turn's first record is, and the pass reads from there (`builder.derive` stamps each exchange with the record that began
  it; an absorbed turn needs the one before it, so the window starts at the last turn that stands alone).
- **Deleted file**: source `log_gone`, session `gone`, every row kept (W1). It is noticed once; if the file comes back with the same
  head and tail it continues.
- **Truncated, or replaced** (inode, head or the 256 bytes before the cursor differ): a new generation of the source. The old
  generation's rows stay; `v1_turns` and the session read the newest generation.
- **Rules change** (the builder's source changed with the checkout; `builder.RULES` is the reader's own `PARSE_RULES`): a log that is
  still there is derived again from its start; a `log_gone` log keeps its turns as derived. Events are never duplicated by this.
- **A last line with no newline** waits for it, unless it already parses whole (a record is complete when its object closes).
- **One unreadable file** never stops a pass (counted: `file_event/unreadable`).

Records are *kept* (an event row), *consumed* (an owner account or a title: a session fact, no row) or *ignored*: in `adapters.py`'s
known-ignored lists (`api-request`, `api-request-blob`, `last-prompt`, `token_count` ...), counted by kind and never stored; an
`api-request-blob` is never indexed as text. **Anything else is unknown**: counted (`unknown_record/...`) and still stored as a bare row
(kind, ids, time, the names of its keys). The first real run found 25 record kinds nobody had listed (for example Claude's
`artifact-autoreact-ledger`, `isolation-latch`, `frame-link`, and attachments such as `goal_status`); they are all visible in
`reader_store.py status` and none lost its position. Extending the known lists is the way they stop counting.

**Tool output follows the reader's own privacy rule**: text comes from `tool_steps` (a bounded output; nothing at all for a step that
touched a dotfile or a credential path; never the text of a file the agent read), applied in every harness, and a result whose call is
not in the store keeps no text. The Pi adapter keeps no tool result text.

### Scope (W2 = everything)

The default policy indexes every session: all `~/.claude*` folders (personal account included), `personal-work`, Codex, Copilot and Pi.
`sessions.scope` is a label (`default`, `personal`, `personal-work`, `codex` ...), not a filter. `scope_policy: "shopback-only"` (a
setting) skips a session whose owner organisation is not in `shopback_org_uuids` or whose folder is under `personal_cwd_prefixes`; every
skip is counted (`skipped_source/<harness>:<reason>`) and a skipped file is looked at again only when it changes or the policy does.

### Turn parity: the stated projection

The store derives turns with the builder's own functions, so a mismatch is an ingest bug. `parity.py` compares every field the store
keeps (`PROJECTED`: uid, source, kind, label, input, at, absorbed, reply, reply_at, word counts, narration, tools, verdict, rule, asks,
ask lines, reminder lines, signal task, cwd, notices) against `build_prototype.parsed_log` (no cache, nothing written). **Exclusions,
listed**: `folded` and `answered_below` (neighbour-dependent: a function of the turns around, computed when read, never stored), `steps` and
`touched` (tool detail and documents: not turns), and sessions the builder does not read (a Codex rollout whose `source` is not `cli`,
a Copilot log that is not a session, every Pi log: the builder has no Pi parser). A file that grows while compared is skipped and compared
next run. Each mismatch is stored with both values.

### Identity

`identity.py`, plan S1 "Identity (B1)", four rules:

1. **The key is (Herdr session, session life, pane id).** The life is the Herdr session folder's inode, so a session deleted and made
   again is a new life. `terminal_id` is stored beside it; `reader_store.py terminal-ids` tests it for uniqueness (see the numbers below).
2. **A fact is live only while the process it describes is the pane's harness process** (pid and `ps -o lstart` start time, the string
   Claude writes as `procStart`). It expires on `pane_exited`, `pane_closed`, a Herdr life change, Herdr stopping, the foreground
   changing (Ctrl+Z, exit, a restart), a pid record for another session (`/clear`) and the process dying.
3. **Rank among live facts**: the harness's pid record naming the foreground pid > Herdr's report > the working-folder inference
   (newest session of that harness in that folder, Codex, Copilot and Pi only).
4. **A Herdr value that has not changed since before the process changed is stale** (Herdr keeps the first id) and is not made a fact; a
   value Herdr reports anew is.

Every change to a pane's answer is an `identity_events` row with before and after (`bind`, `rebind`, `unbind`, `pane_created`,
`pane_closed`, `pane_exited`, `life_change`, `herdr_stopped`, `herdr_started`, `foreground_changed`, `process_restart`,
`fact_expired`, `events_lost`): these are the evidence rows of the coverage checklist. A failed `process-info` read never unbinds a pane.

**Herdr events.** One unix-socket subscription per running Herdr session (`pane.created`, `pane.closed`, `pane.updated`, `pane.exited`,
`pane.agent_detected`, `pane.moved`). Events are hints: each names a pane that is then read again from the inventory (`pane list`,
`pane process-info`), and a full reconcile read runs every 60 seconds. Herdr's schema (protocol 22) defines no loss message, so
`events_lost` is handled three ways: an explicit `events_lost` line, the connection ending or failing (reconnect with backoff), and a
quiet stream that fails a ping; each triggers a reconcile. The wire shape was probed read-only against the running Herdr
(`subscription_started`, then `{"event": ..., "data": {...}}` lines) and the fake Herdr (`tests/fake_herdr.py`) implements the same.
Pid records (`~/.claude*/sessions/<pid>.json`) are an identity event source of their own, stat-polled every 2 seconds, so a `/clear`
relinks without a Herdr call (lab: well under the 2-second budget).

**Links** (`links`): `subagent` comes from the path or a Codex parent thread; `clear` and `pane_successor` are inferred from rebinds
(a `/clear` when the new session opens with the command), labelled `inferred`. Resume, compact and fork stay unknown unless the reader
adds its own `SessionStart` hook (an outside-git change, needs the owner's go) or Herdr exposes `session_start_source` (M4).

### `forget <session>`

Removes a session and its sub-agents everywhere in one transaction (events, turns, search rows, tool steps, links, every fact and binding
that names it, Send checks, parity rows, the id Herdr last reported for it), writes a tombstone so the next scan does not read the
still-present log (nor a Codex child of it), then truncates the WAL and vacuums (`secure_delete` and FTS5's secure-delete are on, so the
text is out of the file: a test searches the raw bytes). **Backups from that point on** are taken from this file and hold nothing of it;
earlier snapshots still do, and the command lists them (it never deletes anything: move them aside).

## Backup (W6, W7)

`reader_store.py backup` (and the nightly job): SQLite's online `.backup` copies a consistent image (ingest keeps writing), the image is
**encrypted before it leaves the folder** to `<store>/backup-staging/reader-store-<UTC>.sqlite.<age|gpg>`, and the plain image is
removed at once (the one file this code deletes, and only its own temporary image). `age` is used when installed (encrypts to a public
key; the private key stays in the keychain, for restoring); it is not installed here, so **gpg** runs (symmetric AES-256): the passphrase is
read from the macOS keychain at the moment of use and handed to gpg on its standard input, never in an argument, the environment or a
file, and never printed. Restore: `reader_store.py backup-verify` decrypts the newest staged file into a scratch folder and checks it.

- **The key does not exist yet.** Creating it is a live write; the exact command is `reader_store.py key-command` (a `security
  add-generic-password` that asks for the passphrase at the terminal). Keep a copy in a password manager: a lost key means the backups
  cannot be read. Until it exists a backup stops with that command in the message and stages nothing.
- **Upload stops until Drive is signed in.** The Drive folder is a setting (`drive_folder`, `reader_store.py settings --set
  drive_folder=...`). While it is unset or missing the step stops and says `drive_not_configured` / `drive_folder_missing`; everything
  before it still runs. The folder must belong to a ShopBack Drive account (`GoogleDrive-<name>@shopback.com` in its path) unless
  `drive_allow_any` is set: a personal Drive is refused, not guessed. The upload copies the encrypted file, re-reads it and compares
  hashes. Drive holds ciphertext only.
- Staged snapshots beyond `keep_snapshots` (14) are reported, never deleted.

## Operations: the LaunchAgents (a live write, not installed)

`reader_store.py launchd` prints both agents and the exact commands; nothing is installed until the owner types `go` in the worker's
tab. `com.pmos.reader-store` runs the daemon (RunAtLoad, KeepAlive: restart on crash); `com.pmos.reader-store-nightly` runs the nightly job at
03:30 (diff job, builder sample, staged encrypted backup, upload step). **Restart on landing**: the daemon fingerprints its own code and
the builder's rules at start and exits when a landing changes them, so KeepAlive starts the new code; no `launchctl` call is needed on a
landing. The agents run the checkout the plist names: install them from the checkout firstmate lands S1 in. **Rollback**: `launchctl
bootout` both labels and move the plists aside (the printed undo), then keep the store file: it holds sessions whose logs are gone.

## Validation (how S1 is proved; plan "How S1 is validated")

| # | Check | Tool |
| --- | --- | --- |
| 1 | Turn parity | `parity` (unit-tested on fixtures; the daemon runs it on changed sessions, the nightly job on all) |
| 2 | Identity at the moment it matters | `sendrec.record` / `record-send`; `audit` for the same comparison with no Send. **The Send hook is applied in `api.js` and off until the recorder is named** (below) |
| 3 | Disagreement adjudication | `disagree sample`, `disagree list`, `disagree adjudicate <row> store-right\|builder-right\|both-wrong` (the `disagreements` view) |
| 4 | Event coverage checklist | `coverage show --write` (auto-detected from identity events), `coverage mark` for lab-staged or waived rows |
| 5 | Crash and file-change tests, in the lab | `tests/test_crash.py`, `tests/test_ingest.py` (`FileChanges`, `Forget`); `lab-run` |
| 6 | Cost and lag | `rusage`, `scan` (prints its own CPU), `ingest_lag`; budget in `rusage.BUDGET` |
| 7 | Usefulness (known answers) | `known-answers draft <queries>` then the owner fills `expected`; `known-answers check` |
| 8 | Exit scorecard | `scorecard --write` (or `SCORECARD-TEMPLATE.md`: the first render, every row OPEN) |

Nothing is PASS by default: a check that has not run reads OPEN. The soak runs after landing for at least seven days and ends when the
checklist is complete.

### The Send hook (applied, off by default)

Check 2 needs the guarded Send path to call `record-send` after its foreground check. The hook is in `api.js` (`recordSendCheck`, with two tests
in `api.test.js` against the fake Herdr); `store/send-hook.patch` is kept as the record of exactly what was applied. It is off unless
`PMOS_READER_STORE_RECORDER` names `reader_store.py` in the reader's environment, fire-and-forget (a failed recorder never delays, changes or
refuses a send), and it records `ok`, `other_session` or `agent_not_foreground`. The live reader on port 8768 runs its served copy, so the hook
does nothing there until that copy is updated and the variable is set (S2's rollout, not S1). Until then the scorecard's check 2 reads OPEN with
"no Send row", and `audit` rows give the same comparison continuously.

## Measured (this machine, 2026-11-07: 5.7 GB of raw logs, 2,249 sessions, two Herdr sessions with 51 panes)

All numbers are `getrusage` and `wall` from real runs against the real logs and the real Herdr (read-only), into a scratch store.

| What | Result | Budget (`rusage.BUDGET`) |
| --- | --- | --- |
| Cold ingest, everything | 75.8 s wall, 60 s CPU, peak 135 MB; 496,155 events, 20,989 turns; 1,343 Claude, 894 Codex, 11 Copilot, 1 Pi | one-off |
| Store size after it | 792 MB = 14% of the raw logs | W5: reviewed at six months |
| Idle scan (2,249 file stats, 1,500 folder stats) | 54 ms wall, 31 ms CPU, every 3 s | - |
| Daemon, steady state, its own CPU plus `herdr` and `ps` children | about 78 CPU-s per hour (2.2% of one core), peak 43 MB | 120 CPU-s/hour |
| Herdr reconcile read (53 calls), every 60 s | 0.66 s wall, 0.33 CPU-s | included above |
| Ingest lag p95 (a change waiting for the next scan) | 2.9 s | 5 s |
| Diff job over every session | 1,776 sessions, 15,507 turns, **0 mismatches**; 36.7 s wall, 30.8 CPU-s | 120 CPU-s per run |
| `/clear` to relink, lab | 0.08 s | 2 s |
| Audit of every bound pane against the send check | 296 checks, 0 disagree | 0 |

Where the 792 MB is: events 334 MB (tool-result excerpts 105 MB, `meta` 88 MB), turns 139 MB (the whole text of every input and reply:
Firstmate's long task briefs and wake-ups are most of it), FTS content 134 MB (a second copy of each turn's text), `tool_calls` 99 MB
(steps with their diffs), indexes about 80 MB. Cheap reductions if size matters at the six-month review: a contentless FTS table (about
134 MB, snippets then come from `turns`), dropping `meta` keys that nothing reads, and not keeping a step's diff for logs that are
still present. None is done: the store is an archive first.

## What the first real run found (and what changed because of it)

- **Claude's `procStart` is in another time zone than `ps` prints** (a real record read seven hours behind for the same process). Comparing
  the strings would have made every pid record look stale, and every Claude pane would have been bound by Herdr's report alone. Records are
  now matched to their process by the record's `startedAt` epoch within two minutes (`identity.record_matches`); with the fix 36 of 37 Claude
  panes bind by pid record and the audit agrees on all 37. A test pins the real record shape.
- **25 record kinds the adapters did not list** (counted, kept as bare rows): see `reader_store.py status`.
- **411 of 894 Codex rollouts are not read by the live reader** (`session_meta.source` is not `cli`). The store holds them (W2); the
  parity job lists them as skipped.
- **Four Codex panes have no session id** (workers started before the Codex reporter landed; their process folder is the project clone, not
  the worktree, so the folder inference finds nothing). The store leaves them unbound rather than guess; they bind when restarted.
- **`terminal_id` is unique** across the 51 panes seen (none shared, none overlapping): evidence for making it the key later; the code
  keys on (session, life, pane) until that has run through a Herdr restart.
- **Herdr's schema defines no `events_lost`.** See the Herdr events paragraph.
- **An idle scan was most of the CPU** until listings were cached by folder modification time and the `ps` start-time check moved out of
  the 0.5-second poll (reconcile checks it).

## Not done, and why

- The LaunchAgent, the keychain key and the Drive upload (outside git, live writes: the printed commands wait for `go` / the Drive sign-in).
- Turning the Send hook on in the live reader (it needs the served copy updated and `PMOS_READER_STORE_RECORDER` set; S2's rollout).
- Resume / compact / fork links (need a `SessionStart` hook or a Herdr field; a decision for the owner).
- Neighbour-dependent turn flags and the page's reading of any of this: S2.
- A parser for Pi in the builder (the store has its own adapter; parity cannot cover Pi until the builder does).
