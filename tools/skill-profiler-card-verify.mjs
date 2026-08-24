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
  identity: { algorithm_id: 'MUST_NOT_RENDER', map_demand_version: 'MUST_NOT_RENDER' },
});

assert.equal(payload.beatmap.coverUrl, 'https://assets.ppy.sh/beatmaps/1946744/covers/cover.jpg');
assert.equal(payload.analysis.mods, 'HDDTPF');
assert.equal(payload.analysis.neutralMods, 'PF');
assert.deepEqual(payload.groups.aim.map((item) => item.label), [
  'Aim Control', 'Jump Aim', 'Spatial Precision', 'Flow Aim',
]);
assert.deepEqual(payload.groups.tapping.map((item) => item.label), [
  'Raw Speed', 'Finger Control', 'Stamina', 'Endurance',
]);
assert.deepEqual(payload.groups.reading.map((item) => item.label), ['Reading']);
assert.doesNotMatch(JSON.stringify(payload), /MUST_NOT_RENDER|algorithm_id|map_demand_version/i);

console.log('PASS: Skill Profiler card is 3-group image data with Tapping and no algorithm version');
