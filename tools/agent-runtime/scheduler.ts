import type { TraceRecorder } from './trace.js';

interface ScheduledAction {
  tick: number;
  order: number;
  label: string;
  run: () => void;
}

/**
 * Deterministic harness-only scheduler. It only orders callbacks that settle
 * injected fake promises; it never models or executes runToolLoop state.
 */
export class DeterministicSettlementScheduler {
  private readonly queue: ScheduledAction[] = [];
  private nextOrder = 0;
  private logicalTick = 0;

  constructor(private readonly recorder: TraceRecorder) {}

  get tick(): number {
    return this.logicalTick;
  }

  get pending(): number {
    return this.queue.length;
  }

  scheduleAt(tick: number, label: string, run: () => void): void {
    this.queue.push({
      tick: Math.max(this.logicalTick, Math.max(0, Math.trunc(tick))),
      order: this.nextOrder++,
      label,
      run,
    });
    this.queue.sort((left, right) => left.tick - right.tick || left.order - right.order);
  }

  async runNext(): Promise<boolean> {
    const action = this.queue.shift();
    if (!action) return false;
    this.logicalTick = action.tick;
    this.recorder.push('scheduler_tick', {
      tick: this.logicalTick,
      label: action.label,
      pendingAfterDequeue: this.queue.length,
    });
    action.run();
    // Let the real promise chain advance. No Agent state transition is
    // simulated here; all follow-up calls must come from runToolLoop itself.
    for (let index = 0; index < 8; index++) await Promise.resolve();
    return true;
  }

  async flushRuntimeMicrotasks(): Promise<void> {
    for (let index = 0; index < 8; index++) await Promise.resolve();
  }
}
