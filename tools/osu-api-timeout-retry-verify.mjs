import assert from 'node:assert/strict';

process.env.OSU_CLIENT_ID = 'retry-verify-client';
process.env.OSU_CLIENT_SECRET = 'retry-verify-secret';
process.env.OSU_TOKEN_URL = 'http://auth.test/oauth/token';
process.env.OSU_API_BASE_URL = 'http://api.test/api/v2';

const originalFetch = globalThis.fetch;
const attemptsByUser = new Map();
let playerLookupCount = 0;

globalThis.fetch = async (input) => {
  const url = String(input);
  if (url === process.env.OSU_TOKEN_URL) {
    return new Response(JSON.stringify({
      access_token: 'retry-verify-token',
      token_type: 'Bearer',
      expires_in: 3600,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (url.includes('/users/@fixture-user/osu')) {
    playerLookupCount += 1;
    return new Response(JSON.stringify({ id: 99, username: 'fixture-user' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const match = /\/users\/(\d+)\/scores\/best/.exec(url);
  assert(match, `unexpected URL: ${url}`);
  const userId = Number(match[1]);
  const attempts = (attemptsByUser.get(userId) || 0) + 1;
  attemptsByUser.set(userId, attempts);

  const aborted = new Error('This operation was aborted');
  aborted.name = 'AbortError';
  if (userId === 1 && attempts === 1) throw aborted;
  if (userId === 2) throw aborted;
  if (userId === 3) await new Promise((resolve) => setImmediate(resolve));

  return new Response(JSON.stringify([{ id: 123, beatmap: { id: 456 } }]), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

try {
  const { getUser, getUserById, getUserBestScores } = await import('../server/osu/api.ts');

  const namedUser = await getUser('fixture-user', 'osu');
  const sameUserById = await getUserById(namedUser.id, 'osu');
  assert.equal(sameUserById.username, 'fixture-user');
  assert.equal(playerLookupCount, 1, 'username lookup should populate the numeric user-id cache alias');

  const scores = await getUserBestScores(1, 'osu', 3);
  assert.equal(attemptsByUser.get(1), 2, 'GET should retry once after AbortError');
  assert.equal(scores[0]?.beatmap?.id, 456, 'retry should return the successful response');

  await assert.rejects(
    () => getUserBestScores(2, 'osu', 3),
    /osu! API 请求超时（已自动重试 1 次）/,
    'exhausted retries should produce an actionable error instead of raw AbortError',
  );
  assert.equal(attemptsByUser.get(2), 2, 'GET retry must remain bounded to one retry');

  const [first, second] = await Promise.all([
    getUserBestScores(3, 'osu', 20),
    getUserBestScores(3, 'osu', 20),
  ]);
  assert.equal(attemptsByUser.get(3), 1, 'identical concurrent GETs should share one upstream request');
  assert.deepEqual(first, second, 'coalesced callers should receive the same successful payload');

  console.log('PASS: osu! API GET coalesces identical in-flight reads, retries one transient abort, and normalizes exhausted timeout errors');
} finally {
  globalThis.fetch = originalFetch;
}
