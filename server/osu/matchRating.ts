// MatchRating — TS port of yumu-bot's MatchRating.kt (osu! multiplayer rating
// model). Output is serialized with snake_case keys so yumu-image's panel_E7 /
// panel_F3 renderers can consume it unchanged.

import type {
  OsuMatch,
  OsuMatchEvent,
  OsuMatchRound,
  OsuLazerScore,
  OsuMatchUser,
} from './types.js';

export interface RatingParam {
  skip?: number;
  ignore?: number;
  remove?: number[] | null;
  easy?: number;
  delete?: boolean;
  rematch?: boolean;
}

export interface PlayerClassDef {
  english: string;
  chinese: string;
  color: string;
  category: string;
}

const CLASS = (english: string, chinese: string, color: string, category = ''): PlayerClassDef => ({
  english,
  chinese,
  color,
  category,
});

const PC: Record<string, PlayerClassDef> = {
  BC: CLASS('Big Carry', '大爹', '#FFF100', 'BC'),
  CA: CLASS('Carry', '大哥', '#FF9800', 'CA'),
  MF: CLASS('Main Force', '主力', '#22AC38', 'MF'),
  SP: CLASS('Specialized', '专精', '#B3D465', 'SP'),
  WF: CLASS('Work Force', '打工', '#0068B7', 'WF'),
  GE: CLASS('General', '普通', '#BDBDBD', 'GE'),
  GU: CLASS('Guest', '客串', '#00A0E9', 'GU'),
  SU: CLASS('Support', '抗压', '#9922EE', 'SU'),
  SG: CLASS('Scapegoat', '背锅', '#E4007F', 'SG'),
  NO: CLASS('Noob', '小弟', '#EB6877', 'NO'),
  FU: CLASS('Futile', '炮灰', '#D32F2F', 'FU'),
  SMA: CLASS('Strongest Marshal', '最强元帅', '#FFF100', 'BC'),
  CMA: CLASS('Competent Marshal', '称职元帅', '#FFF100', 'BC'),
  IMA: CLASS('Indomitable Marshal', '不屈元帅', '#FFF100', 'BC'),
  EGE: CLASS('Ever-Victorious General', '常胜将军', '#FF9800', 'CA'),
  AGE: CLASS('Assiduous General', '勤奋将军', '#FF9800', 'CA'),
  SGE: CLASS('Striven General', '尽力将军', '#FF9800', 'CA'),
  BMF: CLASS('Breakthrough Main Force', '突破主力', '#22AC38', 'MF'),
  RMF: CLASS('Reliable Main Force', '可靠主力', '#22AC38', 'MF'),
  SMF: CLASS('Staunch Main Force', '坚守主力', '#22AC38', 'MF'),
  EAS: CLASS('Elite Assassin', '精锐刺客', '#B3D465', 'SP'),
  NAS: CLASS('Normal Assassin', '普通刺客', '#B3D465', 'SP'),
  FAS: CLASS('Fake Assassin', '冒牌刺客', '#B3D465', 'SP'),
  GCW: CLASS('Gold Collar Worker', '金领工人', '#0068B7', 'WF'),
  WCW: CLASS('White Collar Worker', '白领工人', '#0068B7', 'WF'),
  BCW: CLASS('Blue Collar Worker', '蓝领工人', '#0068B7', 'WF'),
  KPS: CLASS('Key Person', '关键人', '#BDBDBD', 'GE'),
  CMN: CLASS('Common Man', '普通人', '#BDBDBD', 'GE'),
  PSB: CLASS('Passer-by', '路人甲', '#BDBDBD', 'GE'),
  MAC: CLASS('Major Character', '主要角色', '#00A0E9', 'GU'),
  MIC: CLASS('Minor Character', '次要角色', '#00A0E9', 'GU'),
  FIG: CLASS('Figurant', '群众演员', '#00A0E9', 'GU'),
  SAM: CLASS('Stable as Mountain', '稳如泰山', '#9922EE', 'SU'),
  HAS: CLASS('Hard as Stone', '坚若磐石', '#9922EE', 'SU'),
  SIN: CLASS('Seriously Injured', '伤痕累累', '#9922EE', 'SU'),
  ANI: CLASS('Advanced Ninja', '上等忍者', '#E4007F', 'SG'),
  MNI: CLASS('Mediocre Ninja', '普通忍者', '#E4007F', 'SG'),
  LCS: CLASS('Lower-class', '不入流', '#E4007F', 'SG'),
  LKD: CLASS('Lucky Dog', '幸运儿', '#EB6877', 'NO'),
  QAP: CLASS('Qualified Apprentice', '合格学徒', '#EB6877', 'NO'),
  BGN: CLASS('Beginner', '初学者', '#EB6877', 'NO'),
  LSS: CLASS('Life-saving Straw', '救命稻草', '#D32F2F', 'FU'),
  LSP: CLASS('Little Spark', '点点星火', '#D32F2F', 'FU'),
  BDT: CLASS('Burnt Dust', '湮灭尘埃', '#D32F2F', 'FU'),
};

