import { traceEvent } from '../requestTrace.js';

// Optional status messages must never reject into a timer or abort the answer.
export async function sendOptionalNotice(send: () => Promise<unknown>): Promise<void> {
  try { await send(); }
  catch (error) {
    traceEvent('SEND', 'thinking_notice_failed', { status: 'error', error: String(error) });
  }
}
