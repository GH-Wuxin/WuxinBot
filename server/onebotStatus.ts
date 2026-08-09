// OneBot/QQ connection status observer (P0-A).
//
// Scope: observation only. This module NEVER reconnects the WebSocket,
// restarts NapCat, re-logins QQ, or changes message-sending behavior.
// It exists so that "TCP/WS is alive but QQ session is dead" becomes a
// first-class, observable state instead of a silent lie.
//
// The status is split into four dimensions:
//   transportConnected - WebSocket OPEN
//   apiReachable       - NapCat HTTP get_status call succeeded recently
//   accountOnline      - heartbeat / get_status reported QQ online
//   heartbeatFresh     - a heartbeat event arrived within the stale window
//
// A lightweight in-memory flight recorder keeps the last ~10-15 minutes of
// state transitions and per-minute aggregates; when accountOnline flips
// true -> false the buffer is dumped to <dumpDir>/onebot-flight-*.json.
// No chat content is ever recorded.

import fs from 'node:fs';
import path from 'node:path';

export type ReachableState = boolean | null; // null = not probed yet
export type AccountOnlineState = boolean | null; // null = unknown

export interface ConnectionSnapshot {
  transportConnected: boolean;
  apiReachable: ReachableState;
  accountOnline: AccountOnlineState;
  heartbeatFresh: boolean;
  heartbeatGood: boolean | null;
  /** Compat field: transport up, API not known-dead, account not known-offline. */
  connected: boolean;
  lastEventAt: string;
  lastError: string;
  lastHeartbeatAt: string;
  lastGetStatusAt: string;
  lastGetStatusError: string;
  reconnectCount: number;
  lastReconnectAt: string;
}

export interface ConnectionAggregates {
  sendSuccess: number;
  sendFailures: number;
  sendAvgLatencyMs: number;
  activeGroups: number;
  activeProcessing: number;
}

export interface FlightEvent {
  at: string;
  kind: string;
  detail: Record<string, unknown>;
}

export interface FlightSample {
  at: string;
  transportConnected: boolean;
  apiReachable: ReachableState;
  accountOnline: AccountOnlineState;
  heartbeatFresh: boolean;
  sendSuccess: number;
  sendFailures: number;
  sendAvgLatencyMs: number;
  activeGroups: number;
  activeProcessing: number;
  reconnectCount: number;
}

export interface ConnectionStatusOptions {
  now?: () => Date;
  dumpDir?: string;
  getAggregates?: () => ConnectionAggregates;
  heartbeatStaleMs?: number;
}

const DEFAULT_HEARTBEAT_STALE_MS = 90_000;
const GET_STATUS_FAIL_THRESHOLD = 2;
const MAX_EVENTS = 500;
const MAX_SAMPLES = 30; // 30 x 60s samples ≈ 30 minutes of aggregates

export interface ConnectionStatus {
  snapshot(): ConnectionSnapshot;
  markTransportOpen(): ConnectionSnapshot;
  markTransportClosed(code?: number, reason?: string): ConnectionSnapshot;
  markTransportError(message: string): ConnectionSnapshot;
  markReconnect(): ConnectionSnapshot;
  markEventReceived(): ConnectionSnapshot;
  handleHeartbeat(status?: { online?: boolean; good?: boolean } | null): ConnectionSnapshot;
  applyGetStatus(result: {
    ok: boolean;
    online?: boolean;
    good?: boolean;
    error?: string;
  }): ConnectionSnapshot;
  recordEvent(kind: string, detail?: Record<string, unknown>): void;
  sampleNow(): ConnectionSnapshot;
  dump(reason: string): string | null;
  getEvents(): FlightEvent[];
  getSamples(): FlightSample[];
  resetForTest(): void;
}

