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
import {
  beginBridgeTimeline,
  type BridgeTimelineHandle,
} from '../perf/bridgeTimeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Audit-only override: BRIDGE_OUTPUT_DIR redirects decoded base64 image writes
// for offline harnesses. Unset in production, so the default path is unchanged.
const BRIDGE_OUTPUT_DIR = process.env.BRIDGE_OUTPUT_DIR
  || path.resolve(__dirname, '..', '..', 'data', 'bot-bridge');
// Local fake self id used by the bridge for non-yumu bots. Override with
// BRIDGE_SELF_ID when the deployment's NapCat/OneBot setup requires a specific
// self id (the private deployment keeps its real id in .env).
//
// Kanon is the exception: it silently drops any message whose user_id matches a
// connected client's X-Self-ID, so Kanon bridge calls now allocate a
// per-call-safe identity (see bridgeSelfId). Hydrant and LazyBot still use
// this constant unless BRIDGE_SELF_ID is set.
const SPIKE_SELF_ID = process.env.BRIDGE_SELF_ID || '1000000003';
// Reserved Kanon bridge identity pool, disjoint from Yumu's 8.8e9..8.9e9 pool.
const KANON_SELF_ID_START = 7_700_000_000;
const KANON_SELF_ID_SIZE = 100_000_000;
const activeKanonSelfIds = new Set<string>();
// QUICK_BRIDGE_FIX_P0_3 timer policy:
// - The no-reply timeout remains the ONLY deadline until the first valid
//   reply is accepted.
// - After the first valid reply, the no-reply timeout is retired and the call
//   may live at most MAX_POST_REPLY_MS (2 settle windows) for multi-frame
//   collection; each valid frame still resets the nominal 3s settle, but the
//   hard post-reply deadline is not reset by any frame.
// BRIDGE_SETTLE_MS / BRIDGE_MAX_POST_REPLY_MS are default-off test/audit
// overrides used by the offline race verifier; unset in production.
function positiveEnvMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const SETTLE_MS = positiveEnvMs('BRIDGE_SETTLE_MS', 3000);
const MAX_POST_REPLY_MS = positiveEnvMs('BRIDGE_MAX_POST_REPLY_MS', 2 * SETTLE_MS);

// QUICK_BRIDGE_QB05 — A' deterministic safe-slot allocator (final spec).
//
// Yumu/Shiro 2.5.3 builds its group-event dedup key as delimiter-free
//   String(time) + String(group_id) + String(user_id).
// Because the key has no field separators, a 13-digit millisecond synthetic
// time is NOT enough by itself to avoid real-event keys: the digits can
// re-split across the group/user boundaries. We therefore only ever emit
// times whose low 3 digits are 000..099. The 11th character of the synthetic
// key is then always '0'. For a real group message the group_id is positive
// and its canonical decimal representation has no leading zero, so the 11th
// character of every valid real key is 1..9 (leading-zero lemma). That makes
// the synthetic key space strictly disjoint from all valid real keys for any
// group/user digit length.
//
// Allocator guarantees (process-local):
// - exactly 100 safe slots per pool second, emitted strictly increasing,
//   never reused within this process;
// - slot 0 sits 2000..2999ms in the future, slot 99 2099..3098ms, so every
//   call keeps at least a 2030ms flight budget under Yumu's stale gate
//   (drop iff receiveNow - time > 30 on the >=1e10 millisecond branch);
// - pool exhaustion (101st call in a pool second) fails BEFORE any WebSocket
//   is created and is the mechanism that makes wall-clock rollback fail fast;
//   the caller's existing bridge failure fallback consumes the rejection.
//
// The 30s drift guard below is a Wuxin defensive / future-proof policy, not a
// Shiro protocol limit: the target gate only rejects "past" times and has no
// future bound. Under the current control flow it is effectively unreachable
// (safe-slot values are 2000..3098ms ahead, and on rollback the pool boundary
// check fires first). It is kept to guard against future changes to the pool
// arithmetic.
let lastYumuSafeTimeMs = 0;
export function yumuSafeTimeMs(nowMs: number = Date.now()): number {
  const poolBase = Math.ceil((nowMs + 2000) / 1000);
  const poolFirst = poolBase * 1000;
  const poolLast = poolFirst + 99;
  let t = poolFirst;
  if (t <= lastYumuSafeTimeMs) t = lastYumuSafeTimeMs + 1;
  if (t > poolLast) throw new Error('yumu bridge safe-slot pool exhausted (100/s)');
  if (t - nowMs > 30_000) throw new Error('yumu bridge event time drift exceeded');
  lastYumuSafeTimeMs = t;
  return t;
}

