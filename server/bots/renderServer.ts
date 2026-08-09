// yumu-image render server. This mirrors yumu-bot's RenderWebsocket.kt:
// an authenticated renderer receives JSON tasks and returns either
// `<36-byte UUID><image bytes>` or a JSON error response.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { recordRenderFailure } from '../health.js';

const RENDER_TIMEOUT_MS = 45_000;
const AUTH_TIMEOUT_MS = 10_000;
const CLIENT_STALE_MS = 90_000;
const MAX_ANONYMOUS_CLIENTS = 10;
// yumu-image's own client allows up to 30 MiB frames; the original Kotlin
// server used 128 KiB, but Wuxin's enriched scores are larger than Kotlin's
// lean serialization. 4 MiB fits a 100-score BP panel with plenty of margin.
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SEND_BUFFER_BYTES = 20 * 1024 * 1024;
const MAX_PENDING_PER_CLIENT = 10;
const UUID_BYTES = 36;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RenderClient {
  pid: number;
  lastSeenAt: number;
}

interface RenderTask {
  messageId: string;
  path: string;
  client: WebSocket;
  resolve: (buffer: Buffer) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new TypeError('Unsupported WebSocket payload type');
}

function imageType(buffer: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer.subarray(1, 4).toString('ascii') === 'PNG'
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) return 'png';
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'webp';
  return null;
}

export function detectRenderedImageType(buffer: Buffer): 'jpg' | 'png' | 'webp' | null {
  return imageType(buffer);
}