function getV1(eraIndex: number, draIndex: number): string {
  const e = eraIndex;
  const d = draIndex;
  if (e < 1 / 6) {
    if (d < 1 / 6) return 'BC';
    if (d < 2 / 6) return 'CA';
    if (d < 4 / 6) return 'MF';
    return 'SP';
  }
  if (e < 2 / 6) {
    if (d < 2 / 6) return 'CA';
    if (d < 4 / 6) return 'MF';
    return 'SP';
  }
  if (e < 4 / 6) {
    if (d < 2 / 6) return 'WF';
    if (d < 4 / 6) return 'GE';
    return 'GU';
  }
  if (e < 5 / 6) {
    if (d < 2 / 6) return 'SU';
    if (d < 4 / 6) return 'SG';
    return 'NO';
  }
  if (d < 2 / 6) return 'SU';
  if (d < 4 / 6) return 'SG';
  if (d < 5 / 6) return 'NO';
  return 'FU';
}

function getV2(eraIndex: number, draIndex: number, rwsIndex: number): string {
  const base = getV1(eraIndex, draIndex);
  const r = rwsIndex;
  switch (base) {
    case 'BC': return r < 1 / 9 ? 'SMA' : r < 3 / 9 ? 'CMA' : 'IMA';
    case 'FU': return r < 6 / 9 ? 'LSS' : r < 8 / 9 ? 'LSP' : 'BDT';
    case 'CA': return r < 2 / 9 ? 'EGE' : r < 4 / 9 ? 'AGE' : 'SGE';
    case 'MF': return r < 2 / 9 ? 'BMF' : r < 5 / 9 ? 'RMF' : 'SMF';
    case 'SP': return r < 3 / 9 ? 'EAS' : r < 6 / 9 ? 'NAS' : 'FAS';
    case 'WF': return r < 2 / 9 ? 'GCW' : r < 5 / 9 ? 'WCW' : 'BCW';
    case 'GE': return r < 3 / 9 ? 'KPS' : r < 6 / 9 ? 'CMN' : 'PSB';
    case 'GU': return r < 4 / 9 ? 'MAC' : r < 7 / 9 ? 'MIC' : 'FIG';
    case 'SU': return r < 3 / 9 ? 'SAM' : r < 6 / 9 ? 'HAS' : 'SIN';
    case 'SG': return r < 4 / 9 ? 'ANI' : r < 7 / 9 ? 'MNI' : 'LCS';
    case 'NO': return r < 5 / 9 ? 'LKD' : r < 7 / 9 ? 'QAP' : 'BGN';
    default: return 'CMN';
  }
}

interface PlayerData {
  player: OsuMatchUser;
  team: string | null;
  scores: number[];
  roundWinShares: number[];
  total: number;
  rawRatings: number[];
  totalMuPoint: number;
  averageMuPoint: number;
  normalizedMuPoint: number;
  era: number;
  dra: number;
  mra: number;
  rws: number;
  playerClass: string | null;
  eraIndex: number;
  draIndex: number;
  rwsIndex: number;
  ranking: number;
  win: number;
  lose: number;
  associatedRoundCount: number;
}

function createPlayerData(player: OsuMatchUser): PlayerData {
  return {
    player,
    team: null,
    scores: [],
    roundWinShares: [],
    total: 0,
    rawRatings: [],
    totalMuPoint: 0,
    averageMuPoint: 0,
    normalizedMuPoint: 0,
    era: 0,
    dra: 0,
    mra: 0,
    rws: 0,
    playerClass: null,
    eraIndex: 0,
    draIndex: 0,
    rwsIndex: 0,
    ranking: 0,
    win: 0,
    lose: 0,
    associatedRoundCount: 0,
  };
}

