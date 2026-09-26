// Knowledge base v4.1 — BM25 three-collection runtime.
//
// Design invariants:
// - `KB_ENABLED=false` is a startup-level hard veto; `settings.kb.enabled`
//   is the runtime (no-restart) master switch; a local sentinel file is the
//   last-resort machine-local kill switch. Any DB read failure fails closed.
// - Loading is lazy, single-flight and atomic. Nothing is read from disk when
//   the KB is disabled. `osu_analysis` short-circuits before any decision.
// - BM25 tokenization/scoring mirrors the Python golden implementation
//   (community-corpus/tools/v2-eval/retrieval_eval.py): k1=1.2, b=0.75,
//   idf=log(1+(N-df+0.5)/(df+0.5)), docs are unique-token sets.
// - Thresholds come exclusively from manifest `content.retrievalConfig`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readDb, lastDbReadFailureAtMs } from '../store.js';
import { routeForText, isCommandLike } from './kbRoute.js';
import { routeCollections } from './kbPrompt.js';
import { canViewCommand, resolveSummaryAudience, type CommandVisibility, type KnowledgeDocumentKind } from './commands/index.js';
import {
  type KnowledgeBaseSettings,
  type KnowledgeBaseCollectionSettings,
  type KnowledgeCollection,
  type KbEnableDecision,
  type KbHealth,
  type KbRetrievalResult,
  type KbRoute,
  type KbRuntimeInput,
  type KbDrop,
  type RetrievedKnowledgeBlock,
  type CollectionStatus,
  DEFAULT_KB_SETTINGS,
} from './knowledgeTypes.js';

const KB_VERSION_ENV = process.env.KB_ENABLED;
const KB_HARD_DISABLED = KB_VERSION_ENV === 'false';
const SENTINEL_TTL_MS = 1000;
const DB_STALE_TTL_MS = 5000;
const QUERY_MAX_MESSAGES = 5;
const QUERY_MAX_CHARS = 500;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

const KB_COLLECTIONS: KnowledgeCollection[] = ['wuxin_self', 'osu_domain', 'community_style'];

// Structural tags added by the command-doc generator (family/namespace), not
// distinctive anchors: hundreds of docs share them, so tag-anchoring on them
// would let generic matches outrank a real hand-written tag hit.
const GENERIC_TAG_ANCHORS = new Set(['command', 'osu', 'wuxin', 'quick', '快捷指令']);

const COLLECTION_SETTING_KEYS: Record<KnowledgeCollection, keyof KnowledgeBaseCollectionSettings> = {
  wuxin_self: 'wuxinSelf',
  osu_domain: 'osuDomain',
  community_style: 'communityStyle',
};

function dataDir(): string {
  return process.env.DATA_DIR
    || path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'), 'Wuxin');
}

function knowledgeDir(): string {
  return path.join(dataDir(), 'knowledge');
}

// ── Sentinel (machine-local kill switch, ≤1s TTL cache) ──

let sentinelCache: { exists: boolean; at: number } | null = null;

function sentinelExists(): boolean {
  const now = Date.now();
  if (sentinelCache && now - sentinelCache.at < SENTINEL_TTL_MS) return sentinelCache.exists;
  let exists = false;
  try {
    exists = fs.existsSync(path.join(knowledgeDir(), 'DISABLED'));
  } catch {
    // Detection errors also fail closed (treat as disabled).
    exists = true;
  }
  sentinelCache = { exists, at: now };
  return exists;
}

// ── Tokenizer / BM25 (Python-golden compatible) ──

// v3: include 2-letter osu! acronyms (PP/AR/HD/HR/DT/OD/CS/FC/...). Pure
// digit runs stay excluded so QQ numbers / scores cannot become tokens.
// Generic question/connective CJK bigrams are dropped as stopwords: they carry
// no domain meaning but get high IDF in a small knowledge corpus (e.g. a doc
// matching only "和有" or "是什/什么" must not outrank a doc matching "bonus+pp").
const TOKEN_WORD_RE = /[a-z]{2,}/g;
const CJK_RE = /[\u4e00-\u9fa5]/g;
const STOPWORD_CJK_BIGRAMS = new Set(['怎么', '什么', '是什', '为什', '和有']);

