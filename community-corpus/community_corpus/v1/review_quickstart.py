"""Generate a quick-start guide for the V1 manual review.

This is a review aid only: it groups the 300-window sample by category and
flags the windows most likely to need a closer look (high privacy risk,
media-dependent, command-heavy, bot-output). It never changes the sample or
the corpus.

Output: reports/manual-review-v1-quickstart.md
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys


COMMAND_PREFIX_RE = re.compile(r"^[!！/／~～@＠]")
TRIGGER_RE = re.compile(r"^(?:查@|@|查看|查询)")


def _counts(lines: list[dict]) -> dict[str, int]:
    bot = sum(1 for l in lines if l.get("role") == "bot")
    system = sum(1 for l in lines if l.get("role") == "system")
    human = sum(1 for l in lines if l.get("role") == "human")
    human_text = sum(
        1 for l in lines if l.get("role") == "human" and (l.get("text") or "").strip()
    )
    command_lines = sum(
        1
        for l in lines
        if l.get("role") == "human"
        and (COMMAND_PREFIX_RE.match((l.get("text") or "").strip())
             or TRIGGER_RE.match((l.get("text") or "").strip()))
    )
    return {
        "bot": bot,
        "system": system,
        "human": human,
        "human_text": human_text,
        "command_lines": command_lines,
    }


def build_quickstart(
    review_path: pathlib.Path,
    annotated_path: pathlib.Path,
    out_path: pathlib.Path,
) -> int:
    with review_path.open("r", encoding="utf-8") as f:
        rows = [json.loads(line) for line in f]
    ann = {}
    with annotated_path.open("r", encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            ann[rec["window_id"]] = rec
    rows.sort(key=lambda r: (r["group_id_hash"], r["start_timestamp"], r["window_id"]))

    high_risk = [r for r in rows if r["privacy_risk"] == "high"]
    media_dep = [r for r in rows if r["media_dependent"]]
    flagged: list[dict] = []
    for r in rows:
        lines = ann.get(r["window_id"], {}).get("annotated_lines", [])
        c = _counts(lines)
        if c["human_text"] == 0:
            r["flag_reason"] = "no_human_text"
            flagged.append(r)
            continue
        ratio = c["command_lines"] / c["human_text"]
        if ratio > 0.5:
            r["flag_reason"] = f"command_heavy({ratio:.0%})"
            flagged.append(r)
            continue
        if c["bot"] > 0 and c["human_text"] < 2:
            r["flag_reason"] = "bot_output_low_reaction"
            flagged.append(r)

    lines_out: list[str] = []
    lines_out.append("# V1 人工审核快速指引")
    lines_out.append("")
    lines_out.append(f"样本：300 个窗口（{len(rows)} 行记录），固定种子 20260805。")
    lines_out.append("")
    lines_out.append("## 审核方式")
    lines_out.append("")
    lines_out.append(
        "1. 打开 manual-review-v1-review-sheet.csv（UTF-8 BOM），每行一个窗口。"
    )
    lines_out.append(
        "2. 看 annotated_lines 列：S# 是窗口内发言者编号；[bot] 是 bot 输出，"
        "[system] 是系统消息，[human] 是真人；media:xxx 表示带媒体。"
    )
    lines_out.append(
        "3. 末尾五列打分：understandable / effective_interaction / "
        "trigger_reply_correct 填 1 或 0；bot_system_spam_only 和 privacy_leak "
        "正常填 0；notes 可写备注。"
    )
    lines_out.append("")
    lines_out.append("## 验收标准（300 条统计口径）")
    lines_out.append("")
    lines_out.append("- 可独立理解（understandable=1）占比 >= 80%")
    lines_out.append("- 有效互动（effective_interaction=1）占比 >= 75%")
    lines_out.append("- 触发/回复关系正确（trigger_reply_correct=1）占比 >= 95%")
    lines_out.append("- 纯 bot/系统/刷屏窗口（bot_system_spam_only=1）占比 <= 5%")
    lines_out.append("- 高风险隐私泄露（privacy_leak=1）必须为 0")
    lines_out.append("")
    lines_out.append("## 当前样本统计（供参考，不替代人工判定）")
    lines_out.append("")
    lines_out.append(
        f"- 高风险窗口：{len(high_risk)} 条（已全部纳入，必须逐条确认隐私泄露=0）"
    )
    lines_out.append(
        f"- 媒体依赖窗口（图片/视频触发，文本无法复原）：{len(media_dep)} 条"
    )
    lines_out.append(
        f"- 无真人文字窗口：{sum(1 for r in flagged if r.get('flag_reason') == 'no_human_text')} 条"
    )
    lines_out.append("")
    lines_out.append("## 建议优先审核")
    lines_out.append("")
    lines_out.append("### 高风险（隐私）")
    lines_out.append("")
    lines_out.append(
        ", ".join(r["window_id"] for r in high_risk[:50])
        if high_risk
        else "（无）"
    )
    lines_out.append("")
    lines_out.append("### 可能难独立理解（媒体依赖）")
    lines_out.append("")
    lines_out.append(
        ", ".join(r["window_id"] for r in media_dep[:50]) if media_dep else "（无）"
    )
    lines_out.append("")
    lines_out.append("### 命令密集/低反应候选")
    lines_out.append("")
    cand = [r for r in flagged if r.get("flag_reason") not in (None, "no_human_text")]
    lines_out.append(
        ", ".join(f"{r['window_id']}({r['flag_reason']})" for r in cand[:50])
        if cand
        else "（无）"
    )
    lines_out.append("")
    lines_out.append("## 审核结果反馈")
    lines_out.append("")
    lines_out.append(
        "把打分后的 CSV 发回来，或直接告诉我总体结论/不合格窗口类型；"
        "我会按结果决定是否迭代管线。"
    )
    lines_out.append("")

    out_path.write_text("\n".join(lines_out), encoding="utf-8")
    return len(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="community-corpus-review-quickstart")
    parser.add_argument("--review", type=pathlib.Path, default=pathlib.Path("reports/manual-review-v1.jsonl"))
    parser.add_argument("--annotated", type=pathlib.Path, default=pathlib.Path("reports/manual-review-v1-annotated.jsonl"))
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("reports/manual-review-v1-quickstart.md"))
    args = parser.parse_args(argv)
    n = build_quickstart(args.review, args.annotated, args.output)
    print(f"[review-quickstart] {n} windows -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
