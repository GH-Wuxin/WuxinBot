"""Task 4: text sanitization and PII risk classification.

Principles:
- raw text (text_raw) stays local for traceability only;
- sanitized text replaces phone/email/invite/ip/credential/qq-in-context/
  nickname/@mention/location patterns;
- bare number sequences are NOT removed: beatmap ids, pp, rank, acc, dates
  must survive;
- high-risk content that cannot be safely rewritten becomes
  <PRIVATE_CONTENT>.
"""

from __future__ import annotations

import re
from typing import Any


PLACEHOLDER_CREDENTIAL = "<CREDENTIAL>"
PLACEHOLDER_PHONE = "<PHONE>"
PLACEHOLDER_EMAIL = "<EMAIL>"
PLACEHOLDER_IP = "<IP>"
PLACEHOLDER_INVITE = "<INVITE>"
PLACEHOLDER_QQ = "<QQ_NUMBER>"
PLACEHOLDER_MENTION = "<MENTION>"
PLACEHOLDER_NICK = "<NICK>"
PLACEHOLDER_LOCATION = "<LOCATION>"
PLACEHOLDER_PROFILE = "<PROFILE>"
PLACEHOLDER_PRIVATE = "<PRIVATE_CONTENT>"


OSU_TERMS = {
    "auto",
    "dt",
    "hd",
    "hr",
    "nc",
    "ht",
    "ez",
    "nf",
    "fl",
    "so",
    "pf",
    "sd",
    "fc",
    "ss",
    "acc",
    "pp",
    "nm",
    "ar",
    "od",
    "cs",
    "hp",
    "bpm",
    "map",
    "maps",
    "stream",
    "jump",
    "aim",
    "speed",
    "flow",
    "precision",
    "stamina",
    "score",
    "rank",
    "combo",
    "miss",
    "slider",
    "spinner",
    "circle",
    "beatmap",
    "mania",
    "taiko",
    "catch",
    "std",
    "osu",
    "star",
    "stars",
    "skill",
    "playcount",
    "recent",
    "top",
}


_PHONE_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_IP_RE = re.compile(r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)")
_INVITE_RE = re.compile(
    r"(?:https?://)?(?:jq\.qq\.com|qun\.qq\.com|qq\.com/(?:group|s))[\w./?=&%+#-]*",
    re.IGNORECASE,
)
_QQ_CONTEXT_RE = re.compile(
    r"(?i)(?:[qｑ][qｑ]{1,2}|企鹅|群号|加群|好友|qq群|q群|加我|联系方式)[ \t]*[:：]?[ \t]*(?:是|为|号|群)?[ \t]*(\d{5,12})"
)
_ID_CARD_RE = re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")
_CREDENTIAL_RE = re.compile(
    r"(?i)(?:\bsk-[A-Za-z0-9_-]{8,}\b"
    r"|\bbearer\s+[A-Za-z0-9._-]{10,}"
    r"|\b(?:api[_-]?key|password|passwd|secret|token)\s*[=:]\s*[A-Za-z0-9._@#%+/=-]{8,})"
)
_CREDENTIAL_URL_RE = re.compile(
    r"(?i)\bhttps?://[^\s<>\"']*(?:login|oauth|account|auth|passport|signin|token)[^\s<>\"']*"
)
_MENTION_RE = re.compile(r"@(?:\[[^\]]+\]|[\w\u4e00-\u9fa5-]+)")
_LOCATION_RE = re.compile(
    r"[\u4e00-\u9fa5]{2,20}(?:大学|学院|学校|中学|小学)"
    r"|[\u4e00-\u9fa5]{2,15}(?:公司|集团|有限公司|工作室|单位)"
    r"|[\u4e00-\u9fa5]{2,12}(?:省|市|区|县|镇|路|街|巷|大道|小区|大厦|花园)[\u4e00-\u9fa50-9]{0,12}(?:号|栋|楼|幢)?"
)
_CARD_RE = re.compile(
    r"(?i)(?:银行卡|信用卡|卡号|账户|帐号)[:：]?\s*\d{12,19}"
)
_QQ_GROUP_RE = re.compile(r"(?<!\d)群[ \t]*[:：]?[ \t]*(\d{5,12})(?!\d)")
_PROFILE_FIELD_RE = re.compile(
    r"(?im)^[ \t]*(?:discord|website|occupation|location|interests|twitter|youtube|"
    r"bilibili|直播间)[ \t]*[:：][ \t]*[^\n]{1,120}$"
)
_UNIQUE_PARAM_RE = re.compile(
    r"(?i)([?&](?:invite_?code|join_?code|referral_?code|share_?code|reg_?code|"
    r"invitation_?code|invite|code|token|key|sid|session|auth|ticket|sign)=)"
    r"[A-Za-z0-9._%+/-]{6,}"
)
_REAL_NAME_RE = re.compile(
    r"(?i)(?:我叫|真名|本名|名字叫|全名|实名)[ \t]*[:：]?[ \t]*"
    r"([\u4e00-\u9fa5·]{2,8})"
)
_FORWARD_BLOCK_START_RE = re.compile(r"\[(?:转发消息|Forwarded Messages)\s*[:：]\s*\d+\s*条?\]")
_FORWARD_NAME_LINE_RE = re.compile(
    r"^(\s{1,8})([A-Za-z0-9_·•.\u4e00-\u9fa5｜|\- ]{1,40}): "
)


