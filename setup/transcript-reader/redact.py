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
    ("private-key", re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----"), 0),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b"), 0),
    ("api-key", re.compile(r"\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}"), 0),
    ("github-token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})"), 0),
    ("gitlab-token", re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}"), 0),
    ("slack-token", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}"), 0),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), 0),
    ("bearer", re.compile(r"(?i)\bbearer\s+([A-Za-z0-9._~+/-]{20,}=*)"), 1),
    # A password in a URL (https://user:secret@host) and a secret as a query value (?token=...).
    ("url-password", re.compile(r"(?<=://)[^/\s:@'\"<>]+:([^/\s@'\"<>]+)@"), 1),
    ("url-secret", re.compile(r"(?i)[?&](?:password|passwd|pwd|pass|token|access_token|auth|api_key|apikey|key|secret|signature|sig)=([^&\s#'\"<>]{8,})"), 1),
    # An env dump or .env line: NAME=value, the name ending in a secret word, the value not a $reference.
    ("env-secret", re.compile(r"(?m)^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*=(['\"]?)([^\s'\"$][^\s'\"]{7,})\1"), 2),
    # The fleet's own per-start tokens (64 lowercase hex characters); sha256 digests go too.
    ("hex64-token", re.compile(r"(?<![0-9a-fA-F])[0-9a-f]{64}(?![0-9a-fA-F])"), 0),
]


def marker(kind: str, matched: str) -> str:
    return f"[redacted:{kind}]" + "\n" * matched.count("\n")


def redact_text(text: str, counts: dict[str, int]) -> str:
    """<text> with every secret replaced by its marker; adds what it found to <counts>."""
    for kind, pattern, group in PATTERNS:
        def replace(match, kind=kind, group=group):
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
