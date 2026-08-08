// osu! multiplayer match listener — TS port of yumu-bot's MatchListener /
// MatchListenerService. Polls osu! API v2 every 8 seconds, renders events
// through yumu-image (panel_E7 for round start, panel_F3 for round end) and
// pushes them to the bound groups through Wuxin.

import { getMatch, getMatchAfter, getBeatmap } from './api.js';
import { buildMatchRating, serializeRound, type MatchRatingJson } from './matchRating.js';
import { renderPanel } from '../bots/renderServer.js';
import { updateDb, readDb } from '../store.js';
import type { OsuMatch, OsuMatchEvent, OsuMatchRound, OsuMatchUser } from './types.js';

export type MatchStopType = 'MATCH_END' | 'USER_STOP' | 'SUPER_STOP' | 'SERVER_REBOOT' | 'TIME_OUT';

const POLL_INTERVAL_MS = 8_000;
const TIMEOUT_MS = 6 * 3_600_000;
const GROUP_MAX = 3;
const USER_MAX = 3;

export interface MatchCommandResult {
  text?: string;
  images?: string[];
}

export interface MatchBind {
  groupId: string;
  userId: string;
  createdAt: string;
}

export interface MatchListenerState {
  matchName: string;
  lastEventId: number;
  groups: MatchBind[];
  createdAt: string;
}

type SendMessage = (event: any, text: string, extra?: any) => Promise<any>;

function modeName(modeInt?: number | null): string {
  switch (Number(modeInt)) {
    case 0: return 'OSU';
    case 1: return 'TAIKO';
    case 2: return 'CATCH';
    case 3: return 'MANIA';
    default: return 'OSU';
  }
}

function eventType(type: string): string {
  switch (type) {
    case 'player-joined': return 'PlayerJoined';
    case 'player-kicked': return 'PlayerKicked';
    case 'player-left': return 'PlayerLeft';
    case 'host-changed': return 'HostChanged';
    case 'match-disbanded': return 'MatchDisbanded';
    case 'match-created': return 'MatchCreated';
    default: return 'Other';
  }
}

// ── Density approximation (26 buckets, yumu uses a parsed-file database) ──

function approximateDensity(beatmap: any): number[] {
  const circles = Number(beatmap?.count_circles || 0);
  const sliders = Number(beatmap?.count_sliders || 0);
  const spinners = Number(beatmap?.count_spinners || 0);
  const total = circles + sliders * 2 + spinners * 3;
  const bucket = Math.max(1, Math.round(total / 26));
  const arr = new Array(26).fill(0);
  let remaining = total;
  for (let i = 0; i < 26 && remaining > 0; i++) {
    arr[i] = Math.min(bucket, remaining);
    remaining -= bucket;
  }
  return arr;
}

function yumuBeatmap(beatmap: any): Record<string, unknown> {
  const b = beatmap || {};
  const set = b.beatmapset || {};
  return {
    bpm: Number(b.bpm || set.bpm || 0),
    hp: Number(b.drain ?? b.hp ?? 0),
    cs: Number(b.cs || 0),
    ar: Number(b.ar || 0),
    od: Number(b.accuracy ?? b.od ?? 0),
    beatmapset_id: Number(b.beatmapset_id || set.id || 0),
    difficulty_rating: Number(b.difficulty_rating || 0),
    id: Number(b.id || 0),
    mode: modeName(b.mode_int ?? 0),
    status: String(b.status || set.status || ''),
    total_length: Number(b.total_length || 0),
    user_id: Number(b.user_id || set.user_id || 0),
    version: String(b.version || ''),
    count_circles: Number(b.count_circles || 0),
    count_sliders: Number(b.count_sliders || 0),
    count_spinners: Number(b.count_spinners || 0),
    max_combo: Number(b.max_combo || 0),
    beatmapset: {
      id: Number(set.id || b.beatmapset_id || 0),
      title: String(set.title_unicode || set.title || ''),
      artist: String(set.artist_unicode || set.artist || ''),
      creator: String(set.creator || ''),
      covers: set.covers || {},
      status: String(set.status || ''),
    },
  };
}

function yumuMods(mods: string[]): Array<{ acronym: string }> {
  const out: Array<{ acronym: string }> = [];
  for (const m of mods || []) {
    const acronym = String(m || '').toUpperCase();
    if (acronym && acronym !== 'NM') out.push({ acronym });
  }
  return out;
}

// ── MatchListener (per match, polls and fans out events) ──

