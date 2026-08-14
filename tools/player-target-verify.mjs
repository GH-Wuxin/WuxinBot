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
    'REDACTED_QQ_006': { id: 10000005, username: '[TST]Foxtrot' },
    'REDACTED_QQ_004': { id: 10000006, username: '[TST]India' },
    'REDACTED_QQ_001': { id: 10000001, username: '[TST]Alpha' },
    'REDACTED_QQ_007': { id: 10000007, username: '[TST]Juliett' },
  },
  users: [],
  messages: [
    { role: 'user', groupId: 'REDACTED_GROUP_004', userId: 'REDACTED_QQ_001', nickname: 'member-alpha', createdAt: '2026-08-07T07:00:00Z' },
    { role: 'user', groupId: 'REDACTED_GROUP_004', userId: 'REDACTED_QQ_004', nickname: 'member-india', createdAt: '2026-08-07T07:10:00Z' },
    { role: 'user', groupId: 'REDACTED_GROUP_004', userId: 'REDACTED_QQ_008', nickname: 'member-charlie', createdAt: '2026-08-07T07:20:00Z' },
    { role: 'assistant', groupId: 'REDACTED_GROUP_004', userId: 'bot', nickname: '机器人', createdAt: '2026-08-07T07:21:00Z' },
    { role: 'user', groupId: 'REDACTED_GROUP_004', userId: 'REDACTED_QQ_006', nickname: 'foxtrot', createdAt: '2026-08-07T07:30:00Z' },
  ],
};

console.log('=== normalizePlayerName ===');
assert(normalizePlayerName('[TST]Foxtrot') !== normalizePlayerName('pain boy'), 'normalization must preserve legal bracket characters');
assert(normalizePlayerName('[A]same') !== normalizePlayerName('[B]same'), 'different tagged usernames must never collapse');
assert(normalizePlayerName('  member-india ') === 'member-india', 'whitespace must be trimmed');

console.log('\n=== requester binding wins (misattribution fix) ===');
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', 'foxtrot', {
    nickname: 'foxtrot',
    groupId: 'REDACTED_GROUP_004',
  });
  assert(r.target?.kind === 'id' && r.target.value === 10000005, '"foxtrot" must resolve to bound [TST]Foxtrot id');
}
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', '[TST]Foxtrot', {});
  assert(r.target?.kind === 'id' && r.target.value === 10000005, 'exact tagged name must resolve to binding id');
}

console.log('\n=== @-mention binding wins ===');
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', 'India', { atTargets: ['REDACTED_QQ_004'] });
  assert(r.target?.kind === 'id' && r.target.value === 10000006, 'mentioned bound member must resolve to their binding');
}
{
  const dbWithSelf = { ...db, settings: { selfQq: 'REDACTED_QQ_002' } };
  const r = resolveInternalPlayerTargetDetailed(dbWithSelf, 'REDACTED_QQ_006', '', {
    atTargets: ['REDACTED_QQ_002', 'REDACTED_QQ_004'],
  });
  assert(r.target?.kind === 'id' && r.target.value === 10000006, 'pure @ target must beat requester binding while bot @ is ignored');
}
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', '[OTHER] foxtrot', {});
  assert(r.target?.kind === 'username' && r.target.value === '[OTHER] foxtrot', 'an explicitly different tag must stay an explicit username');
}

console.log('\n=== group nickname resolves through binding ===');
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', 'member-india', { groupId: 'REDACTED_GROUP_004' });
  assert(r.target?.kind === 'id' && r.target.value === 10000006, 'group nickname member-india must resolve to [TST]India');
}

console.log('\n=== unbound nickname guessing is blocked ===');
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_008', 'member-charlie', {
    nickname: 'member-charlie',
    groupId: 'REDACTED_GROUP_004',
  });
  assert(r.target === null && r.reason === 'unbound_requester_nickname', 'unbound requester using own nickname must be blocked');
}
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', 'member-charlie', {
    nickname: 'foxtrot',
    groupId: 'REDACTED_GROUP_004',
  });
  assert(r.target === null && r.reason === 'group_member_unbound', 'unbound group member must not be guessed');
}

console.log('\n=== explicit osu username stays explicit ===');
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', 'Hotel', { groupId: 'REDACTED_GROUP_004' });
  assert(r.target?.kind === 'username' && r.target.value === 'Hotel', 'unknown name must be queried as explicit username');
}

console.log('\n=== no explicit username uses binding / fails honestly ===');
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_006', '', {});
  assert(r.target?.kind === 'id' && r.target.value === 10000005, 'bound requester without username resolves to own binding');
}
{
  const r = resolveInternalPlayerTargetDetailed(db, 'REDACTED_QQ_008', '', {});
  assert(r.target === null && r.reason === 'no_target', 'unbound requester without username returns no_target');
}

console.log('\n=== wrapper keeps compatibility ===');
assert(
  resolveInternalPlayerTarget(db, 'REDACTED_QQ_006', 'foxtrot', { nickname: 'foxtrot', groupId: 'REDACTED_GROUP_004' })?.value === 10000005,
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
