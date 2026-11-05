"""Tests for what every page build leaves beside the reader page for the lite page and for a native client: out/live/ (the lite page, its
index, one object for each conversation, the list of the markdown files those name) and out/glance.json (build_prototype's section on
them, written by both build paths).

Run from the repo root: python3 -m unittest setup/transcript-reader/test_live.py
The fixtures are test_cache's: synthetic logs and fleet records in a temporary folder, Herdr faked. Nothing real is read.
(test_cache.Writing compares every file the plain build and the kept-conversation build write, these included, byte for byte.)
"""

import hashlib
import json
import os
import re
import stat
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "prototype"))
import build_cache  # noqa: E402
from reader import builder  # noqa: E402
from test_cache import Case  # noqa: E402
from test_sync import A, M, W, T0 as LAB_T0, append_log, say, user  # noqa: E402


class Gist(unittest.TestCase):
    def test_the_marks_that_only_shape_a_reply_are_dropped_and_the_lines_joined(self):
        text = "# Heading\n\n> quoted\n\n- **First** point with `code`\n2. Second  point\n\n   \nThe end."
        self.assertEqual(builder.gist(text, 200), "Heading quoted First point with code Second point The end.")

    def test_a_long_one_is_clipped_with_an_ellipsis_within_the_limit(self):
        clipped = builder.gist("word " * 100, 40)
        self.assertEqual(len(clipped), 40)
        self.assertTrue(clipped.endswith("…"))
        self.assertEqual(builder.gist("short", 40), "short")
        self.assertEqual(builder.gist("", 40), "")
        self.assertEqual(builder.gist(None, 40), "")