export class MatchListener {
  private timer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private started = false;
  private nowGameId: number | null = null;
  private nowEventId: number;
  private usersIdSet = new Set<number>();
  private userMap = new Map<number, OsuMatchUser>();
  private stopped = false;
  // All outbound side effects (gameStart/gameEnd/gameAbort/error/matchEnd)
  // run through this promise chain so they complete in event order. This
  // keeps polling decoupled from rendering/sending latency while making
  // same-batch events deterministic.
  private eventChain: Promise<void> = Promise.resolve();

  constructor(
    private match: OsuMatch,
    private matchId: number,
    private onEventCb: (type: string, data: any) => Promise<void> | void,
  ) {
    this.nowEventId = match.latest_event_id;
    this.parseUsers(match.events, match.users);
    if (match.current_game_id != null) {
      const gameEvent = [...match.events].reverse().find((e) => e.game != null);
      this.nowGameId = match.current_game_id;
      this.nowEventId = gameEvent ? gameEvent.id - 1 : match.latest_event_id;
      if (gameEvent) this.handleEvent(gameEvent);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.match.match.end_time) {
      this.emit('matchEnd', { type: 'MATCH_END' });
      this.stop('MATCH_END');
      return;
    }
    void this.tick();
    this.killTimer = setTimeout(() => {
      if (!this.stopped) this.stop('TIME_OUT');
    }, TIMEOUT_MS);
  }

  // One poll round, then schedule the next one. Scheduling happens only after
  // a round fully completes, so two listen() calls can never run concurrently.
  private async tick(): Promise<void> {
    await this.listen();
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  stop(type: MatchStopType): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.timer = null;
    this.killTimer = null;
    this.emit('matchEnd', { type });
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private async listen(): Promise<void> {
    if (this.stopped) return;
    let newMatch: OsuMatch;
    try {
      newMatch = await getMatchAfter(this.matchId, this.nowEventId);
    } catch (error) {
      if (this.stopped) return;
      this.emit('error', { error });
      return;
    }
    // A late response may arrive after stop(); it must not touch state or
    // push panels once the listener is stopped.
    if (this.stopped) return;
    try {
      // Stale/older snapshots must never regress already-advanced state.
      if (newMatch.latest_event_id < this.nowEventId) return;
      if (this.nowEventId === newMatch.latest_event_id) return;

      if (newMatch.current_game_id != null) {
        const gameEvent = [...newMatch.events].reverse().find((e) => e.game != null);
        let isAbort = false;
        if (this.nowGameId != null && newMatch.current_game_id !== this.nowGameId) {
          this.nowGameId = newMatch.current_game_id;
          isAbort = true;
        }
        if (gameEvent && this.nowEventId === gameEvent.id - 1 && !isAbort) {
          return;
        } else if (gameEvent) {
          this.nowEventId = gameEvent.id - 1;
        } else {
          this.nowEventId = newMatch.latest_event_id;
        }
      } else {
        this.nowEventId = newMatch.latest_event_id;
        this.nowGameId = null;
      }

      this.parseUsers(newMatch.events, newMatch.users);
      this.addUsers(newMatch.events);
      this.match = newMatch;

      this.onAllEvent(newMatch.events);
      if (newMatch.match.end_time) this.stop('MATCH_END');
    } catch (error) {
      this.emit('error', { error });
    }
  }

  // Serialized side-effect delivery. The chain preserves event order and
  // prevents one slow render from blocking polling (callers never await it).
  private emit(type: string, data: any): void {
    this.eventChain = this.eventChain
      .then(async () => {
        if (this.stopped && type !== 'matchEnd') return;
        await this.onEventCb(type, data);
      })
      .catch((error) => {
        console.error('[match] side-effect delivery failed', type, error);
      });
  }

  private onAllEvent(events: OsuMatchEvent[]): void {
    const gameEvents = events.filter((e) => e.game != null);
    if (gameEvents.length === 0) return;
    if (gameEvents.length > 1) {
      const abortGames = gameEvents.slice(0, -1);
      for (const event of abortGames) {
        const game = event.game!;
        if (game.end_time != null) {
          this.handleEvent(event);
        } else {
          this.emit('gameAbort', { beatmapId: game.beatmap_id });
        }
      }
    }
    this.handleEvent(gameEvents[gameEvents.length - 1]);
  }

  private handleEvent(event: OsuMatchEvent): void {
    const game = event.game;
    if (!game) return;
    const isEnd = game.end_time != null;
    if (isEnd) {
      this.emit('gameEnd', {
        game,
        eventId: event.id,
        users: this.userMap,
      });
    } else {
      const users = [...this.usersIdSet].map((id) => this.userMap.get(id)).filter(Boolean) as OsuMatchUser[];
      this.emit('gameStart', {
        eventId: event.id,
        matchName: this.match.match.name,
        beatmapId: game.beatmap_id,
        startTime: game.start_time,
        mods: game.mods || [],
        isTeamVS: game.team_type === 'team-vs' || game.team_type === 'tag-team-vs',
        teamType: game.team_type,
        users,
      });
    }
  }

  private addUsers(events: OsuMatchEvent[]): void {
    for (const e of events) {
      if (!e.game) continue;
      for (const s of e.game.scores || []) {
        const user = this.userMap.get(Number(s.user_id));
        if (user) (s as unknown as { user?: OsuMatchUser }).user = user;
      }
    }
  }

  private parseUsers(events: OsuMatchEvent[], users: OsuMatchUser[]): void {
    for (const u of users) this.userMap.set(Number(u.id), u);
    for (const e of events) {
      switch (eventType(e.detail?.type || '')) {
        case 'HostChanged':
        case 'PlayerJoined':
          if (e.user_id != null) this.usersIdSet.add(Number(e.user_id));
          break;
        case 'PlayerKicked':
        case 'PlayerLeft':
          if (e.user_id != null) this.usersIdSet.delete(Number(e.user_id));
          break;
        case 'Other':
          if (e.game?.end_time == null) break;
          for (const s of e.game.scores || []) this.usersIdSet.add(Number(s.user_id));
          break;
        default:
          break;
      }
    }
  }
}

// ── MatchManager ──

class MatchManager {
  private listeners = new Map<number, MatchListener>();

