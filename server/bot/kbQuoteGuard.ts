// Knowledge base v4.1 — community-style quote guard (A9).
//
// Flags long verbatim reuse of approved community windows for manual review.
// Generic community phrases are ignored. This is a review aid, never an
// automatic rejection.

export interface QuoteFlag {
  sourceId: string;
  sourceLine: string;
  matched: string;
  length: number;
}

const GENERIC_PHRASES = new Set([
  '笑死',
  '我跪了',
  '我跪',
  '跪了',
  '666',
  '？',
  '?',
  '草',
  '这也能活',
  '你先别急',
]);

const DEFAULT_MIN_MATCH = 12;

function longestCommonSubstring(a: string, b: string): string {
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  let best = '';
  const len = short.length;
  for (let start = 0; start < len; start += 1) {
    let k = 0;
    for (let i = start; i < len; i += 1) {
      if (long.includes(short.slice(start, i + 1))) {
        k = i - start + 1;
        if (k > best.length) best = short.slice(start, i + 1);
      } else {
        break;
      }
    }
  }
  return best;
}

function normalizedLines(text: string): string[] {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^S\d+\s*/, '').trim())
    .filter(Boolean);
}

export function flagCommunityQuotes(
  output: string,
  corpus: { id: string; content: string }[],
  minMatch: number = DEFAULT_MIN_MATCH,
): QuoteFlag[] {
  const flags: QuoteFlag[] = [];
  const outLines = normalizedLines(output);
  for (const doc of corpus) {
    for (const sourceLine of normalizedLines(doc.content)) {
      if (sourceLine.length < minMatch) continue;
      for (const outLine of outLines) {
        if (outLine.length < minMatch) continue;
        const match = longestCommonSubstring(outLine, sourceLine);
        if (match.length < minMatch) continue;
        if (GENERIC_PHRASES.has(match)) continue;
        flags.push({ sourceId: doc.id, sourceLine, matched: match, length: match.length });
      }
    }
  }
  return flags;
}
