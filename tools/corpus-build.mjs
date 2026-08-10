#!/usr/bin/env node
/**
 * ⚠️ LEGACY — 旧版语料构建脚本（仅作历史参考，已冻结）。
 *
 * 已被 community-corpus V1 正式取代，禁止直接接入 V1 或作为正式语料管线：
 *   python -m community_corpus.v1.cli \
 *     --sources "%USERPROFILE%\.qq-chat-exporter\exports" \
 *     --seed 20260805 --salt-file <repo-root>\community-corpus\.salt
 *
 * 正式产物位于 <repo-root>\community-corpus\（normalized/full、
 * windows/v1、reports）。本文件逻辑不再维护；如确有可迁移价值，
 * 先审阅 community_corpus/v1/* 再决定是否移植。
 */
/**
 * 从 QCE 导出的 chunked-jsonl 聊天记录构建 pippi 社区语料库。
 *
 * 输入：%USERPROFILE%\.qq-chat-exporter\exports\group_*_chunked_jsonl
 * 输出：<repo-root>\data\corpus\<groupId>.jsonl + stats.json
 *
 * 每条输出 = 一个对话窗口（按时间连续切分），供 RAG / few-shot 检索使用。
 *
 * 用法：
 *   node tools/corpus-build.mjs
 *   node tools/corpus-build.mjs --groups <groupId>,<groupId>
 *   node tools/corpus-build.mjs --exports C:\path\to\export1,C:\path\to\export2
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const DEFAULT_EXPORTS_DIR = path.join(os.homedir(), '.qq-chat-exporter', 'exports');
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = path.join(SCRIPT_DIR, '..', 'data', 'corpus');

// pippi 自己的 QQ 账号：她的历史消息是旧模板风格，不是玩家社区交流语料。
const DEFAULT_EXCLUDED_UINS = new Set(['REDACTED_QQ_002', 'REDACTED_QQ_005']);

const PURE_MEDIA_PLACEHOLDER = /^\[(图片|动画表情|表情|视频|语音|文件|回复)[：:][^\]]*\]([\s\S]*)$/;
const MEDIA_PLACEHOLDER_GLOBAL = /\[(图片|动画表情|表情|视频|语音|文件|链接)[：:][^\]]*\]/g;
const AT_LEADING = /^@[^\s]+\s*/;

