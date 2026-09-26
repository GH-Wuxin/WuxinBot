import assert from 'node:assert/strict';
import { normalizedJson, sanitizeTraceString, TraceRecorder } from './trace.js';

const raw = [
  'C:\\Users\\someone\\AppData\\Local\\Temp\\case.ts:12:4',
  '/tmp/wuxin-agent-replay-abc/case.json',
  '550e8400-e29b-41d4-a716-446655440000',
  '1730000000123',
  '2026-08-09T12:34:56.789Z',
  'http://localhost:4567/test',
].join(' | ');
const clean = sanitizeTraceString(raw);
for (const secret of ['C:\\Users', '/tmp/', '550e8400', '1730000000123', '2026-08-09', 'localhost:4567']) {
  assert(!clean.includes(secret), `trace sanitizer leaked ${secret}: ${clean}`);
}

function buildTrace() {
  const recorder = new TraceRecorder('TRACE_VERIFY', 7);
  recorder.push('adapter_error', {
    message: raw,
    latencyMs: 999,
    timestamp: 1730000000123,
    port: 4567,
  });
  return recorder.finish({
    kind: 'error',
    error: { name: 'FixtureError', message: raw },
  });
}

const first = normalizedJson(buildTrace());
const second = normalizedJson(buildTrace());
assert.equal(first, second, 'normalized traces must be byte-identical');
for (const secret of ['C:\\Users', '/tmp/', '550e8400', '1730000000123', '2026-08-09', 'localhost:4567', '"latencyMs": 999']) {
  assert(!first.includes(secret), `normalized terminal/event leaked ${secret}`);
}
console.log('AGENT-RUNTIME TRACE VERIFY: PASS');
