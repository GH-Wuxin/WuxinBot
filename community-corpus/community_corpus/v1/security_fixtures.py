"""Curated adversarial PII fixtures for the V1 security suite.

The fixture list is deliberately broader than the six leaks found in the old
300-window review. Every raw text here must never survive into a sanitized
production candidate, review sheet, log or export:

- contact identifiers: QQ, phone, email, IP, group id;
- credentials: bearer tokens, api keys, login URLs, private query params;
- identities: nicknames, real names, forwarded author names, @mentions,
  Discord / profile fields;
- re-identification vectors: QQ + osu! account pairings, invite codes.

Fixtures may carry a ``prepare`` hook so the test exercises the same
normalization path as the corpus (e.g. reply-preview stripping) before
``sanitize_text``.
"""

from __future__ import annotations

from typing import Any


def _prepare_reply(raw: str) -> str:
    from ..adapters import clean_text

    return clean_text(raw, ["-inui sana-｜吉祥物"])


SECURITY_FIXTURES: list[dict[str, Any]] = [
    {
        "name": "qq_context",
        "raw": "加我QQ：123456789",
        "must_not_contain": ["123456789"],
        "expect_types": ["qq"],
    },
    {
        "name": "qq_group",
        "raw": "osu！新人FPS群722050824",
        "must_not_contain": ["722050824"],
        "expect_types": ["qq"],
    },
    {
        "name": "phone",
        "raw": "电话 13800138000 找我",
        "must_not_contain": ["13800138000"],
        "expect_types": ["phone"],
    },
    {
        "name": "email",
        "raw": "联系我 aaa.bbb@example.com 就行",
        "must_not_contain": ["aaa.bbb@example.com"],
        "expect_types": ["email"],
    },
    {
        "name": "ip",
        "raw": "服务器 192.168.1.1 挂了",
        "must_not_contain": ["192.168.1.1"],
        "expect_types": ["ip"],
    },
    {
        "name": "bearer_token",
        "raw": "Authorization: Bearer WDE6hJQ28DEsv6cHRkRVMcSRdXnsQPp2FWNLtshr4ebFEd9YU5HxRS",
        "must_not_contain": ["WDE6hJQ28DEsv6cHRkRVMcSRdXnsQPp2FWNLtshr4ebFEd9YU5HxRS"],
        "expect_types": ["credential"],
    },
    {
        "name": "credential_url",
        "raw": (
            "https://osugaming.sekai.team/login?token="
            "WDE6hJQ28DEsv6cHRkRVMcSRdXnsQPp%2FWNLtshr4ebFEd9YU5HxRS%2BSX8rB4CqiwSfDrMO%2BAAI"
        ),
        "must_not_contain": ["token=", "WNLtshr4ebFEd9YU5HxRS"],
        "expect_types": ["credential"],
    },
    {
        "name": "api_key",
        "raw": "api_key=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
        "must_not_contain": ["sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"],
        "expect_types": ["credential"],
    },
    {
        "name": "invite_url",
        "raw": "进群 https://jq.qq.com/?_wv=1027&k=abcXYZ123456",
        "must_not_contain": ["jq.qq.com", "abcXYZ123456"],
        "expect_types": ["invite"],
    },
    {
        "name": "invite_code",
        "raw": "https://endfield.hypergryph.com/activity/x?invite_code=Z029FJ0QD59RRMM6&share_type=link",
        "must_not_contain": ["Z029FJ0QD59RRMM6"],
        "expect_types": ["invite"],
    },
    {
        "name": "private_session_param",
        "raw": "https://example.com/x?sid=abc123456789&from=group",
        "must_not_contain": ["abc123456789"],
        "expect_types": ["invite"],
    },
    {
        "name": "discord_account",
        "raw": "Discord: bget3066",
        "must_not_contain": ["bget3066"],
        "expect_types": ["profile"],
    },
    {
        "name": "profile_fields",
        "raw": "Occupation: 狂妄之人\nWebsite: https://live.bilibili.com/30286637",
        "must_not_contain": ["狂妄之人", "live.bilibili.com"],
        "expect_types": ["profile"],
    },
    {
        "name": "forward_sender_names",
        "raw": (
            "[转发消息: 13条]\n"
            "  Toriesta: 宝宝你好烧\n"
            "  佐佐佑佑: 宝宝你好烧\n"
            "  PC: 44,602"
        ),
        "must_not_contain": ["Toriesta", "佐佐佑佑"],
        "expect_types": ["nickname"],
    },
    {
        "name": "mention_bracket",
        "raw": "@[语音通话] 语音通话已结束",
        "must_not_contain": ["@[语音通话]"],
        "expect_types": ["mention"],
    },
    {
        "name": "mention_plain",
        "raw": "@mrekk 看看你bp",
        "must_not_contain": ["@mrekk"],
        "expect_types": ["mention"],
    },
    {
        "name": "id_card",
        "raw": "身份证 110101199003077777",
        "must_not_contain": ["110101199003077777"],
        "expect_types": ["private_content"],
    },
    {
        "name": "bank_card",
        "raw": "银行卡 6222020200112233445",
        "must_not_contain": ["6222020200112233445"],
        "expect_types": ["private_content"],
    },
    {
        "name": "school",
        "raw": "我是北京大学的学生",
        "must_not_contain": ["北京大学"],
        "expect_types": ["location"],
    },
    {
        "name": "company",
        "raw": "我在腾讯公司上班",
        "must_not_contain": ["腾讯公司"],
        "expect_types": ["location"],
    },
    {
        "name": "address",
        "raw": "住北京市朝阳区望京街道",
        "must_not_contain": ["北京市朝阳区望京街道"],
        "expect_types": ["location"],
    },
    {
        "name": "real_name_self",
        "raw": "我叫张三，请多指教",
        "must_not_contain": ["张三"],
        "expect_types": ["nickname"],
    },
    {
        "name": "member_osu_mapping",
        "raw": "我的QQ是123456789，osu账号是mrekk",
        "must_not_contain": ["123456789"],
        "expect_types": ["qq"],
    },
    {
        "name": "reply_preview_name",
        "raw": "[回复消息]@-inui sana-｜吉祥物 我越看越觉得ppy像是那个哥布林",
        "prepare": _prepare_reply,
        "must_not_contain": ["-inui sana-｜吉祥物", "sana-｜吉祥物"],
        "expect_types": [],
    },
]


def get_security_fixtures() -> list[dict[str, Any]]:
    """Return a copy of the fixture list for tests."""
    return [dict(f) for f in SECURITY_FIXTURES]
