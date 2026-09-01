import assert from 'node:assert/strict';
import { assertSkillProfilerIdentity, skillProfilerIdentityKey, skillProfilerReleaseLabel } from '../server/bots/skillProfiler.ts';
import { compactSkillProfilerSnapshot } from '../server/bots/skillProfilerFeedback.ts';
import { buildSkillProfilerCardPayload } from '../server/bots/skillProfilerCard.ts';

const beta = { algorithmId: 'MAP_DEMAND_DECOUPLED_V010_BETA1', mapDemandVersion: '0.10.0-beta.1' };
const stable = { algorithmId: 'MAP_DEMAND_ATOMIC_V096', mapDemandVersion: '0.9.6' };
const analysis = { status: 'OK', beatmap: { beatmap_id: 12345 }, axes: {},
  mod_context: { requested_mods: ['HD', 'DT'], effective_mods: ['HD', 'DT'] },
  identity: { algorithm_id: beta.algorithmId, map_demand_version: beta.mapDemandVersion } };
assert.notEqual(skillProfilerIdentityKey(beta), skillProfilerIdentityKey(stable));
assert.doesNotThrow(() => assertSkillProfilerIdentity(analysis, beta));
assert.throws(() => assertSkillProfilerIdentity(analysis, stable), /VERSION_CHANGED/);
assert.equal(skillProfilerReleaseLabel('0.10.0-beta.1'), '0.10.0-beta.1 · 试用');
assert.equal(skillProfilerReleaseLabel('0.9.6'), '');
assert.equal(skillProfilerReleaseLabel('<script>'), '');
assert.equal(buildSkillProfilerCardPayload(analysis).analysis.releaseLabel, '0.10.0-beta.1 · 试用');
const feedback = compactSkillProfilerSnapshot(analysis);
assert.equal(feedback.mapDemandVersion, beta.mapDemandVersion);
assert.equal(feedback.algorithmId, beta.algorithmId);
assert.equal(feedback.beatmapId, 12345);
assert.deepEqual(feedback.mods, ['HD', 'DT']);
console.log('Skill Profiler public beta identity, cache key, card label and feedback PASS');
