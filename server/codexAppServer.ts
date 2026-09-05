import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';

type JsonObject = Record<string, any>;
type RpcEvent = { method: string; params?: any; id?: string | number };

const ADAPTER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'content', 'tool_calls'],
  properties: {
    kind: { type: 'string', enum: ['final', 'tool_calls'] },
    content: { type: 'string' },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'arguments'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          arguments: { type: 'string' },
        },
      },
    },
  },
};

const ADAPTER_BASE_INSTRUCTIONS = [
  'You are the inference engine embedded in WuxinBot, not an interactive coding agent.',
  'Use only the conversation and external-tool definitions supplied in the user input.',
  'Do not inspect files, run commands, browse, call MCP/apps, modify the computer, or delegate.',
  'Never claim that you executed an external tool. Request it through the required JSON output instead.',
  'Follow the supplied system/developer messages and return exactly one object matching the output schema.',
].join(' ');

// WuxinBot only needs Codex as an authenticated inference transport. Disable
// Codex's own computer/tool surfaces at process startup; external bot tools
// continue to run through WuxinBot's existing audited executor.
const APP_SERVER_ARGS = [
  '--enable', 'respect_system_proxy',
  '--disable', 'plugins',
  '--disable', 'apps',
  '--disable', 'browser_use',
  '--disable', 'in_app_browser',
  '--disable', 'image_generation',
  '--disable', 'multi_agent',
  '--disable', 'shell_tool',
  '--disable', 'unified_exec',
  '--disable', 'hooks',
  '--disable', 'skill_search',
  '--disable', 'sleep_tool',
  '--disable', 'goals',
  '--disable', 'workspace_dependencies',
  '-c', 'mcp_servers={}',
  'app-server',
];

function cleanText(value: unknown) {
  return String(value ?? '').replace(/\u0000/g, '').trim();
}

function safeJson(value: unknown) {
  try { return JSON.stringify(value); } catch { return 'null'; }
}

function normalizeToolDefinition(tool: any) {
  const fn = tool?.function || tool || {};
  return {
    name: cleanText(fn.name),
    description: cleanText(fn.description),
    parameters: fn.parameters && typeof fn.parameters === 'object'
      ? fn.parameters
      : { type: 'object', properties: {} },
  };
}

function messageForAdapter(message: any, imageInputs: any[]) {
  const content = Array.isArray(message?.content)
    ? message.content.map((part: any) => {
        if (part?.type === 'text') return { type: 'text', text: cleanText(part.text) };
        if (part?.type === 'image_url' && part?.image_url?.url) {
          const marker = `[attached image ${imageInputs.length + 1}]`;
          imageInputs.push({ type: 'image', url: String(part.image_url.url), detail: 'auto' });
          return { type: 'text', text: marker };
        }
        return part;
      })
    : cleanText(message?.content);
  return {
    role: cleanText(message?.role || 'user'),
    content,
    ...(message?.name ? { name: cleanText(message.name) } : {}),
    ...(message?.tool_call_id ? { tool_call_id: cleanText(message.tool_call_id) } : {}),
    ...(Array.isArray(message?.tool_calls) ? { tool_calls: message.tool_calls } : {}),
  };
}

export function buildCodexAdapterInput(messages: any[] = [], tools: any[] = [], responseFormat?: any) {
  const imageInputs: any[] = [];
  const conversation = messages.map((message) => messageForAdapter(message, imageInputs));
  const availableTools = tools.map(normalizeToolDefinition).filter((tool) => tool.name);
  const instructionMessages: any[] = [];
  let conversationStart = 0;
  while (conversationStart < conversation.length && ['system', 'developer'].includes(conversation[conversationStart]?.role)) {
    instructionMessages.push(conversation[conversationStart]);
    conversationStart += 1;
  }
  const conversationMessages = conversation.slice(conversationStart);
  const prompt = [
    'Act as a Chat Completions-compatible model for this single request.',
    '',
    'External tools that WuxinBot itself can execute (JSON):',
    safeJson(availableTools),
    '',
    'Output rules:',
    '- If you can answer now, set kind="final", put the answer in content, and return tool_calls=[].',
    '- If an external tool is necessary, set kind="tool_calls", keep content empty or brief, and return one or more tool calls.',
    '- Each tool call name must exactly match an available tool. arguments must be a JSON-encoded object string.',
    '- Never fabricate a tool result. After WuxinBot executes a requested tool, a later request will include its result in the conversation.',
    '- Preserve the language, persona, formatting, and safety requirements in the supplied messages.',
    '',
    'Leading system/developer instructions (JSON, in order):',
    safeJson(instructionMessages),
    '',
    'Conversation messages (JSON, in order):',
    safeJson(conversationMessages),
    ...(responseFormat ? [
      '',
      `Requested response format for the content string (JSON): ${safeJson(responseFormat)}`,
    ] : []),
  ].join('\n');
  return [{ type: 'text', text: prompt, text_elements: [] }, ...imageInputs];
}

