// osu! API v2 type definitions — kept lean. Only the fields the analyzer reads.

export interface OsuToken {
  access_token: string;
  token_type: string;
  expires_at: number;
}

export interface OsuUser {
  id: number;
  username: string;
  country_code: string;
  avatar_url: string;
  cover_url?: string;
  is_online: boolean;
  playstyle?: string[];
  join_date: string;
  statistics: OsuUserStats;
  rank_history?: { mode: string; data: number[] };
  rank_highest?: { rank: number; updated_at: string };
  grade_counts: { ss: number; ssh: number; s: number; sh: number; a: number };
  follower_count: number;
  support_level: number;
  unranked_beatmapset_count?: number;
  ranked_beatmapset_count?: number;
}

export interface OsuUserStats {
  level: { current: number; progress: number };
  global_rank: number | null;
  country_rank: number | null;
  pp: number;
  ranked_score: number;
  total_score: number;
  total_hits: number;
  hit_accuracy: number;
  play_count: number;
  play_time: number;
  maximum_combo: number;
  replays_watched_by_others: number;
  is_ranked: boolean;
  grade_counts: { ss: number; s: number; a: number };
}

export interface OsuBeatmapset {
  id: number;
  title: string;
  artist: string;
  creator: string;
  status: string;
  genre?: { name: string };
  language?: { name: string };
  covers: { cover: string; 'cover@2x': string; list: string; 'list@2x': string };
  beatmaps?: OsuBeatmap[];
}

export interface OsuBeatmap {
  id: number;
  beatmapset_id: number;
  mode: 'osu' | 'taiko' | 'fruits' | 'mania';
  difficulty_rating: number;
  version: string;
  accuracy: number;
  ar: number;
  bpm: number;
  cs: number;
  drain: number;
  total_length: number;
  hit_length: number;
  max_combo: number;
  count_circles: number;
  count_sliders: number;
  count_spinners: number;
  status: string;
  url: string;
  beatmapset?: OsuBeatmapset;
}

export interface OsuScore {
  id: number;
  accuracy: number;
  max_combo: number;
  mods: string[];
  pp: number;
  rank: string;
  score: number;
  statistics: {
    count_50: number;
    count_100: number;
    count_300: number;
    count_geki: number;
    count_katsu: number;
    count_miss: number;
  };
  beatmap: OsuBeatmap;
  beatmapset: OsuBeatmapset;
  created_at: string;
  /** ISO timestamp of when the score was set (v2 /scores/best includes this). */
  ended_at?: string;
  mode: string;
  user_id: number;
  weight?: { percentage: number; pp: number };
  /** Star rating returned by /beatmaps/{id}/attributes for this score's exact Mods. */
  modded_star_rating?: number;
  /** Distinguishes verified Mod-adjusted stars from the beatmap's base difficulty_rating. */
  star_rating_source?: 'modded' | 'base' | 'unavailable';
}

export type OsuMode = 'osu' | 'taiko' | 'fruits' | 'mania';

// ── osu! multiplayer match (v2 /matches) ──

export interface OsuMatchUser {
  id: number;
  username: string;
  country_code?: string;
  avatar_url?: string;
  is_bot?: boolean;
  is_deleted?: boolean;
  is_online?: boolean;
  is_supporter?: boolean;
  [key: string]: unknown;
}

export interface OsuLazerScore {
  id?: number;
  user_id: number;
  score: number;
  max_combo?: number;
  mods: string[];
  passed?: boolean;
  accuracy?: number;
  statistics?: {
    count_300?: number;
    count_100?: number;
    count_50?: number;
    count_miss?: number;
    count_geki?: number;
    count_katsu?: number;
  };
  player_stat?: {
    team?: string | null;
    slot?: number;
  };
  [key: string]: unknown;
}

export interface OsuMatchRound {
  id: number;
  beatmap?: OsuBeatmap | null;
  beatmap_id: number;
  start_time: string;
  end_time?: string | null;
  mode_int?: number;
  mods: string[];
  scores: OsuLazerScore[];
  team_type: string;
  scoring_type: string;
}

export interface OsuMatchEvent {
  id: number;
  detail: {
    type: string;
    text?: string;
  };
  timestamp: string;
  user_id?: number | null;
  game?: OsuMatchRound | null;
}

export interface OsuMatch {
  match: {
    id: number;
    start_time: string;
    end_time?: string | null;
    name: string;
  };
  events: OsuMatchEvent[];
  users: OsuMatchUser[];
  first_event_id: number;
  latest_event_id: number;
  current_game_id?: number | null;
}

export interface OsuFixture {
  user: OsuUser;
  bestScores: OsuScore[];
  recentScores: OsuScore[];
}