def _looks_like_person_name(name: str) -> bool:
    """True when a forward line prefix looks like a sender display name.

    Forwarded profiles contain all-caps stat labels (PC/PT/TTH/SS/ID/...);
    those must survive untouched. Real QQ display names normally contain CJK,
    lowercase ASCII, digits, or separator punctuation.
    """
    n = name.strip()
    if not n:
        return False
    if re.search(r"[\u4e00-\u9fa5]", n):
        return True
    if re.search(r"[a-z]", n):
        return True
    if re.search(r"[_·•|｜]", n):
        return True
    if re.search(r"[0-9]", n) and len(n) >= 4:
        return True
    return False


def _redact_forward_names(text: str) -> tuple[str, bool]:
    """Replace original sender names inside forwarded-message blocks.

    QCE forward payloads embed ``昵称: 内容`` lines that are not covered by
    the window speaker map, so their names are redacted to ``<NICK>``.
    """
    lines = text.split("\n")
    in_block = False
    changed = False
    for i, line in enumerate(lines):
        if _FORWARD_BLOCK_START_RE.search(line):
            in_block = True
            continue
        if not in_block:
            continue
        if not line.strip():
            continue
        m = _FORWARD_NAME_LINE_RE.match(line)
        if m and _looks_like_person_name(m.group(2)):
            lines[i] = m.group(1) + PLACEHOLDER_NICK + ": " + line[m.end() :]
            changed = True
            continue
    return "\n".join(lines), changed


def _redact(text: str) -> tuple[str, set[str]]:
    """Apply replacements. Returns (text, pii_types)."""
    pii: set[str] = set()
    original = text

    # high risk: whole-message redaction when a private number cannot be
    # safely rewritten in place.
    if _ID_CARD_RE.search(text) or _CARD_RE.search(text):
        return PLACEHOLDER_PRIVATE, {"private_content"}

    if _CREDENTIAL_URL_RE.search(text):
        text = _CREDENTIAL_URL_RE.sub(PLACEHOLDER_CREDENTIAL, text)
        pii.add("credential")

    if _CREDENTIAL_RE.search(text):
        text = _CREDENTIAL_RE.sub(PLACEHOLDER_CREDENTIAL, text)
        pii.add("credential")

    if _PHONE_RE.search(text):
        text = _PHONE_RE.sub(PLACEHOLDER_PHONE, text)
        pii.add("phone")

    if _EMAIL_RE.search(text):
        text = _EMAIL_RE.sub(PLACEHOLDER_EMAIL, text)
        pii.add("email")

    if _IP_RE.search(text):
        text = _IP_RE.sub(PLACEHOLDER_IP, text)
        pii.add("ip")

    if _INVITE_RE.search(text):
        text = _INVITE_RE.sub(PLACEHOLDER_INVITE, text)
        pii.add("invite")

    if _UNIQUE_PARAM_RE.search(text):
        text = _UNIQUE_PARAM_RE.sub(lambda m: m.group(1) + PLACEHOLDER_INVITE, text)
        pii.add("invite")

    if _REAL_NAME_RE.search(text):
        text = _REAL_NAME_RE.sub(
            lambda m: m.group(0).replace(m.group(1), PLACEHOLDER_NICK), text
        )
        pii.add("nickname")

    if _QQ_CONTEXT_RE.search(text):
        text = _QQ_CONTEXT_RE.sub(lambda m: m.group(0).replace(m.group(1), PLACEHOLDER_QQ), text)
        pii.add("qq")

    if _QQ_GROUP_RE.search(text):
        text = _QQ_GROUP_RE.sub(
            lambda m: m.group(0).replace(m.group(1), PLACEHOLDER_QQ), text
        )
        pii.add("qq")

    if _PROFILE_FIELD_RE.search(text):
        text = _PROFILE_FIELD_RE.sub(PLACEHOLDER_PROFILE, text)
        pii.add("profile")

    if _MENTION_RE.search(text):
        text = _MENTION_RE.sub(PLACEHOLDER_MENTION, text)
        pii.add("mention")

    text, forward_changed = _redact_forward_names(text)
    if forward_changed:
        pii.add("nickname")

    if _LOCATION_RE.search(text):
        text = _LOCATION_RE.sub(PLACEHOLDER_LOCATION, text)
        pii.add("location")

    return text, pii


