# LLM Timeout / Cancellation Audit Report

> **Project**: Wuxin/QQ-AI-ChatBot
> **Date**: 2026-08-08
> **Scope**: LLM 调用超时后底层 HTTP/SDK 请求是否真正被取消
> **Classification**: Read-only investigation, no production code modified

---

## Executive Summary

| Metric | Value |
|--------|-------|
| Files examined | 2 source (`llm.ts`, `executor.ts`) + 1 SDK (`openai/client.js`) |
| LLM request call sites | 1 (`completeChat` → `runCompletion`) |
| Timeout layers | 2 (SDK internal + `withTimeout` wrapper) |
| AbortController in call path | 1 (SDK internal only; **none** in `llm.ts`) |
| Retry layers | 2 (SDK `maxRetries` + `retryAfterEmpty`) |
| Deterministic tests executed | 3 (all PASS) |

**Bottom line**: The SDK's internal timeout correctly aborts the HTTP request via `AbortController`. However, the outer `withTimeout` wrapper uses `Promise.race` without passing an `AbortSignal` to the SDK, so SDK-level retries continue as orphaned requests after the caller has already timed out. This is a **resource/cost risk (B)**, not a functional bug.

---

## 1. Call Chain

```
completeChat                           (server/bot/llm.ts:276)
  └→ runCompletion                     (server/bot/llm.ts:314)
       └→ withTimeout                  (server/bot/llm.ts:82)   ← Promise.race, no AbortController
            └→ client.chat.completions.create()                  ← OpenAI SDK
                 └→ makeRequest         (node_modules/openai/client.js:361)  ← creates AbortController
                      └→ fetchWithTimeout (client.js:486)       ← setTimeout → controller.abort()
                           └→ fetch(url, { signal })             ← actual HTTP request
```

### Per-layer analysis

| Layer | Creates AbortController? | Receives signal? | Passes signal down? | Aborts on timeout? |
|-------|--------------------------|-------------------|----------------------|---------------------|
| `withTimeout` (llm.ts:82) | No | No | No | No — only stops waiting |
| `completeChat` (llm.ts:276) | No | No | No | No |
| SDK `create()` | No (delegates) | No user signal | No | No |
| SDK `makeRequest()` (client.js:361) | **Yes** | Checks `options.signal` | Yes | Yes (via retry) |
| SDK `fetchWithTimeout()` (client.js:486) | Uses parent's | N/A | `signal: controller.signal` | **Yes** — `setTimeout → abort()` |

---

## 2. `withTimeout` Real Semantics

Source: `server/bot/llm.ts:82-88`