function normalizeTag(tag: string): string {
  return String(tag || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

export function kbTokenize(text: string): Set<string> {
  const t = String(text || '').toLowerCase();
  const tokens = new Set<string>();
  for (const m of t.matchAll(TOKEN_WORD_RE)) tokens.add(m[0]);
  const cjk = t.match(CJK_RE) || [];
  for (let i = 0; i + 1 < cjk.length; i += 1) {
    const bigram = cjk[i] + cjk[i + 1];
    if (!STOPWORD_CJK_BIGRAMS.has(bigram)) tokens.add(bigram);
  }
  return tokens;
}

interface Bm25Doc {
  id: string;
  title?: string;
  tags: string[];
  tokens: string[];
  visibility?: CommandVisibility;
  documentKind?: KnowledgeDocumentKind;
}

interface Bm25Index {
  collection: KnowledgeCollection;
  docs: Bm25Doc[];
  docById: Map<string, Bm25Doc>;
  df: Map<string, number>;
  avgLen: number;
  n: number;
}

function buildIndex(collection: KnowledgeCollection, docs: { id: string; title?: string; content: string; tags?: string[] }[]): Bm25Index {
  const converted: Bm25Doc[] = docs.map((d) => ({
    id: d.id,
    title: d.title,
    tags: (d.tags || []).map((tag) => String(tag).toLowerCase()),
    tokens: [...kbTokenize(d.content)],
    ...((d as any).visibility ? { visibility: (d as any).visibility } : {}),
    ...((d as any).documentKind ? { documentKind: (d as any).documentKind } : {}),
  }));
  const df = new Map<string, number>();
  for (const doc of converted) {
    for (const tok of new Set(doc.tokens)) df.set(tok, (df.get(tok) || 0) + 1);
  }
  const n = converted.length;
  const avgLen = n > 0 ? converted.reduce((sum, d) => sum + d.tokens.length, 0) / n : 0;
  return {
    collection,
    docs: converted,
    docById: new Map(converted.map((d) => [d.id, d])),
    df,
    avgLen,
    n,
  };
}

function scoreDoc(index: Bm25Index, doc: Bm25Doc, queryTokens: Set<string>): number {
  const docSet = new Set(doc.tokens);
  let score = 0;
  for (const tok of queryTokens) {
    if (!docSet.has(tok)) continue;
    const df = index.df.get(tok) || 0;
    if (df <= 0) continue;
    const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
    const denom = 1 + BM25_K1 * (1 - BM25_B + BM25_B * (doc.tokens.length / Math.max(1, index.avgLen)));
    score += idf * (BM25_K1 + 1) / denom;
  }
  return score;
}

export interface CollectionRetrievalConfig {
  topK: number;
  minScore: number;
  minScoreGap?: number;
  minDistinctQueryTokens?: number;
  requireLexicalOverlap?: boolean;
}

// ── Manifest / version directory ──

interface KbManifest {
  content: {
    schemaVersion: number;
    tokenizerVersion: string;
    queryBuilderVersion: number;
    bm25: { k1: number; b: number; idf: string };
    retrievalConfig: Record<KnowledgeCollection, CollectionRetrievalConfig>;
    collections: Record<KnowledgeCollection, { docCount: number; sha256: string }>;
    outputSha256: string;
  };
  build: { generatedAt: string; generatorGitCommit: string };
}

interface LoadedCollection {
  index: Bm25Index;
  docs: { id: string; title?: string; content: string; tags?: string[] }[];
}

interface LoadedKb {
  contentSha: string;
  manifest: KbManifest;
  collections: Partial<Record<KnowledgeCollection, LoadedCollection>>;
}

let loaded: LoadedKb | null = null;
let loadFailedAt = 0;
let lastLoadError = '';
let loadedAtIso: string | null = null;
let lastLoadFailLogAt = 0;

const collectionState: Record<KnowledgeCollection, { status: CollectionStatus; docCount: number; errorCode?: string }> = {
  wuxin_self: { status: 'disabled', docCount: 0 },
  osu_domain: { status: 'disabled', docCount: 0 },
  community_style: { status: 'disabled', docCount: 0 },
};

let lastDecision: KbEnableDecision | null = null;

// ── Startup build snapshot (no hot reload) ──
//
// At process startup we read `CURRENT` exactly once and fix the buildId.
// Later database switches may enable the KB, but the process only ever loads
// this pinned build; `CURRENT` changes after startup are ignored until the
// next process start. KB_ENABLED=false skips even this read.
let pinnedBuildSha: string | null = null;
let pinAttempted = false;
let pinError: string | null = null;

function pinBuildOnce(): void {
  if (KB_HARD_DISABLED || pinAttempted) return;
  pinAttempted = true;
  try {
    const currentPath = path.join(knowledgeDir(), 'CURRENT');
    if (!fs.existsSync(currentPath)) {
      pinError = 'KB_CURRENT_MISSING';
      return;
    }
    const contentSha = fs.readFileSync(currentPath, 'utf8').trim();
    if (!/^[a-f0-9]{16,128}$/.test(contentSha)) {
      pinError = 'KB_CURRENT_INVALID';
      return;
    }
    pinnedBuildSha = contentSha;
  } catch (error) {
    pinError = String(error?.message || error);
  }
}

pinBuildOnce();

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function canonicalContentJson(content: unknown): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)]),
      );
    }
    return value;
  };
  return JSON.stringify(sort(content));
}

