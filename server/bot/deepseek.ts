// Compatibility wrapper. New code should import from `llm.ts`.
export {
  callDeepSeek,
  callLLM,
  completeChat,
  createLLMClient,
  defaultBaseUrlForProvider,
  llmProvider,
  llmProviderName,
  mergeUsage,
  supportsProviderSearch,
  withTimeout
} from './llm.js';