function parseArgs(argv) {
  const args = {
    groups: null,
    exports: null,
    out: DEFAULT_OUTPUT_DIR,
    excludeBots: null,
    maxGapMinutes: 10,
    maxWindowMessages: 50,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--groups') args.groups = argv[++i]?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
    else if (a === '--exports') args.exports = argv[++i]?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
    else if (a === '--out') args.out = argv[++i] ?? DEFAULT_OUTPUT_DIR;
    else if (a === '--excludeBots') args.excludeBots = new Set((argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--maxGapMinutes') args.maxGapMinutes = Number(argv[++i] ?? 10);
    else if (a === '--maxWindowMessages') args.maxWindowMessages = Number(argv[++i] ?? 50);
  }
  return args;
}

function findExportDirs(args) {
  if (args.exports) {
    return args.exports.map((p) => path.resolve(p)).filter((p) => fs.existsSync(p));
  }
  if (!fs.existsSync(DEFAULT_EXPORTS_DIR)) return [];
  const dirs = fs.readdirSync(DEFAULT_EXPORTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith('_chunked_jsonl'))
    .map((d) => path.join(DEFAULT_EXPORTS_DIR, d.name));
  if (args.groups) {
    return dirs.filter((d) => args.groups.some((g) => d.includes(`group_${g}_`) || d.includes(g)));
  }
  return dirs;
}

function loadManifest(exportDir) {
  const manifestPath = path.join(exportDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function cleanText(raw) {
  let text = String(raw ?? '').replace(/\r\n/g, '\n').replace(/\u0000/g, '');
  text = text.replace(MEDIA_PLACEHOLDER_GLOBAL, '').trim();
  text = text.replace(AT_LEADING, '').trim();
  return text;
}

function isPureMedia(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return false;
  const m = text.match(PURE_MEDIA_PLACEHOLDER);
  if (!m) return false;
  return m[2] === undefined || m[2].trim() === '';
}

function toEpochMs(timestamp) {
  const n = Number(timestamp);
  if (!Number.isFinite(n)) return 0;
  return n > 1e12 ? n : n * 1000;
}

async function readChunkLines(filePath) {
  const lines = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    try {
      lines.push(JSON.parse(s));
    } catch {
      // 单行损坏丢弃（QCE 正常情况极少）
    }
  }
  return lines;
}

async function parseExport(exportDir, manifest, excludedUins, maxGapMs, maxWindowMessages) {
  const chunksDir = path.join(exportDir, 'chunks');
  const chunkFiles = fs.existsSync(chunksDir)
    ? fs.readdirSync(chunksDir).filter((f) => /^chunk_\d+\.jsonl$/.test(f)).sort()
    : [];
  if (chunkFiles.length === 0) return { messages: [], stats: null };

  // QCE chunk 按时间倒序（chunk_0001 最新）。为得到时间正序，从最后一个 chunk 反向读，chunk 内部再 reverse。
  const orderedFiles = [...chunkFiles].reverse();
  const messages = [];

  // 串行读，每 chunk 约 30-50MB，读完释放
  for (const file of orderedFiles) {
    const lines = readChunkLines(path.join(chunksDir, file));
    const list = await lines;
    list.sort((a, b) => {
      const d = toEpochMs(a.timestamp) - toEpochMs(b.timestamp);
      if (d !== 0) return d;
      return String(a.seq ?? '').localeCompare(String(b.seq ?? ''));
    });
    for (const m of list) {
      if (m.recalled || m.system || m.type === 'system') continue;
      const sender = m.sender ?? {};
      const uin = String(sender.uin ?? sender.uid ?? '');
      if (excludedUins.has(uin)) continue;
      const raw = m.content?.text ?? '';
      if (isPureMedia(raw)) continue;
      const text = cleanText(raw);
      if (!text) continue;
      messages.push({
        ts: toEpochMs(m.timestamp),
        seq: String(m.seq ?? ''),
        uin,
        name: String(sender.groupCard || sender.name || sender.nick || uin || '未知'),
        text,
      });
    }
  }
  messages.sort((a, b) => a.ts - b.ts || a.seq.localeCompare(b.seq));

  // 切对话窗口：相邻消息间隔 <= maxGapMs 为同一窗口
  const windows = [];
  let cur = [];
  let lastTs = null;
  const flush = () => {
    if (cur.length >= 2) {
      const totalChars = cur.reduce((s, m) => s + m.text.length, 0);
      if (totalChars >= 8) windows.push(cur);
    }
    cur = [];
  };
  for (const m of messages) {
    if (lastTs !== null && m.ts - lastTs > maxGapMs) flush();
    if (cur.length >= maxWindowMessages) flush();
    cur.push(m);
    lastTs = m.ts;
  }
  flush();

  return { messages, windows };
}

function buildStats(exportDir, manifest, messages, windows, excludedUins) {
  const senders = new Set();
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const m of messages) {
    senders.add(m.uin);
    if (m.ts < minTs) minTs = m.ts;
    if (m.ts > maxTs) maxTs = m.ts;
  }
  const groupId = path.basename(exportDir).match(/^group_(\d+)_/)?.[1]
    || manifest?.chatInfo?.name
    || path.basename(exportDir).replace(/^group_/, '').replace(/_chunked_jsonl$/, '');
  return {
    groupId,
    groupName: manifest?.chatInfo?.name ?? groupId,
    exportDir: path.basename(exportDir),
    totalRaw: manifest?.statistics?.totalMessages ?? null,
    keptMessages: messages.length,
    windows: windows.length,
    uniqueSenders: senders.size,
    timeRange: {
      start: minTs === Infinity ? null : new Date(minTs).toISOString(),
      end: maxTs === -Infinity ? null : new Date(maxTs).toISOString(),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const excludedUins = new Set([...DEFAULT_EXCLUDED_UINS, ...(args.excludeBots ?? [])]);
  const exportDirs = findExportDirs(args);
  if (exportDirs.length === 0) {
    console.error('未找到任何 QCE chunked-jsonl 导出目录。');
    process.exit(1);
  }

  fs.mkdirSync(args.out, { recursive: true });
  const stats = [];
  for (const exportDir of exportDirs) {
    const manifest = loadManifest(exportDir);
    const name = manifest?.chatInfo?.name ?? path.basename(exportDir);
    console.log(`[corpus] 处理 ${name} (${path.basename(exportDir)}) ...`);
    const { messages, windows } = await parseExport(
      exportDir,
      manifest,
      excludedUins,
      args.maxGapMinutes * 60_000,
      args.maxWindowMessages,
    );

    const groupId = manifest?.chatInfo?.name || path.basename(exportDir).replace(/^group_/, '').replace(/_chunked_jsonl$/, '');
    const outFile = path.join(args.out, `${groupId}.jsonl`);
    const w = fs.createWriteStream(outFile, { encoding: 'utf8' });
    for (const windowMessages of windows) {
      const record = {
        groupId,
        groupName: manifest?.chatInfo?.name ?? groupId,
        startTime: new Date(windowMessages[0].ts).toISOString(),
        endTime: new Date(windowMessages[windowMessages.length - 1].ts).toISOString(),
        messageCount: windowMessages.length,
        messages: windowMessages.map((m) => ({ name: m.name, uin: m.uin, time: new Date(m.ts).toISOString(), text: m.text })),
      };
      w.write(JSON.stringify(record) + '\n');
    }
    await new Promise((resolve, reject) => w.end((err) => (err ? reject(err) : resolve())));

    const s = buildStats(exportDir, manifest, messages, windows, excludedUins);
    stats.push(s);
    console.log(`  -> 保留 ${messages.length} 条消息 / ${windows.length} 个窗口 / ${s.uniqueSenders} 个发送者 -> ${outFile}`);
  }

  fs.writeFileSync(path.join(args.out, 'stats.json'), JSON.stringify(stats, null, 2));
  console.log(`\n[corpus] 完成，统计写入 ${path.join(args.out, 'stats.json')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
