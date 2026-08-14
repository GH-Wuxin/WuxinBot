// Real web search adapter — independent from LLM layer.
// Currently supports SearXNG. Disabled by default (searchProvider = 'disabled').
import { updateDb, nowIso } from '../store.js';

export function getSearchConfig(db) {
  return {
    enabled: db.settings.enableWebSearch !== false,
    provider: db.settings.searchProvider || 'disabled',
    baseUrl: db.settings.searchBaseUrl || '',
    maxResults: Math.max(1, Math.min(10, Number(db.settings.searchMaxResults || 5))),
    timeoutMs: Math.max(1000, Math.min(30000, Number(db.settings.searchTimeoutMs || 8000))),
  };
}

export function isSearchAvailable(db) {
  const cfg = getSearchConfig(db);
  return Boolean(cfg.enabled && cfg.provider !== 'disabled' && cfg.baseUrl && cfg.baseUrl.length > 0);
}

export function extractSearchQuery(text) {
  const original = String(text || '').trim();
  const withoutNoise = original
    .replace(/\[CQ:at,[^\]]+\]/g, ' ')
    .replace(/\[[^\]]*(?:图片|表情|视频|文件)[^\]]*\]/g, ' ');
  const cleaned = withoutNoise
    .replace(/^\s*(?:请|麻烦)?(?:你)?(?:帮我|给我)?\s*(?:上网搜|联网搜|搜索|查资料|查一下|查查|搜一下|搜搜|检索|search|帮我找|查一查|搜一搜|帮我查|帮我搜)\s*/i, '')
    .replace(/^\s*(?:请|麻烦)?(?:你)?(?:帮我|给我)\s*(?:查|搜|找)\s*(?:一下|一查|一搜)?\s*/i, '')
    .replace(/^[：:，,\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || (withoutNoise.trim() === original ? original : '');
}

export async function searchWeb(db, query) {
  const cfg = getSearchConfig(db);
  if (!isSearchAvailable(db)) return { ok: false, error: '未接入真实搜索源', results: [] };
  if (!query || query.trim().length < 2) return { ok: false, error: '搜索词过短', results: [] };

  const started = Date.now();
  let results = [];
  let error = '';

  try {
    if (cfg.provider === 'searxng') {
      const url = `${cfg.baseUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        const resp = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' }
        });
        if (!resp.ok) throw new Error(`SearXNG returned ${resp.status}`);
        const data = await resp.json();
        results = (data.results || []).slice(0, cfg.maxResults).map((r) => ({
          title: String(r.title || '').slice(0, 200),
          url: String(r.url || ''),
          content: String(r.content || r.snippet || '').slice(0, 180),
          engine: String(r.engine || ''),
          publishedDate: String(r.publishedDate || ''),
        }));
      } finally {
        clearTimeout(timer);
      }
    } else {
      throw new Error(`不支持的搜索源：${cfg.provider}`);
    }

    const latencyMs = Date.now() - started;
    const ok = results.length > 0;
    logSearch(db, { query, provider: cfg.provider, resultCount: results.length, error: ok ? '' : '无结果', latencyMs, ok });
    return { ok, results, latencyMs, error: ok ? '' : '无结果' };
  } catch (e) {
    const latencyMs = Date.now() - started;
    error = e.message || String(e);
    logSearch(db, { query, provider: cfg.provider, resultCount: 0, error, latencyMs, ok: false });
    return { ok: false, error, results: [] };
  }
}

function logSearch(db, info) {
  updateDb((draft) => {
    if (!draft.searchLogs) draft.searchLogs = [];
    draft.searchLogs.push({ ...info, createdAt: nowIso() });
    draft.searchLogs = draft.searchLogs.slice(-200);
  });
}

export function getLastSearchStatus(db) {
  const logs = db.searchLogs || [];
  return logs.length > 0 ? logs[logs.length - 1] : null;
}

export function formatSearchResults(results) {
  if (!results || results.length === 0) return '';
  return results.map((r, i) =>
    `${i + 1}. ${r.title}\n   ${r.content}\n   ${r.url}${r.publishedDate ? ' · ' + r.publishedDate : ''}`
  ).join('\n\n');
}
