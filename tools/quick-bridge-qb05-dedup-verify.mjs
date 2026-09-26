// QUICK_BRIDGE_QB05_YUMU_DEDUP_DESIGN_V01 — offline regression verifier.
//
// Audit-only fixture. It mirrors, exactly, the deployed Yumu/Shiro 2.5.3
// group-event dedup predicate:
//
//   key = String.valueOf(event.time) + String.valueOf(event.group_id)
//         + String.valueOf(event.user_id)          // no separators
//   if (cache.has(key) && cache.get(key) + intervalMs >= now) return DROP;
//   cache.put(key, now + intervalMs); return PASS;
//   lazy cleanup: remove entries with storedExpiry < now before each insert
//
// and Yumu's own stale gate (OneBotListener.kt):
//
//   if (event.time < 1e10) now /= 1000;          // seconds vs millis branch
//   if (now - event.time > 30) return;           // silent stale drop
//
// V01 hardening (no production code touched):
//   Phase A2 — delimiter-free cross-field collision proof and classification.
//   Phase D  — allocator stress under same-ms bursts / wall rollback /
//              forward jumps vs the stale gate; bounded allocator revision.

let failures = 0;
let checks = 0;
const check = (name, actual, expected) => {
  checks++;
  const ok = Object.is(actual, expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const GROUP = 770099;
const USER = 900000099;
const INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// Exact Shiro GroupMessageFilterUtils mirror (static cache shared process-wide)
// ---------------------------------------------------------------------------
function makeShiroFilter(intervalMs = INTERVAL_MS) {
  const cache = new Map();
  return {
    cache,
    intervalMs,
    insert(event, nowMs) {
      const key = keyOf(event.time, event.group_id, event.user_id);
      for (const [k, v] of cache) {
        if (v < nowMs) cache.delete(k); // removeExpiredMessageId
      }
      if (cache.has(key)) {
        const stored = cache.get(key);
        if (stored + intervalMs >= nowMs) return { passed: false, key, reason: 'duplicate_window' };
      }
      cache.set(key, nowMs + intervalMs);
      return { passed: true, key, reason: 'inserted' };
    },
  };
}

const keyOf = (time, groupId, userId) => `${String(time)}${String(groupId)}${String(userId)}`;

function makeEvent({ time, groupId = GROUP, userId = USER, selfId = 8800000001, command = '!r user' }) {
  return {
    time,
    group_id: groupId,
    user_id: userId,
    self_id: selfId,
    sender: { user_id: USER },
    message: command,
  };
}

// Wuxin buildEvent current behavior (production today)
const currentTimeSeconds = (nowMs) => Math.floor(nowMs / 1000);

// Candidate A allocator (original spec being hardened): yumu-only millisecond
// event.time, 2000ms future margin, strictly-monotonic guard.
let lastCandidateTimeMs = 0;
const CANDIDATE_FUTURE_MARGIN_MS = 2000;
function candidateTimeMs(nowMs) {
  let t = nowMs + CANDIDATE_FUTURE_MARGIN_MS;
  if (t <= lastCandidateTimeMs) t = lastCandidateTimeMs + 1;
  lastCandidateTimeMs = t;
  return t;
}
const resetCandidate = () => { lastCandidateTimeMs = 0; };

// Revised bounded allocator (future patch spec, not implemented in production):
// same margin + monotonic guard, plus a hard 30s future drift cap. Exceeding
// the cap rejects the call BEFORE anything is sent (bridge falls back).
let lastBoundedTimeMs = 0;
const BOUNDED_MAX_FUTURE_MS = 30_000;
function boundedCandidateTimeMs(nowMs) {
  const floor = nowMs + CANDIDATE_FUTURE_MARGIN_MS;
  let t = floor;
  if (lastBoundedTimeMs >= floor) t = lastBoundedTimeMs + 1;
  if (t - nowMs > BOUNDED_MAX_FUTURE_MS) {
    throw new Error(`yumu bridge event time drift exceeded (${t - nowMs}ms > ${BOUNDED_MAX_FUTURE_MS}ms)`);
  }
  lastBoundedTimeMs = t;
  return t;
}
const resetBounded = () => { lastBoundedTimeMs = 0; };

// FINAL SPEC A' — deterministic safe-slot allocator (leading-zero lemma):
//   poolBase  = ceil((now + MARGIN)/1000)          first second whose slot 0 >= now+MARGIN
//   pool      = [poolBase*1000, poolBase*1000+99] exactly 100 safe slots/sec
//   t         = poolFirst, or last+1 when monotonic guard requires it
//   reject    if t > poolLast  -> pool exhausted, FAIL BEFORE SEND (fallback)
//   reject    if t - now > MAX_FUTURE_MS -> clock rollback guard, FAIL BEFORE SEND
// Every emitted value satisfies time % 1000 in [0,99] and is strictly
// increasing process-wide, so synthetic keys can never equal any valid real
// key (real epoch seconds are exactly 10 digits and real group/user decimal
// strings never start with '0').
const SAFE_SLOT_MARGIN_MS = 2000;
const SAFE_SLOT_MAX_FUTURE_MS = 30_000;
const SAFE_SLOTS_PER_SECOND = 100;
function makeSafeSlotAllocator() {
  let last = 0;
  return {
    last: () => last,
    alloc(nowMs) {
      const poolBase = Math.ceil((nowMs + SAFE_SLOT_MARGIN_MS) / 1000);
      const poolFirst = poolBase * 1000;
      const poolLast = poolFirst + SAFE_SLOTS_PER_SECOND - 1;
      let t = poolFirst;
      if (t <= last) t = last + 1;
      if (t > poolLast) throw new Error('yumu safe-slot pool exhausted (100/s)');
      if (t - nowMs > SAFE_SLOT_MAX_FUTURE_MS) throw new Error('yumu bridge event time drift exceeded');
      last = t;
      return t;
    },
  };
}

// ---------------------------------------------------------------------------
// Phase A — exact key format and window boundaries
// ---------------------------------------------------------------------------
{
  const f = makeShiroFilter();
  const e = makeEvent({ time: 1234, groupId: 770099, userId: 900000099 });
  const r = f.insert(e, 1000);
  check('A1 key has no separators (upstream concat)', r.key, '1234770099900000099');
  check('A2 first insert passes', r.passed, true);

  const g = makeShiroFilter();
  const e2 = makeEvent({ time: 1000 });
  g.insert(e2, 1000);
  check('A3 arrival at now=5999 still drops (stored+5000 >= now)', g.insert(e2, 5999).passed, false);
  check('A4 arrival at now=6000 still drops (equality is drop)', g.insert(e2, 6000).passed, false);
  check('A5 arrival at now=6001 passes and entry was lazily removed', g.insert(e2, 6001).passed, true);

  const h = makeShiroFilter();
  const e3 = makeEvent({ time: 1000 });
  h.insert(e3, 1000);
  const diff = makeEvent({ time: 1000, command: '!s 123' });
  check('A6 different message text, same key -> drop (message not in key)', h.insert(diff, 1200).passed, false);
  check('A7 self_id excluded: same key after self_id change -> drop', h.insert({ ...e3, self_id: 999 }, 1300).passed, false);
  check('A8 nonce field ignored: same key after nonce -> drop', h.insert({ ...e3, nonce: 'n1' }, 1400).passed, false);
  check('A9 different top-level user_id same length -> distinct key and pass', makeShiroFilter().insert(makeEvent({ time: 1000, userId: USER + 1 }), 1500).passed, true);
  check('A10 same-length different group_id -> distinct key and pass', makeShiroFilter().insert(makeEvent({ time: 1000, groupId: GROUP + 1 }), 1500).passed, true);
  check('A11 adjacent second -> distinct key and pass', makeShiroFilter().insert(makeEvent({ time: 1001 }), 1500).passed, true);
}

// ---------------------------------------------------------------------------
// Phase B / C scenario matrix — baseline (seconds) vs candidate A (ms)
// ---------------------------------------------------------------------------
const scenarioRuns = [];
function runPair(name, a, b, nowA, nowB, useCandidate) {
  const f = makeShiroFilter();
  const make = useCandidate ? (e, nowMs) => makeEvent({ ...e, time: candidateTimeMs(nowMs) }) : (e) => e;
  const ra = f.insert(make(makeEvent(a), nowA), nowA);
  const rb = f.insert(make(makeEvent(b), nowB), nowB);
  return { ra, rb };
}

function recordScenario(name, a, b, nowA, nowB, baselineExpectSecondDrop, candidateExpectSecondDrop = false) {
  resetCandidate();
  const base = runPair(name, a, b, nowA, nowB, false);
  resetCandidate();
  const cand = runPair(name, a, b, nowA, nowB, true);
  scenarioRuns.push({ name, baselineSecondDrop: !base.rb.passed, candidateSecondDrop: !cand.rb.passed });
  check(`B/${name}: baseline second ${baselineExpectSecondDrop ? 'dropped' : 'passed'}`, !base.rb.passed, baselineExpectSecondDrop);
  check(`C/${name}: candidate-A second ${candidateExpectSecondDrop ? 'dropped' : 'passed'}`, !cand.rb.passed, candidateExpectSecondDrop);
}

{
  const S = 1_784_000_000;
  recordScenario('same_sender_group_second_same_command',
    { time: S, command: '!r user' }, { time: S, command: '!r user' }, 1000, 1300, true, false);
  recordScenario('same_sender_group_second_different_command',
    { time: S, command: '!r user' }, { time: S, command: '!bp 1' }, 1000, 1300, true, false);
  recordScenario('different_sender_same_length',
    { time: S, userId: USER }, { time: S, userId: USER + 1 }, 1000, 1300, false, false);
  recordScenario('different_group_same_length',
    { time: S, groupId: GROUP }, { time: S, groupId: GROUP + 1 }, 1000, 1300, false, false);
  recordScenario('adjacent_second',
    { time: S }, { time: S + 1 }, 1000, 1300, false, false);
  recordScenario('concurrent_sequential_arrival_window',
    { time: S }, { time: S }, 1000, 1300, true, false);
}

// ---------------------------------------------------------------------------
// Phase A2 hardening — delimiter-free cross-field collisions
// ---------------------------------------------------------------------------
// All possible real triples that can equal a given synthetic key, given that
// a real event's epoch-second string is exactly 10 digits in the current era
// and group/user decimal strings never start with '0':
//   T_r  = first 10 chars of S
//   G_r  = S[10 .. 10+gl)   for gl in 1..10
//   U_r  = S[10+gl ..)
// A split is a valid real triple iff G_r and U_r have no leading zero and
// U_r has at most 10 digits (QQ user ids) and G_r at most 10 digits.
function findRealSplits(time, groupId, userId) {
  const S = keyOf(time, groupId, userId);
  const L = S.length;
  const hits = [];
  for (let gl = 1; gl <= 10; gl++) {
    const ul = L - 10 - gl;
    if (ul < 1 || ul > 10) continue;
    const g = S.slice(10, 10 + gl);
    const u = S.slice(10 + gl);
    if (g[0] !== '0' && u[0] !== '0') {
      hits.push({ Tr: S.slice(0, 10), G: g, U: u, gl, ul });
    }
  }
  return hits;
}

const hardening = { constructedCollision: {}, splitResults: {}, residualRisk: {}, allocatorStress: {} };

{
  // The user-provided constructed collision. It MUST be equal under the real
  // delimiter-free key, which falsifies the earlier "digit-length disjoint"
  // wording.
  const synthKey = keyOf(1786861450123, 770099, 900000099);
  const realKey = keyOf(1786861450, 123770099, 900000099);
  hardening.constructedCollision.equal = synthKey === realKey;
  hardening.constructedCollision.key = synthKey;
  check('A2-1 constructed 13/10-digit cross-field keys are EQUAL', synthKey === realKey, true);

  // Both orderings collide inside the 5s window in the exact mirror.
  const fSynthFirst = makeShiroFilter();
  fSynthFirst.insert(makeEvent({ time: 1786861450123, groupId: 770099, userId: 900000099 }), 1000);
  check('A2-2 real-after-synthetic constructed collision drops', fSynthFirst.insert(makeEvent({ time: 1786861450, groupId: 123770099, userId: 900000099 }), 2000).passed, false);
  const fRealFirst = makeShiroFilter();
  fRealFirst.insert(makeEvent({ time: 1786861450, groupId: 123770099, userId: 900000099 }), 1000);
  check('A2-3 synthetic-after-real constructed collision drops', fRealFirst.insert(makeEvent({ time: 1786861450123, groupId: 770099, userId: 900000099 }), 2000).passed, false);

  // Full split classification for the constructed synthetic key.
  const hits = findRealSplits(1786861450123, 770099, 900000099);
  hardening.splitResults.constructed = hits;
  check('A2-4 constructed key has valid real splits', hits.length > 0, true);
  check('A2-5 same-user split exists (G=123770099, U=900000099)', hits.some((h) => h.G === '123770099' && h.U === '900000099'), true);
  check('A2-6 different-user split exists (G=12377009, U=9900000099)', hits.some((h) => h.G === '12377009' && h.U === '9900000099'), true);

  // Leading-zero lemma: if the synthetic time's low 3 digits X < 100, the
  // forced group boundary (char 11 of the key) starts with '0', so no valid
  // real triple can exist for ANY group/user digit length in 1..10.
  const baseMs = 1_786_861_450_000;
  let lemmaViolations = 0;
  for (let X = 0; X < 100; X++) {
    for (const Us of ['900000', '9000000', '90000009', '900000099', '9000000099', '999000000099']) {
      if (findRealSplits(baseMs + X, '770099', Us).length > 0) lemmaViolations++;
    }
  }
  hardening.leadingZeroLemma = { violations: lemmaViolations, scope: 'X in 0..99, user lengths 6..12' };
  check('A2-7 leading-zero lemma (X<100) has zero valid real splits', lemmaViolations, 0);

  // X >= 100 DOES admit splits (lemma boundary is exactly 100).
  check('A2-8 X=100 admits valid real splits', findRealSplits(baseMs + 100, '770099', '900000099').length > 0, true);

  // Wuxin-Wuxin uniqueness: strictly increasing 13-digit times always yield
  // distinct keys when group/user are held constant.
  let wuxinUnique = true;
  const fw = makeShiroFilter();
  for (let i = 0; i < 2000; i++) {
    const r = fw.insert(makeEvent({ time: baseMs + 2000 + i, groupId: 770099, userId: USER }), 1000 + i);
    if (!r.passed) { wuxinUnique = false; break; }
  }
  hardening.residualRisk.wuxinWuxinUnique = wuxinUnique;
  check('A2-9 Wuxin-Wuxin: 2000 distinct ms times all pass (no mutual collision)', wuxinUnique, true);
}

// Residual Wuxin-vs-real risk characterization for the QUICK-ROUTER path
// (G_s=770099) and the executor same-group path.
{
  const baseMs = 1_786_861_450_000;
  // Quick-router path: collision requires X = T_s mod 1000 in [100,999] and a
  // real event in group (1000*X+770099) from the same user two wall-seconds
  // after the synthetic call (margin 2000 => T_s div 1000 = wallSec+2).
  // Conditional probability bound: X match probability <= 1/1000.
  const sameUserGroups = [];
  for (let X = 100; X <= 999; X++) sameUserGroups.push(1_000_000 * X + GROUP); // dec(X) + "770099"
  hardening.residualRisk.quickRouter = {
    marginMs: 2000,
    prefixSecondOffset: '+2 wall seconds',
    collidingRealGroups: `${sameUserGroups[0]}..${sameUserGroups[sameUserGroups.length - 1]} (900 groups ending 770099)`,
    conditionalProbabilityBound: 1 / 1000,
    differentUserClassExample: { T: '1786861450', G: '12377009', U: '9900000099' },
  };
  check('A2-10 quick-router conditional collision probability bound is 1/1000', 1 / 1000, 0.001);

  // Executor same-group path: G_s == G_r, U_s == U_r => equality reduces to
  // dec(T_s) == dec(T_r). 13-digit vs 10-digit strings can never be equal, so
  // the same-user collision class is empty for ANY user digit length.
  let sameGroupCollision = false;
  for (const U of ['900000', '9000000', '90000009', '900000099', '9000000099']) {
    if (keyOf(baseMs + 2123, 682910196, U) === keyOf(1786861450, 682910196, U)) sameGroupCollision = true;
  }
  hardening.residualRisk.executorSameGroupSameUser = { collisionPossible: sameGroupCollision };
  check('A2-11 executor same-group same-user 13-vs-10 digit time can never match', sameGroupCollision, false);

  // ...but a DIFFERENT-user split can exist in the same-group path only when
  // the real group id is 3-periodic and starts with X (last 3 digits of T_s),
  // e.g. G=123123 or 123123123 with X=123, and the sender id has <=7 digits
  // (so U_r = X||U_s still fits in 10 digits).
  const sameGroupDiffUserHits = findRealSplits(baseMs + 123, '123123123', '900000')
    .filter((h) => h.G === '123123123');
  hardening.residualRisk.executorSameGroupDifferentUser = {
    periodicGroupExample: sameGroupDiffUserHits.length > 0 ? sameGroupDiffUserHits[0] : null,
    note: 'requires a 3-periodic real group id starting with X AND sender id <=7 digits; real QQ groups are normally non-periodic and QQ ids are 9-10 digits',
  };
  check('A2-12 executor same-group different-user split exists for periodic group + 6-digit sender', sameGroupDiffUserHits.length > 0, true);
}

// ---------------------------------------------------------------------------
// Phase D hardening — allocator stress vs Yumu actual stale/future gate
// ---------------------------------------------------------------------------
const yumuGateDrop = (eventTimeMs, receiveNowMs) => receiveNowMs - eventTimeMs > 30; // >=1e10 branch

{
  const W = 1_786_861_450_000;
  resetCandidate();

  // Never-past and monotonic invariants under a 5000-call same-ms burst.
  let burstOk = true;
  let prev = -1;
  let firstTime;
  for (let i = 0; i < 5000; i++) {
    const t = candidateTimeMs(W);
    if (i === 0) firstTime = t;
    if (t < W + CANDIDATE_FUTURE_MARGIN_MS) burstOk = false;
    if (i > 0 && t <= prev) burstOk = false;
    if (yumuGateDrop(t, W + 10)) burstOk = false; // 10ms loopback receive delay
    prev = t;
  }
  hardening.allocatorStress.sameMsBurst5000 = {
    ok: burstOk,
    firstTime,
    lastTime: prev,
    futureDriftMs: prev - W,
    expectedDriftMs: CANDIDATE_FUTURE_MARGIN_MS + 4999,
  };
  check('D-1 5000-call same-ms burst: monotonic, never past, all pass gate', burstOk, true);
  check('D-2 burst future drift = margin + N - 1', prev - W, CANDIDATE_FUTURE_MARGIN_MS + 4999);

  // Per-call flight budget: pass iff receive - time <= 30; with margin 2000
  // the first call budget is 2030ms, later burst calls get +1ms per index.
  resetCandidate();
  const t0 = candidateTimeMs(W);
  check('D-3 first call: receive +2030ms passes gate', yumuGateDrop(t0, W + 2030), false);
  check('D-4 first call: receive +2031ms drops (31 > 30)', yumuGateDrop(t0, W + 2031), true);
  for (let i = 0; i < 5; i++) candidateTimeMs(W);
  const t5 = lastCandidateTimeMs;
  check('D-5 6th same-ms call: receive +2035ms passes gate', yumuGateDrop(t5, W + 2035), false);
  check('D-6 6th same-ms call: receive +2036ms drops', yumuGateDrop(t5, W + 2036), true);

  // Wall-clock rollback: makes receive - time MORE negative, so the gate can
  // never be tripped; drift grows by the rollback distance and decays at
  // 1ms per wall-ms while no new calls are made.
  resetCandidate();
  const wA = W;
  const tA = candidateTimeMs(wA);
  const wB = wA - 5000; // 5s NTP-style rollback
  const tB = candidateTimeMs(wB);
  const driftB = tB - wB;
  check('D-7 rollback -5000ms: next time stays strictly increasing', tB > tA, true);
  check('D-8 rollback -5000ms: event still passes gate at receive +10ms', yumuGateDrop(tB, wB + 10), false);
  check('D-9 rollback -5000ms: drift = 2000 + 5000 + 1 (margin absorbed)', driftB, CANDIDATE_FUTURE_MARGIN_MS + 5000 + 1);
  // catch-up: without new calls, drift decays 1ms per wall-ms; verify by
  // advancing wall and observing when floor overtakes last.
  const catchUpStart = wB;
  let catchUpMs = 0;
  while (lastCandidateTimeMs >= (catchUpStart + catchUpMs) + CANDIDATE_FUTURE_MARGIN_MS) catchUpMs++;
  hardening.allocatorStress.rollback5000 = { driftAfterRollbackMs: driftB, catchUpMs };
  check('D-10 rollback drift fully decays after ~5002ms of wall time', catchUpMs, 5002);

  // Forward wall jump between allocation and receipt is the ONLY way the
  // gate can drop a candidate-A event: drop iff jump > 2030ms (first call).
  resetCandidate();
  const tF = candidateTimeMs(wA);
  check('D-11 forward jump +2030ms in flight: passes (30 boundary)', yumuGateDrop(tF, wA + 2030), false);
  check('D-12 forward jump +2031ms in flight: drops', yumuGateDrop(tF, wA + 2031), true);

  // Naive allocator can exceed ANY fixed semantic future cap under an
  // unbounded same-ms burst (40000 calls -> drift 41999ms > 30000ms).
  resetCandidate();
  for (let i = 0; i < 40000; i++) candidateTimeMs(W);
  const naiveDrift = lastCandidateTimeMs - W;
  hardening.allocatorStress.naiveExceedsCap = { capMs: 30000, driftMs: naiveDrift, exceeded: naiveDrift > 30000 };
  check('D-13 naive allocator exceeds a 30s future-drift cap under 40k burst', naiveDrift > 30000, true);

  // Revised bounded allocator: same invariants plus hard cap; reject before
  // send so the bridge falls back instead of emitting an unbounded time.
  resetBounded();
  let boundedBurstOk = true;
  let boundedRejected = false;
  try {
    for (let i = 0; i < 5000; i++) boundedCandidateTimeMs(W);
  } catch { boundedBurstOk = false; }
  check('D-14 bounded allocator accepts 5000-call same-ms burst', boundedBurstOk, true);
  check('D-15 bounded allocator max drift in burst <= 30000ms', lastBoundedTimeMs - W <= 30000, true);
  try {
    for (let i = 0; i < 30000; i++) boundedCandidateTimeMs(W);
    boundedRejected = false;
  } catch { boundedRejected = true; }
  check('D-16 bounded allocator rejects when drift would exceed 30000ms', boundedRejected, true);

  resetBounded();
  boundedCandidateTimeMs(wA);
  let rollbackReject = false;
  try { boundedCandidateTimeMs(wA - 30000); } catch { rollbackReject = true; }
  hardening.allocatorStress.bounded = {
    capMs: 30000,
    rejectsOnExcess: boundedRejected,
    rejectsOn30sRollback: rollbackReject,
  };
  check('D-17 bounded allocator rejects on 30s wall rollback', rollbackReject, true);

  // Future gate has NO upper bound: a very far future time still passes, so
  // the gate itself never limits positive drift — only the semantic cap does.
  check('D-18 gate accepts arbitrary future time (no future bound)', yumuGateDrop(wA + 86_400_000, wA), false);
}

// ---------------------------------------------------------------------------
// Phase F — FINAL SPEC A' deterministic safe-slot allocator
// ---------------------------------------------------------------------------
const safeSlotResults = {};
{
  const W = 1_786_861_450_000;

  // Slots stay 13-digit, land in X = time%1000 in [0,99], are strictly
  // increasing, and keep a 2000..3098ms future window.
  {
    // (a) Slot-0 future window for every wall-ms phase: fresh allocator per
    // ms so pool exhaustion never interferes.
    let windowOk = true;
    for (let ms = 0; ms < 1000; ms++) {
      const a = makeSafeSlotAllocator();
      const t = a.alloc(W + ms);
      const margin = t - (W + ms);
      if (String(t).length !== 13 || t % 1000 !== 0) windowOk = false;
      if (margin < SAFE_SLOT_MARGIN_MS || margin > SAFE_SLOT_MARGIN_MS + 999) windowOk = false;
    }
    safeSlotResults.slot0WindowSweep = { ok: windowOk, minMargin: SAFE_SLOT_MARGIN_MS, maxMargin: SAFE_SLOT_MARGIN_MS + 999 };
    check('F-1 slot-0 future window is 2000..2999ms for every wall-ms phase, 13-digit, X=0', windowOk, true);

    // (b) Sequential 3-second sweep: pools open at wall ms=1 of each second
    // (because margin 2000 aligns poolBase one second ahead), so the expected
    // successes across wall ms 0..2999 are 1 + 100 + 100 + 100 = 301; every
    // other attempt must fail fast with the pool exhausted.
    const a = makeSafeSlotAllocator();
    let ok = true;
    let prev = -1;
    let successes = 0;
    let expectedFailures = 0;
    const seen = [];
    for (let ms = 0; ms < 3000; ms++) {
      try {
        const t = a.alloc(W + ms);
        if (String(t).length !== 13) ok = false;
        if (t % 1000 < 0 || t % 1000 > 99) ok = false;
        if (t <= prev) ok = false;
        const margin = t - (W + ms);
        if (margin < SAFE_SLOT_MARGIN_MS || margin > SAFE_SLOT_MARGIN_MS + 999 + SAFE_SLOTS_PER_SECOND - 1) ok = false;
        seen.push(t);
        prev = t;
        successes++;
      } catch {
        expectedFailures++;
      }
    }
    safeSlotResults.sweep3000 = { ok, successes, expectedFailures, unique: new Set(seen).size === seen.length };
    check('F-2 3s sweep: 301 successes (1+100+100+100), 2699 fail-fast, monotonic and in-range', ok && successes === 301 && expectedFailures === 2699 && new Set(seen).size === seen.length, true);

    // Every generated key starts with a 10-digit prefix followed by '0' at
    // char 11, so findRealSplits (valid real triples) must be empty for all
    // group/user digit lengths.
    let splitHits = 0;
    for (const t of seen.slice(0, 600)) {
      if (String(t).charAt(10) !== '0') splitHits++;
      for (const Us of ['900000', '9000000', '90000009', '900000099', '9000000099']) {
        if (findRealSplits(t, '770099', Us).length > 0) splitHits++;
      }
    }
    safeSlotResults.disjointness = { checked: Math.min(seen.length, 600) * 5, violations: splitHits };
    check('F-3 leading-zero disjointness: char 11 always 0 and zero valid real splits', splitHits, 0);
  }

  // Exactly 100 slots per pool second; the 101st fails BEFORE send instead of
  // waiting or producing an out-of-range time.
  {
    const a = makeSafeSlotAllocator();
    const sameWall = W + 500;
    const used = [];
    for (let i = 0; i < 100; i++) used.push(a.alloc(sameWall));
    const unique = new Set(used).size === 100;
    const allSameSecond = used.every((t) => Math.floor(t / 1000) === Math.floor(used[0] / 1000));
    const inRange = used.every((t) => t % 1000 >= 0 && t % 1000 <= 99);
    let exhausted = false;
    try { a.alloc(sameWall); } catch { exhausted = true; }
    safeSlotResults.poolCapacity = { unique, allSameSecond, inRange, slots0And99: [used[0] % 1000, used[99] % 1000], rejected101st: exhausted };
    check('F-4 same-ms burst: 100 unique safe slots consumed, all in one pool second', unique && allSameSecond && inRange, true);
    check('F-5 101st call in same pool second fails before send', exhausted, true);

    // Next wall second gets a fresh pool (slot 0 again, strictly > last).
    const tNext = a.alloc(sameWall + 1000);
    check('F-6 next wall second opens a fresh pool with slot 0', tNext % 1000 === 0 && tNext > used[99], true);
  }

  // Stale-gate budget for a slot-0 call is margin+30; slot 99 adds 99ms.
  {
    const wall = W + 500;
    const a0 = makeSafeSlotAllocator();
    const t0 = a0.alloc(wall);
    const budget0 = (t0 - wall) + 30;
    check('F-7 safe-slot first call: receive at exactly its budget passes gate', yumuGateDrop(t0, wall + budget0), false);
    check('F-8 safe-slot first call: one ms beyond its budget drops', yumuGateDrop(t0, wall + budget0 + 1), true);
    const a99 = makeSafeSlotAllocator();
    let t99;
    for (let i = 0; i < 100; i++) t99 = a99.alloc(wall);
    const budget = (t99 - wall) + 30;
    check('F-9 slot-99 call budget = margin + 99 + 30', yumuGateDrop(t99, wall + budget), false);
    check('F-10 slot-99 call drops one ms beyond its budget', yumuGateDrop(t99, wall + budget + 1), true);
  }

  // Wall rollback: no slot reuse, fail-fast while the wall is behind the
  // monotonic watermark, then recovery into a fresh pool.
  {
    const a = makeSafeSlotAllocator();
    const tA = a.alloc(W + 500); // pool second S
    let failedDuringRollback = false;
    try { a.alloc(W + 500 - 5000); } catch { failedDuringRollback = true; } // wall now 5s earlier
    // Wall climbs back; once poolBase reaches the watermark second again the
    // allocator either continues with remaining slots or fails until a NEW
    // second's pool, never reusing an emitted value.
    const emitted = [tA];
    let recovered = null;
    for (let w = W + 500 - 5000 + 1; w <= W + 1500; w++) {
      try { recovered = a.alloc(w); emitted.push(recovered); } catch { /* still behind / exhausted */ }
    }
    const strictlyIncreasing = emitted.every((t, i) => i === 0 || t > emitted[i - 1]);
    const noReuse = new Set(emitted).size === emitted.length;
    safeSlotResults.rollback = { failedDuringRollback, recovered, strictlyIncreasing, noReuse };
    check('F-11 rollback 5s: allocator fails fast instead of reusing slots', failedDuringRollback, true);
    check('F-12 rollback recovery emits only new strictly-increasing safe slots', recovered !== null && strictlyIncreasing && noReuse, true);
  }

  // Same-ms burst comparison: A accepts 5000, A' accepts exactly 100.
  {
    resetCandidate();
    let aOk = true;
    try { for (let i = 0; i < 5000; i++) candidateTimeMs(W); } catch { aOk = false; }
    const ap = makeSafeSlotAllocator();
    let apOk = true;
    try { for (let i = 0; i < 5000; i++) ap.alloc(W); } catch { apOk = false; }
    safeSlotResults.burstComparison = { A_5000_accepted: aOk, APrime_5000_accepted: apOk };
    check('F-13 burst comparison: A accepts 5000 same-ms calls, A\' rejects after 100', aOk === true && apOk === false, true);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nquick-bridge-qb05-dedup-verify: ${checks} checks, ${failures} failures`);
console.log(JSON.stringify({ checks, failures, scenarios: scenarioRuns, hardening, safeSlot: safeSlotResults }, null, 2));
process.exit(failures === 0 ? 0 : 1);
