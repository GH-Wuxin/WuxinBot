// Message cleaning utilities.
// Extracted from bot.ts — pure text-processing functions with zero imports.

export function decodeCqValue(value) {
  return String(value || '')
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

export function parseCqParams(raw) {
  const body = String(raw || '').replace(/^\[CQ:[^,]+,?/, '').replace(/\]$/, '');
  const params = {};
  for (const pair of body.split(',')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    params[pair.slice(0, index)] = decodeCqValue(pair.slice(index + 1));
  }
  return params;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

function findCardText(value, keys) {
  if (!value || typeof value !== 'object') return '';
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findCardText(child, keys);
      if (found) return found;
    }
  }
  return '';
}

function compactCardText(text) {
  // QQ mini-app titles often contain nested labels like "[QQ小程序]".
  // Card placeholders are bracket-based too, so flatten inner brackets before
  // storing them. Otherwise memory cleaning can mistake the tail of a card
  // title for real user text.
  return String(text || '')
    .replace(/\[QQ小程序\]/gi, 'QQ小程序 ')
    .replace(/[\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 42);
}

export function cardPlaceholder(title, desc) {
  const cleanTitle = compactCardText(title);
  const cleanDesc = compactCardText(desc);
  if (cleanTitle && cleanDesc && cleanDesc !== cleanTitle) return `[分享卡片：${cleanTitle} / ${cleanDesc}]`;
  if (cleanTitle) return `[分享卡片：${cleanTitle}]`;
  if (cleanDesc) return `[分享卡片：${cleanDesc}]`;
  return '[分享卡片]';
}

function summarizeJsonCard(data) {
  if (typeof data !== 'object') {
    const decoded = decodeCqValue(data);
    const parsedText = safeJsonParse(decoded);
    if (!parsedText) {
      const prompt = decoded.match(/"prompt"\s*:\s*"([^"]+)/)?.[1];
      const desc = decoded.match(/"(?:summary|desc|description)"\s*:\s*"([^"]+)/)?.[1];
      return cardPlaceholder(prompt, desc);
    }
    data = parsedText;
  }
  const parsed = data;
  const title = findCardText(parsed, ['title', 'name', 'prompt', 'desc']);
  const desc = findCardText(parsed, ['summary', 'description', 'content', 'text', 'tag']);
  return cardPlaceholder(title, desc);
}

function summarizeXmlCard(data) {
  const text = String(data || '');
  const title =
    text.match(/title=["']([^"']+)["']/i)?.[1] ||
    text.match(/<title>([^<]+)<\/title>/i)?.[1] ||
    text.match(/name=["']([^"']+)["']/i)?.[1];
  const desc =
    text.match(/desc=["']([^"']+)["']/i)?.[1] ||
    text.match(/summary=["']([^"']+)["']/i)?.[1] ||
    text.match(/brief=["']([^"']+)["']/i)?.[1] ||
    text.match(/<desc>([^<]+)<\/desc>/i)?.[1];
  return cardPlaceholder(title, desc);
}

function summarizeCardPart(part) {
  if (part.type === 'json') return summarizeJsonCard(part.data?.data || part.data);
  if (part.type === 'xml') return summarizeXmlCard(part.data?.data || part.data);
  if (part.type === 'forward') return cardPlaceholder(part.data?.title || part.data?.name, part.data?.summary || part.data?.content);
  return '[分享卡片]';
}

function summarizeCqCard(kind, raw) {
  const params = parseCqParams(raw);
  if (kind === 'json') return summarizeJsonCard(params.data || params.content || params.resid || raw);
  if (kind === 'xml') return summarizeXmlCard(params.data || params.content || raw);
  return cardPlaceholder(params.title || params.name, params.summary || params.content || params.id);
}

function compactImageInput(data = {}) {
  const url = String(data.url || data.file_url || data.src || data.download_url || '').trim();
  const file = String(data.file || data.file_id || data.path || data.name || '').trim();
  if (!url && !file) return null;
  return { type: 'image', url, file };
}

