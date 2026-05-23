# Bot Runtime Map

This folder is a partial extraction from `server/bot.ts`.

Current runtime entrypoints:

- `server/index.ts` imports `oneBotToInternal()` and `processIncoming()` from `server/bot.ts`.
- OneBot events, `/api/onebot/event`, and `/api/simulate` all enter `processIncoming()`.
- Command execution still runs through `runOwnerCommand()` inside `server/bot.ts`.
- LLM calls go through `server/bot/llm.ts`. DeepSeek is the default provider,
  but the runtime should use `callLLM()` / `completeChat()` instead of direct
  DeepSeek/OpenAI client calls.

Important maintenance note:

- `prompt.ts`, `reply.ts`, and `memory.ts` are now imported by the real runtime
  path. Changes there can affect live behavior.
- `commandHandlers.ts` is not imported by the runtime path yet. Treat it as extraction scratch, not live behavior.
- Before wiring `commandHandlers.ts` into runtime, remove its direct OpenAI/DeepSeek
  client call and route summaries through `completeChat()`.
- Keep the provider abstraction intact: no new runtime code should call
  `new OpenAI()` outside `server/bot/llm.ts`.
- Before changing behavior, run:

```text
npm run structure
npm run sanity
npm run build
```

The safest cleanup direction is to migrate one helper family at a time, then delete the matching local definitions from `server/bot.ts` only after `npm run sanity` still passes.
