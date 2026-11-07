import json
import unittest

from base import HomeCase
from board import lifecycles
from board.lifecycles import LifecycleError


class Builtins(unittest.TestCase):
    def test_every_builtin_validates_and_places_into_a_declared_column(self):
        for name in lifecycles.BUILTIN:
            spec = lifecycles.validate_lifecycle(lifecycles.builtin(name))
            ids = {c["id"] for c in spec["columns"]}
            self.assertIn(spec["default"], ids)
            self.assertTrue({r["col"] for r in spec["place"]} <= ids)

    def test_the_pm_lifecycle_has_no_landing_column_and_the_word_land_appears_only_as_nothing_to_land(self):
        pm = lifecycles.builtin("pm")
        self.assertNotIn("ready", {c["id"] for c in pm["columns"]})
        self.assertIn("legacy", {c["id"] for c in pm["columns"]})
        words = " ".join(c["name"] + " " + c["sub"] for c in pm["columns"]) + pm["blurb"]
        self.assertNotIn("Ready to land", words)

    def test_stages_that_are_the_same_everywhere(self):
        spec = lifecycles.builtin("software")
        self.assertEqual(lifecycles.place(spec, "needs", {}), "needs")
        self.assertEqual(lifecycles.place(spec, "done", {}), "done")
        self.assertEqual(lifecycles.place(spec, "queued", {}), "queued")
        self.assertEqual(lifecycles.place(spec, "active", {"ready": True}), "ready")
        self.assertEqual(lifecycles.place(spec, "active", {}), "running")

    def test_pm_rules_in_order(self):
        pm = lifecycles.builtin("pm")
        self.assertEqual(lifecycles.place(pm, "active", {"legacy_branch": True, "artifact_file": True}), "legacy")
        self.assertEqual(lifecycles.place(pm, "active", {"legacy_branch": True, "merged_record": True}), "running")
        self.assertEqual(lifecycles.place(pm, "active", {"artifact_file": True}), "review")
        self.assertEqual(lifecycles.place(pm, "active", {"waiting_on": True}), "waiting")
        self.assertEqual(lifecycles.place(pm, "active", {}), "running")

    def test_integration_and_fleet(self):
        self.assertEqual(lifecycles.place(lifecycles.builtin("integration"), "active", {"pr_open": True}), "pr")
        self.assertEqual(lifecycles.place(lifecycles.builtin("integration"), "active", {"standing": True}), "standing")
        self.assertEqual(lifecycles.place(lifecycles.builtin("fleet"), "active", {"paused_idle": True}), "standing")
        self.assertEqual(lifecycles.place(lifecycles.builtin("fleet"), "active", {"ready": True}), "ready")

    def test_a_stage_with_no_column_goes_to_the_default(self):
        spec = lifecycles.builtin("software")
        spec["columns"] = [c for c in spec["columns"] if c["id"] != "parked"]
        self.assertEqual(lifecycles.place(spec, "parked", {}), "running")

    def test_a_string_fact_matches_one_value_or_a_list(self):
        spec = lifecycles.validate_lifecycle({"name": "X", "columns": lifecycles.builtin("software")["columns"], "default": "running",
                                              "place": [{"col": "ready", "when": {"last_state": ["done", "paused"], "kind": "scout"}}]})
        self.assertEqual(lifecycles.place(spec, "active", {"last_state": "paused", "kind": "scout"}), "ready")
        self.assertEqual(lifecycles.place(spec, "active", {"last_state": "working", "kind": "scout"}), "running")


class Validation(unittest.TestCase):
    def base(self):
        return lifecycles.builtin("software")

    def test_each_mistake_is_named(self):
        cases = {
            "no columns": lambda s: s.update(columns=[]),
            "missing needs": lambda s: s.update(columns=[c for c in s["columns"] if c["id"] != "needs"]),
            "missing done": lambda s: s.update(columns=[c for c in s["columns"] if c["id"] != "done"]),
            "duplicate id": lambda s: s["columns"].append(dict(s["columns"][0])),
            "bad id": lambda s: s["columns"].append({"id": "Bad Id", "name": "x"}),
            "no name": lambda s: s["columns"].append({"id": "extra"}),
            "default not a column": lambda s: s.update(default="nowhere"),
            "rule column missing": lambda s: s["place"].append({"col": "nowhere", "when": {"ready": True}}),
            "unknown fact": lambda s: s["place"].append({"col": "ready", "when": {"vibes": True}}),
            "wrong fact type": lambda s: s["place"].append({"col": "ready", "when": {"ready": "yes"}}),
            "empty when": lambda s: s["place"].append({"col": "ready", "when": {}}),
            "no lifecycle name": lambda s: s.update(name=" "),
        }
        for label, mutate in cases.items():
            spec = self.base()
            mutate(spec)
            with self.assertRaises(LifecycleError, msg=label):
                lifecycles.validate_lifecycle(spec)


