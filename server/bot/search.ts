// Real web search adapter — independent from LLM layer.
// Currently supports SearXNG. Disabled by default (searchProvider = 'disabled').
import { readDb, updateDb, nowIso } from '../store.js';

export function getSearchConfig(db) {
  return {
    provider: db.settings.searchProvider || 'disabled',
    baseUrl: db.settings.searchBaseUrl || '',
    maxResults: Number(db.settings.searchMaxResults || 5),
    timeoutMs: Number(db.settings.searchTimeoutMs || 8000),
  };
}

export function isSearchAvailable(db) {
  const cfg = getSearchConfig(db);
  return cfg.provider !== 'disabled' && cfg.baseUrl && cfg.baseUrl.length > 0;
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
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`SearXNG returned ${resp.status}`);
      const data = await resp.json();
      results = (data.results || []).slice(0, cfg.maxResults).map((r) => ({
        title: String(r.title || '').slice(0, 200),
        url: String(r.url || ''),
        content: String(r.content || r.snippet || '').slice(0, 180),
        engine: String(r.engine || ''),
        publishedDate: String(r.publishedDate || ''),
      }));
    }

    const latencyMs = Date.now() - started;
    logSearch(db, { query, provider: cfg.provider, resultCount: results.length, error: results.length === 0 ? '无结果' : '', latencyMs, ok: true });
    return { ok: true, results, latencyMs };
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