export function parseCodexAdapterEnvelope(text: unknown) {
  const raw = cleanText(text);
  const candidate = raw.startsWith('```')
    ? raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : raw;
  try {
    const parsed = JSON.parse(candidate);
    const calls = Array.isArray(parsed?.tool_calls)
      ? parsed.tool_calls
          .filter((call: any) => cleanText(call?.name))
          .map((call: any) => ({
            id: cleanText(call.id) || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
            name: cleanText(call.name),
            rawArguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? null),
            arguments: typeof call.arguments === 'string'
              ? (() => { try { return JSON.parse(call.arguments); } catch { return null; } })()
              : (call.arguments ?? null),
          }))
      : [];
    return {
      kind: parsed?.kind === 'tool_calls' && calls.length ? 'tool_calls' : 'final',
      content: cleanText(parsed?.content),
      toolCalls: calls,
    };
  } catch {
    // Older/different Codex builds may ignore outputSchema. Preserve the text
    // as a normal final answer instead of turning a valid reply into an error.
    return { kind: 'final', content: raw, toolCalls: [] };
  }
}

export function mapCodexTokenUsage(breakdown: any = {}) {
  const cachedTokens = Number(breakdown?.cachedInputTokens || 0);
  const cacheWriteTokens = Number(breakdown?.cacheWriteInputTokens || 0);
  return {
    total_tokens: Number(breakdown?.totalTokens || 0),
    prompt_tokens: Number(breakdown?.inputTokens || 0),
    completion_tokens: Number(breakdown?.outputTokens || 0),
    prompt_tokens_details: {
      cached_tokens: cachedTokens,
      cache_write_tokens: cacheWriteTokens,
    },
    input_tokens_details: { cached_tokens: cachedTokens },
    completion_tokens_details: { reasoning_tokens: Number(breakdown?.reasoningOutputTokens || 0) },
    // Preserve App Server-native aliases for diagnostics and callers that do
    // not consume the OpenAI-compatible prompt_tokens_details shape.
    cache_read_input_tokens: cachedTokens,
    cache_write_input_tokens: cacheWriteTokens,
    cache_metrics_available: typeof breakdown?.cachedInputTokens === 'number',
    usage_known: typeof breakdown?.totalTokens === 'number',
  };
}

class CodexRpcError extends Error {
  code: number | string | undefined;
  data: unknown;

  constructor(message: string, code?: number | string, data?: unknown) {
    super(message);
    this.name = 'CodexRpcError';
    this.code = code;
    this.data = data;
  }
}

export class CodexAppServerClient {
  constructor(private spawnProcess: typeof spawn = spawn) {}
  private child: ChildProcessWithoutNullStreams | null = null;
  private command = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(event: RpcEvent) => void>();
  private startPromise: Promise<void> | null = null;
  private ready = false;
  private generation = 0;
  private failureListeners = new Set<(error: Error) => void>();
  private stderrTail: string[] = [];

  isRunning() {
    return Boolean(this.child && !this.child.killed && this.child.exitCode == null);
  }

  getCommand() {
    return this.command || 'codex';
  }

  getLastDiagnostic() {
    return this.stderrTail.slice(-3).join('\n').slice(-1200);
  }

  private rejectPending(error: Error) {
    for (const listener of this.failureListeners) listener(error);
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }

