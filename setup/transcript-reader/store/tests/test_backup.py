"""The backup: snapshot, encryption before anything leaves the folder, the key from the keychain, and the upload step that stops until Drive is set up.

gpg runs for real, in a temporary GNUPGHOME (a symmetric encryption needs no keyring of yours); the keychain is a fake `security` script.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from base import StoreCase
import synth
from rstore import backup, config

PASSPHRASE = "correct-horse-battery-staple-91d4"


@unittest.skipUnless(shutil.which("gpg"), "gpg is not installed")
class Backup(StoreCase):
    def setUp(self):
        super().setUp()
        self.where = config.Paths(self.root)
        self.work = Path(tempfile.mkdtemp(prefix="rsb"))
        gnupg = self.work / "gnupg"
        gnupg.mkdir(mode=0o700)
        self.keyfile = self.work / "key"
        self.keyfile.write_text(PASSPHRASE)
        self.fake_security = self.work / "security"
        self.fake_security.write_text(
            "#!/bin/sh\n"
            'case "$*" in\n'
            f'  *"find-generic-password"*"-s pmos-reader-store-backup"*) [ -s "{self.keyfile}" ] || exit 44; cat "{self.keyfile}"; echo ;;\n'
            "  *) exit 44 ;;\n"
            "esac\n")
        self.fake_security.chmod(0o755)
        self.env = mock.patch.dict(os.environ, {"GNUPGHOME": str(gnupg), backup.SECURITY_ENV: str(self.fake_security)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(lambda: subprocess.run(["gpgconf", "--kill", "gpg-agent"], env={**os.environ}, capture_output=True))
        self.settings = config.Settings(backup_tool="gpg")
        synth.write_jsonl(synth.claude_path(self.home, synth.sid(1)), synth.claude_conversation(n_turns=2))
        synth.write_jsonl(synth.codex_path(self.home, synth.sid(2)), synth.codex_conversation(synth.sid(2)))
        self.ing.scan()
        self.conn.execute("PRAGMA wal_checkpoint(FULL)")

    def staged(self):
        return backup.stage(self.conn, self.where, self.settings, clock=lambda: 1_790_000_000.0)

    def test_the_staged_file_is_ciphertext_and_no_plain_image_is_left(self):
        result = self.staged()
        path = Path(result["path"])
        self.assertTrue(path.name.startswith("reader-store-20260"))
        self.assertTrue(path.name.endswith(".sqlite.gpg"))
        data = path.read_bytes()
        self.assertFalse(data.startswith(b"SQLite format 3"), "the file is not a SQLite image")
        for needle in (b"Question 0 about alpha", b"Synthetic alpha work", b"SQLite format"):
            self.assertNotIn(needle, data)
        self.assertEqual(sorted(p.name for p in self.where.staging.iterdir()), [path.name], "no plain image and no partial file beside it")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.where.staging.stat().st_mode), 0o700)
        row = self.rows("SELECT * FROM backups")[0]
        self.assertEqual((row["snapshot"], row["tool"], row["sha256"]), (path.name, "gpg", result["sha256"]))

    def test_the_snapshot_restores_to_the_same_store(self):
        result = self.staged()
        report = backup.verify(Path(result["path"]), self.settings, self.work / "scratch")
        self.assertEqual(report["integrity"], "ok")
        self.assertEqual(report["sessions"], self.one("SELECT COUNT(*) FROM sessions"))
        self.assertEqual(report["turns"], self.one("SELECT COUNT(*) FROM turns"))
        self.assertEqual(report["schema_version"], 1)

    def test_a_wrong_key_does_not_decrypt_and_the_error_never_holds_the_key(self):
        result = self.staged()
        self.keyfile.write_text("another-passphrase")
        with self.assertRaises(backup.BackupError) as raised:
            backup.verify(Path(result["path"]), self.settings, self.work / "scratch2")
        self.assertNotIn(PASSPHRASE, str(raised.exception))
        self.assertNotIn("another-passphrase", str(raised.exception))

    def test_without_a_key_nothing_is_staged_and_the_message_names_the_command(self):
        self.keyfile.write_text("")
        with self.assertRaises(backup.BackupError) as raised:
            self.staged()
        self.assertIn('security add-generic-password -a "', str(raised.exception))
        self.assertIn("-w", str(raised.exception))
        self.assertEqual(list(self.where.staging.iterdir()), [], "a failed run leaves nothing behind, not even a partial file")
        self.assertEqual(self.one("SELECT COUNT(*) FROM backups"), 0)

    def test_the_key_reaches_gpg_on_stdin_only(self):
        log = self.work / "gpg.log"
        real = shutil.which("gpg")
        shim = self.work / "gpg-shim"
        shim.write_text(f'#!/bin/sh\n{{ echo "ARGV: $*"; env | sort; }} >> "{log}"\nexec "{real}" "$@"\n')
        shim.chmod(0o755)
        with mock.patch.dict(os.environ, {backup.GPG_ENV: str(shim)}):
            self.staged()
        text = log.read_text()
        self.assertIn("ARGV:", text)
        self.assertIn("--passphrase-fd 0", text)
        self.assertNotIn(PASSPHRASE, text, "not in an argument and not in the environment gpg was given")

    def test_the_key_is_not_printed_by_anything_the_stage_returns(self):
        result = self.staged()
        self.assertNotIn(PASSPHRASE, repr(result))
        self.assertNotIn(PASSPHRASE, repr(self.rows("SELECT * FROM backups")))

    def test_age_is_used_when_installed_and_needs_no_keychain(self):
        shim = self.work / "age"
        log = self.work / "age.log"
        shim.write_text(f'#!/bin/sh\necho "$*" >> "{log}"\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\nprintf AGE-FAKE-CIPHERTEXT > "$out"\n')
        shim.chmod(0o755)
        self.keyfile.write_text("")  # no keychain item: age must not need one
        settings = config.Settings(backup_tool="auto", age_recipient="age1examplepublickeyexamplepublickeyexamplepublickeyexamplepubkey")
        with mock.patch.dict(os.environ, {backup.AGE_ENV: str(shim)}):
            result = backup.stage(self.conn, self.where, settings, clock=lambda: 1_790_000_100.0)
        self.assertEqual(result["tool"], "age")
        self.assertTrue(result["snapshot"].endswith(".sqlite.age"))
        self.assertIn("-r age1example", log.read_text())

    def test_old_snapshots_are_reported_never_deleted(self):
        for n in range(4):
            backup.stage(self.conn, self.where, self.settings, clock=lambda n=n: 1_790_000_000.0 + n * 100)
        old = backup.older_than(self.where, 2)
        self.assertEqual(len(old), 2)
        for name in old:
            self.assertTrue((self.where.staging / name).exists())


class Upload(StoreCase):
    def setUp(self):
        super().setUp()
        self.where = config.Paths(self.root)
        self.work = Path(tempfile.mkdtemp(prefix="rsu"))
        self.encrypted = self.work / "reader-store-20261107T000000Z.sqlite.gpg"
        self.encrypted.write_bytes(b"\x8c\x0d ciphertext bytes " * 50)
        self.conn.execute("INSERT INTO backups(at, snapshot, bytes) VALUES (1, ?, 10)", (self.encrypted.name,))

    def test_with_no_drive_folder_the_step_stops_and_says_so(self):
        result = backup.upload(self.conn, self.where, config.Settings(), self.encrypted)
        self.assertEqual(result, {"status": "drive_not_configured", "uploaded": False})
        self.assertIsNone(self.one("SELECT uploaded_at FROM backups"))

    def test_a_missing_folder_stops_it(self):
        settings = config.Settings(drive_folder=str(self.work / "GoogleDrive-nguyen.tran@shopback.com" / "My Drive"))
        self.assertEqual(backup.upload(self.conn, self.where, settings, self.encrypted)["status"], "drive_folder_missing")

    def test_a_personal_drive_is_refused(self):
        folder = self.work / "GoogleDrive-someone@gmail.com" / "My Drive"
        folder.mkdir(parents=True)
        result = backup.upload(self.conn, self.where, config.Settings(drive_folder=str(folder)), self.encrypted)
        self.assertEqual(result["status"], "drive_folder_not_shopback")
        self.assertEqual(list(folder.iterdir()), [])

    def test_a_shopback_drive_folder_gets_a_verified_copy(self):
        folder = self.work / "GoogleDrive-nguyen.tran@shopback.com" / "My Drive" / "reader-store-backups"
        folder.mkdir(parents=True)
        result = backup.upload(self.conn, self.where, config.Settings(drive_folder=str(folder)), self.encrypted)
        self.assertEqual(result["status"], "uploaded")
        self.assertEqual((folder / self.encrypted.name).read_bytes(), self.encrypted.read_bytes())
        self.assertEqual([p.name for p in folder.iterdir()], [self.encrypted.name], "no partial file left")
        self.assertIsNotNone(self.one("SELECT uploaded_at FROM backups"))

    def test_the_allow_any_setting_lets_another_folder_in(self):
        folder = self.work / "elsewhere"
        folder.mkdir()
        settings = config.Settings(drive_folder=str(folder), extra={"drive_allow_any": True})
        self.assertEqual(backup.upload(self.conn, self.where, settings, self.encrypted)["status"], "uploaded")


class Keychain(unittest.TestCase):
    def test_the_command_that_creates_the_key_asks_at_the_terminal(self):
        command = backup.init_key_command(config.Settings(keychain_account="nathan"))
        self.assertTrue(command.endswith("-w"), "no value after -w: security asks for it, so it is in no history and no process list")
        self.assertIn('-s "pmos-reader-store-backup"', command)

    def test_nothing_in_the_backup_module_runs_a_keychain_write(self):
        import inspect
        for name, function in inspect.getmembers(backup, inspect.isfunction):
            if name != "init_key_command":
                self.assertNotIn("add-generic-password", inspect.getsource(function), name)


if __name__ == "__main__":
    unittest.main()