class HomeConfig(HomeCase):
    def put(self, text):
        self.write("config/task-board.json", text if isinstance(text, str) else json.dumps(text))

    def test_no_file_means_the_builtin_default(self):
        spec, source = lifecycles.resolve_lifecycle("pm", self.home)
        self.assertEqual((spec["id"], source), ("pm", {"from": "builtin", "path": None, "error": None}))

    def test_a_named_builtin(self):
        self.put({"schema": "task-board.v1", "lifecycle": "integration"})
        spec, source = lifecycles.resolve_lifecycle("pm", self.home)
        self.assertEqual((spec["id"], source["from"], source["error"]), ("integration", "home-config", None))

    def test_extends_replaces_whole_keys(self):
        self.put({"schema": "task-board.v1", "lifecycle": {"extends": "pm", "name": "eSIM", "place": [{"col": "waiting", "when": {"waiting_on": True}}]}})
        spec, source = lifecycles.resolve_lifecycle("software", self.home)
        self.assertEqual(spec["name"], "eSIM")
        self.assertEqual([r["col"] for r in spec["place"]], ["waiting"])
        self.assertIn("legacy", {c["id"] for c in spec["columns"]})  # columns kept from pm
        self.assertEqual(source["from"], "home-config")

    def test_a_custom_lifecycle(self):
        self.put({"schema": "task-board.v1", "lifecycle": {"name": "Ops", "columns": [{"id": "needs", "name": "Needs you"}, {"id": "doing", "name": "Doing"}, {"id": "done", "name": "Done"}], "default": "doing"}})
        spec, _ = lifecycles.resolve_lifecycle("software", self.home)
        self.assertEqual([c["id"] for c in spec["columns"]], ["needs", "doing", "done"])

    def test_a_bad_file_falls_back_and_says_why(self):
        for text, why in [("{not json", "not valid JSON"), ('{"schema": "other"}', "does not declare schema"), ("[]", "does not declare schema"),
                          (json.dumps({"schema": "task-board.v1", "lifecycle": "nope"}), "unknown lifecycle"),
                          (json.dumps({"schema": "task-board.v1", "lifecycle": {"name": "x", "columns": []}}), "non-empty list"),
                          (json.dumps({"schema": "task-board.v1", "lifecycle": 7}), "built-in name or an object"),
                          (json.dumps({"schema": "task-board.v1", "lifecycle": {"extends": "pm", "place": "no"}}), "ignored")]:
            self.put(text)
            spec, source = lifecycles.resolve_lifecycle("pm", self.home)
            self.assertEqual(spec["id"], "pm", text)
            self.assertIn(why, source["error"], text)
            self.assertEqual(source["from"], "builtin")

    def test_an_unreadable_file_falls_back(self):
        path = self.write("config/task-board.json", "{}")
        path.chmod(0)
        self.addCleanup(path.chmod, 0o600)
        spec, source = lifecycles.resolve_lifecycle("fleet", self.home)
        self.assertEqual(spec["id"], "fleet")
        self.assertIn("cannot be read", source["error"])

    def test_the_reader_never_writes_the_file(self):
        self.put({"schema": "task-board.v1", "lifecycle": "pm"})
        before = (self.home / "config" / "task-board.json").stat().st_mtime_ns
        lifecycles.resolve_lifecycle("software", self.home)
        self.assertEqual((self.home / "config" / "task-board.json").stat().st_mtime_ns, before)

    def test_an_unknown_default_name_is_software(self):
        spec, _ = lifecycles.resolve_lifecycle("whatever", None)
        self.assertEqual(spec["id"], "software")


if __name__ == "__main__":
    unittest.main()
