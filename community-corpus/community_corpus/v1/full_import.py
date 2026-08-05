"""Task 1: full normalization of all QCE messages into normalized/full/.

V0's 50k-sample messages.parquet is frozen and never touched.
"""

from __future__ import annotations

import json
import pathlib
import re
from typing import Any, Iterable

import pyarrow as pa
import pyarrow.parquet as pq

from ..adapters import ParseError, clean_text, parse_qce_line
from ..anonymize import hash_group_id, hash_sender_id, hash_mention_id
from ..config import Config
from ..pii import detect_pii
EXPORT_DIR_RE = re.compile(r"^group_(.+?)_\d{8}_\d{6}_chunked_jsonl$")
CHUNK_FILE_RE = re.compile(r"^chunk_\d+\.jsonl$")
BOT_UINS = {
    # current pippi/WuxinBot host account (bot replies come from it)
    "REDACTED_QQ_002",
    # legacy per-bot accounts present in the exported group histories
    "1708547915",  # 忧郁小猫猫 (kanon/猫猫 bot)
    "1902931474",  # KQN (查分 bot)
    "3311470495",  # 天使果果喵 (Lazybot)
    "3145729213",  # 雨沐 (临时运行)
    "3889016014",  # 雨沐 (原版)
    "2818054860",  # 小幽幽子 (character roleplay bot)
    "3889001246",  # 幽幽子 (group feature bot)
    "3929371650",  # Nikaidou Shinku (查分/图片 bot)
    "1750011571",  # ATRI1024 (replay/avatar bot)
    "1078589506",  # 全自助火化机 (hydrant-style pp+/查分 bot)
    "814992458",  # 遠野幻想物語 (查分 bot)
    "1335734629",  # 白菜V2.1 (recent-score card bot)
    "1020640876",  # 白菜V2.1 (binding error bot)
    "2225126759",  # Lazybot测试机
}

# Content-level bot-output patterns. A message matching one of these is a
# bot's rendered output that the export stored as a plain text message
# (e.g. hydrant personal-info queries pasted/sent through a host account).
# Keep patterns tight: full template + structure, not single keywords.
BOT_OUTPUT_PATTERNS = [
    re.compile(
        r"(?:^|\n)[^\n]*的个人信息—(?:osu!|mania|taiko|catch)\n{1,2}\s*\d+(?:\.\d+)?\s*pp",
        re.MULTILINE,
    ),
    re.compile(
        r"^[^\n]*的 replay (?:轨迹|检测)\n相似度: [-+]?\d+(?:\.\d+)?%",
        re.MULTILINE,
    ),
    re.compile(r"^少女祈祷中\.\.\.$", re.MULTILINE),
    re.compile(
        r"^主要数据已更新完毕，pp\+数据正在后台更新，请稍后使用info功能查看结果。$",
        re.MULTILINE,
    ),
    re.compile(r"^[^\n]*头像已更新$", re.MULTILINE),
    re.compile(r"^[^\n]*的bp类型\nAim:", re.MULTILINE),
    re.compile(r"正在获取pp\+数据，请稍等"),
    re.compile(r"\[内联键盘\]\[Markdown消息\]"),
    re.compile(r"^用户查询：\n!info/recent/bp/get", re.MULTILINE),
    re.compile(r"^\[Lazybot\]", re.MULTILINE),
    re.compile(r"^下图为您的PP\+最好成绩", re.MULTILINE),
    re.compile(r"^您已经猜中以下谱面：", re.MULTILINE),
    re.compile(r"^最飞升：", re.MULTILINE),
    re.compile(r"CNY [\d,]+\s*\nJPY [\d,]+", re.MULTILINE),
    re.compile(r"^根据 BP 关联度，在 osu! 模式给 [^\n]*推荐的图如下：", re.MULTILINE),
]


def is_bot_output_like(text: str) -> bool:
    return any(p.search(text) for p in BOT_OUTPUT_PATTERNS)


def find_source_exports(sources: Iterable[str]) -> list[pathlib.Path]:
    found: list[pathlib.Path] = []
    for raw in sources:
        p = pathlib.Path(raw)
        if not p.exists():
            raise FileNotFoundError(f"source not found: {p}")
        if (p / "chunks").is_dir() and (p / "manifest.json").is_file():
            found.append(p)
            continue
        for child in sorted(p.iterdir()):
            if child.is_dir() and EXPORT_DIR_RE.match(child.name) and (child / "chunks").is_dir():
                found.append(child)
    return sorted(set(found), key=lambda p: str(p))