export class RenderServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private connections: Map<WebSocket, NodeJS.Timeout | null> = new Map();
  private clients: Map<WebSocket, RenderClient> = new Map();
  private pending: Map<string, RenderTask> = new Map();
  private heartbeatSweep: NodeJS.Timeout | null = null;
  private roundRobinCounter = 0;
  private readonly port: number;
  private boundPort: number | null = null;

  constructor(port: number = 8389) {
    super();
    this.port = port;
  }

  start(): void {
    if (this.wss) return;

    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: this.port,
      maxPayload: MAX_IMAGE_BYTES + UUID_BYTES,
      perMessageDeflate: false
    });
    this.wss = wss;

    wss.on('listening', () => {
      const address = wss.address();
      this.boundPort = typeof address === 'object' && address ? address.port : this.port;
      console.log(`[yumu-image] Render server listening on ws://127.0.0.1:${this.boundPort}`);
      this.emit('ready', this.boundPort);
    });

    wss.on('connection', (ws: WebSocket) => {
      const anonymousCount = [...this.connections.keys()].filter((candidate) => !this.clients.has(candidate)).length;
      if (anonymousCount >= MAX_ANONYMOUS_CLIENTS) {
        ws.close(1008, 'Too many unauthenticated render clients');
        return;
      }

      const authTimer = setTimeout(() => {
        if (!this.clients.has(ws)) ws.close(1008, 'Render client authentication timeout');
      }, AUTH_TIMEOUT_MS);
      authTimer.unref?.();
      this.connections.set(ws, authTimer);

      ws.on('message', (raw: RawData, isBinary: boolean) => {
        const data = rawDataToBuffer(raw);
        if (isBinary) this.handleBinaryMessage(ws, data);
        else this.handleTextMessage(ws, data);
      });

      ws.on('ping', () => this.touchClient(ws));
      ws.on('pong', () => this.touchClient(ws));

      ws.on('close', () => {
        this.removeConnection(ws, new Error('yumu-image 渲染客户端已断开'));
      });

      ws.on('error', (err) => {
        console.error('[yumu-image] Render client error:', err.message);
        this.removeConnection(ws, new Error(`yumu-image 渲染客户端错误：${err.message}`));
      });
    });

    wss.on('error', (err: NodeJS.ErrnoException) => {
      if (this.wss === wss) {
        this.wss = null;
        this.boundPort = null;
      }
      if (this.heartbeatSweep) {
        clearInterval(this.heartbeatSweep);
        this.heartbeatSweep = null;
      }
      for (const ws of [...this.connections.keys()]) {
        this.removeConnection(ws, new Error(`yumu-image 渲染服务端错误：${err.message}`));
        ws.terminate();
      }
      if (err.code === 'EADDRINUSE') {
        console.error(`[yumu-image] Port ${this.port} is already in use; render server was not started`);
      } else {
        console.error('[yumu-image] Server error:', err.message);
      }
      this.emit('serverError', err);
    });

    this.heartbeatSweep = setInterval(() => {
      const now = Date.now();
      for (const [ws, client] of this.clients) {
        if (ws.readyState !== WebSocket.OPEN || now - client.lastSeenAt > CLIENT_STALE_MS) {
          ws.terminate();
          this.removeConnection(ws, new Error('yumu-image 渲染客户端心跳超时'));
        }
      }
    }, 30_000);
    this.heartbeatSweep.unref?.();
  }

  async stop(): Promise<void> {
    if (this.heartbeatSweep) {
      clearInterval(this.heartbeatSweep);
      this.heartbeatSweep = null;
    }

    for (const task of [...this.pending.values()]) {
      this.finishTask(task, new Error('Render server shutting down'));
    }

    for (const ws of [...this.connections.keys()]) {
      this.removeConnection(ws, new Error('Render server shutting down'));
      ws.terminate();
    }

    const wss = this.wss;
    this.wss = null;
    this.boundPort = null;
    if (!wss) return;

    await new Promise<void>((resolve) => {
      try {
        wss.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  hasClients(): boolean {
    for (const ws of this.clients.keys()) {
      if (ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  getListeningPort(): number | null {
    return this.boundPort;
  }

  private rejectRenderTask(message: string): Promise<never> {
    recordRenderFailure();
    return Promise.reject(new Error(message));
  }

  renderPanel(path: string, payload: unknown): Promise<Buffer> {
    if (!this.wss) {
      return this.rejectRenderTask('yumu-image 渲染服务不可用（服务端未启动）');
    }

    const connected = [...this.clients.keys()].filter((ws) => ws.readyState === WebSocket.OPEN);
    if (connected.length === 0) {
      return this.rejectRenderTask('yumu-image 渲染服务不可用（没有已认证的渲染客户端）');
    }
    const pendingByClient = new Map<WebSocket, number>();
    for (const task of this.pending.values()) {
      pendingByClient.set(task.client, (pendingByClient.get(task.client) || 0) + 1);
    }
    const available = connected.filter((ws) => (pendingByClient.get(ws) || 0) < MAX_PENDING_PER_CLIENT);
    if (available.length === 0) {
      return this.rejectRenderTask('yumu-image 渲染队列已满，请稍后再试');
    }

    const normalizedPath = String(path || '').trim();
    if (!/^[A-Za-z0-9_/-]{1,80}$/.test(normalizedPath)) {
      return this.rejectRenderTask('yumu-image 面板路径格式无效');
    }

    const index = (this.roundRobinCounter++ & 0x7fffffff) % available.length;
    const ws = available[index];
    const messageId = randomUUID();
    let json: string;
    try {
      json = JSON.stringify({ path: normalizedPath, messageId, payload });
    } catch {
      return this.rejectRenderTask('yumu-image 渲染参数无法序列化');
    }
    if (Buffer.byteLength(json, 'utf8') > MAX_TEXT_BYTES) {
      return this.rejectRenderTask(`yumu-image 渲染参数超过 ${MAX_TEXT_BYTES / 1024} KiB 限制`);
    }
    if (ws.bufferedAmount > MAX_SEND_BUFFER_BYTES) {
      ws.terminate();
      this.removeConnection(ws, new Error('yumu-image 渲染客户端发送缓冲区过载'));
      return this.rejectRenderTask('yumu-image 渲染客户端发送缓冲区过载');
    }

    return new Promise<Buffer>((resolve, reject) => {
      let task: RenderTask;
      const timer = setTimeout(() => {
        this.finishTask(task, new Error(`yumu-image 渲染超时 ${RENDER_TIMEOUT_MS / 1000}s（path: ${normalizedPath}）`));
      }, RENDER_TIMEOUT_MS);
      timer.unref?.();
      task = {
        messageId,
        path: normalizedPath,
        client: ws,
        resolve,
        reject,
        timer
      };
      this.pending.set(messageId, task);

      try {
        ws.send(json, (err) => {
          if (!err) return;
          this.finishTask(task, new Error(`yumu-image 渲染任务发送失败：${err.message}`));
          this.removeConnection(ws, new Error(`yumu-image 渲染任务发送失败：${err.message}`));
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.finishTask(task, new Error(`yumu-image 渲染任务发送失败：${message}`));
        this.removeConnection(ws, new Error(`yumu-image 渲染任务发送失败：${message}`));
      }
    });
  }

  private handleTextMessage(ws: WebSocket, data: Buffer): void {
    if (data.length > MAX_TEXT_BYTES) {
      ws.close(1009, 'Render text message too large');
      return;
    }

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
    } catch {
      ws.close(1007, 'Invalid render JSON');
      return;
    }

    if (message.type === 'AUTH') {
      const pid = Number(message.pid);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
        ws.close(1008, 'Invalid render client pid');
        return;
      }

      for (const [existingWs, client] of this.clients) {
        if (client.pid === pid && existingWs !== ws) {
          existingWs.close(4001, 'Replaced by new process connection');
          this.removeConnection(existingWs, new Error(`yumu-image 渲染进程 ${pid} 已被新连接替换`));
        }
      }

      const authTimer = this.connections.get(ws);
      if (authTimer) clearTimeout(authTimer);
      this.connections.set(ws, null);
      this.clients.set(ws, { pid, lastSeenAt: Date.now() });
      console.log(`[yumu-image] Client authenticated, pid=${pid}`);
      return;
    }

    const client = this.clients.get(ws);
    if (!client) {
      ws.close(1008, 'Render client must authenticate first');
      return;
    }
    client.lastSeenAt = Date.now();

    if (message.type === 'HEARTBEAT') return;

    const messageId = typeof message.messageId === 'string' ? message.messageId : '';
    if (!UUID_PATTERN.test(messageId)) return;
    const task = this.pending.get(messageId);
    if (!task || task.client !== ws) return;

    if (message.status === 'error') {
      const detail = String(message.error || 'Node.js 端发生未知异常').slice(0, 1000);
      this.finishTask(task, new Error(`yumu-image 渲染失败（${task.path}）：${detail}`));
      return;
    }

    // RenderWebsocket.kt also accepts a JSON success response containing base64.
    if (message.status === 'success') {
      const wrapped = message.data;
      const base64 = typeof wrapped === 'string'
        ? wrapped
        : wrapped && typeof wrapped === 'object' && typeof (wrapped as Record<string, unknown>).data === 'string'
          ? String((wrapped as Record<string, unknown>).data)
          : '';
      if (!base64 || base64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) {
        this.finishTask(task, new Error('yumu-image 返回了无效或过大的 base64 图片'));
        return;
      }
      const image = Buffer.from(base64, 'base64');
      this.completeWithImage(task, image);
    }
  }

  private handleBinaryMessage(ws: WebSocket, data: Buffer): void {
    if (!this.clients.has(ws)) {
      ws.close(1008, 'Render client must authenticate first');
      return;
    }
    this.touchClient(ws);

    if (data.length <= UUID_BYTES || data.length > UUID_BYTES + MAX_IMAGE_BYTES) {
      ws.close(1009, 'Invalid render image size');
      return;
    }

    const messageId = data.subarray(0, UUID_BYTES).toString('utf8');
    if (!UUID_PATTERN.test(messageId)) return;
    const task = this.pending.get(messageId);
    if (!task || task.client !== ws) return;
    this.completeWithImage(task, data.subarray(UUID_BYTES));
  }

  private completeWithImage(task: RenderTask, image: Buffer): void {
    if (image.length === 0 || image.length > MAX_IMAGE_BYTES || !imageType(image)) {
      this.finishTask(task, new Error('yumu-image 返回的内容不是受支持的图片（JPEG/PNG/WebP）'));
      return;
    }
    this.finishTask(task, null, Buffer.from(image));
  }

  private finishTask(task: RenderTask, error: Error | null, image?: Buffer): void {
    if (this.pending.get(task.messageId) !== task) return;
    clearTimeout(task.timer);
    this.pending.delete(task.messageId);
    if (error) {
      recordRenderFailure();
      task.reject(error);
    }
    else task.resolve(image!);
  }

  private touchClient(ws: WebSocket): void {
    const client = this.clients.get(ws);
    if (client) client.lastSeenAt = Date.now();
  }

  private removeConnection(ws: WebSocket, reason: Error): void {
    const timer = this.connections.get(ws);
    if (timer) clearTimeout(timer);
    this.connections.delete(ws);
    const wasAuthenticated = this.clients.delete(ws);

    for (const task of [...this.pending.values()]) {
      if (task.client === ws) this.finishTask(task, reason);
    }

    if (wasAuthenticated) console.log('[yumu-image] Render client disconnected');
  }
}

let instance: RenderServer | null = null;

export function getRenderServer(port?: number): RenderServer {
  if (!instance) instance = new RenderServer(port ?? 8389);
  return instance;
}

export function startRenderServer(port?: number): void {
  getRenderServer(port).start();
}

export async function stopRenderServer(): Promise<void> {
  const current = instance;
  instance = null;
  await current?.stop();
}

export async function renderPanel(path: string, payload: unknown): Promise<Buffer> {
  return getRenderServer().renderPanel(path, payload);
}
