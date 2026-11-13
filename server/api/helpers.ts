// Shared response helpers for the local console API. These are protocol
// helpers, not a second API framework: routes keep using Express handlers.
export function ok(data: object = {}) {
  return { ok: true, ...data };
}

export function limitedText(value: unknown, max: number): string {
  return String(value || '').trim().slice(0, max);
}
