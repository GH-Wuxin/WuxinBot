// Local bot bridge — direct invocation of the four original bots.
//
// Each original bot (雨沐/猫猫/消防栓/LazyBot) runs its own OneBot WebSocket
// server. We connect as a Universal-role second client (proven by the spike
// client), post the command as if it came from the requesting QQ user, and
// collect the bot's reply frames on the same connection. This is a direct
// invocation, not QQ forwarding: the bot answers only on this connection and
// the original rendering (panels, text cards) comes back untouched.
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hydrantConfigPath } from './externalPaths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_OUTPUT_DIR = path.resolve(__dirname, '..', '..', 'data', 'bot-bridge');
// Local fake self id used by the bridge for non-yumu bots. Override with
// BRIDGE_SELF_ID when the deployment's NapCat/OneBot setup requires a specific
// self id (the private deployment keeps its real id in .env).
const SPIKE_SELF_ID = process.env.BRIDGE_SELF_ID || '1000000003';

function bridgeSelfId(botId: string): string {
  // Shiro indexes reverse-WebSocket sessions by self id. Reusing the same id
  // for concurrent yumu calls makes the newer session steal the older call's
  // reply. A per-call local identity keeps those sessions independent.
  if (botId === 'yumu') return String(8_800_000_000 + crypto.randomInt(0, 100_000_000));
  return SPIKE_SELF_ID;
}

export interface LocalBotReply {
  text: string;
  /** CQ image codes (file:// or http(s) sources, ready to send). */
  images: string[];
  /** Number of reply frames captured. */
  frames: number;
}

interface BotEndpoint {
  url: string;
  auth?: 'raw' | 'bearer';
  messageArray?: boolean;
}

const HYDRANT_CONFIG_PATH = hydrantConfigPath();

function hydrantToken(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(HYDRANT_CONFIG_PATH, 'utf8'));
    return String(cfg.Hydrant?.ServerAccessToken || '');
  } catch {
    return '';
  }
}

const ENDPOINTS: Record<string, BotEndpoint> = {
  yumu: { url: 'ws://127.0.0.1:8388/pub/onebotSocket' },
  kanon: { url: 'ws://127.0.0.1:7700/', messageArray: true },
  hydrant: { url: 'ws://127.0.0.1:8800/', auth: 'raw' },
  lazybot: { url: 'ws://127.0.0.1:1145/lazybot' },
};

export interface LocalBotCallContext {
  groupId: string;
  userId: string;
  nickname?: string;
  /** Optional at-targets for `查@` style commands. */
  atTargets?: string[];
}

function escapeCqParam(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/,/g, '&#44;');
}

function saveImageBuffer(buffer: Buffer): string {
  fs.mkdirSync(BRIDGE_OUTPUT_DIR, { recursive: true });
  const extension = detectImageExtension(buffer);
  const filename = `bridge-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
  const filepath = path.join(BRIDGE_OUTPUT_DIR, filename);
  fs.writeFileSync(filepath, buffer, { flag: 'wx' });
  const href = `file:///${filepath.replace(/\\/g, '/')}`;
  return `[CQ:image,file=${escapeCqParam(href)}]`;
}

function detectImageExtension(buffer: Buffer): string {
  if (!buffer || buffer.length < 12) return 'img';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return 'img';
}

function imageSourceToCq(source: string): string | null {
  const value = String(source || '').trim();
  if (!value) return null;
  if (/^base64:\/\//i.test(value)) {
    try {
      return saveImageBuffer(Buffer.from(value.slice('base64://'.length), 'base64'));
    } catch {
      return null;
    }
  }
  // http(s)/file URLs or local paths are passed through to NapCat.
  return `[CQ:image,file=${escapeCqParam(value)}]`;
}

interface ExtractedReply {
  text?: string;
  images?: string[];
}

function extractReplyFrame(frame: string): ExtractedReply | null {
  let parsed: any;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const action = String(parsed.action || '').toLowerCase();
  if (
    !action.startsWith('send_group_msg') &&
    !action.startsWith('send_private_msg') &&
    !action.startsWith('send_msg')
  ) return null;

  const message = parsed.params?.message;
  const texts: string[] = [];
  const images: string[] = [];
  if (typeof message === 'string') {
    const stripped = String(message).replace(/\[CQ:image,file=([^\]]+)\]/g, (_all, file: string) => {
      const cq = imageSourceToCq(file);
      if (cq) images.push(cq);
      return '';
    });
    const text = stripped.replace(/\[CQ:[^\]]+\]/g, '').trim();
    if (text) texts.push(text);
  } else if (Array.isArray(message)) {
    for (const segment of message) {
      if (!segment || typeof segment !== 'object') continue;
      if (segment.type === 'text') {
        const text = String(segment.data?.text || '').trim();
        if (text) texts.push(text);
      } else if (segment.type === 'image') {
        const cq = imageSourceToCq(String(segment.data?.file || ''));
        if (cq) images.push(cq);
      }
    }
  }
  if (texts.length === 0 && images.length === 0) return null;
  return { text: texts.join('\n'), images };
}