  private send(payload: JsonObject) {
    if (!this.child?.stdin?.writable) throw new Error('Codex App Server 未运行');
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string) {
    const value = line.trim();
    if (!value.startsWith('{')) return;
    let message: any;
    try { message = JSON.parse(value); } catch { return; }
    if (process.env.CODEX_APP_SERVER_DEBUG === '1') {
      console.error('[codex-app-server]', message.method || `response:${message.id}`, message.params?.turn?.status || '');
    }
    if (message.id != null && !message.method) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error) {
        pending.reject(new CodexRpcError(
          cleanText(message.error.message) || 'Codex App Server 请求失败',
          message.error.code,
          message.error.data,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    // With approvalPolicy=never no interactive request should occur. Decline
    // defensively if a future server build still asks, so the bot cannot hang.
    if (message.id != null && message.method) {
      this.send({ id: message.id, result: { decision: 'decline' } });
      return;
    }
    if (message.method) {
      for (const listener of this.listeners) {
        try { listener(message); } catch { /* one observer must not break the RPC stream */ }
      }
    }
  }

  private rawRequest(method: string, params?: any, timeoutMs = 30_000) {
    if (!this.child) return Promise.reject(new Error('Codex App Server 未运行'));
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时 ${Math.round(timeoutMs / 1000)} 秒`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ method, id, ...(params === undefined ? {} : { params }) });
      } catch (error: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async ensureStarted(command = 'codex') {
    const requestedCommand = cleanText(command) || 'codex';
    if (this.startPromise) {
      await this.startPromise;
      return this.ensureStarted(requestedCommand);
    }
    if (this.ready && this.isRunning() && this.command === requestedCommand) return;
    if (this.isRunning()) this.shutdown();
    const generation = ++this.generation;
    const starting = (async () => {
      this.ready = false;
      this.command = requestedCommand;
      this.stderrTail = [];
      const child = this.spawnProcess(requestedCommand, APP_SERVER_ARGS, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      child.once('error', (error) => {
        if (this.child !== child) return;
        this.ready = false;
        this.rejectPending(new Error(`无法启动 Codex App Server：${error.message}`));
      });
      child.once('exit', (code, signal) => {
        if (this.child !== child) return;
        this.child = null;
        this.ready = false;
        this.rejectPending(new Error(`Codex App Server 已退出（code=${code ?? '-'} signal=${signal ?? '-'}）`));
      });
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (this.child === child) this.handleLine(line);
      });
      readline.createInterface({ input: child.stderr }).on('line', (line) => {
        if (this.child !== child) return;
        const diagnostic = cleanText(line);
        if (!diagnostic) return;
        this.stderrTail.push(diagnostic);
        if (process.env.CODEX_APP_SERVER_DEBUG === '1') console.error('[codex-app-server:stderr]', diagnostic);
        if (this.stderrTail.length > 30) this.stderrTail.shift();
      });
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => { cleanup(); resolve(); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const cleanup = () => {
          child.off('spawn', onSpawn);
          child.off('error', onError);
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      });
      await this.rawRequest('initialize', {
        clientInfo: { name: 'wuxinbot', title: 'WuxinBot', version: '1.0.3' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      }, 30_000);
      if (this.child !== child || !this.isRunning()) throw new Error('Codex 初始化进程已更换或退出');
      this.send({ method: 'initialized', params: {} });
      this.ready = true;
    })();
    this.startPromise = starting;
    try {
      await starting;
    } catch (error) {
      if (this.generation === generation) this.shutdown();
      throw error;
    } finally {
      if (this.startPromise === starting) this.startPromise = null;
    }
  }

  async request(method: string, params?: any, timeoutMs = 30_000, command = 'codex') {
    const deadline = Date.now() + timeoutMs;
    let timer: NodeJS.Timeout;
    try {
      await Promise.race([this.ensureStarted(command), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${method} initialization deadline exceeded`)), timeoutMs);
      })]);
    } finally { clearTimeout(timer!); }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`${method} deadline exceeded during initialization`);
    return this.rawRequest(method, params, remaining);
  }

  onFailure(listener: (error: Error) => void) {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  getGeneration() { return this.generation; }

  onEvent(listener: (event: RpcEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  shutdown() {
    this.ready = false;
    this.generation += 1;
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    this.rejectPending(new Error('Codex App Server 已关闭'));
    if (!child) return;
    try { child.stdin.end(); } catch { /* best effort */ }
    try { child.kill(); } catch { /* best effort */ }
  }
}

const client = new CodexAppServerClient();

function commandFromSettings(settings: JsonObject = {}) {
  return cleanText(settings.codexExecutable) || process.env.CODEX_EXECUTABLE || 'codex';
}

function codexModelFromSettings(settings: JsonObject = {}) {
  return cleanText(settings.codexModel) || 'gpt-5.6-luna';
}

function codexEffortFromSettings(settings: JsonObject = {}) {
  const value = cleanText(settings.codexReasoningEffort).toLowerCase();
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(value) ? value : 'low';
}

export function codexInvocationConfig(settings: JsonObject = {}, options: JsonObject = {}) {
  const requested = cleanText(options.codexReasoningEffort || options.reasoning_effort).toLowerCase();
  const effort = options.thinking?.type === 'disabled' ? 'low'
    : (['low', 'medium', 'high', 'xhigh', 'max'].includes(requested) ? requested : codexEffortFromSettings(settings));
  return {
    model: cleanText(options.codexModel) || codexModelFromSettings(settings), effort,
    capabilities: { hardMaxTokens: false, temperature: false, thinkingOff: false, perCallEffort: true },
    unsupportedOptions: [
      ...(options.maxTokens != null ? ['maxTokens'] : []),
      ...(options.temperature != null ? ['temperature'] : []),
      ...(options.thinking?.type === 'disabled' ? ['thinking=disabled (mapped to low, not off)'] : []),
      ...(options.model && options.model !== codexModelFromSettings(settings) ? ['model (use codexModel override)'] : []),
    ],
  };
}

export async function getCodexAccountStatus(settings: JsonObject = {}) {
  const command = commandFromSettings(settings);
  try {
    const result = await client.request('account/read', { refreshToken: false }, 15_000, command);
    return {
      running: client.isRunning(),
      command: client.getCommand(),
      account: result?.account || null,
      authenticated: result?.account?.type === 'chatgpt',
      requiresOpenaiAuth: Boolean(result?.requiresOpenaiAuth),
      diagnostic: '',
    };
  } catch (error: any) {
    return {
      running: client.isRunning(),
      command,
      account: null,
      authenticated: false,
      requiresOpenaiAuth: true,
      error: cleanText(error?.message || error),
      diagnostic: client.getLastDiagnostic(),
    };
  }
}

export async function startCodexChatGptLogin(settings: JsonObject = {}) {
  return client.request('account/login/start', {
    type: 'chatgpt',
    useHostedLoginSuccessPage: true,
    appBrand: 'chatgpt',
  }, 30_000, commandFromSettings(settings));
}

export async function logoutCodexAccount(settings: JsonObject = {}) {
  await client.request('account/logout', undefined, 15_000, commandFromSettings(settings));
  return getCodexAccountStatus(settings);
}

export async function getCodexRateLimits(settings: JsonObject = {}) {
  return client.request('account/rateLimits/read', undefined, 15_000, commandFromSettings(settings));
}

export async function listCodexModels(settings: JsonObject = {}) {
  const result = await client.request('model/list', { limit: 100, includeHidden: false }, 20_000, commandFromSettings(settings));
  return Array.isArray(result?.data) ? result.data : [];
}

export function shutdownCodexAppServer() {
  client.shutdown();
}

export async function completeCodexAppServerChat(db: any, options: JsonObject = {}, rpcClient: CodexAppServerClient = client) {
  const settings = db?.settings || {};
  const command = commandFromSettings(settings);
  const { model, effort } = codexInvocationConfig(settings, options);
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? settings.codexTimeoutMs ?? 90_000));
  const input = buildCodexAdapterInput(options.messages || [], options.tools || [], options.responseFormat);
  const startedAt = Date.now();
  const remainingMs = () => {
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error('Codex App Server total deadline exceeded');
    return remaining;
  };

  const threadResponse = await rpcClient.request('thread/start', {
    model,
    cwd: process.cwd(),
    approvalPolicy: 'never',
    sandbox: 'read-only',
    baseInstructions: ADAPTER_BASE_INSTRUCTIONS,
    developerInstructions: 'Return only the structured adapter response. Do not use internal Codex tools.',
    ephemeral: true,
    serviceName: 'wuxinbot-llm',
    threadSource: 'wuxinbot',
  }, Math.min(30_000, remainingMs()), command);
  const threadId = cleanText(threadResponse?.thread?.id);
  const generation = rpcClient.getGeneration();
  if (!threadId) throw new Error('Codex App Server 未返回 thread id');

  let expectedTurnId = '';
  const buffered: RpcEvent[] = [];
  let lastUsage: any = null;
  let settled = false;
  let resolveTurn: (value: any) => void;
  let rejectTurn: (error: Error) => void;
  const turnDone = new Promise<any>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  // A child can exit while turn/start RPC is still pending.
  void turnDone.catch(() => {});
  const unsubscribeFailure = rpcClient.onFailure((error) => { settled = true; rejectTurn(error); });
  let finalAgentText = '';
  const inspectEvent = (event: RpcEvent) => {
    const params = event?.params || {};
    if (params.threadId !== threadId) return;
    if (!expectedTurnId) {
      buffered.push(event);
      return;
    }
    if (params.turnId && params.turnId !== expectedTurnId && params.turn?.id !== expectedTurnId) return;
    if (event.method === 'thread/tokenUsage/updated') lastUsage = params.tokenUsage?.last || params.tokenUsage?.total || null;
    if (event.method === 'item/completed' && params.item?.type === 'agentMessage') finalAgentText = cleanText(params.item.text);
    if (event.method === 'turn/completed' && params.turn?.id === expectedTurnId && !settled) {
      settled = true;
      if (params.turn.status === 'failed') {
        rejectTurn(new Error(cleanText(params.turn.error?.message || params.turn.error) || 'Codex turn 失败'));
      } else if (params.turn.status === 'interrupted') {
        rejectTurn(new Error('Codex turn 已中断'));
      } else {
        resolveTurn(params.turn);
      }
    }
  };
  const unsubscribe = rpcClient.onEvent(inspectEvent);
  let timeout: NodeJS.Timeout | undefined;
  try {
    if (!rpcClient.isRunning() || generation !== rpcClient.getGeneration()) throw new Error('Codex thread 所属进程已退出');
    const turnResponse = await rpcClient.request('turn/start', {
      threadId,
      input,
      approvalPolicy: 'never',
      model,
      effort,
      summary: 'none',
      outputSchema: ADAPTER_OUTPUT_SCHEMA,
    }, Math.min(30_000, remainingMs()), command);
    if (generation !== rpcClient.getGeneration()) throw new Error('Codex thread 所属进程已更换');
    expectedTurnId = cleanText(turnResponse?.turn?.id);
    if (!expectedTurnId) throw new Error('Codex App Server 未返回 turn id');
    for (const event of buffered.splice(0)) inspectEvent(event);
    const timedTurn = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Codex App Server 调用超时 ${Math.round(timeoutMs / 1000)} 秒`)), Math.max(1, timeoutMs - (Date.now() - startedAt)));
      timeout.unref?.();
    });
    const turn: any = await Promise.race([turnDone, timedTurn]);
    const agentItems = (turn?.items || []).filter((item: any) => item?.type === 'agentMessage');
    const finalText = cleanText(agentItems.at(-1)?.text) || finalAgentText;
    if (!finalText) throw new Error('Codex 返回了空回复');
    const envelope = parseCodexAdapterEnvelope(finalText);
    const toolCalls = envelope.kind === 'tool_calls'
      ? envelope.toolCalls.map((call: any) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.rawArguments },
        }))
      : [];
    const usage = mapCodexTokenUsage(lastUsage);
    const raw = {
      id: expectedTurnId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: envelope.content || (toolCalls.length ? null : ''),
          tool_calls: toolCalls.length ? toolCalls : null,
        },
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
      }],
      usage,
    };
    return {
      text: envelope.content,
      usage,
      raw,
      provider: 'codex-app-server',
      model,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (expectedTurnId && rpcClient.isRunning() && generation === rpcClient.getGeneration()) {
      void rpcClient.request('turn/interrupt', { threadId, turnId: expectedTurnId }, 5_000, command).catch(() => {});
    }
    // Process failure is shared by all waiting turns. Never mutate that Error
    // with this turn's usage, or concurrent callers can bill each other's data.
    if (lastUsage) throw Object.assign(new Error(String((error as any)?.message || error), { cause: error }), { usage: mapCodexTokenUsage(lastUsage) });
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    unsubscribe();
    unsubscribeFailure();
  }
}