  private loadState(): Record<string, MatchListenerState> {
    return (readDb().osuMatchListeners || {}) as Record<string, MatchListenerState>;
  }

  private saveState(state: Record<string, MatchListenerState>): void {
    updateDb((draft: any) => {
      draft.osuMatchListeners = state;
    });
  }

  async handleCommand(
    db: any,
    event: { groupId?: string; userId?: string },
    rawText: string,
    isOwner: boolean,
  ): Promise<MatchCommandResult> {
    const text = String(rawText || '').trim();
    const groupId = String(event.groupId || '');
    const userId = String(event.userId || '');

    // Parse: [matchID] [operate] [#skip]
    const tokens = text.split(/\s+/).filter(Boolean);
    let matchId: number | null = null;
    let operate = '';
    let skip = 0;
    for (const token of tokens) {
      if (/^\d{4,}$/.test(token)) {
        matchId = Number(token);
      } else if (/^#\d+$/.test(token)) {
        skip = Number(token.slice(1));
      } else if (/^(?:info|list|start|stop|end|off|on|[lispefo])$/i.test(token)) {
        operate = token.toLowerCase();
      }
    }

    if (operate === 'list' || operate === 'l') {
      return this.listListeners(db, groupId);
    }

    if (operate === 'stopall' || operate === 'o') {
      return this.stopAll(isOwner);
    }

    if ((operate === 'stop' || operate === 'end' || operate === 'off') && matchId == null) {
      return this.stopByGroup(groupId);
    }

    if (matchId == null) {
      return { text: '用法：!ml <matchID> [skip #N] 开始观战；!ml list 查看本群监听；!ml end [matchID] 结束监听。' };
    }

      return this.startListener(db, event, matchId, skip, isOwner);
  }

  private async startListener(
    db: any,
    event: any,
    matchId: number,
    skip: number,
    isOwner: boolean,
  ): Promise<MatchCommandResult> {
    const groupId = String(event.groupId || '');
    const userId = String(event.userId || '');
    const state = this.loadState();
    const entry = state[String(matchId)];

    if (entry && entry.groups.some((g) => g.groupId === groupId)) {
      return { text: `这个比赛（${entry.matchName || matchId}）本群已经在观战了。` };
    }

    // Limits: GROUP_MAX per group, USER_MAX per user.
    const groupCount = Object.values(state).filter((e) => e.groups.some((g) => g.groupId === groupId)).length;
    if (groupCount >= GROUP_MAX) {
      return { text: `本群最多同时观战 ${GROUP_MAX} 个比赛。先 !ml end 关掉一些。` };
    }
    const userCount = Object.values(state).filter((e) => e.groups.some((g) => g.userId === userId)).length;
    if (userCount >= USER_MAX && !isOwner) {
      return { text: `你最多同时观战 ${USER_MAX} 个比赛。` };
    }

    let match: OsuMatch;
    try {
      match = await getMatch(matchId);
    } catch (error) {
      return { text: `找不到比赛 ${matchId}（${String((error as Error)?.message || error).slice(0, 120)}）。` };
    }
    if (match.match.end_time) {
      return { text: `比赛 ${matchId}（${match.match.name}）已经结束了。` };
    }

    // Skip rounds: lastEventId aligned to the last N-th round event.
    let lastEventId = match.latest_event_id;
    if (skip > 0) {
      const roundEvents = match.events.filter((e) => e.game != null);
      if (roundEvents.length > skip) {
        lastEventId = roundEvents[roundEvents.length - 1 - skip].id - 1;
      } else {
        lastEventId = roundEvents[0]?.id ? roundEvents[0].id - 1 : match.latest_event_id;
      }
    }

    const newState: MatchListenerState = entry
      ? { ...entry, lastEventId, groups: [...entry.groups, { groupId, userId, createdAt: new Date().toISOString() }] }
      : {
          matchName: match.match.name,
          lastEventId,
          groups: [{ groupId, userId, createdAt: new Date().toISOString() }],
          createdAt: new Date().toISOString(),
        };
    state[String(matchId)] = newState;
    this.saveState(state);

    if (!this.listeners.has(matchId)) {
      const listener = new MatchListener(match, matchId, (type, data) =>
        this.handleListenerEvent(matchId, type, data),
      );
      this.listeners.set(matchId, listener);
      listener.start();
    }

    return { text: `开始观战：${match.match.name}（${matchId}）。对局开始/回合结束会推送到本群。` };
  }