function buildEvent(
  endpoint: BotEndpoint,
  command: string,
  context: LocalBotCallContext,
  selfId: string,
): object {
  const now = Math.floor(Date.now() / 1000);
  const userId = Number(context.userId) || 0;
  const base = {
    post_type: 'message',
    message_type: 'group',
    time: now,
    self_id: Number(selfId),
    sub_type: 'normal',
    // Bots parse message_id as int32; keep it small and unique per call.
    message_id: (Date.now() % 1_500_000_000) + Math.floor(Math.random() * 900),
    group_id: Number(context.groupId) || 770099,
    user_id: userId,
    anonymous: null,
    font: 0,
    sender: {
      user_id: userId,
      nickname: context.nickname || 'WuxinBridge',
      card: '',
      role: 'member',
    },
  };

  const atTargets = Array.isArray(context.atTargets) ? context.atTargets.map(String) : [];
  if (endpoint.messageArray || atTargets.length > 0) {
    const segments: Array<Record<string, any>> = atTargets.length > 0
      ? [
          { type: 'text', data: { text: command } },
          ...atTargets.map((qq) => ({ type: 'at', data: { qq: Number(qq) || qq } })),
        ]
      : [{ type: 'text', data: { text: command } }];
    return { ...base, message: segments, raw_message: command };
  }
  return { ...base, message: command, raw_message: command };
}

/**
 * Call a local bot directly and collect its reply (text and/or panel images).
 * Rejects on connection failure or timeout so the caller can fall back to the
 * internal engine.
 */
export function callLocalBot(
  botId: string,
  command: string,
  context: LocalBotCallContext,
  timeoutMs = 45_000,
): Promise<LocalBotReply> {
  const endpoint = ENDPOINTS[botId];
  if (!endpoint) return Promise.reject(new Error(`未知的本地 bot: ${botId}`));
  if (!command) return Promise.reject(new Error(`本地 bot ${botId} 指令为空`));

  return new Promise((resolve, reject) => {
    const selfId = bridgeSelfId(botId);
    const headers: Record<string, string> = {
      'X-Client-Role': 'Universal',
      'X-Self-ID': selfId,
    };
    if (endpoint.auth) {
      const token = hydrantToken();
      headers.Authorization = endpoint.auth === 'bearer' ? `Bearer ${token}` : token;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoint.url, { headers });
    } catch (error) {
      reject(error);
      return;
    }

    const texts: string[] = [];
    const images: string[] = [];
    let frames = 0;
    let settleTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (settleTimer) clearTimeout(settleTimer);
      try { ws.close(); } catch { /* noop */ }
      if (error) {
        reject(error);
        return;
      }
      const text = texts.join('\n').trim();
      if (!text && images.length === 0 && frames === 0) {
        reject(new Error(`${botId} 无回复`));
        return;
      }
      resolve({ text, images, frames });
    };

    const armSettle = () => {
      if (settleTimer) clearTimeout(settleTimer);
      // Kanon sends its reply then may emit follow-up frames; closing too
      // early makes its next send throw NRE and leaves its dedup lock stuck.
      settleTimer = setTimeout(() => finish(), 3000);
    };

    const overallTimer = setTimeout(() => finish(new Error(`${botId} 调用超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify(buildEvent(endpoint, command, context, selfId)));
    });
    ws.on('message', (data) => {
      const frame = String(data);
      // Kanon (WatsonWsServer) and Hydrant (WudiLib) send API actions that
      // carry an `echo` and wait for the client's acknowledgement; without it
      // their reply-send times out and nothing reaches us.
      try {
        const parsed = JSON.parse(frame);
        if (parsed && typeof parsed === 'object' && parsed.action && parsed.echo !== undefined) {
          if (ws.readyState === WebSocket.OPEN) {
            // data must look like a successful API result (e.g. a message id);
            // data:null makes WudiLib treat the send as failed and hydrant
            // falls back to its screenshot-to-image path (black image).
            ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 0 }, echo: parsed.echo }));
          }
        }
      } catch { /* non-JSON frames are ignored */ }

      const extracted = extractReplyFrame(frame);
      if (!extracted) return;
      frames++;
      if (extracted.text) texts.push(extracted.text);
      if (extracted.images) images.push(...extracted.images);
      armSettle();
    });
    ws.on('close', () => {
      clearTimeout(overallTimer);
      finish();
    });
    ws.on('error', (error) => {
      clearTimeout(overallTimer);
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/** True when the given bot has a local endpoint configured. */
export function hasLocalEndpoint(botId: string): boolean {
  return Boolean(ENDPOINTS[botId]);
}
