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
        self.check(fake("sk_" + "live_", 24), "api-key")
        self.check(fake("rk_" + "test_", 24), "api-key")
        self.check("key " + fake("AIza", 35), "api-key", kept=("key ",))
        self.check(fake("npm_", 36), "api-key")
        self.check(fake("hf_", 34), "api-key")
        self.check(fake("ghp_", 36), "github-token")
        self.check(fake("github_pat_", 40), "github-token")
        self.check("token " + fake("glpat-", 20), "gitlab-token")
        self.check(fake("xoxb-", 24), "slack-token")
        self.check(".".join(["eyJ" + fake("", 20), "eyJ" + fake("", 30), fake("", 25)]), "jwt")
        self.check("Authorization: Bearer " + fake("", 32), "bearer", kept=("Authorization: Bearer ",))
        self.check("open https://deploy:" + fake("", 12) + "@example.com/x", "url-password", kept=("https://deploy:", "@example.com/x"))
        self.check("https://example.com/cb?state=1&access_token=" + fake("", 24) + "&x=2", "url-secret", kept=("&access_token=", "&x=2"))
        self.check("export SERVICE_API_KEY=" + fake("", 24), "assigned-secret", kept=("export SERVICE_API_KEY=",))
        self.check('DB_PASSWORD="' + fake("", 16) + '"', "assigned-secret", kept=('DB_PASSWORD="',))
        self.check("token " + "0123456789abcdef" * 4 + " end", "hex64-token", kept=("token ", " end"))

    def test_a_secret_given_a_value_in_any_form(self):
        # The reviewer's S4 and S5 repros: plain env names, lower case, ini, YAML and JSON keys, a status
        # line, short passwords and a short bearer token.
        for line, kept in [
            ("PASSWORD=" + fake("", 14), "PASSWORD="), ("TOKEN=" + fake("", 16), "TOKEN="), ("SECRET=" + fake("", 13), "SECRET="),
            ("API_KEY=" + fake("", 10), "API_KEY="), ("APIKEY=" + fake("", 10), "APIKEY="), ("PRIVATE_KEY=" + fake("", 8), "PRIVATE_KEY="),
            ("export PASSWORD=" + fake("", 14), "export PASSWORD="), ("password=" + fake("", 14), "password="),
            ("db_password = " + fake("", 8), "db_password = "), ("aws_secret_access_key = " + fake("", 12), "aws_secret_access_key = "),
            ('"password": "' + fake("", 8) + '"', '"password": "'), ("password: " + fake("", 8), "password: "),
            ("old token=" + fake("", 17) + " is dead", " is dead"), ("DB_PASSWORD=" + fake("", 7), "DB_PASSWORD="),
        ]:
            self.check(line, "assigned-secret", kept=(kept,))
        self.check("https://x.example/login?password=" + fake("", 7), "url-secret", kept=("?password=",))
        self.check("Authorization: Bearer " + fake("", 15), "bearer", kept=("Bearer ",))

    def test_a_private_key_cut_off_before_its_end_line(self):
        # The reviewer's S6 repro: the head of a key file, then the rest of the reply after a blank line.
        text = "Here:\n-----BEGIN RSA PRIVATE KEY-----\n" + fake("MIIE", 40) + "\n" + fake("", 40) + "\n\nThat is all."
        out = self.check(text, "private-key", kept=("Here:", "That is all."))
        self.assertEqual(out.count("\n"), text.count("\n"))
        self.check("-----BEGIN PRIVATE KEY-----\n" + fake("", 40), "private-key")

    def test_an_encrypted_key_with_headers_and_a_blank_line_is_redacted_whole(self):
        # The security review's case: RFC 1421 headers, then a blank line, then the body, then END.
        body = fake("MIIE", 40) + "\n" + fake("", 40)
        text = ("-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC," + fake("", 16) + "\n\n"
                + body + "\n-----END RSA PRIVATE KEY-----\nafter")
        out = self.check(text, "private-key", kept=("after",))
        self.assertNotIn(fake("MIIE", 40), out)
        self.assertEqual(out.count("\n"), text.count("\n"))
        cut = self.check("-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n\n" + body + "\n\nThe rest of the reply.", "private-key",
                         kept=("The rest of the reply.",))
        self.assertNotIn(fake("MIIE", 40), cut)

    def test_a_cut_off_key_in_any_line_form(self):
        # The security review's cases: CRLF lines, a key quoted in a JSON string (written-out \\n), indented lines.
        body1, body2 = fake("MIIE", 40), fake("", 40)
        for text in ("-----BEGIN RSA PRIVATE KEY-----\r\nProc-Type: 4,ENCRYPTED\r\n\r\n" + body1 + "\r\n" + body2 + "\r\n\r\nThat is all.",
                     '{"key": "-----BEGIN PRIVATE KEY-----\\n' + body1 + "\\n" + body2 + '\\n", "after": 1}',
                     "  -----BEGIN PRIVATE KEY-----\n    " + body1 + "\n    " + body2 + "\n\nThat is all.",
                     '{"key": "-----BEGIN PRIVATE KEY-----\\r\\n' + body1[:20] + "\\/" + body1[20:] + "\\r\\n" + body2 + '", "after": 1}'):
            out = self.check(text, "private-key", kept=("That is all." if "That" in text else '"after": 1',))
            self.assertNotIn(body1, out)
            self.assertNotIn(body2, out)
            self.assertEqual(out.count("\n"), text.count("\n"))

    def test_a_cut_off_key_in_the_shapes_the_reviewer_found_leaks_nothing(self):
        # The reviewer's S8 repros: a key whose line breaks became spaces, key text on the BEGIN line, lines quoted
        # with "> ", lines with a number prefix, a partial last line followed by text, and an armoured PGP block.
        b1, b2, b3 = fake("MIIE", 64), fake("", 64), fake("zQ", 30)
        for name, text in {
            "spaces": "echo:\n-----BEGIN RSA PRIVATE KEY----- " + b1 + " " + b2 + " " + b3 + "\nnext line",
            "on the BEGIN line": "-----BEGIN RSA PRIVATE KEY-----" + b1 + "\n" + b2 + "\n" + b3 + "\nnext line",
            "quoted": "-----BEGIN RSA PRIVATE KEY-----\n> " + b1 + "\n> " + b2 + "\n> " + b3 + "\nnext line",
            "numbered": "-----BEGIN RSA PRIVATE KEY-----\n     1\t" + b1 + "\n     2\t" + b2 + "\n3: " + b3 + "\nnext line",
            "partial last line": "-----BEGIN RSA PRIVATE KEY-----\n" + b1 + "\n" + b2 + "\n" + b3 + " ... [truncated]\nnext line",
            "pgp": "-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: Made Up 1.0\n\n" + b1 + "\n" + b2 + "\n=" + fake("", 4) + "\nnext line",
        }.items():
            counts = {}
            out = redact.redact_text(text, counts)
            self.assertEqual(counts, {"private-key": 1}, name)
            for body in (b1, b2, b3):
                self.assertNotIn(body, out, name)
            self.assertNotIn("truncated", out, name)
            self.assertTrue(out.endswith("next line"), (name, out))
            self.assertEqual(out.count("\n"), text.count("\n"), name)
        # A whole PGP block, END line and all, goes too.
        whole = "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n" + b1 + "\n-----END PGP PRIVATE KEY BLOCK-----\nafter"
        out = redact.redact_text(whole, {})
        self.assertTrue(out.startswith("[redacted:private-key]") and out.endswith("\nafter"), out)
        self.assertEqual(out.count("\n"), whole.count("\n"))

    def test_prose_after_a_cut_off_key_stays(self):
        text = "-----BEGIN PRIVATE KEY-----\n" + fake("MIIE", 64) + "\nThat is all, thanks. See notes.md for more."
        out = redact.redact_text(text, {})
        self.assertTrue(out.endswith("That is all, thanks. See notes.md for more."), out)

    def test_basic_auth_cookies_and_azure_keys(self):
        self.check("curl -H 'Authorization: Basic " + "dXNlcjpwYXNz" * 2 + "==' https://example.com", "basic-auth", kept=("Authorization: Basic ", "' https://example.com"))
        self.check("Cookie: session=" + fake("", 20) + "; theme=dark", "cookie", kept=("Cookie: ",))
        self.check('"Set-Cookie": "sid=' + fake("", 20) + '; Path=/"', "cookie", kept=('"Set-Cookie": "',))
        self.check("DefaultEndpointsProtocol=https;AccountName=made;AccountKey=" + fake("", 40) + "==;EndpointSuffix=core", "azure-key",
                   kept=("AccountName=made;AccountKey=", ";EndpointSuffix=core"))
        self.check("SharedAccessKey=" + fake("", 30), "azure-key", kept=("SharedAccessKey=",))
        # What only looks like them stays: the word basic in prose, a cookie banner, a setting named cookie_consent.
        text = "A basic configuration, the cookie banner shows, cookie_consent: accepted, Authorization: Bearer-less, AccountKey=short."
        self.assertEqual(redact.redact_text(text, {}), text)

    def test_a_secret_inside_a_json_string_that_was_escaped_twice(self):
        text = '{"output": "{\\"password\\": \\"' + fake("", 12) + '\\", \\"user\\": \\"made\\"}"}'
        out = self.check(text, "assigned-secret", kept=("made",))
        self.assertNotIn(fake("", 12), out)

    def test_long_runs_of_name_characters_are_quick(self):
        import time
        for text in ("a-" * 60000, "_" * 120000, "x." * 60000 + "password=" + fake("", 9), "A" * 120000, "-----BEGIN PRIVATE KEY-----" * 2000,
                     "-----BEGIN PRIVATE KEY-----\n" + " \t" * 60000 + "!", ("-----BEGIN PRIVATE KEY-----\n" + " " * 300 + "\n") * 300,
                     "-----BEGIN PRIVATE KEY-----\n" + "> " * 60000 + "!", "-----BEGIN PRIVATE KEY-----\n" + "1 " * 60000 + "!", "-----BEGIN PRIVATE KEY-----\n" + "9" * 120000 + " !",
                     "-----BEGIN PRIVATE KEY-----\n" + ("A" * 25 + " x\n") * 20000, "-----BEGIN PRIVATE KEY-----\n" + "1 > 2: " * 30000 + "!",
                     "Cookie: " + "a" * 200000, "Authorization: Basic " + "A" * 200000 + "!", "AccountKey=" + "x" * 200000):
            started = time.monotonic()
            redact.redact_text(text, {})
            self.assertLess(time.monotonic() - started, 1.0, text[:20])

    def test_a_private_key_keeps_its_line_breaks(self):
        block = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + fake("", 40) + "\n" + fake("", 40) + "\n-----END OPENSSH PRIVATE KEY-----"
        text = "Line 1\n" + block + "\nLast line asks: ok?"
        out = self.check(text, "private-key")
        self.assertEqual(out.count("\n"), text.count("\n"))
        self.assertEqual(out.splitlines()[-1], "Last line asks: ok?")

    def test_what_is_not_a_secret_stays(self):
        text = ("Session aaaaaaaa-1111-4111-8111-111111111111, commit 0123456789abcdef0123456789abcdef01234567, "
                "the token header x-transcript-reader-token, TOKEN_HEADER = 'x-token', export API_TOKEN=$TOKEN_FROM_KEYCHAIN, "
                "Bearer of good news, https://example.com/a?page=2&key=short, sk-short, ~/notes.md, YOUR_PASSPHRASE_HERE, "
                "token=YOUR_TOKEN_HERE, def login(password: str), Passwords: see the vault, secret: <from the keychain>, pwd=***.")
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
