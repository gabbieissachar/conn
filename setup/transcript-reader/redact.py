"""Secret redaction for the hosted copy: what the sync takes out of every object before it is encrypted.

A pattern scan for secrets, not a personal-data scan (plan section 4.7): names, emails and
partner details stay, and owner-only access and encryption carry their confidentiality.
Each match becomes [redacted:<kind>]; a private key keeps its line breaks, so the line
numbers a reply's asking lines point at stay right. Only counts are ever recorded, never
the text that matched.
"""

from __future__ import annotations

import re

# (kind, pattern, group to replace or 0 for the whole match). Order matters: a private key
# block first, so a token inside it is not counted twice.
PATTERNS = [
    # A whole key block, or one cut off before its END line (the head of a key file, a truncated
    # tool output): then to the next blank line or the end of the text.
    ("private-key", re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|(?=\n[ \t]*\n)|\Z)"), 0),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b"), 0),
    ("api-key", re.compile(r"\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}"), 0),
    ("github-token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})"), 0),
    ("gitlab-token", re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}"), 0),
    ("slack-token", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}"), 0),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), 0),
    ("bearer", re.compile(r"(?i)\bbearer\s+([A-Za-z0-9._~+/-]{8,}=*)"), 1),
    # A password in a URL (https://user:secret@host) and a secret as a query value: any length for
    # a password, 8 characters for the other names, which also name ordinary values (?key=page).
    ("url-password", re.compile(r"(?<=://)[^/\s:@'\"<>]+:([^/\s@'\"<>]+)@"), 1),
    ("url-secret", re.compile(r"(?i)[?&](?:password|passwd|pwd|pass)=([^&\s#'\"<>]+)"), 1),
    ("url-secret", re.compile(r"(?i)[?&](?:token|access_token|auth|api_key|apikey|key|secret|signature|sig)=([^&\s#'\"<>]{8,})"), 1),
    # A secret given a value anywhere: an env or .env line (PASSWORD=..., export API_TOKEN=...), an
    # ini, YAML or JSON key (db_password = ..., "token": "..."), a status line (old token=... is
    # dead). The name must end in the secret word, so TOKEN_HEADER = ... is a header's name, and
    # a $reference or a placeholder is no secret. A value's floor is in assigned() below.
    ("assigned-secret", re.compile(r"(?i)(?<![A-Za-z0-9_])((?:[A-Za-z0-9_.-]*[_.-])?(password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key))"
                                   r"[\"']?[ \t]*[:=][ \t]*([\"']?)([^\s\"'$<>{}()\[\],;`]+)\3"), 4),
    # The fleet's own per-start tokens (64 lowercase hex characters); sha256 digests go too.
    ("hex64-token", re.compile(r"(?<![0-9a-fA-F])[0-9a-f]{64}(?![0-9a-fA-F])"), 0),
]
# A password-named value is a secret from 4 characters; another name's from 6 (a word in prose).
PASSWORD_WORDS = {"password", "passwd", "passphrase", "pwd"}
PLACEHOLDER = re.compile(r"(?i)^(?:your[_-][a-z0-9_-]*|x{3,}|\*{3,}|\.{3,}|changeme|placeholder|redacted|null|none|true|false|str|string|int|bytes|optional)$")


def assigned(match) -> bool:
    """Whether an assigned-secret match names a secret value rather than a placeholder or a type."""
    value = match.group(4).rstrip(".!?:")  # a sentence's own full stop is not part of a placeholder
    floor = 4 if match.group(2).lower() in PASSWORD_WORDS else 6
    return len(value) >= floor and not PLACEHOLDER.match(value) and not value.startswith("[redacted")


def marker(kind: str, matched: str) -> str:
    return f"[redacted:{kind}]" + "\n" * matched.count("\n")


def redact_text(text: str, counts: dict[str, int]) -> str:
    """<text> with every secret replaced by its marker; adds what it found to <counts>."""
    for kind, pattern, group in PATTERNS:
        def replace(match, kind=kind, group=group):
            if kind == "assigned-secret" and not assigned(match):
                return match.group(0)
            counts[kind] = counts.get(kind, 0) + 1
            if not group:
                return marker(kind, match.group(0))
            start, end = match.span(group)
            whole = match.group(0)
            return whole[:start - match.start()] + marker(kind, match.group(group)) + whole[end - match.start():]
        text = pattern.sub(replace, text)
    return text


def redact(value, counts: dict[str, int] | None = None):
    """A copy of a JSON value with every string redacted. Keys are left as they are."""
    counts = {} if counts is None else counts
    if isinstance(value, str):
        return redact_text(value, counts)
    if isinstance(value, list):
        return [redact(item, counts) for item in value]
    if isinstance(value, dict):
        return {key: redact(item, counts) for key, item in value.items()}
    return value