  private async handleListenerEvent(matchId: number, type: string, data: any): Promise<void> {
    const state = this.loadState();
    const entry = state[String(matchId)];
    if (!entry) return;
    const groups = entry.groups.slice();

    if (type === 'matchEnd') {
      const text = `比赛监听结束：${entry.matchName || matchId}（${stopTypeText(data?.type)}）。`;
      for (const g of groups) await this.deliver(g.groupId, text);
      this.cleanup(matchId, data?.type === 'MATCH_END' ? 'ended' : 'stopped');
      return;
    }

    if (type === 'error') {
      const text = `比赛监听（${entry.matchName || matchId}）查询失败：${String((data?.error as Error)?.message || data?.error || '').slice(0, 120)}，下轮重试。`;
      for (const g of groups) await this.deliver(g.groupId, text);
      return;
    }

    if (type === 'gameAbort') {
      const text = `比赛 ${entry.matchName || matchId}：本回合被中止（beatmap ${data?.beatmapId}）。`;
      for (const g of groups) await this.deliver(g.groupId, text);
      return;
    }

    if (type === 'gameStart') {
      try {
        await this.renderGameStart(matchId, data, groups);
      } catch (error) {
        const text = `比赛 ${entry.matchName || matchId} 开局渲染失败：${String((error as Error)?.message || error).slice(0, 120)}`;
        for (const g of groups) await this.deliver(g.groupId, text);
      }
      return;
    }

    if (type === 'gameEnd') {
      try {
        await this.renderGameEnd(matchId, data, groups);
      } catch (error) {
        const text = `比赛 ${entry.matchName || matchId} 回合成绩渲染失败：${String((error as Error)?.message || error).slice(0, 120)}`;
        for (const g of groups) await this.deliver(g.groupId, text);
      }
      return;
    }
  }

  private async renderGameStart(matchId: number, data: any, groups: MatchBind[]): Promise<void> {
    const match = await getMatch(matchId);
    const { json } = buildMatchRating(match);
    const beatmap = data.beatmapId ? await getBeatmap(Number(data.beatmapId)) : null;
    if (!beatmap) throw new Error(`谱面 ${data.beatmapId} 获取失败`);

    const payload = {
      match: json,
      mode: modeName((beatmap as any).mode_int ?? 0),
      mods: yumuMods(data.mods || []),
      players: (data.users || []).map((u: OsuMatchUser) => ({
        id: Number(u.id),
        user_id: Number(u.id),
        username: u.username,
        country_code: u.country_code || '',
        avatar_url: u.avatar_url || '',
        is_bot: Boolean(u.is_bot),
        is_deleted: Boolean(u.is_deleted),
        is_online: Boolean(u.is_online),
        is_supporter: Boolean(u.is_supporter),
      })),
      beatmap: yumuBeatmap(beatmap),
      density: approximateDensity(beatmap),
      original: {
        cs: Number(beatmap.cs || 0),
        ar: Number(beatmap.ar || 0),
        od: Number((beatmap as any).od ?? beatmap.accuracy ?? 0),
        hp: Number((beatmap as any).hp ?? beatmap.drain ?? 0),
        bpm: Number(beatmap.bpm || 0),
        drain: Number(beatmap.hit_length || 0),
        total: Number(beatmap.total_length || 0),
      },
    };

    const buffer = await renderPanel('panel_E7', payload);
    const { saveAndGetCqCode } = await import('../bots/render.js');
    const cqCode = saveAndGetCqCode(buffer, 'bp');
    for (const g of groups) await this.deliver(g.groupId, cqCode);
  }

