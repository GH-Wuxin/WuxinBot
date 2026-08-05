"""HMAC-based anonymization of group and member identifiers."""

from __future__ import annotations

import hashlib
import hmac


def _digest(salt: str, kind: str, value: str) -> str:
    if not value:
        return ""
    payload = f"{kind}:{value}".encode("utf-8")
    return hmac.new(salt.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def hash_group_id(salt: str, group_id: str) -> str:
    return _digest(salt, "group", group_id)


def hash_sender_id(salt: str, sender_id: str) -> str:
    return _digest(salt, "sender", sender_id)


def hash_mention_id(salt: str, mention_id: str) -> str:
    return _digest(salt, "mention", mention_id)
