// player-target-verify.mjs — player resolution must never misattribute data.
// Bound users resolve by exact binding (clan-tag insensitive); unbound users
// are never guessed from QQ nicknames; group nicknames resolve through binding.
import {
  normalizePlayerName,
  resolveInternalPlayerTarget,
  resolveInternalPlayerTargetDetailed,
} from '../server/bots/executor.ts';

let failed = 0;
function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failed++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

const db = {
  osuBindings: {
    'REDACTED_QQ_006': { id: 24579916, username: '[SHK] Pain boy' },
    'REDACTED_QQ_004': { id: 13833144, username: '[SHK]Hina' },
    'REDACTED_QQ_001': { id: 19244792, username: '[SHK]Wuxin' },
    'REDACTED_QQ_007': { id: 8692802, username: '[SHK]Guozi 1611' },
  },
  users: [],
  messages: [
    { role: 'user', groupId: 'REDACTED_GROUP_004', userId: 'REDACTED_QQ_001', nickname: '不像人', createdAt: '2026-08-07T07:00:00Z' },
    { role: 'user', groupId: 'REDACTED_GROUP_004', userId: 'REDACTED_QQ_004', nickname: '地雷女', createdAt: '2026-08-07T07:10:00Z' },
    { role: 'user', groupId: 'REDACTED_GROUP_004', userId: 'REDACTED_QQ_008', nickname: '774', createdAt: '2026-08-07T07:20:00Z' },
    { role: 'assistant', groupId: 'REDACTED_GROUP_004', userId: 'bot', nickname: '机器人', createdAt: '2026-08-07T07:21:00Z' },
    { role: 'user', groupId: 'REDACTED_GROUP_004', userId: 'REDACTED_QQ_006', nickname: 'Pain boy', createdAt: '2026-08-07T07:30:00Z' },
  ],
};

console.log('=== normalizePlayerName ===');
assert(normalizePlayerName('[SHK] Pain boy') !== normalizePlayerName('pain boy'), 'normalization must preserve legal bracket characters');
assert(normalizePlayerName('[A]same') !== normalizePlayerName('[B]same'), 'different tagged usernames must never collapse');
assert(normalizePlayerName('  地雷女 ') === '地雷女', 'whitespace must be trimmed');

console.log('\n=== requester binding wins (misattribution fix) ===');
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', 'Pain boy', {
    nickname: 'Pain boy',
    groupId: 'REDACTED_GROUP_004',
  });
  assert(r.target?.kind === 'id' && r.target.value === 24579916, '"Pain boy" must resolve to bound [SHK] Pain boy id');
}
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', '[SHK] Pain boy', {});
  assert(r.target?.kind === 'id' && r.target.value === 24579916, 'exact tagged name must resolve to binding id');
}

console.log('\n=== @-mention binding wins ===');
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', 'Hina', { atTargets: ['REDACTED_QQ_004'] });
  assert(r.target?.kind === 'id' && r.target.value === 13833144, 'mentioned bound member must resolve to their binding');
}
{
  const dbWithSelf = { ...db, settings: { selfQq: 'REDACTED_QQ_002' } };
  const r = resolveInternalPlayerTargetDetailed(dbWithSelf, 'REDACTED_QQ_006', '', {
    atTargets: ['REDACTED_QQ_002', 'REDACTED_QQ_004'],
  });
  assert(r.target?.kind === 'id' && r.target.value === 13833144, 'pure @ target must beat requester binding while bot @ is ignored');
}
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', '[OTHER] Pain boy', {});
  assert(r.target?.kind === 'username' && r.target.value === '[OTHER] Pain boy', 'an explicitly different tag must stay an explicit username');
}

console.log('\n=== group nickname resolves through binding ===');
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', '地雷女', { groupId: 'REDACTED_GROUP_004' });
  assert(r.target?.kind === 'id' && r.target.value === 13833144, 'group nickname 地雷女 must resolve to [SHK]Hina');
}

console.log('\n=== unbound nickname guessing is blocked ===');
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_008', '774', {
    nickname: '774',
    groupId: 'REDACTED_GROUP_004',
  });
  assert(r.target === null && r.reason === 'unbound_requester_nickname', 'unbound requester using own nickname must be blocked');
}
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', '774', {
    nickname: 'Pain boy',
    groupId: 'REDACTED_GROUP_004',
  });
  assert(r.target === null && r.reason === 'group_member_unbound', 'unbound group member must not be guessed');
}

console.log('\n=== explicit osu username stays explicit ===');
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', 'Boring', { groupId: 'REDACTED_GROUP_004' });
  assert(r.target?.kind === 'username' && r.target.value === 'Boring', 'unknown name must be queried as explicit username');
}

console.log('\n=== no explicit username uses binding / fails honestly ===');
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', '', {});
  assert(r.target?.kind === 'id' && r.target.value === 24579916, 'bound requester without username resolves to own binding');
}
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_008', '', {});
  assert(r.target === null && r.reason === 'no_target', 'unbound requester without username returns no_target');
}

console.log('\n=== wrapper keeps compatibility ===');
assert(
  resolveInternalPlayerTarget(db, 'REDACTED_QQ_006', 'Pain boy', { nickname: 'Pain boy', groupId: 'REDACTED_GROUP_004' })?.value === 24579916,
  'resolveInternalPlayerTarget wrapper must return target only',
);

console.log('\n=== legacy osuUsername fallback ===');
{
  const legacyDb = { ...db, users: [{ userId: 'u1', osuUsername: 'legacy_player' }] };
  const r = resolveInternalPlayerTargetDetailed(legacyDb, 'u1', '', {});
  assert(r.target?.kind === 'username' && r.target.value === 'legacy_player', 'legacy users fallback must keep working');
}

if (failed > 0) {
  console.error(`\nPLAYER-TARGET-VERIFY FAILED (${failed})`);
  process.exit(1);
}
console.log('\nplayer target resolution passed');
process.exit(0);
