import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {getDataDir} from '../../store.js';
const IMAGE_LIMIT_BYTES = 4 * 1024 * 1024;
const IMAGE_FETCH_ATTEMPTS = 3;
const IMAGE_FETCH_TIMEOUT_MS = 8_000;
const IMAGE_MEMORY_CACHE_TTL_MS = 24 * 60 * 60_000;
const IMAGE_DISK_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const imageMemoryCache = new Map<string, { at: number; dataUrl: string }>();
const imageRequests = new Map<string, Promise<string>>();

function allowedImageUrl(value: unknown): URL | null {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !['a.ppy.sh', 'assets.ppy.sh'].includes(host) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function imageCachePath(url: URL): string {
  const key = createHash('sha256').update(url.href).digest('hex');
  return path.join(getDataDir(), 'player-skill-image-cache', `${key}.json`);
}

function detectedImageMime(buffer: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function normalizedCachedDataUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > Math.ceil(IMAGE_LIMIT_BYTES * 4 / 3) + 256) return '';
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) return '';
  const buffer = Buffer.from(match[1], 'base64');
  if (!buffer.length || buffer.length > IMAGE_LIMIT_BYTES) return '';
  const mime = detectedImageMime(buffer);
  return mime ? `data:${mime};base64,${buffer.toString('base64')}` : '';
}

function readCachedImage(url: URL): string {
  const memory = imageMemoryCache.get(url.href);
  if (memory && Date.now() - memory.at <= IMAGE_MEMORY_CACHE_TTL_MS) return memory.dataUrl;
  try {
    const cached = JSON.parse(fs.readFileSync(imageCachePath(url), 'utf8'));
    if (cached?.url !== url.href || Date.now() - Number(cached?.at || 0) > IMAGE_DISK_CACHE_TTL_MS) return '';
    const dataUrl = normalizedCachedDataUrl(cached?.dataUrl);
    if (!dataUrl) return '';
    imageMemoryCache.set(url.href, { at: Number(cached.at), dataUrl });
    if (dataUrl !== cached.dataUrl) writeCachedImage(url, dataUrl);
    return dataUrl;
  } catch {
    return '';
  }
}

function writeCachedImage(url: URL, dataUrl: string): void {
  const at = Date.now();
  imageMemoryCache.set(url.href, { at, dataUrl });
  let temporary = '';
  try {
    const filePath = imageCachePath(url);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ at, url: url.href, dataUrl }), { encoding: 'utf8', flag: 'wx' });
    fs.copyFileSync(temporary, filePath);
  } catch (error: any) {
    console.warn('[player-skill-card] image cache write failed:', String(error?.message || error));
  } finally {
    if (temporary) {
      try { fs.unlinkSync(temporary); } catch { /* best-effort temp cleanup */ }
    }
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function downloadImageDataUrl(url: URL): Promise<string> {
  const cached = readCachedImage(url);
  if (cached) return cached;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= IMAGE_FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const final = allowedImageUrl(response.url);
      if (!final) throw new Error('IMAGE_REDIRECT_NOT_ALLOWED');
      const length = Number(response.headers.get('content-length') || 0);
      if (length > IMAGE_LIMIT_BYTES) throw new Error('IMAGE_TOO_LARGE');
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > IMAGE_LIMIT_BYTES) throw new Error('IMAGE_SIZE_INVALID');
      // a.ppy.sh sometimes serves PNG bytes with an image/jpeg header. SVG
      // renderers trust the data-URL MIME and then silently draw a blank avatar,
      // so determine the type from the file signature instead of the header.
      const mime = detectedImageMime(buffer);
      if (!mime) throw new Error('IMAGE_TYPE_UNSUPPORTED');
      const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
      writeCachedImage(url, dataUrl);
      return dataUrl;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < IMAGE_FETCH_ATTEMPTS) await wait(200 * attempt);
  }
  throw lastError || new Error('IMAGE_FETCH_FAILED');
}

async function cachedImageDataUrl(url: URL): Promise<string> {
  const existing = imageRequests.get(url.href);
  if (existing) return existing;
  const pending = downloadImageDataUrl(url);
  imageRequests.set(url.href, pending);
  try {
    return await pending;
  } finally {
    if (imageRequests.get(url.href) === pending) imageRequests.delete(url.href);
  }
}

export async function imageDataUrl(value: unknown, fallbackOsuId?: unknown): Promise<string> {
  const url = allowedImageUrl(value);
  const osuId = Number(fallbackOsuId);
  const fallback = Number.isSafeInteger(osuId) && osuId > 0 ? allowedImageUrl(`https://a.ppy.sh/${osuId}`) : null;
  const candidates = [url, fallback].filter((candidate): candidate is URL => Boolean(candidate));
  const unique = [...new Map(candidates.map((candidate) => [candidate.href, candidate])).values()];
  let lastError: unknown = null;
  for (const candidate of unique) {
    try {
      return await cachedImageDataUrl(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  if (unique.length) {
    console.warn('[player-skill-card] image unavailable after retries:', {
      url: unique[0].href,
      fallbackUsed: unique.length > 1,
      error: String((lastError as any)?.message || lastError || 'unknown'),
    });
  }
  return '';
}