function bridgeSelfId(botId: string, requestedUserId: string | undefined): string {
  // Shiro indexes reverse-WebSocket sessions by self id. Reusing the same id
  // for concurrent yumu calls makes the newer session steal the older call's
  // reply. A per-call local identity keeps those sessions independent.
  if (botId === 'yumu') return String(8_800_000_000 + crypto.randomInt(0, 100_000_000));
  if (botId !== 'kanon') return SPIKE_SELF_ID;

  // Kanon bridge identity selection (QUICK_BRIDGE_FIX_P0_1):
  // Kanon's OneBot server silently discards any event whose user_id equals a
  // connected client's X-Self-ID. The synthetic bridge identity must therefore
  // never equal the logical sender id, and simultaneous bridge calls must not
  // share an active identity (which would also poison the self-message filter
  // for that sender).
  const logicalUserId = Number(requestedUserId) || 0;
  const configured = String(process.env.BRIDGE_SELF_ID || '').trim();
  if (configured) {
    const numericConfigured = Number(configured);
    if (!activeKanonSelfIds.has(configured) && numericConfigured !== logicalUserId) {
      activeKanonSelfIds.add(configured);
      return configured;
    }
    console.error(
      `[bridge] kanon BRIDGE_SELF_ID=${JSON.stringify(configured)} ` +
      `conflicts with the logical sender id or an active bridge call; ` +
      `using a per-call safe identity for this call instead of the override`,
    );
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = String(KANON_SELF_ID_START + crypto.randomInt(0, KANON_SELF_ID_SIZE));
    if (Number(candidate) !== logicalUserId && !activeKanonSelfIds.has(candidate)) {
      activeKanonSelfIds.add(candidate);
      return candidate;
    }
  }
  // Exhaustive fallback for the (practically impossible) random collision case.
  for (let n = KANON_SELF_ID_START; n < KANON_SELF_ID_START + KANON_SELF_ID_SIZE; n++) {
    const candidate = String(n);
    if (Number(candidate) !== logicalUserId && !activeKanonSelfIds.has(candidate)) {
      activeKanonSelfIds.add(candidate);
      return candidate;
    }
  }
  throw new Error('无法为 kanon 桥接调用分配不冲突的 self id');
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

// Audit-only override: BRIDGE_URL_<BOT> redirects a bot endpoint to a synthetic
// offline server (e.g. BRIDGE_URL_YUMU=ws://127.0.0.1:0 is not used; harnesses
// pass a concrete port). Unset in production, so defaults are unchanged.
function endpointUrl(botId: string, fallback: string): string {
  return process.env[`BRIDGE_URL_${botId.toUpperCase()}`] || fallback;
}

const ENDPOINTS: Record<string, BotEndpoint> = {
  yumu: { url: endpointUrl('yumu', 'ws://127.0.0.1:8388/pub/onebotSocket') },
  kanon: { url: endpointUrl('kanon', 'ws://127.0.0.1:7700/'), messageArray: true },
  hydrant: { url: endpointUrl('hydrant', 'ws://127.0.0.1:8800/'), auth: 'raw' },
  lazybot: { url: endpointUrl('lazybot', 'ws://127.0.0.1:1145/lazybot') },
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

function describeMessageShape(parsed: any): 'string' | 'array' | 'other' | 'missing' {
  const message = parsed?.params?.message;
  if (typeof message === 'string') return 'string';
  if (Array.isArray(message)) return 'array';
  if (message === undefined || message === null) return 'missing';
  return 'other';
}

function describeSegmentTypes(parsed: any): string {
  const message = parsed?.params?.message;
  if (!Array.isArray(message)) return '';
  return message
    .slice(0, 12)
    .map((segment: any) => String(segment?.type || 'unknown'))
    .join(',');
}

function countMessageTextBytes(parsed: any): number {
  const message = parsed?.params?.message;
  if (typeof message === 'string') return Buffer.byteLength(message, 'utf8');
  if (!Array.isArray(message)) return 0;
  let bytes = 0;
  for (const segment of message) {
    if (segment && typeof segment === 'object' && segment.type === 'text') {
      bytes += Buffer.byteLength(String(segment.data?.text || ''), 'utf8');
    }
  }
  return bytes;
}

function countMessageImages(parsed: any): number {
  const message = parsed?.params?.message;
  if (!Array.isArray(message)) return 0;
  return message.filter((segment: any) => segment && typeof segment === 'object' && segment.type === 'image').length;
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
  /** QUICK_BRIDGE_QB05 (A'): pre-allocated safe-slot time for yumu; other bots use current seconds. */
  eventTimeMs?: number,
): object {
  const now = typeof eventTimeMs === 'number'
    ? eventTimeMs
    : Math.floor(Date.now() / 1000);
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
  const timeline = beginBridgeTimeline(botId, command, { timeoutMs });
  if (timeline) timeline.mark('endpoint_lookup_done', { botId, found: true });

  return new Promise((resolve, reject) => {
    // QUICK_BRIDGE_FIX_P0_3_1: absolute monotonic no-reply deadline.
    // Acceptance of the first valid reply depends on its receive timestamp
    // versus this deadline, never on whether the setTimeout callback has
    // already run. Policy: receivedAtNs <= noReplyDeadlineNs is on time.
    const startedAtNs = process.hrtime.bigint();
    const noReplyDeadlineNs = startedAtNs + BigInt(Math.max(1, Math.round(timeoutMs))) * 1_000_000n;
    const selfId = bridgeSelfId(botId, context.userId);
    // QUICK_BRIDGE_QB05 (A'): allocate the yumu safe-slot BEFORE any socket
    // exists. Pool exhaustion or drift-cap violation rejects here as an
    // ordinary bridge failure; the caller's existing fallback consumes it and
    // no bridge traffic is produced.
    let yumuEventTime: number | undefined;
    if (botId === 'yumu') {
      try {
        yumuEventTime = yumuSafeTimeMs();
        if (timeline) {
          timeline.mark('yumu_safe_slot_allocated', {
            eventTimeMs: yumuEventTime,
            slotIndex: yumuEventTime % 1000,
          });
        }
      } catch (error) {
        const message = String(error?.message || error);
        if (timeline) {
          timeline.mark('yumu_safe_slot_alloc_failed', { message });
          timeline.finish('rejected', { endReason: 'yumu_safe_slot_alloc_failed', message });
        }
        reject(error instanceof Error ? error : new Error(message));
        return;
      }
    }
    const headers: Record<string, string> = {
      'X-Client-Role': 'Universal',
      'X-Self-ID': selfId,
    };
    if (endpoint.auth) {
      const token = hydrantToken();
      headers.Authorization = endpoint.auth === 'bearer' ? `Bearer ${token}` : token;
    }

    let ws: WebSocket;
    if (timeline) timeline.mark('ws_construction_start');
    try {
      ws = new WebSocket(endpoint.url, { headers });
    } catch (error) {
      if (botId === 'kanon') activeKanonSelfIds.delete(selfId);
      if (timeline) timeline.mark('ws_construction_failed');
      reject(error);
      return;
    }
    if (timeline) timeline.mark('ws_constructed');

    const texts: string[] = [];
    const images: string[] = [];
    let frames = 0;
    let framesTotal = 0;
    let apiActionFrames = 0;
    let replyActionFrames = 0;
    let extractedFrames = 0;
    let firstFrameMarked = false;
    let firstApiActionMarked = false;
    let firstReplyActionMarked = false;
    let firstExtractionMarked = false;
    let endReason = '';
    let settleFired = false;
    let settleTimer: NodeJS.Timeout | null = null;
    let postReplyDeadlineTimer: NodeJS.Timeout | null = null;
    let overallTimer: NodeJS.Timeout | null = null;
    let replyAccepted = false;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (botId === 'kanon') activeKanonSelfIds.delete(selfId);
      if (settleTimer) clearTimeout(settleTimer);
      if (postReplyDeadlineTimer) clearTimeout(postReplyDeadlineTimer);
      if (overallTimer) clearTimeout(overallTimer);
      try { ws.close(); } catch { /* noop */ }
      if (timeline) {
        timeline.finish(error ? 'rejected' : 'resolved', {
          endReason,
          settleFired,
          framesTotal,
          apiActionFrames,
          replyActionFrames,
          extractedFrames,
          returnedFrames: frames,
          textCount: texts.length,
          imageCount: images.length,
        });
      }
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

    const armSettle = (receivedAtNs: bigint) => {
      if (settled) return;
      if (!replyAccepted) {
        if (receivedAtNs > noReplyDeadlineNs) {
          // First valid reply logically arrived AFTER the no-reply deadline,
          // even if the timeout callback has not executed yet. It must not
          // retire the deadline and must not grant settle grace; the no-reply
          // timeout (possibly delayed) remains authoritative. Content may have
          // been collected, but a later close-with-content still follows the
          // existing close semantics.
          if (timeline) timeline.mark('late_reply_ignored_for_deadline', {
            receivedAfterDeadlineNs: Number(receivedAtNs - noReplyDeadlineNs) / 1e6,
          });
          return;
        }
        // First valid reply accepted before or at the absolute deadline:
        // retire the no-reply timeout and arm the hard post-reply bound.
        // The bound is not reset by later frames; only the nominal settle
        // window is.
        replyAccepted = true;
        if (overallTimer) clearTimeout(overallTimer);
        overallTimer = null;
        postReplyDeadlineTimer = setTimeout(() => {
          endReason = 'post_reply_deadline';
          if (timeline) timeline.mark('post_reply_deadline', { maxPostReplyMs: MAX_POST_REPLY_MS });
          finish();
        }, MAX_POST_REPLY_MS);
        if (timeline) {
          timeline.mark('valid_reply_accepted', {
            maxPostReplyMs: MAX_POST_REPLY_MS,
            settleMs: SETTLE_MS,
            receivedBeforeDeadlineMs: Number(noReplyDeadlineNs - receivedAtNs) / 1e6,
          });
        }
      }
      if (settleTimer) clearTimeout(settleTimer);
      if (timeline) timeline.mark('settle_start', { settleMs: SETTLE_MS });
      // Kanon sends its reply then may emit follow-up frames; closing too
      // early makes its next send throw NRE and leaves its dedup lock stuck.
      settleTimer = setTimeout(() => {
        settleFired = true;
        endReason = 'settle';
        if (timeline) timeline.mark('settle_done');
        finish();
      }, SETTLE_MS);
    };

    overallTimer = setTimeout(() => {
      endReason = 'timeout';
      if (timeline) timeline.mark('timeout', { timeoutMs });
      finish(new Error(`${botId} 调用超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);

    ws.on('open', () => {
      if (timeline) timeline.mark('ws_open');
      ws.send(JSON.stringify(buildEvent(endpoint, command, context, selfId, yumuEventTime)));
      if (timeline) timeline.mark('command_sent');
    });
    ws.on('message', (data) => {
      // Capture receive time BEFORE any parsing/extraction so a frame that
      // entered processing on time is not made late by Wuxin-side parsing.
      const receivedAtNs = process.hrtime.bigint();
      const frame = String(data);
      const frameIndex = ++framesTotal;
      const bytesLength = Buffer.byteLength(frame, 'utf8');
      let parsed: any = null;
      let parseOk = false;
      try {
        parsed = JSON.parse(frame);
        parseOk = parsed !== null && typeof parsed === 'object';
      } catch { /* non-JSON frames are classified below */ }

      const action = parseOk ? String(parsed.action || '').toLowerCase() : '';
      const postType = parseOk ? String(parsed.post_type || '') : '';
      const messageType = parseOk ? String(parsed.message_type || '') : '';
      const hasEcho = parseOk && parsed.echo !== undefined;
      const replyLike = Boolean(
        action.startsWith('send_group_msg')
          || action.startsWith('send_private_msg')
          || action.startsWith('send_msg'),
      );

      if (!firstFrameMarked) {
        firstFrameMarked = true;
        if (timeline) {
          timeline.mark('first_frame', {
            json: parseOk,
            bytesLength,
            action: action || null,
            postType: postType || null,
          });
        }
      }

      // Kanon (WatsonWsServer) and Hydrant (WudiLib) send API actions that
      // carry an `echo` and wait for the client's acknowledgement; without it
      // their reply-send times out and nothing reaches us.
      if (parseOk && parsed.action && parsed.echo !== undefined) {
        apiActionFrames++;
        if (!firstApiActionMarked) {
          firstApiActionMarked = true;
          if (timeline) timeline.mark('first_api_action_frame', { action });
        }
        if (ws.readyState === WebSocket.OPEN) {
          // data must look like a successful API result (e.g. a message id);
          // data:null makes WudiLib treat the send as failed and hydrant
          // falls back to its screenshot-to-image path (black image).
          ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 0 }, echo: parsed.echo }));
          if (timeline) timeline.mark('ack_sent', { action });
        }
      }

      const messageShape = describeMessageShape(parsed);
      const segmentTypes = describeSegmentTypes(parsed);
      const textBytes = countMessageTextBytes(parsed);
      const imageCount = countMessageImages(parsed);
      if (replyLike) {
        replyActionFrames++;
        if (!firstReplyActionMarked) {
          firstReplyActionMarked = true;
          if (timeline) {
            timeline.mark('first_reply_action_frame', {
              action,
              messageShape,
              segmentTypes,
              textBytes,
              imageCount,
            });
          }
        }
      }

      const extracted = extractReplyFrame(frame);
      if (extracted) {
        extractedFrames++;
        if (!firstExtractionMarked) {
          firstExtractionMarked = true;
          if (timeline) {
            timeline.mark('reply_extracted', {
              action,
              textBytes: Buffer.byteLength(extracted.text || '', 'utf8'),
              imageCount: extracted.images.length,
            });
          }
        }
        if (!replyAccepted && receivedAtNs > noReplyDeadlineNs) {
          // QUICK_BRIDGE_FIX_P0_3_1 edge case: the first valid reply arrived
          // after the absolute no-reply deadline. Discard it BEFORE it enters
          // frames/texts/images so a later close cannot resolve from this
          // late-only content; the no-reply timeout (possibly delayed) or a
          // close-without-content rejects instead. ACK has already been sent.
          if (timeline) {
            timeline.mark('late_reply_ignored_for_deadline', {
              receivedAfterDeadlineNs: Number(receivedAtNs - noReplyDeadlineNs) / 1e6,
            });
          }
        } else {
          frames++;
          if (extracted.text) texts.push(extracted.text);
          if (extracted.images) images.push(...extracted.images);
          armSettle(receivedAtNs);
        }
      } else if (replyLike) {
        if (timeline) {
          timeline.mark('reply_not_extracted', {
            action,
            messageShape,
            segmentTypes,
            textBytes,
            imageCount,
          });
        }
      }

      let frameKind: 'api_action' | 'reply_action' | 'echo_response' | 'meta_event' | 'other_json' | 'non_json';
      if (!parseOk) frameKind = 'non_json';
      else if (replyLike) frameKind = 'reply_action';
      else if (action && hasEcho) frameKind = 'api_action';
      else if (parsed.echo !== undefined && (parsed.retcode !== undefined || parsed.status !== undefined)) frameKind = 'echo_response';
      else if (postType === 'meta_event') frameKind = 'meta_event';
      else frameKind = 'other_json';

      if (timeline) {
        timeline.frame({
          frameIndex,
          elapsedMs: 0,
          sincePrevMs: 0,
          bytesLength,
          json: parseOk,
          kind: frameKind,
          action: action || undefined,
          postType: postType || undefined,
          messageType: messageType || undefined,
          hasEcho,
          replyLike,
          extracted: Boolean(extracted),
          messageShape,
          segmentTypes,
          textBytes,
          imageCount,
        });
      }
    });
    ws.on('close', (code, reason) => {
      if (overallTimer) clearTimeout(overallTimer);
      endReason = 'close';
      if (timeline) timeline.mark('ws_close', { code: Number(code), reason: String(reason).slice(0, 80) });
      finish();
    });
    ws.on('error', (error) => {
      if (overallTimer) clearTimeout(overallTimer);
      endReason = 'error';
      if (timeline) timeline.mark('ws_error', { message: String(error?.message || error).slice(0, 160) });
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/** True when the given bot has a local endpoint configured. */
export function hasLocalEndpoint(botId: string): boolean {
  return Boolean(ENDPOINTS[botId]);
}
