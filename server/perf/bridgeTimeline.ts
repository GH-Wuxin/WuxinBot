// Default-off WebSocket bridge timeline diagnostics for root-cause audits.
//
// Enabled only by BRIDGE_TIMELINE=1. When disabled every function is a cheap
// no-op and no file I/O is performed. When enabled, timeline events for each
// local-bot bridge call are appended as JSONL to BRIDGE_TIMELINE_DIR (or
// PERF_TRACE_DIR) and kept in memory.
//
// Privacy contract: this is an explicit opt-in diagnostic mode. It records the
// injected bridge command text (which may contain an osu! username) because
// bridge-command reconstruction is part of the diagnosis. It never records QQ
// numbers, message bodies, frame payloads, URLs or tokens; inbound frames are
// reduced to length, action/post_type and segment-shape metadata only.
import fs from 'node:fs';
import path from 'node:path';

const ENABLED = process.env.BRIDGE_TIMELINE === '1';
const TIMELINE_DIR = process.env.BRIDGE_TIMELINE_DIR || process.env.PERF_TRACE_DIR || '';

export interface BridgeTimelineMeta {
  [key: string]: string | number | boolean | null | undefined;
}

export interface BridgeFrameSummary {
  frameIndex: number;
  elapsedMs: number;
  sincePrevMs: number;
  bytesLength: number;
  json: boolean;
  kind: 'api_action' | 'reply_action' | 'echo_response' | 'meta_event' | 'other_json' | 'non_json';
  action?: string;
  postType?: string;
  messageType?: string;
  hasEcho?: boolean;
  replyLike?: boolean;
  extracted?: boolean;
  messageShape?: 'string' | 'array' | 'other' | 'missing';
  segmentTypes?: string;
  textBytes?: number;
  imageCount?: number;
}

export interface BridgeTimelineHandle {
  readonly id: string;
  readonly botId: string;
  mark(stage: string, meta?: BridgeTimelineMeta): void;
  frame(summary: BridgeFrameSummary): void;
  finish(outcome: string, meta?: BridgeTimelineMeta): void;
}

class BridgeTimeline implements BridgeTimelineHandle {
  readonly id: string;
  readonly botId: string;
  readonly startedAtNs: bigint;
  private lastNs: bigint;
  private finished = false;
  private frames: BridgeFrameSummary[] = [];

  constructor(botId: string, command: string, meta?: BridgeTimelineMeta) {
    this.botId = botId;
    this.startedAtNs = process.hrtime.bigint();
    this.lastNs = this.startedAtNs;
    this.id = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}-${botId}`;
    appendLine('begin', {
      timelineId: this.id,
      botId,
      command,
      meta: sanitizeMeta(meta),
    });
  }

  mark(stage: string, meta?: BridgeTimelineMeta): void {
    if (this.finished) return;
    const nowNs = process.hrtime.bigint();
    const elapsedMs = Number(nowNs - this.startedAtNs) / 1e6;
    const sincePrevMs = Number(nowNs - this.lastNs) / 1e6;
    this.lastNs = nowNs;
    appendLine('stage', {
      timelineId: this.id,
      stage,
      elapsedMs,
      sincePrevMs,
      monotonicNs: nowNs.toString(),
      meta: sanitizeMeta(meta),
    });
  }

  frame(summary: BridgeFrameSummary): void {
    if (this.finished) return;
    this.frames.push(summary);
    appendLine('frame', { timelineId: this.id, ...summary });
  }

  finish(outcome: string, meta?: BridgeTimelineMeta): void {
    if (this.finished) return;
    this.finished = true;
    appendLine('finish', {
      timelineId: this.id,
      outcome,
      frames: this.frames.length,
      meta: sanitizeMeta(meta),
    });
  }
}

const timelines: BridgeTimeline[] = [];

export function beginBridgeTimeline(
  botId: string,
  command: string,
  meta?: BridgeTimelineMeta,
): BridgeTimelineHandle | null {
  if (!ENABLED) return null;
  const timeline = new BridgeTimeline(botId, command, meta);
  timelines.push(timeline);
  if (timelines.length > 100) timelines.shift();
  return timeline;
}

export function getBridgeTimelines(): BridgeTimelineHandle[] {
  return [...timelines];
}

function sanitizeMeta(meta?: BridgeTimelineMeta): BridgeTimelineMeta | undefined {
  if (!meta) return undefined;
  const out: BridgeTimelineMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (typeof value === 'string' && value.length > 200) continue;
    out[key] = value;
  }
  return out;
}

function appendLine(kind: string, payload: Record<string, unknown>): void {
  if (!TIMELINE_DIR) return;
  try {
    fs.mkdirSync(TIMELINE_DIR, { recursive: true });
    const file = path.join(TIMELINE_DIR, 'bridge-timeline.jsonl');
    fs.appendFileSync(file, `${JSON.stringify({ kind, atNs: process.hrtime.bigint().toString(), ...payload })}\n`, 'utf8');
  } catch {
    // Diagnostics must never affect application behavior.
  }
}
