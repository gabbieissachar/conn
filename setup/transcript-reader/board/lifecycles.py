"""Lifecycles: the columns a session's board has, and the rules that place an active task in one.

A lifecycle is data (report section 7, slice 2; ledger L1 = a). `BUILTIN` holds the four the prototype settled on: software, pm, integration and
fleet. A home can carry `config/task-board.json` to choose one or to define its own; the reader reads that file and never writes it. This
module is the evaluator: `resolve_lifecycle` loads and validates, `place` maps a task's facts to a column id.

A task first gets a lifecycle-independent stage (`needs`, `done`, `parked`, `queued`, or active), which is decided from the backlog and the
holds alone and is the same in every home. Only the active tasks (`ready` or `running`) are placed by the lifecycle's own `place` rules, an
ordered list of `{"col": <column id>, "when": {<fact>: <value>, ...}}` where every fact must match. The first match wins and `default` is the
column when none does. A rule naming a column the lifecycle does not declare is a config error, not a silent drop.

`config/task-board.json`, schema `task-board.v1`:

    {"schema": "task-board.v1",
     "lifecycle": "pm",                      # a built-in name, or an object below
     "label": "leader-esim"}                  # optional, shown on the board

    {"schema": "task-board.v1",
     "lifecycle": {"extends": "pm", "name": "PM work", "blurb": "...",
                   "columns": [{"id": "needs", "name": "Needs you", "sub": "...", "common": true}, ...],
                   "place": [{"col": "waiting", "when": {"waiting_on": true}}], "default": "running"}}

`extends` copies a built-in and each key given replaces that key whole. The columns `needs` and `done` are required (the stage rules put tasks
there), `queued` and `parked` are optional (a task whose stage has no column goes to `default`; a go-only hold needs `queued`).
Facts a rule may test: see FACTS. Writing this schema into Firstmate's docs is follow-up work (the board build's done line says so).
"""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path

SCHEMA = "task-board.v1"
CONFIG_RELATIVE = Path("config") / "task-board.json"

NEEDS = {"id": "needs", "name": "Needs you", "sub": "a question, an answer or your go", "common": True}
RUNNING = {"id": "running", "name": "Running", "sub": "a worker is on it"}
QUEUED = {"id": "queued", "name": "Queued", "sub": "not started"}
PARKED = {"optional": True, "id": "parked", "name": "Parked until a date", "sub": "comes back on its date"}
READY = {"id": "ready", "name": "Ready to land", "sub": "branch ready, waiting for the merge"}

BUILTIN: dict[str, dict] = {
    "software": {
        "id": "software", "name": "Software", "blurb": "Work that ships code. Landing is a state.",
        "columns": [NEEDS, READY, RUNNING, QUEUED, PARKED, {"id": "done", "name": "Landed in the last 7 days", "sub": "landed or reported"}],
        "place": [{"col": "ready", "when": {"ready": True}}],
        "default": "running",
    },
    "pm": {
        "id": "pm", "name": "PM work",
        "blurb": "Analysis, drafts, reviews and ops runs. Drafts are plain files, so there is nothing to land: a draft is ready for you to read instead.",
        "columns": [
            NEEDS,
            {"id": "review", "name": "Draft ready for you", "sub": "a report, prototype, PRD or draft file to read"},
            {"optional": True, "id": "legacy", "name": "Legacy draft branches", "sub": "old draft branches from before the drafts rule: read or triage, nothing to land"},
            {"id": "running", "name": "Working", "sub": "a worker is on it"},
            {"optional": True, "id": "waiting", "name": "Waiting on others", "sub": "a stakeholder, a system or a date outside your hands"},
            QUEUED, PARKED,
            {"id": "done", "name": "Delivered in the last 7 days", "sub": "sent, published or reported"},
        ],
        "place": [
            {"col": "running", "when": {"merged_record": True}},
            {"col": "legacy", "when": {"legacy_branch": True}},
            {"col": "review", "when": {"artifact_file": True}},
            {"col": "waiting", "when": {"waiting_on": True}},
        ],
        "default": "running",
    },
    "integration": {
        "id": "integration", "name": "Integration", "blurb": "Partner integrations and ops runs: PRs in review, replays, standing crews.",
        "columns": [
            NEEDS,
            {"id": "pr", "name": "In review", "sub": "a PR is open, or a branch is ready to open one"},
            {"id": "running", "name": "Running", "sub": "a worker is on it"},
            {"optional": True, "id": "waiting", "name": "Waiting on a partner", "sub": "an answer or a system outside your hands"},
            {"optional": True, "id": "standing", "name": "Standing crews", "sub": "idle until the next request"},
            QUEUED, PARKED,
            {"id": "done", "name": "Merged or reported in 7 days", "sub": "merged, replayed or reported"},
        ],
        "place": [
            {"col": "running", "when": {"merged_record": True}},
            {"col": "pr", "when": {"pr_open": True}},
            {"col": "pr", "when": {"ready": True}},
            {"col": "standing", "when": {"standing": True}},
            {"col": "waiting", "when": {"waiting_on": True}},
        ],
        "default": "running",
    },
    "fleet": {
        "id": "fleet", "name": "Fleet tooling", "blurb": "Firstmate patches (landing is a state) plus watches and grill-me reviews.",
        "columns": [
            NEEDS, READY, RUNNING,
            {"optional": True, "id": "standing", "name": "Watching", "sub": "paused on a host or an event"},
            QUEUED, PARKED,
            {"id": "done", "name": "Landed in the last 7 days", "sub": "landed or reported"},
        ],
        "place": [
            {"col": "running", "when": {"merged_record": True}},
            {"col": "ready", "when": {"ready": True}},
            {"col": "standing", "when": {"paused_idle": True}},
        ],
        "default": "running",
    },
}