def group_id_from_dir(export_dir: pathlib.Path) -> str:
    m = EXPORT_DIR_RE.match(export_dir.name)
    return m.group(1) if m else export_dir.name


def run_full_import(cfg: Config) -> dict[str, Any]:
    """Import all messages from all source exports.

    Uses the same salt as V0 (config.salt) so hashes are stable across V0/V1.
    Output: <output>/normalized/full/messages.parquet
    """
    exports = find_source_exports(cfg.sources)
    out_dir = cfg.normalized_dir / "full"
    out_dir.mkdir(parents=True, exist_ok=True)

    batches: list[pa.Table] = []
    batch_rows: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    type_counts: dict[str, int] = {}
    per_source: dict[str, dict[str, Any]] = {}
    unique_message_ids: set[str] = set()
    reply_count = 0
    media_count = 0
    bot_count = 0
    system_count = 0
    recalled_count = 0
    pii_message_count = 0
    pii_type_counts: dict[str, int] = {}
    bot_output_like_count = 0
    total_lines = 0
    total_messages = 0
    min_ts: int | None = None
    max_ts: int | None = None
    def flush():
        nonlocal batch_rows
        if not batch_rows:
            return
        batches.append(pa.Table.from_pylist(batch_rows, schema=_schema()))
        batch_rows = []

    for export_dir in exports:
        group_id = group_id_from_dir(export_dir)
        group_hash = hash_group_id(cfg.salt, group_id)
        chunks_dir = export_dir / "chunks"
        src_stat: dict[str, Any] = {
            "exportDir": export_dir.name,
            "groupId": group_id,
            "groupHash": group_hash,
            "messages": 0,
            "failures": 0,
            "timeStartMs": None,
            "timeEndMs": None,
        }
        for chunk in sorted(chunks_dir.iterdir()):
            if not CHUNK_FILE_RE.match(chunk.name):
                continue
            rel = f"chunks/{chunk.name}"
            with chunk.open("r", encoding="utf-8", newline="") as f:
                line_no = 0
                while True:
                    byte_offset = f.tell()
                    line = f.readline()
                    if not line:
                        break
                    line_no += 1
                    total_lines += 1
                    if not line.strip():
                        continue
                    try:
                        rec = parse_qce_line(line)
                    except ParseError as exc:
                        failures.append(
                            {
                                "source_file": rel,
                                "source_offset": line_no,
                                "source_offset_bytes": byte_offset,
                                "error": str(exc),
                                "preview": line[:160],
                            }
                        )
                        src_stat["failures"] += 1
                        continue
                    sender_id = rec.sender_uin or rec.sender_uid
                    sender_hash = hash_sender_id(cfg.salt, sender_id)
                    mention_hashes = [hash_mention_id(cfg.salt, m) for m in rec.mentions if m]
                    text_clean = clean_text(rec.text_raw, list(rec.reply_sender_names))
                    has_pii, pii_types = detect_pii(rec.text_raw)
                    row: dict[str, Any] = {
                        "message_id": rec.message_id,
                        "group_id_hash": group_hash,
                        "sender_id_hash": sender_hash,
                        "timestamp": rec.timestamp_ms,
                        "seq": rec.seq,
                        "reply_to_id": rec.reply_to_id,
                        "message_type": rec.message_type,
                        "text_raw": rec.text_raw,
                        "text_clean": text_clean,
                        "mentions": mention_hashes,
                        "media_type": ",".join(rec.media_types) if rec.media_types else "none",
                        "has_media": len(rec.media_types) > 0,
                        "is_bot": sender_id in BOT_UINS,
                        "is_system": rec.system,
                        "bot_output_like": is_bot_output_like(rec.text_raw),
                        "recalled": rec.recalled,
                        "has_pii": has_pii,
                        "pii_types": pii_types,
                        "source_file": rel,
                        "source_offset": line_no,
                        "source_offset_bytes": byte_offset,
                        "source_export": export_dir.name,
                    }
                    batch_rows.append(row)
                    total_messages += 1
                    unique_message_ids.add(rec.message_id)
                    if rec.reply_to_id:
                        reply_count += 1
                    if row["has_media"]:
                        media_count += 1
                    if row["is_bot"]:
                        bot_count += 1
                    if row["is_system"]:
                        system_count += 1
                    if row["recalled"]:
                        recalled_count += 1
                    if row["has_pii"]:
                        pii_message_count += 1
                    if row["bot_output_like"]:
                        bot_output_like_count += 1
                    for pt in row["pii_types"]:
                        pii_type_counts[pt] = pii_type_counts.get(pt, 0) + 1
                    type_counts[rec.message_type] = type_counts.get(rec.message_type, 0) + 1
                    src_stat["messages"] += 1
                    min_ts = rec.timestamp_ms if min_ts is None else min(min_ts, rec.timestamp_ms)
                    max_ts = rec.timestamp_ms if max_ts is None else max(max_ts, rec.timestamp_ms)
                    src_stat["timeStartMs"] = (
                        rec.timestamp_ms
                        if src_stat["timeStartMs"] is None
                        else min(src_stat["timeStartMs"], rec.timestamp_ms)
                    )
                    src_stat["timeEndMs"] = (
                        rec.timestamp_ms
                        if src_stat["timeEndMs"] is None
                        else max(src_stat["timeEndMs"], rec.timestamp_ms)
                    )
                    if len(batch_rows) >= 50_000:
                        flush()
        per_source[group_id] = src_stat

    flush()
    if not batches:
        raise RuntimeError("no messages imported")
    table = pa.concat_tables(batches)
    pq.write_table(table, out_dir / "messages.parquet")

    result = {
        "totalLines": total_lines,
        "totalMessages": total_messages,
        "uniqueMessages": len(unique_message_ids),
        "parquetRows": table.num_rows,
        "unknownMessages": type_counts.get("unknown", 0),
        "typeCounts": type_counts,
        "perSource": per_source,
        "parseFailures": failures,
        "parseFailureCount": len(failures),
        "timeStartMs": min_ts,
        "timeEndMs": max_ts,
        "replyMessages": reply_count,
        "mediaMessages": media_count,
        "botMessages": bot_count,
        "systemMessages": system_count,
        "recalledMessages": recalled_count,
        "piiMessages": pii_message_count,
        "piiTypeCounts": dict(sorted(pii_type_counts.items())),
        "botOutputLikeMessages": bot_output_like_count,
    }
    write_full_import_report(cfg, result)
    return result


