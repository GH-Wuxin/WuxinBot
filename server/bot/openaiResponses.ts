// OpenAI Responses API adapter for official tool-calling turns.
//
// Chat Completions remains the transport for ordinary text calls and for
// relays. Official OpenAI models route tool calls here, where reasoning items
// and function calls can be preserved across rounds as the API expects.
import { apiHostFromUrl, OPENAI_OFFICIAL_HOST } from '../usage.js';

const RESPONSES_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

type AnyRecord = Record<string, any>;

function textParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part: any) => part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text')
    .map((part: any) => String(part?.text || ''))
    .join('');
}

function responsesContent(content: unknown): any[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (!Array.isArray(content)) return [];
  const parts: any[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' || part.type === 'input_text') {
      parts.push({ type: 'input_text', text: String(part.text || '') });
    } else if (part.type === 'output_text') {
      parts.push({ type: 'input_text', text: String(part.text || '') });
    } else if (part.type === 'image_url') {
      const image = part.image_url;
      const url = typeof image === 'string' ? image : image?.url;
      if (!url) continue;
      parts.push({
        type: 'input_image',
        image_url: String(url),
        ...(image?.detail ? { detail: String(image.detail) } : {}),
      });
    } else if (part.type === 'input_image') {
      parts.push({ ...part });
    }
  }
  return parts;
}

export function shouldUseOpenAIResponses(
  provider: string,
  baseURL: unknown,
  model: unknown,
  hasTools: boolean,
): boolean {
  if (!hasTools || provider !== 'openai-compatible') return false;
  // An empty base URL means the OpenAI SDK's official default endpoint.
  const host = apiHostFromUrl(baseURL) || OPENAI_OFFICIAL_HOST;
  if (host !== OPENAI_OFFICIAL_HOST) return false;
  return /^(gpt-[5-9]|o[1-9])/i.test(String(model || ''));
}

/**
 * Tool-call turns should reason, not silently force `none`. Default to `low`,
 * which OpenAI recommends for tool use, and clamp explicit levels to values
 * the selected model accepts.
 */
export function openAIResponsesReasoningEffort(model: unknown, requested: unknown): string {
  const id = String(model || '').toLowerCase();
  const raw = String(requested || '').toLowerCase();
  const effort = RESPONSES_EFFORTS.has(raw) ? raw : 'low';
  if (effort === 'none' || effort === 'minimal') return 'low';
  const supportsMax = /^gpt-6\.1-(terra|sol)$/.test(id) || /^gpt-6-luna$/.test(id);
  const supportsXhigh = /^(gpt-6|gpt-5\.6|gpt-5\.5|gpt-5\.4)/.test(id);
  if (effort === 'max' && !supportsMax) return supportsXhigh ? 'xhigh' : 'high';
  if (effort === 'xhigh' && !supportsXhigh) return 'high';
  return effort;
}

export function buildResponsesInput(messages: any[] = []) {
  const instructions: string[] = [];
  const input: any[] = [];
  const knownCallIds = new Set<string>();

  const pushAssistantText = (content: unknown) => {
    const text = textParts(content);
    if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
  };

  for (const message of messages) {
    const role = String(message?.role || '');
    if (role === 'system' || role === 'developer') {
      const text = textParts(message?.content);
      if (text) instructions.push(text);
      continue;
    }
    if (role === 'user') {
      const content = responsesContent(message?.content);
      if (content.length) input.push({ role: 'user', content });
      continue;
    }
    if (role === 'assistant') {
      const preserved = Array.isArray(message?.responses_output) ? message.responses_output : [];
      if (preserved.length) {
        for (const item of preserved) {
          if (!item || typeof item !== 'object') continue;
          if (item.type === 'function_call') {
            const callId = String(item.call_id || item.id || '');
            if (callId) knownCallIds.add(callId);
          }
          if (item.type === 'reasoning' || item.type === 'message' || item.type === 'function_call') {
            input.push({ ...item });
          }
        }
        continue;
      }
      pushAssistantText(message?.content);
      for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
        const callId = String(call?.id || call?.call_id || '');
        const name = String(call?.function?.name || call?.name || '');
        if (!callId || !name) continue;
        knownCallIds.add(callId);
        input.push({
          type: 'function_call',
          call_id: callId,
          name,
          arguments: String(call?.function?.arguments ?? call?.arguments ?? '{}'),
        });
      }
      continue;
    }
    if (role === 'tool') {
      const callId = String(message?.tool_call_id || '');
      const output = typeof message?.content === 'string'
        ? message.content
        : textParts(message?.content);
      if (callId && knownCallIds.has(callId)) {
        input.push({ type: 'function_call_output', call_id: callId, output });
      } else {
        input.push({
          role: 'user',
          content: [{ type: 'input_text', text: `[tool result${callId ? ` ${callId}` : ''}]\n${output}` }],
        });
      }
      continue;
    }
    const fallback = textParts(message?.content);
    if (fallback) input.push({ role: 'user', content: [{ type: 'input_text', text: fallback }] });
  }

  if (!input.length) input.push({ role: 'user', content: [{ type: 'input_text', text: '' }] });
  return { instructions: instructions.join('\n\n'), input };
}

function responsesTools(tools: any[] = []): any[] {
  return tools.map((tool) => {
    const fn = tool?.function || tool;
    if (tool?.type !== 'function' || !fn?.name) return null;
    return {
      type: 'function',
      name: String(fn.name),
      ...(fn.description ? { description: String(fn.description) } : {}),
      parameters: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} },
      // Match Chat Completions' non-strict behavior.
      strict: false,
    };
  }).filter(Boolean);
}

