"""Folds what an HTML file loads from beside itself into the file, for the offline copy.

The local reader shows an HTML file a reply names in a sandboxed frame served by its own server (api.js),
which also serves the pictures, styles and scripts beside the file. A copy read with the laptop shut has
no server to ask, so sync.py builds each such file once into one self-contained text: this module follows
the same rules as the server and puts what the file loads into the file itself.

The rules, the viewer's own (api.js serveView), so the copy shows what the local page shows:

  - Only references that stay below the folder of the file (a stylesheet's own references are read from
    its own folder, still below the file's): never a path leading out of it, never a dot file or a dot
    folder, never a link that leads out once followed, and never outside the home folder and the temp
    folders. A file directly in the home folder or a temp folder gets only the files in that folder.
  - Only these types: .png .jpg .jpeg .gif .webp .avif .svg .ico .bmp pictures, .css and .js.
    Fonts, media and other pages beside the file are left as they are (the viewer never served them
    either: they need a CORS answer, or open in the frame in place of the file).
  - Absolute addresses (https://..., //host/..., /rooted/...) and data: addresses are left as they are.
    The frame the copy shows them in has no network, so an address outside the file loads nothing there.

What it folds in: <link rel=stylesheet> (as <style>), <script src> (as inline code; one with defer or async runs at the end of
the body, in order, since inline code cannot be deferred; a module script is left, as the viewer never served one), <img src>, <img srcset>,
<source src|srcset>, <video poster>, <input type=image>, <link rel=icon>, url() and @import in <style> blocks,
in style="" attributes and inside the stylesheets themselves. What it cannot: a file a script asks for while
it runs (fetch, an Image made in code, a stylesheet it adds), inline SVG's own <image href> and <use href>,
and anything over the budget below, which stays unloaded and is listed in `skipped`.

The copy keeps one budget per file, MAX_INLINE_BYTES of what is folded in (pictures grow by a third as
base64): the viewer takes a file up to 32 MB, which a phone should not carry in every copy.
"""

from __future__ import annotations

import base64
import html as html_lib
import posixpath
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

MAX_ASSET_BYTES = 32 * 1024 * 1024  # the viewer's limit for one file beside the page (api.js MAX_ASSET_BYTES)
MAX_INLINE_BYTES = 12 * 1024 * 1024  # what the copy folds into one document in all
MAX_DEPTH = 3  # @import inside @import inside a stylesheet
IMAGE_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".bmp": "image/bmp",
}
TEXT_TYPES = {".css", ".js"}

CSS_URL = re.compile(r"""url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)""", re.I)
CSS_IMPORT = re.compile(r"""@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)|"([^"]*)"|'([^']*)')\s*([^;{}]*);""", re.I)
ATTRIBUTE = re.compile(r"""([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?""")


