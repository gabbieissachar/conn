import json
import os
import unittest
from pathlib import Path

from base import HomeCase
from board import homes


class Registry(HomeCase):
    def setUp(self):
        super().setUp()
        self.main = self.tmp / "main"
        (self.main / "data").mkdir(parents=True)
        lines = [
            "- secondmate-nip - charter text (home: %s/nip; scope: nip things; projects: x)" % self.tmp,
            "- secondmate-workspaceos-firstmate - charter text (home: %s/wos; scope: ws; projects: y)" % self.tmp,
            "- secondmate-esim - charter (home: %s/esim; scope: e)" % self.tmp,
            "- secondmate-fleet-watch - charter (home: %s/watch; scope: w)" % self.tmp,
            "not a registry line",
        ]
        (self.main / "data" / "secondmates.md").write_text("\n".join(lines) + "\n")
        for key, value in (("FM_MAIN_HOME", str(self.main)), ("PMOS_READER_BOARD_CONFIG", str(self.tmp / "board.json")), ("FM_ROOT", "")):
            os.environ[key] = value
            self.addCleanup(os.environ.pop, key, None)

    def test_defaults_come_from_the_main_homes_registry_and_only_known_leaders_get_boards(self):
        reg = homes.load()
        self.assertEqual([(s.id, s.label, s.lifecycle, s.kind) for s in reg.sessions],
                         [("big-boss", "big-boss", "fleet", "big-boss"), ("leader-nip", "NIP", "integration", "leader"),
                          ("leader-workspaceos", "workspaceOS", "software", "leader"), ("leader-esim", "eSIM", "pm", "leader")])
        self.assertEqual(reg.get("leader-esim").home, self.tmp / "esim")
        self.assertEqual(reg.get("big-boss").home, self.main)
        self.assertIsNone(reg.get("leader-fleet-watch"))
        self.assertEqual((reg.source, reg.error), ("defaults", None))

    def test_no_registry_means_big_boss_alone(self):
        os.environ["FM_MAIN_HOME"] = str(self.tmp / "nowhere")
        self.assertEqual([s.id for s in homes.load().sessions], ["big-boss"])

    def test_a_config_replaces_the_sessions_and_names_the_scripts(self):
        root = self.tmp / "fm"
        (root / "bin").mkdir(parents=True)
        (root / "bin" / "fm-fleet-snapshot.sh").write_text("#!/bin/sh\n")
        (self.tmp / "board.json").write_text(json.dumps({"fm_root": str(root), "sessions": [{"id": "leader-a", "label": "A", "home": str(self.tmp / "a"), "lifecycle": "pm"}]}))
        reg = homes.load()
        self.assertEqual([(s.id, s.lifecycle) for s in reg.sessions], [("leader-a", "pm")])
        self.assertEqual(reg.fm_root, root)
        self.assertEqual(reg.source, str(self.tmp / "board.json"))

    def test_a_bad_config_is_ignored_and_says_why(self):
        for text, why in [("{", "board config ignored"), (json.dumps({"sessions": []}), "non-empty list"),
                          (json.dumps({"sessions": [{"id": "x"}]}), "unique id and a home"),
                          (json.dumps({"sessions": [{"id": "x y", "home": "/h"}]}), "unique id and a home"),
                          (json.dumps({"sessions": [{"id": "x", "home": "/h"}, {"id": "x", "home": "/h2"}]}), "unique id and a home"),
                          (json.dumps({"fm_root": "/no/such/checkout"}), "fm_root has no bin/fm-fleet-snapshot.sh"), ("[]", "not an object")]:
            (self.tmp / "board.json").write_text(text)
            reg = homes.load()
            self.assertIn(why, reg.error, text)
            self.assertEqual(reg.sessions[0].id, "big-boss")

    def test_the_scripts_root_is_found_from_FM_ROOT(self):
        root = self.tmp / "fm"
        (root / "bin").mkdir(parents=True)
        (root / "bin" / "fm-fleet-snapshot.sh").write_text("#!/bin/sh\n")
        os.environ["FM_ROOT"] = str(root)
        self.assertEqual(homes.find_fm_root(), root)
        os.environ["FM_ROOT"] = str(self.tmp / "nope")
        self.assertNotEqual(homes.find_fm_root(), self.tmp / "nope")

    def test_public_session_hides_the_path(self):
        self.assertEqual(set(homes.load().sessions[0].public()), {"id", "label", "lifecycle", "kind", "parent", "task"})


if __name__ == "__main__":
    unittest.main()
