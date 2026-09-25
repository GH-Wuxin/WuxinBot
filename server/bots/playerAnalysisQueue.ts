type PlayerAnalysisJob<T> = {
  playerId: number;
  run?: () => Promise<T>;
  resolve?: (value: T | PromiseLike<T>) => void;
  reject?: (reason?: unknown) => void;
  cancelled: boolean;
};

// A player profile is the unit of ownership for the Python analysis workers.
// The worker pool can still analyse several maps in parallel, but a second
// player's maps never enter that pool until the current player's batch has
// fully settled.
const pending: Array<PlayerAnalysisJob<unknown>> = [];
let active = false;
let activePlayerId: number | null = null;

async function drain(): Promise<void> {
  if (active) return;
  while (pending[0]?.cancelled) pending.shift();
  const job = pending[0];
  if (!job) return;
  // A reserved player is allowed to fetch its BP and prefetch missing maps
  // before attaching the actual analysis work. Preserve FIFO while waiting
  // for that preparation to finish.
  if (!job.run) return;
  pending.shift();
  active = true;
  activePlayerId = job.playerId;
  try {
    job.resolve?.(await job.run());
  } catch (error) {
    job.reject?.(error);
  } finally {
    active = false;
    activePlayerId = null;
    void drain();
  }
}

export function playerAnalysisQueueDepth(): number {
  return pending.length + (active ? 1 : 0);
}

export function activePlayerAnalysisId(): number | null {
  return activePlayerId;
}

export interface PlayerAnalysisTicket {
  readonly playerId: number;
  readonly position: number;
  run<T>(run: () => Promise<T>): Promise<T>;
  cancel(): void;
}

export function reservePlayerAnalysis(playerId: number): PlayerAnalysisTicket {
  const job: PlayerAnalysisJob<unknown> = { playerId, cancelled: false };
  pending.push(job);
  const position = playerAnalysisQueueDepth();

  return {
    playerId,
    position,
    run<T>(run: () => Promise<T>): Promise<T> {
      if (job.cancelled) return Promise.reject(new Error('PLAYER_ANALYSIS_TICKET_CANCELLED'));
      if (job.run) return Promise.reject(new Error('PLAYER_ANALYSIS_TICKET_ALREADY_STARTED'));
      return new Promise<T>((resolve, reject) => {
        job.run = run as unknown as () => Promise<unknown>;
        job.resolve = resolve as unknown as (value: unknown) => void;
        job.reject = reject;
        void drain();
      });
    },
    cancel(): void {
      if (job.cancelled) return;
      job.cancelled = true;
      const index = pending.indexOf(job);
      if (index >= 0) pending.splice(index, 1);
      void drain();
    },
  };
}

export function runPlayerAnalysis<T>(playerId: number, run: () => Promise<T>): Promise<T> {
  return reservePlayerAnalysis(playerId).run(run);
}