function parseCollectionFile(
  buildDir: string,
  collection: KnowledgeCollection,
  expectedSha: string,
  expectedCount: number,
): { id: string; title?: string; content: string; tags?: string[] }[] | null {
  const fileName = collection === 'community_style' ? 'community_style.jsonl' : `${collection}.json`;
  const filePath = path.join(buildDir, fileName);
  if (!fs.existsSync(filePath)) return null;
  if (sha256File(filePath) !== expectedSha) return null;

  if (collection === 'community_style') {
    const rows = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    if (rows.length !== expectedCount) return null;
    return rows.map((row) => ({
      id: String(row.id),
      title: row.title,
      content: String(row.content || ''),
      ...(Array.isArray(row.tags) ? { tags: row.tags.map(String) } : {}),
    }));
  }

  const rows = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(rows) || rows.length !== expectedCount) return null;
  return rows.map((row) => ({
    id: String(row.id),
    title: row.title,
    content: String(row.content || ''),
    ...(Array.isArray(row.tags) ? { tags: row.tags.map(String) } : {}),
    ...(row.visibility ? { visibility: String(row.visibility) as CommandVisibility } : {}),
    ...(row.documentKind ? { documentKind: String(row.documentKind) as KnowledgeDocumentKind } : {}),
    ...(row.source ? { source: row.source } : {}),
  }));
}