function roundTeamScores(round: OsuMatchRound): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of round.scores) {
    const team = s.player_stat?.team ?? 'none';
    out[team] = (out[team] || 0) + Number(s.score || 0);
  }
  return out;
}

function roundIsTeamVs(round: OsuMatchRound): boolean {
  return round.team_type === 'team-vs' || round.team_type === 'tag-team-vs';
}

function roundWinningTeam(round: OsuMatchRound): string | null {
  if (!roundIsTeamVs(round)) return 'none';
  const teams = roundTeamScores(round);
  const red = teams['red'] || 0;
  const blue = teams['blue'] || 0;
  return red > blue ? 'red' : red < blue ? 'blue' : null;
}

function roundWinningTeamScore(round: OsuMatchRound): number {
  if (!roundIsTeamVs(round)) return round.scores.reduce((sum, s) => sum + Number(s.score || 0), 0);
  const teams = roundTeamScores(round);
  return Math.max(teams['red'] || 0, teams['blue'] || 0);
}

function roundMaxScore(round: OsuMatchRound): number {
  return round.scores.reduce((max, s) => Math.max(max, Number(s.score || 0)), 0);
}

function modsContain(mods: string[], acronym: string): boolean {
  return mods.some((m) => String(m).toUpperCase() === acronym.toUpperCase());
}

function applyParams(
  fullRounds: OsuMatchRound[],
  param: Required<Pick<RatingParam, 'delete' | 'rematch' | 'easy'>> & RatingParam,
  fullPlayers: Map<number, OsuMatchUser>,
): OsuMatchRound[] {
  let rounds = fullRounds.slice();

  if (param.delete) {
    rounds = rounds.map((round) => {
      if (round.scores.length > 0) {
        return { ...round, scores: round.scores.filter((s) => Number(s.score || 0) > 10000) };
      }
      return round;
    });
  }

  if (!param.rematch) {
    // Keep the last occurrence of each beatmap.
    const seen = new Set<number>();
    const kept: OsuMatchRound[] = [];
    for (let i = rounds.length - 1; i >= 0; i--) {
      if (!seen.has(rounds[i].beatmap_id)) {
        seen.add(rounds[i].beatmap_id);
        kept.push(rounds[i]);
      }
    }
    rounds = kept.reverse();
  }

  const size = rounds.length;
  const skip = Math.max(0, Math.min(param.skip ?? 0, size));
  const limit = Math.max(skip, Math.min(size - (param.ignore ?? 0), size));
  if (skip !== 0 || limit !== size) {
    rounds = rounds.slice(skip, limit);
  }

  if (param.remove && param.remove.length > 0) {
    const removeSet = new Set(
      param.remove.map((idx) => idx - skip).filter((idx) => idx >= 1 && idx < limit - skip),
    );
    if (removeSet.size > 0) {
      rounds = rounds.filter((_, index) => !removeSet.has(index));
    }
  }

  for (const round of rounds) {
    for (const s of round.scores) {
      if (param.easy !== 1 && modsContain(s.mods || [], 'EZ')) {
        s.score = Math.round(Number(s.score || 0) * (param.easy ?? 1));
      }
    }
    round.scores = [...round.scores].sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .map((s, index) => ({ ...s, ranking: index + 1 }));
  }

  for (const s of rounds.flatMap((r) => r.scores)) {
    const user = fullPlayers.get(Number(s.user_id));
    if (user) (s as unknown as { user?: OsuMatchUser }).user = user;
  }

  return rounds;
}

// ── Serialization helpers (snake_case, matching yumu-bot JSON) ──

export function serializeRound(round: OsuMatchRound): Record<string, unknown> {
  const teams = roundTeamScores(round);
  return {
    id: round.id,
    beatmap: round.beatmap || null,
    beatmap_id: round.beatmap_id,
    start_time: round.start_time,
    end_time: round.end_time ?? null,
    mode_int: round.mode_int ?? null,
    mods: round.mods || [],
    scores: (round.scores || []).map((s) => ({
      id: s.id ?? null,
      user_id: s.user_id,
      score: s.score,
      max_combo: s.max_combo ?? null,
      mods: s.mods || [],
      accuracy: s.accuracy ?? null,
      passed: s.passed ?? null,
      statistics: s.statistics || null,
      ranking: s.ranking ?? 0,
      player_stat: s.player_stat || null,
    })),
    team_type: round.team_type,
    scoring_type: round.scoring_type,
    is_team_vs: roundIsTeamVs(round),
    red_team_score: teams['red'] || 0,
    blue_team_score: teams['blue'] || 0,
    total_team_score: round.scores.reduce((sum, s) => sum + Number(s.score || 0), 0),
    max_score: roundMaxScore(round),
    winning_team: roundWinningTeam(round),
    winning_team_score: roundWinningTeamScore(round),
  };
}

