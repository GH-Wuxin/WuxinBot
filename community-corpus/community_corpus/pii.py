"""Basic PII detection. Original records are kept; PII is only flagged."""

from __future__ import annotations

import re


QQ_RE = re.compile(r"(?<!\d)[1-9]\d{4,11}(?!\d)")
PHONE_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def detect_pii(text: str) -> tuple[bool, list[str]]:
    """Return (has_pii, matched_types). Types: qq, phone, email."""
    types: list[str] = []
    if not text:
        return False, types
    if QQ_RE.search(text):
        types.append("qq")
    if PHONE_RE.search(text):
        types.append("phone")
    if EMAIL_RE.search(text):
        types.append("email")
    return bool(types), types
