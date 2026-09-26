"""Offline retrieval quality test for the 24 approved V2 seed windows.

Runs a small BM25 index over the approved windows and evaluates:
1. self-recall: each window's longest human line must retrieve that window;
2. real-query retrieval: curated real player messages retrieve top-3 windows.

Output: reports/v2-eval/retrieval-results.json
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
import re
from collections import Counter

from community_corpus.v1.windows import _tokens


def _human_lines(text: str) -> list[str]:
    lines: list[str] = []
    for line in text.split("\n"):
        line = line.strip()
        line = re.sub(r"^S\d+\s*", "", line)
        if not line or line.startswith("[") or line.startswith("<"):
            continue
        if re.fullmatch(r"[\s\d\W_]+", line):
            continue
        lines.append(line)
    return lines


def _bm25(
    docs: list[tuple[str, list[str]]],
    query_tokens: set[str],
    k1: float = 1.2,
    b: float = 0.75,
) -> list[tuple[str, float]]:
    """docs: (doc_id, tokens). Returns (doc_id, score) sorted desc."""
    avg_len = sum(len(toks) for _, toks in docs) / max(1, len(docs))
    doc_freq: Counter[str] = Counter()
    for _, toks in docs:
        for tok in set(toks):
            doc_freq[tok] += 1
    n = len(docs)
    scores: list[tuple[str, float]] = []
    for doc_id, toks in docs:
        tf = Counter(toks)
        score = 0.0
        for tok in query_tokens:
            f = tf.get(tok, 0)
            if not f:
                continue
            df = doc_freq.get(tok, 0)
            idf = math.log(1 + (n - df + 0.5) / (df + 0.5))
            denom = f + k1 * (1 - b + b * len(toks) / avg_len)
            score += idf * (f * (k1 + 1)) / denom
        scores.append((doc_id, score))
    scores.sort(key=lambda x: x[1], reverse=True)
    return scores


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--candidates",
        type=pathlib.Path,
        default=pathlib.Path("reports/V2-style-ready-candidates.jsonl"),
    )
    parser.add_argument(
        "--output",
        type=pathlib.Path,
        default=pathlib.Path("reports/v2-eval/retrieval-results.json"),
    )
    args = parser.parse_args()

    recs = [
        json.loads(l)
        for l in args.candidates.read_text(encoding="utf-8").splitlines()
    ]
    approved = [r for r in recs if r.get("approved")]
    docs: list[tuple[str, list[str]]] = []
    for r in approved:
        toks = list(_tokens(r["text_sanitized"]))
        docs.append((r["window_id"], toks))

    # 1. self-recall: longest human line of each window as its own query
    self_results: dict[str, list[tuple[str, float]]] = {}
    recall1 = 0
    recall3 = 0
    for r in approved:
        lines = _human_lines(r["text_sanitized"])
        if not lines:
            continue
        query = max(lines, key=len)
        ranked = _bm25(docs, _tokens(query))
        self_results[r["window_id"]] = {
            "query": query,
            "top": [{"window_id": wid, "score": round(s, 4)} for wid, s in ranked[:5]],
        }
        if ranked and ranked[0][0] == r["window_id"]:
            recall1 += 1
        if any(wid == r["window_id"] for wid, _ in ranked[:3]):
            recall3 += 1

    # 2. real queries (curated from actual group chat, osu-flavored)
    real_queries = [
        "你们的pp都没有我稳定",
        "ACC不够星数来凑是吧",
        "96acc就吃到500pp了",
        "没事呀，你打8星fc",
        "aim烂完了",
        "听不清这个串的节奏…",
        "这fc才500",
        "一个kiai给我打力竭了",
        "这图也太几把难了",
        "我怀疑我打了的开头连2.0的内容都没到",
        "确实有点水平 一堆初见不好打的图跟我分差不多",
        "他b1甚至都不是抽的最多的图",
        "10星未遂",
        "上手打4*图打了个b",
        "ht和dt也能用",
        "这两天打少了",
        "单戳练读图，会读了就能打",
        "hd到底怎么玩",
        "212串dt就算了 还几把99acc",
        "串图想800pp只需要点开六十年",
    ]
    real_results: list[dict] = []
    for q in real_queries:
        ranked = _bm25(docs, _tokens(q))
        real_results.append(
            {
                "query": q,
                "top": [{"window_id": wid, "score": round(s, 4)} for wid, s in ranked[:3]],
            }
        )

    result = {
        "indexSize": len(approved),
        "selfRecallAt1": round(recall1 / len(approved), 4),
        "selfRecallAt3": round(recall3 / len(approved), 4),
        "selfResults": self_results,
        "realQueryCount": len(real_queries),
        "realQueries": real_results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"self recall@1={result['selfRecallAt1']} recall@3={result['selfRecallAt3']} "
        f"({len(approved)} windows) -> {args.output}"
    )


if __name__ == "__main__":
    main()