function loadKbSync(): LoadedKb {
  pinBuildOnce();
  if (!pinnedBuildSha) throw new Error(pinError || 'KB_CURRENT_MISSING');
  const contentSha = pinnedBuildSha;
  const buildDir = path.join(knowledgeDir(), 'builds', contentSha);
  const manifestPath = path.join(buildDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('KB_MANIFEST_MISSING');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as KbManifest;
  if (manifest?.content?.schemaVersion !== 1) throw new Error('KB_SCHEMA_VERSION');
  if (
    !manifest.content.retrievalConfig?.wuxin_self
    || !manifest.content.retrievalConfig?.osu_domain
    || !manifest.content.retrievalConfig?.community_style
  ) {
    throw new Error('KB_RETRIEVAL_CONFIG_MISSING');
  }
  if (manifest.content.tokenizerVersion !== 'v3-cjk-bigram' || manifest.content.queryBuilderVersion !== 1) {
    throw new Error('KB_VERSION_MISMATCH');
  }
  const recomputedContentSha = crypto.createHash('sha256').update(canonicalContentJson(manifest.content), 'utf8').digest('hex');
  if (recomputedContentSha !== contentSha) throw new Error('KB_CONTENT_HASH_MISMATCH');

  const collections: Partial<Record<KnowledgeCollection, LoadedCollection>> = {};
  for (const collection of KB_COLLECTIONS) {
    const meta = manifest.content.collections?.[collection];
    if (!meta) throw new Error(`KB_COLLECTION_META_MISSING:${collection}`);
    const docs = parseCollectionFile(buildDir, collection, meta.sha256, meta.docCount);
    if (docs === null) throw new Error(`KB_COLLECTION_HASH_MISMATCH:${collection}`);
    collections[collection] = { index: buildIndex(collection, docs), docs };
  }
  return { contentSha, manifest, collections };
}

function loadOnce(): { ok: boolean; error?: string } {
  if (loaded) return { ok: true };
  try {
    const next = loadKbSync();
    loaded = next;
    loadedAtIso = new Date().toISOString();
    for (const collection of KB_COLLECTIONS) {
      const state = collectionState[collection];
      const loadedCollection = next.collections[collection];
      state.status = loadedCollection ? 'ready' : 'failed';
      state.docCount = loadedCollection?.index.n || 0;
      state.errorCode = loadedCollection ? undefined : 'KB_COLLECTION_NOT_LOADED';
    }
    loadFailedAt = 0;
    lastLoadError = '';
    return { ok: true };
  } catch (error) {
    loaded = null;
    loadFailedAt = Date.now();
    lastLoadError = String(error?.message || error);
    for (const collection of KB_COLLECTIONS) {
      collectionState[collection].status = 'failed';
      collectionState[collection].errorCode = lastLoadError;
    }
    return { ok: false, error: lastLoadError };
  }
}

// ── Enable decision ──

function rolloutAllowed(settings: KnowledgeBaseSettings, groupId?: string, messageType?: string): boolean {
  const rollout = settings.rollout || DEFAULT_KB_SETTINGS.rollout;
  if (rollout.mode === 'all') return true;
  if (rollout.mode === 'allowlist') {
    if (messageType === 'private') return rollout.privateMessagesEnabled === true;
    return Boolean(groupId && rollout.groupIds.includes(String(groupId)));
  }
  return false;
}

export function decideKbEnabled(input: {
  settings?: KnowledgeBaseSettings;
  groupId?: string;
  messageType?: string;
}): KbEnableDecision {
  if (KB_HARD_DISABLED) {
    lastDecision = { enabled: false, source: 'env' };
    return lastDecision;
  }
  if (sentinelExists()) {
    lastDecision = { enabled: false, source: 'sentinel' };
    return lastDecision;
  }

  let settings = input.settings;
  if (!settings) {
    try {
      settings = readDb().settings?.kb as KnowledgeBaseSettings | undefined;
    } catch {
      lastDecision = { enabled: false, source: 'db_unavailable' };
      return lastDecision;
    }
    // readDb() auto-recovers a corrupt db.json, so a "successful" read can
    // still mean the DB was unavailable moments ago. Fail closed (and label
    // the decision db_unavailable) until the recovery is older than the stale
    // TTL; after that the recovered db is treated as the live configuration.
    if (lastDbReadFailureAtMs() !== 0 && Date.now() - lastDbReadFailureAtMs() <= DB_STALE_TTL_MS) {
      lastDecision = { enabled: false, source: 'db_unavailable' };
      return lastDecision;
    }
  }
  if (!settings || settings.enabled !== true) {
    lastDecision = { enabled: false, source: 'db' };
    return lastDecision;
  }
  const collections = settings.collections || DEFAULT_KB_SETTINGS.collections;
  if (!(collections.wuxinSelf || collections.osuDomain || collections.communityStyle)) {
    lastDecision = { enabled: false, source: 'collection' };
    return lastDecision;
  }
  if (!rolloutAllowed(settings, input.groupId, input.messageType)) {
    lastDecision = { enabled: false, source: 'rollout' };
    return lastDecision;
  }
  lastDecision = { enabled: true, source: 'db' };
  return lastDecision;
}

// ── Query builder (A8, queryBuilderVersion=1) ──

const PRIVACY_STRIP_RES = [
  /\[CQ:at,qq=\d+(?:,[^\]]*)?\]/g,
  /\b\d{8,12}\b/g,
  /https?:\/\/\S+/gi,
  /www\.\S+/gi,
];