export function extractImageInputs(message) {
  const images = [];
  const seen = new Set();
  const add = (input) => {
    const item = compactImageInput(input);
    if (!item) return;
    const key = item.url || item.file;
    if (seen.has(key)) return;
    seen.add(key);
    images.push(item);
  };

  if (Array.isArray(message)) {
    for (const part of message) {
      if (part?.type === 'image') add(part.data || {});
    }
    return images;
  }

  const raw = String(message || '');
  for (const match of raw.matchAll(/\[CQ:image[^\]]*\]/g)) {
    add(parseCqParams(match[0]));
  }
  return images;
}

export function normalizeMessage(message) {
  // Visual/media segments are reduced to explicit placeholders at the cleaning
  // layer. Vision-capable providers still need a later transport step that
  // passes actual image URLs/files to the model.
  if (Array.isArray(message)) {
    return message
      .map((part) => {
        if (part.type === 'text') return part.data?.text || '';
        if (part.type === 'at') return `[CQ:at,qq=${part.data?.qq}]`;
        if (part.type === 'image') return '[图片]';
        if (part.type === 'face') return '[表情]';
        if (part.type === 'mface') return '[表情包]';
        if (part.type === 'record') return '[语音]';
        if (part.type === 'video') return '[视频]';
        if (part.type === 'file') return '[文件]';
        if (part.type === 'json' || part.type === 'xml' || part.type === 'forward') return summarizeCardPart(part);
        return '';
      })
      .join('')
      .trim();
  }
  return String(message || '')
    .replace(/\[CQ:reply[^\]]*(?:\]|$)/g, '')
    .replace(/\[CQ:json[^\]]*(?:\]|$)/g, (raw) => summarizeCqCard('json', raw))
    .replace(/\[CQ:xml[^\]]*(?:\]|$)/g, (raw) => summarizeCqCard('xml', raw))
    .replace(/\[CQ:forward[^\]]*(?:\]|$)/g, (raw) => summarizeCqCard('forward', raw))
    .replace(/\[CQ:image[^\]]*\]/g, '[图片]')
    .replace(/\[CQ:face[^\]]*\]/g, '[表情]')
    .replace(/\[CQ:mface[^\]]*\]/g, '[表情包]')
    .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
    .replace(/\[CQ:video[^\]]*\]/g, '[视频]')
    .replace(/\[CQ:file[^\]]*\]/g, '[文件]')
    .trim();
}

export function extractAtTargets(message) {
  if (Array.isArray(message)) {
    return message
      .filter((part) => part.type === 'at' && part.data?.qq)
      .map((part) => String(part.data.qq));
  }
  const targets = [];
  const raw = String(message || '');
  for (const match of raw.matchAll(/\[CQ:at,qq=([^\],]+)[^\]]*\]/g)) {
    targets.push(String(match[1]));
  }
  return targets;
}

export function mentionsBot(text, settings) {
  const names = String(settings.botNames || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (settings.selfQq && text.includes(`[CQ:at,qq=${settings.selfQq}]`)) return true;
  return names.some((name) => text.toLowerCase().includes(name.toLowerCase()));
}

export function isQuestion(text) {
  return /[?？吗呢么]|怎么|咋|如何|为什么|为啥|是不是|能不能|要不要|觉得/.test(text);
}

export function hasVisualPlaceholder(text) {
  return /\[(图片|表情|表情包|视频|文件)\]/.test(text);
}

export function asksToInspectVisual(text) {
  // Pure [图片]/[表情包] messages should be ignored. Only explain the visual
  // limitation when the user adds real text asking the bot to inspect it.
  if (!hasVisualPlaceholder(text)) return false;
  const wordsOnly = String(text)
    .replace(/\[(图片|表情|表情包|视频|文件|语音)\]/g, ' ')
    .trim();
  if (!wordsOnly) return false;
  return /看一下|看看|帮.*看|识别|认一下|截图|这是什么|啥意思|什么意思|评价|分析|解释|猜一下|能看见|看得到/.test(wordsOnly);
}

export function onlyVisualMessage(text) {
  return /^[\s\[\]图片表情包视频文件语音]+$/.test(text || '') && hasVisualPlaceholder(text || '');
}

export function textWithoutControlPlaceholders(text) {
  return String(text || '')
    .replace(/\[CQ:at,qq=[^\]]+\]/g, ' ')
    .replace(/\[CQ:reply[^\]]+\]/g, ' ')
    .replace(/\[(图片|表情|表情包|视频|文件|语音)\]/g, ' ')
    .replace(/\[分享卡片[\s\S]*?\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
