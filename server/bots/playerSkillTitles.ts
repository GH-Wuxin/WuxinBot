import type { PlayerSkillArchetype, PlayerSkillTier } from './playerSkillProfile.js';

export const PLAYER_SKILL_TITLE_POLICY_ID = 'AGGREGATE_SPECIALTY_FOUR_TIER_TITLES_V02';

// One catalog for profile data and cards. Names describe the measured specialty;
// the existing evidence and strength rules decide the class, never player names.
export const PLAYER_SKILL_TITLES: Readonly<Record<PlayerSkillArchetype, Readonly<Record<PlayerSkillTier, string>>>> = {
  ALL_ROUNDER: { BEGINNER: 'Rookie', PLAYER: 'Flex', EXPERT: 'All-Round Ace', WORLD_CLASS: 'Multiskill Virtuoso' },
  AIM: { BEGINNER: 'Rookie', PLAYER: 'Aimer', EXPERT: 'Aim Pro', WORLD_CLASS: 'Aiming Ascendant' },
  JUMP: { BEGINNER: 'Rookie', PLAYER: 'Snapper', EXPERT: 'Snap Ace', WORLD_CLASS: 'Ballistic Virtuoso' },
  FLOW: { BEGINNER: 'Rookie', PLAYER: 'Glider', EXPERT: 'Flow Rider', WORLD_CLASS: 'Kinetic Virtuoso' },
  PRECISION: { BEGINNER: 'Rookie', PLAYER: 'Pinpoint', EXPERT: 'Precision Ace', WORLD_CLASS: 'Precision Paragon' },
  CONTROL: { BEGINNER: 'Rookie', PLAYER: 'Pivot', EXPERT: 'Cursor Pilot', WORLD_CLASS: 'Trajectory Architect' },
  FLOW_SPEED: { BEGINNER: 'Rookie', PLAYER: 'Stream Runner', EXPERT: 'Torrent Rider', WORLD_CLASS: 'Torrential Virtuoso' },
  SPEED: { BEGINNER: 'Rookie', PLAYER: 'Blitz', EXPERT: 'Rapidfire', WORLD_CLASS: 'Tapping Overdrive' },
  RHYTHM: { BEGINNER: 'Rookie', PLAYER: 'Beatkeeper', EXPERT: 'Rhythm Pilot', WORLD_CLASS: 'Cadence Conductor' },
  STAMINA: { BEGINNER: 'Rookie', PLAYER: 'Ironhand', EXPERT: 'Stream Tank', WORLD_CLASS: 'Percussive Colossus' },
  ENDURANCE: { BEGINNER: 'Rookie', PLAYER: 'Longrunner', EXPERT: 'Marathon Ace', WORLD_CLASS: 'Endurance Titan' },
  READING: { BEGINNER: 'Rookie', PLAYER: 'Scout', EXPERT: 'Pattern Seeker', WORLD_CLASS: 'Perception Savant' },
  TECH: { BEGINNER: 'Rookie', PLAYER: 'Technician', EXPERT: 'Pattern Artisan', WORLD_CLASS: 'Mechanical Virtuoso' },
};