def write_full_import_report(cfg: Config, result: dict[str, Any]) -> pathlib.Path:
    """Write reports/full-import-report.json from the full-import result."""
    cfg.reports_dir.mkdir(parents=True, exist_ok=True)
    out = cfg.reports_dir / "full-import-report.json"
    report = {
        "schemaVersion": "v1",
        "summary": {
            "totalLines": result["totalLines"],
            "totalMessages": result["totalMessages"],
            "uniqueMessages": result["uniqueMessages"],
            "parquetRows": result["parquetRows"],
            "unknownMessages": result["unknownMessages"],
            "replyMessages": result["replyMessages"],
            "mediaMessages": result["mediaMessages"],
            "botMessages": result["botMessages"],
            "systemMessages": result["systemMessages"],
            "recalledMessages": result["recalledMessages"],
            "piiMessages": result["piiMessages"],
            "botOutputLikeMessages": result["botOutputLikeMessages"],
            "timeStartMs": result["timeStartMs"],
            "timeEndMs": result["timeEndMs"],
            "parseFailureCount": result["parseFailureCount"],
        },
        "typeCounts": result["typeCounts"],
        "piiTypeCounts": result["piiTypeCounts"],
        "perSource": result["perSource"],
        "parseFailures": result["parseFailures"][:500],
    }
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


def _schema() -> pa.Schema:
    return pa.schema(
        [
            pa.field("message_id", pa.string()),
            pa.field("group_id_hash", pa.string()),
            pa.field("sender_id_hash", pa.string()),
            pa.field("timestamp", pa.int64()),
            pa.field("seq", pa.string()),
            pa.field("reply_to_id", pa.string()),
            pa.field("message_type", pa.string()),
            pa.field("text_raw", pa.string()),
            pa.field("text_clean", pa.string()),
            pa.field("mentions", pa.list_(pa.string())),
            pa.field("media_type", pa.string()),
            pa.field("has_media", pa.bool_()),
            pa.field("is_bot", pa.bool_()),
            pa.field("is_system", pa.bool_()),
            pa.field("bot_output_like", pa.bool_()),
            pa.field("recalled", pa.bool_()),
            pa.field("has_pii", pa.bool_()),
            pa.field("pii_types", pa.list_(pa.string())),
            pa.field("source_file", pa.string()),
            pa.field("source_offset", pa.int64()),
            pa.field("source_offset_bytes", pa.int64()),
            pa.field("source_export", pa.string()),
        ]
    )
