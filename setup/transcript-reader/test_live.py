"""Tests for what every page build leaves beside the reader page for the lite page and for a native client: out/live/ (the lite page, its
index, one object for each conversation, the list of the markdown files those name, the answer sheet and one object for each conversation
that has one) and out/glance.json (build_prototype's section on
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
                if path.is_file() and (path.parent.name in ("live", "s", "a") or path.name in ("glance.json", "prototype.html", "prototype.stamp"))}

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
        self.assertEqual(names, sorted(["embed.html", "index.html", "index.json", "md-files.json", "sheet.html", f"a/{M}.json", *(f"s/{sid}.json" for sid in (A, W, M))]),
                         "the answer sheet has an object only for the conversation whose reply asks for keyed answers")
        self.assertTrue((self.out.parent / "glance.json").is_file())

    def test_the_embed_page_is_the_reader_page_in_its_embed_mode_with_no_transcript_no_token_and_no_way_out(self):
        """A host's web view (Conn's) loads out/live/embed.html and hands it a conversation of its own: the page holds none of the reader's
        transcripts, carries no token, and its content policy allows no connection, frame or image (README, "The embed page")."""
        self.write(derived=[A, W, M])
        page = (self.live / "embed.html").read_text(encoding="utf-8")
        self.assertIn('const MODE = "embed";', page)
        self.assertIn("const hosted = null;", page, "it asks no laptop and loads no object")
        self.assertIn("const embedModel = (() => {", page, "embed.js is in it")
        self.assertNotIn("Plan the login fix", page, "no transcript in it")
        self.assertNotIn('<meta name="reader-token"', page, "no token slot for the server to fill, whatever address the page is opened from")
        policy = re.search(r'http-equiv="Content-Security-Policy" content="([^"]*)"', page).group(1)
        for rule in ("default-src 'none'", "connect-src 'none'", "frame-src 'none'", "img-src 'none'", "form-action 'none'"):
            self.assertIn(rule, policy)
        self.assertNotIn("connect-src 'self'", policy)
        self.assertEqual(page.count('<script id="payload"'), 1)
        payload = re.search(r'<script id="payload" type="application/json">(.*?)</script>', page, re.S).group(1)
        self.assertEqual(json.loads(payload)["sessions"], [], "the reading list is empty: the host's conversation comes through window.readerEmbed")
        self.assertEqual(re.search(r'<meta name="template" content="([^"]*)">', page).group(1), builder.embed_shell()[1])

    def test_the_embed_page_is_written_once_and_again_only_when_the_code_changes(self):
        self.write(derived=[A, W, M])
        target = self.live / "embed.html"
        before = target.stat().st_mtime_ns
        time.sleep(0.02)
        self.write(derived=[])
        self.assertEqual(target.stat().st_mtime_ns, before, "a rebuild leaves it alone")
        self.restart()
        time.sleep(0.02)
        self.write(derived=[A, W, M])
        self.assertEqual(target.stat().st_mtime_ns, before, "and so does a restarted worker, which finds the same bytes on disk")

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
                         "the one object, the index, the listing, the glance and the page: no other conversation's object, and no sheet (it asked nothing new)")
        self.assertIn("Anything else you need", self.object(M)["exchanges"][-1]["reply"])
        entry = next(e for e in self.index()["conversations"] if e["id"] == M)
        self.assertEqual(entry["stamp"], hashlib.sha1((self.live / f"s/{M}.json").read_bytes()).hexdigest()[:16])

    def test_a_build_that_changes_nothing_a_page_shows_writes_nothing(self):
        self.write(derived=[A, W, M])
        before = self.mtimes()
        time.sleep(0.02)
        self.write(derived=[])
        self.assertEqual(self.mtimes(), before)

    def test_what_herdr_says_changes_the_index_but_no_object_and_not_the_glance_unless_a_pane_comes_or_goes(self):
        self.write(derived=[A, W, M])
        before = self.mtimes()
        stamps = {entry["id"]: entry["stamp"] for entry in self.index()["conversations"]}
        time.sleep(0.02)
        self.lab.panes[A] = {**self.lab.panes[A], "status": "idle"}
        self.write(derived=[])
        self.assertEqual({entry["id"]: entry["stamp"] for entry in self.index()["conversations"]}, stamps, "an object carries no pane, so its stamp stays")
        after = self.mtimes()
        self.assertEqual(sorted(name for name in after if before.get(name) != after[name]), sorted(["live/index.json", "live/md-files.json", "prototype.html", "prototype.stamp"]),
                         "the glance holds no pane state: a Herdr state change leaves the file a client watches alone")
        self.assertEqual(self.index()["conversations"][0]["pane"]["status"], "idle")
        time.sleep(0.02)
        self.lab.panes[A] = {**self.lab.panes[A], "label": "renamed"}
        self.write(derived=[])
        self.assertEqual(self.glance()["conversations"][0]["pane"]["label"], "renamed")

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
        self.assertEqual(sorted(alpha), sorted(["id", "ids", "home", "where", "last", "open_asks", "ask", "pane"]), "what a list of open asks needs, and no gist of the talk")
        self.assertEqual((alpha["id"], alpha["home"], alpha["last"]), (A, "main", LAB_T0 + 670))
        self.assertEqual(alpha["pane"], {"label": "alpha", "herdr": "lab", "live": True}, "which pane it is, not what the pane is doing")

    def test_the_glance_names_how_many_asks_are_open_and_the_first_lines_of_the_newest_one(self):
        self.write(derived=[A, W, M])
        alpha = self.glance()["conversations"][0]
        self.assertEqual(alpha["open_asks"], 2)
        self.assertEqual((alpha["ask"]["at"], alpha["ask"]["lines"]), (LAB_T0 + 670, ["The worker needs a layout. Which one do you want?"]))
        worker = next(c for c in self.glance()["conversations"] if c["id"] == W)
        self.assertEqual((worker["open_asks"], worker["ask"]), (0, None))
        self.assertEqual(worker["pane"], None, "no Herdr pane was seen for it")

    def test_the_ask_names_its_turn_so_a_list_can_open_the_conversation_on_it(self):
        self.write(derived=[A, W, M])
        alpha = self.glance()["conversations"][0]
        turn = next(e for e in self.object(A)["exchanges"] if (e["reply_at"] or e["at"]) == alpha["ask"]["at"])
        self.assertEqual(alpha["ask"]["uid"], turn["uid"])
        self.assertRegex(alpha["ask"]["uid"], r"^[0-9A-Za-z_-]{6,64}$", "the form the page's #s=<id>&m=<turn> address takes")

    def test_the_ask_carries_the_tags_a_list_shows_beside_it_the_sheets_size_and_the_asks_before_it(self):
        self.write(derived=[A, W, M])
        feed = {c["id"]: c for c in self.glance()["conversations"]}
        self.assertEqual(feed[A]["ask"]["tags"], ["+1 earlier"], "two asks are open: the newest one's tag counts the other")
        self.assertEqual(feed[M]["ask"]["tags"], ["Answer sheet · 2 questions"], "a reply that opens a sheet says how many questions it asks, and nothing is before it")
        self.assertEqual(feed[W]["ask"], None)
        reply = "Which colour do you want for the notes?"
        append_log(self.lab.logs[M], [user("Details?", LAB_T0 + 800, str(self.lab.mate)), say(reply, LAB_T0 + 810, str(self.lab.mate))])
        self.newer(self.lab.logs[M])
        self.write(derived=[M])
        mate = next(c for c in self.glance()["conversations"] if c["id"] == M)
        self.assertEqual(mate["ask"]["tags"], [], "your message after the sheet's reply closed it, so the new ask is alone and says no more than its lines")

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
        self.assertEqual(self.index()["conversations"][0]["needs"], 0)

    def test_the_glance_is_written_only_when_it_changes_and_a_restart_does_not_rewrite_it(self):
        self.write(derived=[A, W, M])
        feed = self.out.parent / "glance.json"
        first = (feed.stat().st_mtime_ns, feed.read_bytes())
        time.sleep(0.02)
        self.restart()
        self.write(derived=[A, W, M])
        self.assertEqual((feed.stat().st_mtime_ns, feed.read_bytes()), first, "the same asks and panes: the file a native client watches is left as it was")
        self.lab.panes[A] = {**self.lab.panes[A], "label": "renamed"}
        time.sleep(0.02)
        self.write(derived=[])
        self.assertNotEqual(feed.read_bytes(), first[1])
        self.assertEqual(self.glance()["conversations"][0]["pane"]["label"], "renamed")

    def test_the_glance_carries_no_more_of_a_conversation_than_its_asks(self):
        self.write(derived=[A, W, M])
        feed = (self.out.parent / "glance.json").read_text(encoding="utf-8")
        self.assertNotIn("tool", feed)
        self.assertNotIn(str(self.lab.projects), feed, "no log path")
        self.assertLess(len(feed), 10000)

    # ----------------------------------------------------------------------------------------------------- the answer sheet

    def sheet_index(self):
        return self.index()["sheets"]

    def test_a_conversation_whose_reply_asks_for_keyed_answers_has_a_sheet_the_index_lists(self):
        self.write(derived=[A, W, M])
        sheets = self.sheet_index()
        self.assertEqual(list(sheets), [M], "only the conversation that asks for keyed answers has one")
        entry = sheets[M]
        data = (self.live / "a" / f"{M}.json").read_bytes()
        self.assertEqual(entry["object"], f"a/{M}.json")
        self.assertEqual(entry["stamp"], hashlib.sha1(data).hexdigest()[:16], "the stamp is the hash of the object's bytes, as a conversation's is")
        self.assertEqual(entry["list"], [{"at": LAB_T0 + 44, "open": 2, "title": "Two choices for the notes:"}], "the picker's line: when it was asked, how many cards are open, its title")
        made = json.loads(data)
        [questionnaire] = made["questionnaires"]
        self.assertEqual([card["key"] for card in questionnaire["cards"]], ["A1", "A2"])
        self.assertEqual((questionnaire["session"], questionnaire["sent"], questionnaire["at"]), (M, {}, LAB_T0 + 44))
        self.assertIn("Reply with: A1=...; A2=...", questionnaire["reply"])

    def test_the_sheet_is_what_the_local_sheet_and_the_hosted_copy_collect_for_the_conversation(self):
        from build_questionnaire import chain_questionnaires
        self.write(derived=[A, W, M])
        found = chain_questionnaires(builder.session_chain(self.lab.logs[M]), self.out.parent / "parsed")
        self.assertEqual(json.loads((self.live / "a" / f"{M}.json").read_text(encoding="utf-8")), json.loads(builder.payload_json({"questionnaires": found})))

    def test_the_lite_sheet_is_the_sheets_page_in_its_live_mode_and_the_index_names_its_template(self):
        self.write(derived=[A, W, M])
        page = (self.live / "sheet.html").read_text(encoding="utf-8")
        self.assertIn('const MODE = "live";', page)
        self.assertIn("const hosted = (() => {", page, "it loads one conversation's sheet at a time with the hosted loader")
        self.assertEqual(re.search(r'<meta name="template" content="([^"]*)">', page).group(1), self.index()["sheet_template"], "so a sheet that finds a newer index than its own code reloads")
        self.assertNotEqual(self.index()["sheet_template"], self.index()["template"], "it is a page of its own")
        self.assertNotIn("Keep the intro", page, "no transcript in it")
        self.assertIn('content="__READER_TOKEN__"', page, "the server fills the token in when it serves the page")

    def test_an_answer_sent_in_the_session_changes_that_sheet_and_its_conversation_and_nothing_else(self):
        self.write(derived=[A, W, M])
        before = self.mtimes()
        time.sleep(0.02)
        append_log(self.lab.logs[M], [user("A1=keep;A2=short", LAB_T0 + 800, str(self.lab.mate)), say("Thanks, applying.", LAB_T0 + 810, str(self.lab.mate))])
        self.newer(self.lab.logs[M])
        self.write(derived=[M])
        after = self.mtimes()
        self.assertEqual(sorted(name for name in after if before.get(name) != after[name]),
                         sorted(["glance.json", "live/index.json", "live/md-files.json", "prototype.html", "prototype.stamp", f"live/s/{M}.json", f"live/a/{M}.json"]),
                         "the conversation's object and its sheet, the index, the glance and the page: no other conversation's")
        [questionnaire] = json.loads((self.live / "a" / f"{M}.json").read_text(encoding="utf-8"))["questionnaires"]
        self.assertEqual(questionnaire["sent"], {"A1": "keep", "A2": "short"})
        self.assertEqual(self.sheet_index()[M]["list"][0]["open"], 0, "answered: no card is open")
        self.assertEqual(self.sheet_index()[M]["stamp"], hashlib.sha1((self.live / "a" / f"{M}.json").read_bytes()).hexdigest()[:16])

    def test_a_reply_that_asks_nothing_keyed_leaves_the_sheet_as_it_was(self):
        self.write(derived=[A, W, M])
        stamp = self.sheet_index()[M]["stamp"]
        before = self.mtimes()[f"live/a/{M}.json"]
        time.sleep(0.02)
        append_log(self.lab.logs[M], [user("And the notes?", LAB_T0 + 800, str(self.lab.mate)), say("Fine too. Anything else you need from me?", LAB_T0 + 810, str(self.lab.mate))])
        self.newer(self.lab.logs[M])
        self.write(derived=[M])
        self.assertEqual((self.sheet_index()[M]["stamp"], self.mtimes()[f"live/a/{M}.json"]), (stamp, before))

    def test_a_restarted_worker_does_not_write_every_sheet_again_and_a_sheet_taken_away_is_written_again(self):
        self.write(derived=[A, W, M])
        before = self.mtimes()[f"live/a/{M}.json"]
        self.restart()
        time.sleep(0.02)
        self.write(derived=[A, W, M])
        self.assertEqual(self.mtimes()[f"live/a/{M}.json"], before)
        (self.live / "a" / f"{M}.json").unlink()
        append_log(self.lab.logs[A], [user("Again.", LAB_T0 + 800, self.main), say("Done.", LAB_T0 + 810, self.main)])
        self.newer(self.lab.logs[A])
        self.write(derived=[A])
        self.assertTrue((self.live / "a" / f"{M}.json").is_file())

    def test_a_sheet_no_conversation_has_is_removed(self):
        self.write(derived=[A, W, M])
        stale = self.live / "a" / "gone.json"
        stale.write_text("{}", encoding="utf-8")
        partial = self.live / "a" / ".x.json.1.partial"
        partial.write_text("{", encoding="utf-8")
        append_log(self.lab.logs[A], [user("Again.", LAB_T0 + 800, self.main), say("Done.", LAB_T0 + 810, self.main)])
        self.newer(self.lab.logs[A])
        self.write(derived=[A])
        self.assertFalse(stale.exists())
        self.assertFalse(partial.exists())
        self.assertEqual(sorted(path.name for path in (self.live / "a").iterdir()), [f"{M}.json"])

    def test_the_sheets_files_are_written_before_the_index_that_names_them(self):
        order = []
        real = builder.write_pieces

        def spy(target, pieces):
            order.append(target.name)
            return real(target, pieces)
        with mock.patch.object(builder, "write_pieces", spy):
            self.write(derived=[A, W, M])
        self.assertGreater(order.index("index.json"), order.index(f"{M}.json"))
        self.assertGreater(order.index("index.json"), order.index("sheet.html"))

    def test_the_sheet_of_a_pane_cleared_with_clear_is_the_chains_under_the_newest_session(self):
        from test_cache import CLEAR
        from test_sync import write_log
        self.write(derived=[A, W, M])
        new = "eeeeeeee-5555-4555-8555-555555555555"
        clear = {"type": "user", "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(LAB_T0 + 701)), "cwd": self.main, "message": {"role": "user", "content": CLEAR}}
        sheet = "Which layout?\n\n| ID | Question | Answer |\n| --- | --- | --- |\n| B1 | Layout | `left` / `right` |\n\nReply with: B1=..."
        write_log(self.lab.projects / "main" / f"{new}.jsonl", [clear, user("Carry on.", LAB_T0 + 720, self.main), say(sheet, LAB_T0 + 730, self.main)], LAB_T0 + 740)
        self.write(derived=[new])
        self.assertIn(new, self.sheet_index(), "the chain's newest session names the conversation, and its sheet")
        self.assertNotIn(A, self.sheet_index())
        [questionnaire] = json.loads((self.live / "a" / f"{new}.json").read_text(encoding="utf-8"))["questionnaires"]
        self.assertEqual((questionnaire["session"], [card["key"] for card in questionnaire["cards"]]), (new, ["B1"]))

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
        self.assertIn("live/sheet.html", names)
        self.assertIn("live/embed.html", names)
        self.assertEqual(sum(name.startswith("live/s/") for name in names), 3)
        self.assertEqual([name for name in names if name.startswith("live/a/")], [f"live/a/{M}.json"])

    def test_a_conversations_agent_is_in_its_object_where_the_page_has_it_in_both_build_paths(self):
        """A Copilot session carries `agent` after its turns and before its leader (thread_session); the object keeps it, as the page does."""
        real = builder.thread_session

        def tagged(home, chain, loaded, parent):
            session = real(home, chain, loaded, parent)
            if session["id"] == A:
                leader = session.pop("leader", None)
                session["agent"] = "copilot"
                if leader:
                    session["leader"] = leader
            return session
        stamp = time.time()
        plain, cached = self.lab.root / "plain" / "prototype.html", self.lab.root / "cached" / "prototype.html"
        with mock.patch.object(builder, "thread_session", tagged), mock.patch("time.time", lambda: stamp), builder.chains_frozen():
            builder.write_page(builder.TEMPLATE, builder.build(self.args(out=plain)), plain)
            build_cache.write(build_cache.build(self.args(out=cached)), cached)
        one, other = (folder.parent / "live" / "s" / f"{A}.json" for folder in (plain, cached))
        self.assertEqual(one.read_bytes(), other.read_bytes())
        made = json.loads(one.read_text(encoding="utf-8"))
        self.assertEqual(made["agent"], "copilot")
        self.assertLess(list(made).index("exchanges"), list(made).index("agent"))
        self.assertLess(list(made).index("agent"), list(made).index("documents"))

    def test_a_template_that_is_not_the_reader_page_writes_no_lite_page(self):
        template = self.lab.root / "t.html"
        template.write_text("<script>x</script>__PAYLOAD__", encoding="utf-8")
        out = self.lab.root / "sheet" / "q.html"
        builder.write_page(template, {"generated": 1.0, "sessions": [], "documents": {}}, out)
        self.assertFalse((out.parent / "live").exists())
        self.assertFalse((out.parent / "glance.json").exists())


class LiveLeader(Case):
    """A conversation whose working folder is a Firstmate home lists that home's task folders in its lite object, as the page's By task view does."""

    write, index, glance, object, mtimes = Live.write, Live.index, Live.glance, Live.object, Live.mtimes

    def setUp(self):
        super().setUp()
        self.out = self.lab.root / "out" / "prototype.html"
        self.live = self.out.parent / "live"
        builder._LIVE_WRITTEN.clear()
        self.addCleanup(builder._LIVE_WRITTEN.clear)
        (self.lab.main / "projects").mkdir()
        (self.lab.main / "data" / "backlog.md").write_text("## In flight\n- [ ] fix-login - Fix the login page (repo: x)\n", encoding="utf-8")
        self.task = self.lab.main / "data" / "fix-login"
        (self.task / "notes").mkdir(parents=True)
        (self.task / "report.md").write_text("# Report\n", encoding="utf-8")
        (self.task / "notes" / "plan.md").write_text("# Plan\n", encoding="utf-8")
        (self.task / "shot.png").write_bytes(b"\x89PNG")
        (self.task / "sketch.html").write_text("<p>sketch</p>", encoding="utf-8")

    def listed(self, sid):
        return {record["name"]: record for record in self.object(sid)["documents"].values()}

    def test_a_leaders_object_lists_the_files_of_its_homes_task_folders_named_or_not(self):
        self.write(derived=[A, W, M])
        listed = self.listed(A)
        self.assertEqual(sorted(listed), ["notes.md", "plan.md", "report.md", "shot.png", "sketch.html"], "the one it names and each file of the task folder")
        self.assertEqual({name: (record.get("kind"), record.get("lazy")) for name, record in listed.items()},
                         {"notes.md": (None, True), "plan.md": (None, True), "report.md": (None, True), "shot.png": ("image", None), "sketch.html": ("html", None)})
        self.assertTrue(all("text" not in record for record in listed.values()), "none with its text")
        self.assertEqual(list(self.object(A)["documents"]), sorted(self.object(A)["documents"]), "in id order, so two builds agree")
        self.assertEqual(sorted(Path(path).name for path in json.loads((self.live / "md-files.json").read_text(encoding="utf-8")).values()), ["notes.md", "plan.md", "report.md"],
                         "the markdown ones are opened through md-open, as they are on disk now")
        self.assertEqual(self.listed(W), {}, "a worker's copy is no leader's: it lists nothing it does not name")
        self.assertIn("leader", self.object(A), "and its tasks, for the By task view")

    def test_what_a_leader_lists_is_what_the_page_lists_by_task(self):
        """The page's By task list (template.html taskDocuments) is every document whose folder is under <home>/data/ and every one the conversation named."""
        built = self.write(derived=[A, W, M])
        payload = json.loads(b"".join(built.payload))
        session = next(s for s in payload["sessions"] if s["id"] == A)
        root = session["leader"]["dir"] + "/data/"
        named = {doc for e in session["exchanges"] for doc in (*e.get("documents", ()), *e.get("input_documents", ()))}
        expected = sorted(named | {doc for doc, record in payload["documents"].items() if str(record["dir"]).startswith(root)})
        self.assertEqual(sorted(self.object(A)["documents"]), expected)

    def test_a_file_added_to_a_task_folder_changes_the_leaders_object_and_no_other(self):
        self.write(derived=[A, W, M])
        before = self.mtimes()
        stamps = {entry["id"]: entry["stamp"] for entry in self.index()["conversations"]}
        time.sleep(0.02)
        (self.task / "later.md").write_text("# Later\n", encoding="utf-8")
        self.write(derived=[])
        after = self.mtimes()
        self.assertEqual(sorted(name for name in after if before.get(name) != after[name]),
                         sorted(["live/index.json", "live/md-files.json", "prototype.html", "prototype.stamp", f"live/s/{A}.json"]), "the leader's object, the index and the listing: no other conversation's")
        self.assertIn("later.md", self.listed(A))
        self.assertNotEqual({e["id"]: e["stamp"] for e in self.index()["conversations"]}[A], stamps[A])
        (self.task / "later.md").unlink()
        self.write(derived=[])
        self.assertNotIn("later.md", self.listed(A))

    def test_a_file_a_leader_named_that_another_conversation_also_names_is_listed_once(self):
        picture = self.lab.main / "shot2.png"
        picture.write_bytes(b"\x89PNG")
        self.write(derived=[A, W, M])
        self.assertEqual(sorted(self.listed(A)).count("notes.md"), 1)

    def test_the_plain_build_and_the_kept_build_write_the_same_lite_files(self):
        """Both build paths write the leader's object, the sheet, the index, the listing and the glance byte for byte."""
        stamp = time.time()
        plain, cached = self.lab.root / "plain" / "prototype.html", self.lab.root / "cached" / "prototype.html"
        with mock.patch("time.time", lambda: stamp), builder.chains_frozen():
            builder.write_page(builder.TEMPLATE, builder.build(self.args(out=plain)), plain)
            build_cache.write(build_cache.build(self.args(out=cached)), cached)

        def written(folder):
            return {str(path.relative_to(folder.parent)): path.read_bytes() for path in sorted(folder.parent.rglob("*"))
                    if path.is_file() and (path.name == "glance.json" or "live" in path.relative_to(folder.parent).parts)}
        theirs, ours = written(plain), written(cached)
        self.assertEqual(sorted(ours), sorted(theirs))
        for name in theirs:
            self.assertEqual(ours[name], theirs[name], name)
        self.assertIn(f"live/a/{M}.json", ours)
        self.assertIn("live/sheet.html", ours)
        self.assertEqual(len(json.loads(ours[f"live/s/{A}.json"])["documents"]), 5)

    def test_a_leader_that_loses_its_leader_lists_only_what_it_names(self):
        self.write(derived=[A, W, M])
        self.assertEqual(len(self.object(A)["documents"]), 5)
        for child in sorted(self.lab.main.joinpath("projects").iterdir()):
            child.unlink()
        self.lab.main.joinpath("projects").rmdir()
        self.newer(self.lab.logs[A])
        self.write(derived=[A])
        self.assertEqual(sorted(self.listed(A)), ["notes.md"])


if __name__ == "__main__":
    unittest.main()
