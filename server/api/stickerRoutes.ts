// Sticker and random-image console routes. Extracted from server/index.ts.
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { readDb, updateDb } from '../store.js';
import {
  clearStickerDebugTraces,
  getStickerDebugState,
  listStickerDebugTraces,
  runStickerDryRun,
  setStickerDebugMode,
  type StickerDebugMode,
} from '../bot/stickers/debug.js';
import { getStickerDeliveryStats, stickerDeliveryConfig } from '../bot/stickers/delivery.js';
import { validateStickerCatalog } from '../bot/stickers/index.js';
import { randomImageDir, randomImageSnapshot } from '../bot/randomImages.js';
import { limitedText, ok } from './helpers.js';

export function mountStickerRoutes(app: Express) {// Sticker decision diagnostics stay local and in memory. They are deliberately
// separate from normal bot settings so enabling a trace cannot persist across
// a restart or silently change production behaviour.
const STICKER_DEBUG_MODES = new Set<StickerDebugMode>(['off', 'dry-run', 'trace-once']);
app.get('/api/sticker-debug', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(ok({
    debug: getStickerDebugState(),
    catalog: validateStickerCatalog(),
    delivery: getStickerDeliveryStats(),
    traces: listStickerDebugTraces(Number(req.query.limit || 20)),
  }));
});

app.get('/api/sticker-policy', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(ok({
    policy: stickerDeliveryConfig(),
    delivery: getStickerDeliveryStats(),
  }));
});

// 随机甩图的观测接口：哪些群参与、各自掷了多少次、命中几次、当前概率、最近发的是哪几张。
app.get('/api/random-image', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(ok(randomImageSnapshot(readDb())));
});

// 图池里的单张图，供控制台渲染缩略图。名字里出现路径分隔符或上级引用一律拒绝，
// 只允许图池目录下的直接文件名（字面判断，不做模式匹配）。
app.get('/api/random-image/file', (req, res) => {
  const name = String(req.query.name || '');
  const rejected = !name
    || name.includes('/') || name.includes('\\') || name.includes('..')
    || name.startsWith('.');
  if (rejected) {
    res.status(400).json({ ok: false, error: '文件名不合法' });
    return;
  }
  const dir = randomImageDir(readDb());
  const file = path.resolve(dir, name);
  if (path.dirname(file) !== path.resolve(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.status(404).json({ ok: false, error: '图不在图池里' });
    return;
  }
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(file);
});

// 图池文件名列表：控制台用来渲染缩略图网格。
app.get('/api/random-image/list', (_req, res) => {
  try {
    const dir = randomImageDir(readDb());
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((name) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)).slice(0, 120)
      : [];
    res.json(ok({ dir, files, count: files.length }));
  } catch (error) {
    res.status(500).json({ ok: false, error: String((error && error.message) || error) });
  }
});

app.post('/api/sticker-policy', (req, res) => {
  const incoming = req.body && typeof req.body === 'object' ? req.body : {};
  const mode = String(incoming.mode || '').trim();
  if (!['off', 'dry-run', 'live'].includes(mode)) {
    res.status(400).json({ ok: false, error: 'mode 必须是 off、dry-run 或 live' });
    return;
  }
  const groupIds = Array.isArray(incoming.groupIds)
    ? [...new Set(incoming.groupIds.map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 256)
    : [];
  const allGroups = incoming.allGroups === true;
  if (mode === 'live' && !allGroups && groupIds.length === 0) {
    res.status(400).json({ ok: false, error: 'live 模式必须明确指定至少一个群白名单，或显式设置 allGroups=true' });
    return;
  }
  const integer = (value, fallback, min, max) => {
    const result = value === undefined || value === null || value === '' ? fallback : Number(value);
    return Number.isInteger(result) && result >= min && result <= max ? result : null;
  };
  const current = readDb().settings.stickerPolicy || {};
  const groupCooldownSec = integer(incoming.groupCooldownSec, current.groupCooldownSec ?? 600, 0, 86_400);
  const userCooldownSec = integer(incoming.userCooldownSec, current.userCooldownSec ?? 1_200, 0, 604_800);
  const hourlyLimit = integer(incoming.hourlyLimit, current.hourlyLimit ?? 3, 0, 10_000);
  const dailyLimit = integer(incoming.dailyLimit, current.dailyLimit ?? 16, 0, 100_000);
  const userDailyLimit = integer(incoming.userDailyLimit, current.userDailyLimit ?? 4, 0, 100_000);
  const duplicateStickerCooldownSec = integer(
    incoming.duplicateStickerCooldownSec,
    current.duplicateStickerCooldownSec ?? 7_200,
    0,
    2_592_000,
  );
  if ([groupCooldownSec, userCooldownSec, hourlyLimit, dailyLimit, userDailyLimit, duplicateStickerCooldownSec].some((value) => value === null)) {
    res.status(400).json({ ok: false, error: '频率参数超出允许范围或不是整数' });
    return;
  }
  updateDb((db) => {
    db.settings.stickerPolicy = {
      mode,
      allGroups,
      groupIds,
      groupCooldownSec,
      userCooldownSec,
      hourlyLimit,
      dailyLimit,
      userDailyLimit,
      duplicateStickerCooldownSec,
    };
  });
  res.json(ok({ policy: stickerDeliveryConfig(), delivery: getStickerDeliveryStats() }));
});

app.post('/api/sticker-debug/mode', (req, res) => {
  const mode = String(req.body?.mode || '').trim() as StickerDebugMode;
  if (!STICKER_DEBUG_MODES.has(mode)) {
    res.status(400).json({ ok: false, error: 'mode 必须是 off、dry-run 或 trace-once' });
    return;
  }
  const groupId = limitedText(req.body?.groupId, 80);
  const userId = limitedText(req.body?.userId, 80);
  if (mode !== 'off' && !groupId && !userId) {
    res.status(400).json({ ok: false, error: '开启调试时必须指定 groupId 或 userId，避免影响所有消息' });
    return;
  }
  res.json(ok({ debug: setStickerDebugMode(mode, { groupId: groupId || undefined, userId: userId || undefined }) }));
});

app.delete('/api/sticker-debug/traces', (_req, res) => {
  clearStickerDebugTraces();
  res.json(ok({ debug: getStickerDebugState(), traces: [] }));
});

app.post('/api/sticker-debug/dry-run', (req, res) => {
  const stickerId = limitedText(req.body?.stickerId, 80);
  if (!stickerId) {
    res.status(400).json({ ok: false, error: '缺少 stickerId' });
    return;
  }
  try {
    const result = runStickerDryRun({
      stickerId,
      groupId: limitedText(req.body?.groupId, 80) || undefined,
      userId: limitedText(req.body?.userId, 80) || undefined,
      messageId: limitedText(req.body?.messageId, 160) || undefined,
    });
    res.status(result.ok ? 200 : 422).json(result.ok ? ok(result) : { ok: false, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: `表情包 dry-run 失败：${String(error?.message || error).slice(0, 300)}` });
  }
});
}
