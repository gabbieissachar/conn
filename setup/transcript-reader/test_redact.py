"""Tests for redact.py, the secret scan the hosted copy runs on every object before encrypting it.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_redact.py
Every sample secret is made up and put together at run time, so this file holds no token
a scanner would flag.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import redact  # noqa: E402

LETTERS = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"


def fake(prefix, length, alphabet=LETTERS):
    return prefix + (alphabet * 4)[:length]


class RedactTextTest(unittest.TestCase):
    def check(self, text, kind, kept=()):
        counts = {}
        out = redact.redact_text(text, counts)
        self.assertEqual(counts, {kind: 1}, out)
        self.assertIn(f"[redacted:{kind}]", out)
        for part in kept:
            self.assertIn(part, out)
        return out

    def test_each_kind_of_secret(self):
        self.check("key " + fake("AKIA", 16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567") + " here", "aws-access-key", kept=("key ", " here"))
        self.check("use " + fake("sk-ant-", 40), "api-key", kept=("use ",))
        self.check(fake("ghp_", 36), "github-token")
        self.check(fake("github_pat_", 40), "github-token")
        self.check("token " + fake("glpat-", 20), "gitlab-token")
        self.check(fake("xoxb-", 24), "slack-token")
        self.check(".".join(["eyJ" + fake("", 20), "eyJ" + fake("", 30), fake("", 25)]), "jwt")
        self.check("Authorization: Bearer " + fake("", 32), "bearer", kept=("Authorization: Bearer ",))
        self.check("open https://deploy:" + fake("", 12) + "@example.com/x", "url-password", kept=("https://deploy:", "@example.com/x"))
        self.check("https://example.com/cb?state=1&access_token=" + fake("", 24) + "&x=2", "url-secret", kept=("&access_token=", "&x=2"))
        self.check("export SERVICE_API_KEY=" + fake("", 24), "env-secret", kept=("export SERVICE_API_KEY=",))
        self.check('DB_PASSWORD="' + fake("", 16) + '"', "env-secret", kept=('DB_PASSWORD="',))
        self.check("token " + "0123456789abcdef" * 4 + " end", "hex64-token", kept=("token ", " end"))

    def test_a_private_key_keeps_its_line_breaks(self):
        block = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + fake("", 40) + "\n" + fake("", 40) + "\n-----END OPENSSH PRIVATE KEY-----"
        text = "Line 1\n" + block + "\nLast line asks: ok?"
        out = self.check(text, "private-key")
        self.assertEqual(out.count("\n"), text.count("\n"))
        self.assertEqual(out.splitlines()[-1], "Last line asks: ok?")

    def test_what_is_not_a_secret_stays(self):
        text = ("Session aaaaaaaa-1111-4111-8111-111111111111, commit 0123456789abcdef0123456789abcdef01234567, "
                "the token header x-transcript-reader-token, TOKEN_HEADER = 'x-token', export API_TOKEN=$TOKEN_FROM_KEYCHAIN, "
                "Bearer of good news, https://example.com/a?page=2&key=short, sk-short, ~/notes.md, YOUR_PASSPHRASE_HERE.")
        counts = {}
        self.assertEqual(redact.redact_text(text, counts), text)
        self.assertEqual(counts, {})

    def test_counts_add_up_and_redacting_twice_changes_nothing(self):
        text = fake("ghp_", 36) + " and " + fake("ghp_", 40) + " and " + fake("xoxp-", 20)
        counts = {}
        once = redact.redact_text(text, counts)
        self.assertEqual(counts, {"github-token": 2, "slack-token": 1})
        again = {}
        self.assertEqual(redact.redact_text(once, again), once)
        self.assertEqual(again, {})


class RedactObjectTest(unittest.TestCase):
    def test_every_string_of_an_object_and_never_a_key(self):
        secret = fake("glpat-", 24)
        value = {"id": "s1", "exchanges": [{"input": "deploy with " + secret, "reply": "done", "at": 1.5, "asks": [secret], "folded": False}],
                 secret: "a key is left alone"}
        counts = {}
        out = redact.redact(value, counts)
        self.assertEqual(out["exchanges"][0]["input"], "deploy with [redacted:gitlab-token]")
        self.assertEqual(out["exchanges"][0]["asks"], ["[redacted:gitlab-token]"])
        self.assertEqual((out["exchanges"][0]["at"], out["exchanges"][0]["folded"], out["id"]), (1.5, False, "s1"))
        self.assertIn(secret, out)
        self.assertEqual(counts, {"gitlab-token": 2})
        self.assertIn(secret, value["exchanges"][0]["input"], "the original is not changed")


if __name__ == "__main__":
    unittest.main()