function responsesToolChoice(choice: any): any {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;
  if (choice.type === 'function') {
    const name = choice.function?.name || choice.name;
    return name ? { type: 'function', name: String(name) } : undefined;
  }
  return undefined;
}

function responsesTextFormat(format: any): any {
  if (!format) return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema') {
    if (format.json_schema) return { type: 'json_schema', ...format.json_schema };
    return { ...format };
  }
  return undefined;
}

function inputContainsJSON(items: any[]): boolean {
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const content = item.content;
    if (typeof content === 'string' && /json/i.test(content)) return true;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part?.text === 'string' && /json/i.test(part.text)) return true;
      if (typeof part?.refusal === 'string' && /json/i.test(part.refusal)) return true;
    }
  }
  return false;
}

export function buildOpenAIResponsesParams(
  chatParams: AnyRecord,
  messages: any[],
  options: AnyRecord = {},
) {
  const { instructions, input } = buildResponsesInput(messages);
  const tools = responsesTools(chatParams?.tools || options.tools || []);
  const params: AnyRecord = {
    model: chatParams?.model,
    input,
    store: false,
    include: ['reasoning.encrypted_content'],
    reasoning: {
      effort: openAIResponsesReasoningEffort(chatParams?.model, options.reasoning_effort),
    },
  };
  if (instructions) params.instructions = instructions;
  if (tools.length) {
    params.tools = tools;
    params.parallel_tool_calls = true;
  }
  const toolChoice = responsesToolChoice(chatParams?.tool_choice ?? options.tool_choice);
  if (toolChoice) params.tool_choice = toolChoice;
  const textFormat = responsesTextFormat(chatParams?.response_format ?? options.responseFormat);
  if (textFormat?.type === 'json_object' && !inputContainsJSON(input)) {
    // Responses validates json_object against input messages, not instructions.
    // The app keeps its JSON schema in the system prompt, so add a minimal
    // in-band reminder when the converted input would otherwise omit the word.
    input.push({
      role: 'developer',
      content: [{ type: 'input_text', text: 'Return the final answer as a JSON object.' }],
    });
  }
  if (textFormat) params.text = { format: textFormat };

  const rawLimit = chatParams?.max_completion_tokens ?? chatParams?.max_tokens;
  if (rawLimit != null && Number.isFinite(Number(rawLimit))) {
    const explicitBudget = Number(options.completionBudget);
    // Background activities have their own token cap. Interactive tool turns
    // get enough room for reasoning plus the requested answer.
    const effort = String(params.reasoning?.effort || 'low');
    const reasoningFloor = ['high', 'xhigh', 'max'].includes(effort) ? 8192 : 4096;
    params.max_output_tokens = explicitBudget > 0
      ? Math.max(128, Math.min(8192, Math.floor(explicitBudget)))
      : Math.max(reasoningFloor, Math.min(16384, Math.floor(Number(rawLimit))));
  }
  return params;
}

function outputText(output: any[]): string {
  let text = '';
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'output_text') {
      text += String(item.text || '');
      continue;
    }
    if (item.type !== 'message') continue;
    if (typeof item.content === 'string') {
      text += item.content;
      continue;
    }
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'output_text' || part.type === 'text') text += String(part.text || '');
      else if (part.type === 'refusal') text += String(part.refusal || '');
    }
  }
  return text.trim();
}

function responsesUsage(usage: any) {
  if (!usage) return undefined;
  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const total = Number(usage.total_tokens || input + output);
  const details = usage.input_tokens_details || {};
  const hasCached = Object.prototype.hasOwnProperty.call(details, 'cached_tokens');
  const cached = Number(details.cached_tokens || 0);
  const cacheWrite = details.cache_write_tokens;
  const reasoning = Number(usage.output_tokens_details?.reasoning_tokens || 0);
  return {
    total_tokens: total,
    prompt_tokens: input,
    completion_tokens: output,
    input_tokens_details: { cached_tokens: cached },
    prompt_tokens_details: {
      cached_tokens: cached,
      ...(cacheWrite != null ? { cache_write_tokens: Number(cacheWrite) } : {}),
    },
    completion_tokens_details: { reasoning_tokens: reasoning },
    cache_read_input_tokens: cached,
    ...(cacheWrite != null ? { cache_write_input_tokens: Number(cacheWrite) } : {}),
    cache_metrics_available: Boolean(hasCached || cacheWrite != null),
  };
}

export function normalizeOpenAIResponsesResponse(response: any, fallbackModel = '') {
  const output = Array.isArray(response?.output) ? response.output : [];
  const text = outputText(output) || String(response?.output_text || '').trim();
  const toolCalls: any[] = [];
  for (const item of output) {
    if (!item || item.type !== 'function_call') continue;
    const id = String(item.call_id || item.id || '');
    const name = String(item.name || '');
    if (!id || !name) continue;
    toolCalls.push({
      id,
      type: 'function',
      function: { name, arguments: String(item.arguments || '{}') },
    });
  }
  const finishReason = toolCalls.length
    ? 'tool_calls'
    : (response?.status === 'incomplete' ? 'length' : 'stop');
  return {
    id: response?.id || '',
    object: 'chat.completion',
    created: response?.created_at || Math.floor(Date.now() / 1000),
    model: response?.model || fallbackModel,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.length ? toolCalls : null,
        responses_output: JSON.parse(JSON.stringify(output)),
      },
      finish_reason: finishReason,
    }],
    usage: responsesUsage(response?.usage),
    responses: response,
  };
}
