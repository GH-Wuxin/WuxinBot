// Profile logging — independent from chat message logs.
// Tracks every step of the profiling pipeline for debugging and transparency.
import { readDb, updateDb, nowIso } from '../store.js';

export type ProfileLogEvent =
  | 'sample.accepted'
  | 'sample.rejected'
  | 'evidence.created'
  | 'evidence.rejected'
  | 'profile.threshold_check'
  | 'profile.run_started'
  | 'profile.llm_result'
  | 'profile.patch_applied'
  | 'profile.no_change'
  | 'profile.error';

export interface ProfileLogEntry {
  id: string;
  runId: string;
  event: ProfileLogEvent;
  userId: string;
  nickname?: string;
  groupId?: string;
  detail: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}

const MAX_LOGS = 2000;

// Generate a short run ID for tracing a profile update pipeline
export function newRunId(): string {
  return `pr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// Write a profile log entry
export function writeProfileLog(entry: Omit<ProfileLogEntry, 'id' | 'createdAt'>): void {
  updateDb((draft) => {
    if (!draft.profileLogs) draft.profileLogs = [];
    draft.profileLogs.push({
      id: crypto.randomUUID(),
      ...entry,
      createdAt: nowIso(),
    });
    // Keep only the latest MAX_LOGS entries
    if (draft.profileLogs.length > MAX_LOGS) {
      draft.profileLogs = draft.profileLogs.slice(-MAX_LOGS);
    }
  });
}

// Query profile logs with optional filters
export function queryProfileLogs(filters: {
  userId?: string;
  runId?: string;
  event?: ProfileLogEvent;
  limit?: number;
  offset?: number;
} = {}): ProfileLogEntry[] {
  const db = readDb();
  let logs = (db.profileLogs || []) as ProfileLogEntry[];

  if (filters.userId) {
    logs = logs.filter((l) => String(l.userId) === String(filters.userId));
  }
  if (filters.runId) {
    logs = logs.filter((l) => l.runId === filters.runId);
  }
  if (filters.event) {
    logs = logs.filter((l) => l.event === filters.event);
  }

  // Sort newest first
  logs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const offset = filters.offset || 0;
  const limit = filters.limit || 100;
  return logs.slice(offset, offset + limit);
}

// Get log stats
export function getProfileLogStats(): {
  total: number;
  byEvent: Record<string, number>;
  recentErrors: number;
  recentRuns: number;
} {
  const db = readDb();
  const logs = (db.profileLogs || []) as ProfileLogEntry[];
  const byEvent: Record<string, number> = {};
  for (const l of logs) {
    byEvent[l.event] = (byEvent[l.event] || 0) + 1;
  }
  const oneDayAgo = Date.now() - 86400000;
  const recentErrors = logs.filter((l) => l.event === 'profile.error' && new Date(l.createdAt).getTime() > oneDayAgo).length;
  const recentRunIds = new Set(
    logs.filter((l) => l.event === 'profile.run_started' && new Date(l.createdAt).getTime() > oneDayAgo).map((l) => l.runId)
  );
  return { total: logs.length, byEvent, recentErrors, recentRuns: recentRunIds.size };
}