function sanitizeQueryText(value: string): string {
  let result = String(value || '').replace(/\s+/g, ' ').trim();
  for (const re of PRIVACY_STRIP_RES) result = result.replace(re, ' ');
  return result.replace(/\[(?:图片|表情包?|视频|语音|文件|动画表情)[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isPureCommandOrMedia(content: string): boolean {
  const value = String(content || '').trim();
  if (!value) return true;
  if (isCommandLike(value)) return true;
  if (/^\[(?:图片|表情包?|视频|语音|文件|动画表情)[^\]]*\]$/.test(value)) return true;
  return false;
}

export function buildKbQueryText(
  currentText: string,
  contextMessages: { role?: string; userId?: string | number; content?: string }[] = [],
): string {
  const selected: string[] = [];
  let used = 0;
  for (let i = contextMessages.length - 1; i >= 0 && selected.length < QUERY_MAX_MESSAGES; i -= 1) {
    const message = contextMessages[i];
    const role = String(message.role || '');
    const userId = String(message.userId ?? '');
    if (role === 'assistant' || userId === 'bot' || String(userId).toLowerCase() === 'bot') continue;
    const content = sanitizeQueryText(message.content || '');
    if (!content || isPureCommandOrMedia(content)) continue;
    if (selected.length > 0 && used + content.length > QUERY_MAX_CHARS) break;
    selected.unshift(content);
    used += content.length;
  }
  selected.push(sanitizeQueryText(currentText));
  return selected.join('\n---\n');
}

// ── Retrieval ──

function retrieveCollection(
  loadedCollection: LoadedCollection,
  config: CollectionRetrievalConfig,
  queryTokens: Set<string>,
  filter?: {
    permissions: { isOwner: boolean; isAdmin: boolean };
    documentKinds?: KnowledgeDocumentKind[];
    summaryDocId?: string;
  },
): { blocks: RetrievedKnowledgeBlock[]; dropped: KbDrop[] } {
  const dropped: KbDrop[] = [];
  const index = loadedCollection.index;
  if (index.n === 0) return { blocks: [], dropped };
  let candidates = index.docs;
  if (filter) {
    candidates = index.docs.filter((doc) => {
      const visible = canViewCommand(doc.visibility || 'public', filter.permissions);
      const kindOk = filter.documentKinds
        ? filter.documentKinds.includes(doc.documentKind || 'command')
          && (!filter.summaryDocId || doc.id === filter.summaryDocId)
        : true;
      if (!visible) dropped.push({ documentId: doc.id, reason: 'visibility_filter' });
      else if (!kindOk) dropped.push({ documentId: doc.id, reason: 'document_kind_filter' });
      return visible && kindOk;
    });
  }
  const scored = candidates.map((doc) => ({ doc, score: scoreDoc(index, doc, queryTokens) }));
  // Authoritative tag anchors: if the query contains a curated doc tag, select
  // by tag first (score > 0 guarantees lexical overlap). Tags are hand-written
  // per document, so a tag hit is a stronger signal than BM25 score — this
  // prevents generic CJK bigrams (e.g. 什么/怎么) from outranking a real match
  // like "bonus+pp", and prevents one-token noise (e.g. HT doc matching "BPM").
  const tagMatched = scored
    .filter((item) => item.score > 0 && [...queryTokens].some((tok) => !GENERIC_TAG_ANCHORS.has(tok) && item.doc.tags.some((tag) => normalizeTag(tag) === tok)))
    .sort((a, b) => b.score - a.score);
  if (tagMatched.length > 0) {
    const topK = Math.max(1, config.topK || 1);
    const selected = tagMatched.slice(0, topK);
    for (const item of tagMatched.slice(topK)) dropped.push({ documentId: item.doc.id, reason: 'topk' });
    for (const item of scored) {
      if (!tagMatched.includes(item)) dropped.push({ documentId: item.doc.id, reason: 'no_tag_match' });
    }
    return {
      blocks: selected.map((item) => ({
        collection: loadedCollection.index.collection,
        documentId: item.doc.id,
        title: item.doc.title,
        text: loadedCollection.docs.find((d) => d.id === item.doc.id)?.content || '',
        score: item.score,
      })),
      dropped,
    };
  }
  const minTokens = config.minDistinctQueryTokens ?? 1;
  if (queryTokens.size < minTokens) {
    dropped.push({ documentId: '*', reason: `query_tokens_${queryTokens.size}<${minTokens}` });
    return { blocks: [], dropped };
  }
  const minScore = config.minScore || 0;
  const keptScored = scored.filter((item) => {
    if (item.score <= 0) {
      dropped.push({ documentId: item.doc.id, reason: 'no_lexical_overlap' });
      return false;
    }
    if (item.score < minScore) {
      dropped.push({ documentId: item.doc.id, reason: 'below_min_score' });
      return false;
    }
    return true;
  });
  if (config.requireLexicalOverlap === false) {
    // Explicitly allowed: score 0 docs could be kept, but BM25 semantics in
    // this runtime keep overlap as an invariant; nothing to do here.
  }
  let kept = keptScored.sort((a, b) => b.score - a.score); // stable in modern JS → Python tie-break parity
  const gap = config.minScoreGap ?? 0;
  if (gap > 0 && kept.length >= 2 && kept[0].score - kept[1].score < gap) {
    for (let i = 1; i < kept.length; i += 1) {
      dropped.push({ documentId: kept[i].doc.id, reason: 'score_gap' });
    }
    kept = kept.slice(0, 1);
  }
  const topK = Math.max(1, config.topK || 1);
  const blocks = kept.slice(0, topK).map((item) => ({
    collection: loadedCollection.index.collection,
    documentId: item.doc.id,
    title: item.doc.title,
    text: loadedCollection.docs.find((d) => d.id === item.doc.id)?.content || '',
    score: item.score,
  }));
  for (const item of kept.slice(topK)) dropped.push({ documentId: item.doc.id, reason: 'topk' });
  return { blocks, dropped };
}

function groupHash(groupId?: string): string {
  if (!groupId) return '';
  return crypto.createHash('sha256').update(String(groupId), 'utf8').digest('hex').slice(0, 16);
}

function logKbUsage(meta: Record<string, unknown>): void {
  console.log('[kb] ' + JSON.stringify(meta));
}

export function retrieveKnowledgeForPrompt(input: KbRuntimeInput): KbRetrievalResult {
  const started = Date.now();
  const scene = String(input.scene || 'casual');
  if (scene === 'osu_analysis') {
    return {
      route: { kind: 'none', reason: 'analysis_scene_zero_inject' },
      decision: { enabled: false, source: 'scene' },
      blocks: [],
      dropped: [],
      elapsedMs: 0,
    };
  }

  const decision = decideKbEnabled({
    settings: input.settings,
    groupId: input.groupId,
    messageType: input.messageType,
  });
  const route: KbRoute = routeForText(scene, input.text || '');
  if (!decision.enabled) {
    return { route, decision, blocks: [], dropped: [], elapsedMs: 0 };
  }
  if (route.kind === 'none') {
    logKbUsage({
      route: route.kind,
      reason: route.reason,
      decisionSource: decision.source,
      groupHash: groupHash(input.groupId),
      elapsedMs: Date.now() - started,
    });
    return { route, decision, blocks: [], dropped: [], elapsedMs: Date.now() - started };
  }

  const loadResult = loadOnce();
  if (!loadResult.ok || !loaded) {
    // Rate-limit config-error logging: a broken build must not spam the log
    // on every message. Error code stays visible in health.
    const now = Date.now();
    if (now - lastLoadFailLogAt >= 60_000) {
      lastLoadFailLogAt = now;
      logKbUsage({
        route: route.kind,
        reason: 'load_failed',
        errorCode: loadResult.error || 'KB_LOAD_FAILED',
        decisionSource: decision.source,
        groupHash: groupHash(input.groupId),
        elapsedMs: Date.now() - started,
      });
    }
    return { route, decision, blocks: [], dropped: [{ documentId: '*', reason: 'load_failed' }], elapsedMs: Date.now() - started };
  }

  const queryText = buildKbQueryText(input.text || '', input.contextMessages || []);
  const queryTokens = kbTokenize(queryText);
  const blocks: RetrievedKnowledgeBlock[] = [];
  const dropped: KbDrop[] = [];
  const collectionCalls: string[] = [];
  const settings = input.settings || (readDb().settings?.kb as KnowledgeBaseSettings | undefined);
  const collectionsEnabled = settings?.collections || DEFAULT_KB_SETTINGS.collections;
  const plans = routeCollections(route);
  const permissions = input.permissions || { isOwner: false, isAdmin: false };
  const summaryDocId = route.kind === 'capability_summary'
    ? `summary:all:${resolveSummaryAudience(permissions)}`
    : undefined;

  for (const plan of plans) {
    const enabled = collectionsEnabled[COLLECTION_SETTING_KEYS[plan.collection]];
    const loadedCollection = loaded.collections[plan.collection];
    if (!enabled) {
      dropped.push({ documentId: '*', reason: `collection_disabled:${plan.collection}` });
      continue;
    }
    if (!loadedCollection) {
      dropped.push({ documentId: '*', reason: `collection_not_loaded:${plan.collection}` });
      continue;
    }
    const config = loaded.manifest.content.retrievalConfig[plan.collection];
    const filter = plan.collection === 'wuxin_self'
      ? {
          permissions,
          documentKinds: route.kind === 'capability_summary'
            ? (['capability_summary'] as KnowledgeDocumentKind[])
            : (['command', 'boundary'] as KnowledgeDocumentKind[]),
          ...(summaryDocId ? { summaryDocId } : {}),
        }
      : undefined;
    const result = retrieveCollection(loadedCollection, config, queryTokens, filter);
    blocks.push(...result.blocks);
    dropped.push(...result.dropped);
    collectionCalls.push(`${plan.collection}:${result.blocks.length}`);
  }

  logKbUsage({
    route: route.kind,
    reason: route.reason,
    decisionSource: decision.source,
    groupHash: groupHash(input.groupId),
    collections: collectionCalls,
    documentIds: blocks.map((b) => `${b.collection}:${b.documentId}`),
    scores: blocks.map((b) => Number(b.score.toFixed(4))),
    dropped: dropped.slice(0, 12).map((d) => d.reason),
    injectedChars: blocks.reduce((sum, b) => sum + b.text.length, 0),
    elapsedMs: Date.now() - started,
  });
  return { route, decision, blocks, dropped, elapsedMs: Date.now() - started };
}

// ── Health ──

export function getKbHealth(): KbHealth {
  const collections = {} as KbHealth['collections'];
  for (const collection of KB_COLLECTIONS) {
    collections[collection] = { ...collectionState[collection] };
  }
  return {
    decision: lastDecision,
    collections,
    contentSha: loaded?.contentSha || null,
    loadedAt: loadedAtIso,
    buildGeneratedAt: loaded?.manifest?.build?.generatedAt || null,
    retrievalConfigVersion: loaded?.manifest?.content?.queryBuilderVersion ?? null,
  };
}

export function resetKbForTests(): void {
  loaded = null;
  loadFailedAt = 0;
  lastLoadError = '';
  loadedAtIso = null;
  lastLoadFailLogAt = 0;
  sentinelCache = null;
  lastDecision = null;
  pinnedBuildSha = null;
  pinAttempted = false;
  pinError = null;
  for (const collection of KB_COLLECTIONS) {
    collectionState[collection] = { status: 'disabled', docCount: 0 };
  }
  pinBuildOnce();
}

export function kbSentinelPathForTests(): string {
  return path.join(knowledgeDir(), 'DISABLED');
}

export function kbKnowledgeDirForTests(): string {
  return knowledgeDir();
}

/**
 * Raw BM25 search (no min-score/topK filtering) — used by the golden
 * TS-vs-Python comparison and debugging. Scores are rounded to 4 decimals to
 * match the Python reference output.
 */
export function kbRawSearch(
  collection: KnowledgeCollection,
  query: string,
  topN = 10,
): { documentId: string; score: number }[] {
  loadOnce();
  if (!loaded || !loaded.collections[collection]) return [];
  const index = loaded.collections[collection]!.index;
  const tokens = kbTokenize(query);
  const ranked = index.docs.map((doc) => ({ documentId: doc.id, score: scoreDoc(index, doc, tokens) }));
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, topN).map((item) => ({ documentId: item.documentId, score: Number(item.score.toFixed(4)) }));
}

export { DB_STALE_TTL_MS, loadFailedAt, lastLoadError };