# The facts a `place` rule may test. All are booleans except `kind` and `last_state`, which are matched as strings (a list matches any of them).
FACTS = {
    "ready": "the worker reported a branch ready and nothing since says it landed",
    "pr_open": "a PR or merge request is recorded for the task and the task is open",
    "merged_record": "the record is still open but its work is merged (a status line says so, or its branch is fully in main and the worker is quiet)",
    "legacy_branch": "an open task that carries a branch with commits main does not have, and no PR",
    "artifact": "the worker's last line is done or paused and says a report, draft or branch is ready, and one exists",
    "artifact_file": "the same, but only a report or draft file counts (a branch does not)",
    "waiting_on": "the last status line is paused and carries an [on=stakeholder|partner|system|date] tag",
    "standing": "the last line is done or paused and says the crew is standing by or idle until the next request",
    "paused_idle": "the last line is paused and no artifact is ready",
    "captain_driven": "the captain works with this task directly",
    "live": "the task has a worker record",
    "kind": "the task's kind (ship, scout, captain, secondmate ...)",
    "last_state": "the state word of the last status line",
}


class LifecycleError(ValueError):
    pass


def _validate_columns(columns) -> list[dict]:
    if not isinstance(columns, list) or not columns:
        raise LifecycleError("columns must be a non-empty list")
    seen, out = set(), []
    for column in columns:
        if not isinstance(column, dict):
            raise LifecycleError("each column must be an object")
        cid = column.get("id")
        if not isinstance(cid, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,30}", cid):
            raise LifecycleError(f"column id {cid!r} must be lower-case letters, digits and dashes")
        if cid in seen:
            raise LifecycleError(f"column id {cid!r} appears twice")
        seen.add(cid)
        name = column.get("name")
        if not isinstance(name, str) or not name.strip():
            raise LifecycleError(f"column {cid!r} needs a name")
        clean = {"id": cid, "name": name.strip()[:60], "sub": str(column.get("sub") or "")[:160]}
        if column.get("optional"):
            clean["optional"] = True
        if column.get("common"):
            clean["common"] = True
        out.append(clean)
    for required in ("needs", "done"):
        if required not in seen:
            raise LifecycleError(f"a lifecycle needs a {required!r} column")
    return out


def _validate_when(when, where: str) -> dict:
    if not isinstance(when, dict) or not when:
        raise LifecycleError(f"{where}: when must be a non-empty object")
    for fact, expected in when.items():
        if fact not in FACTS:
            raise LifecycleError(f"{where}: unknown fact {fact!r}")
        if fact in ("kind", "last_state"):
            ok = isinstance(expected, str) or (isinstance(expected, list) and expected and all(isinstance(v, str) for v in expected))
        else:
            ok = isinstance(expected, bool)
        if not ok:
            raise LifecycleError(f"{where}: fact {fact!r} has a value of the wrong type")
    return when


