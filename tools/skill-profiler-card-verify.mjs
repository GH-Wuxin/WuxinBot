import assert from 'node:assert/strict';
import { buildSkillProfilerCardPayload } from '../server/bots/skillProfilerCard.ts';

const axis = (stars, confidence = 'MEDIUM', unit = 'star_equivalent') => ({
  stars,
  confidence,
  unit,
});

const payload = buildSkillProfilerCardPayload({
  status: 'OK',
  beatmap: {
    beatmap_id: 4288226,
    beatmapset_id: 1946744,
    artist: 'Fixture Artist',
    title: 'Fixture Title',
    version: 'Expert',
    creator: 'Fixture Mapper',
    local_nm_stars: 7.42,
  },
  analysis_context: {
    bpm_max: 240,
    duration_ms: 123000,
    difficulty: { ApproachRate: 9.6, OverallDifficulty: 9.2, CircleSize: 4, HPDrainRate: 6 },
    effective_difficulty: { ApproachRate: 10.4, OverallDifficulty: 10.1, CircleSize: 4, HPDrainRate: 6 },
  },
  mod_context: {
    requested_mods: ['HD', 'DT', 'PF'],
    effective_mods: ['HD', 'DT'],
    neutral_mods: ['PF'],
  },
  axes: {
    aim_control: axis(8.2, 'HIGH'),
    jump_aim: axis(6.4),
    spatial_precision: axis(7.1),
    flow_aim: axis(9.0, 'HIGH'),
    raw_speed: axis(7.3),
    finger_control: axis(6.2),
    stamina: axis(7.8, 'MEDIUM', 'bounded_0_10'),
    endurance: axis(7.0, 'MEDIUM', 'bounded_0_10'),
    reading: axis(9.1, 'HIGH'),
  },
  archetype: {
    primary_type: 'FLOW_AIM_READING',
    dominant_axes: ['flow_aim', 'reading'],
  },
  experimental_type: {
    stage: 'EXPERIMENTAL',
    status: 'PROPOSED',
    classifier_version: 'fixture-experimental',
    summary: {
      status: 'PROPOSED',
      primary_type: 'STREAM',
      secondary_types: ['ALT', 'GIMMICK'],
      composition_types: ['STREAM', 'TECH', 'ALT'],
      gimmick_subtype: 'LOW_AR_READING',
    },
  },
  identity: { algorithm_id: 'MUST_NOT_RENDER', map_demand_version: 'MUST_NOT_RENDER' },
}, {
  beatmap: { bpm: 200, total_length: 180 },
  starRating: 8.765,
}, {
  sourceLabel: 'FixturePlayer 的 BP#2',
});

assert.equal(payload.beatmap.coverUrl, 'https://assets.ppy.sh/beatmaps/1946744/covers/fullsize.jpg');
assert.equal(payload.analysis.mods, 'HDDTPF');
assert.deepEqual(payload.analysis.modList, ['HD', 'DT', 'PF']);
assert.equal(payload.analysis.neutralMods, 'PF');
assert.equal(payload.analysis.sourceLabel, 'FixturePlayer 的 BP#2');
assert.equal(payload.beatmap.stars, 8.765);
assert.equal(payload.beatmap.bpm, 200, 'official BPM wins over the computed fallback');
assert.equal(payload.beatmap.lengthSeconds, 180, 'official length wins over the computed fallback');
assert.equal(payload.beatmap.ar, 10.4, 'card uses clock-adjusted effective AR');
assert.equal(payload.beatmap.od, 10.1, 'card uses clock-adjusted effective OD');
assert.equal(payload.beatmap.cs, 4, 'clock mods do not alter CS');
assert.equal(payload.beatmap.hp, 6, 'clock mods do not alter HP');
assert.deepEqual(payload.groups.aim.map((item) => item.label), [
  'Aim Control', 'Jump Aim', 'Micro Precision', 'Flow Aim',
]);
assert.deepEqual(payload.groups.tapping.map((item) => item.label), [
  'Raw Speed', 'Finger Control', 'Stamina', 'Endurance',
]);
assert.deepEqual(payload.groups.reading.map((item) => item.label), ['Reading']);
assert.deepEqual(payload.analysis.mapType, {
  experimental: true,
  available: true,
  primary: 'Stream',
  secondary: ['Alt', 'Gimmick', 'Tech'],
  gimmickSubtype: 'LOW AR READING',
});
assert.doesNotMatch(JSON.stringify(payload), /MUST_NOT_RENDER|algorithm_id|map_demand_version/i);

const fallbackPayload = buildSkillProfilerCardPayload({
  status: 'OK',
  beatmap: {
    beatmap_id: 1,
    beatmapset_id: 2,
    title: 'Fallback metadata',
  },
  analysis_context: { clock_rate: 1.5, difficulty: {} },
  mod_context: { effective_mods: ['HD', 'DT'] },
  archetype: { status: 'INSUFFICIENT_EVIDENCE', primary_type: null, dominant_axes: [] },
  axes: {
    aim_control: axis(1), jump_aim: axis(1), spatial_precision: axis(1), flow_aim: axis(1),
    raw_speed: axis(1), finger_control: axis(1), stamina: axis(1, 'LOW', 'bounded_0_10'),
    endurance: axis(1, 'LOW', 'bounded_0_10'), reading: axis(1),
  },
}, {
  beatmap: { bpm: 180, total_length: 150 },
  starRating: 6.54,
});
assert.equal(fallbackPayload.beatmap.stars, 6.54);
assert.equal(fallbackPayload.beatmap.bpm, 270, 'DT clock rate adjusts official base BPM');
assert.equal(fallbackPayload.beatmap.lengthSeconds, 100, 'DT clock rate adjusts official base length');
assert.equal(fallbackPayload.analysis.primaryType, '暂无主导维度');

const strictModPayload = buildSkillProfilerCardPayload({
  status: 'OK',
  beatmap: { beatmap_id: 1, local_nm_stars: 5.5 },
  analysis_context: { difficulty: {} },
  mod_context: { effective_mods: ['HR'] },
  axes: {
    aim_control: axis(1), jump_aim: axis(1), spatial_precision: axis(1), flow_aim: axis(1),
    raw_speed: axis(1), finger_control: axis(1), stamina: axis(1, 'LOW', 'bounded_0_10'),
    endurance: axis(1, 'LOW', 'bounded_0_10'), reading: axis(1),
  },
});
assert.equal(strictModPayload.beatmap.stars, null, 'NM stars never masquerade as Mod-adjusted stars');
assert.equal(strictModPayload.analysis.mapType.experimental, true);
assert.equal(strictModPayload.analysis.mapType.available, false);
assert.equal(strictModPayload.analysis.mapType.primary, '暂无明确类型');
assert.equal(strictModPayload.analysis.sourceLabel, '');

console.log('PASS: Skill Profiler card is 3-group image data with Tapping and no algorithm version');