class Bundle:
    """What one document folds in: the budget, each file once, and what was left alone."""

    def __init__(self, entry: Path, roots: list[Path]) -> None:
        self.entry = entry.resolve()
        self.dir = self.entry.parent
        self.roots = [root.resolve() for root in roots]
        # A file directly in the home folder or a temp folder gets only that folder's own files, as the viewer serves it.
        self.flat = self.dir in self.roots
        self.used = 0
        self.files: dict[Path, bytes] = {}
        self.versions: dict[str, list[int]] = {}
        self.skipped: list[dict] = []
        self.inlined = 0

    def within(self, real: Path, base: Path) -> bool:
        return real == base or base in real.parents

    def locate(self, ref: str, from_dir: Path) -> tuple[Path | None, str]:
        """The file <ref> names, read from <from_dir>, or (None, why not). Only a path that stays below the entry's
        folder, as the viewer serves it."""
        ref = html_lib.unescape(ref).strip()
        if not ref or ref.startswith("#"):
            return None, ""
        try:
            parts = urlsplit(ref)
        except ValueError:
            return None, "an address that cannot be read"
        if parts.scheme or parts.netloc or ref.startswith("//") or parts.path.startswith("/") or not parts.path:
            return None, ""  # an absolute address, a data: URI or a rooted path: left as written
        name = unquote(parts.path)
        if "\\" in name or "\0" in name:
            return None, "a path with a backslash"
        target = Path(posixpath.normpath(str(from_dir / name)))
        try:
            under = target.relative_to(self.dir).parts
        except ValueError:
            return None, "outside the file's folder"
        if not under or any(part.startswith(".") or not part for part in under):
            return None, "a hidden file or folder"
        if self.flat and len(under) > 1:
            return None, "the file is directly in the home or a temp folder, so only files beside it load"
        suffix = target.suffix.lower()
        if suffix not in IMAGE_TYPES and suffix not in TEXT_TYPES:
            return None, "a type the viewer does not load" if suffix not in (".html", ".htm") else "another page"
        try:
            real = target.resolve(strict=True)
            stat = real.stat()
        except OSError:
            return None, "no such file"
        if not real.is_file() or not self.within(real, self.dir) or not any(self.within(real, root) for root in self.roots):
            return None, "a link leading out of the folder"
        if stat.st_size > MAX_ASSET_BYTES:
            return None, "over the viewer's 32 MB limit"
        return real, ""

    def read(self, real: Path) -> bytes | None:
        """The file's bytes, within the budget (each file counts once)."""
        if real in self.files:
            return self.files[real]
        size = real.stat().st_size
        if self.used + size > MAX_INLINE_BYTES:
            return None
        data = real.read_bytes()
        self.used += len(data)
        self.files[real] = data
        stat = real.stat()
        self.versions[str(real)] = [stat.st_mtime_ns, stat.st_size]
        self.inlined += 1
        return data

    def skip(self, ref: str, why: str) -> None:
        if why and len(self.skipped) < 50:
            self.skipped.append({"ref": html_lib.unescape(ref).strip()[:200], "why": why})

    # ------------------------------------------------------------------ pieces

    def data_uri(self, ref: str, from_dir: Path) -> str | None:
        """The picture <ref> names as a data: URI, or None (left as written)."""
        real, why = self.locate(ref, from_dir)
        if real is None:
            self.skip(ref, why)
            return None
        mime = IMAGE_TYPES.get(real.suffix.lower())
        if not mime:
            self.skip(ref, "not a picture")
            return None
        data = self.read(real)
        if data is None:
            self.skip(ref, "over the copy's size budget")
            return None
        return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"

    def text_file(self, ref: str, from_dir: Path, suffix: str) -> tuple[str, Path] | None:
        real, why = self.locate(ref, from_dir)
        if real is None:
            self.skip(ref, why)
            return None
        if real.suffix.lower() != suffix:
            self.skip(ref, "not " + suffix)
            return None
        data = self.read(real)
        if data is None:
            self.skip(ref, "over the copy's size budget")
            return None
        return data.decode("utf-8", errors="replace"), real

    def css(self, text: str, from_dir: Path, depth: int = 0) -> str:
        """A stylesheet's text with its @import and url() references folded in; <from_dir> is where it was read."""
        def imported(match: re.Match) -> str:
            ref = next((group for group in match.groups()[:5] if group), "")
            media = (match.group(6) or "").strip()
            found = self.text_file(ref, from_dir, ".css") if depth < MAX_DEPTH else None
            if not found:
                return match.group(0)
            body = self.css(found[0], found[1].parent, depth + 1)
            return f"@media {media} {{\n{body}\n}}" if media else body

        def pictured(match: re.Match) -> str:
            ref = next((group for group in match.groups() if group), "")
            uri = self.data_uri(ref, from_dir)
            return f'url("{uri}")' if uri else match.group(0)

        return CSS_URL.sub(pictured, CSS_IMPORT.sub(imported, text))

    def srcset(self, value: str) -> str:
        pieces = []
        for candidate in value.split(","):
            fields = candidate.strip().split(None, 1)
            if not fields:
                continue
            uri = self.data_uri(fields[0], self.dir)
            pieces.append(" ".join([uri or fields[0], *fields[1:]]))
        return ", ".join(pieces)


def script_safe(code: str) -> str:
    """Code that cannot close the element it is put in or start an HTML comment inside it."""
    return re.sub(r"<!--", r"<\\!--", re.sub(r"</(script)", r"<\\/\1", code, flags=re.I))


def style_safe(text: str) -> str:
    return re.sub(r"</(style)", r"<\\/\1", text, flags=re.I)


