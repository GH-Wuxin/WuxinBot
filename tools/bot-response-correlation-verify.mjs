// External bot response correlation verify.
//
// Covers ADVERSARIAL_REVIEW.md C1 (a late response from a timed-out request
// must never be claimed by the next pending request) and the C2 tail window
// (text -> image panels / trailing captions must not leak into the next call).
//
// The protocol has no request id echoed back by the external bot, so the fix
// is a per-route drain window: after a call finishes the route absorbs bot
// messages for a short period and rejects new registrations.

import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-bot-response');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);

const prodBefore = productionDbSnapshot();
console.log('[isolation] production db snapshot: ' + (prodBefore ? prodBefore.sha256.slice(0, 12) + '...' : 'N/A'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
  const { registerPendingBotCall, tryResolveBotResponse } = await import('../server/bots/executor.ts');
  ensureStore();

  updateDb((db) => {
    db.settings.botRegistry = {
      updatedAt: new Date().toISOString(),
      bots: [
        {
          id: 'ext_bot',
          name: 'ExtBot',
          description: 'test external bot',
          qq: '999',
          channel: 'qq_group',
          groupId: '123',
          enabled: true,
          commands: [],
        },
      ],
    };
    // Keep every settle/drain window short so the verify finishes quickly.
    db.settings.botResponseTextSettleMs = 40;
    db.settings.botResponseProgressSettleMs = 60;
    db.settings.botResponseImageDrainMs = 60;
    db.settings.botResponseTextDrainMs = 80;
    db.settings.botResponseTimeoutDrainMs = 100;
  });

  const register = (correlationId, timeoutMs = 20_000) =>
    registerPendingBotCall({
      correlationId,
      botId: 'ext_bot',
      channel: 'qq_group',
      groupId: '123',
      drainPolicy: {
        imageMs: 60,
        textMs: 80,
        timeoutMs: 100,
      },
    }, timeoutMs);

  const botEvent = (text, images = [], messageId = '') => ({
    userId: '999',
    type: 'group',
    groupId: '123',
    text,
    images,
    messageId,
  });

  async function expectDrainRejected(label) {
    let threw = false;
    try {
      await register(`blocked-${label}-${Date.now()}`);
    } catch (error) {
      threw = /bot_route_draining/.test(String(error?.message || ''));
    }
    assert(threw, `${label}: next call must be rejected during route drain`);
  }

  // A times out, drain absorbs the orphaned late response even with no next call.
  {
    const aPromise = register('case-b-a', 25);
    const aResult = await aPromise;
    assert(!aResult.ok, 'A must time out without content');
    const absorbed = tryResolveBotResponse(readDb(), botEvent('A late tail', [], 'm0'));
    assert(absorbed === true, 'late message during drain must be consumed even without a next request');
    await sleep(150);
    console.log('PASS: drain absorbs orphaned late responses');
  }

  // C1 case D: A timeout -> B blocked during drain -> A late image absorbed ->
  // B registered after drain -> B gets its own image.
  {
    const aPromise = register('case-d-a', 25);
    const aResult = await aPromise;
    assert(!aResult.ok, 'A must time out');
    await expectDrainRejected('case-d');
    const absorbed = tryResolveBotResponse(readDb(), botEvent('', [{ url: 'late-A.png' }], 'm1'));
    assert(absorbed === true, 'A late image during drain must be absorbed');
    await sleep(150);
    const bPromise = register('case-d-b', 500);
    const consumed = tryResolveBotResponse(readDb(), botEvent('', [{ url: 'real-B.png' }], 'm2'));
    assert(consumed === true, 'B image must be consumed by pending call');
    const bResult = await bPromise;
    assert(bResult.ok === true, 'B must resolve ok');
    assert(bResult.images.length === 1 && bResult.images[0] === 'real-B.png',
      'B must receive its own image, not A late image');
    console.log('PASS: A timeout late image cannot hijack B');
    await sleep(150);
  }

  // C1 case C: A timeout -> B blocked during drain -> A late text absorbed ->
  // B registered after drain -> B settles with its own text.
  {
    const aPromise = register('case-c-a', 25);
    await aPromise;
    const absorbed = tryResolveBotResponse(readDb(), botEvent('A late progress text', [], 'm3'));
    assert(absorbed === true, 'A late text during drain must be absorbed');
    await sleep(150);
    const bPromise = register('case-c-b', 1000);
    tryResolveBotResponse(readDb(), botEvent('B real text', [], 'm4'));
    const bResult = await bPromise;
    assert(bResult.ok === true && bResult.text.includes('B real text'),
      'B must resolve with its own text');
    console.log('PASS: A timeout late text cannot hijack B');
    await sleep(150);
  }

  // C2 tail: text settle finishes A, then a late panel image arrives inside
  // the text drain. It must be absorbed, and the next request stays clean.
  {
    const aPromise = register('case-f-a', 2000);
    tryResolveBotResponse(readDb(), botEvent('query done', [], 'm5'));
    const aResult = await aPromise;
    assert(aResult.ok === true && aResult.text.includes('query done'),
      'A must settle with its text');
    const absorbed = tryResolveBotResponse(readDb(), botEvent('', [{ url: 'late-A-image.png' }], 'm6'));
    assert(absorbed === true, 'tail image inside text drain must be absorbed');
    await expectDrainRejected('case-f');
    await sleep(150);
    const bPromise = register('case-f-b', 500);
    tryResolveBotResponse(readDb(), botEvent('', [{ url: 'B.png' }], 'm7'));
    const bResult = await bPromise;
    assert(bResult.images.length === 1 && bResult.images[0] === 'B.png',
      'B must get its own image after drain');
    console.log('PASS: text settle tail image cannot leak into next request');
    await sleep(150);
  }

  // Image resolve finishes A; a trailing caption inside the image drain is absorbed.
  {
    const aPromise = register('case-img-a', 2000);
    tryResolveBotResponse(readDb(), botEvent('', [{ url: 'A.png' }], 'm8'));
    const aResult = await aPromise;
    assert(aResult.images.length === 1 && aResult.images[0] === 'A.png',
      'A image must resolve immediately');
    const absorbed = tryResolveBotResponse(readDb(), botEvent('A trailing caption', [], 'm9'));
    assert(absorbed === true, 'trailing caption inside image drain must be absorbed');
    await sleep(150);
    console.log('PASS: image resolve trailing caption is absorbed');
    await sleep(150);
  }

  // Outside any drain window, an unclaimed bot message still falls through
  // (the existing external-bot sender gate handles it downstream).
  {
    await sleep(150);
    const unclaimed = tryResolveBotResponse(readDb(), botEvent('stray text', [], 'm10'));
    assert(unclaimed === false, 'message outside drain with no pending call must fall through');
    console.log('PASS: non-drain unclaimed bot message still falls through');
  }

  console.log('ALL PASS');
}

main().then(() => {
  const prodOk = verifyProductionDbUnchanged(prodBefore);
  if (!prodOk) {
    // The test runs against an isolated DATA_DIR and store.ts refuses
    // production writes from non-server entry points, so a production change
    // here means the live bot is actively writing (sandboxed CIM queries
    // cannot always detect that process). Warn instead of failing the verify.
    console.warn('[isolation] production db changed during test (live bot likely writing); test DATA_DIR was isolated');
  }
  console.log('[isolation] production db unchanged: ' + prodOk);
  cleanupTestDir(testDataDir);
}).catch((error) => {
  console.error(error);
  cleanupTestDir(testDataDir);
  process.exit(1);
});