def validate_lifecycle(spec: dict) -> dict:
    """A complete lifecycle object -> the cleaned copy, or LifecycleError naming what is wrong."""
    if not isinstance(spec, dict):
        raise LifecycleError("a lifecycle must be an object")
    columns = _validate_columns(spec.get("columns"))
    ids = {c["id"] for c in columns}
    default = spec.get("default", "running")
    if default not in ids:
        raise LifecycleError(f"default column {default!r} is not one of the columns")
    place = []
    for index, rule in enumerate(spec.get("place") or []):
        if not isinstance(rule, dict) or rule.get("col") not in ids:
            raise LifecycleError(f"place rule {index} names a column that is not declared")
        place.append({"col": rule["col"], "when": _validate_when(rule.get("when"), f"place rule {index}")})
    name = spec.get("name")
    if not isinstance(name, str) or not name.strip():
        raise LifecycleError("a lifecycle needs a name")
    return {"id": str(spec.get("id") or "custom")[:40], "name": name.strip()[:60], "blurb": str(spec.get("blurb") or "")[:400],
            "columns": columns, "place": place, "default": default}


def builtin(name: str) -> dict:
    if name not in BUILTIN:
        raise LifecycleError(f"unknown lifecycle {name!r}; the built-in ones are {', '.join(sorted(BUILTIN))}")
    return copy.deepcopy(BUILTIN[name])


def read_home_config(home: Path) -> tuple[dict | None, str | None]:
    """(config, error) for <home>/config/task-board.json. A missing file is (None, None); an unreadable or invalid one is (None, why)."""
    path = Path(home) / CONFIG_RELATIVE
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, None
    except OSError as error:
        return None, f"{path.name} cannot be read ({error.strerror or error.__class__.__name__})"
    try:
        config = json.loads(raw)
    except ValueError:
        return None, f"{path.name} is not valid JSON"
    if not isinstance(config, dict) or config.get("schema") != SCHEMA:
        return None, f"{path.name} does not declare schema {SCHEMA}"
    return config, None


def resolve_lifecycle(default_name: str, home: Path | None) -> tuple[dict, dict]:
    """(lifecycle, source) for a session: the home's config when present and valid, else the built-in `default_name`.

    source is {"from": "builtin" | "home-config", "path": <file or None>, "error": <why the config was ignored, or None>}.
    """
    source = {"from": "builtin", "path": None, "error": None}
    fallback = builtin(default_name if default_name in BUILTIN else "software")
    if home is None:
        return fallback, source
    config, error = read_home_config(home)
    path = str(Path(home) / CONFIG_RELATIVE)
    if error:
        source.update(path=path, error=error)
        return fallback, source
    if config is None:
        return fallback, source
    choice = config.get("lifecycle")
    try:
        if isinstance(choice, str):
            spec = builtin(choice)
        elif isinstance(choice, dict):
            base = builtin(choice["extends"]) if choice.get("extends") else {}
            spec = {**base, **{k: v for k, v in choice.items() if k != "extends"}}
            spec.setdefault("id", "custom")
        else:
            raise LifecycleError("lifecycle must be a built-in name or an object")
        spec = validate_lifecycle(spec)
    except LifecycleError as error:
        source.update(path=path, error=f"task-board.json ignored: {error}")
        return fallback, source
    except Exception as error:  # a config of a shape nothing here expects must not take the board down
        source.update(path=path, error=f"task-board.json ignored: {error.__class__.__name__}")
        return fallback, source
    source.update({"from": "home-config", "path": path})
    return spec, source


def _matches(when: dict, facts: dict) -> bool:
    for fact, expected in when.items():
        have = facts.get(fact)
        if isinstance(expected, list):
            if have not in expected:
                return False
        elif isinstance(expected, str):
            if have != expected:
                return False
        elif bool(have) != expected:
            return False
    return True


def place(lifecycle: dict, stage: str, facts: dict) -> str:
    """The column id for a task. `stage` is needs | done | parked | queued | active."""
    ids = {c["id"] for c in lifecycle["columns"]}
    if stage in ("needs", "done"):
        return stage
    if stage in ("parked", "queued"):
        return stage if stage in ids else lifecycle["default"]
    for rule in lifecycle["place"]:
        if _matches(rule["when"], facts):
            return rule["col"]
    return lifecycle["default"]
