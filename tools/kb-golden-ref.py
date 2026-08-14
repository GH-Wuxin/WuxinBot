"""Golden BM25 reference for the WuxinBot knowledge base (v4.1).

Reads the built three-collection corpus and computes the exact Python scores
used by community-corpus/tools/v2-eval/retrieval_eval.py. The TS runtime must
match this output (tokens, df, idf, scoring, tie-break).

Usage:
  python tools/kb-golden-ref.py --knowledge-root <dir> --queries q.json --output out.json

q.json: [{"id": "...", "collection": "wuxin_self|osu_domain|community_style", "query": "..."}]
out.json: [{"id": "...", "collection": "...", "query": "...", "top": [{"documentId": "...", "score": 1.2345}]}]
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import re
from collections import Counter


_TOKEN_WORD_RE = re.compile(r"[a-z]{2,}")
_CJK_RE = re.compile(r"[\u4e00-\u9fa5]")
_STOPWORD_CJK_BIGRAMS = {"怎么", "什么", "是什", "为什", "和有"}


def _tokens(text: str) -> set[str]:
    t = (text or "").lower()
    words = set(_TOKEN_WORD_RE.findall(t))
    cjk = _CJK_RE.findall(t)
    bigrams = {
        cjk[i] + cjk[i + 1]
        for i in range(len(cjk) - 1)
        if cjk[i] + cjk[i + 1] not in _STOPWORD_CJK_BIGRAMS
    }
    return words | bigrams


def _bm25(docs: list[tuple[str, list[str]]], query_tokens: set[str]) -> list[tuple[str, float]]:
    k1 = 1.2
    b = 0.75
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


def load_collection(knowledge_root: pathlib.Path, collection: str) -> list[tuple[str, list[str]]]:
    if collection == "community_style":
        rows = [
            json.loads(line)
            for line in (knowledge_root / "community_style.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    else:
        rows = json.loads((knowledge_root / f"{collection}.json").read_text(encoding="utf-8"))
    return [(str(row["id"]), list(_tokens(str(row.get("content", ""))))) for row in rows]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--knowledge-root", type=pathlib.Path, required=True)
    parser.add_argument("--queries", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()

    queries = json.loads(args.queries.read_text(encoding="utf-8"))
    results = []
    for item in queries:
        collection = item["collection"]
        docs = load_collection(args.knowledge_root / "builds" / (args.knowledge_root / "CURRENT").read_text(encoding="utf-8").strip(), collection)
        ranked = _bm25(docs, _tokens(item["query"]))
        results.append(
            {
                "id": item["id"],
                "collection": collection,
                "query": item["query"],
                "top": [{"documentId": doc_id, "score": round(score, 4)} for doc_id, score in ranked[:10]],
            }
        )
    args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"golden ok: {len(results)} queries")


if __name__ == "__main__":
    main()