class Live(Case):
    def setUp(self):
        super().setUp()
        self.out = self.lab.root / "out" / "prototype.html"
        self.live = self.out.parent / "live"
        # What this process remembers of a folder is the point of some tests, and a fresh folder each time must start from nothing.
        builder._LIVE_WRITTEN.clear()
        self.addCleanup(builder._LIVE_WRITTEN.clear)

    def write(self, derived=None):
        builder._LOG_INDEX.clear()
        built = self.same(derived=derived)
        self.assertTrue(build_cache.write(built, self.out))
        return built

    def index(self):
        return json.loads((self.live / "index.json").read_text(encoding="utf-8"))

    def glance(self):
        return json.loads((self.out.parent / "glance.json").read_text(encoding="utf-8"))

    def object(self, sid):
        return json.loads((self.live / "s" / f"{sid}.json").read_text(encoding="utf-8"))

    def mtimes(self):
        """The lite page's files, the glance and the page with its stamp: what these tests are about (a build also rewrites the pane cache and the lists of files)."""
        return {str(path.relative_to(self.out.parent)): path.stat().st_mtime_ns for path in sorted(self.out.parent.rglob("*"))
                if path.is_file() and (path.parent.name in ("live", "s") or path.name in ("glance.json", "prototype.html", "prototype.stamp"))}

    def restart(self):
        """A new process: it remembers nothing it wrote or kept, and the page it wrote is on disk."""
        builder._LIVE_WRITTEN.clear()
        build_cache._WRITTEN.clear()
        build_cache._THREADS.clear()
        build_cache._TASKS.clear()

    # ------------------------------------------------------------------------------------------------ what is written

    def test_a_build_writes_the_lite_page_its_index_one_object_for_each_conversation_and_the_glance(self):
        self.write(derived=[A, W, M])
        names = sorted(str(path.relative_to(self.live)) for path in self.live.rglob("*") if path.is_file())
        self.assertEqual(names, sorted(["index.html", "index.json", "md-files.json", *(f"s/{sid}.json" for sid in (A, W, M))]))
        self.assertTrue((self.out.parent / "glance.json").is_file())

    def test_the_lite_page_is_the_reader_page_in_its_live_mode_and_the_index_names_its_template(self):
        self.write(derived=[A, W, M])
        page = (self.live / "index.html").read_text(encoding="utf-8")
        self.assertIn('const MODE = "live";', page)
        self.assertIn('<script id="payload" type="application/json">null</script>', page)
        self.assertIn("const hosted = (() => {", page, "it loads one conversation at a time with the hosted loader")
        self.assertNotIn("const hosted = null;", page)
        self.assertEqual(re.search(r'<meta name="template" content="([^"]*)">', page).group(1), self.index()["template"],
                         "so a page that finds a newer index than its own code reloads")
        self.assertNotIn("Plan the login fix", page, "no transcript in it")
        local, _ = builder.fill_template(builder.TEMPLATE, "null", "local")
        self.assertIn("const hosted = null;", local)

    def test_the_index_is_the_hosted_indexs_shape_newest_activity_first_with_the_pane_as_of_the_build(self):
        self.write(derived=[A, W, M])
        index = self.index()
        orders = [entry["order"] for entry in index["conversations"]]
        self.assertEqual(orders, sorted(orders, reverse=True))
        alpha = index["conversations"][0]
        self.assertEqual(alpha["id"], A)
        self.assertEqual((alpha["pane"]["label"], alpha["pane"]["status"], alpha["pane"]["live"], alpha["reopened"]), ("alpha", "working", True, False))
        self.assertEqual((alpha["needs"], alpha["turns"], alpha["last"]), (2, 3, LAB_T0 + 670), "two asks since your last message")
        self.assertEqual(alpha["object"], f"s/{A}.json")
        self.assertEqual(index["as_of"], float((self.out.parent / "prototype.stamp").read_text(encoding="utf-8")), "the build time, which is the page's own stamp")
        self.assertEqual((index["fleet_timeline"], index["weeks"], index["documents"], index["closed"], index["live"]), (False, {}, {}, [], True))
        self.assertEqual(index["homes"], ["main", "secondmate-mate"])

    def test_an_objects_stamp_is_the_hash_of_its_bytes(self):
        self.write(derived=[A, W, M])
        for entry in self.index()["conversations"]:
            data = (self.live / entry["object"]).read_bytes()
            self.assertEqual(entry["stamp"], hashlib.sha1(data).hexdigest()[:16], entry["id"])

    def test_an_object_is_the_conversations_entry_in_the_page_without_its_pane_and_with_the_files_it_names(self):
        built = self.write(derived=[A, W, M])
        payload = json.loads(b"".join(built.payload))
        for session in payload["sessions"]:
            made = self.object(session["id"])
            expected = {key: value for key, value in session.items() if key not in ("pane", "reopened")}
            self.assertEqual({key: value for key, value in made.items() if key != "documents"}, expected, session["id"])
            self.assertEqual(list(made)[-1], "documents")
        # The file A names comes as a record without its text, listed to open through the server as it is on disk.
        [(doc_id, record)] = self.object(A)["documents"].items()
        self.assertEqual((record["name"], record["lazy"], "text" in record), ("notes.md", True, False))
        self.assertEqual(json.loads((self.live / "md-files.json").read_text(encoding="utf-8")), {doc_id: str(self.lab.main / "notes.md")})
        self.assertEqual(payload["documents"][doc_id]["text"], "# Notes\n\nThe plan.\n", "the page itself still holds the text")
        self.assertEqual(self.object(W)["documents"], {})

    def test_a_picture_or_a_page_a_reply_names_keeps_its_kind_and_is_not_listed_for_md_open(self):
        picture = self.lab.main / "shot.png"
        picture.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 32)
        sketch = self.lab.main / "sketch.html"
        sketch.write_text("<p>sketch</p>", encoding="utf-8")
        append_log(self.lab.logs[A], [user("Show me.", LAB_T0 + 800, self.main), say("See `shot.png` and `sketch.html`.", LAB_T0 + 810, self.main)])
        self.newer(self.lab.logs[A])
        self.write(derived=[A, W, M])
        records = self.object(A)["documents"]
        kinds = {record["name"]: (record.get("kind"), record.get("lazy"), "text" in record) for record in records.values()}
        self.assertEqual(kinds, {"notes.md": (None, True, False), "shot.png": ("image", None, False), "sketch.html": ("html", None, False)})
        self.assertEqual(sorted(Path(path).name for path in json.loads((self.live / "md-files.json").read_text(encoding="utf-8")).values()), ["notes.md"])
        self.assertEqual(list(records), sorted(records), "in id order, so two builds agree")

    def test_the_files_are_the_owners_alone(self):
        self.write(derived=[A, W, M])
        paths = [path for path in [*self.live.rglob("*"), self.out.parent / "glance.json"]]
        self.assertTrue(paths)
        for path in paths:
            mode = stat.S_IMODE(path.stat().st_mode)
            self.assertEqual(mode & 0o077, 0, f"{path.name} {oct(mode)}")

    # ----------------------------------------------------------------------------------------- what a rebuild leaves alone

    def test_a_reply_in_one_conversation_writes_that_conversations_object_and_no_other(self):
        self.write(derived=[A, W, M])
        before = self.mtimes()
        time.sleep(0.02)
        append_log(self.lab.logs[M], [user("And the notes?", LAB_T0 + 800, str(self.lab.mate)), say("Fine too. Anything else you need from me?", LAB_T0 + 810, str(self.lab.mate))])
        self.newer(self.lab.logs[M])
        self.write(derived=[M])
        after = self.mtimes()
        changed = sorted(name for name in after if before.get(name) != after[name])
        self.assertEqual(changed, sorted(["glance.json", "live/index.json", "live/md-files.json", "prototype.html", "prototype.stamp", f"live/s/{M}.json"]),
                         "the one object, the index, the listing, the glance and the page: no other conversation's object")
        self.assertIn("Anything else you need", self.object(M)["exchanges"][-1]["reply"])
        entry = next(e for e in self.index()["conversations"] if e["id"] == M)
        self.assertEqual(entry["stamp"], hashlib.sha1((self.live / f"s/{M}.json").read_bytes()).hexdigest()[:16])

    def test_a_build_that_changes_nothing_a_page_shows_writes_nothing(self):
        self.write(derived=[A, W, M])
        before = self.mtimes()
        time.sleep(0.02)
        self.write(derived=[])
        self.assertEqual(self.mtimes(), before)

    def test_what_herdr_says_changes_the_index_and_the_glance_but_no_object(self):
        self.write(derived=[A, W, M])
        before = self.mtimes()
        stamps = {entry["id"]: entry["stamp"] for entry in self.index()["conversations"]}
        time.sleep(0.02)
        self.lab.panes[A] = {**self.lab.panes[A], "status": "idle"}
        self.write(derived=[])
        self.assertEqual({entry["id"]: entry["stamp"] for entry in self.index()["conversations"]}, stamps, "an object carries no pane, so its stamp stays")
        after = self.mtimes()
        self.assertEqual(sorted(name for name in after if before.get(name) != after[name]), sorted(["glance.json", "live/index.json", "live/md-files.json", "prototype.html", "prototype.stamp"]))
        self.assertEqual(self.index()["conversations"][0]["pane"]["status"], "idle")
        self.assertEqual(self.glance()["conversations"][0]["pane"]["status"], "idle")

    def test_a_restarted_worker_does_not_write_every_object_again(self):
        self.write(derived=[A, W, M])
        before = {name: value for name, value in self.mtimes().items() if name.startswith("live/s/")}
        self.restart()
        time.sleep(0.02)
        self.write(derived=[A, W, M])
        self.assertEqual({name: value for name, value in self.mtimes().items() if name.startswith("live/s/")}, before)

    def test_an_object_that_is_gone_is_written_again_and_one_no_conversation_has_is_removed(self):
        self.write(derived=[A, W, M])
        (self.live / "s" / f"{W}.json").unlink()
        stale = self.live / "s" / "gone.json"
        stale.write_text("{}", encoding="utf-8")
        partial = self.live / "s" / ".x.json.1.partial"
        partial.write_text("{", encoding="utf-8")
        append_log(self.lab.logs[A], [user("Again.", LAB_T0 + 800, self.main), say("Done.", LAB_T0 + 810, self.main)])
        self.newer(self.lab.logs[A])
        self.write(derived=[A])
        self.assertTrue((self.live / "s" / f"{W}.json").is_file())
        self.assertFalse(stale.exists())
        self.assertFalse(partial.exists())

    def test_the_live_folder_taken_away_is_written_again_though_the_page_is_the_same(self):
        self.write(derived=[A, W, M])
        for path in sorted(self.live.rglob("*"), reverse=True):
            path.unlink() if path.is_file() else path.rmdir()
        builder._LIVE_WRITTEN.clear()
        self.write(derived=[])
        self.assertTrue((self.live / "index.json").is_file())
        self.assertEqual(len(list((self.live / "s").glob("*.json"))), 3)

    def test_the_lite_pages_files_are_written_before_the_stamp_a_waiting_page_wakes_on(self):
        order = []
        real = builder.write_pieces

        def spy(target, pieces):
            order.append(target.name)
            return real(target, pieces)
        with mock.patch.object(builder, "write_pieces", spy):
            self.write(derived=[A, W, M])
        self.assertGreater(order.index("index.json"), max(order.index(f"{sid}.json") for sid in (A, W, M)), "the index, which names each object's stamp, follows the objects")
        self.assertEqual(self.index()["as_of"], float((self.out.parent / "prototype.stamp").read_text(encoding="utf-8")))
        newest_live = max(path.stat().st_mtime_ns for path in self.live.rglob("*") if path.is_file())
        self.assertGreaterEqual((self.out.parent / "prototype.stamp").stat().st_mtime_ns, newest_live, "the stamp is the last file written")

    # --------------------------------------------------------------------------------------------------- the glance feed

    def test_the_glance_is_one_record_for_each_listed_conversation_newest_first(self):
        self.write(derived=[A, W, M])
        feed = self.glance()
        self.assertEqual(feed["version"], 1)
        self.assertEqual(feed["as_of"], self.index()["as_of"])
        self.assertEqual([c["id"] for c in feed["conversations"]], [e["id"] for e in self.index()["conversations"]])
        alpha = feed["conversations"][0]
        self.assertEqual(sorted(alpha), sorted(["id", "ids", "home", "where", "last", "turns", "message", "reply", "open_asks", "ask", "pane"]))
        self.assertEqual((alpha["id"], alpha["home"], alpha["turns"], alpha["last"]), (A, "main", 3, LAB_T0 + 670))
        self.assertEqual(alpha["pane"], {"label": "alpha", "herdr": "lab", "status": "working", "live": True})

    def test_the_glance_holds_the_gist_of_your_last_message_and_of_the_last_reply(self):
        self.write(derived=[A, W, M])
        alpha = self.glance()["conversations"][0]
        # The lab's conversation: the last turn is a wake-up whose reply asks; your last message is the plan request.
        self.assertEqual(alpha["message"], {"at": LAB_T0, "text": "Plan the login fix."})
        self.assertEqual(alpha["reply"]["text"], "The worker needs a layout. Which one do you want?")
        self.assertEqual(alpha["reply"]["at"], LAB_T0 + 670)
        self.assertEqual(alpha["reply"]["words"], 10)

    def test_the_glance_names_how_many_asks_are_open_and_the_first_lines_of_the_newest_one(self):
        self.write(derived=[A, W, M])
        alpha = self.glance()["conversations"][0]
        self.assertEqual(alpha["open_asks"], 2)
        self.assertEqual(alpha["ask"], {"at": LAB_T0 + 670, "lines": ["The worker needs a layout. Which one do you want?"]})
        worker = next(c for c in self.glance()["conversations"] if c["id"] == W)
        self.assertEqual((worker["open_asks"], worker["ask"]), (0, None))
        self.assertEqual(worker["pane"], None, "no Herdr pane was seen for it")

    def test_an_ask_of_several_lines_gives_at_most_three_and_each_is_clipped(self):
        self.write(derived=[A, W, M])
        long_line = "Should I use the first or the second layout for the settings page, " + "and why " * 40 + "?"
        reply = f"{long_line}\nOne more question: do you want tests?\nAnd another: should I open a PR?\nAnd a fourth: when?\nNot an ask."
        append_log(self.lab.logs[M], [user("Details?", LAB_T0 + 800, str(self.lab.mate)), say(reply, LAB_T0 + 810, str(self.lab.mate))])
        self.newer(self.lab.logs[M])
        self.write(derived=[M])
        mate = next(c for c in self.glance()["conversations"] if c["id"] == M)
        self.assertEqual(len(mate["ask"]["lines"]), 3)
        self.assertLessEqual(len(mate["ask"]["lines"][0]), 200)
        self.assertTrue(mate["ask"]["lines"][0].endswith("…"))
        self.assertEqual(mate["ask"]["lines"][1], "One more question: do you want tests?")

    def test_an_answered_ask_is_not_open(self):
        append_log(self.lab.logs[A], [user("Use the left layout.", LAB_T0 + 800, self.main), say("Doing that now.", LAB_T0 + 810, self.main)])
        self.newer(self.lab.logs[A])
        self.write(derived=[A, W, M])
        alpha = self.glance()["conversations"][0]
        self.assertEqual((alpha["open_asks"], alpha["ask"]), (0, None))
        self.assertEqual(alpha["message"]["text"], "Use the left layout.")
        self.assertEqual(self.index()["conversations"][0]["needs"], 0)

    def test_the_glance_is_written_only_when_it_changes_and_a_restart_does_not_rewrite_it(self):
        self.write(derived=[A, W, M])
        feed = self.out.parent / "glance.json"
        first = (feed.stat().st_mtime_ns, feed.read_bytes())
        time.sleep(0.02)
        self.restart()
        self.write(derived=[A, W, M])
        self.assertEqual((feed.stat().st_mtime_ns, feed.read_bytes()), first, "the same gist and panes: the file a native client watches is left as it was")
        self.lab.panes[A] = {**self.lab.panes[A], "status": "idle"}
        time.sleep(0.02)
        self.write(derived=[])
        self.assertNotEqual(feed.read_bytes(), first[1])
        self.assertEqual(self.glance()["conversations"][0]["pane"]["status"], "idle")

    def test_the_glance_carries_no_more_of_a_conversation_than_the_gists(self):
        self.write(derived=[A, W, M])
        feed = (self.out.parent / "glance.json").read_text(encoding="utf-8")
        self.assertNotIn("tool", feed)
        self.assertNotIn(str(self.lab.projects), feed, "no log path")
        self.assertLess(len(feed), 10000)

    # ------------------------------------------------------------------------------------------------ the plain build too

    def test_the_plain_build_writes_the_same_files_as_a_hand_run(self):
        """build_prototype.write_page (a hand run, or a worker whose calls cannot be recorded) writes the lite page's files as the kept build does."""
        plain = self.lab.root / "plain" / "prototype.html"
        with builder.chains_frozen():
            builder.write_page(builder.TEMPLATE, builder.build(self.args(out=plain)), plain)
        names = sorted(str(path.relative_to(plain.parent)) for path in plain.parent.rglob("*") if path.is_file() and not path.name.endswith(".lock") and "parsed" not in path.parts)
        self.assertIn("glance.json", names)
        self.assertIn("live/index.html", names)
        self.assertIn("live/index.json", names)
        self.assertEqual(sum(name.startswith("live/s/") for name in names), 3)

    def test_a_template_that_is_not_the_reader_page_writes_no_lite_page(self):
        template = self.lab.root / "t.html"
        template.write_text("<script>x</script>__PAYLOAD__", encoding="utf-8")
        out = self.lab.root / "sheet" / "q.html"
        builder.write_page(template, {"generated": 1.0, "sessions": [], "documents": {}}, out)
        self.assertFalse((out.parent / "live").exists())
        self.assertFalse((out.parent / "glance.json").exists())


if __name__ == "__main__":
    unittest.main()