export function createConnectionStatus(opts: ConnectionStatusOptions = {}): ConnectionStatus {
  const now = opts.now || (() => new Date());
  const dumpDir = opts.dumpDir || path.join(process.cwd(), 'logs');
  const heartbeatStaleMs = opts.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
  const getAggregates =
    opts.getAggregates ||
    (() => ({
      sendSuccess: 0,
      sendFailures: 0,
      sendAvgLatencyMs: 0,
      activeGroups: 0,
      activeProcessing: 0,
    }));

  let transportConnected = false;
  let apiReachable: ReachableState = null;
  let accountOnline: AccountOnlineState = null;
  let heartbeatGood: boolean | null = null;
  let lastEventAt = '';
  let lastError = '';
  let lastHeartbeatAt = '';
  let lastGetStatusAt = '';
  let lastGetStatusError = '';
  let reconnectCount = 0;
  let lastReconnectAt = '';
  let getStatusFailStreak = 0;

  const events: FlightEvent[] = [];
  const samples: FlightSample[] = [];

  function snapshot(): ConnectionSnapshot {
    const heartbeatFresh = lastHeartbeatAt
      ? now().getTime() - new Date(lastHeartbeatAt).getTime() <= heartbeatStaleMs
      : false;
    const connected =
      transportConnected && apiReachable !== false && accountOnline !== false;
    return {
      transportConnected,
      apiReachable,
      accountOnline,
      heartbeatFresh,
      heartbeatGood,
      connected,
      lastEventAt,
      lastError,
      lastHeartbeatAt,
      lastGetStatusAt,
      lastGetStatusError,
      reconnectCount,
      lastReconnectAt,
    };
  }

  function pushEvent(kind: string, detail: Record<string, unknown> = {}): void {
    events.push({ at: now().toISOString(), kind, detail });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  }

  function maybeDumpOnAccountOffline(prevOnline: AccountOnlineState): void {
    if (prevOnline === true && accountOnline === false) {
      dump('account_offline');
    }
  }

  function markTransportOpen(): ConnectionSnapshot {
    transportConnected = true;
    lastError = '';
    pushEvent('transport_open', {});
    return snapshot();
  }

  function markTransportClosed(code?: number, reason?: string): ConnectionSnapshot {
    transportConnected = false;
    pushEvent('transport_close', {
      code: typeof code === 'number' ? code : null,
      reason: String(reason || ''),
    });
    return snapshot();
  }

  function markTransportError(message: string): ConnectionSnapshot {
    transportConnected = false;
    lastError = String(message || '');
    pushEvent('transport_error', { error: String(message || '').slice(0, 300) });
    return snapshot();
  }

  function markReconnect(): ConnectionSnapshot {
    reconnectCount += 1;
    lastReconnectAt = now().toISOString();
    pushEvent('reconnect', { count: reconnectCount });
    return snapshot();
  }

  function markEventReceived(): ConnectionSnapshot {
    lastEventAt = now().toISOString();
    return snapshot();
  }

  function handleHeartbeat(
    status?: { online?: boolean; good?: boolean } | null,
  ): ConnectionSnapshot {
    const prevOnline = accountOnline;
    lastHeartbeatAt = now().toISOString();
    const onlineChanged = Boolean(status && typeof status.online === 'boolean' && status.online !== accountOnline);
    const goodChanged = Boolean(status && typeof status.good === 'boolean' && status.good !== heartbeatGood);
    if (status && typeof status.online === 'boolean') {
      accountOnline = status.online;
    }
    if (status && typeof status.good === 'boolean') {
      heartbeatGood = status.good;
    }
    if (onlineChanged || goodChanged) {
      pushEvent('heartbeat', {
        online: typeof accountOnline === 'boolean' ? accountOnline : null,
        good: typeof heartbeatGood === 'boolean' ? heartbeatGood : null,
      });
    }
    const snap = snapshot();
    maybeDumpOnAccountOffline(prevOnline);
    return snap;
  }

  function applyGetStatus(result: {
    ok: boolean;
    online?: boolean;
    good?: boolean;
    error?: string;
  }): ConnectionSnapshot {
    const prevOnline = accountOnline;
    const prevApiReachable = apiReachable;
    lastGetStatusAt = now().toISOString();
    if (result.ok) {
      getStatusFailStreak = 0;
      const apiRecovered = prevApiReachable !== true;
      const onlineChanged =
        typeof result.online === 'boolean' && result.online !== prevOnline;
      apiReachable = true;
      lastGetStatusError = '';
      if (onlineChanged) {
        accountOnline = result.online;
        pushEvent('get_status', {
          online: result.online,
          good: typeof result.good === 'boolean' ? result.good : null,
        });
      } else if (apiRecovered) {
        pushEvent('get_status_ok', {});
      }
    } else {
      getStatusFailStreak += 1;
      lastGetStatusError = String(result.error || '').slice(0, 300);
      if (getStatusFailStreak >= GET_STATUS_FAIL_THRESHOLD) {
        if (apiReachable !== false) {
          pushEvent('api_unreachable', {
            streak: getStatusFailStreak,
            error: lastGetStatusError,
          });
        }
        apiReachable = false;
      }
    }
    const snap = snapshot();
    maybeDumpOnAccountOffline(prevOnline);
    return snap;
  }

  function recordEvent(kind: string, detail: Record<string, unknown> = {}): void {
    pushEvent(kind, detail);
  }

  function sampleNow(): ConnectionSnapshot {
    const agg = getAggregates();
    const s = snapshot();
    samples.push({
      at: now().toISOString(),
      transportConnected: s.transportConnected,
      apiReachable: s.apiReachable,
      accountOnline: s.accountOnline,
      heartbeatFresh: s.heartbeatFresh,
      sendSuccess: agg.sendSuccess,
      sendFailures: agg.sendFailures,
      sendAvgLatencyMs: agg.sendAvgLatencyMs,
      activeGroups: agg.activeGroups,
      activeProcessing: agg.activeProcessing,
      reconnectCount: s.reconnectCount,
    });
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
    return s;
  }

  function dump(reason: string): string | null {
    try {
      fs.mkdirSync(dumpDir, { recursive: true });
      const filename = path.join(
        dumpDir,
        `onebot-flight-${now().toISOString().replace(/[:.]/g, '-')}.json`,
      );
      const payload = {
        dumpedAt: now().toISOString(),
        reason,
        note: 'flight recorder: no chat content recorded',
        snapshot: snapshot(),
        events: [...events],
        samples: [...samples],
      };
      fs.writeFileSync(filename, JSON.stringify(payload, null, 2), 'utf8');
      return filename;
    } catch (error) {
      console.error('[onebotStatus] flight dump failed:', String((error as Error)?.message || error));
      return null;
    }
  }

  function getEvents(): FlightEvent[] {
    return [...events];
  }

  function getSamples(): FlightSample[] {
    return [...samples];
  }

  function resetForTest(): void {
    transportConnected = false;
    apiReachable = null;
    accountOnline = null;
    heartbeatGood = null;
    lastEventAt = '';
    lastError = '';
    lastHeartbeatAt = '';
    lastGetStatusAt = '';
    lastGetStatusError = '';
    reconnectCount = 0;
    lastReconnectAt = '';
    getStatusFailStreak = 0;
    events.length = 0;
    samples.length = 0;
  }

  return {
    snapshot,
    markTransportOpen,
    markTransportClosed,
    markTransportError,
    markReconnect,
    markEventReceived,
    handleHeartbeat,
    applyGetStatus,
    recordEvent,
    sampleNow,
    dump,
    getEvents,
    getSamples,
    resetForTest,
  };
}