```typescript
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 ${Math.round(ms / 1000)}秒`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
```

**What it does**: Races the input promise against a timer. If the timer wins, rejects with a timeout error. The `finally` clears the timer.

**What it does NOT do**:
- Does not create an `AbortController`
- Does not call `.abort()` on anything
- Does not pass any signal to the underlying promise
- Does not cancel, stop, or interrupt the underlying operation

**Conclusion**: `Promise.race` only stops **waiting**. The losing promise continues to run to completion (or its own internal timeout).

---

## 3. SDK Internal Timeout Mechanism

Source: `node_modules/openai/client.js:486-512`

```javascript
async fetchWithTimeout(url, init, ms, controller) {
    const { signal, method, ...options } = init || {};
    const abort = this._makeAbort(controller);       // () => controller.abort()
    if (signal) signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, ms);            // SDK's own timeout
    const fetchOptions = {
        signal: controller.signal,                    // ← signal passed to fetch
        ...options,
    };
    try {
        return await this.fetch.call(undefined, url, fetchOptions);
    } finally {
        clearTimeout(timeout);
    }
}
```

**The SDK correctly**:
1. Creates an `AbortController` (in `makeRequest`, line 361)
2. Sets `setTimeout(abort, ms)` to call `controller.abort()` after timeout
3. Passes `signal: controller.signal` to `fetch()`
4. `fetch` receives the abort signal and terminates the HTTP connection

**So the SDK's internal timeout DOES abort the HTTP request.**

---

## 4. The Timeout Overlap Problem

Current code (`llm.ts:314-324`):

```typescript
const requestTimeoutMs = Number(options.timeoutMs || 45_000);
const requestMaxRetries = Math.max(0, Number(options.requestMaxRetries ?? 2));
const response = await withTimeout(
    client.chat.completions.create(nextParams, {
        timeout: requestTimeoutMs,        // SDK timeout: 45s
        maxRetries: requestMaxRetries,    // SDK retries: 2
    }),
    requestTimeoutMs + 1000,              // withTimeout: 46s
    options.label || `...`
);
```

### Timeline (single attempt, no retry)

```
0s          45s         46s
│           │           │
├───────────┤           │
│ SDK fires │           │
│ abort()   │           │
│           ├───────────┤
│           │ withTimeout│
│           │ rejects    │
```

When there's no retry, the SDK aborts at 45s and `withTimeout` rejects at 46s. The HTTP request is properly aborted. **No issue here.**

### Timeline (with SDK retry, worst case)

```
0s     45s    46s    90s    91s   135s
│      │      │      │      │      │
├──────┤      │      │      │      │  Attempt 1: SDK timeout → abort
│      ├──────┤      │      │      │
│      │withTimeout  │      │      │
│      │rejects      │      │      │
│      │      ├──────┤      │      │  Attempt 2: SDK retry (orphaned)
│      │      │      ├──────┤      │
│      │      │      │      ├──────┤  Attempt 3: SDK retry (orphaned)
```

**At t=46s**: `withTimeout` rejects → caller sees timeout error → caller moves on.
**At t=46s–135s**: SDK continues retrying attempts 2 and 3. These are **orphaned** — no one is waiting for the result.

---

## 5. Deterministic Test Results

Three tests were executed against a replica of `withTimeout`:

### Test 1: Underlying promise continues after timeout

```
Input:  fakeRequest (5s delay) + withTimeout (1s)
Result: withTimeout rejected at 1s, underlying resolved at 5s
Verdict: PASS — underlying continues running
```

### Test 2: No signal propagation

```
Input:  provider that checks for abort signal + withTimeout (1s)
Result: No signal received by provider
Verdict: PASS — withTimeout does not propagate any signal
```

### Test 3: Retry amplification

```
Input:  fake SDK with maxRetries=2 + withTimeout (1s, SDK takes 2s/attempt)
Result: withTimeout rejected at 1s, SDK continued all 3 attempts
Verdict: RISK — multiple orphaned requests in flight
```

---

## 6. Late Result Business Side-Effects

Checked: when the SDK request completes after `withTimeout` has already rejected.

| Pathway | Late result enters? | Notes |
|---------|---------------------|-------|
| `retryAfterEmpty` | No | Exception skips to catch block |
| Tool loop (executor.ts) | No | `completeChat` already threw |
| QQ message delivery | No | `routeDrain` mechanism absorbs late messages |
| Memory / DB write | No | Only on successful return |
| Token consumption | **Yes** | API call was made, tokens consumed regardless |
| Network resources | **Yes** | HTTP socket held until SDK abort or response |

**Conclusion**: "功能竞态未发现，主要是资源/成本风险。"

---

## 7. Retry Amplification Analysis

| Retry source | Max retries | Trigger | Continues after withTimeout reject? |
|--------------|-------------|---------|-------------------------------------|
| SDK `maxRetries` | 2 (default) | Connection error / timeout / 4xx-5xx | **Yes** — no signal to cancel |
| `retryAfterEmpty` | 1 | Empty LLM response | No — not reached on exception |
| Provider fallback | 0 | N/A in current code | N/A |

**Worst case**: 1 timeout → SDK retries 2x → **3 real HTTP requests** in flight, caller sees 1 timeout error.

---

## 8. Active Counter-Evidence Search

Searched for evidence that cancellation actually happens:

| Pattern | Found in LLM call path? | Found elsewhere? |
|---------|-------------------------|------------------|
| `AbortController` | **No** | render.ts, index.ts, onebot.ts, osu/api.ts, search.ts |
| `signal` propagation | **No** | Same files as above |
| `finally` cleanup | Timer only | No request cleanup |
| SDK cancellation | Internal only | Not exposed to caller |
| Stale generation guard | **No** | N/A |
| Request identity | **No** | N/A |

**The project correctly uses `AbortController` in 6 other locations** (HTTP fetches to external services), but **not** in the LLM call path. This is the gap.

---

## 9. Classification

| Category | Verdict |
|----------|---------|
| **A** (Eliminated) | SDK internal timeout + abort works correctly |
| **B** (Resource/Cost Risk) | **Confirmed**: Orphaned SDK retries after `withTimeout` reject consume network + API quota |
| **C** (Functional Bug) | **Not found**: Late results do not enter business pipeline |
| **D** (Unable to confirm) | None |

---

## 10. Recommended Fix

**Priority**: B — resource/cost risk, not user-facing bug.

**Change**: Pass an `AbortSignal` from `withTimeout` to the SDK so retries are cancelled when the outer timeout fires.

**Sketch** (not a production patch — read-only audit):

```typescript
// server/bot/llm.ts — conceptual fix
async function runCompletion(nextParams) {
    const requestTimeoutMs = Number(options.timeoutMs || 45_000);
    const requestMaxRetries = Math.max(0, Number(options.requestMaxRetries ?? 2));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs + 1000);

    try {
        const response = await client.chat.completions.create(nextParams, {
            timeout: requestTimeoutMs,
            maxRetries: requestMaxRetries,
            signal: controller.signal,   // ← SDK will honour this
        });
        return { text: response.choices?.[0]?.message?.content?.trim() || '', ... };
    } finally {
        clearTimeout(timer);
    }
}
```

**Effect**: When the outer timeout fires `controller.abort()`, the SDK receives the abort signal, cancels the in-flight fetch, and stops all pending retries. Eliminates orphaned requests entirely.

---

## Appendix: Files Examined

| File | Path | Lines read | Purpose |
|------|------|------------|---------|
| llm.ts | `server/bot/llm.ts` | 82–88, 260–375 | `withTimeout`, `completeChat`, `runCompletion` |
| executor.ts | `server/bots/executor.ts` | 1–55, 130–254 | Pending bot call timeout, route drain |
| client.js | `node_modules/openai/client.js` | 355–512, 628–632 | SDK fetchWithTimeout, abort mechanism |

---

*End of audit. No production code was modified, committed, or deployed.*