function serializeEvent(event: OsuMatchEvent): Record<string, unknown> {
  return {
    id: event.id,
    detail: event.detail,
    timestamp: event.timestamp,
    user_id: event.user_id ?? null,
    game: event.game ? serializeRound(event.game) : null,
  };
}

function serializeMatch(match: OsuMatch): Record<string, unknown> {
  return {
    match: {
      id: match.match.id,
      start_time: match.match.start_time,
      end_time: match.match.end_time ?? null,
      name: match.match.name,
    },
    events: match.events.map(serializeEvent),
    users: match.users,
    first_event_id: match.first_event_id,
    latest_event_id: match.latest_event_id,
    current_game_id: match.current_game_id ?? null,
    is_match_end: Boolean(match.match.end_time),
  };
}

// ── Public entry ──

export interface MatchRatingJson {
  match: Record<string, unknown>;
  is_skipping: boolean;
  round_count: number;
  score_count: number;
  player_count: number;
  is_team_vs: boolean;
  average_star: number;
  first_map_bid: number;
  first_map_sid: number;
  skip_ignore_map: { skip: number; ignore: number; easy: number };
  team_point_map: Record<string, number>;
  player_data_list: Array<Record<string, unknown>>;
}

export interface MatchRatingResult {
  json: MatchRatingJson;
  rounds: OsuMatchRound[];
}

