import type { SocialEvent } from './types.js';
import { AsyncResource } from 'node:async_hooks';

interface Pending<T> {
  event: SocialEvent;
  priority: number;
  queuedAt: number;
  run: (event: SocialEvent) => Promise<T>;
  resolve: (result: T | { replied: false; reason: string; merged?: boolean }) => void;
  reject: (error: unknown) => void;
}
interface Room { running: boolean; timer?: ReturnType<typeof setTimeout>; queue: Pending<any>[] }

/** One conversational generation per room. Every pending request retains its real speaker. */
export class SocialCoordinator {
  private rooms = new Map<string, Room>();
  constructor(private debounceMs = 900, private ttlMs = 90_000, private limit = 30) {}

  submit<T>(event: SocialEvent, priority: number, run: (merged: SocialEvent) => Promise<T>) {
    const key = event.type === 'private' ? `private:${event.userId}` : `group:${event.groupId}`;
    let room = this.rooms.get(key);
    if (!room) { room = { running: false, queue: [] }; this.rooms.set(key, room); }
    if (room.queue.length >= this.limit) {
      if (priority === 0) return Promise.resolve({ replied: false as const, reason: '本群接话队列已满' });
      const victim = room.queue.findIndex((p) => p.priority === 0);
      if (victim < 0) return Promise.resolve({ replied: false as const, reason: '本群接话队列已满，请稍后重试' });
      room.queue.splice(victim, 1)[0].resolve({ replied: false, reason: '让出自然接话名额给明确请求' });
    }
    const pending = new Promise<T | { replied: false; reason: string; merged?: boolean }>((resolve, reject) => {
      // Each queued request owns its abort signal, trace and LLM budget. The
      // worker may run under another request's context after an await.
      room.queue.push({ event, priority, run: AsyncResource.bind(run), resolve, reject, queuedAt: Date.now() });
    });
    if (!room.running) {
      if (priority > 0 && room.timer) { clearTimeout(room.timer); room.timer = undefined; }
      if (!room.timer) room.timer = setTimeout(() => { room.timer = undefined; void this.drain(key, room); }, priority ? 0 : this.debounceMs);
    }
    return pending;
  }

  private async drain(key: string, room: Room) {
    if (room.running) return;
    room.running = true;
    try {
      while (room.queue.length) {
        room.queue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
        const first = room.queue.shift()!;
        if (Date.now() - first.queuedAt > this.ttlMs) { first.resolve({ replied: false, reason: '接话等待超时，跳过旧消息' }); continue; }
        // Only merge adjacent bursts from the same speaker; never merge different direct requests.
        const batch = [first];
        while (!first.priority && room.queue[0]?.priority === 0 && room.queue[0]?.event.userId === first.event.userId
          && room.queue[0].queuedAt - first.queuedAt < 4000 && batch.length < 8) batch.push(room.queue.shift()!);
        const event: SocialEvent = { ...batch.at(-1)!.event,
          socialMessageIds: batch.flatMap((p) => p.event.socialMessageIds || [p.event.messageId]) };
        if (batch.length > 1) {
          event.text = batch.map((p) => p.event.text).join('\n');
          event.images = batch.flatMap((p) => p.event.images || []);
        }
        try {
          first.resolve(await first.run(event));
          batch.slice(1).forEach((p) => p.resolve({ replied: false, reason: '同一成员的连续消息已合并回复', merged: true }));
        } catch (error) { batch.forEach((p) => p.reject(error)); }
      }
    } finally { room.running = false; if (!room.queue.length) this.rooms.delete(key); }
  }

  hasPriorityRequest(event: SocialEvent) {
    return Boolean(this.rooms.get(`group:${event.groupId}`)?.queue.some((p) => p.priority > 0));
  }
  get size() { return this.rooms.size; }
}

export const socialCoordinator = new SocialCoordinator();
