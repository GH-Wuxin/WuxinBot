import assert from 'node:assert/strict';

process.env.OSU_CLIENT_ID = 'retry-verify-client';
process.env.OSU_CLIENT_SECRET = 'retry-verify-secret';
process.env.OSU_TOKEN_URL = 'http://auth.test/oauth/token';
process.env.OSU_API_BASE_URL = 'http://api.test/api/v2';

const originalFetch = globalThis.fetch;
const attemptsByUser = new Map();

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

  const match = /\/users\/(\d+)\/scores\/best/.exec(url);
  assert(match, `unexpected URL: ${url}`);
  const userId = Number(match[1]);
  const attempts = (attemptsByUser.get(userId) || 0) + 1;
  attemptsByUser.set(userId, attempts);

  const aborted = new Error('This operation was aborted');
  aborted.name = 'AbortError';
  if (userId === 1 && attempts === 1) throw aborted;
  if (userId === 2) throw aborted;

  return new Response(JSON.stringify([{ id: 123, beatmap: { id: 456 } }]), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

try {
  const { getUserBestScores } = await import('../server/osu/api.ts');

  const scores = await getUserBestScores(1, 'osu', 3);
  assert.equal(attemptsByUser.get(1), 2, 'GET should retry once after AbortError');
  assert.equal(scores[0]?.beatmap?.id, 456, 'retry should return the successful response');

  await assert.rejects(
    () => getUserBestScores(2, 'osu', 3),
    /osu! API 请求超时（已自动重试 1 次）/,
    'exhausted retries should produce an actionable error instead of raw AbortError',
  );
  assert.equal(attemptsByUser.get(2), 2, 'GET retry must remain bounded to one retry');

  console.log('PASS: osu! API GET retries one transient abort and normalizes exhausted timeout errors');
} finally {
  globalThis.fetch = originalFetch;
}
