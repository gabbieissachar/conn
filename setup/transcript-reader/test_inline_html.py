"""Tests for prototype/inline_html.py: what an HTML file's copy folds in from beside it, and what it leaves.

Run from the repo root: python3 -m unittest setup/transcript-reader/test_inline_html.py
Fixtures are made-up files in a temporary folder (the temp folders are allowed places, as for the viewer).
"""

import base64
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "prototype"))
import inline_html  # noqa: E402

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")


class FoldTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name).resolve()
        self.roots = [self.dir.parent]  # the folder the file is in is not itself an allowed root, so the files below it load
        (self.dir / "img").mkdir()
        (self.dir / "img" / "a.png").write_bytes(PNG)

    def fold(self, html: str, name: str = "page.html", roots=None) -> dict:
        (self.dir / name).write_text(html, encoding="utf-8")
        return inline_html.fold(self.dir / name, roots or self.roots)

    def test_a_deferred_script_runs_at_the_end_of_the_body_in_order_and_its_old_place_runs_nothing(self):
        (self.dir / "a.js").write_text("window.A = 1;", encoding="utf-8")
        (self.dir / "b.js").write_text("window.B = 2;", encoding="utf-8")
        out = self.fold('<html><head><script src="a.js" defer></script></head><body><p id="x"></p><script src="b.js" async></script><script>window.C = 3;</script></body></html>')
        text = out["text"]
        self.assertLess(text.index("<p id=\"x\">"), text.index("window.A = 1;"))
        self.assertLess(text.index("window.A = 1;"), text.index("window.B = 2;"))
        self.assertGreater(text.index("window.A = 1;"), text.index("window.C = 3;"), "after the document's own inline scripts, as a deferred one runs after parsing")
        self.assertEqual(text.count('data-folded="deferred"'), 2)
        self.assertNotIn('src="a.js"', text)

    def test_a_plain_script_stays_where_it_was(self):
        (self.dir / "a.js").write_text("window.A = 1;", encoding="utf-8")
        text = self.fold('<body><i></i><script src="a.js"></script><b></b></body>')["text"]
        self.assertLess(text.index("<i>"), text.index("window.A = 1;"))
        self.assertLess(text.index("window.A = 1;"), text.index("<b>"))

    def test_a_module_script_is_left_and_said(self):
        (self.dir / "m.js").write_text("export default 1;", encoding="utf-8")
        out = self.fold('<script type="module" src="m.js"></script>')
        self.assertIn('src="m.js"', out["text"])
        self.assertIn("module script", out["skipped"][0]["why"])

    def test_code_cannot_close_the_script_it_is_put_in(self):
        (self.dir / "a.js").write_text("var s = '</script><b>'; /* <!-- */", encoding="utf-8")
        text = self.fold('<body><script src="a.js"></script></body>')["text"]
        self.assertEqual(text.count("</script>"), 1)
        self.assertNotIn("<!--", text)

    def test_a_stylesheet_brings_its_imports_and_pictures_and_keeps_its_media(self):
        (self.dir / "css").mkdir()
        (self.dir / "css" / "main.css").write_text("@import 'more.css'; body { background: url(../img/a.png); }", encoding="utf-8")
        (self.dir / "css" / "more.css").write_text("h1 { color: red; }", encoding="utf-8")
        out = self.fold('<link rel="stylesheet" href="css/main.css" media="print">')
        text = out["text"]
        self.assertTrue(text.startswith('<style media="print">'))
        self.assertIn("h1 { color: red; }", text)
        self.assertIn("url(\"data:image/png;base64,", text)
        self.assertEqual(out["inlined"], 3)

    def test_an_import_loop_ends(self):
        (self.dir / "a.css").write_text("@import 'b.css'; a { color: red }", encoding="utf-8")
        (self.dir / "b.css").write_text("@import 'a.css'; b { color: red }", encoding="utf-8")
        text = self.fold('<link rel="stylesheet" href="a.css">')["text"]
        self.assertIn("a { color: red }", text)

    def test_srcset_icons_posters_and_style_attributes(self):
        out = self.fold('<link rel="icon" href="img/a.png"><img srcset="img/a.png 1x, img/a.png 2x"><video poster="img/a.png"></video><div style="background:url(img/a.png)"></div>')
        self.assertEqual(out["text"].count("data:image/png;base64,"), 5)
        self.assertEqual(out["inlined"], 1, "one file, read once")

    def test_other_pages_fonts_and_media_beside_it_are_left_as_written(self):
        (self.dir / "other.html").write_text("x", encoding="utf-8")
        (self.dir / "f.woff2").write_bytes(b"font")
        (self.dir / "v.mp4").write_bytes(b"video")
        out = self.fold('<a href="other.html">x</a><link rel="stylesheet" href="f.woff2"><video src="v.mp4"></video><style>@font-face { src: url(f.woff2) }</style>')
        self.assertIn('href="other.html"', out["text"])
        self.assertIn("url(f.woff2)", out["text"])
        self.assertEqual(out["inlined"], 0)

    def test_nothing_leads_out_of_the_files_folder_or_into_a_hidden_one(self):
        (self.dir / "sub").mkdir()
        (self.dir / "sub" / "p.html").write_text('<img src="../img/a.png"><img src="../../x.png"><img src="../.git/x.png">', encoding="utf-8")
        (self.dir / ".git").mkdir()
        (self.dir / ".git" / "x.png").write_bytes(PNG)
        out = inline_html.fold(self.dir / "sub" / "p.html", self.roots)
        self.assertEqual(out["text"].count("data:image"), 0, "the file's own folder is the limit, as the viewer's address is")
        self.assertEqual(len(out["skipped"]), 3)

    def test_a_link_out_of_the_folder_is_refused_after_it_is_followed(self):
        outside = Path(tempfile.mkdtemp(dir=self.dir.parent))
        self.addCleanup(lambda: [p.unlink() for p in outside.iterdir()] and outside.rmdir() or True)
        (outside / "secret.png").write_bytes(PNG)
        (self.dir / "link.png").symlink_to(outside / "secret.png")
        out = self.fold('<img src="link.png">')
        self.assertEqual(out["inlined"], 0)
        self.assertEqual(out["skipped"][0]["why"], "a link leading out of the folder")

    def test_a_file_outside_the_allowed_folders_is_not_read(self):
        out = self.fold('<img src="img/a.png">', roots=[Path(tempfile.gettempdir()) / "somewhere-else"])
        self.assertEqual(out["inlined"], 0)

    def test_the_budget_stops_what_is_folded_in_and_says_so(self):
        (self.dir / "img" / "big.png").write_bytes(b"x" * 1024)
        (self.dir / "img" / "big2.png").write_bytes(b"y" * 1024)
        old = inline_html.MAX_INLINE_BYTES
        inline_html.MAX_INLINE_BYTES = 1500
        try:
            out = self.fold('<img src="img/big.png"><img src="img/big2.png"><img src="img/a.png"><img src="img/big.png">')
        finally:
            inline_html.MAX_INLINE_BYTES = old
        self.assertEqual(out["text"].count("data:image/png"), 3, "the first big picture twice (read once) and the small one; the second big one no longer fits")
        self.assertIn('src="img/big2.png"', out["text"])
        self.assertEqual([item["why"] for item in out["skipped"]], ["over the copy's size budget"])
        self.assertLessEqual(out["bytes"], 1500)

    def test_absolute_and_data_addresses_are_left_alone_and_not_called_refusals(self):
        out = self.fold('<img src="https://x.example/p.png"><img src="//x.example/p.png"><img src="/rooted.png"><img src="data:image/png;base64,AAAA"><a href="#top">t</a>')
        self.assertEqual(out["skipped"], [])
        self.assertEqual(out["inlined"], 0)


if __name__ == "__main__":
    unittest.main()