def _replace_nicknames(text: str, nick_map: dict[str, str]) -> tuple[str, set[str]]:
    """Replace in-window speaker nicknames with S# placeholders.

    Nicknames that are also osu terms are left untouched to avoid mangling
    game language. Returns (text, pii_types).
    """
    pii: set[str] = set()
    for name in sorted(nick_map, key=len, reverse=True):
        name = name.strip()
        if len(name) < 2:
            continue
        low = name.lower()
        if low in OSU_TERMS:
            continue
        escaped = re.escape(name)
        # avoid replacing inside longer identifiers/words for ASCII names
        if name.isascii():
            pattern = rf"(?<![A-Za-z0-9]){escaped}(?![A-Za-z0-9])"
        else:
            pattern = escaped
        if re.search(pattern, text):
            text = re.sub(pattern, nick_map[name], text)
            pii.add("nickname")
    # safety net: a nickname replaced inside an @-mention leaves @S# behind
    if re.search(r"@S\d+", text):
        text = re.sub(r"@S\d+", PLACEHOLDER_MENTION, text)
        pii.add("mention")
    return text, pii


def sanitize_text(
    text: str,
    nick_map: dict[str, str] | None = None,
) -> tuple[str, list[str], str, str]:
    """Sanitize one message text.

    Returns (sanitized, pii_types, confidence, privacy_risk).
    confidence/risk: low | medium | high.
    """
    nick_map = nick_map or {}
    text, pii = _redact(text)
    text, nick_pii = _replace_nicknames(text, nick_map)
    pii |= nick_pii

    pii_set = set(pii)
    if not pii_set:
        return text, [], "low", "low"

    high = {"phone", "credential", "private_content"}
    medium = {"email", "ip", "invite", "qq", "location", "nickname", "mention", "profile"}
    if pii_set & high:
        confidence = "high"
        risk = "high"
    elif pii_set & medium:
        confidence = "medium"
        risk = "medium"
    else:
        confidence = "low"
        risk = "low"
    return text, sorted(pii_set), confidence, risk


def window_text(messages: list[dict[str, Any]]) -> tuple[str, list[str], str, str]:
    """Build text_sanitized for a window.

    Each message is rendered as ``S# <sanitized text>`` where S# is a stable
    label for the sender within the window.
    """
    speakers = sorted({m["sender_id_hash"] for m in messages})
    label_of = {h: f"S{speakers.index(h) + 1}" for h in speakers}
    nick_of: dict[str, str] = {}
    for m in messages:
        nick = m.get("sender_name") or ""
        if nick:
            nick_of[nick] = label_of[m["sender_id_hash"]]

    parts: list[str] = []
    pii_all: set[str] = set()
    confidences: list[str] = []
    for m in messages:
        label = label_of[m["sender_id_hash"]]
        text = m.get("text_clean") or ""
        sanitized, types, confidence, risk = sanitize_text(text, nick_of)
        parts.append(f"{label} {sanitized}")
        pii_all.update(types)
        confidences.append(confidence)

    joined = "\n".join(parts)
    if not pii_all:
        return joined, [], "low", "low"
    risk_rank = {"low": 0, "medium": 1, "high": 2}
    conf = max(confidences, key=lambda c: risk_rank.get(c, 0))
    risk = "high" if any(c == "high" for c in confidences) else (
        "medium" if any(c == "medium" for c in confidences) else "low"
    )
    return joined, sorted(pii_all), conf, risk