class Folder(HTMLParser):
    """Walks the document once and collects the edits (offset, length, replacement)."""

    def __init__(self, source: str, bundle: Bundle) -> None:
        super().__init__(convert_charrefs=False)
        self.source, self.bundle = source, bundle
        self.starts = [0]
        for found in re.finditer("\n", source):
            self.starts.append(found.end())
        self.edits: list[tuple[int, int, str]] = []
        self.in_style = False
        self.deferred: list[str] = []  # code of deferred and async scripts, put at the end of the body
        self.body_end: int | None = None

    def at(self) -> int:
        line, column = self.getpos()
        return self.starts[line - 1] + column

    def handle_starttag(self, tag: str, attrs: list) -> None:
        raw = self.get_starttag_text() or ""
        start = self.at()
        found = {name.lower(): (value if value is not None else "") for name, value in attrs}  # a bare attribute (defer) is there, with no value
        rel = (found.get("rel") or "").lower().split()
        if tag == "link" and "stylesheet" in rel and found.get("href"):
            got = self.bundle.text_file(found["href"], self.bundle.dir, ".css")
            if got:
                media = f' media="{html_lib.escape(found["media"], quote=True)}"' if found.get("media") else ""
                self.edits.append((start, len(raw), f"<style{media}>{style_safe(self.bundle.css(got[0], got[1].parent))}</style>"))
            return
        if tag == "script" and found.get("src"):
            if (found.get("type") or "").lower() == "module":
                self.bundle.skip(found["src"], "a module script (it needs a CORS answer, which the viewer never gave)")
                return
            got = self.bundle.text_file(found["src"], self.bundle.dir, ".js")
            if got:
                later = "defer" in found or "async" in found
                kept = " ".join(self.attribute_text(raw, name) for name in found if name not in ("src", "integrity", "crossorigin", "nonce", "defer", "async") and self.attribute_text(raw, name))
                if later:
                    # An inline script cannot be deferred, so its code runs where the document is complete, at the end of the body, in the
                    # order the scripts came; the element it came from stays as an empty one that runs nothing.
                    self.deferred.append(f"<script{' ' + kept if kept else ''}>{script_safe(got[0])}</script>")
                    self.edits.append((start, len(raw), '<script type="text/plain" data-folded="deferred">'))
                else:
                    # The code goes right after the start tag; the document's own </script> closes it.
                    self.edits.append((start, len(raw), f"<script{' ' + kept if kept else ''}>{script_safe(got[0])}"))
            return
        replaced = raw
        # Attribute values, from the end so earlier offsets stay right.
        spans = []
        for found_attribute in ATTRIBUTE.finditer(raw, 1 + len(tag)):
            name = found_attribute.group(1).lower()
            value = next((group for group in found_attribute.groups()[1:] if group is not None), None)
            if value is None:
                continue
            new = None
            if (name == "src" and (tag in ("img", "source") or (tag == "input" and (found.get("type") or "").lower() == "image"))) or (name == "poster" and tag == "video"):
                new = self.bundle.data_uri(value, self.bundle.dir)
            elif name == "srcset" and tag in ("img", "source"):
                new = self.bundle.srcset(html_lib.unescape(value))
            elif name == "href" and tag == "link" and any(word in ("icon", "shortcut", "apple-touch-icon") for word in rel):
                new = self.bundle.data_uri(value, self.bundle.dir)
            elif name == "style":
                changed = self.bundle.css(html_lib.unescape(value), self.bundle.dir)
                new = changed if changed != html_lib.unescape(value) else None
            if new is not None and new != value:
                spans.append((found_attribute.start(), found_attribute.end(), name, html_lib.escape(new, quote=True)))
        for begin, end, name, new in reversed(spans):
            replaced = replaced[:begin] + f'{name}="{new}"' + replaced[end:]
        if replaced != raw:
            self.edits.append((start, len(raw), replaced))
        if tag == "style":
            self.in_style = True

    def attribute_text(self, raw: str, name: str) -> str:
        for found_attribute in ATTRIBUTE.finditer(raw):
            if found_attribute.group(1).lower() == name:
                return found_attribute.group(0)
        return ""

    def handle_endtag(self, tag: str) -> None:
        if tag == "style":
            self.in_style = False
        elif tag == "body":
            self.body_end = self.at()

    def handle_data(self, data: str) -> None:
        if self.in_style and data:
            changed = self.bundle.css(data, self.bundle.dir)
            if changed != data:
                self.edits.append((self.at(), len(data), style_safe(changed)))

    def unknown_decl(self, data: str) -> None:  # <![CDATA[ ... ]]> and the like: left alone
        pass


def fold(entry: Path, roots: list[Path]) -> dict:
    """The document at <entry> with what it loads from beside itself folded in, and what that read:
    { text, assets: {path: [mtime_ns, size]}, inlined, skipped: [{ref, why}], bytes }."""
    bundle = Bundle(entry, roots)
    source = entry.read_text(encoding="utf-8", errors="replace")
    folder = Folder(source, bundle)
    folder.feed(source)
    folder.close()
    text = source
    if folder.deferred:
        folder.edits.append((folder.body_end if folder.body_end is not None else len(source), 0, "".join(folder.deferred)))
    # Offsets from the parser follow the characters it was fed; apply the edits from the end.
    for start, length, replacement in sorted(folder.edits, key=lambda edit: edit[0], reverse=True):
        text = text[:start] + replacement + text[start + length:]
    return {"text": text, "assets": bundle.versions, "inlined": bundle.inlined, "skipped": bundle.skipped, "bytes": bundle.used}