export function buildMatchRating(match: OsuMatch, param: RatingParam = {}): MatchRatingResult {
  const fullRounds = match.events
    .map((e) => e.game)
    .filter((r): r is OsuMatchRound => Boolean(r && r.scores.length > 0 && r.end_time))
    .filter((r, index, arr) => arr.findIndex((x) => x.id === r.id) === index);

  const fullPlayers = new Map<number, OsuMatchUser>();
  for (const p of match.users || []) fullPlayers.set(Number(p.id), p);

  const rounds = applyParams(fullRounds, {
    skip: param.skip ?? 0,
    ignore: param.ignore ?? 0,
    remove: param.remove ?? null,
    easy: param.easy ?? 1,
    delete: param.delete ?? true,
    rematch: param.rematch ?? true,
  }, fullPlayers);

  const scores = rounds.flatMap((r) => r.scores);
  const hasScoreSet = new Set(scores.map((s) => Number(s.user_id)));
  const players = new Map<number, OsuMatchUser>();
  for (const [id, p] of fullPlayers) {
    if (hasScoreSet.has(id)) players.set(id, p);
  }

  const playerData = new Map<number, PlayerData>();
  for (const [id, p] of players) playerData.set(id, createPlayerData(p));

  // calculateRawRating
  for (const r of rounds) {
    const roundScoreSum = r.scores.reduce((sum, s) => sum + Number(s.score || 0), 0);
    const roundScoreCount = r.scores.length;
    if (roundScoreSum === 0 || roundScoreCount === 0) continue;
    for (const s of r.scores) {
      if (!Number(s.score)) continue;
      const data = playerData.get(Number(s.user_id));
      if (!data) continue;
      data.rawRatings.push(Number(s.score) * roundScoreCount / roundScoreSum);
      data.scores.push(Number(s.score));
      if (data.team === null) data.team = s.player_stat?.team ?? null;
    }
  }

  // calculateAverageRoundWinShare
  for (const r of rounds) {
    const winningScore = roundWinningTeamScore(r);
    if (winningScore === 0) continue;
    const winner = roundWinningTeam(r);
    const maxScore = roundMaxScore(r);
    for (const s of r.scores) {
      if (!Number(s.score)) continue;
      const data = playerData.get(Number(s.user_id));
      if (!data) continue;
      let rws = 0;
      if (roundIsTeamVs(r)) {
        const team = s.player_stat?.team ?? null;
        if (team === winner) {
          rws = Number(s.score) / winningScore;
          data.win++;
        } else if (!winner || !team) {
          rws = Number(s.score) / winningScore;
        } else {
          data.lose++;
        }
      } else {
        if (Number(s.score) >= maxScore) {
          rws = Number(s.score) / winningScore;
          data.win++;
        } else {
          data.lose++;
        }
      }
      data.roundWinShares.push(rws);
    }
  }

  for (const d of playerData.values()) d.total = d.scores.reduce((a, b) => a + b, 0);

  let roundAMG = 0;
  for (const d of playerData.values()) {
    d.totalMuPoint = d.rawRatings.reduce((a, b) => a + b, 0);
    d.averageMuPoint = d.rawRatings.length > 0 ? d.totalMuPoint / d.rawRatings.length : 0;
    d.rws = d.roundWinShares.length > 0
      ? d.roundWinShares.reduce((a, b) => a + b, 0) / d.roundWinShares.length
      : 0;
    d.associatedRoundCount = rounds.length;
    roundAMG += d.averageMuPoint;
  }

  const playerCount = players.size;
  const aAMG = playerCount > 0 ? roundAMG / playerCount : 0;
  const scalingFactor = playerCount <= 2 ? 0 : 2 / (1 + Math.exp(0.5 - 0.25 * playerCount)) - 1;
  let minMQ = 100;
  for (const d of playerData.values()) {
    d.normalizedMuPoint = aAMG !== 0 ? d.averageMuPoint / aAMG : 0;
    minMQ = Math.min(minMQ, d.normalizedMuPoint);
  }

  for (const d of playerData.values()) {
    d.era = (d.normalizedMuPoint - minMQ * scalingFactor) / (1 - minMQ * scalingFactor);
    d.dra = scores.length > 0 ? (d.totalMuPoint / scores.length) * playerCount : 0;
    d.mra = 0.7 * d.era + 0.3 * d.dra;
  }

  // calculateIndex
  const values = [...playerData.values()];
  const maxIndex = Math.max(values.length - 1, 1);
  if (values.length > 0) {
    [...values].sort((a, b) => b.era - a.era).forEach((d, i) => {
      d.eraIndex = values.length > 1 ? i / maxIndex : 0.5;
    });
    [...values].sort((a, b) => b.dra - a.dra).forEach((d, i) => {
      d.draIndex = values.length > 1 ? i / maxIndex : 0.5;
    });
    [...values].sort((a, b) => b.rws - a.rws || b.dra - a.dra).forEach((d, i) => {
      d.rwsIndex = values.length > 1 ? i / maxIndex : 0.5;
    });
    [...values].sort((a, b) => b.mra - a.mra).forEach((d, i) => {
      d.ranking = i + 1;
    });
  }

  for (const d of playerData.values()) {
    d.playerClass = getV2(d.eraIndex, d.draIndex, d.rwsIndex);
  }

  const firstRound = rounds[0] ?? null;
  const firstBeatmap = firstRound?.beatmap ?? null;
  const teamPointMap: Record<string, number> = {};
  for (const r of rounds) {
    const winner = roundWinningTeam(r);
    if (winner) teamPointMap[winner] = (teamPointMap[winner] || 0) + 1;
  }

  const playerDataList = [...playerData.values()].sort((a, b) => b.mra - a.mra).map((d) => ({
    player: d.player,
    team: d.team,
    total: d.total,
    era: d.era,
    dra: d.dra,
    mra: d.mra,
    rws: d.rws,
    player_class: d.playerClass ? PC[d.playerClass] : null,
    ranking: d.ranking,
    win: d.win,
    lose: d.lose,
    arc: d.associatedRoundCount,
  }));

  const json: MatchRatingJson = {
    match: serializeMatch(match),
    is_skipping: Boolean(param.skip && param.skip > 0),
    round_count: rounds.length,
    score_count: scores.length,
    player_count: players.size,
    is_team_vs: rounds[0]?.team_type === 'team-vs' || rounds[0]?.team_type === 'tag-team-vs'
      || [...match.events].reverse().find((e) => e.game)?.game?.team_type === 'team-vs'
      || [...match.events].reverse().find((e) => e.game)?.game?.team_type === 'tag-team-vs',
    average_star: rounds.length > 0
      ? rounds.reduce((sum, r) => sum + (r.beatmap?.difficulty_rating ?? 0), 0) / rounds.length
      : 0,
    first_map_bid: firstRound?.beatmap_id ?? 0,
    first_map_sid: firstBeatmap?.beatmapset_id ?? 0,
    skip_ignore_map: { skip: param.skip ?? 0, ignore: param.ignore ?? 0, easy: param.easy ?? 1 },
    team_point_map: teamPointMap,
    player_data_list: playerDataList,
  };
  return { json, rounds };
}
