// Pure player-name normalization shared by tool execution and the tool loop.
export function normalizePlayerName(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