  private async renderGameEnd(matchId: number, data: any, groups: MatchBind[]): Promise<void> {
    const match = await getMatch(matchId);
    const { json, rounds } = buildMatchRating(match);
    const roundId = Number(data.game?.id || 0);
    const foundIndex = rounds.findIndex((r) => r.id === roundId);
    const index = foundIndex >= 0 ? foundIndex : 0;
    // Never substitute a different completed round when the cached snapshot
    // does not contain this round yet: render the raw event game instead.
    const round = foundIndex >= 0 ? rounds[foundIndex] : data.game;

    const payload = {
      match: json,
      round: serializeRound(round),
      index,
      panel: 'RR',
    };

    const buffer = await renderPanel('panel_F3', payload);
    const { saveAndGetCqCode } = await import('../bots/render.js');
    const cqCode = saveAndGetCqCode(buffer, 'bp');
    for (const g of groups) await this.deliver(g.groupId, cqCode);
  }

  private listListeners(db: any, groupId: string): MatchCommandResult {
    const state = this.loadState();
    const entries = Object.entries(state).filter(([, e]) => e.groups.some((g) => g.groupId === groupId));
    if (entries.length === 0) return { text: '本群当前没有观战中的比赛。' };
    const lines = entries.map(([id, e]) => `- ${e.matchName || id}（${id}）`);
    return { text: `本群观战中的比赛：\n${lines.join('\n')}` };
  }

  private stopByGroup(groupId: string): MatchCommandResult {
    const state = this.loadState();
    const removed: string[] = [];
    for (const [id, e] of Object.entries(state)) {
      const before = e.groups.length;
      e.groups = e.groups.filter((g) => g.groupId !== groupId);
      if (e.groups.length !== before) removed.push(`${e.matchName || id}（${id}）`);
      if (e.groups.length === 0) delete state[id];
    }
    if (removed.length === 0) return { text: '本群没有观战中的比赛。' };
    this.saveState(state);
    // Stop listeners that lost all groups.
    for (const [id, listener] of [...this.listeners]) {
      if (!state[String(id)]) {
        listener.stop('USER_STOP');
        this.listeners.delete(id);
      }
    }
    return { text: `已停止本群的观战：\n${removed.join('\n')}` };
  }

  private stopAll(isOwner: boolean): MatchCommandResult {
    if (!isOwner) return { text: 'stopall 仅 owner 可用。' };
    const state = this.loadState();
    const count = Object.keys(state).length;
    this.saveState({});
    for (const [id, listener] of [...this.listeners]) {
      listener.stop('SUPER_STOP');
      this.listeners.delete(id);
    }
    return { text: `已停止全部 ${count} 个观战。` };
  }

  private cleanup(matchId: number, reason: string): void {
    const state = this.loadState();
    if (reason === 'ended') {
      delete state[String(matchId)];
      this.saveState(state);
    }
    this.listeners.delete(matchId);
  }

  private async deliver(groupId: string, content: string): Promise<void> {
    // Event delivery goes through the same OneBot channel Wuxin uses for all
    // outbound messages; callers provide a sendMessage that resolves groupId.
    const sender = (globalThis as any).__matchSender;
    if (!sender) return;
    await sender({ type: 'group', groupId, userId: '' }, content);
  }

  async restore(db: any): Promise<void> {
    const state = this.loadState();
    for (const [id, e] of Object.entries(state)) {
      const matchId = Number(id);
      if (!Number.isFinite(matchId) || this.listeners.has(matchId)) continue;
      try {
        const match = await getMatch(matchId);
        if (match.match.end_time) {
          delete state[id];
          continue;
        }
        const listener = new MatchListener(match, matchId, (type, data) =>
          this.handleListenerEvent(matchId, type, data),
        );
        this.listeners.set(matchId, listener);
        listener.start();
      } catch {
        delete state[id];
      }
    }
    this.saveState(state);
  }
}

function stopTypeText(type: string): string {
  switch (type) {
    case 'MATCH_END': return '比赛正常结束';
    case 'USER_STOP': return '调用者关闭';
    case 'SUPER_STOP': return '超级管理员关闭';
    case 'SERVER_REBOOT': return '服务器重启';
    case 'TIME_OUT': return '超时（6 小时无新事件）';
    default: return type || '已停止';
  }
}

export const matchManager = new MatchManager();

export function setMatchSender(fn: SendMessage): void {
  (globalThis as any).__matchSender = fn;
}
