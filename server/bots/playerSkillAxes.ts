/**
 * One user-facing order for the nine player-skill dimensions.
 *
 * Keep this catalog separate from the aggregation implementation so profile,
 * compare, recent-profile, and text renderers cannot silently drift apart.
 */
export const PLAYER_SKILL_AXIS_ORDER = [
  'jump_aim',
  'flow_aim',
  'aim_control',
  'spatial_precision',
  'raw_speed',
  'finger_control',
  'reading',
  'stamina',
  'endurance',
] as const;

export type PlayerSkillAxis = typeof PLAYER_SKILL_AXIS_ORDER[number];

export const PLAYER_SKILL_AXIS_DEFINITIONS: ReadonlyArray<{
  key: PlayerSkillAxis;
  label: string;
  abbr: string;
  color: string;
  unit: 'star' | 'independent';
}> = [
  { key: 'jump_aim', label: 'Jump Aim', abbr: 'JP', color: '#76b3ed', unit: 'star' },
  { key: 'flow_aim', label: 'Flow Aim', abbr: 'FL', color: '#72edc5', unit: 'star' },
  { key: 'aim_control', label: 'Aim Control', abbr: 'AC', color: '#eab885', unit: 'star' },
  { key: 'spatial_precision', label: 'Spatial Precision', abbr: 'PR', color: '#c1a9f0', unit: 'star' },
  { key: 'raw_speed', label: 'Raw Speed', abbr: 'SP', color: '#f3d786', unit: 'star' },
  { key: 'finger_control', label: 'Finger Control', abbr: 'FC', color: '#e9a8be', unit: 'star' },
  { key: 'reading', label: 'Reading', abbr: 'RD', color: '#a8c9d0', unit: 'star' },
  { key: 'stamina', label: 'Stamina', abbr: 'ST', color: '#afb4d8', unit: 'independent' },
  { key: 'endurance', label: 'Endurance', abbr: 'EN', color: '#9bcbb8', unit: 'independent' },
];

export const PLAYER_SKILL_AXIS_LABELS: Readonly<Record<PlayerSkillAxis, string>> =
  Object.fromEntries(PLAYER_SKILL_AXIS_DEFINITIONS.map(({ key, label }) => [key, label])) as Record<PlayerSkillAxis, string>;
